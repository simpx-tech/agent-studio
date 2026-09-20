//! Selected-profile plugin management. No raw CLI output, manifests, or credentials leave the host.
use crate::{
    folders::ChatLocation,
    pool::{Line, Process},
    providers::{Executable, RunRequest},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    List,
    Details {
        id: String,
    },
    Install {
        id: String,
    },
    Toggle {
        id: String,
        enabled: bool,
    },
    Uninstall {
        id: String,
    },
    Skill {
        path: String,
        enabled: bool,
    },
    Runtime {
        #[serde(rename = "pluginDirs")]
        plugin_dirs: Vec<String>,
        #[serde(rename = "pluginUrls")]
        plugin_urls: Vec<String>,
        #[serde(rename = "skillRoots")]
        skill_roots: Vec<String>,
    },
    Eval {
        id: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "maxCostUsd")]
        max_cost_usd: f64,
        trusted: bool,
    },
    Cancel {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub plugin_dirs: Vec<String>,
    pub plugin_urls: Vec<String>,
    pub skill_roots: Vec<String>,
    pub revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    id: String,
    name: String,
    version: String,
    scope: String,
    enabled: Option<bool>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultView {
    plugins: Vec<PluginView>,
    message: String,
    details: Vec<String>,
    #[serde(flatten)]
    runtime: Runtime,
}
static RUNTIMES: LazyLock<Mutex<HashMap<String, Runtime>>> = LazyLock::new(Mutex::default);
static REVISIONS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Mutex::default);
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static EVALS: LazyLock<Mutex<HashMap<String, (String, CancellationToken)>>> =
    LazyLock::new(Mutex::default);
struct Operation(String);
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut active) = EVALS.lock() {
            active.remove(&self.0);
        }
    }
}
pub fn active_tokens() -> Vec<CancellationToken> {
    EVALS
        .lock()
        .map(|active| active.values().map(|(_, token)| token.clone()).collect())
        .unwrap_or_default()
}
fn profile_key() -> String {
    let p = crate::profiles::current();
    format!("{}:{}:{}", p.namespace, p.provider, p.id)
}
fn key(conversation: Option<&str>) -> String {
    format!("{}:{}", profile_key(), conversation.unwrap_or_default())
}
pub fn runtime(conversation: Option<&str>) -> Runtime {
    let mut result = RUNTIMES
        .lock()
        .ok()
        .and_then(|m| m.get(&key(conversation)).cloned())
        .unwrap_or_default();
    result.revision = REVISIONS
        .lock()
        .ok()
        .and_then(|m| m.get(&profile_key()).copied())
        .unwrap_or_default();
    result
}
pub fn for_run(request: &RunRequest) -> Runtime {
    if request.tools_enabled() {
        let mut runtime = runtime(request.conversation_id.as_deref());
        request.shared_context.extend_runtime(&mut runtime);
        runtime
    } else {
        Runtime::default()
    }
}
pub fn claude_args(command: &mut tokio::process::Command, runtime: &Runtime) {
    for dir in &runtime.plugin_dirs {
        command.args(["--plugin-dir", dir]);
    }
    for url in &runtime.plugin_urls {
        command.args(["--plugin-url", url]);
    }
}
fn valid_text(s: &str, limit: usize) -> bool {
    !s.is_empty() && s.len() <= limit && s.trim() == s && !s.chars().any(char::is_control)
}
fn valid_id(s: &str) -> bool {
    valid_text(s, 200) && !s.starts_with('-')
}
fn absolute(s: &str) -> bool {
    valid_text(s, 4096)
        && (s.starts_with('/')
            || s.starts_with("\\\\")
            || (s.len() > 2
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.as_bytes()[1] == b':'
                && matches!(s.as_bytes()[2], b'/' | b'\\')))
}
fn public_zip(s: &str) -> bool {
    valid_text(s, 4096)
        && tauri::Url::parse(s).is_ok_and(|u| {
            u.scheme() == "https"
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
        })
}
impl Action {
    fn validate(&self, provider: &str) -> Result<(), String> {
        if !matches!(provider, "claude" | "codex") {
            return Err("Plugin management is unavailable for this agent".into());
        }
        match self {
            Self::Details { id }
            | Self::Install { id }
            | Self::Toggle { id, .. }
            | Self::Uninstall { id }
            | Self::Eval { id, .. }
                if !valid_id(id) =>
            {
                return Err("Invalid plugin identifier".into())
            }
            Self::Skill { path, .. } if provider != "codex" || !absolute(path) => {
                return Err("Skill toggles require a Codex skill path".into())
            }
            Self::Runtime {
                plugin_dirs,
                plugin_urls,
                skill_roots,
            } if [plugin_dirs.len(), plugin_urls.len(), skill_roots.len()]
                .iter()
                .any(|n| *n > 8)
                || !plugin_dirs.iter().chain(skill_roots).all(|s| absolute(s))
                || !plugin_urls.iter().all(|s| public_zip(s))
                || (provider == "codex"
                    && (!plugin_dirs.is_empty() || !plugin_urls.is_empty()))
                || (provider == "claude" && !skill_roots.is_empty()) =>
            {
                return Err("Invalid temporary plugin or skill directories".into());
            }
            _ => {}
        }
        if let Self::Eval {
            operation_id,
            max_cost_usd,
            trusted,
            ..
        } = self
        {
            if provider != "claude"
                || !trusted
                || !max_cost_usd.is_finite()
                || !(0.01..=100.0).contains(max_cost_usd)
                || uuid::Uuid::parse_str(operation_id).is_err()
            {
                return Err(
                    "Evaluation needs an explicit trust confirmation, operation ID and USD budget"
                        .into(),
                );
            }
        }
        if let Self::Cancel { operation_id } = self {
            uuid::Uuid::parse_str(operation_id).map_err(|_| "Invalid evaluation operation")?;
        }
        Ok(())
    }
}
fn bounded(v: &Value, key: &str, max: usize) -> String {
    v[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
fn claude_inventory(v: &Value) -> Result<Vec<PluginView>, String> {
    let rows = v
        .as_array()
        .ok_or("The CLI did not return an installed plugin list")?;
    if rows.len() > 200 {
        return Err("Plugin inventory exceeds the 200-plugin limit".into());
    }
    Ok(rows
        .iter()
        .filter(|p| p["id"].as_str().is_some_and(valid_id))
        .map(|p| PluginView {
            id: bounded(p, "id", 200),
            name: bounded(p, "id", 200),
            version: bounded(p, "version", 80),
            scope: bounded(p, "scope", 40),
            enabled: p["enabled"].as_bool(),
        })
        .collect())
}
fn codex_inventory(v: &Value) -> Result<Vec<PluginView>, String> {
    let markets = v["marketplaces"]
        .as_array()
        .ok_or("Plugin inventory is unavailable in this CLI version")?;
    if v["marketplaceLoadErrors"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        return Err("Some installed plugins could not be inspected. Check the selected CLI configuration and refresh.".into());
    }
    let mut rows = Vec::new();
    for market in markets {
        for p in market["plugins"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["installed"] == true)
        {
            if !p["id"].as_str().is_some_and(valid_id) {
                continue;
            }
            rows.push(PluginView {
                id: bounded(p, "id", 200),
                name: bounded(p, "name", 200),
                version: if p["localVersion"].is_string() {
                    bounded(p, "localVersion", 80)
                } else {
                    bounded(p, "version", 80)
                },
                scope: bounded(market, "name", 200),
                enabled: p["enabled"].as_bool(),
            });
            if rows.len() > 200 {
                return Err("Plugin inventory exceeds the 200-plugin limit".into());
            }
        }
    }
    Ok(rows)
}
pub(crate) async fn rpc(
    process: &mut Process,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = process.next_id;
    process.next_id += 1;
    process
        .stdin
        .write_all(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
        .await
        .map_err(|_| "Could not send plugin request")?;
    let result=tokio::time::timeout(Duration::from_secs(90),async {
        while let Some(line)=process.lines.recv().await {
            let Line::Out(line)=line else{continue};
            if line.len()>2_000_000 {return Err("Plugin response exceeded its limit".into());}
            let Ok(value)=serde_json::from_str::<Value>(&line) else{continue};
            if value["id"]==id && value.get("method").is_none() {
                return if value.get("error").is_some(){Err("The CLI rejected this action. Check plugin availability, policy and CLI version.".into())}else{Ok(value["result"].clone())};
            }
            if value.get("id").is_some() && value["method"].is_string() {
                process.stdin.write_all(format!("{}\n",json!({"id":value["id"],"error":{"code":-32601,"message":"Interactive requests are unavailable during plugin management"}})).as_bytes()).await.map_err(|_|"Plugin response failed")?;
            }
        }
        Err("The CLI exited without confirming the plugin request".into())
    }).await.map_err(|_|"Plugin request timed out; check the CLI before retrying")?;
    result
}
async fn codex_start(exe: &Executable, folder: &str, roots: &[String]) -> Result<Process, String> {
    let child = crate::mcp::command(exe, folder)
        .args(["app-server", "--stdio"])
        .spawn()
        .map_err(|_| "Could not start the selected CLI")?;
    let mut p = Process::new(exe.clone(), child, String::new(), String::new())?;
    let result=async {
        rpc(&mut p,"initialize",json!({"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        p.stdin.write_all(b"{\"method\":\"initialized\"}\n").await.map_err(|_|"Could not initialize plugins")?;
        if !roots.is_empty(){rpc(&mut p,"skills/extraRoots/set",json!({"extraRoots":roots})).await?;}
        Ok::<_,String>(())
    }.await;
    if let Err(e) = result {
        p.kill().await;
        return Err(e);
    }
    Ok(p)
}
async fn cli(
    exe: &Executable,
    folder: &str,
    args: Vec<String>,
    cancel: CancellationToken,
    seconds: u64,
) -> Result<(i32, String), String> {
    if cancel.is_cancelled() {
        return Err("Plugin operation cancelled".into());
    }
    let child = crate::mcp::command(exe, folder)
        .args(args)
        .env("NO_COLOR", "1")
        .env_remove("CLAUDECODE")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start the selected plugin command")?;
    let mut process = Process::new(exe.clone(), child, String::new(), String::new())?;
    process
        .stdin
        .shutdown()
        .await
        .map_err(|_| "Could not close plugin input")?;
    let work = async {
        let mut output = String::new();
        while let Some(line) = process.lines.recv().await {
            if let Line::Out(line) = line {
                if output.len() + line.len() > 2_000_000 {
                    return Err("Plugin output exceeded its limit".into());
                }
                output.push_str(&line);
                output.push('\n');
            }
        }
        let status = process
            .child
            .wait()
            .await
            .map_err(|_| "Plugin command did not exit")?;
        Ok((status.code().unwrap_or(-1), output))
    };
    let result = tokio::select! { _=cancel.cancelled()=>Err("Plugin evaluation cancelled".into()), result=tokio::time::timeout(Duration::from_secs(seconds),work)=>result.map_err(|_|"Plugin command timed out; check its state before retrying".to_string()).and_then(|r|r) };
    process.kill().await;
    result
}
fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}
fn selection(v: &Value, id: &str) -> Result<(Value, Value), String> {
    for m in v["marketplaces"].as_array().into_iter().flatten() {
        for p in m["plugins"].as_array().into_iter().flatten() {
            if p["id"] == id {
                if p["availability"] == "DISABLED_BY_ADMIN" || p["installPolicy"] == "NOT_AVAILABLE"
                {
                    return Err(
                        "This plugin is unavailable under the selected account's policy".into(),
                    );
                }
                return Ok((
                    json!({"pluginName":p["name"],"marketplacePath":m["path"],"remoteMarketplaceName":if m["path"].is_null(){m["name"].clone()}else{Value::Null}}),
                    p.clone(),
                ));
            }
        }
    }
    Err("Plugin was not found. Use its full plugin@source identifier and refresh.".into())
}
async fn codex_action(
    p: &mut Process,
    folder: &str,
    action: &Action,
    out: &mut ResultView,
) -> Result<(), String> {
    if let Action::Skill { path, enabled } = action {
        let list = rpc(
            p,
            "skills/list",
            json!({"cwds":[folder],"forceReload":true}),
        )
        .await?;
        if !list["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|g| g["cwd"] == folder)
            .flat_map(|g| g["skills"].as_array().into_iter().flatten())
            .any(|s| s["path"] == *path)
        {
            return Err("This skill is not in the selected CLI's current inventory".into());
        }
        rpc(
            p,
            "skills/config/write",
            json!({"path":path,"enabled":enabled}),
        )
        .await?;
        return Ok(());
    }
    if matches!(action, Action::Runtime { .. }) {
        rpc(
            p,
            "skills/extraRoots/set",
            json!({"extraRoots":out.runtime.skill_roots}),
        )
        .await?;
        return Ok(());
    }
    let inventory = rpc(p, "plugin/installed", json!({"cwds":[folder]})).await?;
    out.plugins = codex_inventory(&inventory)?;
    let id = match action {
        Action::List => return Ok(()),
        Action::Install { id }
        | Action::Toggle { id, .. }
        | Action::Uninstall { id }
        | Action::Details { id } => id,
        _ => return Err("Unsupported Codex plugin action".into()),
    };
    let catalog = if matches!(action, Action::Install { .. }) {
        rpc(
            p,
            "plugin/list",
            json!({"cwds":[folder],"forceRefetch":false}),
        )
        .await?
    } else {
        inventory
    };
    let (target, summary) = selection(&catalog, id)?;
    match action {
        Action::Install { .. } => {
            if summary["installed"] == true {
                return Err("Plugin is already installed".into());
            }
            if summary["mustShowInstallationInterstitial"] == true {
                return Err(
                    "This plugin requires installation through the Codex CLI's own consent flow"
                        .into(),
                );
            }
            rpc(p, "plugin/install", target).await?;
        }
        Action::Uninstall { .. } => {
            rpc(p, "plugin/uninstall", json!({"pluginId":id})).await?;
        }
        Action::Toggle { enabled, .. } => {
            rpc(p,"config/value/write",json!({"keyPath":format!("plugins.{}.enabled",serde_json::to_string(id).unwrap()),"value":enabled,"mergeStrategy":"replace"})).await?;
        }
        Action::Details { .. } => {
            let v = rpc(p, "plugin/read", target).await?;
            let d = &v["plugin"];
            let description = bounded(d, "description", 1200);
            if !description.is_empty() {
                out.details.push(description);
            }
            for (key, label) in [
                ("skills", "Skills"),
                ("hooks", "Hooks"),
                ("mcpServers", "MCP servers"),
                ("apps", "Apps"),
            ] {
                if let Some(a) = d[key].as_array() {
                    out.details.push(format!("{label}: {}", a.len()));
                }
            }
        }
        _ => {}
    }
    Ok(())
}
async fn claude_action(
    exe: &Executable,
    folder: &str,
    action: &Action,
    out: &mut ResultView,
    cancel: CancellationToken,
) -> Result<(), String> {
    if matches!(action, Action::Runtime { .. }) {
        return Ok(());
    }
    let (code, text) = cli(
        exe,
        folder,
        args(&["plugin", "list", "--json"]),
        cancel.clone(),
        30,
    )
    .await?;
    if code != 0 {
        return Err("The selected Claude CLI could not list plugins".into());
    }
    out.plugins = claude_inventory(
        &serde_json::from_str(&text).map_err(|_| "Unsupported Claude plugin list response")?,
    )?;
    let id = match action {
        Action::List => return Ok(()),
        Action::Install { id }
        | Action::Toggle { id, .. }
        | Action::Uninstall { id }
        | Action::Details { id }
        | Action::Eval { id, .. } => id,
        _ => return Err("Unsupported Claude plugin action".into()),
    };
    let installed = out.plugins.iter().find(|p| p.id == *id);
    if out.plugins.iter().filter(|p| p.id == *id).count() > 1 {
        return Err("This plugin exists in multiple scopes. Manage its scope in the CLI before changing it here.".into());
    }
    if matches!(action, Action::Install { .. }) {
        if installed.is_some() {
            return Err("Plugin is already installed".into());
        }
    } else if installed.is_none() {
        return Err("Plugin is no longer installed. Refresh the list.".into());
    }
    let plugin_scope = installed.map(|p| p.scope.as_str()).unwrap_or("user");
    if matches!(action, Action::Toggle { .. } | Action::Uninstall { .. })
        && !matches!(plugin_scope, "user" | "project" | "local")
    {
        return Err("This plugin is managed outside the selected CLI's editable scopes".into());
    }
    let command = match action {
        Action::Install { .. } => args(&["plugin", "install", id, "--scope", "user", "--json"]),
        Action::Toggle { enabled, .. } => args(&[
            "plugin",
            if *enabled { "enable" } else { "disable" },
            id,
            "--scope",
            plugin_scope,
            "--json",
        ]),
        Action::Uninstall { .. } => args(&["plugin", "uninstall", id, "--scope", plugin_scope]),
        Action::Details { .. } => args(&["plugin", "details", id]),
        Action::Eval { max_cost_usd, .. } => args(&[
            "plugin",
            "eval",
            id,
            "--trust-plugin",
            "--max-cost-usd",
            &max_cost_usd.to_string(),
            "--runs",
            "1",
            "--concurrency",
            "1",
            "--no-publish",
            "--no-scaffold",
            "--json",
        ]),
        _ => unreachable!(),
    };
    let result = cli(
        exe,
        folder,
        command,
        cancel,
        if matches!(action, Action::Eval { .. }) {
            600
        } else {
            90
        },
    )
    .await;
    let (code, text) = result?;
    if matches!(action, Action::Eval { .. }) {
        if !serde_json::from_str::<Value>(&text).is_ok_and(|v| v.is_object()) {
            return Err("The CLI did not return an evaluation result. Check its login and this plugin's eval suite.".into());
        }
        out.message = match code {
            0 => "Evaluation passed. The CLI saved its local report on the selected computer.",
            1 => "Evaluation finished with failing cases. Review the CLI's local report.",
            2 => "Evaluation stopped at its budget limit. Review the CLI's partial local report.",
            _ => {
                return Err(
                    "Evaluation failed. Check the selected CLI and plugin's eval suite.".into(),
                )
            }
        }
        .into();
    } else if code != 0 {
        return Err("The CLI rejected this plugin action. Check availability, policy and CLI version. Command-source installs must be reviewed in the CLI.".into());
    } else if matches!(action, Action::Details { .. }) {
        // Human details have no JSON mode. Only fixed inventory totals are admitted.
        for line in text.lines() {
            let line = line.trim();
            if [
                "Skills (",
                "Agents (",
                "Hooks (",
                "MCP servers (",
                "LSP servers (",
            ]
            .iter()
            .any(|p| line.starts_with(p))
            {
                if let Some(end) = line.find(')') {
                    let item = &line[..=end];
                    if item.len() < 80 {
                        out.details.push(item.into());
                    }
                }
            }
        }
        if out.details.is_empty() {
            out.details
                .push("This CLI did not report a recognized component inventory.".into());
        }
    }
    Ok(())
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
    if let Some(id) = &conversation_id {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid conversation")?;
    }
    crate::folders::validate_chat(&app, location.as_ref(), Some(&connection_id))?;
    let mut profile = crate::profiles::resolve(&app, &provider, Some(&connection_id))?;
    profile.folder_distribution = location
        .as_ref()
        .map(|l| crate::folders::environment_distribution(&app, &l.environment_id))
        .transpose()?
        .flatten();
    crate::profiles::scope(
        profile,
        manage_scoped(app, provider, conversation_id, location, action),
    )
    .await
}
async fn manage_scoped(
    app: tauri::AppHandle,
    provider: String,
    conversation_id: Option<String>,
    location: Option<ChatLocation>,
    action: Action,
) -> Result<ResultView, String> {
    let scope = key(conversation_id.as_deref());
    if let Action::Cancel { operation_id } = &action {
        let evaluations = EVALS
            .lock()
            .map_err(|_| "Evaluation registry unavailable")?;
        if let Some((owner, cancel)) = evaluations.get(operation_id) {
            if owner != &scope {
                return Err("Evaluation belongs to another selection".into());
            }
            cancel.cancel();
        }
        return Ok(ResultView {
            message: "Cancellation requested.".into(),
            ..Default::default()
        });
    }
    let _serial = MUTATION
        .try_lock()
        .map_err(|_| "Another plugin operation is running. Wait for it to finish.")?;
    let operation_id = if let Action::Eval { operation_id, .. } = &action {
        operation_id.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let cancel = CancellationToken::new();
    EVALS
        .lock()
        .map_err(|_| "Plugin registry unavailable")?
        .insert(operation_id.clone(), (scope.clone(), cancel.clone()));
    let _operation = Operation(operation_id);
    let mutation = !matches!(
        action,
        Action::List | Action::Details { .. } | Action::Eval { .. }
    );
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let _session_lock = if mutation {
        if let Some(id) = &conversation_id {
            let directory = root.join("native-sessions");
            std::fs::create_dir_all(&directory).map_err(|_| "Cannot lock native session")?;
            let file = File::options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(format!("{id}.lock")))
                .map_err(|_| "Cannot lock native session")?;
            file.try_lock()
                .map_err(|_| "Wait for this conversation's reply to finish")?;
            Some(file)
        } else {
            None
        }
    } else {
        None
    };
    let exe = crate::providers::resolve(&provider).await?;
    let folder = crate::mcp::folder(
        &app,
        &provider,
        &exe,
        location.as_ref(),
        conversation_id.as_deref(),
    )
    .await?;
    let mut out = ResultView {
        runtime: runtime(conversation_id.as_deref()),
        ..Default::default()
    };
    if let Action::Runtime {
        plugin_dirs,
        plugin_urls,
        skill_roots,
    } = &action
    {
        if conversation_id.is_none() {
            return Err(
                "Send a message before configuring temporary sources for this conversation".into(),
            );
        }
        out.runtime = Runtime {
            plugin_dirs: plugin_dirs.clone(),
            plugin_urls: plugin_urls.clone(),
            skill_roots: skill_roots.clone(),
            revision: out.runtime.revision,
        };
        let runtimes = RUNTIMES
            .lock()
            .map_err(|_| "Runtime registry unavailable")?;
        if runtimes.len() >= 64 && !runtimes.contains_key(&scope) {
            return Err(
                "Temporary source limit reached. Restart the host to clear temporary sources."
                    .into(),
            );
        }
    }
    let result = if provider == "codex" {
        let mut p = codex_start(&exe, &folder, &out.runtime.skill_roots).await?;
        let result = tokio::select! {_=cancel.cancelled()=>Err("Plugin operation cancelled".into()),result=codex_action(&mut p,&folder,&action,&mut out)=>result};
        p.kill().await;
        result
    } else {
        claude_action(&exe, &folder, &action, &mut out, cancel).await
    };
    // Also invalidate after uncertain writes: a timeout is not proof the write failed.
    if mutation {
        let mut revisions = REVISIONS
            .lock()
            .map_err(|_| "Plugin revisions unavailable")?;
        *revisions.entry(profile_key()).or_default() += 1;
    }
    result?;
    if matches!(action, Action::Runtime { .. }) {
        RUNTIMES
            .lock()
            .map_err(|_| "Runtime registry unavailable")?
            .insert(scope, out.runtime.clone());
    }
    if out.message.is_empty() {
        out.message=if mutation{"Saved. Changes apply when the next reply starts; other running replies keep their current setup."}else{"Installed plugins in the selected CLI profile."}.into();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn evaluation_keeps_arguments_structured_never_publishes_and_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fixture.mjs");
        std::fs::write(&script,r#"import fs from 'node:fs'; const a=process.argv.slice(2);
if(a[1]==='list') console.log(JSON.stringify([{id:'fixture@local',enabled:true,scope:'user'}]));
else { fs.writeFileSync('eval-args.json',JSON.stringify(a)); console.log('{}'); setInterval(()=>{},1000); }
"#).unwrap();
        let exe = Executable {
            provider: "claude".into(),
            program: "node".into(),
            prefix: vec![script.to_string_lossy().into_owned()],
            wsl: None,
        };
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let capture = dir.path().join("eval-args.json");
        let observed = capture.clone();
        let stopping = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !observed.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            stop.cancel();
        });
        let mut out = ResultView::default();
        let result = claude_action(
            &exe,
            dir.path().to_str().unwrap(),
            &Action::Eval {
                id: "fixture@local".into(),
                operation_id: uuid::Uuid::new_v4().to_string(),
                max_cost_usd: 0.25,
                trusted: true,
            },
            &mut out,
            cancel,
        )
        .await;
        stopping.await.unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        let args: Vec<String> = serde_json::from_slice(&std::fs::read(capture).unwrap()).unwrap();
        assert!(args.windows(2).any(|a| a == ["--max-cost-usd", "0.25"]));
        for flag in ["--no-publish", "--no-scaffold", "--trust-plugin"] {
            assert!(args.iter().any(|a| a == flag));
        }
        assert!(!args
            .iter()
            .any(|a| a == "--allow-real-servers" || a == "--allow-tools"));
    }
    #[tokio::test]
    #[ignore = "Opt-in installed CLI integration using disposable profiles and local plugins; no model replies"]
    async fn real_installed_cli_plugin_lifecycle() {
        let fixture = tempfile::tempdir().unwrap();
        let market = fixture.path().join("market");
        let plugin = market.join("demo");
        for directory in [".claude-plugin", ".agents/plugins"] {
            std::fs::create_dir_all(market.join(directory)).unwrap();
            std::fs::write(market.join(directory).join("marketplace.json"), json!({"name":"studio-fixture","owner":{"name":"Fixture"},"plugins":[{"name":"demo","source":"./demo","description":"Synthetic local plugin"}]}).to_string()).unwrap();
        }
        for directory in [".claude-plugin", ".codex-plugin"] {
            std::fs::create_dir_all(plugin.join(directory)).unwrap();
            std::fs::write(
                plugin.join(directory).join("plugin.json"),
                json!({"name":"demo","version":"1.0.0","description":"Synthetic local plugin"})
                    .to_string(),
            )
            .unwrap();
        }
        std::fs::create_dir_all(plugin.join("skills/fixture")).unwrap();
        std::fs::write(
            plugin.join("skills/fixture/SKILL.md"),
            "---\nname: fixture\ndescription: Synthetic fixture\n---\nNo actions required.\n",
        )
        .unwrap();
        let project = fixture.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        for provider in ["claude", "codex"] {
            let config = fixture.path().join(provider);
            std::fs::create_dir_all(&config).unwrap();
            let profile = crate::profiles::Profile {
                id: uuid::Uuid::new_v4().to_string(),
                provider: provider.into(),
                root: Some(config),
                namespace: "plugin-tests".into(),
                isolated: true,
                ..Default::default()
            };
            crate::profiles::scope(profile,async {
                let exe=crate::providers::resolve(provider).await.unwrap();
                let folder=project.to_str().unwrap();
                let id="demo@studio-fixture".to_string();
                let mut out=ResultView::default();
                if provider=="claude" {
                    let (code,_)=cli(&exe,folder,args(&["plugin","marketplace","add",market.to_str().unwrap()]),CancellationToken::new(),30).await.unwrap();
                    assert_eq!(code,0,"Claude local fixture registration");
                    for action in [Action::Install{id:id.clone()},Action::Details{id:id.clone()},Action::Toggle{id:id.clone(),enabled:false},Action::List,Action::Toggle{id:id.clone(),enabled:true},Action::Uninstall{id:id.clone()}] {
                        claude_action(&exe,folder,&action,&mut out,CancellationToken::new()).await.unwrap();
                        if matches!(action,Action::List){assert_eq!(out.plugins.iter().find(|p|p.id==id).unwrap().enabled,Some(false));}
                    }
                    claude_action(&exe,folder,&Action::List,&mut out,CancellationToken::new()).await.unwrap();
                    assert!(out.plugins.is_empty());
                } else {
                    let mut process=codex_start(&exe,folder,&[]).await.unwrap();
                    let result=async {
                        rpc(&mut process,"marketplace/add",json!({"source":market.to_str().unwrap()})).await?;
                        for action in [Action::Install{id:id.clone()},Action::Details{id:id.clone()},Action::Toggle{id:id.clone(),enabled:false},Action::List,Action::Toggle{id:id.clone(),enabled:true}] {
                            codex_action(&mut process,folder,&action,&mut out).await?;
                            if matches!(action,Action::List){assert_eq!(out.plugins.iter().find(|p|p.id==id).unwrap().enabled,Some(false));}
                        }
                        let roots=fixture.path().join("extras");std::fs::create_dir_all(roots.join("extra")).unwrap();
                        let skill=roots.join("extra/SKILL.md");std::fs::write(&skill,"---\nname: extra\ndescription: Synthetic additional root\n---\nFixture only.\n").unwrap();
                        out.runtime.skill_roots=vec![roots.to_string_lossy().into_owned()];
                        codex_action(&mut process,folder,&Action::Runtime{plugin_dirs:vec![],plugin_urls:vec![],skill_roots:out.runtime.skill_roots.clone()},&mut out).await?;
                        let catalog=rpc(&mut process,"skills/list",json!({"cwds":[folder],"forceReload":true})).await?;
                        let reported=catalog["data"].as_array().into_iter().flatten().flat_map(|g|g["skills"].as_array().into_iter().flatten()).find(|s|s["name"]=="extra").and_then(|s|s["path"].as_str()).ok_or("Extra root fixture not discovered")?;
                        for enabled in [false,true] { codex_action(&mut process,folder,&Action::Skill{path:reported.into(),enabled},&mut out).await?; }
                        codex_action(&mut process,folder,&Action::Uninstall{id:id.clone()},&mut out).await?;
                        codex_action(&mut process,folder,&Action::List,&mut out).await?;
                        assert!(out.plugins.is_empty());
                        Ok::<(),String>(())
                    }.await;
                    process.kill().await; result.unwrap();
                }
            }).await;
        }
    }
    #[test]
    fn validates_mutations_and_public_sources() {
        for id in ["--all", "", "bad\nname"] {
            assert!(Action::Install { id: id.into() }
                .validate("claude")
                .is_err());
        }
        assert!(Action::Skill {
            path: "/skills/demo/SKILL.md".into(),
            enabled: false
        }
        .validate("claude")
        .is_err());
        for url in [
            "http://example.com/a.zip",
            "https://user:secret@example.com/a.zip",
            "https://example.com/a.zip?token=secret",
        ] {
            assert!(!public_zip(url));
        }
        assert!(public_zip("https://example.com/a.zip"));
        assert!(!absolute("relative/SKILL.md"));
        assert!(absolute("C:\\skills\\demo"));
    }
    #[test]
    fn inventory_is_bounded_metadata_and_preserves_unknown() {
        let list =
            claude_inventory(&json!([{"id":"demo@local","scope":"user","credential":"secret"}]))
                .unwrap();
        assert!(list[0].enabled.is_none());
        assert!(!serde_json::to_string(&list).unwrap().contains("secret"));
        let v = json!({"marketplaces":[{"name":"local","plugins":[{"id":"demo@local","name":"Demo","installed":true,"enabled":false},{"id":"other@local","installed":false}]}]});
        let list = codex_inventory(&v).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].enabled, Some(false));
    }
}
