//! The tools a chat reserves this computer with (`pc_status`, `pc_reserve`, `pc_wait` and
//! `pc_release`), as SDK tools of Claude's agent_studio server and Codex dynamic tools, and the
//! hook Claude chats run before each command (`Session::gate`), which refuses other chats'
//! commands while one holds the computer. The tools act for the conversation whose CLI calls
//! them, its sub-agents included, since a sub-agent may measure too. `pc_wait` waits as long as
//! the computer stays reserved, so every answer goes back through `Session::rx`, which the reply's
//! loop writes to the CLI, and never holds up the loop meanwhile.
use super::Broker;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const STATUS: &str = "pc_status";
pub const RESERVE: &str = "pc_reserve";
pub const WAIT: &str = "pc_wait";
pub const RELEASE: &str = "pc_release";
pub const NAMES: [&str; 4] = [STATUS, RESERVE, WAIT, RELEASE];
/// The hook callback that holds other chats' commands.
const GATE: &str = "studio-pc-gate";
/// How long the CLI waits for the gate. A running reply answers at once. A process parked between
/// replies has nobody to answer, so a command a turn of its own starts goes ahead after this.
const GATE_TIMEOUT_SECONDS: u64 = 30;

pub const GUIDANCE: &str = "Chats run side by side on this computer. To measure performance (a benchmark, profiling or a timing run), reserve the computer first with pc_reserve, wait for its window with pc_wait, measure, and release it with pc_release right after (Claude: mcp__agent_studio__pc_reserve, mcp__agent_studio__pc_wait, mcp__agent_studio__pc_release; pc_status shows what runs on the computer now). Never reserve it for ordinary builds, tests or runs. When a command of yours is refused because another chat reserved the computer, call pc_wait, then run the command again.";

const STATUS_DESCRIPTION: &str = "Show whether this computer is reserved for a performance measurement and by which chat, what other chats run on it now (commands and background work, and whether each finishes by itself), and its busiest and largest programs with whose they are: a chat's, Agent Studio's, the system's, or the user's own (\"yours\"). Call it before pc_reserve.";
const RESERVE_DESCRIPTION: &str = "Reserve this computer for a performance measurement (a benchmark, profiling or a timing run) so that no other chat's work disturbs it. Chats otherwise work side by side: reserve only to measure performance, never for an ordinary build, test or game run. Before reserving, build, cook and prepare everything, and call pc_status: if programs the user started (\"yours\") use much CPU or memory, ask the user with studio_ask_user whether to close them or measure anyway, before reserving, so that no chat waits on the answer. From the moment you reserve, other chats' new commands wait, except light ones such as git status, and the commands they already run finish first. Then call pc_wait, which returns once the window opens; measure at once (warm up, run several times), call pc_release right after capturing, and analyze afterwards, since other chats wait until you release. Reservations take turns, and one ends by itself when this reply ends.";
const WAIT_DESCRIPTION: &str = "Wait for this computer, as long as it takes. When this chat holds a reservation, it returns once its window opens: no other chat runs a command then. Otherwise it returns once no other chat holds the computer: call it when a command of yours was refused because another chat reserved the computer, then run the command again.";
const RELEASE_DESCRIPTION: &str = "End this chat's reservation of the computer, right after measuring, so other chats go on. Returns a report: what kept the window closed and for how long, other chats' work that ran while it was open, how busy the computer was (this chat's processes apart from everything else, with the busiest other programs and whose they are), and how long other chats waited because of it. Read it before trusting the numbers: when something else used the computer during the window, say so and offer to measure again.";

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
    vec![
        tool(STATUS, STATUS_DESCRIPTION, json!({}), &[]),
        tool(
            RESERVE,
            RESERVE_DESCRIPTION,
            json!({
                "purpose":{"type":"string","minLength":1,"description":"What you will measure, in a few words, such as \"Benchmark of chunk meshing, Development build\"."},
                "minutes":{"type":"number","exclusiveMinimum":0,"description":"About how many minutes the measurement takes once its window opens."}
            }),
            &["purpose"],
        ),
        wait,
        tool(RELEASE, RELEASE_DESCRIPTION, json!({}), &[]),
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

/// The `hooks` field of a Claude chat's `initialize` request that runs the gate before commands.
pub fn hooks() -> Value {
    json!({"PreToolUse":[{"matcher":"Bash|PowerShell|Monitor","hookCallbackIds":[GATE],"timeout":GATE_TIMEOUT_SECONDS}]})
}

/// One reply's reservation tools and gate.
pub struct Session {
    broker: Arc<Broker>,
    conversation: String,
    run_id: String,
    tx: mpsc::UnboundedSender<Value>,
    /// Answers to the reply's calls, to write to its CLI as they come.
    pub rx: mpsc::UnboundedReceiver<Value>,
    cancel: CancellationToken,
}

impl Drop for Session {
    fn drop(&mut self) {
        // A call still waiting ends with its reply.
        self.cancel.cancel();
    }
}

impl Session {
    pub fn new(broker: Arc<Broker>, conversation: &str, run_id: &str) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            broker,
            conversation: conversation.into(),
            run_id: run_id.into(),
            tx,
            rx,
            cancel: CancellationToken::new(),
        }
    }

    /// The answer to Claude's gate hook before a command, or None for any other line.
    pub fn gate(&self, value: &Value) -> Option<Value> {
        let request = &value["request"];
        if value["type"] != "control_request"
            || request["subtype"] != "hook_callback"
            || request["callback_id"] != GATE
        {
            return None;
        }
        let input = &request["input"];
        let refusal = if input["hook_event_name"] == "PreToolUse" {
            let command = input["tool_input"]["command"].as_str().unwrap_or_default();
            // The call's activity identity, as the tool decoder names a Claude call.
            let call = input["tool_use_id"]
                .as_str()
                .or_else(|| request["tool_use_id"].as_str())
                .map(|id| format!("claude:{id}"));
            self.broker.gate(
                &self.conversation,
                command,
                call.as_deref(),
                "mcp__agent_studio__pc_wait",
            )
        } else {
            None
        };
        let output = match refusal {
            Some(reason) => json!({"hookSpecificOutput":{
                "hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason
            }}),
            // No opinion: the command runs as it would without the gate.
            None => json!({}),
        };
        Some(json!({"type":"control_response","response":{
            "subtype":"success","request_id":value["request_id"],"response":output
        }}))
    }

    /// Takes a Claude SDK call of a reservation tool, whose answer comes through `rx`. None for
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

    /// Takes a Codex dynamic call of a reservation tool, whose answer comes through `rx`. None
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
        tauri::async_runtime::spawn(async move {
            let result = tokio::select! {
                result = act(&broker, &name, &args, &conversation, &run_id, &cancel) => result,
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

async fn act(
    broker: &Arc<Broker>,
    name: &str,
    args: &Value,
    conversation: &str,
    run_id: &str,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let fields = args
        .as_object()
        .map(|o| o.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let allowed: &[&str] = if name == RESERVE {
        &["purpose", "minutes"]
    } else {
        &[]
    };
    if let Some(field) = fields.iter().find(|f| !allowed.contains(&f.as_str())) {
        return Err(format!(
            "{name} takes no field named {field}.{}",
            if name == RESERVE {
                " Pass purpose and, optionally, minutes."
            } else {
                ""
            }
        ));
    }
    match name {
        STATUS => {
            let now = super::machine::now(broker.jobs.members()).await;
            Ok(broker.status(conversation, now.as_ref()))
        }
        RESERVE => {
            let purpose = args["purpose"]
                .as_str()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("Say what you will measure in purpose.")?;
            let minutes = args["minutes"]
                .as_f64()
                .filter(|m| m.is_finite() && *m > 0.0);
            let text = broker.reserve(run_id, conversation, purpose, minutes);
            Ok(match super::machine::now(broker.jobs.members()).await {
                Some(now) => format!("{text}\n{}", now.text(|c| broker.chat(c))),
                None => text,
            })
        }
        WAIT => broker.wait(conversation, cancel).await,
        RELEASE => broker
            .release(conversation)
            .map(|report| report.text)
            .ok_or_else(|| "This chat holds no reservation.".into()),
        _ => Err(format!("{name} is not a tool of this computer.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> Arc<Broker> {
        Broker::new(
            Box::new(|_| {}),
            Box::new(|c| (c == "bench").then(|| "Chunk benchmark".to_string())),
            Box::new(Vec::new),
            None,
        )
    }
    fn hook(command: &str) -> Value {
        json!({"type":"control_request","request_id":"hook-7","request":{"subtype":"hook_callback","callback_id":GATE,"input":{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":command},"tool_use_id":"toolu_1"},"tool_use_id":"toolu_1"}})
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
    fn tools_and_the_gate_hook_are_declared_for_both_agents() {
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
        assert_eq!(
            hooks()["PreToolUse"][0]["matcher"],
            "Bash|PowerShell|Monitor"
        );
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
        // Other callbacks are not the gate's.
        let mut other_callback = hook("cargo build");
        other_callback["request"]["callback_id"] = json!("studio-after-compaction-0");
        assert!(other.gate(&other_callback).is_none());
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
            error && refusal.contains("no field named seconds"),
            "{refusal}"
        );
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
            status.starts_with("The chat \"Chunk benchmark\" holds the computer (Profile)"),
            "{status}"
        );
        // A tool of another namespace is not this one.
        assert!(codex.codex(&json!({"id":14,"method":"item/tool/call","params":{"tool":WAIT,"namespace":"linear","arguments":{}}})).is_none());
    }
}
