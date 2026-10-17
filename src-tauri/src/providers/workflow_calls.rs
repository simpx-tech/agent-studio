//! Workflow tools (docs/WORKFLOWS.md): SDK tools of Claude's agent_studio server and Codex
//! dynamic tools that build, run and read workflows, and for a mission's orchestrator, drive
//! the mission. The host only checks that a call is the conversation's own (Claude's registered
//! parent tool use, Codex's parent thread without a namespace) and hands it to this computer's
//! window, whose workflow engine answers it through `answer_workflow_call`, as an answered
//! question reaches its run.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

/// The event a window answers calls from.
pub const EVENT: &str = "studio-workflow-call";
/// Tools every saved Claude and Codex chat with tools gets.
pub const GENERAL: [&str; 6] = [
    "workflow_list",
    "workflow_read",
    "workflow_save",
    "workflow_run",
    "workflow_status",
    "mission_start",
];
/// Tools only a mission's orchestrator gets.
pub const MISSION: [&str; 13] = [
    "mission_state",
    "mission_plan",
    "mission_spawn",
    "mission_message",
    "mission_stop",
    "mission_read",
    "mission_chats",
    "mission_ask",
    "mission_note",
    "mission_wait",
    "mission_screen",
    "mission_run_workflow",
    "mission_complete",
];
pub fn known(name: &str) -> bool {
    GENERAL.contains(&name) || MISSION.contains(&name)
}

pub const GUIDANCE: &str = "To automate a sequence of steps across chats, agents and computers, build a workflow with workflow_save (Claude: mcp__agent_studio__workflow_save) and run it with workflow_run; workflow_list and workflow_read find and open saved ones, and workflow_status follows a run. For a goal an agent should pursue by itself over many steps, sessions or days, start a mission with mission_start: an orchestrator agent then plans it, starts agents on the computers and accounts it chooses and drives it to completion. Both appear under Workflows in Agent Studio's sidebar.";

const STEPS: &str = "Steps (type: settings in config; outputs):
- start (a trigger; a workflow may have several, each starting its own runs): trigger manual|schedule|chat|workflow|webhook|computer|usage. manual: inputs [{name, label, default, multiline}] (Run and workflow_run). schedule: schedules [{id, every: minutes|hours|days|weeks, interval, at: HH:MM, days: [0-6], timezone}]. chat: chat {events: [completed|failed|stopped|question], environmentId, path (folder prefix), provider, title (contains), workflowChats} for a reply ending or asking in a matching chat (empty filters match any). workflow: workflow {workflowId ('' for any run or mission), statuses: [completed|failed|stopped]}. webhook: webhook {secret} (leave it empty; the editor makes one), started by a POST to its URL. computer: computer {environmentId ('' for any), event: online|offline}. usage: usage {connectionId or provider ('' for any)} when an account's 5-hour or weekly limit reset after it was reached. Its output is what fired it (a chat's reply, a run's output, the webhook's body); out.
- agent: prompt, location {computerId, environmentId, path} (omit for the driving computer, empty path for a Standalone folder), provider claude|codex|gemini, connectionId (an account's connection id; empty for the least used account), model (empty for the CLI default), reasoning, json (ask for a JSON reply), schema (a JSON Schema as text), chat continue|new (a repeated run for the same loop item continues its chat or starts a new one), title, listed (show the chat in Active), instructions; out, error.
- message: target step|chat, step (the key of an earlier step whose chat it uses) or conversationId, text, mode next|steer, wait; out, error.
- read: target, step or conversationId, what reply|messages|chat, count; out, error.
- condition: left, op contains|notContains|equals|notEquals|matches|greater|less|empty|notEmpty|true, right, ignoreCase; true, false.
- loop: items (a JSON list or lines, usually a template), parallel; each (runs once per item; the item ends when its steps end), done.
- merge: waits for every incoming branch; out.
- wait: mode for|until, amount, unit seconds|minutes|hours|days, until (HH:MM or an ISO time); out.
- ask: header, question, choices, multiple; out (the answer).
- confirm: header, question, approve, reject (button labels); approved, rejected.
- notify: title, text; out.
- set: values [{name, value, json}]; out (an object of the values).
- screen: like agent without prompt, plus screenTitle, spec (what the screen shows and does), screenId (to update one); out, error.
- screenAction: environmentId, screenId, action, params {name: value}; out (stdout), error.
- screenData: environmentId, screenId, op load|save, key, value, json; out.
- workflow: workflowId, inputs {name: value}, wait; out (its output), error.
- end: output, status completed|failed.
Text settings are templates: {{input.NAME}} a manual trigger's input, {{trigger.output}} and {{trigger.json.PATH}} what fired the run, {{KEY.output}} a step's output text, {{KEY.json.PATH}} part of its JSON, {{KEY.chat}} its chat id, {{item}} and {{index}} the loop item, {{previous.output}} what the step before handed over, {{run.title}}, {{now}}. Every step may set onError stop|continue, retries and retryDelay (seconds); a connected error port takes its failures.";

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{
        "type":"object","properties":properties,"required":required,"additionalProperties":false
    }})
}
fn agent_choice() -> Value {
    json!({"type":"object","description":"Who runs it: provider claude|codex|gemini, account (a connection id or an account name; omit for the least used ready account), model (omit for the CLI default) and reasoning.","properties":{
        "provider":{"type":"string","enum":["claude","codex","gemini"]},
        "account":{"type":"string"},
        "model":{"type":"string"},
        "reasoning":{"type":"string"}
    },"additionalProperties":false})
}
fn questions() -> Value {
    json!({"type":"array","minItems":1,"items":{"type":"object","properties":{
        "id":{"type":"string","minLength":1},
        "header":{"type":"string"},
        "question":{"type":"string","minLength":1},
        "multiSelect":{"type":"boolean"},
        "options":{"type":"array","items":{"type":"object","properties":{
            "label":{"type":"string","minLength":1},"description":{"type":"string"}
        },"required":["label"],"additionalProperties":false}}
    },"required":["id","question"],"additionalProperties":false}})
}

/// The tools a conversation gets: none without a saved conversation, the mission tools only
/// for an orchestrator.
pub fn tools(enabled: bool, orchestrator: bool) -> Vec<Value> {
    if !enabled {
        return vec![];
    }
    let save = format!("Create or replace a static workflow: a graph of steps Agent Studio runs, which the user also edits in its Workflows view. Omit id to create one; to change one, read it with workflow_read and send the whole workflow again with its id and revision. nodes: [{{id, key, type, title, config, position {{x, y}}, onError, retries, retryDelay}}] (key: lowercase letters, digits and _, unique; positions are optional and laid out when missing); edges: [{{source, sourcePort, target}}] from a step's output port to the next step. Returns the id, revision and anything that keeps it from running.\n{STEPS}");
    let mut list = vec![
        tool("workflow_list", "List the saved workflows (id, name, steps, schedules) and the runs and missions of this workspace (id, title, mode, status, what each waits for).", json!({}), &[]),
        tool("workflow_read", "Read a saved workflow whole: name, description, revision, nodes and edges, to change it with workflow_save.", json!({"id":{"type":"string"}}), &["id"]),
        tool("workflow_save", &save, json!({
            "id":{"type":"string"},
            "revision":{"type":"integer","minimum":0},
            "name":{"type":"string","minLength":1},
            "description":{"type":"string"},
            "nodes":{"type":"array","items":{"type":"object"}},
            "edges":{"type":"array","items":{"type":"object"}}
        }), &["name","nodes","edges"]),
        tool("workflow_run", "Start a run of a saved workflow with its inputs, at its first manual trigger or at the trigger step whose key you name. computer names the computer that drives it (an id or name); it defaults to this one. Returns the run's id; follow it with workflow_status.", json!({
            "id":{"type":"string"},
            "inputs":{"type":"object","additionalProperties":{"type":"string"}},
            "trigger":{"type":"string"},
            "computer":{"type":"string"}
        }), &["id"]),
        tool("workflow_status", "Read a run or mission: its status, what it waits for, each step or agent with its status and output, open questions and recent history.", json!({"id":{"type":"string"}}), &["id"]),
        tool("mission_start", "Start a mission: an orchestrator agent pursues the goal by itself, planning, starting agents on the computers and accounts it chooses, reviewing their work and asking the user when needed, until it is done, across sessions, computers and days. The user watches it live in the Workflows view. Returns the mission's id.", json!({
            "mission":{"type":"string","minLength":1,"description":"The goal, with everything the orchestrator should know."},
            "title":{"type":"string"},
            "folder":{"type":"object","description":"The project's folder: computer (id or name) and its absolute path.","properties":{"computer":{"type":"string"},"path":{"type":"string"}},"required":["path"],"additionalProperties":false},
            "orchestrator":agent_choice()
        }), &["mission"]),
    ];
    if orchestrator {
        list.extend([
            tool("mission_state", "Read the mission whole: its goal, plan, every agent with its status, computer, account and the length of its latest reply, notes, open questions, timers, the computers with their online state, folders and installed agents, every account with its 5-hour and weekly usage, pace and resets, and recent history. include picks parts.", json!({
                "include":{"type":"array","items":{"type":"string","enum":["plan","agents","notes","questions","timers","computers","accounts","history"]}}
            }), &[]),
            tool("mission_plan", "Add, change or remove tasks of the mission's plan, which the user sees live as a graph: id (stable, yours), title, description, status planned|running|done|failed|blocked|skipped|cancelled, dependsOn (task ids), phase, result (a short note of what came of it). Send only the fields that change.", json!({
                "tasks":{"type":"array","items":{"type":"object","properties":{
                    "id":{"type":"string","minLength":1},"title":{"type":"string"},"description":{"type":"string"},
                    "status":{"type":"string","enum":["planned","running","done","failed","blocked","skipped","cancelled"]},
                    "dependsOn":{"type":"array","items":{"type":"string"}},"phase":{"type":"string"},"result":{"type":"string"}
                },"required":["id"],"additionalProperties":false}},
                "remove":{"type":"array","items":{"type":"string"}}
            }), &[]),
            tool("mission_spawn", "Start an agent: a new chat that works on its task by itself. It returns at once with the agent's id; you hear when it finishes, with its reply. It may wait first for its computer, its account's sign-in or a usage reset, which mission_state shows. computer: an id or name (default: the computer of the project folder, else this one). folder: an absolute path on that computer, or empty for a Standalone folder of its own (default: the project folder when it is on that computer). The mission and its notes go with the task unless includeContext is false. after names agents whose work this one continues.", json!({
                "title":{"type":"string","minLength":1},
                "task":{"type":"string","minLength":1,"description":"Everything the agent needs to do and deliver."},
                "taskId":{"type":"string","description":"The plan task this agent works on."},
                "computer":{"type":"string"},
                "folder":{"type":"string"},
                "agent":agent_choice(),
                "includeContext":{"type":"boolean"},
                "after":{"type":"array","items":{"type":"string"}},
                "listed":{"type":"boolean","description":"Show its chat in the user's chat list."}
            }), &["title","task"]),
            tool("mission_message", "Send a chat (an agent's, by its id, or any other) a message: next (default) is its next message, sent once its reply ends; steer goes into its running reply. You hear when the reply ends.", json!({
                "chat":{"type":"string"},"text":{"type":"string","minLength":1},"mode":{"type":"string","enum":["next","steer"]}
            }), &["chat","text"]),
            tool("mission_stop", "Stop a chat's running reply.", json!({"chat":{"type":"string"}}), &["chat"]),
            tool("mission_read", "Read a chat: its latest reply (default), its last count messages, or the whole conversation.", json!({
                "chat":{"type":"string"},"what":{"type":"string","enum":["reply","messages","chat"]},"count":{"type":"integer","minimum":1}
            }), &["chat"]),
            tool("mission_chats", "List chats: this mission's agents (default) or every chat of the workspace, with their computer, folder, agent, account and status. query filters by title.", json!({
                "scope":{"type":"string","enum":["mission","all"]},"query":{"type":"string"}
            }), &[]),
            tool("mission_ask", "Ask the user questions without waiting: other work goes on, and the answer arrives with a later turn. Ask only what needs their decision. Each question has an id, the question, an optional header, options and multiSelect.", json!({"questions":questions()}), &["questions"]),
            tool("mission_note", "Write, change or delete a shared note of the mission: decisions, conventions, progress, learnings. Notes outlive this session; a later session or agent continues from them. Omit id to add one.", json!({
                "id":{"type":"string"},"title":{"type":"string"},"text":{"type":"string"},"delete":{"type":"boolean"}
            }), &[]),
            tool("mission_wait", "Set a timer that wakes you at a time (until, ISO 8601) or after seconds, for example at a usage reset. End your turn after it.", json!({
                "until":{"type":"string"},"seconds":{"type":"number","minimum":1},"reason":{"type":"string"}
            }), &[]),
            tool("mission_screen", "Use a screen of a computer: run one of its allowed actions (op run, action, params), or load (op load) or save (op save, key, value) its data. Build screens yourself with save_screen.", json!({
                "op":{"type":"string","enum":["run","load","save"]},"computer":{"type":"string"},"screen":{"type":"string"},
                "action":{"type":"string"},"params":{"type":"object"},"key":{"type":"string"},"value":{}
            }), &["op","screen"]),
            tool("mission_run_workflow", "Run a saved static workflow with its inputs. With wait, its output arrives with a later turn when it ends.", json!({
                "id":{"type":"string"},"inputs":{"type":"object","additionalProperties":{"type":"string"}},"wait":{"type":"boolean"}
            }), &["id"]),
            tool("mission_complete", "End the mission once its goal is fully achieved and checked, with a summary of what was done and where the results are; or as failed when it cannot be achieved.", json!({
                "summary":{"type":"string","minLength":1},"status":{"type":"string","enum":["completed","failed"]}
            }), &["summary"]),
        ]);
    }
    list
}
pub fn codex_tools(enabled: bool, orchestrator: bool) -> Vec<Value> {
    tools(enabled, orchestrator)
        .into_iter()
        .map(|mut tool| {
            tool["type"] = json!("function");
            tool["deferLoading"] = json!(false);
            tool
        })
        .collect()
}

/// The mission a conversation orchestrates, as its run request names it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub run_id: String,
    pub role: String,
}
impl Binding {
    pub fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.run_id).map_err(|_| "Invalid mission")?;
        if self.role != "orchestrator" {
            return Err("Invalid mission role".into());
        }
        Ok(())
    }
}

/// One call, as the window that answers it receives it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub id: String,
    pub run_id: String,
    pub conversation_id: String,
    pub connection_id: Option<String>,
    pub tool: String,
    pub input: Value,
    pub mission: Option<Binding>,
}

/// What the tools act for: the saved conversation and how its calls reach the window.
#[derive(Clone)]
pub struct Context {
    pub conversation_id: String,
    pub connection_id: Option<String>,
    pub mission: Option<Binding>,
    pub emit: Arc<dyn Fn(&Call) + Send + Sync>,
}

/// The tools' context for a run: a saved Claude or Codex chat with tools, whose calls reach
/// this computer's window.
pub fn context(
    app: &tauri::AppHandle,
    request: &super::RunRequest,
    connection_id: Option<String>,
) -> Option<Context> {
    if !request.workflow_tools() {
        return None;
    }
    let app = app.clone();
    Some(Context {
        conversation_id: request.conversation_id.clone()?,
        connection_id,
        mission: request.mission.clone(),
        emit: Arc::new(move |call: &Call| {
            let _ = tauri::Emitter::emit(&app, EVENT, call);
        }),
    })
}

#[derive(Clone)]
enum Wire {
    Claude { request: Value, message: Value },
    Codex(Value),
}
impl Wire {
    fn respond(&self, text: &str, error: bool) -> Value {
        match self {
            Self::Claude { request, message } => {
                json!({"type":"control_response","response":{"subtype":"success","request_id":request,"response":{"mcp_response":{
                    "jsonrpc":"2.0","id":message,"result":{"isError":error,"content":[{"type":"text","text":text}]}
                }}}})
            }
            Self::Codex(id) => {
                json!({"id":id,"result":{"success":!error,"contentItems":[{"type":"inputText","text":text}]}})
            }
        }
    }
}
struct Pending {
    call: Call,
    wire: Wire,
    sending: bool,
}
struct Run {
    connection: Option<String>,
    calls: HashMap<String, Pending>,
    tx: mpsc::UnboundedSender<Delivery>,
    active: bool,
}
#[derive(Clone, Default)]
pub struct Hub(Arc<Mutex<HashMap<String, Run>>>);
pub struct Delivery {
    pub payload: Value,
    id: String,
    ack: oneshot::Sender<Result<(), String>>,
}
pub struct Session {
    hub: Hub,
    run_id: String,
    pub rx: mpsc::UnboundedReceiver<Delivery>,
    context: Option<Context>,
    /// The parent assistant's calls, by Claude's tool use id, with their tool and input.
    registered: HashMap<String, (String, Value)>,
}

impl Hub {
    pub fn open(&self, run_id: &str, connection: Option<String>) -> Session {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut runs) = self.0.lock() {
            runs.insert(
                run_id.into(),
                Run {
                    connection,
                    calls: HashMap::new(),
                    tx,
                    active: true,
                },
            );
        }
        Session {
            hub: self.clone(),
            run_id: run_id.into(),
            rx,
            context: None,
            registered: HashMap::new(),
        }
    }
    /// The window's answer to a call, delivered to the CLI that waits for it.
    pub async fn answer(
        &self,
        run_id: &str,
        connection: Option<&str>,
        id: &str,
        text: String,
        error: bool,
    ) -> Result<(), String> {
        let rx = {
            let mut runs = self
                .0
                .lock()
                .map_err(|_| "Workflow calls are unavailable.")?;
            let run = runs
                .get_mut(run_id)
                .filter(|r| r.active)
                .ok_or("This reply is no longer waiting for the workflow.")?;
            if run.connection.as_deref() != connection {
                return Err("This call belongs to another connection.".into());
            }
            let pending = run
                .calls
                .get_mut(id)
                .filter(|p| !p.sending)
                .ok_or("This call is no longer waiting.")?;
            let (ack, rx) = oneshot::channel();
            run.tx
                .send(Delivery {
                    payload: pending.wire.respond(&text, error),
                    id: id.into(),
                    ack,
                })
                .map_err(|_| "The reply is no longer waiting.")?;
            pending.sending = true;
            rx
        };
        rx.await
            .map_err(|_| "The reply ended before the answer reached it.".to_string())?
    }
    /// Calls still waiting for this computer's window, which a reloaded window answers.
    pub fn pending(&self) -> Vec<Call> {
        self.0
            .lock()
            .map(|runs| {
                runs.values()
                    .filter(|r| r.active)
                    .flat_map(|r| {
                        r.calls
                            .values()
                            .filter(|p| !p.sending)
                            .map(|p| p.call.clone())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Session {
    pub fn attach(&mut self, context: Option<Context>) {
        self.context = context;
    }
    fn allowed(&self, name: &str) -> bool {
        GENERAL.contains(&name)
            || (MISSION.contains(&name)
                && self.context.as_ref().is_some_and(|c| c.mission.is_some()))
    }
    /// Hands a call to the window, or returns the refusal the CLI gets at once.
    fn forward(&mut self, name: &str, input: &Value, wire: Wire) -> Option<Value> {
        let Some(context) = self.context.clone() else {
            return Some(wire.respond(
                "Workflows are available in saved Claude and Codex conversations with tools.",
                true,
            ));
        };
        if !self.allowed(name) {
            return Some(wire.respond(
                "Only a mission's orchestrator uses the mission tools.",
                true,
            ));
        }
        let call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: self.run_id.clone(),
            conversation_id: context.conversation_id.clone(),
            connection_id: context.connection_id.clone(),
            tool: name.into(),
            input: input.clone(),
            mission: context.mission.clone(),
        };
        let Ok(mut runs) = self.hub.0.lock() else {
            return Some(wire.respond("Workflow calls are unavailable.", true));
        };
        let Some(run) = runs.get_mut(&self.run_id).filter(|r| r.active) else {
            return Some(wire.respond("This reply is ending.", true));
        };
        run.calls.insert(
            call.id.clone(),
            Pending {
                call: call.clone(),
                wire,
                sending: false,
            },
        );
        drop(runs);
        (context.emit)(&call);
        None
    }
    /// Claude reports the parent's tool calls before the SDK asks this server to run them.
    pub fn observe_claude(&mut self, value: &Value) {
        if value["type"] != "assistant" || !value["parent_tool_use_id"].is_null() {
            return;
        }
        for block in value["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_use" {
                continue;
            }
            let name = block["name"]
                .as_str()
                .and_then(|name| name.strip_prefix("mcp__agent_studio__"))
                .filter(|name| known(name));
            if let (Some(name), Some(id)) = (name, block["id"].as_str()) {
                self.registered
                    .insert(id.into(), (name.into(), block["input"].clone()));
            }
        }
    }
    /// A Claude SDK call of a workflow tool: `Some(None)` once handed to the window, which
    /// answers later, `Some(Some(refusal))` at once, `None` for other requests.
    pub fn claude(&mut self, value: &Value) -> Option<Option<Value>> {
        let r = &value["request"];
        let m = &r["message"];
        if r["subtype"] != "mcp_message"
            || r["server_name"] != "agent_studio"
            || m["method"] != "tools/call"
        {
            return None;
        }
        let name = m["params"]["name"].as_str().filter(|name| known(name))?;
        let args = &m["params"]["arguments"];
        let wire = Wire::Claude {
            request: value["request_id"].clone(),
            message: m["id"].clone(),
        };
        let call = self
            .registered
            .iter()
            .find(|(_, (tool, input))| tool == name && input == args)
            .map(|(id, _)| id.clone());
        let Some(call) = call else {
            return Some(Some(wire.respond(
                &format!("Only a registered parent-conversation {name} call reaches workflows."),
                true,
            )));
        };
        self.registered.remove(&call);
        Some(self.forward(name, args, wire))
    }
    /// A Codex dynamic tool call of a workflow tool, answered like Claude's.
    pub fn codex(&mut self, value: &Value, root: &str) -> Option<Option<Value>> {
        if value["method"] != "item/tool/call" {
            return None;
        }
        let p = &value["params"];
        let name = p["tool"].as_str().filter(|name| known(name))?;
        let wire = Wire::Codex(value["id"].clone());
        if root.is_empty() || p["threadId"] != root || !p["namespace"].is_null() {
            return Some(Some(
                wire.respond("Workflows are used by the parent conversation.", true),
            ));
        }
        Some(self.forward(name, &p["arguments"], wire))
    }
    pub fn can_deliver(&self, delivery: &Delivery) -> bool {
        self.hub.0.lock().is_ok_and(|runs| {
            runs.get(&self.run_id)
                .is_some_and(|r| r.active && r.calls.get(&delivery.id).is_some_and(|p| p.sending))
        })
    }
    pub fn delivered(&self, delivery: Delivery, result: Result<(), String>) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                if result.is_ok() {
                    run.calls.remove(&delivery.id);
                } else if let Some(pending) = run.calls.get_mut(&delivery.id) {
                    pending.sending = false;
                }
            }
        }
        let _ = delivery.ack.send(result);
    }
    /// The reply ended: calls still waiting go unanswered, and late answers are refused.
    pub fn close(&self) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                run.active = false;
                run.calls.clear();
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
        if let Ok(mut runs) = self.hub.0.lock() {
            runs.remove(&self.run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_session(hub: &Hub, mission: bool) -> (Session, Arc<Mutex<Vec<Call>>>) {
        let calls = Arc::new(Mutex::new(vec![]));
        let seen = calls.clone();
        let mut session = hub.open("run-1", None);
        session.attach(Some(Context {
            conversation_id: "11111111-1111-4111-8111-111111111111".into(),
            connection_id: None,
            mission: mission.then(|| Binding {
                run_id: "22222222-2222-4222-8222-222222222222".into(),
                role: "orchestrator".into(),
            }),
            emit: Arc::new(move |call: &Call| seen.lock().unwrap().push(call.clone())),
        }));
        (session, calls)
    }
    fn control(name: &str, input: Value) -> Value {
        json!({"type":"control_request","request_id":"request-1","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":name,"arguments":input}}}})
    }
    fn tool_use(name: &str, input: Value, parent: Value) -> Value {
        json!({"type":"assistant","parent_tool_use_id":parent,"message":{"content":[{"type":"tool_use","id":"t1","name":format!("mcp__agent_studio__{name}"),"input":input}]}})
    }

    #[test]
    fn tools_are_listed_for_saved_chats_and_mission_tools_for_orchestrators() {
        assert!(tools(false, true).is_empty());
        let names = |list: Vec<Value>| {
            list.iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(tools(true, false)), GENERAL);
        assert_eq!(
            names(tools(true, true)).len(),
            GENERAL.len() + MISSION.len()
        );
        assert!(tools(true, false)[2]["description"]
            .as_str()
            .unwrap()
            .contains("screenAction"));
        for tool in codex_tools(true, true) {
            assert_eq!(tool["type"], "function");
        }
        assert!(Binding {
            run_id: "x".into(),
            role: "orchestrator".into()
        }
        .validate()
        .is_err());
    }

    #[tokio::test]
    async fn a_registered_parent_call_reaches_the_window_and_its_answer_the_cli() {
        let hub = Hub::default();
        let (mut session, calls) = open_session(&hub, false);
        // An unregistered call and a sub-agent's call are refused.
        let refused = session
            .claude(&control("workflow_list", json!({})))
            .unwrap()
            .unwrap();
        assert_eq!(
            refused["response"]["response"]["mcp_response"]["result"]["isError"],
            true
        );
        session.observe_claude(&tool_use("workflow_list", json!({}), json!("child")));
        assert!(session.registered.is_empty());
        // Other servers and tools belong to their own handlers.
        assert!(session.claude(&control("visualize", json!({}))).is_none());
        session.observe_claude(&tool_use("workflow_list", json!({}), Value::Null));
        assert!(session
            .claude(&control("workflow_list", json!({})))
            .unwrap()
            .is_none());
        let call = calls.lock().unwrap()[0].clone();
        assert_eq!(call.tool, "workflow_list");
        assert_eq!(hub.pending().len(), 1);
        let answer = {
            let hub = hub.clone();
            let id = call.id.clone();
            tokio::spawn(async move { hub.answer("run-1", None, &id, "[]".into(), false).await })
        };
        let delivery = session.rx.recv().await.unwrap();
        assert!(session.can_deliver(&delivery));
        assert_eq!(
            delivery.payload["response"]["response"]["mcp_response"]["result"]["content"][0]
                ["text"],
            "[]"
        );
        assert_eq!(delivery.payload["response"]["request_id"], "request-1");
        session.delivered(delivery, Ok(()));
        answer.await.unwrap().unwrap();
        assert!(hub.pending().is_empty());
        // A second answer to the same call is refused.
        assert!(hub
            .answer("run-1", None, &call.id, "again".into(), false)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn mission_tools_answer_only_an_orchestrator() {
        let hub = Hub::default();
        let (mut session, calls) = open_session(&hub, false);
        let value = json!({"id":4,"method":"item/tool/call","params":{"threadId":"root","tool":"mission_state","arguments":{}}});
        let refusal = session.codex(&value, "root").unwrap().unwrap();
        assert_eq!(refusal["result"]["success"], false);
        drop(session);
        let (mut orchestrator, calls_2) = open_session(&Hub::default(), true);
        assert!(orchestrator.codex(&value, "root").unwrap().is_none());
        assert_eq!(calls_2.lock().unwrap()[0].tool, "mission_state");
        // A child thread's call is refused.
        let child = json!({"id":5,"method":"item/tool/call","params":{"threadId":"child","tool":"workflow_list","arguments":{}}});
        assert_eq!(
            orchestrator.codex(&child, "root").unwrap().unwrap()["result"]["success"],
            false
        );
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_closed_reply_refuses_late_answers() {
        let hub = Hub::default();
        let (mut session, calls) = open_session(&hub, false);
        session.observe_claude(&tool_use("workflow_list", json!({}), Value::Null));
        session.claude(&control("workflow_list", json!({})));
        let id = calls.lock().unwrap()[0].id.clone();
        assert_eq!(hub.pending().len(), 1);
        session.close();
        assert!(hub
            .answer("run-1", None, &id, "x".into(), false)
            .await
            .is_err());
        assert!(hub.pending().is_empty());
    }
}
