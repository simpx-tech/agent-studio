//! Keep the Claude Code and Codex CLIs current on this computer. See docs/UPDATES.md.
//!
//! Both CLIs update themselves only from their interactive terminals, and Agent Studio always runs
//! them headless, so a CLI used through Agent Studio alone kept the version it was installed with,
//! and with it the models it offers: Claude Code 2.1.278 runs Opus 5 for `opus` where 2.1.281 runs
//! Opus 5.5. This runs each CLI's own updater a minute after the app starts and every six hours,
//! for this computer's CLIs and, on Windows, a WSL distribution's only while it already runs, so an
//! automatic check never starts one. `claude update` follows its release channel and any version
//! policy and verifies the signed build before swapping it in. `codex update` reruns whatever
//! installed Codex: its checksum-verifying standalone installer, npm, bun, pnpm or Homebrew. So it
//! runs only when a newer Codex is published, and a Windows package-manager installation, whose
//! files are replaced in place, waits until no Codex process of this app runs them.
use crate::providers::Executable;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    process::Stdio,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};

const EVENT: &str = "studio-cli-update";
const FIRST_CHECK: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(30 * 60);
const CHECK_EVERY_MS: u64 = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS: u64 = 60 * 60 * 1000;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A first install downloads the whole CLI, about 240 MB for Claude Code.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: u64 = 64 * 1024;
const MESSAGE_LIMIT: usize = 240;
const SETTINGS_FILE: &str = "cli-updates.json";
/// The newest published Codex, the release every installer of it resolves as latest.
const CODEX_LATEST: &str = "https://registry.npmjs.org/@openai/codex/latest";

/// The CLIs kept current, by provider.
const CLIS: [(&str, &str); 2] = [("claude", "Claude Code"), ("codex", "Codex")];

fn cli_name(provider: &str) -> &'static str {
    CLIS.iter()
        .find(|(id, _)| *id == provider)
        .map_or("The CLI", |(_, name)| name)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Checking,
    /// Up to date, or held at its version by a release channel or version policy.
    Current,
    Updated,
    /// A newer Codex waits until no process of this app runs the files its installer replaces.
    Waiting,
    /// Another Claude Code update held the install lock; the next check retries.
    Busy,
    /// A package manager owns this installation, or the CLI cannot tell how it was installed.
    Managed,
    /// An administrator turned Claude Code updates off.
    Blocked,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    provider: &'static str,
    environment_id: String,
    phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// The version an update replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
impl Status {
    fn new(provider: &'static str, environment_id: String, phase: Phase) -> Self {
        Self {
            provider,
            environment_id,
            phase,
            version: None,
            previous: None,
            checked_at: None,
            message: None,
        }
    }
}

/// Which CLIs update automatically on this device, all of them unless turned off.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default)]
pub struct Automatic {
    claude: bool,
    codex: bool,
}
impl Default for Automatic {
    fn default() -> Self {
        Self {
            claude: true,
            codex: true,
        }
    }
}
impl Automatic {
    fn get(self, provider: &str) -> bool {
        match provider {
            "claude" => self.claude,
            "codex" => self.codex,
            _ => false,
        }
    }
    fn set(&mut self, provider: &str, automatic: bool) {
        match provider {
            "claude" => self.claude = automatic,
            "codex" => self.codex = automatic,
            _ => {}
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    automatic: Automatic,
    /// Why automatic Claude Code checks are off although its switch is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<&'static str>,
    statuses: Vec<Status>,
}

#[derive(Default)]
struct Inner {
    /// Read from app data on first use.
    automatic: Option<Automatic>,
    statuses: BTreeMap<String, Status>,
}

#[derive(Default)]
pub struct CliUpdates {
    inner: Mutex<Inner>,
    checking: tokio::sync::Mutex<()>,
    /// Installations under way, by provider and environment.
    installing: Mutex<std::collections::BTreeSet<String>>,
}
impl CliUpdates {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Claude Code's own switch for automatic updates also stops Agent Studio's.
fn environment_notice(value: Option<std::ffi::OsString>) -> Option<&'static str> {
    let value = value?.to_string_lossy().trim().to_ascii_lowercase();
    (!["", "0", "false", "no", "off"].contains(&value.as_str())).then_some(
        "DISABLE_AUTOUPDATER is set for Agent Studio, so it leaves Claude Code as it is. Check for updates still runs it.",
    )
}

fn claude_notice() -> Option<&'static str> {
    environment_notice(std::env::var_os("DISABLE_AUTOUPDATER"))
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<CliUpdates>();
    let inner = state.lock();
    Snapshot {
        automatic: inner.automatic.unwrap_or_default(),
        notice: claude_notice(),
        statuses: inner.statuses.values().cloned().collect(),
    }
}

fn key(provider: &str, environment_id: &str) -> String {
    format!("{provider}:{environment_id}")
}

fn record(app: &AppHandle, status: Status) {
    app.state::<CliUpdates>()
        .lock()
        .statuses
        .insert(key(status.provider, &status.environment_id), status);
    let _ = app.emit(EVENT, snapshot(app));
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate CLI update settings")?
        .join(SETTINGS_FILE))
}

async fn load_settings(app: &AppHandle) -> Result<Automatic, String> {
    if let Some(automatic) = app.state::<CliUpdates>().lock().automatic {
        return Ok(automatic);
    }
    let path = settings_path(app)?;
    let automatic = tauri::async_runtime::spawn_blocking(move || match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 10_000 => serde_json::from_slice::<Automatic>(&bytes)
            .map_err(|_| "Cannot read CLI update settings".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Automatic::default()),
        _ => Err("Cannot read CLI update settings".into()),
    })
    .await
    .map_err(|_| "Cannot read CLI update settings")??;
    app.state::<CliUpdates>().lock().automatic = Some(automatic);
    Ok(automatic)
}

async fn save_settings(app: &AppHandle, automatic: Automatic) -> Result<(), String> {
    let path = settings_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = path.parent().ok_or("Cannot locate CLI update settings")?;
        std::fs::create_dir_all(root).map_err(|_| "Cannot save CLI update settings")?;
        let mut file =
            tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot save CLI update settings")?;
        file.write_all(&serde_json::to_vec(&automatic).map_err(|_| "Cannot encode settings")?)
            .map_err(|_| "Cannot save CLI update settings")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot save CLI update settings")?;
        file.persist(path)
            .map_err(|_| "Cannot finish saving CLI update settings")?;
        Ok(())
    })
    .await
    .map_err(|_| "Cannot save CLI update settings")??;
    app.state::<CliUpdates>().lock().automatic = Some(automatic);
    Ok(())
}

/// Check a minute after startup, then look every half hour for installations whose last check
/// is six hours old, an hour after a failed one, or waiting for their CLI to be free.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

fn due(status: Option<&Status>, now: u64) -> bool {
    let Some(checked_at) = status.and_then(|status| status.checked_at) else {
        return true;
    };
    let wait = match status.map(|status| status.phase) {
        Some(Phase::Waiting) => 0,
        Some(Phase::Failed | Phase::Busy) => RETRY_AFTER_MS,
        _ => CHECK_EVERY_MS,
    };
    now.saturating_sub(checked_at) >= wait
}

struct Installation {
    provider: &'static str,
    environment_id: String,
    exe: Executable,
}

/// This computer's CLIs and, on Windows, those of each WSL distribution already running.
async fn installations(app: &AppHandle, providers: &[&'static str]) -> Vec<Installation> {
    let Ok(installation) = crate::profiles::installation(app) else {
        return vec![];
    };
    let mut found = vec![];
    for &provider in providers {
        // Outside any connection's scope this is the CLI on PATH, which every profile shares.
        if let Ok(exe) = crate::providers::resolve(provider).await {
            found.push(Installation {
                provider,
                environment_id: installation.id.clone(),
                exe,
            });
        }
    }
    #[cfg(windows)]
    if let Ok(discovery) = crate::wsl::discover(&installation.id).await {
        for distribution in discovery.distributions {
            if distribution.running != Some(true) {
                continue;
            }
            for &provider in providers {
                let Ok(profile) = crate::profiles::resolve(app, provider, None) else {
                    continue;
                };
                let resolved = crate::profiles::scope(
                    profile,
                    crate::wsl::resolve(provider, &distribution.name),
                );
                if let Ok(exe) = resolved.await {
                    found.push(Installation {
                        provider,
                        environment_id: distribution.id.clone(),
                        exe,
                    });
                }
            }
        }
    }
    found
}

/// Update every installation that is due, or all of them when asked to.
async fn check(app: &AppHandle, forced: bool) -> Snapshot {
    // A check requested during a background one reports the one already running.
    let state = app.state::<CliUpdates>();
    let Ok(_checking) = state.checking.try_lock() else {
        return snapshot(app);
    };
    let automatic = load_settings(app).await.unwrap_or_default();
    let providers: Vec<&'static str> = CLIS
        .iter()
        .map(|(provider, _)| *provider)
        .filter(|provider| {
            forced
                || (automatic.get(provider) && (*provider != "claude" || claude_notice().is_none()))
        })
        .collect();
    if providers.is_empty() {
        return snapshot(app);
    }
    // The newest published Codex, read once for every Codex installation in this pass.
    let mut latest_codex: Option<Option<String>> = None;
    for Installation {
        provider,
        environment_id,
        exe,
    } in installations(app, &providers).await
    {
        let previous = state
            .lock()
            .statuses
            .get(&key(provider, &environment_id))
            .cloned();
        if !forced && !due(previous.as_ref(), now()) {
            continue;
        }
        let mut checking = Status::new(provider, environment_id.clone(), Phase::Checking);
        checking.version = previous.and_then(|status| status.version);
        record(app, checking);
        let before = version(&exe).await;
        if provider == "codex" {
            if latest_codex.is_none() {
                latest_codex = Some(latest_codex_version().await);
            }
            let latest = latest_codex.clone().flatten();
            match codex_plan(before.as_deref(), latest.as_deref(), in_use(app, &exe)) {
                Plan::Update => {}
                Plan::Current => {
                    let mut status = Status::new(provider, environment_id, Phase::Current);
                    status.version = before;
                    status.checked_at = Some(now());
                    record(app, status);
                    continue;
                }
                Plan::Wait(message) => {
                    let mut status = Status::new(provider, environment_id, Phase::Waiting);
                    status.version = before;
                    status.checked_at = Some(now());
                    status.message = Some(message);
                    record(app, status);
                    continue;
                }
            }
        }
        let run = run(&exe, &["update"], UPDATE_TIMEOUT).await;
        let after = version(&exe).await;
        record(
            app,
            outcome(provider, environment_id, before, after, run, now()),
        );
    }
    snapshot(app)
}

/// What a Codex installation needs before its updater may run.
#[derive(Debug, PartialEq)]
enum Plan {
    Update,
    Current,
    Wait(String),
}

fn codex_plan(before: Option<&str>, latest: Option<&str>, in_use: bool) -> Plan {
    if let (Some(before), Some(latest)) = (before, latest) {
        if !newer(latest, before) {
            return Plan::Current;
        }
    }
    if in_use {
        let available = latest.map_or("A newer Codex".to_string(), |v| format!("Codex {v}"));
        return Plan::Wait(format!(
            "{available} is available. Agent Studio installs it once no Codex chat on this computer is replying or waiting for its next message."
        ));
    }
    Plan::Update
}

/// Whether `latest` is a later release than `installed`, comparing their numbers.
fn newer(latest: &str, installed: &str) -> bool {
    let numbers = |version: &str| -> Vec<u64> {
        version
            .split(['-', '+'])
            .next()
            .unwrap_or_default()
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    numbers(latest) > numbers(installed)
}

async fn latest_codex_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("AgentStudio/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let response = client.get(CODEX_LATEST).send().await.ok()?;
    let response = response.error_for_status().ok()?;
    if response
        .content_length()
        .is_some_and(|size| size > 1_000_000)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parse_version(value["version"].as_str()?)
}

/// A Windows installation a package manager replaces in place, which it cannot do while this
/// app runs or keeps a process of it. The standalone installer adds each release beside the
/// running one and switches a link, and Linux replaces files that stay open.
fn in_use(app: &AppHandle, exe: &Executable) -> bool {
    replaced_in_place(exe)
        && (app
            .state::<crate::runner::Runs>()
            .0
            .lock()
            .map_or(true, |runs| !runs.is_empty())
            || app.state::<crate::pool::Pool>().holds_native(&exe.provider))
}

fn replaced_in_place(exe: &Executable) -> bool {
    cfg!(windows) && exe.wsl.is_none() && !standalone(exe)
}

/// Codex's standalone installer keeps each release under `packages/standalone/releases/`.
fn standalone(exe: &Executable) -> bool {
    exe.prefix.is_empty()
        && std::fs::canonicalize(&exe.program).is_ok_and(|path| {
            path.to_string_lossy()
                .replace('\\', "/")
                .to_lowercase()
                .contains("/packages/standalone/releases/")
        })
}

struct Output {
    success: bool,
    text: String,
}

async fn read(stream: Option<impl AsyncRead + Unpin>) -> String {
    let mut bytes = Vec::new();
    if let Some(stream) = stream {
        let _ = stream.take(OUTPUT_LIMIT).read_to_end(&mut bytes).await;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Run the CLI without input, keeping the beginning of what it printed.
async fn run(exe: &Executable, args: &[&str], limit: Duration) -> Result<Output, String> {
    let name = cli_name(&exe.provider);
    let mut command = exe.command();
    command
        .args(args)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| format!("Could not start {name}"))?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let finished = tokio::time::timeout(limit, async {
        let (stdout, stderr) = tokio::join!(read(stdout), read(stderr));
        (child.wait().await, stdout, stderr)
    })
    .await;
    match finished {
        Ok((Ok(status), stdout, stderr)) => Ok(Output {
            success: status.success(),
            text: plain(&format!("{stdout}\n{stderr}")),
        }),
        Ok((Err(_), ..)) => Err(format!("{name} stopped unexpectedly.")),
        Err(_) => {
            exe.kill(&mut child).await;
            Err(format!("{name} did not finish updating in time."))
        }
    }
}

async fn version(exe: &Executable) -> Option<String> {
    let output = run(exe, &["--version"], VERSION_TIMEOUT).await.ok()?;
    output
        .success
        .then(|| parse_version(&output.text))
        .flatten()
}

/// The first number-led word: `2.1.278 (Claude Code)` and `codex-cli 0.153.4` give their
/// versions.
fn parse_version(text: &str) -> Option<String> {
    let token = text
        .split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))?;
    let valid = token.len() <= 40
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
    valid.then(|| token.to_string())
}

/// Printable text without terminal color sequences or carriage-return redraws.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c == '\n' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

fn bounded(line: &str) -> String {
    let line = line.trim();
    if line.chars().count() <= MESSAGE_LIMIT {
        return line.to_string();
    }
    let mut short: String = line.chars().take(MESSAGE_LIMIT - 1).collect();
    short.push('…');
    short
}

fn line_with<'a>(text: &'a str, needle: &str) -> Option<&'a str> {
    text.lines().find(|line| line.contains(needle))
}

/// Why an update failed: the error and its reason, not the warnings printed before them, with
/// Codex's echo of the whole installer command shortened.
fn failure(text: &str, name: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("Current version")
                && !line.starts_with("Checking for updates")
                && !line.starts_with("Try running")
                && !line.starts_with("Updating Codex via")
                && !line.starts_with("At line:")
                && !line.starts_with('+')
        })
        .map(|line| match line.split_once("` failed with status ") {
            Some((_, status)) => format!("The installer failed with status {status}."),
            None => line.to_string(),
        })
        .collect();
    let start = lines
        .iter()
        .position(|line| {
            ["rror", "ailed", "Could not", "did not", "Cannot", "Invalid"]
                .iter()
                .any(|needle| line.contains(needle))
        })
        .unwrap_or(lines.len().saturating_sub(2));
    let reason = lines[start..].iter().take(2).cloned().collect::<Vec<_>>();
    if reason.is_empty() {
        format!("{name} could not update.")
    } else {
        bounded(&reason.join(" "))
    }
}

/// Read one update from the versions before and after it and from the CLI's own messages
/// (Claude Code 2.1.278, Codex 0.153.4).
fn outcome(
    provider: &'static str,
    environment_id: String,
    before: Option<String>,
    after: Option<String>,
    run: Result<Output, String>,
    checked_at: u64,
) -> Status {
    let name = cli_name(provider);
    let mut status = Status::new(provider, environment_id, Phase::Current);
    status.version = after.clone().or(before.clone());
    status.checked_at = Some(checked_at);
    let output = match run {
        Ok(output) => output,
        Err(message) => {
            status.phase = Phase::Failed;
            status.message = Some(message);
            return status;
        }
    };
    let text = output.text.as_str();
    let changed = matches!((&before, &after), (Some(before), Some(after)) if before != after);
    // The message counts only when the version before the run is unknown.
    let reported = ["Successfully updated", "Update ran successfully"]
        .iter()
        .any(|needle| text.contains(needle));
    if changed || (before.is_none() && after.is_some() && reported) {
        status.phase = Phase::Updated;
        status.previous = before.filter(|before| Some(before) != after.as_ref());
    } else if text.contains("Could not detect the Codex installation method")
        || text.contains("not available in debug builds")
    {
        status.phase = Phase::Managed;
        status.message = Some(
            "Codex cannot tell how it was installed. Update it the way you installed it.".into(),
        );
    } else if let Some(line) =
        line_with(text, "is managed by").or_else(|| line_with(text, "managed by a package manager"))
    {
        status.phase = Phase::Managed;
        let command = text.lines().map(str::trim).find(|line| {
            ["brew upgrade", "winget upgrade", "apk upgrade"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        });
        status.message = Some(bounded(&match command {
            Some(command) => format!("{} Update it with {command}.", line.trim()),
            None => line.to_string(),
        }));
    } else if text.contains("disabled by your administrator") {
        status.phase = Phase::Blocked;
        status.message = Some(format!("Your administrator turned {name} updates off."));
    } else if text.contains("is currently running. Please try again") {
        status.phase = Phase::Busy;
        status.message = Some(format!(
            "Another {name} update was running. Agent Studio tries again in an hour."
        ));
    } else if !output.success {
        status.phase = Phase::Failed;
        status.message = Some(failure(text, name));
    } else {
        // Up to date, or held back by a release channel, a version policy or a release that
        // predates signed builds: those print why the version stays.
        status.message = ["Staying on", "newer than the", "predates release-signature"]
            .iter()
            .find_map(|needle| line_with(text, needle))
            .map(bounded);
    }
    status
}

#[tauri::command]
pub async fn cli_update_status(app: AppHandle) -> Result<Snapshot, String> {
    load_settings(&app).await?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn set_cli_auto_update(
    app: AppHandle,
    provider: String,
    automatic: bool,
) -> Result<Snapshot, String> {
    if !CLIS.iter().any(|(id, _)| *id == provider) {
        return Err("Agent Studio updates only Claude Code and Codex.".into());
    }
    let mut settings = load_settings(&app).await?;
    settings.set(&provider, automatic);
    save_settings(&app, settings).await?;
    let _ = app.emit(EVENT, snapshot(&app));
    if automatic {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            check(&app, false).await;
        });
    }
    Ok(snapshot(&app))
}

/// Check every installation now, including a WSL distribution the automatic check skipped
/// because it was not running.
#[tauri::command]
pub async fn check_cli_updates(app: AppHandle) -> Result<Snapshot, String> {
    load_settings(&app).await?;
    Ok(check(&app, true).await)
}

/// The version an installer run reported, from the launcher's last line.
fn installed_version(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("agent-studio-installed "))
        .and_then(parse_version)
}

/// Install Claude Code or Codex inside one of this computer's WSL distributions, where a chat in
/// one of its folders runs, with the provider's own installer, as its documentation tells people
/// to: Anthropic's `install.sh` and OpenAI's standalone Codex `install.sh`, each verifying the build
/// it downloads into the default user's `~/.local/bin`. Only this explicit request installs;
/// detection and update checks never do. Returns the installed version.
#[tauri::command]
pub async fn install_cli(
    app: AppHandle,
    provider: String,
    environment_id: String,
) -> Result<String, String> {
    let Some(provider) = CLIS.iter().map(|(id, _)| *id).find(|id| *id == provider) else {
        return Err("Agent Studio installs only Claude Code and Codex.".into());
    };
    let name = cli_name(provider);
    let distribution = crate::folders::environment_distribution(&app, &environment_id)?
        .ok_or("Agent Studio installs CLIs inside this computer's WSL distributions only.")?;
    let state = app.state::<CliUpdates>();
    let job = key(provider, &environment_id);
    if !state
        .installing
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(job.clone())
    {
        return Err(format!("{name} is already being installed there."));
    }
    let result = install_in(provider, &distribution).await;
    state
        .installing
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&job);
    install_outcome(name, &result?)
}

/// The version an installer run installed, or why it did not install one.
fn install_outcome(name: &str, output: &Output) -> Result<String, String> {
    match installed_version(&output.text) {
        Some(version) if output.success => Ok(version),
        _ if output.success => Err(format!(
            "{name} was installed, but it does not run in this distribution."
        )),
        _ => {
            let reason = failure(&output.text, name);
            Err(if reason == format!("{name} could not update.") {
                format!("{name} could not be installed.")
            } else {
                reason
            })
        }
    }
}

async fn install_in(provider: &'static str, distribution: &str) -> Result<Output, String> {
    #[cfg(windows)]
    {
        let script = crate::wsl::embedded_script(&format!(
            "{}\n{}",
            include_str!("wsl-env.sh"),
            include_str!("wsl-install.sh")
        ));
        let mut command = tokio::process::Command::new("wsl.exe");
        command
            .args([
                "--distribution",
                distribution,
                "--cd",
                "~",
                "--exec",
                "bash",
                "-lc",
                &script,
                "agent-studio",
                provider,
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let name = cli_name(provider);
        let mut child = command
            .spawn()
            .map_err(|_| format!("Could not start WSL to install {name}."))?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let finished = tokio::time::timeout(INSTALL_TIMEOUT, async {
            let (stdout, stderr) = tokio::join!(read(stdout), read(stderr));
            (child.wait().await, stdout, stderr)
        })
        .await;
        match finished {
            Ok((Ok(status), stdout, stderr)) => Ok(Output {
                success: status.success(),
                text: plain(&format!("{stdout}\n{stderr}")),
            }),
            Ok((Err(_), ..)) => Err(format!("The {name} installer stopped unexpectedly.")),
            Err(_) => Err(format!("The {name} installer did not finish in time.")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (provider, distribution);
        Err("CLIs are installed in WSL from its Windows computer.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(success: bool, text: &str) -> Result<Output, String> {
        Ok(Output {
            success,
            text: plain(text),
        })
    }
    fn read_out(before: Option<&str>, after: Option<&str>, run: Result<Output, String>) -> Status {
        outcome(
            "claude",
            "env".into(),
            before.map(String::from),
            after.map(String::from),
            run,
            7,
        )
    }
    fn read_codex(
        before: Option<&str>,
        after: Option<&str>,
        run: Result<Output, String>,
    ) -> Status {
        outcome(
            "codex",
            "env".into(),
            before.map(String::from),
            after.map(String::from),
            run,
            7,
        )
    }

    #[test]
    fn versions_come_from_the_version_flag() {
        assert_eq!(
            parse_version("2.1.278 (Claude Code)\n").as_deref(),
            Some("2.1.278")
        );
        assert_eq!(
            parse_version("codex-cli 0.153.4\n").as_deref(),
            Some("0.153.4")
        );
        assert_eq!(parse_version("2.2.0-rc.1").as_deref(), Some("2.2.0-rc.1"));
        for text in ["", "error: unknown option", "2.1.278;rm", "codex-cli"] {
            assert_eq!(parse_version(text), None, "{text}");
        }
    }

    #[test]
    fn a_newer_codex_is_one_with_greater_numbers() {
        assert!(newer("0.157.1", "0.153.4"));
        assert!(newer("0.160.0", "0.157.10"));
        assert!(newer("1.0.0", "0.999.9"));
        for (latest, installed) in [
            ("0.157.1", "0.157.1"),
            ("0.157.1", "0.158.0-alpha.2"),
            ("0.157.1", "0.157.2"),
            ("0.9.0", "0.10.0"),
        ] {
            assert!(!newer(latest, installed), "{latest} vs {installed}");
        }
    }

    #[test]
    fn codex_updates_only_when_newer_and_free() {
        assert_eq!(
            codex_plan(Some("0.157.1"), Some("0.157.1"), true),
            Plan::Current
        );
        assert_eq!(
            codex_plan(Some("0.153.4"), Some("0.157.1"), false),
            Plan::Update
        );
        // Without a published version to compare, the installer decides.
        assert_eq!(codex_plan(Some("0.153.4"), None, false), Plan::Update);
        assert_eq!(codex_plan(None, Some("0.157.1"), false), Plan::Update);
        let Plan::Wait(message) = codex_plan(Some("0.153.4"), Some("0.157.1"), true) else {
            panic!("an installation in use waits");
        };
        assert!(
            message.starts_with("Codex 0.157.1 is available."),
            "{message}"
        );
        let Plan::Wait(message) = codex_plan(Some("0.153.4"), None, true) else {
            panic!("an installation in use waits");
        };
        assert!(
            message.starts_with("A newer Codex is available."),
            "{message}"
        );
    }

    #[test]
    fn only_the_standalone_codex_is_updated_beside_its_running_files() {
        let dir = tempfile::tempdir().unwrap();
        let release = dir
            .path()
            .join(".codex/packages/standalone/releases/0.157.1-x86_64-pc-windows-msvc/bin");
        std::fs::create_dir_all(&release).unwrap();
        std::fs::write(release.join("codex.exe"), "codex").unwrap();
        let native = |program: std::path::PathBuf, prefix: Vec<String>| Executable {
            provider: "codex".into(),
            program,
            prefix,
            wsl: None,
        };
        assert!(standalone(&native(release.join("codex.exe"), vec![])));
        assert!(!replaced_in_place(&native(
            release.join("codex.exe"),
            vec![]
        )));
        let npm = dir
            .path()
            .join("npm/node_modules/@openai/codex/bin/codex.js");
        std::fs::create_dir_all(npm.parent().unwrap()).unwrap();
        std::fs::write(&npm, "js").unwrap();
        let npm = native(
            dir.path().join("node.exe"),
            vec![npm.to_string_lossy().into_owned()],
        );
        assert!(!standalone(&npm));
        assert_eq!(replaced_in_place(&npm), cfg!(windows));
        assert!(!standalone(&native(dir.path().join("missing.exe"), vec![])));
    }

    #[test]
    fn an_update_is_read_from_the_versions_around_it() {
        let status = read_out(
            Some("2.1.278"),
            Some("2.1.283"),
            ok(true, "Current version: 2.1.278\nChecking for updates to latest version...\nSuccessfully updated from 2.1.278 to version 2.1.283\n"),
        );
        assert_eq!(status.phase, Phase::Updated);
        assert_eq!(status.version.as_deref(), Some("2.1.283"));
        assert_eq!(status.previous.as_deref(), Some("2.1.278"));
        assert_eq!(status.checked_at, Some(7));
        // A changed version counts even when the message wording changes.
        let status = read_out(Some("2.1.278"), Some("2.1.283"), ok(true, "Done."));
        assert_eq!(status.phase, Phase::Updated);
        let current = read_out(
            Some("2.1.283"),
            Some("2.1.283"),
            ok(true, "Current version: 2.1.283\n\u{1b}[32mClaude Code is up to date (2.1.283)\u{1b}[39m\n"),
        );
        assert_eq!(current.phase, Phase::Current);
        assert_eq!(current.version.as_deref(), Some("2.1.283"));
        assert_eq!((current.previous, current.message), (None, None));
        let codex = read_codex(
            Some("0.153.4"),
            Some("0.157.1"),
            ok(true, "\nUpdating Codex via `powershell -ExecutionPolicy Bypass -c '$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex'`...\n==> Updating Codex CLI from 0.153.4 to 0.157.1\n\n🎉 Update ran successfully! Please restart Codex.\n"),
        );
        assert_eq!(
            (codex.phase, codex.previous.as_deref(), codex.provider),
            (Phase::Updated, Some("0.153.4"), "codex")
        );
    }

    #[test]
    fn held_busy_managed_blocked_and_failed_updates_say_why() {
        let held = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(
                true,
                "The stable channel is at 2.1.270, which is older. Staying on 2.1.278.\n",
            ),
        );
        assert_eq!(held.phase, Phase::Current);
        assert!(held.message.unwrap().contains("Staying on 2.1.278"));
        let busy = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Another Claude process (PID 42) is currently running. Please try again in a moment.\n"),
        );
        assert_eq!(busy.phase, Phase::Busy);
        assert!(busy
            .message
            .unwrap()
            .starts_with("Another Claude Code update"));
        let managed = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Current version: 2.1.278\n\nClaude is managed by winget.\nUpdate available: 2.1.278 → 2.1.283\n\nTo update, run:\n  winget upgrade Anthropic.ClaudeCode\n"),
        );
        assert_eq!(managed.phase, Phase::Managed);
        assert_eq!(
            managed.message.as_deref(),
            Some(
                "Claude is managed by winget. Update it with winget upgrade Anthropic.ClaudeCode."
            )
        );
        let unknown = read_codex(
            Some("0.153.4"),
            Some("0.153.4"),
            ok(false, "Error: Could not detect the Codex installation method. Please update manually: https://developers.openai.com/codex/cli/\n"),
        );
        assert_eq!(unknown.phase, Phase::Managed);
        let blocked = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Updates are disabled by your administrator. Contact your IT team to get the latest version.\n"),
        );
        assert_eq!(blocked.phase, Phase::Blocked);
        let failed = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(false, "Current version: 2.1.278\nChecking for updates to latest version...\nError: Failed to install native update\nEPERM: operation not permitted\nTry running \"claude doctor\" for diagnostics\n"),
        );
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(
            failed.message.as_deref(),
            Some("Error: Failed to install native update EPERM: operation not permitted")
        );
        assert_eq!(failed.version.as_deref(), Some("2.1.278"));
        // Codex echoes the whole installer command; its failure reads as the installer's.
        let installer = read_codex(
            Some("0.153.4"),
            Some("0.153.4"),
            ok(false, "Updating Codex via `powershell -c 'irm https://chatgpt.com/codex/install.ps1 | iex'`...\n==> Updating Codex CLI from 0.153.4 to 0.157.1\nDownloaded Codex archive checksum did not match expected digest.\nAt line:1 char:1\n+ irm https://chatgpt.com/codex/install.ps1 | iex\nError: `powershell -c 'irm https://chatgpt.com/codex/install.ps1 | iex'` failed with status exit code: 1\n"),
        );
        assert_eq!(installer.phase, Phase::Failed);
        assert_eq!(
            installer.message.as_deref(),
            Some("Downloaded Codex archive checksum did not match expected digest. The installer failed with status exit code: 1.")
        );
        let silent = read_out(None, None, ok(false, ""));
        assert_eq!(
            silent.message.as_deref(),
            Some("Claude Code could not update.")
        );
        let silent = read_codex(None, None, ok(false, ""));
        assert_eq!(silent.message.as_deref(), Some("Codex could not update."));
        let timeout = read_out(Some("2.1.278"), None, Err("timed out".into()));
        assert_eq!(timeout.phase, Phase::Failed);
        assert_eq!(timeout.version.as_deref(), Some("2.1.278"));
        let long = read_out(None, None, ok(false, &"x".repeat(1000)));
        assert_eq!(long.message.unwrap().chars().count(), MESSAGE_LIMIT);
    }

    #[test]
    fn checks_repeat_every_six_hours_and_retry_failures_after_one() {
        let status = |phase, checked_at| {
            let mut status = Status::new("claude", "env".into(), phase);
            status.checked_at = checked_at;
            status
        };
        let hour = 60 * 60 * 1000;
        assert!(due(None, 0));
        assert!(due(Some(&status(Phase::Checking, None)), 0));
        assert!(!due(Some(&status(Phase::Current, Some(0))), 5 * hour));
        assert!(due(Some(&status(Phase::Current, Some(0))), 6 * hour));
        assert!(!due(Some(&status(Phase::Updated, Some(0))), hour));
        for phase in [Phase::Failed, Phase::Busy] {
            assert!(!due(Some(&status(phase, Some(0))), hour - 1));
            assert!(due(Some(&status(phase, Some(0))), hour));
        }
        // A waiting update looks again on every half-hourly pass.
        assert!(due(Some(&status(Phase::Waiting, Some(10))), 10));
    }

    #[test]
    fn an_install_reports_its_version_or_the_installers_reason() {
        // What the launcher printed after Claude Code's installer on Ubuntu (2026-10-01).
        let installed = ok(
            true,
            "Setting up Claude Code...\n\u{1b}[32m✔\u{1b}[0m Claude Code successfully installed!\n  Version: 2.1.287\n\n✅ Installation complete!\n\nagent-studio-installed 2.1.287 (Claude Code)\n",
        )
        .unwrap();
        assert_eq!(
            install_outcome("Claude Code", &installed).as_deref(),
            Ok("2.1.287")
        );
        let codex = ok(
            true,
            "==> Installing Codex CLI\nagent-studio-installed codex-cli 0.159.3\n",
        )
        .unwrap();
        assert_eq!(install_outcome("Codex", &codex).as_deref(), Ok("0.159.3"));
        // An installer that ended well but left nothing that runs.
        let silent = ok(true, "✅ Installation complete!\nagent-studio-installed \n").unwrap();
        assert_eq!(
            install_outcome("Claude Code", &silent),
            Err("Claude Code was installed, but it does not run in this distribution.".into())
        );
        let curl = ok(
            false,
            "curl is not installed in this distribution. Install it with its package manager, then try again.\n",
        )
        .unwrap();
        assert!(install_outcome("Codex", &curl)
            .unwrap_err()
            .starts_with("curl is not installed"));
        let checksum = ok(false, "Downloading...\nChecksum verification failed\n").unwrap();
        assert_eq!(
            install_outcome("Claude Code", &checksum),
            Err("Checksum verification failed".into())
        );
        assert_eq!(
            install_outcome("Codex", &ok(false, "").unwrap()),
            Err("Codex could not be installed.".into())
        );
    }

    #[test]
    fn claude_codes_own_switch_turns_automatic_checks_off() {
        assert_eq!(environment_notice(None), None);
        for value in ["", "0", "false", "OFF", " no "] {
            assert_eq!(environment_notice(Some(value.into())), None, "{value}");
        }
        for value in ["1", "true", "yes"] {
            assert!(environment_notice(Some(value.into())).is_some(), "{value}");
        }
    }

    #[test]
    fn settings_default_to_automatic_and_serialize_plainly() {
        let defaults = Automatic {
            claude: true,
            codex: true,
        };
        assert_eq!(serde_json::from_str::<Automatic>("{}").unwrap(), defaults);
        // A development build's single switch reads as both on.
        assert_eq!(
            serde_json::from_str::<Automatic>("{\"automatic\":false}").unwrap(),
            defaults
        );
        let mut settings = defaults;
        settings.set("codex", false);
        settings.set("gemini", false);
        assert!(settings.get("claude") && !settings.get("codex") && !settings.get("gemini"));
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            serde_json::json!({"claude": true, "codex": false})
        );
        let status = read_codex(Some("1.0.0"), Some("1.1.0"), ok(true, ""));
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"provider":"codex","environmentId":"env","phase":"updated","version":"1.1.0","previous":"1.0.0","checkedAt":7})
        );
    }

    /// Stand-in CLIs whose version file `update` rewrites, run through the same process path.
    #[tokio::test]
    async fn a_run_reads_the_update_and_the_new_version_from_the_cli() {
        for (provider, version_line, updated) in [
            (
                "claude",
                "$v (Claude Code)",
                "Successfully updated from 1.0.0 to version 1.1.0",
            ),
            (
                "codex",
                "codex-cli $v",
                "Update ran successfully! Please restart Codex.",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("version.txt"), "1.0.0").unwrap();
            #[cfg(windows)]
            let exe = {
                let script = dir.path().join("cli.ps1");
                std::fs::write(
                    &script,
                    format!("$command = $args[0]\n$file = Join-Path $PSScriptRoot 'version.txt'\n$v = Get-Content $file\nif ($command -eq '--version') {{ Write-Output \"{version_line}\"; exit 0 }}\nif ($command -eq 'update') {{ Set-Content -Path $file -Value '1.1.0' -NoNewline; Write-Output '{updated}'; exit 0 }}\nexit 2\n"),
                )
                .unwrap();
                Executable {
                    provider: provider.into(),
                    program: "powershell.exe".into(),
                    prefix: vec![
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-File".into(),
                        script.to_string_lossy().into_owned(),
                    ],
                    wsl: None,
                }
            };
            #[cfg(not(windows))]
            let exe = {
                let script = dir.path().join("cli.sh");
                std::fs::write(
                    &script,
                    format!("file=\"$(dirname \"$0\")/version.txt\"\nv=\"$(cat \"$file\")\"\ncase \"$1\" in\n--version) echo \"{version_line}\";;\nupdate) printf 1.1.0 > \"$file\"; echo '{updated}';;\n*) exit 2;;\nesac\n"),
                )
                .unwrap();
                Executable {
                    provider: provider.into(),
                    program: "sh".into(),
                    prefix: vec![script.to_string_lossy().into_owned()],
                    wsl: None,
                }
            };
            let before = version(&exe).await;
            assert_eq!(before.as_deref(), Some("1.0.0"), "{provider}");
            let result = run(&exe, &["update"], Duration::from_secs(60)).await;
            let after = version(&exe).await;
            let status = outcome(provider, "env".into(), before, after, result, 1);
            assert_eq!(status.phase, Phase::Updated, "{provider}");
            assert_eq!(status.version.as_deref(), Some("1.1.0"));
            assert_eq!(status.previous.as_deref(), Some("1.0.0"));
            // An unknown command fails and is reported as such.
            let failed = run(&exe, &["unknown"], Duration::from_secs(60))
                .await
                .unwrap();
            assert!(!failed.success);
        }
    }
}
