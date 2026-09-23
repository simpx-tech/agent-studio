//! Background work that keeps a Claude reply open. The CLI re-invokes the model when a
//! background task finishes, so a turn can end while the requested work continues.
//! Background agents and workflows hold a reply implicitly, but a background shell may be
//! a server left running for the user. The model therefore declares the tasks it waits
//! for, and the reply ends only after the model has received each declared outcome.
use serde_json::{json, Value};
use std::collections::HashMap;

pub const TOOL: &str = "await_background_tasks";
const CLAUDE_NAME: &str = "mcp__agent_studio__await_background_tasks";
pub const DESCRIPTION: &str = "Keep your reply open while you wait for background tasks you started. Agent Studio tells the user that a reply is finished when your turn ends, so call this right before ending a turn in which you wait for finite background work whose results you still need: tests, builds, type checks, installs, migrations or CI polling started with run_in_background or Monitor. Pass their task IDs, then end your turn: you are re-invoked when each task finishes, and the reply completes after your final turn. Never pass servers, watchers or an app you launched for the user to try; they keep running after the reply ends. Background agents and workflows are awaited automatically.";
const MAX_IDS: usize = 8;
const MAX_TASKS: usize = 256;
const MAX_AWAITED: usize = 32;
const MAX_REQUESTS: usize = 16;

pub fn tool() -> Value {
    json!({"name":TOOL,"description":DESCRIPTION,"inputSchema":{
        "type":"object","properties":{"task_ids":{"type":"array","minItems":1,"maxItems":MAX_IDS,
            "items":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9_-]+$"},
            "description":"IDs of running background tasks from this reply, as reported when each started."}},
        "required":["task_ids"],"additionalProperties":false},
        "annotations":{"readOnlyHint":true},
        // Deferred tools show only their name; this description matters as a turn ends.
        "_meta":{"anthropic/alwaysLoad":true}})
}

struct Task {
    /// The tool call that launched the task.
    call: String,
    /// The parent's launching call returned while the task kept running.
    background: bool,
    running: bool,
}

/// Declared background tasks of one reply, and whether a model turn is in progress.
#[derive(Default)]
pub struct AwaitedTasks {
    tasks: HashMap<String, Task>,
    /// Declared tasks; true once finished but not yet delivered to the model.
    awaited: HashMap<String, bool>,
    /// Parent calls of this tool, matched to their MCP request by input.
    requests: HashMap<String, Value>,
    idle: bool,
}

impl AwaitedTasks {
    pub fn observe(&mut self, value: &Value) {
        let parent = value["parent_tool_use_id"].is_null();
        let blocks = value["message"]["content"].as_array().into_iter().flatten();
        match value["type"].as_str().unwrap_or_default() {
            "result" if parent => self.idle = true,
            "stream_event" if parent => self.turn_started(),
            "assistant" if parent => {
                self.turn_started();
                for block in blocks {
                    if block["type"] == "tool_use"
                        && block["name"] == CLAUDE_NAME
                        && self.requests.len() < MAX_REQUESTS
                    {
                        if let Some(id) = bounded(&block["id"], 240) {
                            self.requests.insert(id, block["input"].clone());
                        }
                    }
                }
            }
            "user" if parent => {
                self.turn_started();
                if let Some(text) = value["message"]["content"].as_str() {
                    self.delivered(text);
                }
                for block in blocks {
                    if let Some(text) = block["text"].as_str() {
                        self.delivered(text);
                    }
                    let Some(call) = block["tool_use_id"].as_str() else {
                        continue;
                    };
                    self.requests.remove(call);
                    // A launch that returns while its task runs moved the task to the
                    // background. A foreground task returns only after it finished.
                    for task in self.tasks.values_mut() {
                        if task.running && task.call == call {
                            task.background = true;
                        }
                    }
                }
            }
            "system" => match value["subtype"].as_str().unwrap_or_default() {
                "init" if parent => self.turn_started(),
                "task_started" => self.started(value),
                "task_notification" => self.finished(value, value["status"].as_str()),
                "task_updated" => self.finished(
                    value,
                    value["patch"]["status"]
                        .as_str()
                        .filter(|status| !matches!(*status, "running" | "pending")),
                ),
                _ => {}
            },
            _ => {}
        }
    }
    fn turn_started(&mut self) {
        if std::mem::take(&mut self.idle) {
            // A turn the CLI starts receives every queued notification of a finished task.
            self.awaited.retain(|_, finished| !*finished);
        }
    }
    fn started(&mut self, value: &Value) {
        let (Some(id), Some(call)) = (
            bounded(&value["task_id"], 64),
            bounded(&value["tool_use_id"], 240),
        ) else {
            return;
        };
        if self.tasks.len() >= MAX_TASKS {
            self.tasks.retain(|_, task| task.running);
        }
        if self.tasks.len() < MAX_TASKS {
            let task = Task {
                call,
                background: false,
                running: true,
            };
            self.tasks.insert(id, task);
        }
    }
    fn finished(&mut self, value: &Value, status: Option<&str>) {
        let (Some(id), Some(status)) = (value["task_id"].as_str(), status) else {
            return;
        };
        if let Some(task) = self.tasks.get_mut(id) {
            task.running = false;
        }
        match self.awaited.get_mut(id) {
            // The CLI re-invokes the model with the outcome; a stopped task wakes nobody.
            Some(finished) if matches!(status, "completed" | "failed") => *finished = true,
            Some(_) => {
                self.awaited.remove(id);
            }
            None => {}
        }
    }
    /// Finished-task notifications injected into the running turn, replayed on stdout.
    fn delivered(&mut self, text: &str) {
        if !text.trim_start().starts_with("<task-notification>") {
            return;
        }
        for part in text.split("<task-id>").skip(1).take(16) {
            if let Some(id) = part.split("</task-id>").next() {
                self.awaited.remove(id.trim());
            }
        }
    }
    /// Declared tasks hold the reply until the model has received their outcome.
    pub fn holds_reply(&self) -> bool {
        !self.awaited.is_empty()
    }
    pub fn turn_active(&self) -> bool {
        !self.idle
    }
    /// Only finished declared tasks remain, and no turn has started to deliver them.
    pub fn expects_follow_up(&self) -> bool {
        self.idle && !self.awaited.is_empty() && self.awaited.values().all(|finished| *finished)
    }
    /// The CLI started no turn for the finished tasks, so the model already has them.
    pub fn release(&mut self) {
        self.awaited.clear();
    }
    pub fn running(&self) -> impl Iterator<Item = &str> {
        self.awaited
            .iter()
            .filter(|(_, finished)| !**finished)
            .map(|(id, _)| id.as_str())
    }
    pub fn claude_response(&mut self, value: &Value) -> Option<Value> {
        let request = &value["request"];
        let message = &request["message"];
        if request["subtype"] != "mcp_message"
            || request["server_name"] != "agent_studio"
            || message["method"] != "tools/call"
            || message["params"]["name"] != TOOL
        {
            return None;
        }
        let arguments = &message["params"]["arguments"];
        let call = self
            .requests
            .iter()
            .find(|(_, input)| *input == arguments)
            .map(|(id, _)| id.clone());
        let (error, text) = match call {
            Some(call) => {
                self.requests.remove(&call);
                self.register(arguments)
            }
            None => (
                true,
                "Only this reply's parent conversation can wait for background tasks.".into(),
            ),
        };
        Some(
            json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"mcp_response":{"jsonrpc":"2.0","id":message["id"],"result":{"isError":error,"content":[{"type":"text","text":text}]}}}}}),
        )
    }
    fn register(&mut self, arguments: &Value) -> (bool, String) {
        let Some(ids) = task_ids(arguments) else {
            return (
                true,
                "Provide task_ids with one to eight background task IDs.".into(),
            );
        };
        let (mut waiting, mut finished, mut unknown) = (vec![], vec![], vec![]);
        for id in ids {
            match self.tasks.get(&id) {
                Some(task)
                    if task.running
                        && task.background
                        && (self.awaited.len() < MAX_AWAITED || self.awaited.contains_key(&id)) =>
                {
                    self.awaited.insert(id.clone(), false);
                    waiting.push(id);
                }
                Some(task) if !task.running => finished.push(id),
                _ => unknown.push(id),
            }
        }
        let mut text = vec![];
        if !waiting.is_empty() {
            text.push(format!("Agent Studio will keep this reply open until {} finish. End your turn now instead of waiting in the foreground; you will be re-invoked with each result.", waiting.join(", ")));
        }
        if !finished.is_empty() {
            text.push(format!(
                "Already finished: {}. Read the output before you end your turn.",
                finished.join(", ")
            ));
        }
        if !unknown.is_empty() {
            let mut running: Vec<_> = self
                .tasks
                .iter()
                .filter(|(_, task)| task.running && task.background)
                .map(|(id, _)| id.as_str())
                .collect();
            running.sort_unstable();
            running.truncate(MAX_IDS);
            text.push(format!(
                "Not a running background task started in this reply: {}. Running background tasks: {}.",
                unknown.join(", "),
                if running.is_empty() { "none".into() } else { running.join(", ") }
            ));
        }
        (waiting.is_empty(), text.join(" "))
    }
}

fn bounded(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max)
        .map(String::from)
}

fn task_ids(arguments: &Value) -> Option<Vec<String>> {
    let object = arguments.as_object().filter(|o| o.len() == 1)?;
    let ids = object
        .get("task_ids")?
        .as_array()
        .filter(|ids| (1..=MAX_IDS).contains(&ids.len()))?;
    let mut valid: Vec<String> = vec![];
    for id in ids {
        let id = id.as_str().filter(|id| {
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })?;
        if !valid.iter().any(|v| v == id) {
            valid.push(id.into());
        }
    }
    Some(valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(state: &mut AwaitedTasks, task: &str, call: &str) {
        state.observe(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":call,"name":"Bash","input":{"command":"x","run_in_background":true}}]}}));
        state.observe(&json!({"type":"system","subtype":"task_started","task_id":task,"tool_use_id":call,"task_type":"local_bash"}));
        state.observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":call,"content":"Command running in background"}]},"tool_use_result":{"backgroundTaskId":task}}));
    }
    fn declare(state: &mut AwaitedTasks, call: &str, input: Value) -> Value {
        state.observe(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":call,"name":CLAUDE_NAME,"input":input}]}}));
        call_tool(state, input)
    }
    fn call_tool(state: &mut AwaitedTasks, input: Value) -> Value {
        let response = state.claude_response(&json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":TOOL,"arguments":input}}}})).unwrap();
        response["response"]["response"]["mcp_response"]["result"].clone()
    }
    fn result() -> Value {
        json!({"type":"result","subtype":"success","parent_tool_use_id":null})
    }
    fn notification(task: &str, status: &str) -> Value {
        json!({"type":"system","subtype":"task_notification","task_id":task,"status":status})
    }

    #[test]
    fn declared_tests_hold_the_reply_until_their_follow_up_turn_but_servers_do_not() {
        let mut state = AwaitedTasks::default();
        launch(&mut state, "server", "server-call");
        launch(&mut state, "tests", "tests-call");
        let accepted = declare(&mut state, "await", json!({"task_ids":["tests"]}));
        assert_eq!(accepted["isError"], false);
        assert!(accepted["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("until tests finish"));
        state.observe(&result());
        assert!(state.holds_reply() && !state.expects_follow_up() && !state.turn_active());
        assert_eq!(state.running().collect::<Vec<_>>(), ["tests"]);
        state.observe(&json!({"type":"system","subtype":"task_updated","task_id":"tests","patch":{"status":"completed"}}));
        state.observe(&notification("tests", "completed"));
        assert!(state.holds_reply() && state.expects_follow_up());
        state.observe(&json!({"type":"system","subtype":"init","parent_tool_use_id":null}));
        assert!(state.turn_active() && !state.holds_reply());
        state.observe(&result());
        assert!(!state.holds_reply(), "the server never holds the reply");
    }

    #[test]
    fn injected_notifications_release_and_undelivered_ones_expect_a_turn() {
        for (replayed, blocks) in [(true, false), (true, true), (false, false)] {
            let mut state = AwaitedTasks::default();
            launch(&mut state, "tests", "tests-call");
            declare(&mut state, "await", json!({"task_ids":["tests"]}));
            state.observe(&notification("tests", "completed"));
            if replayed {
                let text = "<task-notification>\n<task-id>tests</task-id>\n<status>completed</status>\n</task-notification>";
                let content = if blocks {
                    json!([{"type":"text","text":text}])
                } else {
                    json!(text)
                };
                state.observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":content}}));
            }
            state.observe(&result());
            assert_eq!(state.holds_reply(), !replayed);
            assert_eq!(state.expects_follow_up(), !replayed);
            state.release();
            assert!(!state.holds_reply());
        }
    }

    #[test]
    fn stopped_tasks_and_ordinary_user_text_do_not_deliver_or_hold() {
        let mut state = AwaitedTasks::default();
        launch(&mut state, "tests", "tests-call");
        launch(&mut state, "build", "build-call");
        declare(&mut state, "await", json!({"task_ids":["tests","build"]}));
        state.observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":"Please mention <task-id>tests</task-id>"}}));
        state.observe(&json!({"type":"system","subtype":"task_updated","task_id":"tests","patch":{"status":"killed"}}));
        state.observe(&notification("tests", "stopped"));
        state.observe(&result());
        assert_eq!(state.running().collect::<Vec<_>>(), ["build"]);
        state.observe(&notification("build", "failed"));
        assert!(
            state.expects_follow_up(),
            "a failed task still reports to the model"
        );
    }

    #[test]
    fn rejects_foreign_foreground_finished_invalid_and_unregistered_requests() {
        let mut state = AwaitedTasks::default();
        launch(&mut state, "tests", "tests-call");
        assert_eq!(
            call_tool(&mut state, json!({"task_ids":["tests"]}))["isError"],
            true,
            "a request needs its parent tool call"
        );
        state.observe(&json!({"type":"assistant","parent_tool_use_id":"agent","message":{"content":[{"type":"tool_use","id":"child","name":CLAUDE_NAME,"input":{"task_ids":["tests"]}}]}}));
        assert_eq!(
            call_tool(&mut state, json!({"task_ids":["tests"]}))["isError"],
            true
        );
        // A child's background shell and a running foreground command cannot hold the reply.
        state.observe(&json!({"type":"system","subtype":"task_started","task_id":"child-task","tool_use_id":"child-call","task_type":"local_bash"}));
        state.observe(&json!({"type":"user","parent_tool_use_id":"agent","message":{"content":[{"type":"tool_result","tool_use_id":"child-call","content":"running"}]}}));
        state.observe(&json!({"type":"system","subtype":"task_started","task_id":"foreground","tool_use_id":"fg-call","task_type":"local_bash"}));
        let rejected = declare(
            &mut state,
            "await-1",
            json!({"task_ids":["child-task","foreground","missing"]}),
        );
        assert_eq!(rejected["isError"], true);
        assert!(rejected["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Running background tasks: tests."));
        state.observe(&notification("tests", "completed"));
        let finished = declare(&mut state, "await-2", json!({"task_ids":["tests","tests"]}));
        assert_eq!(finished["isError"], true);
        assert!(finished["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Already finished: tests."));
        for input in [
            json!({"task_ids":[]}),
            json!({"task_ids":["a","b","c","d","e","f","g","h","i"]}),
            json!({"task_ids":["bad id"]}),
            json!({"task_ids":["tests"],"extra":true}),
            json!({"task_ids":"tests"}),
        ] {
            assert_eq!(declare(&mut state, "invalid", input)["isError"], true);
        }
        assert!(!state.holds_reply());
        assert!(state
            .claude_response(&json!({"request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"method":"tools/call","params":{"name":"visualize"}}}}))
            .is_none());
    }

    #[test]
    fn the_tool_is_always_loaded_and_read_only() {
        let tool = tool();
        assert_eq!(tool["name"], TOOL);
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(tool["inputSchema"]["properties"]["task_ids"]["maxItems"], 8);
    }
}
