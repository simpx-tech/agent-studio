//! The tools chats coordinate this computer with (`pc_status`, `pc_reserve`, `pc_wait`,
//! `pc_release`, `pc_land`, `pc_stop` and `chat_message`), as SDK tools of Claude's agent_studio server and
//! Codex dynamic tools, and the hooks Claude chats run around their calls: the gate before each
//! command (`GATE`), which refuses other chats' commands while one holds the computer, and the
//! delivery of messages after each call (`MESSAGES`). The tools act for the conversation whose
//! CLI calls them, its sub-agents included, since a sub-agent may measure too; messages are for
//! the conversation's own agent. `pc_wait` waits as long as the computer stays reserved, so every
//! answer goes back through `Session::rx`, which the reply's loop writes to the CLI, and never
//! holds up the loop meanwhile.
use super::Broker;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const STATUS: &str = "pc_status";
pub const RESERVE: &str = "pc_reserve";
pub const WAIT: &str = "pc_wait";
pub const RELEASE: &str = "pc_release";
pub const LAND: &str = "pc_land";
pub const STOP: &str = "pc_stop";
pub const MESSAGE: &str = "chat_message";
pub const NAMES: [&str; 7] = [STATUS, RESERVE, WAIT, RELEASE, LAND, STOP, MESSAGE];
/// The hook callback that holds other chats' commands.
const GATE: &str = "studio-pc-gate";
/// The hook callback that hands a chat the messages other chats sent it.
const MESSAGES: &str = "studio-pc-messages";
/// How long the CLI waits for the gate, which a running reply answers at once. Claude Code refuses
/// the call once this passes, so a process parked between replies answers a turn of its own with
/// no opinion from its output reader (`pool::Lent`), and the turn's commands go ahead.
const GATE_TIMEOUT_SECONDS: u64 = 30;
/// How long the CLI waits for messages after a call, which a running reply also answers at once.
const MESSAGES_TIMEOUT_SECONDS: u64 = 10;

pub const GUIDANCE: &str = "Chats run side by side on this computer. To measure performance (a benchmark, profiling or a timing run), build, cook and prepare everything first, then reserve the computer with pc_reserve, wait for its window with pc_wait, run the whole series of measured runs, and release it with pc_release right after the last one, before reading logs or writing up (Claude: mcp__agent_studio__pc_reserve, mcp__agent_studio__pc_wait, mcp__agent_studio__pc_release; pc_status shows what runs on the computer now, pc_stop stops programs chats left running, and chat_message writes to another chat). One reservation covers a whole series, and scope: \"gpu\" reserves GPU work alone, beside which other chats' builds and headless tests run on. Never reserve the computer for ordinary builds, tests or runs. To land on a repository's main branch, run the full pipeline first on your branch merged with a freshly fetched main. When the repository has a merge train (.agent-studio/train.json in its main checkout), commit and call pc_land: the train lands the branches queued together, with one merge, one pipeline and one push, and pc_wait returns once yours landed or came back with the reason. Otherwise take the repository's landing turn with pc_reserve and landing: true, fetch again, and push at once if main has not moved, or merge what came and run again the checks it could affect, then push; release the turn right after the push, so that chats land one at a time and none waits through another's whole pipeline; pc_reserve with name holds anything else one chat at a time should use, such as a shared folder. When a command or MCP tool call of yours is refused because another chat reserved the computer, or a build because the builds running leave no room for it, call pc_wait, then run it again. When another chat asks you to hand over what you hold, finish what you need, then call pc_release.";

/// What a Claude session begun before chats could reserve this computer (Agent Studio 1.4.0)
/// reads once, with its next reply's context (`Session::reservations_rule_changed`): its process
/// has the tools, but its first message never named them, and a system prompt cannot reach it,
/// since Claude Code keeps the one a session started with. A Codex thread keeps the tools it
/// started with, so one begun before has none to hear of.
pub fn guidance_added() -> String {
    format!("Agent Studio added this guidance after this conversation began: {GUIDANCE}")
}

const STATUS_DESCRIPTION: &str = "Show whether this computer is reserved for a performance measurement and by which chat, what other chats run on it now (commands and background work, and whether each finishes by itself), the programs chats left running outside their CLIs (editors, games, servers) with their program numbers, and the computer's busiest and largest programs with whose they are: a chat's, Agent Studio's, the system's, or the user's own (\"yours\"). Chats are named by title and id. Call it before pc_reserve.";
const RESERVE_DESCRIPTION: &str = "Reserve this computer for a performance measurement (a benchmark, profiling or a timing run) so that no other chat's work disturbs it. Chats otherwise work side by side: reserve only to measure performance, never for an ordinary build, test or game run. Reserve late: build, cook, stage and prepare everything first, and call pc_status: if programs the user started (\"yours\") use much CPU or memory, ask the user with studio_ask_user whether to close them or measure anyway, before reserving, so that no chat waits on the answer. Reserve once for a whole series of measured runs (five on/off pairs are one reservation), so the wait for other chats' work is paid once. With scope: \"gpu\", reserve GPU work alone, for a measurement that reads only the GPU, such as frame times or a GPU capture: then only other chats' games, editors, browser tests and MCP tool calls of programs here keep your window closed or wait, and their builds and headless tests run on beside it. Your window opens at the first moment no other chat runs heavy work; until then other chats work on, and only after a few minutes without such a moment do their new commands and MCP tool calls wait, except light commands such as git status, while what they already run finishes first. Programs chats left running, such as an editor or a game, keep running: stop those of chats that are not replying with pc_stop, and ask a replying chat that still works with one to hand it over with chat_message and hand_over: true, which your window then waits for. Then call pc_wait, which returns once the window opens; run the series at once (warm up, run several times), call pc_release right after the last run, and read logs, analyze and write up afterwards, since other chats wait until you release. Reservations take turns, and one ends by itself when this reply ends.\nWith name or landing, reserve a thing instead of the computer, one chat at a time, across your calls: name holds anything else, such as a shared folder or an editor that holds a project's assets, and landing: true holds the landing turn of the repository this chat's folder belongs to, every checkout and worktree of it alike. Take the landing turn once the full pipeline passed on your branch merged with a freshly fetched main branch, not before it: under the turn, fetch again and push at once if the main branch has not moved, or merge what came and run again the checks it could affect, then push; release it with pc_release and landing: true right after the push, so chats land one at a time and none waits through another's whole pipeline. When another chat holds it, call pc_wait: it returns once your turn comes. A turn holds nothing else: other chats' commands still run. It outlives this reply by a few minutes, for this chat's next reply to take on (a message the user sends ends a reply), and when work this chat runs under it, such as a build or a test run, uses no CPU for 10 minutes you hear it may have stalled, and after 20 the turn goes to the next chat in line, if one waits.";
const WAIT_DESCRIPTION: &str = "Wait for this computer, as long as it takes. When this chat holds a reservation, it returns once its window opens: no other chat runs busy work then, at most idle work, such as a watcher between its checks. When a build of yours was refused because the builds running leave no room for it, it returns once a build slot is free for it, when this chat asked for a named reservation or a landing turn another chat holds, once its turn comes, and when this chat's branch is on a merge train (pc_land), once it landed or came back with the reason. Otherwise it returns once no other chat holds the computer: call it when a command or MCP tool call of yours was refused because another chat reserved the computer, then run it again. A message from another chat ends the wait early: read it, then call pc_wait again if you still must wait.";
const RELEASE_DESCRIPTION: &str = "End this chat's reservation of the computer right after the last measured run, before reading logs or writing up, so other chats go on. Returns a report: what kept the window closed and for how long, other chats' work that ran while it was open, how busy the computer was (this chat's processes apart from everything else, with the busiest other programs and whose they are), whether the measurement ran beside other heavy work and whose (a chat, Claude Code or Codex outside Agent Studio, the system or the user's programs), and how long other chats waited because of it. Read it before trusting the numbers: when its Measurement line says it ran beside other heavy work, tell the user and offer to measure again. With name or landing: true, release that named reservation or landing turn instead, right after you are done with it (a landing turn right after the push); without them, a chat that holds no reservation of the computer releases its named ones. When the chat holding the computer asked this chat to hand over what it holds, pc_release hands over instead: Agent Studio closes the programs this chat left running, and its commands and MCP tool calls wait until that measurement ends.";
const LAND_DESCRIPTION: &str = "Land this chat's branch on its repository's main branch through the repository's merge train, instead of a landing turn, when the repository has one (.agent-studio/train.json in its main checkout; otherwise this says so, and you land with pc_reserve and landing: true). Call it once your branch, merged with a freshly fetched main branch, passed your own pipeline and is committed: the car carries the commit the branch's head is on now. The train merges the cars queued, up to a few at a time, onto a fresh main branch, runs the repository's pipeline once, pushes and brings the main checkout up to date; a car that conflicts or breaks the pipeline comes back with the reason and its log, and the others land. Then call pc_wait: it returns once yours landed or came back. Calling it again after a new commit brings a waiting car up to date; pc_release with landing: true takes a car that has not left yet off the train. A car needs no running reply: what became of it reaches this chat with its next tool call.";
const STOP_DESCRIPTION: &str = "Stop programs a chat left running on this computer outside its CLI, such as an editor, a game or a server, by the program numbers pc_status lists for it, and with background: true the background work its CLI keeps. Only for a chat that is not replying now, or this chat's own programs: ask a replying chat to hand over instead, with chat_message and hand_over: true. A program with a window is asked to close as its close button asks, so it may still ask about unsaved work; one without a window is ended. Programs the user started are never a chat's: ask the user about those.";
const MESSAGE_DESCRIPTION: &str = "Send a message to another chat replying on this computer, to coordinate your work on it: another agent reads it with its next tool call, not the user. With hand_over: true, the chat holding the computer for a measurement asks that chat to hand over what it holds, such as an editor it still works with: that chat's commands and MCP tool calls run again until it hands over with pc_release, and your window waits until it does or its reply ends; Agent Studio then closes the programs it left running. Name the chat by its title or its id, as pc_status names it.";

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{
        "type":"object","properties":properties,"required":required,"additionalProperties":false
    }})
}

/// The tools of Claude's agent_studio server.
pub fn tools() -> Vec<Value> {
    let mut wait = tool(WAIT, WAIT_DESCRIPTION, json!({}), &[]);
    // A refused command names this tool: it must be at hand, not behind a tool search.
    wait["_meta"] = json!({"anthropic/alwaysLoad": true});
    let chat = json!({"type":"string","minLength":1,"description":"The chat, by its title or its id as pc_status names it."});
    vec![
        tool(STATUS, STATUS_DESCRIPTION, json!({}), &[]),
        tool(
            RESERVE,
            RESERVE_DESCRIPTION,
            json!({
                "purpose":{"type":"string","minLength":1,"description":"What you will measure, or do with what you reserve, in a few words, such as \"Benchmark of chunk meshing, Development build\" or \"Final pipeline and push\"."},
                "minutes":{"type":"number","exclusiveMinimum":0,"description":"About how many minutes the measurement takes once its window opens."},
                "scope":{"type":"string","enum":["computer","gpu"],"description":"What the measurement reserves: the whole computer (the default), or GPU work alone, beside which other chats' builds and headless tests run on."},
                "name":{"type":"string","minLength":1,"description":"Reserve this thing instead of the computer, such as a shared folder's path or \"Unreal editor of bluevox\"."},
                "landing":{"type":"boolean","description":"Reserve the landing turn of this chat's repository instead of the computer."}
            }),
            &["purpose"],
        ),
        wait,
        tool(
            RELEASE,
            RELEASE_DESCRIPTION,
            json!({
                "name":{"type":"string","minLength":1,"description":"Release this named reservation."},
                "landing":{"type":"boolean","description":"Release this chat's landing turn, and take its branch off a merge train it has not left on yet."}
            }),
            &[],
        ),
        tool(
            LAND,
            LAND_DESCRIPTION,
            json!({
                "purpose":{"type":"string","minLength":1,"description":"What the branch changes, in one line, for the train's merge commit and record, such as \"Fed rivers carve their banks\"."}
            }),
            &["purpose"],
        ),
        tool(
            STOP,
            STOP_DESCRIPTION,
            json!({
                "chat": chat,
                "programs":{"type":"array","items":{"type":"integer","minimum":0},"description":"The program numbers pc_status lists for that chat."},
                "background":{"type":"boolean","description":"Also stop the background work its CLI keeps, which ends that CLI until the chat's next reply."}
            }),
            &["chat"],
        ),
        tool(
            MESSAGE,
            MESSAGE_DESCRIPTION,
            json!({
                "chat": chat,
                "message":{"type":"string","minLength":1,"description":"The message."},
                "hand_over":{"type":"boolean","description":"Ask that chat to hand over what it holds for this chat's measurement. Only while this chat holds the computer."}
            }),
            &["chat", "message"],
        ),
    ]
}

/// The same tools as Codex dynamic tools.
pub fn codex_tools() -> Vec<Value> {
    tools()
        .into_iter()
        .map(|mut tool| {
            if let Some(fields) = tool.as_object_mut() {
                fields.remove("_meta");
            }
            tool["type"] = json!("function");
            tool["deferLoading"] = json!(false);
            tool
        })
        .collect()
}

/// The tools the gate is asked about: commands, monitors and every MCP server's tools. A matcher
/// that is more than names is a regular expression to Claude Code, tried anywhere in the name
/// unless anchored, so `BashOutput` would match `Bash`.
pub const GATED: &str = "^(Bash|PowerShell|Monitor|mcp__.+)$";

/// The `hooks` field of a Claude chat's `initialize` request: the gate before commands and MCP
/// tool calls, and the delivery of messages after every call.
pub fn hooks() -> Value {
    json!({
        "PreToolUse":[{"matcher":GATED,"hookCallbackIds":[GATE],"timeout":GATE_TIMEOUT_SECONDS}],
        "PostToolUse":[{"hookCallbackIds":[MESSAGES],"timeout":MESSAGES_TIMEOUT_SECONDS}]
    })
}

/// What a reply waits for in `pc_wait`, as `Broker::wait` tells it, for its time ledger.
pub type Held = Arc<dyn Fn(Option<&'static str>) + Send + Sync>;

/// One reply's reservation tools, gate and messages.
pub struct Session {
    broker: Arc<Broker>,
    conversation: String,
    run_id: String,
    /// The chat's folder as this computer reads it, whose repository a landing turn is.
    folder: Option<std::path::PathBuf>,
    held: Option<Held>,
    tx: mpsc::UnboundedSender<Value>,
    /// Answers to the reply's calls, to write to its CLI as they come.
    pub rx: mpsc::UnboundedReceiver<Value>,
    cancel: CancellationToken,
}

impl Drop for Session {
    fn drop(&mut self) {
        // A call still waiting ends with its reply, and it reads no more messages.
        self.cancel.cancel();
        self.broker.detach(&self.run_id);
    }
}

impl Session {
    pub fn new(broker: Arc<Broker>, conversation: &str, run_id: &str) -> Self {
        broker.attach(run_id, conversation, None);
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            broker,
            conversation: conversation.into(),
            run_id: run_id.into(),
            folder: None,
            held: None,
            tx,
            rx,
            cancel: CancellationToken::new(),
        }
    }

    /// The chat's folder, as this computer reads it.
    pub fn folder(&mut self, folder: Option<std::path::PathBuf>) {
        self.folder = folder;
    }

    /// Where the reply hears what it waits for in `pc_wait`.
    pub fn held(&mut self, held: Held) {
        self.held = Some(held);
    }

    /// Shows the messages this reply reads in its Work history, through `sink`.
    pub fn show(&self, sink: super::Sink) {
        self.broker
            .attach(&self.run_id, &self.conversation, Some(sink));
    }

    /// The Codex thread this reply's own agent works in, whose commands take its messages.
    pub fn thread(&self, thread: &str) {
        self.broker.thread(&self.run_id, thread);
    }

    /// The answer to one of Claude's hooks of these tools: the gate before a command, or the
    /// messages after a call. None for any other line.
    pub fn gate(&self, value: &Value) -> Option<Value> {
        let request = &value["request"];
        if value["type"] != "control_request" || request["subtype"] != "hook_callback" {
            return None;
        }
        let callback = request["callback_id"].as_str()?;
        if callback != GATE && callback != MESSAGES {
            return None;
        }
        let input = &request["input"];
        // A sub-agent's call names its agent: messages are for the chat's own.
        let own = input["agent_id"].as_str().is_none_or(str::is_empty);
        let output = if callback == GATE {
            let refusal = if input["hook_event_name"] == "PreToolUse" {
                // The call's activity identity, as the tool decoder names a Claude call.
                let call = input["tool_use_id"]
                    .as_str()
                    .or_else(|| request["tool_use_id"].as_str())
                    .map(|id| format!("claude:{id}"));
                let tool = input["tool_name"].as_str().unwrap_or_default();
                let wait = "mcp__agent_studio__pc_wait";
                match crate::protocol::activity::mcp_tool(tool) {
                    Some((server, _)) => {
                        self.broker
                            .gate_call(&self.conversation, server, call.as_deref(), wait)
                    }
                    // Agent Studio's own tools, pc_wait among them, answer for themselves.
                    None if tool.starts_with("mcp__") => None,
                    None => {
                        let command = input["tool_input"]["command"].as_str().unwrap_or_default();
                        self.broker
                            .gate(&self.conversation, command, call.as_deref(), wait)
                    }
                }
            } else {
                None
            };
            match refusal {
                Some(mut reason) => {
                    if let Some(messages) = own
                        .then(|| self.broker.deliver(&self.conversation))
                        .flatten()
                    {
                        reason.push_str("\n\n");
                        reason.push_str(&messages);
                    }
                    json!({"hookSpecificOutput":{
                        "hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason
                    }})
                }
                // No opinion: the command runs as it would without the gate.
                None => json!({}),
            }
        } else {
            match own
                .then(|| self.broker.deliver(&self.conversation))
                .flatten()
            {
                Some(messages) => json!({"hookSpecificOutput":{
                    "hookEventName":"PostToolUse","additionalContext":messages
                }}),
                None => json!({}),
            }
        };
        Some(json!({"type":"control_response","response":{
            "subtype":"success","request_id":value["request_id"],"response":output
        }}))
    }

    /// Takes a Claude SDK call of one of these tools, whose answer comes through `rx`. None for
    /// any other line.
    pub fn claude(&self, value: &Value) -> Option<()> {
        let r = &value["request"];
        let m = &r["message"];
        if value["type"] != "control_request"
            || r["subtype"] != "mcp_message"
            || r["server_name"] != "agent_studio"
            || m["method"] != "tools/call"
        {
            return None;
        }
        let name = m["params"]["name"].as_str().filter(|n| NAMES.contains(n))?;
        let (request_id, id) = (value["request_id"].clone(), m["id"].clone());
        self.spawn(name, m["params"]["arguments"].clone(), move |text, error| {
            json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":{"mcp_response":{
                "jsonrpc":"2.0","id":id,"result":{"isError":error,"content":[{"type":"text","text":text}]}
            }}}})
        });
        Some(())
    }

    /// Takes a Codex dynamic call of one of these tools, whose answer comes through `rx`. None
    /// for any other request.
    pub fn codex(&self, value: &Value) -> Option<()> {
        let p = &value["params"];
        if value["method"] != "item/tool/call"
            || !crate::providers::codex_chat::own_namespace(&p["namespace"])
        {
            return None;
        }
        let name = p["tool"].as_str().filter(|n| NAMES.contains(n))?;
        let id = value["id"].clone();
        self.spawn(name, p["arguments"].clone(), move |text, error| {
            json!({"id":id,"result":{"success":!error,"contentItems":[{"type":"inputText","text":text}]}})
        });
        Some(())
    }

    fn spawn(
        &self,
        name: &str,
        args: Value,
        answer: impl FnOnce(String, bool) -> Value + Send + 'static,
    ) {
        let (broker, conversation, run_id) = (
            self.broker.clone(),
            self.conversation.clone(),
            self.run_id.clone(),
        );
        let (tx, cancel, name) = (self.tx.clone(), self.cancel.clone(), name.to_string());
        let context = Context {
            folder: self.folder.clone(),
            held: self.held.clone(),
        };
        tauri::async_runtime::spawn(async move {
            let result = tokio::select! {
                result = act(&broker, &name, &args, &conversation, &run_id, &cancel, &context) => result,
                _ = cancel.cancelled() => return,
            };
            let (text, error) = match result {
                Ok(text) => (text, false),
                Err(error) => (error, true),
            };
            let _ = tx.send(answer(text, error));
        });
    }
}

/// What a reply's calls act with besides their arguments.
struct Context {
    folder: Option<std::path::PathBuf>,
    held: Option<Held>,
}

/// The fields each tool takes.
fn fields(name: &str) -> &'static [&'static str] {
    match name {
        RESERVE => &["purpose", "minutes", "scope", "name", "landing"],
        RELEASE => &["name", "landing"],
        LAND => &["purpose"],
        STOP => &["chat", "programs", "background"],
        // `text` too, as an agent may name the message.
        MESSAGE => &["chat", "message", "hand_over", "text"],
        _ => &[],
    }
}

async fn act(
    broker: &Arc<Broker>,
    name: &str,
    args: &Value,
    conversation: &str,
    run_id: &str,
    cancel: &CancellationToken,
    context: &Context,
) -> Result<String, String> {
    let given = args
        .as_object()
        .map(|o| o.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let allowed = fields(name);
    if let Some(field) = given.iter().find(|f| !allowed.contains(&f.as_str())) {
        return Err(format!(
            "{name} takes no field named {field}.{}",
            if allowed.is_empty() {
                String::new()
            } else {
                format!(" It takes {}.", allowed.join(", "))
            }
        ));
    }
    let chat = || {
        args["chat"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| {
                "Name the chat by its title or its id, as pc_status names it.".to_string()
            })
    };
    // A named reservation, or this chat's landing turn: its key, how it reads, and whether it
    // is a landing.
    let named = || -> Result<Option<(String, String, bool)>, String> {
        if args["landing"] == true {
            let folder = context.folder.as_deref().ok_or(
                "This chat has no project folder, so no repository to land in: name what you reserve with name instead.",
            )?;
            let (key, name) = super::named::landing(folder)?;
            return Ok(Some((key, name, true)));
        }
        Ok(args["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| (super::named::key(n), n.to_string(), false)))
    };
    let result = match name {
        STATUS => {
            let now = broker.now().await;
            Ok(broker.status(conversation, now.as_ref()))
        }
        RESERVE => {
            let purpose = args["purpose"]
                .as_str()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("Say what you will measure in purpose.")?;
            if let Some((key, name, landing)) = named()? {
                return with_messages(
                    broker,
                    conversation,
                    Ok(broker.take_turn(run_id, conversation, &key, &name, landing, purpose)),
                );
            }
            let minutes = args["minutes"]
                .as_f64()
                .filter(|m| m.is_finite() && *m > 0.0);
            let scope = match args["scope"].as_str().map(str::trim) {
                None | Some("") | Some("computer") => super::Scope::Computer,
                Some("gpu") => super::Scope::Gpu,
                Some(other) => {
                    return Err(format!(
                        "scope is \"computer\" or \"gpu\", not \"{other}\"."
                    ))
                }
            };
            let text = broker.reserve_scoped(run_id, conversation, purpose, minutes, scope);
            Ok(match broker.now().await {
                Some(now) => format!(
                    "{text}{}\n{}",
                    broker.left_text(conversation, &now.left),
                    now.text(|c| broker.chat(c))
                ),
                None => text,
            })
        }
        // A wait hands over the messages it ends on itself.
        WAIT => {
            let held = context.held.clone();
            return broker
                .wait(conversation, cancel, &move |reason| {
                    if let Some(held) = &held {
                        held(reason);
                    }
                })
                .await;
        }
        RELEASE => match named()? {
            // A landing turn, and the chat's branch waiting for a merge train.
            Some((key, name, true)) => {
                let turns = broker.release_turns(conversation, Some(&key));
                let cars = broker.withdraw(conversation);
                match (turns, cars) {
                    (None, None) => Err(format!(
                        "This chat holds no turn at {name}, waits for none, and has no branch waiting for a merge train."
                    )),
                    (turns, cars) => Ok([turns, cars].into_iter().flatten().collect::<Vec<_>>().join("\n")),
                }
            }
            Some((key, name, false)) => broker
                .release_turns(conversation, Some(&key))
                .ok_or_else(|| format!("This chat holds no turn at {name}, and waits for none.")),
            None => match broker.hand_over(conversation).await {
                Some(result) => result,
                None => match broker.release(conversation) {
                    Some(report) => Ok(report.text),
                    None => broker
                        .release_turns(conversation, None)
                        .ok_or_else(|| "This chat holds no reservation.".into()),
                },
            },
        },
        LAND => {
            let purpose = args["purpose"]
                .as_str()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("Say in purpose what the branch changes, in one line.")?;
            let folder = context
                .folder
                .as_deref()
                .ok_or("This chat has no project folder, so no branch to land.")?;
            broker.land(conversation, folder, purpose)
        }
        STOP => {
            let programs = match &args["programs"] {
                Value::Null => vec![],
                Value::Array(list) => list
                    .iter()
                    .map(|p| p.as_u64().and_then(|p| u32::try_from(p).ok()))
                    .collect::<Option<Vec<u32>>>()
                    .ok_or("programs takes the program numbers pc_status lists.")?,
                _ => return Err("programs takes the program numbers pc_status lists.".into()),
            };
            let background = args["background"].as_bool().unwrap_or(false);
            broker
                .stop(conversation, chat()?, &programs, background)
                .await
        }
        MESSAGE => {
            let text = args["message"]
                .as_str()
                .or_else(|| args["text"].as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .ok_or("Write the message.")?;
            broker.message(
                conversation,
                chat()?,
                text,
                args["hand_over"].as_bool().unwrap_or(false),
            )
        }
        _ => Err(format!("{name} is not a tool of this computer.")),
    };
    with_messages(broker, conversation, result)
}

/// An answer with the messages waiting for this chat, which come with any answer.
fn with_messages(
    broker: &Broker,
    conversation: &str,
    result: Result<String, String>,
) -> Result<String, String> {
    match (result, broker.deliver(conversation)) {
        (Ok(text), Some(messages)) => Ok(format!("{text}\n\n{messages}")),
        (Err(text), Some(messages)) => Err(format!("{text}\n\n{messages}")),
        (result, None) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> Arc<Broker> {
        Broker::new(
            Box::new(|_| {}),
            Box::new(|c| match c {
                "bench" => Some("Chunk benchmark".to_string()),
                "other" => Some("Level art".to_string()),
                _ => None,
            }),
            Box::new(Vec::new),
            None,
        )
    }
    fn hook(command: &str) -> Value {
        json!({"type":"control_request","request_id":"hook-7","request":{"subtype":"hook_callback","callback_id":GATE,"input":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":command},"tool_use_id":"toolu_1"},"tool_use_id":"toolu_1"}})
    }
    fn after(agent: Option<&str>) -> Value {
        let mut input = json!({"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"a.txt"},"tool_use_id":"toolu_2"});
        if let Some(agent) = agent {
            input["agent_id"] = json!(agent);
        }
        json!({"type":"control_request","request_id":"hook-8","request":{"subtype":"hook_callback","callback_id":MESSAGES,"input":input,"tool_use_id":"toolu_2"}})
    }
    fn call(name: &str, arguments: Value) -> Value {
        json!({"type":"control_request","request_id":"r-1","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":name,"arguments":arguments}}}})
    }
    fn text(answer: &Value) -> (bool, String) {
        let result = &answer["response"]["response"]["mcp_response"]["result"];
        (
            result["isError"] == true,
            result["content"][0]["text"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn tools_and_hooks_are_declared_for_both_agents() {
        let names: Vec<_> = tools()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, NAMES);
        assert_eq!(tools()[2]["_meta"]["anthropic/alwaysLoad"], true);
        assert!(codex_tools()
            .iter()
            .all(|t| t["type"] == "function" && t.get("_meta").is_none()));
        assert_eq!(hooks()["PreToolUse"][0]["hookCallbackIds"][0], GATE);
        assert_eq!(hooks()["PreToolUse"][0]["matcher"], GATED);
        // Claude Code tests a matcher that is more than names as a regular expression.
        let gated = regex::Regex::new(GATED).unwrap();
        for name in [
            "Bash",
            "PowerShell",
            "Monitor",
            "mcp__unreal-mcp__execute_python",
        ] {
            assert!(gated.is_match(name), "{name}");
        }
        for name in ["BashOutput", "Read", "Edit", "mcp__", "WebFetch"] {
            assert!(!gated.is_match(name), "{name}");
        }
        // Messages arrive after any call.
        assert_eq!(hooks()["PostToolUse"][0]["hookCallbackIds"][0], MESSAGES);
        assert!(hooks()["PostToolUse"][0].get("matcher").is_none());
    }

    #[tokio::test]
    async fn the_gate_refuses_other_chats_commands_while_one_holds_the_computer() {
        let broker = broker();
        let other = Session::new(broker.clone(), "other", "run-other");
        let allowed = other.gate(&hook("cargo build")).unwrap();
        assert_eq!(allowed["response"]["request_id"], "hook-7");
        assert_eq!(allowed["response"]["response"], json!({}));
        broker.reserve(
            "run-bench",
            "bench",
            "Benchmark of chunk meshing",
            Some(5.0),
        );
        let refused = other.gate(&hook("cargo build")).unwrap();
        let output = &refused["response"]["response"]["hookSpecificOutput"];
        assert_eq!(output["permissionDecision"], "deny");
        let reason = output["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.contains("the chat \"Chunk benchmark\""), "{reason}");
        assert!(reason.contains("mcp__agent_studio__pc_wait"), "{reason}");
        // Light commands, and the holder's own commands, still run.
        assert_eq!(
            other.gate(&hook("git status")).unwrap()["response"]["response"],
            json!({})
        );
        let holder = Session::new(broker.clone(), "bench", "run-bench");
        assert_eq!(
            holder.gate(&hook("cargo build")).unwrap()["response"]["response"],
            json!({})
        );
        // Other callbacks are not these tools'.
        let mut other_callback = hook("cargo build");
        other_callback["request"]["callback_id"] = json!("studio-after-compaction-0");
        assert!(other.gate(&other_callback).is_none());
    }

    #[tokio::test]
    async fn the_gate_refuses_other_chats_mcp_calls_but_not_agent_studio_s_own() {
        let broker = broker();
        let other = Session::new(broker.clone(), "other", "run-other");
        let mcp = |tool: &str| {
            let mut value = hook("");
            value["request"]["input"]["tool_name"] = json!(tool);
            value["request"]["input"]["tool_input"] = json!({"code":"print(1)"});
            value
        };
        let editor = mcp("mcp__unreal-mcp__execute_python");
        assert_eq!(
            other.gate(&editor).unwrap()["response"]["response"],
            json!({})
        );
        broker.reserve("run-bench", "bench", "Frame timing", None);
        let refused = other.gate(&editor).unwrap();
        let output = &refused["response"]["response"]["hookSpecificOutput"];
        assert_eq!(output["permissionDecision"], "deny");
        let reason = output["permissionDecisionReason"].as_str().unwrap();
        assert!(reason.starts_with("This tool call did not run"), "{reason}");
        assert!(reason.contains("mcp__agent_studio__pc_wait"), "{reason}");
        // The tool it must call to wait, connectors that run elsewhere and the holder's own
        // calls go ahead.
        for tool in [
            "mcp__agent_studio__pc_wait",
            "mcp__claude_ai_Linear__list_issues",
        ] {
            assert_eq!(
                other.gate(&mcp(tool)).unwrap()["response"]["response"],
                json!({}),
                "{tool}"
            );
        }
        let holder = Session::new(broker.clone(), "bench", "run-bench");
        assert_eq!(
            holder.gate(&editor).unwrap()["response"]["response"],
            json!({})
        );
    }

    #[tokio::test]
    async fn a_message_reaches_the_chat_s_own_agent_after_its_next_call() {
        // "other" keeps a server running, so it stays known once its reply ends.
        let broker = Broker::new(
            Box::new(|_| {}),
            Box::new(|c| match c {
                "bench" => Some("Chunk benchmark".to_string()),
                "other" => Some("Level art".to_string()),
                _ => None,
            }),
            Box::new(|| {
                vec![super::super::BackgroundWork {
                    conversation: "other".into(),
                    id: "claude:serve".into(),
                    label: "npm run dev".into(),
                }]
            }),
            None,
        );
        broker.run_started("run-bench", "bench");
        broker.run_started("run-other", "other");
        let reader = Session::new(broker.clone(), "other", "run-other");
        let shown = Arc::new(std::sync::Mutex::new(vec![]));
        let seen = shown.clone();
        reader.show(Arc::new(move |tool| seen.lock().unwrap().push(tool)));
        // Nothing to read: no opinion.
        assert_eq!(
            reader.gate(&after(None)).unwrap()["response"]["response"],
            json!({})
        );
        let sent = broker
            .message("bench", "Level art", "Are you done with the editor?", false)
            .unwrap();
        assert!(
            sent.starts_with("Sent: the chat \"Level art\" (id other) reads it"),
            "{sent}"
        );
        // A sub-agent's call leaves it for the chat's own agent.
        assert_eq!(
            reader.gate(&after(Some("agent-1"))).unwrap()["response"]["response"],
            json!({})
        );
        let answer = reader.gate(&after(None)).unwrap();
        let output = &answer["response"]["response"]["hookSpecificOutput"];
        assert_eq!(output["hookEventName"], "PostToolUse");
        let context = output["additionalContext"].as_str().unwrap();
        assert!(
            context.starts_with("A message from the chat \"Chunk benchmark\" (id bench), another agent working on this computer (not the user): Are you done with the editor?"),
            "{context}"
        );
        // It shows in the reply's Work history, and is read once.
        let tools = shown.lock().unwrap().clone();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "Message from another chat");
        assert_eq!(
            tools[0].detail(),
            Some("the chat \"Chunk benchmark\" (id bench)")
        );
        assert_eq!(
            reader.gate(&after(None)).unwrap()["response"]["response"],
            json!({})
        );
        // A chat that is not replying cannot read one.
        let refused = broker
            .message("bench", "nobody", "Hello", false)
            .unwrap_err();
        assert!(refused.starts_with("No chat named \"nobody\""), "{refused}");
        broker.run_ended("run-other");
        let idle = broker
            .message("bench", "other", "Hello", false)
            .unwrap_err();
        assert!(idle.contains("is not replying now"), "{idle}");
    }

    #[tokio::test]
    async fn calls_answer_through_the_channel_and_waits_end_when_the_computer_is_free() {
        let broker = broker();
        let mut bench = Session::new(broker.clone(), "bench", "run-bench");
        let mut other = Session::new(broker.clone(), "other", "run-other");
        bench
            .claude(&call(
                RESERVE,
                json!({"purpose":"Benchmark of chunk meshing"}),
            ))
            .unwrap();
        let (error, reserved) = text(&bench.rx.recv().await.unwrap());
        assert!(!error && reserved.starts_with("Reserved"), "{reserved}");
        // The window opens at once: no other chat runs anything.
        bench.claude(&call(WAIT, json!({}))).unwrap();
        let (_, opened) = text(&bench.rx.recv().await.unwrap());
        assert!(opened.starts_with("The window is open"), "{opened}");
        // Another chat's wait ends once the holder releases.
        other.claude(&call(WAIT, json!({}))).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(other.rx.try_recv().is_err());
        assert_eq!(broker.snapshot().reservations[0].held, 1);
        bench.claude(&call(RELEASE, json!({}))).unwrap();
        let (_, report) = text(&bench.rx.recv().await.unwrap());
        assert!(
            report.starts_with("Released the computer (reserved for: Benchmark of chunk meshing)."),
            "{report}"
        );
        let (_, free) = text(&other.rx.recv().await.unwrap());
        assert!(
            free.starts_with("The computer is free again after"),
            "{free}"
        );
        // Fields a tool does not take are refused with what it takes.
        bench
            .claude(&call(RESERVE, json!({"purpose":"x","seconds":3})))
            .unwrap();
        let (error, refusal) = text(&bench.rx.recv().await.unwrap());
        assert!(
            error
                && refusal.contains(
                    "no field named seconds. It takes purpose, minutes, scope, name, landing."
                ),
            "{refusal}"
        );
        bench
            .claude(&call(STOP, json!({"chat":"Level art","programs":["x"]})))
            .unwrap();
        let (error, refusal) = text(&bench.rx.recv().await.unwrap());
        assert!(error && refusal.contains("program numbers"), "{refusal}");
        // Other servers' and other tools' calls are left to their own handlers.
        let mut foreign = call(WAIT, json!({}));
        foreign["request"]["server_name"] = json!("linear");
        assert!(bench.claude(&foreign).is_none());
        assert!(bench.claude(&call("visualize", json!({}))).is_none());
    }

    #[tokio::test]
    async fn codex_calls_answer_in_its_own_shape_and_a_reply_that_ends_stops_its_wait() {
        let broker = broker();
        let codex = Session::new(broker.clone(), "other", "run-other");
        broker.reserve("run-bench", "bench", "Profile", None);
        let request = json!({"id":12,"method":"item/tool/call","params":{"threadId":"t","tool":WAIT,"namespace":"agent_studio","arguments":{}}});
        codex.codex(&request).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(broker.snapshot().reservations[0].held, 1);
        drop(codex);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(broker.snapshot().reservations[0].held, 0);
        let mut codex = Session::new(broker.clone(), "other", "run-other-2");
        codex.codex(&json!({"id":13,"method":"item/tool/call","params":{"threadId":"t","tool":STATUS,"arguments":{}}})).unwrap();
        let answer = codex.rx.recv().await.unwrap();
        assert_eq!(answer["id"], 13);
        assert_eq!(answer["result"]["success"], true);
        let status = answer["result"]["contentItems"][0]["text"]
            .as_str()
            .unwrap();
        assert!(
            status.starts_with(
                "The chat \"Chunk benchmark\" (id bench) holds the computer (Profile)"
            ),
            "{status}"
        );
        // A tool of another namespace is not this one.
        assert!(codex.codex(&json!({"id":14,"method":"item/tool/call","params":{"tool":WAIT,"namespace":"linear","arguments":{}}})).is_none());
    }
}
