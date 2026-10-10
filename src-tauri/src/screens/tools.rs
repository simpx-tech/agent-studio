//! The tools a chat saves, lists and reads this computer's screens with: SDK tools of Claude's
//! agent_studio server and Codex dynamic tools. Only the conversation's own call reaches them:
//! Claude's registered parent tool use, Codex's parent thread without a namespace. A screen
//! runs where the conversation that created it runs, which the host decides, never the call.
use super::{Card, Screen, Site};
use crate::protocol::RunEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

pub const SAVE: &str = "save_screen";
pub const LIST: &str = "list_screens";
pub const READ: &str = "read_screen";
const NAMES: [&str; 3] = [SAVE, LIST, READ];

pub const GUIDANCE: &str = "For a page the user keeps and reopens in Agent Studio, such as a dashboard, a tracker, a report to revisit or a small tool with its own interface and commands, call save_screen (Claude: mcp__agent_studio__save_screen): it saves a screen on this computer, listed under Screens in the sidebar apart from this chat. Before updating a screen by its id, find it with list_screens and open it with read_screen (Claude: mcp__agent_studio__list_screens, mcp__agent_studio__read_screen). Use visualize for a visual that belongs only in this reply.";

const SAVE_DESCRIPTION: &str = "Save a screen: a lasting page in Agent Studio with its own interface (HTML, CSS and JavaScript) and the actions it may run on this computer. The user reopens saved screens from Screens in the Agent Studio sidebar, apart from this conversation, so build one when the user asks for a dashboard, a tracker, a report to revisit or a small tool. Omit id to create a screen; to change one, pass its id and send the complete screen again.

html: one self-contained page (a fragment or a whole document) with inline CSS and JavaScript. It fills the window's main area and scrolls by itself, on a transparent background in the app's font at 14px. Style it with the host's CSS variables --foreground, --heading, --muted-foreground, --card, --border, --primary, --primary-foreground and --viz-series-1 to --viz-series-6 so it matches the light and dark themes. The page has no network access: remote scripts, styles, fonts, images and fetch are blocked, so its data comes from actions. Its script reaches Agent Studio through the global studio object:
- await studio.run(name, params) runs one action with an object of parameter values and resolves to {exitCode, stdout, stderr, truncated, timedOut, durationMs}. It rejects when the action cannot run, for example before the user allowed the screen's actions; show that message in the page.
- await studio.json(name, params) runs an action and returns its stdout parsed as JSON, rejecting with its stderr when it exits with a code other than 0.
- await studio.load(key) and await studio.save(key, value) keep JSON values for this screen on this computer, for preferences and data the screen owns; save(key, null) removes one.
- studio.chat(text) opens a new conversation in this screen's folder with text in its message box for the user to send. It works only right after the user clicked or typed in the screen.
- studio.theme is 'dark' or 'light'; studio.screen holds its id and title.
Write command output into the page as text (textContent or text nodes), never as HTML, since it can hold anything. Show loading, empty and error states, and run actions when the page opens and when the user asks (buttons, filters), never in tight loops.

actions: the commands the page may run, each {name, description, shell, script, params, timeout}. name is lowercase letters, digits and _. shell is 'powershell' on Windows (pwsh when installed, otherwise Windows PowerShell 5.1, so write for both) or 'bash' (Git Bash on Windows, bash in WSL, Linux and macOS). The script runs in this conversation's working folder, bash in a login shell, with stdin closed, until it ends; set timeout to a number of seconds to stop it after that long, and whatever it started ends with it. It succeeds with exit code 0, and a PowerShell script ends with its own exit code or that of the last program it ran. params declares each value the page may pass, as {name: {type: 'string' | 'number' | 'integer' | 'boolean', description, enum, pattern, maxLength, minimum, maximum, optional}}; the host refuses values that do not fit before anything runs. Each value reaches the script only as the environment variable PARAM_<NAME> (since becomes PARAM_SINCE), never inside the script's text: quote it as \"$PARAM_SINCE\" in bash, use $env:PARAM_SINCE in PowerShell, and never pass it to eval or Invoke-Expression. Print JSON for studio.json (gh --json, ConvertTo-Json -Depth 6 -Compress, jq). Test each script with your own shell tool first, in this folder and with its PARAM_ variables set. The user reviews the actions and must allow them before any runs, and again after they change, so declare only what the page needs and describe what each does; a screen without actions needs no approval.";

const LIST_DESCRIPTION: &str = "List the screens this computer keeps: id, title, description, the folder their actions run in, their actions, whether the user allowed those, and whether this conversation can update the screen. Call it before reading or updating a screen.";

const READ_DESCRIPTION: &str = "Read one saved screen whole: its title, description, html, actions and the values it saved with studio.save, to change it and save it again with save_screen and the same id.";

pub fn tools() -> Vec<Value> {
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
                        "timeout":{"type":"integer","minimum":1,"description":"Seconds the script may run before it is stopped. Omit it to let the script run until it ends."}
                    },"required":["name","shell","script"],"additionalProperties":false}}
            },"required":["title","html"],"additionalProperties":false}}),
        json!({"name":LIST,"description":LIST_DESCRIPTION,"inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":READ,"description":READ_DESCRIPTION,"inputSchema":{
            "type":"object","properties":{"id":{"type":"string","description":"A screen id from list_screens."}},
            "required":["id"],"additionalProperties":false}}),
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
/// keeps this computer's app data folder rather than the app itself, so the tools stay plain.
pub struct Context {
    data: PathBuf,
    screens: Arc<super::Screens>,
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
            conversation_id: request.conversation_id.clone().expect("a conversation"),
            run_id: request.run_id.clone(),
            provider: request.agent.provider.clone(),
            connection_id: None,
            location: request.location.clone(),
        }
    }
    /// The execution environment of the conversation's account: this computer, or the WSL
    /// distribution its connection belongs to.
    async fn environment(&self) -> Result<String, String> {
        let local = crate::profiles::installation_in(&self.data)?;
        let Some(connection) = self.connection_id.clone() else {
            return Ok(local.id);
        };
        let root = self.data.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let fleet = crate::saved::fleet(
                &root,
                "Save the workspace before saving a screen",
                "Cannot read this conversation's connection",
            )?;
            fleet["connections"]
                .as_array()
                .and_then(|list| list.iter().find(|c| c["id"] == connection.as_str()))
                .and_then(|c| c["environmentId"].as_str())
                .map(String::from)
                .ok_or_else(|| "This conversation's connection no longer exists.".to_string())
        })
        .await
        .map_err(|_| "Cannot read this conversation's connection".to_string())?
    }
    /// Where the conversation's commands run now: its folder, as its CLI works in it.
    async fn site(&self) -> Result<Site, String> {
        let environment_id = self.environment().await?;
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

fn card(screen: &Screen) -> Card {
    Card {
        id: screen.id.clone(),
        revision: screen.revision,
        title: screen.title.clone(),
        environment_id: screen.site.environment_id.clone(),
    }
}

fn saved_text(screen: &Screen, created: bool, previously_allowed: bool) -> String {
    let count = screen.actions.len();
    let actions = match count {
        0 => "It declares no actions, so it needs no approval.".to_string(),
        _ if screen.allowed() => "Its actions are unchanged and stay allowed.".to_string(),
        _ => {
            let (subject, pronoun) = if count == 1 {
                ("Its action runs".to_string(), "it")
            } else {
                (format!("Its {count} actions run"), "them")
            };
            format!(
                "{subject} in {} on this computer once the user allows {pronoun}: tell the user to open the screen and review {pronoun} first.{}",
                screen.site.folder,
                if !created && previously_allowed {
                    " The actions changed, so the user must allow them again."
                } else {
                    ""
                }
            )
        }
    };
    format!(
        "Saved the screen \"{}\" (id {}, revision {}). The user opens it from Screens in Agent Studio's sidebar, and this reply shows a card that opens it. {actions} To change it later, call save_screen with this id and the complete screen.",
        screen.title, screen.id, screen.revision
    )
}

async fn save(context: &Context, args: &Value) -> Result<(String, Card), String> {
    let definition = super::definition(args)?;
    let site = context.site().await?;
    for action in &definition.actions {
        super::run::available(&site, action.shell)
            .map_err(|error| format!("Action {}: {error}", action.name))?;
    }
    let root = context.data.join("screens");
    let previously_allowed = match &definition.id {
        Some(id) => super::opened(root.clone(), id.clone())
            .await
            .is_ok_and(|(screen, _)| screen.allowed() && !screen.actions.is_empty()),
        None => false,
    };
    let (screen, created) = super::saved(
        &context.screens,
        root,
        definition,
        site,
        context.conversation_id.clone(),
        context.run_id.clone(),
    )
    .await?;
    Ok((
        saved_text(&screen, created, previously_allowed),
        card(&screen),
    ))
}

async fn list(context: &Context, args: &Value) -> Result<String, String> {
    if !(args.is_null() || args.as_object().is_some_and(|o| o.is_empty())) {
        return Err("list_screens takes no arguments.".into());
    }
    let environment = context.environment().await?;
    let screens = super::listed(context.data.join("screens")).await?;
    if screens.is_empty() {
        return Ok("This computer keeps no screens yet. Create one with save_screen.".into());
    }
    let entries: Vec<Value> = screens
        .iter()
        .map(|screen| {
            json!({
                "id": screen.id,
                "title": screen.title,
                "description": screen.description,
                "folder": screen.site.folder,
                "revision": screen.revision,
                "updatedAt": screen.updated_at,
                "actions": screen.actions.iter().map(|a| json!({"name": a.name, "description": a.description})).collect::<Vec<_>>(),
                "allowed": screen.allowed(),
                "updatableHere": screen.site.environment_id == environment,
            })
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
    serde_json::to_string_pretty(&json!({
        "id": screen.id,
        "title": screen.title,
        "description": screen.description,
        "revision": screen.revision,
        "folder": screen.site.folder,
        "allowed": screen.allowed(),
        "html": screen.html,
        "actions": screen.actions,
        "savedValues": values,
    }))
    .map_err(|_| "Cannot read this screen".into())
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
            "studio.load(",
            "studio.save(",
            "studio.chat(",
            "PARAM_",
        ] {
            assert!(SAVE_DESCRIPTION.contains(api), "{api}");
        }
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
        let call = |thread: &str, namespace: Value| json!({"id":9,"method":"item/tool/call","params":{"threadId":thread,"tool":LIST,"namespace":namespace,"arguments":{}}});
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
    fn the_saved_text_tells_the_model_what_the_user_must_do() {
        let mut screen = Screen {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 2,
            title: "PRs".into(),
            description: String::new(),
            html: "<p>x</p>".into(),
            actions: vec![],
            site: Site {
                environment_id: uuid::Uuid::new_v4().to_string(),
                distribution: None,
                folder: "C:\\work".into(),
                project: String::new(),
            },
            conversation_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
            created_at: super::super::now(),
            updated_at: super::super::now(),
            approval: None,
        };
        assert!(saved_text(&screen, true, false).contains("needs no approval"));
        screen.actions = super::super::definition(&json!({"title":"x","html":"x","actions":[{"name":"list","shell":"powershell","script":"gh pr list"}]}))
            .unwrap()
            .actions;
        let text = saved_text(&screen, false, true);
        assert!(
            text.contains("open the screen and review it") && text.contains("allow them again"),
            "{text}"
        );
        assert!(text.contains(&screen.id) && text.contains("C:\\work"));
    }
}
