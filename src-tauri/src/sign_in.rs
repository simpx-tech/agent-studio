//! Sign-in without a terminal (requested 2026-10-06). The selected profile's own CLI signs in
//! as a hidden process, so the user sees only the provider's sign-in page. Claude Code's
//! `auth login` opens that page itself and also takes the code the page shows when the browser
//! cannot come back to this computer. Codex's app-server hands back its page
//! (`account/login/start`), which this app opens, and reports how the sign-in ended
//! (`account/login/completed`). Windows follow each sign-in through `studio-sign-in` events until
//! the CLI reports its end. Sign-in pages and codes stay in this computer's memory: they are never
//! logged, saved, synced or relayed. Antigravity signs in inside its own interactive screen, so it
//! keeps a terminal (`providers::terminal_sign_in`).
use crate::providers::Executable;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio_util::sync::CancellationToken;

/// The event windows follow sign-ins by.
pub const EVENT: &str = "studio-sign-in";
/// How long a CLI may take to show its sign-in page; a WSL distribution may have to start first.
const START: Duration = Duration::from_secs(60);
/// How long a sign-in waits for the browser before it ends by itself.
const WAIT: Duration = Duration::from_secs(10 * 60);
/// The most CLI output kept while it signs in, to find its page and its last error.
const OUTPUT: usize = 64 * 1024;
const ENDED: &str = "This sign-in has ended. Open sign-in to start again.";
const CANCELLED: &str = "Sign-in was cancelled.";
const EXPIRED: &str = "Sign-in was not finished within 10 minutes. Open sign-in to try again.";
const REPLACED: &str =
    "Replaced by another Codex sign-in. Codex signs in one account at a time on a computer.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Waiting,
    Connected,
    Failed,
    Cancelled,
    Expired,
}

/// One sign-in, as windows show it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub provider: String,
    /// The connection it was opened for; none for a CLI's own login.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub phase: Phase,
    /// The sign-in page, to open again while the sign-in waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Whether the page can end with a code to paste here (Claude).
    pub code: bool,
    /// Whether the page that opened always ends with that code (Claude in WSL), rather than
    /// returning to the CLI by itself.
    pub code_expected: bool,
    /// What to do now, or why the sign-in ended, as bounded plain text.
    pub message: String,
}

/// Tells windows about a sign-in that changed.
pub type Notify = Arc<dyn Fn(&View) + Send + Sync>;
/// Opens a sign-in page in the browser, reporting whether it could.
pub type Open = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Tells this computer's windows about a sign-in that changed.
pub fn notifier(app: &tauri::AppHandle) -> Notify {
    let app = app.clone();
    Arc::new(move |view: &View| {
        let _ = tauri::Emitter::emit(&app, EVENT, view);
    })
}

/// Opens a sign-in page in this computer's default browser.
pub fn browser(app: &tauri::AppHandle) -> Open {
    let app = app.clone();
    Arc::new(move |page: &str| {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(page, None::<&str>).is_ok()
    })
}

/// What a sign-in starts with.
pub struct Start {
    pub exe: Executable,
    pub provider: String,
    pub connection_id: Option<String>,
    /// The login that signs in: its connection, or the provider for a CLI's own login. A WSL
    /// Codex profile that borrows a Windows login names the Windows connection, where it signs
    /// in.
    pub account: String,
    /// Where a native CLI runs while it signs in.
    pub directory: PathBuf,
}

struct Entry {
    view: View,
    account: String,
    cancel: CancellationToken,
    /// Claude's input, where a pasted code goes, and the state that code must carry.
    input: Option<(Arc<tokio::sync::Mutex<ChildStdin>>, String)>,
    /// A code was pasted, which explains a failure that follows.
    pasted: bool,
    /// Why another sign-in ended this one.
    replaced: bool,
}

/// A CLI signing in, followed until it ends.
enum Flow {
    Claude {
        child: Child,
        errors: Arc<Mutex<String>>,
        collector: tokio::task::JoinHandle<()>,
    },
    Codex {
        child: Child,
        input: ChildStdin,
        lines: Box<Lines<BufReader<ChildStdout>>>,
        login: String,
    },
}
impl Flow {
    async fn kill(&mut self, exe: &Executable) {
        match self {
            Flow::Claude { child, .. } | Flow::Codex { child, .. } => exe.kill(child).await,
        }
    }
}

enum Ended {
    Connected,
    Failed(String),
    Cancelled,
    Expired,
}

/// The sign-ins this computer runs, by id.
#[derive(Clone)]
pub struct SignIns {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    wait: Duration,
}
impl Default for SignIns {
    fn default() -> Self {
        Self {
            entries: Arc::default(),
            wait: WAIT,
        }
    }
}

impl SignIns {
    /// Starts a sign-in and returns it once its page is open, or says why it could not start.
    /// Another sign-in of the same login ends, and so does any other Codex sign-in, because
    /// Codex returns from its page to one fixed local port.
    pub async fn start(&self, start: Start, notify: Notify, open: Open) -> Result<View, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        let replaced = self.reserve(&id, &start, cancel.clone());
        self.gone(&replaced).await;
        let started = match start.provider.as_str() {
            "claude" => claude(&start, &cancel).await,
            "codex" => codex(&start, &cancel).await,
            _ => Err("This agent signs in through its own terminal.".to_string()),
        };
        let (mut flow, page, input) = match started {
            Ok(started) => started,
            Err(error) => {
                self.entries.lock().unwrap().remove(&id);
                return Err(if cancel.is_cancelled() {
                    CANCELLED.into()
                } else {
                    error
                });
            }
        };
        if cancel.is_cancelled() {
            flow.kill(&start.exe).await;
            self.entries.lock().unwrap().remove(&id);
            return Err(CANCELLED.into());
        }
        // Claude Code opens its own page, except in WSL, where it cannot reach the Windows
        // browser: there this app opens the page, which ends with a code to paste.
        let wsl = start.exe.wsl.is_some();
        let opened = (start.provider != "claude" || wsl) && open(&page);
        let message = match (start.provider == "claude", wsl, opened) {
            (true, false, _) => "",
            (true, true, true) => "Sign in on the page that opened, then paste the code it shows.",
            (true, true, false) => "Open the sign-in page, sign in, then paste the code it shows.",
            (false, _, true) => "",
            (false, _, false) => "Your browser did not open. Open the sign-in page to continue.",
        };
        let state = page_state(&page).filter(|_| start.provider == "claude");
        let view = self.entries.lock().unwrap().get_mut(&id).map(|entry| {
            entry.view.url = Some(page);
            entry.view.code = state.is_some() && input.is_some();
            entry.view.code_expected = entry.view.code && wsl;
            entry.view.message = message.into();
            entry.input = input
                .zip(state)
                .map(|(input, state)| (Arc::new(tokio::sync::Mutex::new(input)), state));
            entry.view.clone()
        });
        let Some(view) = view else {
            flow.kill(&start.exe).await;
            return Err(CANCELLED.into());
        };
        notify(&view);
        tokio::spawn(self.clone().follow(id, flow, start.exe, cancel, notify));
        Ok(view)
    }

    /// Sends the code a Claude sign-in page showed to the CLI that waits for it.
    pub async fn code(&self, id: &str, text: &str, notify: &Notify) -> Result<View, String> {
        let (input, state) = self
            .entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|entry| entry.view.url.is_some())
            .ok_or(ENDED)?
            .input
            .clone()
            .ok_or("This sign-in finishes in the browser and takes no code.")?;
        let line = pasted_code(text, &state)?;
        {
            let mut input = input.lock().await;
            input
                .write_all(format!("{line}\n").as_bytes())
                .await
                .map_err(|_| ENDED)?;
            input.flush().await.map_err(|_| ENDED)?;
        }
        let view = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries.get_mut(id).ok_or(ENDED)?;
            entry.pasted = true;
            entry.view.message = "Checking the code…".into();
            entry.view.clone()
        };
        notify(&view);
        Ok(view)
    }

    /// Ends a sign-in; its CLI stops, and windows hear that it was cancelled.
    pub fn cancel(&self, id: &str) {
        if let Some(entry) = self.entries.lock().unwrap().get(id) {
            entry.cancel.cancel();
        }
    }

    /// The sign-ins waiting for the browser, for a window that opens or reloads.
    pub fn list(&self) -> Vec<View> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|entry| entry.view.url.is_some())
            .map(|entry| entry.view.clone())
            .collect()
    }

    /// The sign-ins this app owns, which quitting ends.
    pub fn tokens(&self) -> Vec<CancellationToken> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .map(|entry| entry.cancel.clone())
            .collect()
    }

    fn reserve(&self, id: &str, start: &Start, cancel: CancellationToken) -> Vec<String> {
        let mut entries = self.entries.lock().unwrap();
        let mut replaced = vec![];
        for (other, entry) in entries.iter_mut() {
            let same = entry.account == start.account;
            if same || (start.provider == "codex" && entry.view.provider == "codex") {
                entry.replaced = !same;
                entry.cancel.cancel();
                replaced.push(other.clone());
            }
        }
        entries.insert(
            id.into(),
            Entry {
                view: View {
                    id: id.into(),
                    provider: start.provider.clone(),
                    connection_id: start.connection_id.clone(),
                    phase: Phase::Waiting,
                    url: None,
                    code: false,
                    code_expected: false,
                    message: String::new(),
                },
                account: start.account.clone(),
                cancel,
                input: None,
                pasted: false,
                replaced: false,
            },
        );
        replaced
    }

    /// Waits a moment for replaced sign-ins to stop, so their CLIs let go of their port.
    async fn gone(&self, ids: &[String]) {
        for _ in 0..100 {
            if !ids
                .iter()
                .any(|id| self.entries.lock().unwrap().contains_key(id))
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn follow(
        self,
        id: String,
        flow: Flow,
        exe: Executable,
        cancel: CancellationToken,
        notify: Notify,
    ) {
        let ended = match flow {
            Flow::Claude {
                mut child,
                errors,
                collector,
            } => {
                let ended = tokio::select! {
                    _ = cancel.cancelled() => Ended::Cancelled,
                    _ = tokio::time::sleep(self.wait) => Ended::Expired,
                    status = child.wait() => match status {
                        Ok(status) if status.success() => Ended::Connected,
                        _ => {
                            // Its reason arrives on its error output as it exits.
                            let _ = tokio::time::timeout(Duration::from_secs(2), collector).await;
                            let pasted = self
                                .entries
                                .lock()
                                .unwrap()
                                .get(&id)
                                .is_some_and(|entry| entry.pasted);
                            let errors = errors.lock().unwrap().clone();
                            Ended::Failed(claude_failure(&errors, pasted))
                        }
                    },
                };
                exe.kill(&mut child).await;
                ended
            }
            Flow::Codex {
                mut child,
                mut input,
                mut lines,
                login,
            } => {
                let ended = tokio::select! {
                    _ = cancel.cancelled() => Ended::Cancelled,
                    _ = tokio::time::sleep(self.wait) => Ended::Expired,
                    outcome = codex_outcome(&mut input, &mut lines, &login) => match outcome {
                        Ok(()) => Ended::Connected,
                        Err(error) => Ended::Failed(error),
                    },
                };
                exe.kill(&mut child).await;
                ended
            }
        };
        let view = self.entries.lock().unwrap().remove(&id).map(|mut entry| {
            (entry.view.phase, entry.view.message) = match ended {
                Ended::Connected => (Phase::Connected, String::new()),
                Ended::Failed(message) => (Phase::Failed, message),
                Ended::Cancelled if entry.replaced => (Phase::Cancelled, REPLACED.into()),
                Ended::Cancelled => (Phase::Cancelled, String::new()),
                Ended::Expired => (Phase::Expired, EXPIRED.into()),
            };
            entry.view.url = None;
            entry.view.code = false;
            entry.view.code_expected = false;
            entry.view
        });
        if let Some(view) = view {
            notify(&view);
        }
    }
}

type Started = (Flow, String, Option<ChildStdin>);

async fn claude(start: &Start, cancel: &CancellationToken) -> Result<Started, String> {
    let mut command = start.exe.command();
    command
        .args(["auth", "login"])
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if start.exe.wsl.is_some() {
        // Claude Code in WSL cannot reach the Windows browser, so it opens none (`true` stands
        // in for a browser) and this app opens the page instead.
        command
            .env("BROWSER", "true")
            .env("WSLENV", wsl_env("BROWSER/u"));
    } else {
        command.current_dir(&start.directory);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Claude Code's sign-in.")?;
    let input = child.stdin.take();
    let (Some(mut stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        start.exe.kill(&mut child).await;
        return Err("Could not start Claude Code's sign-in.".into());
    };
    let errors = Arc::new(Mutex::new(String::new()));
    let collector = tokio::spawn(collect(stderr, errors.clone()));
    let found = tokio::select! {
        _ = cancel.cancelled() => Err(CANCELLED.to_string()),
        found = tokio::time::timeout(START, claude_page_in(&mut stdout)) => match found {
            Ok(Some(page)) => Ok(page),
            Ok(None) => Err("Claude Code ended before it showed its sign-in page.".to_string()),
            Err(_) => Err("Claude Code did not show its sign-in page. Try again.".to_string()),
        },
    };
    match found {
        Ok(page) => {
            // Keep reading what it prints, so a full pipe never holds it up.
            tokio::spawn(drain(stdout));
            Ok((
                Flow::Claude {
                    child,
                    errors,
                    collector,
                },
                page,
                input,
            ))
        }
        Err(error) => {
            start.exe.kill(&mut child).await;
            let _ = tokio::time::timeout(Duration::from_secs(2), collector).await;
            let reason = last_error(&errors.lock().unwrap());
            Err(match reason {
                Some(reason) if !cancel.is_cancelled() => {
                    format!("Claude Code could not sign in: {reason}")
                }
                _ => error,
            })
        }
    }
}

async fn claude_page_in(stdout: &mut ChildStdout) -> Option<String> {
    let mut text = String::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = stdout.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        if let Some(page) = claude_page(&text) {
            return Some(page);
        }
        keep_tail(&mut text);
    }
}

async fn codex(start: &Start, cancel: &CancellationToken) -> Result<Started, String> {
    let mut command = start.exe.command();
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if start.exe.wsl.is_none() {
        command.current_dir(&start.directory);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Codex's sign-in.")?;
    let (Some(mut input), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        start.exe.kill(&mut child).await;
        return Err("Could not start Codex's sign-in.".into());
    };
    let mut lines = BufReader::new(stdout).lines();
    let found = tokio::select! {
        _ = cancel.cancelled() => Err(CANCELLED.to_string()),
        found = tokio::time::timeout(START, codex_page(&mut input, &mut lines)) => found
            .unwrap_or_else(|_| Err("Codex did not show its sign-in page. Try again.".into())),
    };
    match found {
        Ok((login, page)) => Ok((
            Flow::Codex {
                child,
                input,
                lines: Box::new(lines),
                login,
            },
            page,
            None,
        )),
        Err(error) => {
            start.exe.kill(&mut child).await;
            Err(error)
        }
    }
}

async fn codex_page(
    input: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
) -> Result<(String, String), String> {
    const STOPPED: &str = "Codex stopped before it showed its sign-in page.";
    let initialize = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_studio","version":"0.1.0"}}});
    send(input, &initialize).await.map_err(|_| STOPPED)?;
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let response = value.get("method").is_none();
        if response && value["id"] == 1 {
            if value.get("error").is_some() {
                return Err(
                    "This Codex version cannot sign in here. Update Codex, then try again.".into(),
                );
            }
            send(input, &json!({"method":"initialized"}))
                .await
                .map_err(|_| STOPPED)?;
            let login = json!({"id":2,"method":"account/login/start","params":{"type":"chatgpt"}});
            send(input, &login).await.map_err(|_| STOPPED)?;
        } else if response && value["id"] == 2 {
            if let Some(error) = value.get("error") {
                return Err(match error["message"].as_str().map(|m| plain(m, 300)) {
                    Some(reason) if !reason.is_empty() => {
                        format!("Codex could not start its sign-in: {reason}")
                    }
                    _ => "Codex could not start its sign-in.".into(),
                });
            }
            let result = &value["result"];
            let login = result["loginId"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200);
            return match (login, result["authUrl"].as_str().and_then(sign_in_page)) {
                (Some(login), Some(page)) => Ok((login.into(), page)),
                _ => Err("Codex did not return a sign-in page this app can open.".into()),
            };
        } else {
            decline(input, &value).await;
        }
    }
    Err(STOPPED.into())
}

/// Waits for Codex to report how its sign-in ended.
async fn codex_outcome(
    input: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    login: &str,
) -> Result<(), String> {
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["method"] == "account/login/completed" {
            let params = &value["params"];
            if params["loginId"].as_str().is_some_and(|id| id != login) {
                continue;
            }
            if params["success"] == true {
                return Ok(());
            }
            return Err(match params["error"].as_str().map(|e| plain(e, 300)) {
                Some(reason) if !reason.is_empty() => format!("Codex could not sign in: {reason}"),
                _ => "Codex could not sign in. Open sign-in to try again.".into(),
            });
        }
        decline(input, &value).await;
    }
    Err("Codex stopped before the sign-in finished. Open sign-in to try again.".into())
}

/// Refuses a request the app-server makes: signing in asks the user nothing here.
async fn decline(input: &mut ChildStdin, value: &Value) {
    if value.get("id").is_some() && value["method"].is_string() {
        let refusal = json!({"id":value["id"],"error":{"code":-32601,"message":"Agent Studio's sign-in answers no requests"}});
        let _ = send(input, &refusal).await;
    }
}

async fn send(input: &mut ChildStdin, value: &Value) -> std::io::Result<()> {
    input.write_all(format!("{value}\n").as_bytes()).await?;
    input.flush().await
}

/// Keeps the end of what a CLI wrote on its error output, for the reason it gives.
async fn collect(mut stream: impl AsyncRead + Unpin, into: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = stream.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        let mut text = into.lock().unwrap();
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        keep_tail(&mut text);
    }
}

async fn drain(mut stream: impl AsyncRead + Unpin) {
    let mut buffer = [0u8; 4096];
    while matches!(stream.read(&mut buffer).await, Ok(read) if read > 0) {}
}

fn keep_tail(text: &mut String) {
    if text.len() > OUTPUT {
        let mut start = text.len() - OUTPUT / 2;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
    }
}

static ESCAPES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]").unwrap()
});

/// The page Claude Code's `auth login` names, once its whole line has arrived.
fn claude_page(text: &str) -> Option<String> {
    let text = ESCAPES.replace_all(text, "");
    let rest = &text[text.find("visit: ")? + "visit: ".len()..];
    let end = rest.find(['\r', '\n'])?;
    sign_in_page(&rest[..end])
}

/// A sign-in page a CLI named: an https address, without credentials, that a browser opens.
fn sign_in_page(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty()
        || text.len() > 8192
        || text.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let url = tauri::Url::parse(text).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| text.to_string())
}

/// The state a Claude sign-in page carries, which the code it ends with repeats after `#`.
fn page_state(page: &str) -> Option<String> {
    tauri::Url::parse(page)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .filter(|state| !state.is_empty())
}

/// The line Claude Code takes for a pasted code: the code, `#`, and this sign-in's state.
fn pasted_code(text: &str, state: &str) -> Result<String, String> {
    let shape = |part: &str| {
        !part.is_empty()
            && part.len() <= 2048
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._~+/=".contains(c))
    };
    let (code, pasted) = text
        .trim()
        .split_once('#')
        .filter(|(code, pasted)| shape(code) && shape(pasted))
        .ok_or("Paste the whole code the sign-in page shows, including the part after #.")?;
    if pasted != state {
        return Err(
            "This code is from another sign-in. Open the sign-in page again and paste the code it shows."
                .into(),
        );
    }
    Ok(format!("{code}#{pasted}"))
}

/// The reason a CLI gave on its error output: its last "Login failed:" line, else its last line.
fn last_error(errors: &str) -> Option<String> {
    let errors = ESCAPES.replace_all(errors, "");
    let lines: Vec<&str> = errors
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let line = lines
        .iter()
        .rev()
        .find(|line| line.starts_with("Login failed:"))
        .or(lines.last())
        .copied()?;
    let reason = plain(line.strip_prefix("Login failed:").unwrap_or(line), 300);
    (!reason.is_empty()).then_some(reason)
}

fn claude_failure(errors: &str, pasted: bool) -> String {
    match (pasted, last_error(errors)) {
        (true, Some(reason)) => {
            format!("Claude did not accept the code ({reason}). Open sign-in to try again.")
        }
        (true, None) => "Claude did not accept the code. Open sign-in to try again.".into(),
        (false, Some(reason)) => format!("Claude Code could not sign in: {reason}"),
        (false, None) => {
            "Claude Code's sign-in ended before you signed in. Open sign-in to try again.".into()
        }
    }
}

/// One line of plain text from a CLI, without escapes or characters that hide or reorder text,
/// cut to `max` characters.
fn plain(text: &str, max: usize) -> String {
    let text = ESCAPES.replace_all(text, "");
    let line = text
        .split(|c: char| c.is_whitespace() || crate::console::hidden(c))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let mut cut: String = line.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// `WSLENV` naming one more variable that wsl.exe passes into the distribution.
fn wsl_env(entry: &str) -> String {
    match std::env::var("WSLENV") {
        Ok(current) if !current.is_empty() => format!("{current}:{entry}"),
        _ => entry.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // A CLI played by a Node script, as the selected profile's CLI.
    fn cli(provider: &str, source: &str) -> (Executable, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cli.mjs");
        std::fs::write(&path, source).unwrap();
        let exe = Executable {
            provider: provider.into(),
            program: "node".into(),
            prefix: vec![path.to_string_lossy().into()],
            wsl: None,
        };
        (exe, dir)
    }
    fn request(exe: Executable, dir: &Path, account: &str) -> Start {
        Start {
            provider: exe.provider.clone(),
            exe,
            connection_id: Some(account.into()),
            account: account.into(),
            directory: dir.to_owned(),
        }
    }
    fn recorder() -> (Notify, Arc<Mutex<Vec<View>>>) {
        let views = Arc::new(Mutex::new(vec![]));
        let seen = views.clone();
        (
            Arc::new(move |view: &View| seen.lock().unwrap().push(view.clone())),
            views,
        )
    }
    fn browser(works: bool) -> (Open, Arc<Mutex<Vec<String>>>) {
        let pages = Arc::new(Mutex::new(vec![]));
        let opened = pages.clone();
        (
            Arc::new(move |page: &str| {
                opened.lock().unwrap().push(page.into());
                works
            }),
            pages,
        )
    }
    async fn end_of(views: &Arc<Mutex<Vec<View>>>, id: &str) -> View {
        for _ in 0..400 {
            let ended = views
                .lock()
                .unwrap()
                .iter()
                .find(|view| view.id == id && view.phase != Phase::Waiting)
                .cloned();
            if let Some(view) = ended {
                return view;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the sign-in never ended");
    }

    const CLAUDE: &str = r#"
      import { createInterface } from 'node:readline';
      if (process.argv.slice(2).join(' ') !== 'auth login') { console.error('Unexpected arguments'); process.exit(2); }
      process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=st4te\n");
      process.stdout.write('Paste code here if prompted > ');
      createInterface({ input: process.stdin }).on('line', (line) => {
        if (line === 'good#st4te') { process.stdout.write('Login successful.\n'); process.exit(0); }
        process.stderr.write('Login failed: Request failed with status code 400\n');
        process.exit(1);
      });
    "#;

    #[tokio::test]
    async fn claude_signs_in_hidden_and_takes_only_its_own_pages_code() {
        let (exe, dir) = cli("claude", CLAUDE);
        let signs = SignIns::default();
        let (notify, views) = recorder();
        let (open, pages) = browser(true);
        let view = signs
            .start(request(exe, dir.path(), "account"), notify.clone(), open)
            .await
            .unwrap();
        assert_eq!(view.phase, Phase::Waiting);
        assert_eq!(
            view.url.as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=st4te")
        );
        assert!(view.code && !view.code_expected);
        // Claude Code opens its page itself.
        assert!(pages.lock().unwrap().is_empty());
        assert_eq!(signs.list().len(), 1);
        assert!(signs
            .code(&view.id, "good", &notify)
            .await
            .unwrap_err()
            .contains("including the part after #"));
        assert!(signs
            .code(&view.id, "good#an0ther", &notify)
            .await
            .unwrap_err()
            .contains("another sign-in"));
        let checking = signs
            .code(&view.id, "  good#st4te\n", &notify)
            .await
            .unwrap();
        assert_eq!(checking.message, "Checking the code…");
        let ended = end_of(&views, &view.id).await;
        assert_eq!((ended.phase, ended.url), (Phase::Connected, None));
        assert!(signs.list().is_empty() && signs.tokens().is_empty());
    }

    #[tokio::test]
    async fn a_refused_code_ends_the_sign_in_with_the_clis_reason() {
        let (exe, dir) = cli("claude", CLAUDE);
        let signs = SignIns::default();
        let (notify, views) = recorder();
        let view = signs
            .start(
                request(exe, dir.path(), "account"),
                notify.clone(),
                browser(true).0,
            )
            .await
            .unwrap();
        signs.code(&view.id, "wrong#st4te", &notify).await.unwrap();
        let ended = end_of(&views, &view.id).await;
        assert_eq!(ended.phase, Phase::Failed);
        assert_eq!(
            ended.message,
            "Claude did not accept the code (Request failed with status code 400). Open sign-in to try again."
        );
        assert!(signs
            .code(&view.id, "good#st4te", &notify)
            .await
            .unwrap_err()
            .contains("has ended"));
    }

    #[tokio::test]
    async fn claude_says_why_it_could_not_start() {
        let (exe, dir) = cli(
            "claude",
            r#"process.stderr.write('\u001b[31mManaged settings on this machine configure a Cloud gateway sign-in; run interactive /login to authenticate.\u001b[0m\n'); process.exit(1);"#,
        );
        let signs = SignIns::default();
        let error = signs
            .start(
                request(exe, dir.path(), "account"),
                recorder().0,
                browser(true).0,
            )
            .await
            .unwrap_err();
        assert_eq!(error, "Claude Code could not sign in: Managed settings on this machine configure a Cloud gateway sign-in; run interactive /login to authenticate.");
        assert!(signs.tokens().is_empty());
    }

    // Codex's app-server, whose sign-in ends as `outcome` says: success, fail or never.
    fn codex_cli(outcome: &str) -> (Executable, tempfile::TempDir) {
        let source = r#"
          import { createInterface } from 'node:readline';
          const send = (v) => console.log(JSON.stringify(v));
          const outcome = 'OUTCOME';
          if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(2);
          createInterface({ input: process.stdin }).on('line', (line) => {
            const v = JSON.parse(line);
            if (v.method === 'initialize') send({ id: v.id, result: {} });
            if (v.method === 'account/login/start' && v.params.type === 'chatgpt') {
              send({ id: v.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize?state=x' } });
              // Asks something, which the sign-in refuses before it ends.
              send({ id: 99, method: 'item/tool/requestUserInput', params: {} });
            }
            if (v.id === 99 && v.error && outcome !== 'never') {
              send({ method: 'account/login/completed', params: { loginId: 'other', success: true, error: null } });
              send({ method: 'account/login/completed', params: outcome === 'fail'
                ? { loginId: 'login-1', success: false, error: 'Login server error: Login was not completed' }
                : { loginId: 'login-1', success: true, error: null } });
            }
          });
        "#;
        cli("codex", &source.replace("OUTCOME", outcome))
    }

    #[tokio::test]
    async fn codex_opens_its_page_and_follows_its_own_login_to_the_end() {
        let (exe, dir) = codex_cli("success");
        let signs = SignIns::default();
        let (notify, views) = recorder();
        let (open, pages) = browser(true);
        let view = signs
            .start(request(exe, dir.path(), "account"), notify, open)
            .await
            .unwrap();
        assert_eq!(
            *pages.lock().unwrap(),
            ["https://auth.openai.com/oauth/authorize?state=x"]
        );
        assert!(!view.code && view.message.is_empty());
        let ended = end_of(&views, &view.id).await;
        assert_eq!(ended.phase, Phase::Connected);
        assert!(signs.tokens().is_empty());
    }

    #[tokio::test]
    async fn codex_failures_and_closed_browsers_are_explained() {
        let (exe, dir) = codex_cli("fail");
        let signs = SignIns::default();
        let (notify, views) = recorder();
        let view = signs
            .start(
                request(exe, dir.path(), "account"),
                notify,
                browser(false).0,
            )
            .await
            .unwrap();
        assert_eq!(
            view.message,
            "Your browser did not open. Open the sign-in page to continue."
        );
        let ended = end_of(&views, &view.id).await;
        assert_eq!(
            (ended.phase, ended.message.as_str()),
            (
                Phase::Failed,
                "Codex could not sign in: Login server error: Login was not completed"
            )
        );
    }

    #[tokio::test]
    async fn sign_ins_end_when_replaced_cancelled_or_left_waiting() {
        let (exe, dir) = codex_cli("never");
        let signs = SignIns::default();
        let (notify, views) = recorder();
        let first = signs
            .start(
                request(exe.clone(), dir.path(), "first"),
                notify.clone(),
                browser(true).0,
            )
            .await
            .unwrap();
        // Codex signs in one account at a time on a computer.
        let second = signs
            .start(
                request(exe, dir.path(), "second"),
                notify.clone(),
                browser(true).0,
            )
            .await
            .unwrap();
        let replaced = end_of(&views, &first.id).await;
        assert_eq!(
            (replaced.phase, replaced.message.as_str()),
            (Phase::Cancelled, REPLACED)
        );
        assert_eq!(signs.list().len(), 1);
        signs.cancel(&second.id);
        let cancelled = end_of(&views, &second.id).await;
        assert_eq!(
            (cancelled.phase, cancelled.message.as_str()),
            (Phase::Cancelled, "")
        );
        assert!(signs.tokens().is_empty());

        // A sign-in nobody finishes ends by itself.
        let (exe, dir) = cli("claude", CLAUDE);
        let waiting = SignIns {
            wait: Duration::from_millis(300),
            ..SignIns::default()
        };
        let view = waiting
            .start(request(exe, dir.path(), "third"), notify, browser(true).0)
            .await
            .unwrap();
        let expired = end_of(&views, &view.id).await;
        assert_eq!(
            (expired.phase, expired.message.as_str()),
            (Phase::Expired, EXPIRED)
        );
        assert!(waiting.tokens().is_empty());
    }

    #[tokio::test]
    #[ignore = "Opt-in: starts the installed Claude Code and Codex sign-ins in throwaway profiles, opens no browser and cancels them"]
    async fn installed_clis_show_their_sign_in_pages_without_a_terminal() {
        // Claude Code opens its own page through BROWSER, which names no program here.
        std::env::set_var("BROWSER", "agent-studio-test-no-browser");
        for provider in ["claude", "codex"] {
            let root = tempfile::tempdir().unwrap();
            // Codex refuses a CODEX_HOME that does not exist; profiles create theirs.
            std::fs::create_dir_all(root.path().join("profile")).unwrap();
            let profile = crate::profiles::Profile {
                id: "probe".into(),
                provider: provider.into(),
                root: Some(root.path().join("profile")),
                isolated: true,
                ..Default::default()
            };
            crate::profiles::scope(profile, async {
                let exe = crate::providers::resolve(provider).await.unwrap();
                let signs = SignIns::default();
                let (notify, views) = recorder();
                let (open, pages) = browser(true);
                let view = signs
                    .start(request(exe, root.path(), "probe"), notify, open)
                    .await
                    .unwrap();
                let page = view.url.clone().unwrap();
                if provider == "claude" {
                    assert!(view.code && page_state(&page).is_some());
                    assert!(pages.lock().unwrap().is_empty());
                } else {
                    assert_eq!(*pages.lock().unwrap(), [page]);
                }
                signs.cancel(&view.id);
                assert_eq!(end_of(&views, &view.id).await.phase, Phase::Cancelled);
                assert!(signs.tokens().is_empty());
            })
            .await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in: starts Claude Code and Codex sign-ins inside a WSL distribution (AGENT_STUDIO_TEST_DISTRO, else Ubuntu) in a throwaway profile, opens no browser and cancels them"]
    async fn wsl_sign_ins_open_their_page_on_windows_and_stop_inside_the_distribution() {
        let distro = std::env::var("AGENT_STUDIO_TEST_DISTRO").unwrap_or_else(|_| "Ubuntu".into());
        let namespace = format!("agent-studio-bridge-test-{}", uuid::Uuid::new_v4());
        let root = tempfile::tempdir().unwrap();
        // wsl.exe hands BROWSER to the Linux CLI, which then opens no browser of its own.
        let launch = crate::wsl::Launch {
            distribution: distro.clone(),
            namespace: namespace.clone(),
            job: uuid::Uuid::new_v4().to_string(),
            shared: false,
        };
        let shell = Executable {
            provider: "claude".into(),
            program: "wsl.exe".into(),
            prefix: launch.prefix("claude", "/bin/bash", "existing"),
            wsl: Some(launch),
        };
        let output = shell
            .command()
            .args(["-c", r#"printf '%s' "${BROWSER-}""#])
            .env("BROWSER", "true")
            .env("WSLENV", wsl_env("BROWSER/u"))
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "true");
        for provider in ["claude", "codex"] {
            let profile = crate::profiles::Profile {
                id: uuid::Uuid::new_v4().to_string(),
                provider: provider.into(),
                distribution: Some(distro.clone()),
                namespace: namespace.clone(),
                isolated: true,
                ..Default::default()
            };
            crate::profiles::scope(profile, async {
                let exe = crate::providers::resolve(provider).await.unwrap();
                assert!(exe.wsl.is_some());
                let signs = SignIns::default();
                let (notify, views) = recorder();
                let (open, pages) = browser(true);
                let view = signs
                    .start(request(exe, root.path(), "wsl-probe"), notify, open)
                    .await
                    .unwrap();
                // This app opens the page on Windows for both.
                assert_eq!(*pages.lock().unwrap(), [view.url.clone().unwrap()]);
                if provider == "claude" {
                    assert!(view.code && view.code_expected);
                    assert_eq!(
                        view.message,
                        "Sign in on the page that opened, then paste the code it shows."
                    );
                }
                signs.cancel(&view.id);
                assert_eq!(end_of(&views, &view.id).await.phase, Phase::Cancelled);
            })
            .await;
        }
        // Nothing that ran with the throwaway profile still runs in the distribution.
        let mut check = tokio::process::Command::new("wsl.exe");
        check
            .args([
                "-d",
                &distro,
                "--exec",
                "bash",
                "-c",
                r#"! grep -lsF -- "$1" /proc/[0-9]*/environ"#,
                "check",
                &namespace,
            ])
            .creation_flags(0x08000000);
        assert!(
            check.status().await.unwrap().success(),
            "a sign-in kept running in WSL"
        );
        let mut cleanup = tokio::process::Command::new("wsl.exe");
        cleanup.args(["-d", &distro, "--exec", "bash", "-c", "case \"$1\" in agent-studio-bridge-test-*) rm -rf -- \"$HOME/.local/share/$1\";; *) exit 1;; esac", "cleanup", &namespace]).creation_flags(0x08000000);
        assert!(cleanup.status().await.unwrap().success());
    }

    #[test]
    fn only_a_whole_https_page_line_is_a_sign_in_page() {
        let line = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=abc\n";
        assert_eq!(
            claude_page(line).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?state=abc")
        );
        // Not yet whole, or wrapped in a terminal link.
        assert_eq!(claude_page(&line[..line.len() - 5]), None);
        assert_eq!(
            claude_page(
                "visit: \u{1b}]8;;https://claude.com/a?state=s\u{7}https://claude.com/a?state=s\u{1b}]8;;\u{7}\n"
            )
            .as_deref(),
            Some("https://claude.com/a?state=s")
        );
        for page in [
            "http://claude.com/a",
            "javascript:alert(1)",
            "file:///C:/Windows",
            "https://user:pass@claude.com/a",
            "https://claude.com/a b",
            "https://",
        ] {
            assert_eq!(sign_in_page(page), None, "{page}");
        }
        assert_eq!(
            page_state("https://claude.com/a?code=true&state=s%2B1").as_deref(),
            Some("s+1")
        );
        assert_eq!(page_state("https://claude.com/a?code=true"), None);
    }

    #[test]
    fn pasted_codes_must_be_whole_and_belong_to_this_sign_in() {
        assert_eq!(
            pasted_code(" abc-_.~+/=#st4te \n", "st4te").unwrap(),
            "abc-_.~+/=#st4te"
        );
        assert!(pasted_code("abc", "st4te").is_err());
        assert!(pasted_code("#st4te", "st4te").is_err());
        assert!(pasted_code("abc#", "st4te").is_err());
        assert!(pasted_code("abc def#st4te", "st4te").is_err());
        assert!(pasted_code("abc#st4te#more", "st4te").is_err());
        assert!(pasted_code("abc;rm#st4te", "st4te").is_err());
        assert!(pasted_code("abc#other", "st4te")
            .unwrap_err()
            .contains("another sign-in"));
    }

    #[test]
    fn cli_reasons_become_one_bounded_plain_line() {
        assert_eq!(
            last_error("noise\nLogin failed: Request failed\nwith detail\n"),
            Some("Request failed".into())
        );
        assert_eq!(last_error("\n  \n"), None);
        assert_eq!(
            plain("a\u{202e}b \u{1b}[1mbold\u{1b}[0m\tend", 100),
            "a b bold end"
        );
        assert_eq!(plain(&"x".repeat(400), 300).chars().count(), 300);
        assert_eq!(
            claude_failure("", false),
            "Claude Code's sign-in ended before you signed in. Open sign-in to try again."
        );
    }
}
