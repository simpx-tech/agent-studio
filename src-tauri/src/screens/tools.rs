//! The tools a chat saves, lists and reads this computer's screens with, and reaches the MCP
//! servers of this computer's places with: SDK tools of Claude's agent_studio server and Codex
//! dynamic tools. Only the conversation's own call reaches them: Claude's registered parent tool
//! use, Codex's parent thread without a namespace. A screen is made where the conversation that
//! created it runs, and calls MCP tools first as that conversation's account, which the host
//! decides, never the call.
use super::places::{self, Candidate};
use super::{Account, Card, Screen, Site};
use crate::protocol::RunEvent;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

pub const SAVE: &str = "save_screen";
pub const LIST: &str = "list_screens";
pub const READ: &str = "read_screen";
pub const SERVERS: &str = "list_mcp_tools";
pub const CALL: &str = "call_mcp_tool";
const NAMES: [&str; 5] = [SAVE, LIST, READ, SERVERS, CALL];

/// The owner chats' MCP calls share their CLIs under (`mcp::Calls`).
const CHATS: &str = "chats";

pub const GUIDANCE: &str = "For a page the user keeps and reopens in Agent Studio, such as a dashboard, a tracker, a report to revisit or a small tool with its own interface, commands and MCP tool calls, call save_screen (Claude: mcp__agent_studio__save_screen): it saves a screen on this computer, listed under Screens in the sidebar apart from this chat. Before updating a screen by its id, find it with list_screens and open it with read_screen (Claude: mcp__agent_studio__list_screens, mcp__agent_studio__read_screen). list_mcp_tools and call_mcp_tool reach the MCP servers of this computer's other places as screens call them, such as the servers signed in inside its WSL distribution (Claude: mcp__agent_studio__list_mcp_tools, mcp__agent_studio__call_mcp_tool). Use visualize for a visual that belongs only in this reply.";

const SAVE_DESCRIPTION: &str = "Save a screen: a lasting page in Agent Studio with its own interface (HTML, CSS and JavaScript) that runs commands and calls MCP tools on this computer, on Windows and in its WSL distributions alike. The user reopens saved screens from Screens in the Agent Studio sidebar, apart from this conversation, so build one when the user asks for a dashboard, a tracker, a report to revisit or a small tool. Omit id to create a screen; to change one, pass its id and send the complete screen again. Nothing asks the user for permission: the page runs its actions, commands and tools as soon as it asks.

html: one self-contained page (a fragment or a whole document) with inline CSS and JavaScript. It fills the window's main area and scrolls by itself, on a transparent background in the app's font at 14px. Style it with the host's CSS variables --foreground, --heading, --muted-foreground, --card, --border, --primary, --primary-foreground and --viz-series-1 to --viz-series-6 so it matches the light and dark themes, which can change while the page is open (the studio-theme event on window). The page has no network access: remote scripts, styles, fonts, images and fetch are blocked, so its data comes from actions, commands and MCP tools. Its script reaches Agent Studio through the global studio object:
- await studio.run(name, params, {onOutput, signal}) runs one action with an object of parameter values and resolves to {exitCode, stdout, stderr, timedOut, stopped, durationMs, job}; onOutput(text, stream) receives its output as it arrives (stream is 'stdout' or 'stderr'), and aborting signal stops it. It rejects when the action cannot run at all; show that message in the page.
- await studio.json(name, params, options) runs an action and returns its stdout parsed as JSON, rejecting with its stderr when it exits with a code other than 0.
- await studio.exec(script, {shell, where, params, timeout, onOutput, signal}) runs a script the page writes, as an action runs (shell 'powershell' or 'bash'; params reach it as PARAM_<NAME> variables), and resolves like run.
- await studio.start(name, params), or studio.start({script, shell, where, params, timeout}) for a command, starts a job that goes on while the screen is closed and keeps its output until studio.forget(id); it resolves to the job {id, action, label, params, state ('running', 'done', 'stopped', 'interrupted' or 'failed'), exitCode, timedOut, startedAt, endedAt, durationMs, error}.
- await studio.jobs() lists the screen's jobs, the newest first: those it started, and runs whose page closed before they ended. await studio.follow(id, {onOutput}) replays a job's output from its start, follows it as it arrives and resolves like run once the job ended; await studio.stop(id) stops a running job with everything it started; await studio.forget(id) removes one.
- await studio.mcp(server, tool, args, {where, account}) calls any MCP tool of the servers an account has where it is called, and resolves to {content, structuredContent, text, account}: the tool's content blocks as its server returned them (text, images as base64 data, resources), its structured result when it has one, its text blocks joined, and the account that answered. It rejects with the tool's own error, or when no account there has the server connected; show that message in the page.
- await studio.mcpJson(server, tool, args, options) calls a tool and returns its structured result, or else its text parsed as JSON.
- await studio.mcpServers({where, account}) lists the servers an account has there, each {name, status, tools}.
- await studio.ask(prompt, {model, system, json}) asks a model as this screen's account, without tools, and resolves to its text, or with json: true to that text parsed as JSON. model names one, such as 'sonnet'; otherwise the provider's small model answers.
- await studio.load(key) and await studio.save(key, value) keep JSON values for this screen on this computer, for preferences, state and data the screen owns; save(key, null) removes one. studio.values holds every value saved when the page opened.
- await studio.copy(text) puts text on the clipboard, and await studio.open(url) opens an http or https link in the browser.
- await studio.chat(text, {send}) opens a new conversation in this screen's folder with the text in its message box, and sends it with send: true.
- studio.theme is 'dark' or 'light'; studio.screen holds its id and title.
The user leaves the screen and comes back, quits the app and opens it again, or opens the screen on another device, and the page must never lose what it showed: keep its state with studio.save as it changes and restore it from studio.values when it opens; run long or important work (builds, deployments, syncs) with studio.start rather than run, and when the page opens call studio.jobs() to show the latest of each and studio.follow the ones still running. Write command output and tool results into the page as text (textContent or text nodes), never as HTML, since they can hold anything. Show loading, empty and error states, and run actions when the page opens and when the user asks (buttons, filters), never in tight loops.

where: an action, a command or an MCP call runs where this conversation runs unless it names another place of this computer: 'windows' (this Windows computer itself), 'wsl' (its WSL distribution) or a WSL distribution's name, such as 'Ubuntu'. Elsewhere a command starts in the same folder as that place reaches it (C:\\work is /mnt/c/work in WSL), or in its home folder.

actions: the commands the page runs by name, each {name, description, shell, script, params, timeout, where}. name is lowercase letters, digits and _. shell is 'powershell' on Windows (pwsh when installed, otherwise Windows PowerShell 5.1, so write for both) or 'bash' (Git Bash on Windows, bash in WSL, Linux and macOS). The script runs in this conversation's working folder, or where it names, bash in a login shell, with stdin closed, until it ends; set timeout to a number of seconds to stop it after that long, and whatever it started ends with it. It succeeds with exit code 0, and a PowerShell script ends with its own exit code or that of the last program it ran. params declares the values the page passes, as {name: {type: 'string' | 'number' | 'integer' | 'boolean', description, enum, pattern, maxLength, minimum, maximum, optional}}, which the host checks before the script runs; a value the action does not declare passes as it is, as JSON when it is not text. Each value reaches the script only as the environment variable PARAM_<NAME> (since becomes PARAM_SINCE), never inside the script's text: quote it as \"$PARAM_SINCE\" in bash, use $env:PARAM_SINCE in PowerShell, and never pass it to eval or Invoke-Expression. Print JSON for studio.json (gh --json, ConvertTo-Json -Depth 6 -Compress, jq). Test each script with your own shell tool first, in its folder and with its PARAM_ variables set.

mcpTools: the MCP tools the page calls, each {server, tool, description, where, account}, named as a tool list names them: mcp__linear__list_issues is {\"server\":\"linear\",\"tool\":\"list_issues\"}. A declaration says what the page uses a tool for, and where and as which account (by the name Connections gives it) studio.mcp calls it unless the call names its own. The screen calls tools through the CLI of an account in that place, with the servers and sign-ins it has there: where this conversation runs, its account first; elsewhere, that place's CLI login first; then each other account there until one has the server connected. No model takes part, and a call's result goes to the page alone. Call each tool first, with your own tools or with call_mcp_tool for another place, to see the arguments it takes and what it returns, and list_mcp_tools to see the servers and tools a place has. Prefer an MCP tool to a script doing the same through a command line, and a server already signed in somewhere on this computer, such as Linear in WSL, to asking the user for keys.";

const LIST_DESCRIPTION: &str = "List the screens this computer keeps: id, title, description, the folder their actions run in, their actions and MCP tools with the account that calls those first, how many of their jobs run, and whether this conversation can update the screen. Call it before reading or updating a screen.";

const READ_DESCRIPTION: &str = "Read one saved screen whole: its title, description, html, actions, MCP tools with the account that calls them first, the values it saved with studio.save and its jobs, to change it and save it again with save_screen and the same id.";

const SERVERS_DESCRIPTION: &str = "List the MCP servers an account has in a place of this computer, each with its state and tools (Codex reports each tool's description and input schema, Claude Code its name), as a screen's studio.mcp reaches them. where is 'windows', 'wsl' or a WSL distribution's name; omit it for where this conversation runs. account names the account to ask, by the name Connections gives it; otherwise the account a screen would call first answers. The result names that account and the others there.";

const CALL_DESCRIPTION: &str = "Call an MCP tool in a place of this computer as a screen's studio.mcp calls it, through the CLI of an account there, and return the tool's result: try the tools of servers this conversation does not have, such as those signed in inside WSL, before a screen calls them. where and account as in list_mcp_tools; an account that does not have the server connected gives way to the next one there, and the result names the account that answered.";

pub fn tools() -> Vec<Value> {
    let place = json!({"type":"string","description":"windows, wsl or a WSL distribution's name. Omit it to run where this conversation runs."});
    vec![
        json!({"name":SAVE,"description":SAVE_DESCRIPTION,"inputSchema":{
            "type":"object","properties":{
                "id":{"type":"string","description":"The id of the screen to replace, from save_screen or list_screens. Omit it to create a screen."},
                "title":{"type":"string","minLength":1},
                "description":{"type":"string","description":"One line the Screens list shows."},
                "html":{"type":"string","minLength":1,"description":"The complete page, with inline CSS and JavaScript."},
                "actions":{"type":"array","items":{
                    "type":"object","properties":{
                        "name":{"type":"string","pattern":"^[a-z][a-z0-9_]*$"},
                        "description":{"type":"string"},
                        "shell":{"type":"string","enum":["powershell","bash"]},
                        "script":{"type":"string","minLength":1},
                        "params":{"type":"object","description":"Each value the page passes, by name.","additionalProperties":{
                            "type":"object","properties":{
                                "type":{"type":"string","enum":["string","number","integer","boolean"]},
                                "description":{"type":"string"},
                                "enum":{"type":"array","minItems":1},
                                "pattern":{"type":"string"},
                                "maxLength":{"type":"integer","minimum":0},
                                "minimum":{"type":"number"},
                                "maximum":{"type":"number"},
                                "optional":{"type":"boolean"}
                            },"required":["type"],"additionalProperties":false}},
                        "timeout":{"type":"integer","minimum":1,"description":"Seconds the script may run before it is stopped. Omit it to let the script run until it ends."},
                        "where":place
                    },"required":["name","shell","script"],"additionalProperties":false}},
                "mcpTools":{"type":"array","description":"The MCP tools the page calls with studio.mcp.","items":{
                    "type":"object","properties":{
                        "server":{"type":"string","minLength":1,"description":"The MCP server's name: linear in mcp__linear__list_issues."},
                        "tool":{"type":"string","minLength":1,"description":"The tool's name: list_issues in mcp__linear__list_issues."},
                        "description":{"type":"string","description":"What the page uses it for."},
                        "where":place,
                        "account":{"type":"string","description":"The account to call it as first, by the name Connections gives it."}
                    },"required":["server","tool"],"additionalProperties":false}}
            },"required":["title","html"],"additionalProperties":false}}),
        json!({"name":LIST,"description":LIST_DESCRIPTION,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":READ,"description":READ_DESCRIPTION,"inputSchema":{
            "type":"object","properties":{"id":{"type":"string","description":"A screen id from list_screens."}},
            "required":["id"],"additionalProperties":false}}),
        json!({"name":SERVERS,"description":SERVERS_DESCRIPTION,"inputSchema":{
            "type":"object","properties":{
                "where":place,
                "account":{"type":"string","description":"The account to ask, by the name Connections gives it."}
            },"additionalProperties":false}}),
        json!({"name":CALL,"description":CALL_DESCRIPTION,"inputSchema":{
            "type":"object","properties":{
                "server":{"type":"string","minLength":1,"description":"The MCP server's name, as list_mcp_tools names it."},
                "tool":{"type":"string","minLength":1},
                "arguments":{"type":"object","description":"The tool's arguments."},
                "where":place,
                "account":{"type":"string","description":"The account to call it as first, by the name Connections gives it."}
            },"required":["server","tool"],"additionalProperties":false}}),
    ]
}
pub fn codex_tools() -> Vec<Value> {
    tools()
        .into_iter()
        .map(|mut tool| {
            tool["type"] = json!("function");
            tool["deferLoading"] = json!(false);
            tool
        })
        .collect()
}

/// The conversation whose reply calls the tools, and what decides where its screens run. It
/// keeps this computer's app data folder rather than the app itself, so the tools stay plain;
/// `launch` starts the CLIs its MCP calls go through.
pub struct Context {
    data: PathBuf,
    screens: Arc<super::Screens>,
    launch: Arc<dyn super::mcp::Launch>,
    conversation_id: String,
    run_id: String,
    provider: String,
    connection_id: Option<String>,
    location: Option<crate::folders::ChatLocation>,
}
impl Context {
    /// Screens belong to a saved Claude or Codex conversation with tools.
    pub fn new(
        app: &tauri::AppHandle,
        request: &crate::providers::RunRequest,
        connection_id: Option<&str>,
    ) -> Option<Self> {
        let conversation_id = request.conversation_id.clone()?;
        if !request.tools_enabled()
            || !matches!(request.agent.provider.as_str(), "claude" | "codex")
        {
            return None;
        }
        Some(Self {
            data: app.path().app_local_data_dir().ok()?,
            screens: app.try_state::<Arc<super::Screens>>()?.inner().clone(),
            launch: Arc::new(super::mcp::Host(app.clone())),
            conversation_id,
            run_id: request.run_id.clone(),
            provider: request.agent.provider.clone(),
            connection_id: connection_id.map(String::from),
            location: request.location.clone(),
        })
    }
    /// A conversation of a test, keeping its screens in `data` on this computer.
    #[cfg(test)]
    pub fn for_test(
        data: PathBuf,
        screens: Arc<super::Screens>,
        request: &crate::providers::RunRequest,
    ) -> Self {
        Self {
            data,
            screens,
            launch: Arc::new(super::mcp::Unlaunched),
            conversation_id: request.conversation_id.clone().expect("a conversation"),
            run_id: request.run_id.clone(),
            provider: request.agent.provider.clone(),
            connection_id: None,
            location: request.location.clone(),
        }
    }
    /// The computers, accounts and connections of the saved workspace. A conversation without a
    /// connection replies with this computer's own CLI login and does without them.
    async fn fleet(&self) -> Result<Value, String> {
        let root = self.data.clone();
        let fleet = tauri::async_runtime::spawn_blocking(move || {
            crate::saved::fleet(
                &root,
                "Save the workspace before saving a screen",
                "Cannot read this conversation's connection",
            )
        })
        .await
        .map_err(|_| "Cannot read this conversation's connection".to_string())?;
        match self.connection_id {
            Some(_) => fleet,
            None => Ok(fleet.unwrap_or(Value::Null)),
        }
    }
    /// The execution environment of the conversation's account: this computer, or the WSL
    /// distribution its connection belongs to.
    fn environment(&self, fleet: &Value) -> Result<String, String> {
        let local = crate::profiles::installation_in(&self.data)?;
        let Some(connection) = &self.connection_id else {
            return Ok(local.id);
        };
        connection_environment(fleet, connection)
            .ok_or_else(|| "This conversation's connection no longer exists.".to_string())
    }
    /// The account this conversation replies with, which calls a screen's MCP tools first.
    fn account(&self) -> Account {
        Account {
            provider: self.provider.clone(),
            connection_id: self.connection_id.clone(),
        }
    }
    /// Where the conversation's commands run now: its folder, as its CLI works in it.
    async fn site(&self, fleet: &Value) -> Result<Site, String> {
        let environment_id = self.environment(fleet)?;
        let profile = crate::profiles::current();
        let folder = crate::mcp::working_folder_in(
            &self.data,
            &self.provider,
            profile.distribution.as_deref(),
            self.location.as_ref(),
            Some(&self.conversation_id),
        )
        .await?;
        Ok(Site {
            environment_id,
            distribution: profile.distribution,
            folder,
            project: self
                .location
                .as_ref()
                .map(|location| location.path.clone())
                .unwrap_or_default(),
        })
    }
}

/// One reply's calls of the screen tools.
#[derive(Default)]
pub struct Agent {
    /// The parent assistant's calls, by Claude's tool use id, with their tool and input.
    pending: HashMap<String, (String, Value)>,
    /// Screens saved by calls whose results have not arrived yet.
    accepted: HashMap<String, Card>,
    saved: bool,
}

fn connection_environment(fleet: &Value, connection: &str) -> Option<String> {
    fleet["connections"]
        .as_array()?
        .iter()
        .find(|c| c["id"] == connection)?["environmentId"]
        .as_str()
        .map(String::from)
}

fn card(screen: &Screen) -> Card {
    Card {
        id: screen.id.clone(),
        revision: screen.revision,
        title: screen.title.clone(),
        environment_id: screen.site.environment_id.clone(),
    }
}

/// What the model hears once a screen is saved. `caller` names the account the screen calls
/// its MCP tools as first when that is not the saving conversation's own.
fn saved_text(screen: &Screen, caller: Option<&str>) -> String {
    let (actions, tools) = (screen.actions.len(), screen.mcp_tools.len());
    let runs = match actions {
        0 => String::new(),
        1 => format!(
            " Its action runs in {} unless it names another place.",
            screen.site.folder
        ),
        _ => format!(
            " Its {actions} actions run in {} unless they name another place.",
            screen.site.folder
        ),
    };
    let caller = match caller {
        Some(name) if tools > 0 => format!(
            " It calls MCP tools first as {name}, the account it was created with, not this conversation's account."
        ),
        _ => String::new(),
    };
    format!(
        "Saved the screen \"{}\" (id {}, revision {}). The user opens it from Screens in Agent Studio's sidebar, and this reply shows a card that opens it; a page already open loads this revision.{runs}{caller} Nothing waits for the user to allow it. To change it later, call save_screen with this id and the complete screen.",
        screen.title, screen.id, screen.revision
    )
}

async fn save(context: &Context, args: &Value) -> Result<(String, Card), String> {
    let definition = super::definition(args)?;
    let fleet = context.fleet().await?;
    let site = context.site(&fleet).await?;
    for action in &definition.actions {
        let place = context
            .screens
            .place(&context.data, &site, action.place.as_deref())
            .await
            .map_err(|error| format!("Action {}: {error}", action.name))?;
        super::run::available(&place, action.shell)
            .map_err(|error| format!("Action {}: {error}", action.name))?;
    }
    let root = context.data.join("screens");
    // A screen keeps its account while that account stays connected where it runs.
    let usable = {
        let (fleet, environment, distribution) = (
            fleet.clone(),
            site.environment_id.clone(),
            site.distribution.clone(),
        );
        move |account: &Account| match &account.connection_id {
            Some(connection) => {
                connection_environment(&fleet, connection).as_deref() == Some(environment.as_str())
            }
            None => distribution.is_none(),
        }
    };
    let ours = context.account();
    let (screen, _) = super::saved(
        &context.screens,
        root,
        definition,
        site,
        Some(ours.clone()),
        usable,
        context.conversation_id.clone(),
        context.run_id.clone(),
    )
    .await?;
    let caller = screen
        .account
        .as_ref()
        .filter(|account| **account != ours)
        .map(|account| places::account_name(&fleet, account));
    Ok((saved_text(&screen, caller.as_deref()), card(&screen)))
}

async fn list(context: &Context, args: &Value) -> Result<String, String> {
    if !(args.is_null() || args.as_object().is_some_and(|o| o.is_empty())) {
        return Err("list_screens takes no arguments.".into());
    }
    let fleet = context.fleet().await?;
    let environment = context.environment(&fleet)?;
    let screens = super::listed(context.data.join("screens")).await?;
    if screens.is_empty() {
        return Ok("This computer keeps no screens yet. Create one with save_screen.".into());
    }
    let entries: Vec<Value> = screens
        .iter()
        .map(|screen| {
            let mut entry = json!({
                "id": screen.id,
                "title": screen.title,
                "description": screen.description,
                "folder": screen.site.folder,
                "revision": screen.revision,
                "updatedAt": screen.updated_at,
                "actions": screen.actions.iter().map(|a| json!({"name": a.name, "description": a.description, "where": a.place})).collect::<Vec<_>>(),
                "runningJobs": context.screens.jobs.running_for(&screen.id),
                "updatableHere": screen.site.environment_id == environment,
            });
            if !screen.mcp_tools.is_empty() {
                entry["mcpTools"] = json!(screen.mcp_tools);
            }
            entry["mcpAccount"] = json!(callers(&fleet, screen));
            entry
        })
        .collect();
    serde_json::to_string_pretty(&json!({ "screens": entries }))
        .map_err(|_| "Cannot list screens".into())
}

async fn read(context: &Context, args: &Value) -> Result<String, String> {
    let id = args
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| super::valid_id(id))
        .ok_or("Send the id of a screen from list_screens, and nothing else.")?;
    let (screen, values) = super::opened(context.data.join("screens"), id.into())
        .await
        .map_err(|error| {
            if error == super::MISSING {
                format!("No screen with id {id} is kept on this computer. Call list_screens.")
            } else {
                error
            }
        })?;
    let root = context.data.join("screens");
    let jobs = context.screens.jobs.list(&root, &screen.id).await?;
    let fleet = context.fleet().await?;
    serde_json::to_string_pretty(&json!({
        "id": screen.id,
        "title": screen.title,
        "description": screen.description,
        "revision": screen.revision,
        "folder": screen.site.folder,
        "html": screen.html,
        "actions": screen.actions,
        "mcpTools": screen.mcp_tools,
        "mcpAccount": callers(&fleet, &screen),
        "savedValues": values,
        "jobs": jobs,
    }))
    .map_err(|_| "Cannot read this screen".into())
}

/// Who a screen calls its MCP tools as first, for the model.
fn callers(fleet: &Value, screen: &Screen) -> String {
    match &screen.account {
        Some(account) => places::account_name(fleet, account),
        None => "the account of the next chat that saves it".into(),
    }
}

/// The place and account a call of the MCP tools names, checked.
fn reach(args: &Map<String, Value>) -> Result<(Option<String>, Option<String>), String> {
    let place = super::named_place(args.get("where"))?;
    let account = Some(super::line(args.get("account"), "account", false)?)
        .filter(|account| !account.is_empty());
    Ok((place, account))
}

/// Where a chat's MCP call goes, and the accounts that may answer it there.
async fn reached(
    context: &Context,
    place: Option<&str>,
    account: Option<String>,
) -> Result<(Site, Vec<Candidate>), String> {
    let fleet = context.fleet().await?;
    let own = context.site(&fleet).await?;
    let site = context.screens.place(&context.data, &own, place).await?;
    let local = crate::profiles::installation_in(&context.data)?.id;
    let candidates = places::candidates(
        &fleet,
        &local,
        &site,
        Some(&context.account()),
        site == own,
        account.as_deref(),
    );
    Ok((site, candidates))
}

async fn servers(context: &Context, args: &Value) -> Result<String, String> {
    let empty = Map::new();
    let object = match args {
        Value::Null => &empty,
        Value::Object(object) => object,
        _ => return Err("Send where and account, or nothing.".into()),
    };
    super::unexpected(object, &["where", "account"])?;
    let (place, account) = reach(object)?;
    let (site, candidates) = reached(context, place.as_deref(), account).await?;
    let names: Vec<String> = candidates.iter().map(|c| c.name.clone()).collect();
    let (asked, servers) = context
        .screens
        .calls
        .servers(CHATS, &site, candidates, &*context.launch)
        .await?;
    serde_json::to_string_pretty(&json!({
        "where": place,
        "folder": site.folder,
        "account": asked.name,
        "otherAccounts": names.into_iter().filter(|name| *name != asked.name).collect::<Vec<_>>(),
        "servers": servers,
    }))
    .map_err(|_| "Cannot list these MCP servers".into())
}

async fn call(context: &Context, args: &Value) -> Result<String, String> {
    let object = args
        .as_object()
        .ok_or("Send server, tool and arguments, with where and account when needed.")?;
    super::unexpected(object, &["server", "tool", "arguments", "where", "account"])?;
    let server = super::tool_name(object.get("server"), "server")?;
    let tool = super::tool_name(object.get("tool"), "tool")?;
    if server == "agent_studio" {
        return Err("agent_studio's tools are yours to call directly.".into());
    }
    let arguments = match object.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        Some(_) => return Err("arguments must be an object of the tool's arguments.".into()),
    };
    let (place, account) = reach(object)?;
    let (site, candidates) = reached(context, place.as_deref(), account.clone()).await?;
    let (result, answered) = context
        .screens
        .calls
        .call(
            CHATS,
            &site,
            account.is_some(),
            async move { Ok(candidates) },
            &*context.launch,
            &server,
            &tool,
            arguments,
        )
        .await?;
    let mut result = result;
    result["account"] = json!(answered);
    serde_json::to_string_pretty(&result).map_err(|_| "Cannot read this tool's result".into())
}

impl Agent {
    /// Whether this reply saved a screen, so a screen alone completes it.
    pub fn has_screens(&self) -> bool {
        self.saved
    }

    async fn answer(
        &self,
        name: &str,
        args: &Value,
        context: Option<&Context>,
    ) -> Result<(String, Option<Card>), String> {
        let context = context
            .ok_or("Screens are available in saved Claude and Codex conversations with tools.")?;
        match name {
            SAVE => save(context, args)
                .await
                .map(|(text, card)| (text, Some(card))),
            LIST => list(context, args).await.map(|text| (text, None)),
            SERVERS => servers(context, args).await.map(|text| (text, None)),
            CALL => call(context, args).await.map(|text| (text, None)),
            _ => read(context, args).await.map(|text| (text, None)),
        }
    }

    /// Claude reports the parent's tool calls before the SDK asks this server to run them, and
    /// their results when they end. A saved screen's card follows its successful result.
    pub fn observe_claude(&mut self, value: &Value) -> Vec<RunEvent> {
        let mut events = vec![];
        if !value["parent_tool_use_id"].is_null() {
            return events;
        }
        let Some(blocks) = value["message"]["content"].as_array() else {
            return events;
        };
        for block in blocks {
            if value["type"] == "assistant" && block["type"] == "tool_use" {
                let tool = block["name"]
                    .as_str()
                    .and_then(|name| name.strip_prefix("mcp__agent_studio__"))
                    .filter(|name| NAMES.contains(name));
                if let (Some(tool), Some(id)) = (tool, block["id"].as_str()) {
                    self.pending
                        .insert(id.into(), (tool.into(), block["input"].clone()));
                }
            }
            if value["type"] == "user" && block["type"] == "tool_result" {
                if let Some(id) = block["tool_use_id"].as_str() {
                    self.pending.remove(id);
                    if let Some(card) = self.accepted.remove(id) {
                        if block["is_error"] != true {
                            self.saved = true;
                            events.push(RunEvent::Screen { screen: card });
                        }
                    }
                }
            }
        }
        events
    }

    /// A Claude SDK call of a screen tool. Other requests are left to their own handlers.
    pub async fn claude(&mut self, value: &Value, context: Option<&Context>) -> Option<Value> {
        let r = &value["request"];
        let m = &r["message"];
        if r["subtype"] != "mcp_message"
            || r["server_name"] != "agent_studio"
            || m["method"] != "tools/call"
        {
            return None;
        }
        let name = m["params"]["name"]
            .as_str()
            .filter(|name| NAMES.contains(name))?;
        let args = &m["params"]["arguments"];
        let call = self
            .pending
            .iter()
            .find(|(id, (tool, input))| {
                tool == name && input == args && !self.accepted.contains_key(*id)
            })
            .map(|(id, _)| id.clone());
        let result = match call {
            Some(call) => {
                let answer = self.answer(name, args, context).await;
                if let Ok((_, Some(card))) = &answer {
                    self.accepted.insert(call, card.clone());
                }
                answer.map(|(text, _)| text)
            }
            None => Err(format!(
                "Only a registered parent-conversation {name} call reaches this computer's screens."
            )),
        };
        let (text, error) = match result {
            Ok(text) => (text, false),
            Err(error) => (error, true),
        };
        Some(
            json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"mcp_response":{
                "jsonrpc":"2.0","id":m["id"],"result":{"isError":error,"content":[{"type":"text","text":text}]}
            }}}}),
        )
    }

    /// A Codex dynamic tool call of a screen tool, answered once it is done.
    pub async fn codex(
        &mut self,
        value: &Value,
        root: &str,
        context: Option<&Context>,
    ) -> Option<(Value, Option<RunEvent>)> {
        let p = &value["params"];
        if value["method"] != "item/tool/call" {
            return None;
        }
        let name = p["tool"].as_str().filter(|name| NAMES.contains(name))?;
        let result = if !root.is_empty() && p["threadId"] == root && p["namespace"].is_null() {
            self.answer(name, &p["arguments"], context).await
        } else {
            Err("Screens are saved and read by the parent conversation.".into())
        };
        let (text, success, event) = match result {
            Ok((text, card)) => (text, true, card.map(|screen| RunEvent::Screen { screen })),
            Err(error) => (error, false, None),
        };
        self.saved |= event.is_some();
        Some((
            json!({"id":value["id"],"result":{"success":success,"contentItems":[{"type":"inputText","text":text}]}}),
            event,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(name: &str, input: Value) -> Value {
        json!({"type":"control_request","request_id":"request-1","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":name,"arguments":input}}}})
    }
    fn result(answer: &Value) -> (&Value, String) {
        let result = &answer["response"]["response"]["mcp_response"]["result"];
        (
            &result["isError"],
            result["content"][0]["text"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn tools_describe_their_fields_and_the_page_api() {
        let listed = tools();
        assert_eq!(
            listed
                .iter()
                .map(|t| t["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            NAMES
        );
        assert_eq!(
            listed[0]["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            super::super::FIELDS
                .iter()
                .copied()
                .collect::<std::collections::BTreeSet<_>>()
        );
        for api in [
            "studio.run(",
            "studio.json(",
            "studio.exec(",
            "studio.start(",
            "studio.jobs()",
            "studio.follow(",
            "studio.stop(",
            "studio.forget(",
            "studio.mcp(",
            "studio.mcpJson(",
            "studio.mcpServers(",
            "studio.ask(",
            "studio.load(",
            "studio.save(",
            "studio.values",
            "studio.copy(",
            "studio.open(",
            "studio.chat(",
            "PARAM_",
            "'wsl'",
            "call_mcp_tool",
            "list_mcp_tools",
            "mcp__linear__list_issues is {\"server\":\"linear\",\"tool\":\"list_issues\"}",
        ] {
            assert!(SAVE_DESCRIPTION.contains(api), "{api}");
        }
        // Nothing in it asks the user for permission any more.
        assert!(!SAVE_DESCRIPTION.contains("allow them"));
        assert!(GUIDANCE.contains("list_mcp_tools") && GUIDANCE.contains("call_mcp_tool"));
        for tool in codex_tools() {
            assert_eq!(tool["type"], "function");
            assert_eq!(tool["deferLoading"], false);
        }
    }

    #[tokio::test]
    async fn only_the_parents_registered_call_reaches_the_screens() {
        let mut agent = Agent::default();
        // Another server's request and other tools belong to their own handlers.
        let mut other = control(LIST, json!({}));
        other["request"]["server_name"] = json!("other");
        assert!(agent.claude(&other, None).await.is_none());
        assert!(agent
            .claude(&control("visualize", json!({})), None)
            .await
            .is_none());
        // An unregistered call is refused.
        let answer = agent.claude(&control(LIST, json!({})), None).await.unwrap();
        let (error, text) = result(&answer);
        assert_eq!(*error, true);
        assert!(text.contains("registered parent-conversation"), "{text}");
        let answer = agent
            .claude(
                &control(CALL, json!({"server": "linear", "tool": "x"})),
                None,
            )
            .await
            .unwrap();
        assert!(result(&answer).1.contains("registered parent-conversation"));
        // A sub-agent's call never registers.
        agent.observe_claude(&json!({"type":"assistant","parent_tool_use_id":"child","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__agent_studio__list_screens","input":{}}]}}));
        assert!(agent.pending.is_empty());
        // The parent's call reaches the tool, which needs a conversation.
        agent.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__agent_studio__list_screens","input":{}}]}}));
        let answer = agent.claude(&control(LIST, json!({})), None).await.unwrap();
        let (error, text) = result(&answer);
        assert_eq!(*error, true);
        assert!(
            text.contains("saved Claude and Codex conversations"),
            "{text}"
        );
        // A result without an accepted save publishes nothing.
        let events = agent.observe_claude(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]}}));
        assert!(events.is_empty() && !agent.has_screens());
    }

    #[tokio::test]
    async fn codex_calls_come_from_the_parent_thread_alone() {
        let mut agent = Agent::default();
        let call = |thread: &str, namespace: Value| json!({"id":9,"method":"item/tool/call","params":{"threadId":thread,"tool":SERVERS,"namespace":namespace,"arguments":{}}});
        assert!(agent
            .codex(&json!({"id":1,"method":"item/tool/call","params":{"threadId":"root","tool":"visualize"}}), "root", None)
            .await
            .is_none());
        for value in [call("child", Value::Null), call("root", json!("mcp"))] {
            let (response, event) = agent.codex(&value, "root", None).await.unwrap();
            assert_eq!(response["result"]["success"], false);
            assert!(event.is_none());
            assert!(response["result"]["contentItems"][0]["text"]
                .as_str()
                .unwrap()
                .contains("parent conversation"));
        }
        let (response, _) = agent
            .codex(&call("root", Value::Null), "root", None)
            .await
            .unwrap();
        assert_eq!(response["id"], 9);
        assert!(response["result"]["contentItems"][0]["text"]
            .as_str()
            .unwrap()
            .contains("saved Claude and Codex conversations"));
    }

    #[test]
    fn the_saved_text_tells_the_model_where_the_screen_runs() {
        let mut screen = Screen {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 2,
            title: "PRs".into(),
            description: String::new(),
            html: "<p>x</p>".into(),
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
            created_at: super::super::now(),
            updated_at: super::super::now(),
        };
        let text = saved_text(&screen, None);
        assert!(
            text.contains(&screen.id) && text.contains("Nothing waits for the user"),
            "{text}"
        );
        let declared = super::super::definition(&json!({"title":"x","html":"x",
            "actions":[{"name":"list","shell":"powershell","script":"gh pr list"}],
            "mcpTools":[{"server":"linear","tool":"list_issues"}]}))
        .unwrap();
        screen.actions = declared.actions;
        assert!(saved_text(&screen, None).contains("Its action runs in C:\\work"));
        // Its tools are called first as the account it keeps, which the model hears when it
        // differs from the saving conversation's.
        screen.mcp_tools = declared.mcp_tools;
        let text = saved_text(&screen, Some("the Claude account Work"));
        assert!(
            text.contains("calls MCP tools first as the Claude account Work"),
            "{text}"
        );
        let fleet =
            json!({"connections": [{"id": "c1", "accountId": "a1", "environmentId": "e1"}]});
        assert_eq!(connection_environment(&fleet, "c1").as_deref(), Some("e1"));
    }

    #[test]
    fn calls_of_the_mcp_tools_name_a_place_and_an_account_or_none() {
        let object = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(reach(&object(json!({}))).unwrap(), (None, None));
        assert_eq!(
            reach(&object(
                json!({"where": "WSL", "account": " Claude CLI login "})
            ))
            .unwrap(),
            (Some("wsl".into()), Some("Claude CLI login".into()))
        );
        assert!(reach(&object(json!({"where": "C:\\"}))).is_err());
    }
}
