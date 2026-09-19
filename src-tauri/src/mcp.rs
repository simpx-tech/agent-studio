//! Explicit MCP management. Credentials stay with the selected CLI. OAuth handles,
//! URLs and callback codes are transient and never enter chat history or diagnostics.
use crate::{
    folders::ChatLocation,
    pool::{Line, Process},
    providers::{sessions, Executable},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs::File, path::Path, process::Stdio, sync::Arc, time::Duration};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, sync::Mutex, time::Instant};

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Server {
    Http { url: String },
    Sse { url: String },
    Stdio { command: String, args: Vec<String> },
}
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Status,
    Login {
        name: String,
    },
    Authenticate {
        name: String,
    },
    Reconnect {
        name: String,
    },
    Toggle {
        name: String,
        enabled: bool,
    },
    Add {
        name: String,
        server: Server,
    },
    Logout {
        name: String,
    },
    Reload,
    SetServers {
        servers: HashMap<String, Server>,
    },
    Poll {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Cancel {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Callback {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "callbackUrl")]
        callback_url: String,
    },
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultView {
    status: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    authorization_url: Option<String>,
    callback_allowed: bool,
    servers: Vec<ServerView>,
}
#[derive(Clone, Serialize)]
struct ServerView {
    name: String,
    status: String,
}
struct Pending {
    cli_login: bool,
    scope: String,
    conversation: Option<String>,
    process: Option<Process>,
    _lock: Option<File>,
    pooled: bool,
    provider: String,
    name: String,
    view: ResultView,
    expires: Instant,
    oauth_completed: Option<bool>,
}
#[derive(Default)]
pub struct Management(Mutex<HashMap<String, Arc<Mutex<Pending>>>>);

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name != "agent_studio"
        && !name.starts_with('-')
        && name.trim() == name
        && !name.chars().any(char::is_control)
}
fn safe_url(value: &str) -> bool {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
}
impl Server {
    fn value(&self) -> Result<Value, String> {
        match self {
            Self::Http { url } | Self::Sse { url } if safe_url(url) && url.len() <= 4096 && tauri::Url::parse(url).is_ok_and(|u| u.fragment().is_none()) =>
                Ok(json!({"type":if matches!(self, Self::Http { .. }) { "http" } else { "sse" },"url":url})),
            Self::Stdio { command, args } if args.len() <= 64 &&
                std::iter::once(command).chain(args).all(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)) =>
                Ok(json!({"type":"stdio","command":command,"args":args})),
            _ => Err("Invalid MCP server. Use HTTPS or local HTTP, or a command with separate arguments.".into()),
        }
    }
}
impl Action {
    fn validate(&self, provider: &str) -> Result<(), String> {
        if !matches!(provider, "claude" | "codex") {
            return Err("MCP management is unavailable for this agent".into());
        }
        match self {
            Self::Login { name }
            | Self::Authenticate { name }
            | Self::Reconnect { name }
            | Self::Toggle { name, .. }
            | Self::Add { name, .. }
            | Self::Logout { name }
                if !valid_name(name) =>
            {
                return Err("Invalid or reserved MCP server name".into())
            }
            Self::SetServers { servers } => {
                if servers.len() > 20 || servers.keys().any(|s| !valid_name(s)) {
                    return Err("Invalid session server names or too many servers".into());
                }
                let mut total = 0;
                for server in servers.values() {
                    total += server.value()?.to_string().len();
                    if total > 64_000 {
                        return Err("Session server definitions exceed their size limit".into());
                    }
                }
            }
            Self::Add { server, .. } => {
                server.value()?;
            }
            Self::Poll { operation_id }
            | Self::Cancel { operation_id }
            | Self::Callback { operation_id, .. } => {
                uuid::Uuid::parse_str(operation_id).map_err(|_| "Invalid MCP operation")?;
            }
            _ => {}
        }
        if provider != "claude"
            && matches!(
                self,
                Self::Toggle { .. } | Self::SetServers { .. } | Self::Login { .. }
            )
        {
            return Err("This control is available for Claude only".into());
        }
        if let Self::Callback { callback_url, .. } = self {
            if !safe_url(callback_url) {
                return Err("Invalid OAuth callback URL".into());
            }
        }
        Ok(())
    }
}

fn observe(pending: &mut Pending, value: &Value) {
    let Some(process) = &pending.process else {
        return;
    };
    let params = &value["params"];
    // App-scoped notifications must never satisfy a thread-scoped operation, or vice versa.
    let scope_matches = if process.thread.is_empty() {
        params["threadId"].is_null()
    } else {
        params["threadId"].as_str() == Some(process.thread.as_str())
    };
    if !scope_matches {
        return;
    }
    if value["method"] == "mcpServer/oauthLogin/completed" && params["name"] == pending.name {
        if let Some(success) = params["success"].as_bool() {
            pending.oauth_completed = Some(success);
        }
    }
    if value["method"] == "mcpServer/startupStatus/updated" {
        if let Some(name) = params["name"].as_str().filter(|s| valid_name(s)) {
            let status = if params["failureReason"] == "reauthenticationRequired" {
                "needsAuth"
            } else {
                status(&params["status"])
            };
            pending.view.servers.retain(|s| s.name != name);
            if pending.view.servers.len() < 200 {
                pending.view.servers.push(ServerView {
                    name: name.into(),
                    status: status.into(),
                });
            }
        }
    }
}
fn status(value: &Value) -> &'static str {
    match value.as_str() {
        Some("connected" | "ready") => "connected",
        Some("disabled") => "disabled",
        Some("starting" | "pending") => "pending",
        Some("failed" | "cancelled") => "failed",
        Some("needs-auth" | "notLoggedIn" | "authenticationRequired") => "needsAuth",
        _ => "configured",
    }
}
async fn write(pending: &mut Pending, value: Value) -> Result<(), String> {
    pending
        .process
        .as_mut()
        .ok_or("MCP process is unavailable")?
        .stdin
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|_| "MCP request could not be sent".into())
}
async fn request(pending: &mut Pending, method: &str, params: Value) -> Result<Value, String> {
    let process = pending
        .process
        .as_mut()
        .ok_or("MCP process is unavailable")?;
    let id = process.next_id;
    process.next_id += 1;
    let claude = pending.provider == "claude";
    let request_id = format!("studio-mcp-{id}");
    let value = if claude {
        let mut body = params;
        body["subtype"] = json!(method);
        json!({"type":"control_request","request_id":request_id,"request":body})
    } else {
        json!({"id":id,"method":method,"params":params})
    };
    write(pending, value).await?;
    let work = async {
        loop {
            let line = pending
                .process
                .as_mut()
                .ok_or("MCP process is unavailable")?
                .lines
                .recv()
                .await
                .ok_or("The CLI exited before confirming the MCP request")?;
            let Line::Out(line) = line else {
                continue;
            };
            if line.len() > 2_000_000 {
                return Err("MCP response exceeded its limit".into());
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            observe(pending, &value);
            if claude
                && value["type"] == "control_response"
                && value["response"]["request_id"] == request_id
            {
                return if value["response"]["subtype"] == "success" {
                    Ok(value["response"]["response"].clone())
                } else {
                    Err("The CLI rejected this MCP action. Check server availability, policy, and CLI version.".into())
                };
            }
            if !claude && value["id"] == id && value.get("method").is_none() {
                return if value.get("error").is_some() {
                    Err("The CLI rejected this MCP action. Check server availability, policy, and CLI version.".into())
                } else {
                    Ok(value["result"].clone())
                };
            }
            // Management never approves tool execution or elicitation from a background server.
            if claude && value["type"] == "control_request" {
                if value["request"]["subtype"] == "mcp_message"
                    && value["request"]["server_name"] == "agent_studio"
                    && matches!(
                        value["request"]["message"]["method"].as_str(),
                        Some("initialize" | "notifications/initialized" | "ping" | "tools/list")
                    )
                {
                    let response =
                        crate::providers::visualize::Visualizer::default().claude_response(&value);
                    write(pending, response).await?;
                    continue;
                }
                write(pending, json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"Unavailable during MCP management"}})).await?;
            } else if !claude && value.get("id").is_some() && value["method"].is_string() {
                write(pending, json!({"id":value["id"],"error":{"code":-32601,"message":"Unavailable during MCP management"}})).await?;
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(25), work).await {
        Ok(result) => result,
        Err(_) => {
            if let Some(process) = &mut pending.process {
                process.healthy = false;
            }
            Err(
                "MCP request timed out; its outcome is unconfirmed. Refresh before retrying."
                    .into(),
            )
        }
    }
}
async fn inventory(pending: &mut Pending) -> Result<(), String> {
    let mut servers = Vec::new();
    if pending.provider == "claude" {
        let result = request(pending, "mcp_status", json!({})).await?;
        let list = result["mcpServers"]
            .as_array()
            .ok_or("MCP status is unavailable in this CLI version")?;
        for server in list.iter().take(200) {
            if let Some(name) = server["name"].as_str().filter(|n| valid_name(n)) {
                servers.push(ServerView {
                    name: name.into(),
                    status: status(&server["status"]).into(),
                });
            }
        }
    } else {
        let config = request(pending, "config/read", json!({"includeLayers":false})).await?;
        if let Some(configured) = config["config"]["mcp_servers"].as_object() {
            for (name, settings) in configured
                .iter()
                .take(200)
                .filter(|(name, _)| valid_name(name))
            {
                servers.push(ServerView {
                    name: name.clone(),
                    status: if settings["enabled"] == false {
                        "disabled"
                    } else {
                        "configured"
                    }
                    .into(),
                });
            }
        }
        let mut cursor = Value::Null;
        let mut seen = std::collections::HashSet::new();
        loop {
            let thread = pending
                .process
                .as_ref()
                .filter(|p| !p.thread.is_empty())
                .map(|p| p.thread.clone());
            let result = request(
                pending,
                "mcpServerStatus/list",
                json!({"threadId":thread,"limit":100,"detail":"toolsAndAuthOnly","cursor":cursor}),
            )
            .await?;
            let list = result["data"]
                .as_array()
                .ok_or("MCP status is unavailable in this CLI version")?;
            for server in list.iter().take(200usize.saturating_sub(servers.len())) {
                if let Some(name) = server["name"].as_str().filter(|n| valid_name(n)) {
                    let state = if server["authStatus"] == "notLoggedIn" {
                        "needsAuth"
                    } else {
                        status(&server["runtimeStatus"])
                    };
                    if servers
                        .iter()
                        .any(|s| s.name == name && s.status == "disabled")
                    {
                        continue;
                    }
                    servers.retain(|s| s.name != name);
                    servers.push(ServerView {
                        name: name.into(),
                        status: state.into(),
                    });
                }
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() || servers.len() >= 200 || !seen.insert(cursor.to_string()) {
                break;
            }
        }
    }
    if pending.provider == "codex" {
        for server in &mut servers {
            if server.status == "configured" {
                if let Some(event) = pending.view.servers.iter().find(|s| s.name == server.name) {
                    server.status.clone_from(&event.status);
                }
            }
        }
    }
    pending.view.servers = servers;
    Ok(())
}

async fn folder(
    app: &tauri::AppHandle,
    provider: &str,
    exe: &Executable,
    location: Option<&ChatLocation>,
    conversation: Option<&str>,
) -> Result<String, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let dedicated = if location.is_none() {
        conversation
            .map(|id| crate::standalone::context_directory(&root, id, provider, false))
            .transpose()?
            .flatten()
    } else {
        None
    };
    let relative = if dedicated == Some(crate::standalone::Directory::Dedicated) {
        std::path::PathBuf::from("standalone").join(conversation.unwrap())
    } else {
        "chat-runtime".into()
    };
    let profile = crate::profiles::current();
    let (fallback, bridge) = if let Some(wsl) = &exe.wsl {
        let (_, _, bridge, fallback) = crate::context::wsl_paths(wsl, &profile, provider).await?;
        let fallback = Path::new(&fallback)
            .parent()
            .ok_or("Invalid CLI runtime")?
            .join(&relative)
            .to_string_lossy()
            .replace('\\', "/");
        (fallback, bridge)
    } else {
        let runtime = root.join(relative);
        std::fs::create_dir_all(&runtime).map_err(|_| "Cannot prepare MCP management")?;
        (runtime.to_string_lossy().into_owned(), None)
    };
    let mut folder = location.map(|l| l.path.clone()).unwrap_or(fallback);
    if exe.wsl.is_none() {
        if let Some(distro) = profile
            .folder_distribution
            .as_deref()
            .filter(|_| location.is_some())
        {
            folder = crate::folders::windows_path(distro, &folder)
                .await?
                .to_string_lossy()
                .into_owned();
        }
    }
    let physical = bridge
        .map(|p| p.join(folder.trim_start_matches('/')))
        .unwrap_or_else(|| folder.clone().into());
    if !physical.is_dir() {
        return Err("The selected working folder is unavailable".into());
    }
    Ok(folder)
}
fn command(exe: &Executable, folder: &str) -> tokio::process::Command {
    let mut command = exe.command();
    if exe.wsl.is_some() {
        command.args(["--agent-studio-cwd", folder]);
    } else {
        command.current_dir(folder);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}
async fn finish(app: &tauri::AppHandle, pending: &mut Pending) {
    pending.view.authorization_url = None;
    if let Some(mut process) = pending.process.take() {
        if pending.pooled && process.healthy && process.alive() {
            app.state::<crate::pool::Pool>()
                .park(pending.conversation.as_deref().unwrap(), process)
                .await;
        } else {
            process.kill().await;
        }
    }
    pending._lock = None;
}
impl Management {
    pub fn has_work(&self) -> bool {
        self.0
            .try_lock()
            .map(|entries| !entries.is_empty())
            .unwrap_or(true)
    }
    pub async fn sweep(&self, app: &tauri::AppHandle, all: bool) {
        let entries: Vec<_> = self
            .0
            .lock()
            .await
            .iter()
            .map(|(id, p)| (id.clone(), p.clone()))
            .collect();
        for (id, entry) in entries {
            let mut pending = if all {
                entry.lock().await
            } else {
                let Ok(pending) = entry.try_lock() else {
                    continue;
                };
                pending
            };
            if all || Instant::now() > pending.expires {
                // An abandoned OAuth flow must not continue in a parked process.
                pending.pooled = false;
                finish(app, &mut pending).await;
                self.0.lock().await.remove(&id);
            }
        }
    }
}

pub async fn manage(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
    conversation_id: Option<String>,
    location: Option<ChatLocation>,
    action: Action,
) -> Result<ResultView, String> {
    action.validate(&provider)?;
    let conversation_id = conversation_id
        .map(|id| {
            uuid::Uuid::parse_str(&id)
                .map(|id| id.to_string())
                .map_err(|_| "Invalid conversation id")
        })
        .transpose()?;
    crate::folders::validate_chat(&app, location.as_ref(), Some(&connection_id))?;
    let mut profile = crate::profiles::resolve(&app, &provider, Some(&connection_id))?;
    profile.folder_distribution = location
        .as_ref()
        .map(|l| crate::folders::environment_distribution(&app, &l.environment_id))
        .transpose()?
        .flatten();
    crate::profiles::scope(profile, async move {
        let scope = format!(
            "{}:{}",
            sessions::scope(&provider, location.as_ref())?,
            conversation_id.as_deref().unwrap_or_default()
        );
        let state = app.state::<Management>();
        state.sweep(&app, false).await;
        if let Action::Poll { operation_id }
        | Action::Cancel { operation_id }
        | Action::Callback { operation_id, .. } = &action
        {
            let entry = state
                .0
                .lock()
                .await
                .get(operation_id)
                .cloned()
                .ok_or("This MCP sign-in expired. Start again.")?;
            let mut pending = if matches!(action, Action::Cancel { .. }) {
                entry.lock().await
            } else {
                entry.try_lock().map_err(|_| "This MCP operation is busy")?
            };
            if pending.scope != scope {
                return Err("MCP operation belongs to another selection".into());
            }
            if pending.process.is_none() {
                return Ok(pending.view.clone());
            }
            if matches!(action, Action::Cancel { .. }) {
                pending.pooled = false;
                pending.view.status = "cancelled".into();
                pending.view.message =
                    "Sign-in cancelled. Refresh to check the server's current state.".into();
                finish(&app, &mut pending).await;
            } else {
                let result = async {
                    if pending.cli_login {
                        let exit = pending
                            .process
                            .as_mut()
                            .ok_or("MCP process is unavailable")?
                            .child
                            .try_wait()
                            .map_err(|_| "Cannot check CLI sign-in")?;
                        pending.oauth_completed = exit.map(|e| e.success());
                        return Ok(());
                    }
                    if let Action::Callback { callback_url, .. } = &action {
                        if !pending.view.callback_allowed || provider != "claude" {
                            return Err("Manual callback is unavailable for this sign-in".into());
                        }
                        let name = pending.name.clone();
                        request(
                            &mut pending,
                            "mcp_oauth_callback_url",
                            json!({"serverName":name,"callbackUrl":callback_url}),
                        )
                        .await?;
                        request(&mut pending, "mcp_reconnect", json!({"serverName":name})).await?;
                    }
                    inventory(&mut pending).await
                }
                .await;
                let completed = if provider == "codex" || pending.cli_login {
                    pending.oauth_completed
                } else if pending
                    .view
                    .servers
                    .iter()
                    .any(|s| s.name == pending.name && s.status == "connected")
                {
                    Some(true)
                } else {
                    None
                };
                if let Some(success) = completed {
                    pending.view.status = if success { "complete" } else { "failed" }.into();
                    pending.view.message = if success {
                        "Sign-in confirmed by the CLI."
                    } else {
                        "The CLI reported that sign-in failed. Try again."
                    }
                    .into();
                    finish(&app, &mut pending).await;
                } else if let Err(error) = result {
                    // A rejected pasted callback can be corrected without abandoning the flow.
                    if matches!(action, Action::Callback { .. })
                        && pending.process.as_ref().is_some_and(|p| p.healthy)
                    {
                        return Err(error);
                    }
                    pending.view.status = "failed".into();
                    pending.view.message = error;
                    pending.pooled = false;
                    finish(&app, &mut pending).await;
                }
            }
            return Ok(pending.view.clone());
        }
        // Serialize by exact selection, including while an OAuth browser is open.
        let mut registry = state.0.lock().await;
        if registry.len() >= 32 {
            return Err("Too many MCP operations. Wait for earlier operations to expire.".into());
        }
        let mut active = 0;
        for entry in registry.values() {
            if let Ok(p) = entry.try_lock() {
                active += usize::from(p.process.is_some());
                if p.scope == scope && p.process.is_some() {
                    return Err("Finish or cancel this selection's MCP sign-in first".into());
                }
            } else {
                return Err("Another MCP request is busy. Try again shortly.".into());
            }
        }
        if active >= 4 {
            return Err(
                "Four MCP sign-ins are already waiting. Finish or cancel one first.".into(),
            );
        }
        let operation_id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(Mutex::new(Pending {
            cli_login: false,
            scope,
            conversation: conversation_id.clone(),
            process: None,
            _lock: None,
            pooled: false,
            provider: provider.clone(),
            name: String::new(),
            view: ResultView::default(),
            expires: Instant::now() + Duration::from_secs(300),
            oauth_completed: None,
        }));
        registry.insert(operation_id.clone(), entry.clone());
        // Lock before releasing the registry so concurrent starts cannot pass the reservation.
        let mut pending = entry.lock().await;
        drop(registry);
        let result = perform(
            &app,
            &mut pending,
            &provider,
            conversation_id.as_deref(),
            location.as_ref(),
            &action,
        )
        .await;
        match result {
            Ok(()) if pending.view.status == "pending" => {
                pending.view.operation_id = Some(operation_id);
            }
            Ok(()) => {
                finish(&app, &mut pending).await;
                state.0.lock().await.remove(&operation_id);
            }
            Err(error) => {
                finish(&app, &mut pending).await;
                state.0.lock().await.remove(&operation_id);
                return Err(error);
            }
        }
        Ok(pending.view.clone())
    })
    .await
}

async fn perform(
    app: &tauri::AppHandle,
    pending: &mut Pending,
    provider: &str,
    conversation: Option<&str>,
    location: Option<&ChatLocation>,
    action: &Action,
) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    if let Some(id) = conversation {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid conversation id")?;
        let directory = root.join("native-sessions");
        std::fs::create_dir_all(&directory).map_err(|_| "Cannot lock native session")?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{id}.lock")))
            .map_err(|_| "Cannot lock native session")?;
        lock.try_lock()
            .map_err(|_| "Wait for this conversation's reply or other MCP operation to finish")?;
        pending._lock = Some(lock);
        let bound = sessions::bound_id(&root, id, provider, location)?;
        if let Some(mut process) = app.state::<crate::pool::Pool>().take(id) {
            if bound.as_deref() != Some(process.session_id.as_str())
                || !process.healthy
                || !process.alive()
            {
                process.kill().await;
            } else {
                process.claim();
                pending.pooled = true;
                pending.process = Some(process);
            }
        }
    }
    if matches!(
        action,
        Action::SetServers { .. } | Action::Reconnect { .. } | Action::Toggle { .. }
    ) && !pending.pooled
    {
        return Err("This control needs an idle live chat session. Send a reply first, then reopen MCP management.".into());
    }
    let exe = crate::providers::resolve(provider).await?;
    let folder = folder(app, provider, &exe, location, conversation).await?;
    if let Action::Login { name } = action {
        if exe.wsl.is_some() || !cfg!(windows) {
            return Err("Use Sign in for this environment, then open its URL. CLI browser sign-in is available on Windows Desktop only.".into());
        }
        // This explicit fallback uses Claude's own local browser launch. It never interprets CLI output.
        pending.pooled = false;
        if let Some(mut process) = pending.process.take() {
            process.kill().await;
        }
        let child = command(&exe, &folder)
            .args(["mcp", "login", name])
            .spawn()
            .map_err(|_| "Could not start CLI MCP sign-in")?;
        pending.process = Some(Process::new(exe, child, String::new(), String::new())?);
        pending.cli_login = true;
        pending.view.status = "pending".into();
        pending.view.message = "Complete sign-in in the browser on the selected Windows computer. Waiting for the CLI to finish.".into();
        return Ok(());
    }
    if matches!(action, Action::Add { .. } | Action::Logout { .. }) {
        if let Action::Add { name, .. } = action {
            // CLI add may overwrite an existing definition. Check effective config first.
            let report = if provider == "codex" {
                crate::context::codex_report(&exe, &folder).await?
            } else {
                crate::context::claude_report(&exe, &folder, "").await?
            };
            if report["incomplete"] == true
                || (provider == "codex" && !report["mcpConfig"].is_object())
                || (provider == "claude" && !report["mcps"].is_array())
            {
                return Err(
                    "Could not check existing MCP servers. Refresh before adding one.".into(),
                );
            }
            if report["mcpConfig"].get(name).is_some()
                || report["mcps"]
                    .as_array()
                    .is_some_and(|list| list.iter().any(|s| s["name"] == *name))
            {
                return Err(
                    "A server with this name already exists. Choose a different name.".into(),
                );
            }
        }
        let args = cli_args(provider, action)?;
        let mut child = command(&exe, &folder)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start the MCP command")?;
        let result = tokio::time::timeout(Duration::from_secs(25), child.wait()).await;
        exe.kill(&mut child).await;
        // Saved configuration/auth changes take effect on the next native resume.
        pending.pooled = false;
        if !matches!(result, Ok(Ok(status)) if status.success()) {
            return Err("The CLI did not confirm the saved MCP change. Check its version and server configuration.".into());
        }
        pending.view.status = "complete".into();
        pending.view.message =
            "Saved by the selected CLI. Changes apply when this chat next resumes.".into();
        return Ok(());
    }
    if pending.process.is_none() {
        let mut cmd = command(&exe, &folder);
        if provider == "codex" {
            cmd.args(["app-server", "--stdio"]);
        } else {
            cmd.args([
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
                "{\"disableAllHooks\":true}",
            ])
            .env_remove("CLAUDECODE")
            .env_remove("CODEX_THREAD_ID");
        }
        let child = cmd.spawn().map_err(|_| "Could not start MCP management")?;
        pending.process = Some(Process::new(exe, child, String::new(), String::new())?);
        let params = if provider == "codex" {
            json!({"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}})
        } else {
            json!({})
        };
        request(pending, "initialize", params).await?;
        if provider == "codex" {
            write(pending, json!({"method":"initialized"})).await?;
        }
    }
    match action {
        Action::Status => {}
        Action::Authenticate { name } => {
            inventory(pending).await?;
            if !pending.view.servers.iter().any(|s| s.name == *name) {
                return Err(
                    "The selected CLI did not report this server. Refresh before signing in."
                        .into(),
                );
            }
            if provider == "claude"
                && pending
                    .view
                    .servers
                    .iter()
                    .any(|s| s.name == *name && s.status == "connected")
            {
                return Err("This server is already connected. Sign out first if you need to use a different login.".into());
            }
            pending.name.clone_from(name);
            let thread = pending
                .process
                .as_ref()
                .filter(|p| !p.thread.is_empty())
                .map(|p| p.thread.clone());
            let result = if provider == "codex" {
                request(
                    pending,
                    "mcpServer/oauth/login",
                    json!({"name":name,"threadId":thread,"timeoutSecs":300}),
                )
                .await?
            } else {
                request(pending, "mcp_authenticate", json!({"serverName":name})).await?
            };
            let url = result[if provider == "codex" {
                "authorizationUrl"
            } else {
                "authUrl"
            }]
            .as_str();
            if let Some(url) = url {
                if !safe_url(url) {
                    pending.pooled = false;
                    return Err("The CLI returned an unsupported authorization URL".into());
                }
                pending.view.authorization_url = Some(url.into());
            } else if provider == "codex" {
                return Err("The CLI did not return a sign-in URL".into());
            }
            pending.view.status = "pending".into();
            pending.view.callback_allowed =
                provider == "claude" && result["callbackExpected"] == true;
            pending.view.message = "Open sign-in and complete it in your browser. Waiting for CLI confirmation; the callback runs on the selected computer.".into();
        }
        Action::Reconnect { name } if provider == "claude" => {
            request(pending, "mcp_reconnect", json!({"serverName":name})).await?;
        }
        Action::Toggle { name, enabled } => {
            request(
                pending,
                "mcp_toggle",
                json!({"serverName":name,"enabled":enabled}),
            )
            .await?;
        }
        Action::SetServers { servers } => {
            let mut map = serde_json::Map::new();
            for (name, server) in servers {
                map.insert(name.clone(), server.value()?);
            }
            // Preserve the app's in-process visualization/question integration.
            map.insert(
                "agent_studio".into(),
                json!({"type":"sdk","name":"agent_studio"}),
            );
            let response = request(pending, "mcp_set_servers", json!({"servers":map})).await?;
            if response["errors"]
                .as_object()
                .is_some_and(|e| !e.is_empty())
            {
                return Err("Some session servers could not be applied. Refresh their status before retrying.".into());
            }
        }
        Action::Reload | Action::Reconnect { .. } if provider == "codex" => {
            request(pending, "config/mcpServer/reload", json!({})).await?;
        }
        _ => return Err("Unsupported MCP action".into()),
    }
    if pending.view.status != "pending" {
        pending.view.status = "complete".into();
        pending.view.message = if matches!(action, Action::Status) {
            "MCP server status refreshed."
        } else if provider == "codex" {
            "MCP configuration reloaded. Loaded chats refresh on their next turn."
        } else {
            "MCP control confirmed for this live session."
        }
        .into();
        // The mutation was acknowledged even if the follow-up status query fails.
        if inventory(pending).await.is_err() {
            pending
                .view
                .message
                .push_str(" Status refresh is unavailable; refresh to check again.");
        }
    }
    Ok(())
}
fn cli_args(provider: &str, action: &Action) -> Result<Vec<String>, String> {
    let mut args = vec!["mcp".into()];
    match action {
        Action::Logout { name } => args.extend(["logout".into(), name.clone()]),
        Action::Add { name, server } => {
            args.push("add".into());
            if provider == "claude" {
                args.extend(["--scope".into(), "user".into()]);
            }
            match server {
                Server::Http { url } | Server::Sse { url } => {
                    if provider == "claude" {
                        args.extend([
                            "--transport".into(),
                            if matches!(server, Server::Http { .. }) {
                                "http"
                            } else {
                                "sse"
                            }
                            .into(),
                            name.clone(),
                            url.clone(),
                        ]);
                    } else if matches!(server, Server::Http { .. }) {
                        args.extend([name.clone(), "--url".into(), url.clone()]);
                    } else {
                        return Err("Codex does not support adding SSE servers here".into());
                    }
                }
                Server::Stdio {
                    command,
                    args: arguments,
                } => {
                    args.extend([name.clone(), "--".into(), command.clone()]);
                    args.extend(arguments.clone());
                }
            }
        }
        _ => return Err("Unsupported saved MCP change".into()),
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture(provider: &str, script: &str) -> (Pending, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cli.mjs");
        std::fs::write(&path, format!("import {{ createInterface }} from 'node:readline'; const send=v=>console.log(JSON.stringify(v)); createInterface({{input:process.stdin}}).on('line', line=>{{const v=JSON.parse(line); {script} }});")).unwrap();
        let exe = Executable {
            provider: provider.into(),
            program: "node".into(),
            prefix: vec![path.to_string_lossy().into()],
            wsl: None,
        };
        let child = exe
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        (
            Pending {
                cli_login: false,
                scope: "selected".into(),
                conversation: None,
                process: Some(Process::new(exe, child, "".into(), "".into()).unwrap()),
                _lock: None,
                pooled: false,
                provider: provider.into(),
                name: "docs".into(),
                view: ResultView::default(),
                expires: Instant::now() + Duration::from_secs(300),
                oauth_completed: None,
            },
            dir,
        )
    }
    #[test]
    fn rejects_unbounded_or_executable_auth_links_and_reserved_servers() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/test",
            "https://user:secret@example.com/",
            "http://example.com/",
            "https://example.com/\n",
        ] {
            assert!(!safe_url(url), "{url}");
        }
        assert!(safe_url("https://example.com/authorize?state=abc"));
        assert!(safe_url("http://localhost:1234/callback?code=abc"));
        for name in ["agent_studio", "--help", "docs\nserver", ""] {
            assert!(Action::Authenticate { name: name.into() }
                .validate("claude")
                .is_err());
        }
        let action = Action::Toggle {
            name: "docs".into(),
            enabled: false,
        };
        assert!(action.validate("codex").is_err());
        assert!(action.validate("claude").is_ok());
        assert!(serde_json::from_value::<Action>(
            json!({"kind":"authenticate","name":"docs","threadId":"foreign"})
        )
        .is_err());
        assert!(serde_json::from_value::<Server>(
            json!({"type":"http","url":"https://example.com","headers":{"Authorization":"secret"}})
        )
        .is_err());
    }
    #[test]
    fn saved_commands_keep_arguments_as_data_and_use_selected_profile_user_scope() {
        let action = Action::Add {
            name: "docs".into(),
            server: Server::Stdio {
                command: "C:/Program Files/tool.exe".into(),
                args: vec!["$(do-not-run)".into(), "two words".into()],
            },
        };
        assert_eq!(
            cli_args("claude", &action).unwrap(),
            [
                "mcp",
                "add",
                "--scope",
                "user",
                "docs",
                "--",
                "C:/Program Files/tool.exe",
                "$(do-not-run)",
                "two words"
            ]
        );
        assert_eq!(
            cli_args(
                "codex",
                &Action::Logout {
                    name: "docs".into()
                }
            )
            .unwrap(),
            ["mcp", "logout", "docs"]
        );
    }
    #[tokio::test]
    async fn codex_oauth_requires_matching_server_and_thread_completion() {
        let (mut p, _dir) = fixture("codex", r#"
          send({method:'mcpServer/oauthLogin/completed',params:{name:'foreign',threadId:'bound',success:true,error:'private'}});
          send({method:'mcpServer/oauthLogin/completed',params:{name:'docs',threadId:null,success:true}});
          send({method:'mcpServer/startupStatus/updated',params:{name:'docs',threadId:'foreign',status:'ready'}});
          send({id:v.id,result:{authorizationUrl:'https://example.com/auth?state=private'}});
        "#).await;
        p.process.as_mut().unwrap().thread = "bound".into();
        let response = request(
            &mut p,
            "mcpServer/oauth/login",
            json!({"name":"docs","threadId":"bound"}),
        )
        .await
        .unwrap();
        assert!(response["authorizationUrl"].is_string());
        assert_eq!(p.oauth_completed, None);
        assert!(p.view.servers.is_empty());
        observe(
            &mut p,
            &json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"bound","name":"docs","status":"failed","failureReason":"reauthenticationRequired","error":"private"}}),
        );
        assert_eq!(p.view.servers[0].status, "needsAuth");
        observe(
            &mut p,
            &json!({"method":"mcpServer/oauthLogin/completed","params":{"name":"docs","threadId":"bound","success":false,"error":"private"}}),
        );
        assert_eq!(p.oauth_completed, Some(false));
        assert!(!serde_json::to_string(&p.view).unwrap().contains("private"));
        p.process.as_mut().unwrap().kill().await;
    }
    #[tokio::test]
    async fn status_consumes_codex_completion_before_its_response_and_paginates() {
        let (mut p, _dir) = fixture("codex", r#"
          if(v.method==='config/read') send({id:v.id,result:{config:{mcp_servers:{disabled:{enabled:false,env:{SECRET:'hidden'}}}}}});
          else if(!v.params.cursor) {
            send({method:'mcpServer/oauthLogin/completed',params:{name:'docs',threadId:null,success:true}});
            send({id:v.id,result:{data:[{name:'docs',authStatus:'loggedIn',tools:{private:{schema:'hidden'}}}],nextCursor:'next'}});
          } else send({id:v.id,result:{data:[{name:'second',runtimeStatus:'ready'}],nextCursor:null}});
        "#).await;
        inventory(&mut p).await.unwrap();
        assert_eq!(p.oauth_completed, Some(true));
        assert_eq!(p.view.servers.len(), 3);
        assert_eq!(p.view.servers[0].status, "disabled");
        assert!(!serde_json::to_string(&p.view).unwrap().contains("hidden"));
        p.process.as_mut().unwrap().kill().await;
    }
    #[tokio::test]
    async fn claude_matches_control_id_and_refreshes_auth_without_stale_status() {
        let (mut p, _dir) = fixture("claude", r#"
          send({type:'control_response',response:{subtype:'error',request_id:'foreign',error:'private'}});
          send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{mcpServers:[{name:'docs',status:'connected',config:{url:'private'}}]}}});
        "#).await;
        p.view.servers.push(ServerView {
            name: "docs".into(),
            status: "needsAuth".into(),
        });
        inventory(&mut p).await.unwrap();
        assert_eq!(p.view.servers[0].status, "connected");
        assert!(!serde_json::to_string(&p.view).unwrap().contains("private"));
        p.process.as_mut().unwrap().kill().await;
    }
    #[tokio::test]
    async fn provider_rejection_never_exposes_raw_diagnostics() {
        let (mut p, _dir) = fixture("claude", "send({type:'control_response',response:{subtype:'error',request_id:v.request_id,error:'secret token or URL'}});").await;
        let error = request(
            &mut p,
            "mcp_toggle",
            json!({"serverName":"docs","enabled":false}),
        )
        .await
        .unwrap_err();
        assert!(!error.contains("secret"));
        assert!(error.contains("rejected"));
        p.process.as_mut().unwrap().kill().await;
    }
}
