//! The MCP tools a screen's page and a chat's `call_mcp_tool` call (docs/SCREENS.md). A call goes
//! through the CLI of an account in the place it names, started under that account's profile in
//! the screen's folder as that place reaches it, with the MCP servers a chat of that account
//! loads there: Claude Code answers its `mcp_call` control request and Codex its app-server's
//! `mcpServer/tool/call`, neither with a model turn. The CLI keeps the servers, their sign-ins and
//! their credentials; Agent Studio reads none of them. When an account there has no such server
//! connected, or must sign in to it, the next account there is tried, and the one that answered
//! is remembered for that place and server. A screen keeps each CLI while its page calls tools and
//! for a while after, and a later call starts it again.
use super::places::Candidate;
use super::{Account, Site};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as Shared, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// How long a screen keeps its CLI after its last call ended. A page that calls again within
/// it finds its servers connected; a quiet one frees the CLI and the servers it started.
const IDLE: Duration = Duration::from_secs(5 * 60);

const ENDED: &str =
    "The CLI answering this screen's MCP calls ended before it answered. Try again.";
/// What a screen's CLI hears when it asks for something only a person in a chat could give.
const REFUSED: &str = "A screen's MCP calls answer no requests.";
const GONE: &str = "This screen's account is no longer connected where it runs. Ask a chat there to save the screen again.";

fn lock<T>(mutex: &Shared<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Claude,
    Codex,
}

pub type Input = Pin<Box<dyn AsyncWrite + Send>>;
type Answer = oneshot::Sender<Result<Value, String>>;
type Waiting = Arc<Shared<Option<HashMap<String, Answer>>>>;
/// Ends a session's CLI once handed the CLI's input, whose end the CLI exits on.
pub type Ender = Box<dyn FnOnce(Option<Input>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// A CLI's input and the requests waiting for its answers.
struct Wire {
    kind: Kind,
    input: Arc<Mutex<Option<Input>>>,
    /// None once the CLI's output ended: nothing it was asked will be answered.
    waiting: Waiting,
    next: AtomicU64,
}

async fn send(input: &Mutex<Option<Input>>, value: &Value) -> Result<(), String> {
    let mut input = input.lock().await;
    let input = input.as_mut().ok_or(ENDED)?;
    input
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|_| ENDED.to_string())?;
    input.flush().await.map_err(|_| ENDED.to_string())
}

fn text(value: &Value, otherwise: &str) -> String {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .unwrap_or(otherwise)
        .to_string()
}

impl Wire {
    fn new(
        kind: Kind,
        input: Input,
        output: impl AsyncRead + Send + Unpin + 'static,
        lender: Option<crate::profiles::Profile>,
    ) -> Self {
        let input = Arc::new(Mutex::new(Some(input)));
        let waiting: Waiting = Arc::new(Shared::new(Some(HashMap::new())));
        tokio::spawn(read(kind, output, input.clone(), waiting.clone(), lender));
        Self {
            kind,
            input,
            waiting,
            next: AtomicU64::new(1),
        }
    }
    async fn notify(&self, method: &str) -> Result<(), String> {
        send(&self.input, &json!({ "method": method })).await
    }
    /// Sends one request and waits, as long as the CLI takes, for its answer.
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let number = self.next.fetch_add(1, Ordering::Relaxed);
        let (key, line) = match self.kind {
            Kind::Claude => {
                let key = format!("screen-{number}");
                let mut request = params;
                request["subtype"] = json!(method);
                let line =
                    json!({"type": "control_request", "request_id": &key, "request": request});
                (key, line)
            }
            Kind::Codex => (
                number.to_string(),
                json!({"id": number, "method": method, "params": params}),
            ),
        };
        let (answer, answered) = oneshot::channel();
        lock(&self.waiting)
            .as_mut()
            .ok_or(ENDED)?
            .insert(key.clone(), answer);
        if let Err(error) = send(&self.input, &line).await {
            if let Some(waiting) = lock(&self.waiting).as_mut() {
                waiting.remove(&key);
            }
            return Err(error);
        }
        answered.await.unwrap_or_else(|_| Err(ENDED.into()))
    }
}

/// Reads the CLI's output: each answer goes to the request waiting for it, and what the CLI
/// asks of its client is answered here. Once the output ends, every request still waiting
/// fails, and later ones fail at once.
async fn read(
    kind: Kind,
    output: impl AsyncRead + Unpin,
    input: Arc<Mutex<Option<Input>>>,
    waiting: Waiting,
    lender: Option<crate::profiles::Profile>,
) {
    let answered = |key: &str, result: Result<Value, String>| {
        if let Some(answer) = lock(&waiting).as_mut().and_then(|known| known.remove(key)) {
            let _ = answer.send(result);
        }
    };
    let mut lines = BufReader::new(output).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        match kind {
            Kind::Claude if value["type"] == "control_response" => {
                let mut response = value["response"].take();
                if !response.is_object() {
                    continue;
                }
                let Some(key) = response["request_id"].as_str().map(String::from) else {
                    continue;
                };
                let result = if response["subtype"] == "success" {
                    Ok(response["response"].take())
                } else {
                    Err(text(&response["error"], "Claude Code refused this call."))
                };
                answered(&key, result);
            }
            // Nobody sits at a screen's CLI, so whatever it asks, such as a form a server
            // wants filled in, is refused.
            Kind::Claude if value["type"] == "control_request" => {
                let refusal = json!({"type": "control_response", "response": {
                    "subtype": "error", "request_id": value["request_id"], "error": REFUSED,
                }});
                let _ = send(&input, &refusal).await;
            }
            Kind::Codex if value.get("method").is_none() => {
                let key = match &value["id"] {
                    Value::Number(number) => number.to_string(),
                    Value::String(id) => id.clone(),
                    _ => continue,
                };
                let result = match value.get("error") {
                    Some(error) => Err(text(&error["message"], "Codex refused this call.")),
                    None => Ok(value["result"].take()),
                };
                answered(&key, result);
            }
            Kind::Codex if value.get("id").is_some() => {
                let input = input.clone();
                let lender = lender.clone();
                // A borrowed Windows login is renewed there, which takes a query of its own.
                tokio::spawn(async move {
                    let reply = match (&lender, value["method"].as_str()) {
                        (Some(lender), Some("account/chatgptAuthTokens/refresh")) => {
                            crate::lending::codex_refresh(lender, &value).await
                        }
                        _ => {
                            json!({"id": value["id"], "error": {"code": -32601, "message": REFUSED}})
                        }
                    };
                    let _ = send(&input, &reply).await;
                });
            }
            _ => {}
        }
    }
    let unanswered = lock(&waiting).take();
    for (_, answer) in unanswered.into_iter().flatten() {
        let _ = answer.send(Err(ENDED.into()));
    }
}

/// The name Claude Code gives a server in its tools' names (`mcp__<name>__<tool>`), which its
/// `mcp_call` finds the server by: every other character becomes `_`, once per UTF-16 unit as
/// in JavaScript, and a `claude.ai` connector's runs of `_` collapse, without one at either end.
fn claude_name(server: &str) -> String {
    let mut name = String::new();
    for c in server.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            name.push(c);
        } else {
            name.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    if !server.starts_with("claude.ai ") {
        return name;
    }
    let mut collapsed = String::new();
    for c in name.chars() {
        if !(c == '_' && collapsed.ends_with('_')) {
            collapsed.push(c);
        }
    }
    collapsed.trim_matches('_').to_string()
}

/// A server's name with every character but letters and digits read as `_`, as the identifiers
/// a Codex agent sees name servers whose configuration spells them otherwise.
fn loose(server: &str) -> String {
    server
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// What a page receives: the tool's content blocks as its server sent them, and its
/// structured content when it has any.
fn outcome(mut result: Value) -> Value {
    if !result.is_object() {
        return json!({ "content": [] });
    }
    let content = match result["content"].take() {
        Value::Array(blocks) => Value::Array(blocks),
        // Claude Code hands over a tool's lone text as a string.
        Value::String(text) => json!([{ "type": "text", "text": text }]),
        Value::Null => json!([]),
        other => json!([{ "type": "text", "text": other.to_string() }]),
    };
    let mut value = json!({ "content": content });
    let structured = result["structuredContent"].take();
    if !structured.is_null() {
        value["structuredContent"] = structured;
    }
    value
}

/// The text a tool reported its error with.
fn reported(tool: &str, result: &Value) -> String {
    let said: Vec<&str> = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block["text"].as_str())
        .filter(|text| !text.trim().is_empty())
        .collect();
    if said.is_empty() {
        format!("The MCP tool {tool} reported an error.")
    } else {
        said.join("\n")
    }
}

/// Why a call failed, whether the CLI's servers need reading again (a server that is not
/// connected, signed out or gone from this CLI may be ready for a new one), and whether another
/// account may have the server where this one has not.
#[derive(Debug, PartialEq)]
pub(crate) struct Failure {
    pub message: String,
    pub restart: bool,
    pub elsewhere: bool,
}
impl Failure {
    fn tool(message: String) -> Self {
        let restart = message == ENDED;
        Self {
            message,
            restart,
            elsewhere: false,
        }
    }
    fn missing(message: String, restart: bool) -> Self {
        Self {
            message,
            restart,
            elsewhere: true,
        }
    }
}

fn claude_failure(server: &str, error: String) -> Failure {
    if error.contains("requires authentication") {
        Failure::missing(
            format!("Sign in to the MCP server {server} for this account first, from MCPs in Model context."),
            true,
        )
    } else if error.starts_with("MCP server not connected")
        || error.starts_with("MCP session expired")
    {
        Failure::missing(
            format!("This account has no connected MCP server named {server}."),
            true,
        )
    } else {
        Failure::tool(error)
    }
}
fn codex_failure(server: &str, error: String) -> Failure {
    if error.starts_with("unknown MCP server") {
        Failure::missing(
            format!("This account has no MCP server named {server}."),
            false,
        )
    } else if error.starts_with("failed to get client") {
        Failure::missing(
            format!("The MCP server {server} did not start for this account."),
            true,
        )
    } else {
        Failure::tool(error)
    }
}

/// A server as a listing reports it: its state, and its tools with what the CLI says of them
/// (Codex reports each tool's description and input schema, Claude Code its name).
fn server_view(name: &str, status: &str, tools: Vec<Value>, error: Option<&str>) -> Value {
    let mut view = json!({ "name": name, "status": status, "tools": tools });
    if let Some(error) = error.filter(|error| !error.trim().is_empty()) {
        view["error"] = json!(error);
    }
    view
}

/// One screen's CLI: what it was started for, how calls reach it and how it ends.
pub struct Session {
    key: String,
    wire: Wire,
    /// Codex: the thread whose MCP connections answer, and the names its configuration gives
    /// servers a page names otherwise.
    thread: String,
    names: Shared<HashMap<String, String>>,
    busy: AtomicUsize,
    last: Shared<Instant>,
    /// No new call reaches it; it ends once the calls it answers end.
    retired: AtomicBool,
    ended: AtomicBool,
    ender: Shared<Option<Ender>>,
}

impl Session {
    fn open(
        kind: Kind,
        input: Input,
        output: impl AsyncRead + Send + Unpin + 'static,
        lender: Option<crate::profiles::Profile>,
        ender: Ender,
    ) -> Self {
        Self {
            key: String::new(),
            wire: Wire::new(kind, input, output, lender),
            thread: String::new(),
            names: Shared::new(HashMap::new()),
            busy: AtomicUsize::new(0),
            last: Shared::new(Instant::now()),
            retired: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            ender: Shared::new(Some(ender)),
        }
    }
    /// Claude Code reading stream-json control requests, once it answered `initialize`.
    pub async fn claude(
        input: Input,
        output: impl AsyncRead + Send + Unpin + 'static,
        ender: Ender,
    ) -> Result<Self, String> {
        let session = Self::open(Kind::Claude, input, output, None, ender);
        if session.wire.request("initialize", json!({})).await.is_err() {
            session.finish();
            return Err(
                "Claude Code did not start for this screen's MCP calls. Check its sign-in and version."
                    .into(),
            );
        }
        Ok(session)
    }
    /// Codex's app-server with an ephemeral thread, whose MCP connections answer the calls.
    /// A separate WSL profile signs in with its account's Windows login first.
    pub async fn codex(
        input: Input,
        output: impl AsyncRead + Send + Unpin + 'static,
        lender: Option<crate::profiles::Profile>,
        ender: Ender,
    ) -> Result<Self, String> {
        let mut session = Self::open(Kind::Codex, input, output, lender.clone(), ender);
        let started = async {
            session
                .wire
                .request(
                    "initialize",
                    json!({"clientInfo": {"name": "agent_studio", "version": "0.1.0"},
                           "capabilities": {"experimentalApi": true}}),
                )
                .await
                .map_err(|_| {
                    "Codex did not start for this screen's MCP calls. Check its sign-in and version."
                        .to_string()
                })?;
            session.wire.notify("initialized").await?;
            if let Some(lender) = &lender {
                let login = crate::lending::codex_login(lender, false).await?;
                session
                    .wire
                    .request("account/login/start", login)
                    .await
                    .map_err(|_| {
                        "Codex in WSL did not accept this account's Windows login.".to_string()
                    })?;
            }
            // `never` declines a form a server asks for, since nobody sits at this thread.
            let thread = session
                .wire
                .request(
                    "thread/start",
                    json!({"approvalPolicy": "never", "sandbox": "danger-full-access", "ephemeral": true}),
                )
                .await
                .map_err(|_| "Codex could not open its MCP servers for this screen.".to_string())?;
            thread["thread"]["id"]
                .as_str()
                .map(String::from)
                .ok_or_else(|| "Codex did not name the thread for this screen's calls.".to_string())
        }
        .await;
        match started {
            Ok(thread) => {
                session.thread = thread;
                Ok(session)
            }
            Err(error) => {
                session.finish();
                Err(error)
            }
        }
    }
    fn alive(&self) -> bool {
        !self.ended.load(Ordering::SeqCst)
            && !self.retired.load(Ordering::SeqCst)
            && lock(&self.wire.waiting).is_some()
    }
    /// Ends the CLI, letting it finish what it still has under way (`Executable::end`).
    fn finish(&self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(ender) = lock(&self.ender).take() else {
            return;
        };
        let input = self.wire.input.clone();
        let ending = crate::providers::Ending::start();
        tokio::spawn(async move {
            let input = input.lock().await.take();
            ender(input).await;
            drop(ending);
        });
    }
    /// Takes no new call, and ends once the calls it answers now end.
    fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
        if self.busy.load(Ordering::SeqCst) == 0 {
            self.finish();
        }
    }
    fn done(&self) {
        *lock(&self.last) = Instant::now();
        if self.busy.fetch_sub(1, Ordering::SeqCst) == 1 && self.retired.load(Ordering::SeqCst) {
            self.finish();
        }
    }
    /// Calls one tool, failing with why, whether the CLI should start again and whether another
    /// account may have the server.
    async fn call(
        &self,
        server: &str,
        tool: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, Failure> {
        match self.wire.kind {
            Kind::Claude => {
                let name = format!("mcp__{}__{tool}", claude_name(server));
                // The result is the page's, not a model's: Claude Code hands it over whole.
                let params =
                    json!({"tool": name, "arguments": arguments, "result_not_for_model": true});
                match self.wire.request("mcp_call", params).await {
                    Ok(result) => Ok(outcome(result)),
                    Err(error) => Err(claude_failure(server, error)),
                }
            }
            Kind::Codex => {
                let known = lock(&self.names).get(server).cloned();
                let mut answer = self
                    .codex_call(known.as_deref().unwrap_or(server), tool, &arguments)
                    .await;
                if known.is_none()
                    && answer
                        .as_ref()
                        .is_err_and(|error| error.starts_with("unknown MCP server"))
                {
                    if let Some(configured) = self.configured(server).await {
                        lock(&self.names).insert(server.into(), configured.clone());
                        answer = self.codex_call(&configured, tool, &arguments).await;
                    }
                }
                match answer {
                    Ok(result) if result["isError"] == true => {
                        Err(Failure::tool(reported(tool, &result)))
                    }
                    Ok(result) => Ok(outcome(result)),
                    Err(error) => Err(codex_failure(server, error)),
                }
            }
        }
    }
    /// The servers this CLI has, each with its state and tools. Claude Code connects servers
    /// after it starts, so the listing waits while one is still connecting.
    async fn servers(&self) -> Result<Vec<Value>, String> {
        match self.wire.kind {
            Kind::Claude => {
                let mut status = Value::Null;
                for _ in 0..60 {
                    status = self.wire.request("mcp_status", json!({})).await?;
                    let pending = status["mcpServers"]
                        .as_array()
                        .is_some_and(|list| list.iter().any(|s| s["status"] == "pending"));
                    if !pending {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                let list = status["mcpServers"]
                    .as_array()
                    .ok_or("Claude Code did not list its MCP servers.")?;
                Ok(list
                    .iter()
                    .filter_map(|server| {
                        let name = server["name"].as_str()?;
                        let tools = server["tools"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|tool| Some(json!({ "name": tool["name"].as_str()? })))
                            .collect();
                        Some(server_view(
                            name,
                            server["status"].as_str().unwrap_or("unknown"),
                            tools,
                            server["error"].as_str(),
                        ))
                    })
                    .collect())
            }
            Kind::Codex => {
                let mut servers = vec![];
                let mut cursor = Value::Null;
                let mut seen = HashSet::new();
                loop {
                    let page = self
                        .wire
                        .request(
                            "mcpServerStatus/list",
                            json!({"threadId": self.thread, "detail": "toolsAndAuthOnly", "cursor": cursor}),
                        )
                        .await?;
                    for entry in page["data"].as_array().into_iter().flatten() {
                        let Some(name) = entry["name"].as_str() else {
                            continue;
                        };
                        let status = if entry["authStatus"] == "notLoggedIn" {
                            "needs-auth"
                        } else {
                            entry["runtimeStatus"].as_str().unwrap_or("unknown")
                        };
                        let tools = entry["tools"]
                            .as_object()
                            .into_iter()
                            .flatten()
                            .map(|(name, tool)| {
                                let mut view =
                                    json!({ "name": tool["name"].as_str().unwrap_or(name) });
                                if let Some(description) = tool["description"].as_str() {
                                    view["description"] = json!(description);
                                }
                                if tool["inputSchema"].is_object() {
                                    view["inputSchema"] = tool["inputSchema"].clone();
                                }
                                view
                            })
                            .collect();
                        servers.push(server_view(
                            name,
                            status,
                            tools,
                            entry["toolsError"].as_str(),
                        ));
                    }
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() || !seen.insert(cursor.to_string()) {
                        return Ok(servers);
                    }
                }
            }
        }
    }
    async fn codex_call(
        &self,
        server: &str,
        tool: &str,
        arguments: &Map<String, Value>,
    ) -> Result<Value, String> {
        self.wire
            .request(
                "mcpServer/tool/call",
                json!({"threadId": self.thread, "server": server, "tool": tool, "arguments": arguments}),
            )
            .await
    }
    /// The configured name of the server a page names as the agent saw it (`mcp__<name>__…`).
    async fn configured(&self, server: &str) -> Option<String> {
        let wanted = loose(server);
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        loop {
            let page = self
                .wire
                .request(
                    "mcpServerStatus/list",
                    json!({"threadId": self.thread, "detail": "toolsAndAuthOnly", "cursor": cursor}),
                )
                .await
                .ok()?;
            for entry in page["data"].as_array()? {
                if let Some(name) = entry["name"].as_str() {
                    if name != server && loose(name) == wanted {
                        return Some(name.into());
                    }
                }
            }
            cursor = page["nextCursor"].clone();
            if cursor.is_null() || !seen.insert(cursor.to_string()) {
                return None;
            }
        }
    }
}

pub type Launched = Pin<Box<dyn Future<Output = Result<Session, String>> + Send>>;
pub type Asked = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// Starts the CLIs that answer a screen's MCP calls, and asks a model what a page asks.
pub trait Launch: Send + Sync {
    fn launch(&self, site: &Site, account: &Account) -> Launched;
    /// The answer of the account's small model, or the model a page names, to a page's
    /// question: a one-shot request without tools or conversation.
    fn ask(
        &self,
        _account: Option<&Account>,
        _question: super::Question,
        _cancel: CancellationToken,
    ) -> Asked {
        Box::pin(async { Err("This computer cannot ask a model for screens.".into()) })
    }
}

/// What a session was started for: the account and its profile, and where it runs.
fn key(site: &Site, account: &Account) -> String {
    json!([
        account.provider,
        account.connection_id,
        site.environment_id,
        site.distribution,
        site.folder
    ])
    .to_string()
}

/// A screen (or the chats), a place and a server, which the account that answered there last is
/// remembered for. Each screen keeps its own, so one never calls as another screen's account.
fn route(owner: &str, site: &Site, server: &str) -> String {
    json!([
        owner,
        site.environment_id,
        site.distribution,
        site.folder,
        server
    ])
    .to_string()
}

type Slot = Arc<Mutex<Option<Arc<Session>>>>;

const QUITTING: &str = "Agent Studio is quitting.";

/// Why no account in a place could call a server's tools, account by account.
fn unreachable(server: &str, tried: Vec<(String, String)>) -> String {
    match tried.len() {
        0 => {
            format!("No Claude or Codex account is connected there to call the tools of {server}.")
        }
        1 => tried
            .into_iter()
            .next()
            .map(|(_, message)| message)
            .unwrap_or_default(),
        _ => format!(
            "No account there could call the tools of {server}. {}",
            tried
                .into_iter()
                .map(|(name, message)| format!("{name}: {message}"))
                .collect::<Vec<_>>()
                .join(" ")
        ),
    }
}

/// The CLIs answering MCP calls for this computer's screens and its chats, one for each screen
/// (or the chats together), account and place, and the account that answered each screen last in
/// each place for each server.
#[derive(Default)]
pub struct Calls {
    sessions: Mutex<HashMap<String, Slot>>,
    routes: Shared<HashMap<String, Candidate>>,
    pub(crate) closing: CancellationToken,
}

impl Calls {
    /// `owner`'s session of an account in a place, started when it has none or its CLI ended.
    async fn session(
        &self,
        owner: &str,
        site: &Site,
        account: &Account,
        launch: &dyn Launch,
    ) -> Result<(Slot, Arc<Session>), String> {
        if self.closing.is_cancelled() {
            return Err(QUITTING.into());
        }
        let key = key(site, account);
        let slot = self
            .sessions
            .lock()
            .await
            .entry(format!("{owner}\n{key}"))
            .or_default()
            .clone();
        let mut held = slot.lock().await;
        let kept = held.as_ref().filter(|session| session.alive()).cloned();
        let session = match kept {
            Some(session) => session,
            None => {
                if let Some(earlier) = held.take() {
                    earlier.retire();
                }
                let started = tokio::select! {
                    started = launch.launch(site, account) => started?,
                    _ = self.closing.cancelled() => return Err(QUITTING.into()),
                };
                let mut started = started;
                started.key = key;
                let started = Arc::new(started);
                *held = Some(started.clone());
                watch(slot.clone(), started.clone());
                started
            }
        };
        session.busy.fetch_add(1, Ordering::SeqCst);
        drop(held);
        Ok((slot, session))
    }
    /// Lets a session go after a request; one whose servers need reading again ends.
    async fn done(&self, slot: &Slot, session: &Arc<Session>, restart: bool) {
        if restart {
            let mut held = slot.lock().await;
            if held
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                held.take();
            }
            session.retired.store(true, Ordering::SeqCst);
        }
        session.done();
    }
    #[allow(clippy::too_many_arguments)]
    async fn attempt(
        &self,
        owner: &str,
        site: &Site,
        account: &Account,
        launch: &dyn Launch,
        server: &str,
        tool: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, Failure> {
        let (slot, session) =
            self.session(owner, site, account, launch)
                .await
                .map_err(|message| Failure {
                    elsewhere: message != QUITTING,
                    restart: false,
                    message,
                })?;
        let result = session.call(server, tool, arguments).await;
        let restart = matches!(&result, Err(failure) if failure.restart);
        self.done(&slot, &session, restart).await;
        result
    }
    /// Calls a tool in a place: as the account that answered there last for that server, unless
    /// one is named, then as each candidate in turn while those before have no such server
    /// connected or must sign in to it. The call takes as long as the tool takes, and answers
    /// with the tool's result and the name of the account that answered.
    #[allow(clippy::too_many_arguments)]
    pub async fn call(
        &self,
        owner: &str,
        site: &Site,
        named: bool,
        candidates: impl Future<Output = Result<Vec<Candidate>, String>>,
        launch: &dyn Launch,
        server: &str,
        tool: &str,
        arguments: Map<String, Value>,
    ) -> Result<(Value, String), String> {
        let key = route(owner, site, server);
        let remembered = if named {
            None
        } else {
            lock(&self.routes).get(&key).cloned()
        };
        let mut tried: Vec<(String, String)> = vec![];
        if let Some(known) = &remembered {
            match self
                .attempt(
                    owner,
                    site,
                    &known.account,
                    launch,
                    server,
                    tool,
                    arguments.clone(),
                )
                .await
            {
                Ok(value) => return Ok((value, known.name.clone())),
                Err(failure) if !failure.elsewhere => return Err(failure.message),
                Err(failure) => {
                    lock(&self.routes).remove(&key);
                    tried.push((known.name.clone(), failure.message));
                }
            }
        }
        for candidate in candidates.await? {
            if remembered
                .as_ref()
                .is_some_and(|known| known.account == candidate.account)
            {
                continue;
            }
            match self
                .attempt(
                    owner,
                    site,
                    &candidate.account,
                    launch,
                    server,
                    tool,
                    arguments.clone(),
                )
                .await
            {
                Ok(value) => {
                    let name = candidate.name.clone();
                    lock(&self.routes).insert(key, candidate);
                    return Ok((value, name));
                }
                Err(failure) if !failure.elsewhere => return Err(failure.message),
                Err(failure) => tried.push((candidate.name, failure.message)),
            }
        }
        Err(unreachable(server, tried))
    }
    /// The MCP servers of the first candidate whose CLI starts in a place, each with its state
    /// and tools, and that candidate. The servers it has connected are remembered as its.
    pub async fn servers(
        &self,
        owner: &str,
        site: &Site,
        candidates: Vec<Candidate>,
        launch: &dyn Launch,
    ) -> Result<(Candidate, Vec<Value>), String> {
        let mut tried: Vec<(String, String)> = vec![];
        for candidate in candidates {
            let (slot, session) = match self.session(owner, site, &candidate.account, launch).await
            {
                Ok(started) => started,
                Err(error) if error == QUITTING => return Err(error),
                Err(error) => {
                    tried.push((candidate.name, error));
                    continue;
                }
            };
            let listed = session.servers().await;
            self.done(&slot, &session, listed.is_err()).await;
            match listed {
                Ok(servers) => {
                    let mut routes = lock(&self.routes);
                    for server in &servers {
                        if let (Some(name), Some("connected")) =
                            (server["name"].as_str(), server["status"].as_str())
                        {
                            routes
                                .entry(route(owner, site, name))
                                .or_insert_with(|| candidate.clone());
                        }
                    }
                    drop(routes);
                    return Ok((candidate, servers));
                }
                Err(error) => tried.push((candidate.name, error)),
            }
        }
        Err(match tried.len() {
            0 => "No Claude or Codex account is connected there.".to_string(),
            _ => tried
                .into_iter()
                .map(|(name, message)| format!("{name}: {message}"))
                .collect::<Vec<_>>()
                .join(" "),
        })
    }
    /// Ends the CLIs of a screen, or of the chats, once their calls end, as when a screen is
    /// deleted or saved again.
    pub async fn release(&self, owner: &str) {
        // Its next call finds its accounts again.
        let routed = format!("[{},", json!(owner));
        lock(&self.routes).retain(|key, _| !key.starts_with(&routed));
        let prefix = format!("{owner}\n");
        let slots: Vec<Slot> = {
            let mut sessions = self.sessions.lock().await;
            let keys: Vec<String> = sessions
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| sessions.remove(&key))
                .collect()
        };
        for slot in slots {
            if let Some(session) = slot.lock().await.take() {
                session.retire();
            }
        }
    }
    /// Ends every CLI as the app quits, and takes no call after.
    pub async fn shutdown(&self) {
        self.closing.cancel();
        let slots: Vec<Slot> = self
            .sessions
            .lock()
            .await
            .drain()
            .map(|(_, slot)| slot)
            .collect();
        for slot in slots {
            if let Some(session) = slot.lock().await.take() {
                session.retired.store(true, Ordering::SeqCst);
                session.finish();
            }
        }
    }
}

// Ends a session once it answered nothing for `IDLE`, unless another took its place.
fn watch(slot: Slot, session: Arc<Session>) {
    tokio::spawn(async move {
        loop {
            let wake = *lock(&session.last) + IDLE;
            tokio::time::sleep_until(wake).await;
            if session.ended.load(Ordering::SeqCst) {
                return;
            }
            let mut held = slot.lock().await;
            if !held
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                return;
            }
            if session.busy.load(Ordering::SeqCst) > 0 {
                drop(held);
                tokio::time::sleep(IDLE).await;
                continue;
            }
            if lock(&session.last).elapsed() >= IDLE {
                held.take();
                drop(held);
                session.retire();
                return;
            }
        }
    });
}

/// This app's own launch: the account's CLI under its profile, in the screen's folder.
pub struct Host(pub tauri::AppHandle);
impl Launch for Host {
    fn launch(&self, site: &Site, account: &Account) -> Launched {
        Box::pin(start(self.0.clone(), site.clone(), account.clone()))
    }
    fn ask(
        &self,
        account: Option<&Account>,
        question: super::Question,
        cancel: CancellationToken,
    ) -> Asked {
        Box::pin(ask(self.0.clone(), account.cloned(), question, cancel))
    }
}

/// What the model asked for a page hears before the page's question, unless the page gives
/// its own instructions.
const ASK_INSTRUCTIONS: &str =
    "You answer a request a page in Agent Studio sends. Reply with the answer alone.";

/// A model's answer for a page, from the account's CLI in the restricted background runtime
/// titles use: no tools, no conversation, the provider's small model unless the page names one.
async fn ask(
    app: tauri::AppHandle,
    account: Option<Account>,
    question: super::Question,
    cancel: CancellationToken,
) -> Result<String, String> {
    let (provider, connection) = match &account {
        Some(account) => (account.provider.clone(), account.connection_id.clone()),
        None => ("claude".to_string(), None),
    };
    let profile = crate::profiles::resolve(&app, &provider, connection.as_deref())?;
    // A borrowed Codex login answers on Windows, where that login lives.
    let profile = match profile.lender {
        Some(lender) => *lender,
        None => profile,
    };
    let instructions = question.system.as_deref().unwrap_or(ASK_INSTRUCTIONS);
    let mut request = crate::titles::background_request(&provider, instructions, question.prompt)?;
    if let Some(model) = question.model {
        request.agent.model = model;
    }
    request.validate()?;
    crate::profiles::scope(
        profile,
        crate::runner::background_text(app, request, cancel),
    )
    .await
}

async fn start(app: tauri::AppHandle, site: Site, account: Account) -> Result<Session, String> {
    let (kind, name) = match account.provider.as_str() {
        "claude" => (Kind::Claude, "Claude Code"),
        "codex" => (Kind::Codex, "Codex"),
        _ => return Err("Only Claude and Codex accounts call MCP tools for screens.".into()),
    };
    let profile =
        crate::profiles::resolve(&app, &account.provider, account.connection_id.as_deref())
            .map_err(|_| GONE.to_string())?;
    // Its calls run where its actions run.
    if profile.distribution != site.distribution {
        return Err(GONE.into());
    }
    // A folder of a WSL distribution reached from Windows can take its distribution's start.
    let folder = site.folder.clone();
    let present = site.distribution.is_some()
        || tauri::async_runtime::spawn_blocking(move || Path::new(&folder).is_dir())
            .await
            .unwrap_or(false);
    if !present {
        return Err(format!(
            "This screen's folder is unavailable: {}",
            site.folder
        ));
    }
    crate::profiles::scope(profile, async move {
        let exe = crate::providers::resolve(&account.provider).await?;
        // The servers a chat of this account loads here, shared definitions included.
        let shared = crate::shared_context::load(&account.provider, &site.folder).await?;
        let mut plugins = crate::plugins::Runtime::default();
        shared.extend_runtime(&mut plugins);
        let lender = crate::lending::codex_lender();
        let servers = Servers {
            claude: &shared.mcp_servers,
            codex: &shared.codex_overrides,
            plugins: &plugins,
        };
        spawn(kind, name, exe, &site.folder, servers, lender).await
    })
    .await
}

/// The MCP definitions a CLI loads besides its profile's own, as a chat's launch passes them.
struct Servers<'a> {
    claude: &'a Map<String, Value>,
    codex: &'a [String],
    plugins: &'a crate::plugins::Runtime,
}

/// Starts the CLI in `folder` and opens its session. Inside a launch's profile, it is that
/// profile's CLI.
async fn spawn(
    kind: Kind,
    name: &str,
    exe: crate::providers::Executable,
    folder: &str,
    servers: Servers<'_>,
    lender: Option<crate::profiles::Profile>,
) -> Result<Session, String> {
    // A distribution without a folder of the screen's starts the CLI in its own runtime folder.
    let mut command = if folder.is_empty() && exe.wsl.is_some() {
        let mut command = exe.command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    } else {
        crate::mcp::command(&exe, folder)
    };
    command
        .env_remove("CLAUDECODE")
        .env_remove("CODEX_THREAD_ID")
        .env("NO_COLOR", "1");
    match kind {
        Kind::Claude => {
            command.args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--tools",
                "",
                "--permission-mode",
                "dontAsk",
                "--settings",
                &json!({"cleanupPeriodDays": crate::retention::DAYS, "disableAllHooks": true})
                    .to_string(),
            ]);
            if !servers.claude.is_empty() {
                command.args([
                    "--mcp-config",
                    &json!({ "mcpServers": servers.claude }).to_string(),
                ]);
            }
            crate::plugins::claude_args(&mut command, servers.plugins);
        }
        Kind::Codex => {
            command.args(["app-server", "--stdio"]);
            for entry in servers.codex {
                command.args(["-c", entry]);
            }
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| format!("Could not start {name} for this screen's MCP calls."))?;
    let input = child.stdin.take().ok_or("CLI stdin is unavailable")?;
    let output = child.stdout.take().ok_or("CLI stdout is unavailable")?;
    if let Some(mut errors) = child.stderr.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut errors, &mut tokio::io::sink()).await;
        });
    }
    // Read while the launch's profile holds: the CLI ends outside it.
    let renewal = exe.renewal_lock();
    let ender: Ender = Box::new(move |input| {
        Box::pin(async move {
            crate::providers::wait_for_renewal(renewal.as_deref()).await;
            drop(input);
            exe.end(child, None, None, None).await;
        })
    });
    match kind {
        Kind::Claude => Session::claude(Box::pin(input), output, ender).await,
        Kind::Codex => Session::codex(Box::pin(input), output, lender, ender).await,
    }
}

/// A launch for tests that start no CLI.
#[cfg(test)]
pub(crate) struct Unlaunched;
#[cfg(test)]
impl Launch for Unlaunched {
    fn launch(&self, _site: &Site, _account: &Account) -> Launched {
        Box::pin(async { Err("No CLI starts in this test.".into()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};

    /// A CLI's side of a session: the lines the session sent, and a way to answer.
    struct Cli {
        lines: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
        output: WriteHalf<DuplexStream>,
    }
    impl Cli {
        async fn next(&mut self) -> Value {
            let line = self.lines.next_line().await.unwrap().expect("a line");
            serde_json::from_str(&line).unwrap()
        }
        async fn say(&mut self, value: Value) {
            self.output
                .write_all(format!("{value}\n").as_bytes())
                .await
                .unwrap();
        }
    }
    /// The session's input and output, and the CLI's side of them.
    fn pipes() -> (Input, ReadHalf<DuplexStream>, Cli) {
        let (session, cli) = tokio::io::duplex(1 << 20);
        let (from_cli, to_cli) = tokio::io::split(session);
        let (cli_reads, cli_writes) = tokio::io::split(cli);
        (
            Box::pin(to_cli),
            from_cli,
            Cli {
                lines: BufReader::new(cli_reads).lines(),
                output: cli_writes,
            },
        )
    }
    fn counting(ended: &Arc<AtomicUsize>) -> Ender {
        let ended = ended.clone();
        Box::new(move |input| {
            Box::pin(async move {
                drop(input);
                ended.fetch_add(1, Ordering::SeqCst);
            })
        })
    }
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }
    fn arguments(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn servers_are_named_as_claude_code_names_them() {
        assert_eq!(claude_name("linear"), "linear");
        assert_eq!(claude_name("probe server.v1"), "probe_server_v1");
        assert_eq!(claude_name("claude.ai Linear"), "claude_ai_Linear");
        assert_eq!(
            claude_name("claude.ai  Claude  Docs"),
            "claude_ai_Claude_Docs"
        );
        assert_eq!(claude_name("claude_ai_Linear"), "claude_ai_Linear");
        // One _ for each UTF-16 unit, as JavaScript replaces them.
        assert_eq!(claude_name("a😀b"), "a__b");
        assert_eq!(claude_name("ñ-x"), "_-x");
        // A Codex agent's identifiers spell punctuation as _.
        assert_eq!(loose("dash-name"), loose("dash_name"));
        assert_ne!(loose("dash-name"), loose("dashname"));
    }

    #[tokio::test]
    async fn claude_answers_calls_by_request_id_and_hears_refusals() {
        let (input, output, mut cli) = pipes();
        let ended = Arc::new(AtomicUsize::new(0));
        let fake = tokio::spawn(async move {
            let init = cli.next().await;
            assert_eq!(init["request"]["subtype"], "initialize");
            cli.say(json!({"type":"control_response","response":{"subtype":"success","request_id":init["request_id"],"response":{}}}))
                .await;
            let first = cli.next().await;
            let second = cli.next().await;
            assert_eq!(first["request"]["subtype"], "mcp_call");
            assert_eq!(
                first["request"]["tool"],
                "mcp__claude_ai_Linear__list_issues"
            );
            assert_eq!(first["request"]["arguments"], json!({"team": "x"}));
            assert_eq!(first["request"]["result_not_for_model"], true);
            // A form a server wants filled in is refused, and the call still answers.
            cli.say(json!({"type":"control_request","request_id":"ask-1","request":{"subtype":"elicitation"}}))
                .await;
            let refusal = cli.next().await;
            assert_eq!(refusal["response"]["subtype"], "error");
            assert_eq!(refusal["response"]["request_id"], "ask-1");
            // Answers arrive in any order.
            cli.say(json!({"type":"control_response","response":{"subtype":"error","request_id":second["request_id"],"error":"MCP server not connected: meshy"}}))
                .await;
            cli.say(json!({"type":"control_response","response":{"subtype":"success","request_id":first["request_id"],
                "response":{"content":"{\"issues\":[]}","structuredContent":{"issues":[]}}}}))
                .await;
            cli
        });
        let session = Session::claude(input, output, counting(&ended))
            .await
            .unwrap();
        let (listed, missing) = tokio::join!(
            session.call(
                "claude.ai Linear",
                "list_issues",
                arguments(json!({"team": "x"}))
            ),
            session.call("meshy", "check_balance", Map::new()),
        );
        assert_eq!(
            listed.unwrap(),
            json!({"content":[{"type":"text","text":"{\"issues\":[]}"}],"structuredContent":{"issues":[]}})
        );
        let failure = missing.unwrap_err();
        assert!(
            failure
                .message
                .contains("no connected MCP server named meshy")
                && failure.restart
                && failure.elsewhere,
            "{failure:?}"
        );
        let cli = fake.await.unwrap();
        // A CLI that ends fails what still waits, and every later call.
        drop(cli);
        settle().await;
        let failure = session.call("meshy", "x", Map::new()).await.unwrap_err();
        assert!(failure.message == ENDED && failure.restart && !failure.elsewhere);
        assert!(!session.alive());
        session.finish();
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn claude_failures_read_as_the_page_should_see_them() {
        // A server this account must sign in to, or does not have, may be another's there.
        let failure = claude_failure(
            "linear",
            "MCP server linear requires authentication — send mcp_authenticate and retry mcp_call: x".into(),
        );
        assert!(
            failure
                .message
                .starts_with("Sign in to the MCP server linear")
                && failure.restart
                && failure.elsewhere
        );
        // A tool's own error is the page's to read.
        assert_eq!(
            claude_failure("x", "MCP error -32602: Tool nope not found".into()),
            Failure {
                message: "MCP error -32602: Tool nope not found".into(),
                restart: false,
                elsewhere: false,
            }
        );
        let failure = codex_failure(
            "rider",
            "failed to get client: MCP startup failed: handshaking".into(),
        );
        assert!(failure.message.contains("did not start") && failure.restart && failure.elsewhere);
        let failure = codex_failure("rider", "unknown MCP server 'rider'".into());
        assert!(failure.elsewhere && !failure.restart);
        assert_eq!(
            outcome(json!({"content": null, "_meta": {"x": 1}})),
            json!({"content": []})
        );
        assert_eq!(
            reported(
                "fail",
                &json!({"content": [{"type":"text","text":"It failed"}]})
            ),
            "It failed"
        );
        assert_eq!(
            reported("fail", &json!({"content": []})),
            "The MCP tool fail reported an error."
        );
    }

    #[tokio::test]
    async fn codex_calls_reach_its_thread_and_find_servers_by_their_configured_names() {
        let (input, output, mut cli) = pipes();
        let ended = Arc::new(AtomicUsize::new(0));
        let fake = tokio::spawn(async move {
            let init = cli.next().await;
            assert_eq!(init["method"], "initialize");
            assert_eq!(init["params"]["capabilities"]["experimentalApi"], true);
            cli.say(json!({"id": init["id"], "result": {}})).await;
            assert_eq!(cli.next().await, json!({"method": "initialized"}));
            let thread = cli.next().await;
            assert_eq!(thread["method"], "thread/start");
            assert_eq!(thread["params"]["ephemeral"], true);
            assert_eq!(thread["params"]["approvalPolicy"], "never");
            cli.say(json!({"id": thread["id"], "result": {"thread": {"id": "thread-1"}}}))
                .await;
            // The agent saw dash-name as dash_name.
            let call = cli.next().await;
            assert_eq!(call["method"], "mcpServer/tool/call");
            assert_eq!(call["params"]["threadId"], "thread-1");
            assert_eq!(call["params"]["server"], "dash_name");
            cli.say(json!({"id": call["id"], "error": {"code": -32603, "message": "unknown MCP server 'dash_name'"}}))
                .await;
            let list = cli.next().await;
            assert_eq!(list["method"], "mcpServerStatus/list");
            cli.say(json!({"id": list["id"], "result": {"data": [{"name": "other"}, {"name": "dash-name"}], "nextCursor": null}}))
                .await;
            let retry = cli.next().await;
            assert_eq!(retry["params"]["server"], "dash-name");
            assert_eq!(retry["params"]["arguments"], json!({"text": "hi"}));
            // A request the CLI makes of its client is refused.
            cli.say(json!({"id": 77, "method": "mcpServer/elicitation/request", "params": {}}))
                .await;
            let refusal = cli.next().await;
            assert_eq!(refusal["id"], 77);
            assert_eq!(refusal["error"]["code"], -32601);
            cli.say(
                json!({"id": retry["id"], "result": {"content": [{"type":"text","text":"ok"}]}}),
            )
            .await;
            // The name it found is kept for the next call.
            let failing = cli.next().await;
            assert_eq!(failing["params"]["server"], "dash-name");
            cli.say(json!({"id": failing["id"], "result": {"isError": true, "content": [{"type":"text","text":"It failed on purpose"}]}}))
                .await;
            cli
        });
        let session = Session::codex(input, output, None, counting(&ended))
            .await
            .unwrap();
        assert_eq!(session.thread, "thread-1");
        let echoed = session
            .call("dash_name", "echo", arguments(json!({"text": "hi"})))
            .await
            .unwrap();
        assert_eq!(echoed, json!({"content": [{"type":"text","text":"ok"}]}));
        let failure = session
            .call("dash_name", "fail", Map::new())
            .await
            .unwrap_err();
        assert!(
            failure.message == "It failed on purpose" && !failure.restart && !failure.elsewhere
        );
        drop(fake.await.unwrap());
    }

    #[tokio::test]
    async fn a_cli_that_never_starts_is_ended() {
        let (input, output, mut cli) = pipes();
        let ended = Arc::new(AtomicUsize::new(0));
        let fake = tokio::spawn(async move {
            let init = cli.next().await;
            cli.say(json!({"type":"control_response","response":{"subtype":"error","request_id":init["request_id"],"error":"no"}}))
                .await;
            cli
        });
        let error = Session::claude(input, output, counting(&ended))
            .await
            .err()
            .unwrap();
        assert!(error.contains("did not start"), "{error}");
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        drop(fake.await.unwrap());
    }

    /// Starts sessions whose fake Claude Code answers every call with its account and the tool's
    /// name. An account in `without` must sign in to the server first; the tool `gone` finds the
    /// server disconnected for every account, and `broken` fails as a tool.
    struct Fake {
        launched: Arc<AtomicUsize>,
        ended: Arc<AtomicUsize>,
        without: Vec<String>,
    }
    impl Launch for Fake {
        fn launch(&self, _site: &Site, account: &Account) -> Launched {
            self.launched.fetch_add(1, Ordering::SeqCst);
            let ended = self.ended.clone();
            let name = account.connection_id.clone().unwrap_or_default();
            let lacking = self.without.contains(&name);
            Box::pin(async move {
                let (input, output, mut cli) = pipes();
                tokio::spawn(async move {
                    while let Ok(Some(line)) = cli.lines.next_line().await {
                        let request: Value = serde_json::from_str(&line).unwrap();
                        let id = &request["request_id"];
                        let status = if lacking { "needs-auth" } else { "connected" };
                        let answer = match request["request"]["tool"].as_str() {
                            None => json!({"subtype":"success","request_id":id,"response":{
                                "mcpServers":[{"name":"x","status":status,"tools":[{"name":"one","annotations":{}}]}]}}),
                            Some("mcp__x__gone") => {
                                json!({"subtype":"error","request_id":id,"error":"MCP server not connected: x"})
                            }
                            Some("mcp__x__broken") => {
                                json!({"subtype":"error","request_id":id,"error":"MCP error -32602: Tool broken not found"})
                            }
                            Some(_) if lacking => {
                                json!({"subtype":"error","request_id":id,"error":"MCP server x requires authentication — send mcp_authenticate"})
                            }
                            Some(tool) => {
                                json!({"subtype":"success","request_id":id,"response":{"content":format!("{name} {tool}")}})
                            }
                        };
                        cli.say(json!({"type":"control_response","response":answer}))
                            .await;
                    }
                });
                Session::claude(input, output, counting(&ended)).await
            })
        }
    }
    fn screen() -> super::super::Screen {
        super::super::Screen {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            title: "Issues".into(),
            description: String::new(),
            html: "<p></p>".into(),
            actions: vec![],
            mcp_tools: vec![],
            site: Site {
                environment_id: uuid::Uuid::new_v4().to_string(),
                distribution: None,
                folder: "C:\\work".into(),
                project: String::new(),
            },
            account: None,
            conversation_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
    fn candidate(id: &str) -> Candidate {
        Candidate {
            account: Account {
                provider: "claude".into(),
                connection_id: Some(id.into()),
            },
            name: id.into(),
        }
    }
    fn fake(without: &[&str]) -> (Fake, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let launched = Arc::new(AtomicUsize::new(0));
        let ended = Arc::new(AtomicUsize::new(0));
        (
            Fake {
                launched: launched.clone(),
                ended: ended.clone(),
                without: without.iter().map(|name| name.to_string()).collect(),
            },
            launched,
            ended,
        )
    }
    fn content(value: Value) -> Value {
        value["content"][0]["text"].clone()
    }

    #[tokio::test(start_paused = true)]
    async fn each_screen_keeps_a_cli_per_account_while_it_calls_and_frees_it_when_idle() {
        let (fake, launched, ended) = fake(&[]);
        let calls = Calls::default();
        let screen = screen();
        let ask = |tool: &'static str, who: &'static str| {
            let (calls, screen, fake) = (&calls, &screen, &fake);
            async move {
                calls
                    .call(
                        &screen.id,
                        &screen.site,
                        true,
                        async move { Ok(vec![candidate(who)]) },
                        fake,
                        "x",
                        tool,
                        Map::new(),
                    )
                    .await
                    .map(|(value, _)| value)
            }
        };
        // Calls at once share the one CLI the first starts.
        let (first, second) = tokio::join!(ask("one", "a"), ask("two", "a"));
        assert_eq!(content(first.unwrap()), "a mcp__x__one");
        assert_eq!(content(second.unwrap()), "a mcp__x__two");
        assert_eq!(launched.load(Ordering::SeqCst), 1);
        // Another account starts a CLI of its own beside it.
        assert_eq!(content(ask("three", "b").await.unwrap()), "b mcp__x__three");
        settle().await;
        assert_eq!(
            (
                launched.load(Ordering::SeqCst),
                ended.load(Ordering::SeqCst)
            ),
            (2, 0)
        );
        // Quiet CLIs go, and the next call starts another.
        tokio::time::sleep(IDLE - Duration::from_secs(1)).await;
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_secs(2)).await;
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 2);
        ask("four", "b").await.unwrap();
        assert_eq!(launched.load(Ordering::SeqCst), 3);
        // A server this CLI cannot reach sends the next call to a new one.
        let error = ask("gone", "b").await.unwrap_err();
        assert!(error.contains("no connected MCP server named x"), "{error}");
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 3);
        ask("five", "b").await.unwrap();
        assert_eq!(launched.load(Ordering::SeqCst), 4);
        // Releasing the screen ends its CLIs; quitting ends the rest and refuses later calls.
        calls.release(&screen.id).await;
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 4);
        ask("six", "b").await.unwrap();
        calls.shutdown().await;
        settle().await;
        assert_eq!(ended.load(Ordering::SeqCst), 5);
        assert!(ask("seven", "b").await.unwrap_err().contains("quitting"));
    }

    #[tokio::test]
    async fn a_call_goes_on_to_the_account_that_has_the_server_and_remembers_it() {
        let (fake, launched, _) = fake(&["same"]);
        let calls = Calls::default();
        let screen = screen();
        let call = |tool: &'static str, candidates: Result<Vec<Candidate>, String>| {
            let (calls, screen, fake) = (&calls, &screen, &fake);
            async move {
                calls
                    .call(
                        &screen.id,
                        &screen.site,
                        false,
                        async move { candidates },
                        fake,
                        "x",
                        tool,
                        Map::new(),
                    )
                    .await
                    .map(|(value, _)| value)
            }
        };
        let both = || Ok(vec![candidate("same"), candidate("login")]);
        // The first account must sign in to the server, so the next one answers.
        assert_eq!(
            content(call("one", both()).await.unwrap()),
            "login mcp__x__one"
        );
        assert_eq!(launched.load(Ordering::SeqCst), 2);
        // The next call goes straight to it, without reading the accounts again.
        assert_eq!(
            content(call("two", Err("not read".into())).await.unwrap()),
            "login mcp__x__two"
        );
        // A tool's own error is the answer, from the first account that has the server.
        assert_eq!(
            call("broken", both()).await.unwrap_err(),
            "MCP error -32602: Tool broken not found"
        );
        // When no account there can reach it, each says why.
        let error = call("gone", both()).await.unwrap_err();
        assert!(
            error.starts_with("No account there could call the tools of x.")
                && error.contains("login: This account has no connected MCP server named x.")
                && error.contains("same: This account has no connected MCP server named x."),
            "{error}"
        );
        assert!(call("one", Ok(vec![]))
            .await
            .unwrap_err()
            .contains("No Claude or Codex account"));
        // A listing reports the first account that starts, and remembers the servers it has.
        let (listed, servers) = calls
            .servers(&screen.id, &screen.site, vec![candidate("login")], &fake)
            .await
            .unwrap();
        assert_eq!(listed.name, "login");
        assert_eq!(
            servers,
            [json!({"name": "x", "status": "connected", "tools": [{"name": "one"}]})]
        );
        assert_eq!(
            content(call("three", Err("not read".into())).await.unwrap()),
            "login mcp__x__three"
        );
        // Another screen keeps routes of its own, and releasing a screen forgets its own.
        let elsewhere = calls
            .call(
                "other",
                &screen.site,
                false,
                async { Ok(vec![candidate("same")]) },
                &fake,
                "x",
                "four",
                Map::new(),
            )
            .await
            .unwrap_err();
        assert!(
            elsewhere.starts_with("Sign in to the MCP server x"),
            "{elsewhere}"
        );
        calls.release(&screen.id).await;
        assert!(call("five", Err("read again".into()))
            .await
            .unwrap_err()
            .contains("read again"));
        calls.shutdown().await;
    }

    /// A stdio MCP server for the opt-in tests, run by Node: echo, big, fail, structured, image.
    const PROBE: &str = r#"import { createInterface } from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const tools = ['echo', 'big', 'fail', 'structured', 'image'].map((name) => ({ name, inputSchema: { type: 'object' } }));
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } });
  if (m.method === 'tools/list') return reply({ tools });
  if (m.method !== 'tools/call') return m.id === undefined ? undefined : reply({});
  const a = m.params.arguments ?? {};
  if (m.params.name === 'echo') return reply({ content: [{ type: 'text', text: JSON.stringify({ args: a, cwd: process.cwd() }) }] });
  if (m.params.name === 'big') return reply({ content: [{ type: 'text', text: 'x'.repeat(a.n - 3) + 'END' }] });
  if (m.params.name === 'fail') return reply({ isError: true, content: [{ type: 'text', text: 'It failed on purpose' }] });
  if (m.params.name === 'structured') return reply({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } });
  if (m.params.name === 'image') return reply({ content: [{ type: 'text', text: 'a pixel' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool ' + m.params.name } });
});
"#;

    /// Calls every probe tool through a session of an installed CLI, the probe server named
    /// `server` there and reached as `called`.
    async fn probe(session: &Session, called: &str, folder: &Path) {
        let echoed = session
            .call(called, "echo", arguments(json!({"text": "hi \"there\" ñ"})))
            .await
            .unwrap();
        let said: Value =
            serde_json::from_str(echoed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(said["args"], json!({"text": "hi \"there\" ñ"}));
        // The server runs in the screen's folder.
        assert_eq!(
            std::fs::canonicalize(said["cwd"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(folder).unwrap()
        );
        // A megabyte comes whole: the result is the page's, not a model's.
        let big = session
            .call(called, "big", arguments(json!({"n": 1_000_000})))
            .await
            .unwrap();
        let text = big["content"][0]["text"].as_str().unwrap();
        assert!(text.len() == 1_000_000 && text.ends_with("END"));
        let structured = session
            .call(called, "structured", Map::new())
            .await
            .unwrap();
        assert_eq!(structured["structuredContent"], json!({"ok": true}));
        let image = session.call(called, "image", Map::new()).await.unwrap();
        assert_eq!(image["content"][1]["type"], "image");
        let failed = session.call(called, "fail", Map::new()).await.unwrap_err();
        assert!(
            failed.message.contains("It failed on purpose") && !failed.restart,
            "{failed:?}"
        );
        let missing = session.call("nope", "echo", Map::new()).await.unwrap_err();
        assert!(
            missing.message.contains("nope") && missing.elsewhere,
            "{missing:?}"
        );
        // Listing names the server with its tools.
        let servers = session.servers().await.unwrap();
        let probe = servers
            .iter()
            .find(|server| server["status"] == "connected")
            .expect("the probe server");
        assert!(probe["tools"].to_string().contains("echo"), "{probe}");
    }
    fn probe_script(folder: &Path) -> String {
        let path = folder.join("probe.mjs");
        std::fs::write(&path, PROBE).unwrap();
        path.to_string_lossy().replace('\\', "/")
    }

    #[tokio::test]
    #[ignore = "Opt-in: runs the installed Claude Code against a local MCP server (needs Node)"]
    async fn installed_claude_answers_a_screens_mcp_calls() {
        let folder = tempfile::tempdir().unwrap();
        let script = probe_script(folder.path());
        let servers =
            json!({"probe server.v1": {"type": "stdio", "command": "node", "args": [script]}});
        let exe = crate::providers::resolve("claude").await.unwrap();
        let session = spawn(
            Kind::Claude,
            "Claude Code",
            exe,
            &folder.path().to_string_lossy(),
            Servers {
                claude: servers.as_object().unwrap(),
                codex: &[],
                plugins: &crate::plugins::Runtime::default(),
            },
            None,
        )
        .await
        .unwrap();
        probe(&session, "probe server.v1", folder.path()).await;
        session.finish();
    }

    /// The first WSL distribution this computer has.
    #[cfg(windows)]
    fn first_distribution() -> String {
        use std::os::windows::process::CommandExt;
        let listed = std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet"])
            .creation_flags(0x08000000)
            .output()
            .unwrap()
            .stdout;
        let listed: Vec<u16> = listed
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&listed)
            .lines()
            .map(str::trim)
            .find(|name| !name.is_empty())
            .expect("Install a WSL distribution first")
            .to_string()
    }

    /// A screen on Windows reaching the servers of the first WSL distribution's Claude CLI login
    /// (requested 2026-10-30): the session starts there without a folder of the screen's, lists
    /// the servers with their state and tools, and with `AGENT_STUDIO_TEST_MCP_CALL` set to
    /// `server/tool` calls that tool without arguments.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in: lists the MCP servers of the first WSL distribution's Claude CLI login"]
    async fn installed_wsl_claude_lists_its_servers_for_a_screen() {
        let profile = crate::profiles::Profile {
            provider: "claude".into(),
            distribution: Some(first_distribution()),
            namespace: "agent-studio-test".into(),
            ..Default::default()
        };
        let session = crate::profiles::scope(profile, async {
            let exe = crate::providers::resolve("claude").await.unwrap();
            spawn(
                Kind::Claude,
                "Claude Code",
                exe,
                "",
                Servers {
                    claude: &Map::new(),
                    codex: &[],
                    plugins: &crate::plugins::Runtime::default(),
                },
                None,
            )
            .await
        })
        .await
        .unwrap();
        let servers = session.servers().await.unwrap();
        for server in &servers {
            eprintln!(
                "{} {} {} tools",
                server["name"],
                server["status"],
                server["tools"].as_array().map_or(0, Vec::len)
            );
        }
        assert!(servers.iter().all(|server| server["name"].is_string()));
        if let Ok(named) = std::env::var("AGENT_STUDIO_TEST_MCP_CALL") {
            let (server, tool) = named.split_once('/').expect("server/tool");
            let result = session.call(server, tool, Map::new()).await.unwrap();
            let text = result["content"].to_string();
            eprintln!(
                "{tool} of {server} answered {} bytes",
                text.len() + result["structuredContent"].to_string().len()
            );
        }
        session.finish();
    }

    #[tokio::test]
    #[ignore = "Opt-in: runs the installed Codex against a local MCP server (needs Node)"]
    async fn installed_codex_answers_a_screens_mcp_calls() {
        let folder = tempfile::tempdir().unwrap();
        let script = probe_script(folder.path());
        let overrides = [
            "mcp_servers.probe-server.command=\"node\"".to_string(),
            format!("mcp_servers.probe-server.args=['{script}']"),
        ];
        let exe = crate::providers::resolve("codex").await.unwrap();
        let session = spawn(
            Kind::Codex,
            "Codex",
            exe,
            &folder.path().to_string_lossy(),
            Servers {
                claude: &Map::new(),
                codex: &overrides,
                plugins: &crate::plugins::Runtime::default(),
            },
            None,
        )
        .await
        .unwrap();
        // As a Codex agent names it in mcp__probe_server__echo.
        probe(&session, "probe_server", folder.path()).await;
        session.finish();
    }
}
