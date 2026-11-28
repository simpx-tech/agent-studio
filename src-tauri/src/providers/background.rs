//! Background work that keeps a Claude reply open. The CLI re-invokes the model when a
//! background task finishes, so a turn can end while the requested work continues.
//! Background agents and workflows hold a reply implicitly, but a background shell may be
//! a server left running for the user. The model therefore declares the tasks it waits
//! for, and the reply ends only after the model has received each declared outcome.
//!
//! Claude Code names each task's run (`run_id`) and the run whose report a turn it starts
//! answers (the result's `origin.runId`). A turn it starts is not always the report of a
//! finished task: a monitor's event takes its own turn, even with that report already
//! queued, and reports that arrive together share one turn, each but the last ending first
//! with an empty result. So a declared task counts as reported only by the result naming its
//! run, or by its notification replayed inside a turn (requested 2026-11-25, after replies
//! ended at a monitor's event and at such an empty result while their work went on unseen).
use serde_json::{json, Value};
use std::collections::HashMap;

pub const TOOL: &str = "await_background_tasks";
const CLAUDE_NAME: &str = "mcp__agent_studio__await_background_tasks";
pub const DESCRIPTION: &str = "Keep your reply open while you wait for background tasks you started. Agent Studio tells the user that a reply is finished when your turn ends, so call this right before ending a turn in which you wait for finite background work whose results you still need: tests, builds, type checks, installs, migrations or CI polling started with run_in_background or Monitor. Pass their IDs in task_ids, then end your turn: you are re-invoked when each task finishes, and the reply completes after your final turn. Never pass servers, watchers or an app you launched for the user to try; they keep running after the reply ends. Background agents and Workflow tool runs are awaited automatically. An Agent Studio workflow run (workflow_run, dynamic_start) is not: wait for one with workflow_status and wait: true before you end your turn.";
/// Said of an ID that is an Agent Studio workflow run's rather than a background task's.
const WORKFLOW_RUN: &str = "An Agent Studio workflow run is waited for with workflow_status and wait: true, which answers once the run has ended.";

pub fn tool() -> Value {
    json!({"name":TOOL,"description":DESCRIPTION,"inputSchema":{
        "type":"object","properties":{"task_ids":{"type":"array","minItems":1,
            "items":{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9_-]+$"},
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
    /// The CLI's run of the task, which the turn reporting it names (`origin.runId`).
    run: Option<String>,
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
    /// The last result was an empty one for a notification, which the CLI carries into the
    /// turn it starts next.
    folded: bool,
}

impl AwaitedTasks {
    pub fn observe(&mut self, value: &Value) {
        let parent = value["parent_tool_use_id"].is_null();
        let blocks = value["message"]["content"].as_array().into_iter().flatten();
        match value["type"].as_str().unwrap_or_default() {
            "result" if parent => self.turn_ended(value),
            "stream_event" if parent => self.turn_started(),
            "assistant" if parent => {
                self.turn_started();
                for block in blocks {
                    if block["type"] == "tool_use" && block["name"] == CLAUDE_NAME {
                        if let Some(id) = filled(&block["id"]) {
                            self.requests.insert(id, block["input"].clone());
                        }
                    }
                }
            }
            "user" if parent => {
                self.turn_started();
                // A notification injected into the running turn, replayed with its run.
                if let Some(run) = notified_run(&value["origin"]) {
                    self.reported(run);
                }
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
            // A CLI that names no runs gives a turn it starts every queued notification of a
            // finished task. The others report each run in the result naming it.
            let tasks = &self.tasks;
            self.awaited.retain(|id, finished| {
                !*finished || tasks.get(id).is_some_and(|task| task.run.is_some())
            });
        }
    }
    fn turn_ended(&mut self, value: &Value) {
        self.idle = true;
        let run = notified_run(&value["origin"]);
        if let Some(run) = run {
            self.reported(run);
        }
        // Reports queued together share the turn of the last: the CLI ends each one before it
        // with an empty result, and the turn they share follows at once.
        self.folded = value["origin"]["kind"] == "task-notification"
            && value["num_turns"] == 0
            && value["is_error"] != true;
    }
    /// The turn naming this run reported its task to the model.
    fn reported(&mut self, run: &str) {
        let tasks = &self.tasks;
        self.awaited
            .retain(|id, _| tasks.get(id).and_then(|task| task.run.as_deref()) != Some(run));
    }
    fn started(&mut self, value: &Value) {
        let (Some(id), Some(call)) = (filled(&value["task_id"]), filled(&value["tool_use_id"]))
        else {
            return;
        };
        let task = Task {
            call,
            background: false,
            running: true,
            run: filled(&value["run_id"]),
        };
        self.tasks.insert(id, task);
    }
    fn finished(&mut self, value: &Value, status: Option<&str>) {
        let (Some(id), Some(status)) = (value["task_id"].as_str(), status) else {
            return;
        };
        if let Some(task) = self.tasks.get_mut(id) {
            task.running = false;
            if let Some(run) = filled(&value["run_id"]) {
                task.run = Some(run);
            }
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
        for part in text.split("<task-id>").skip(1) {
            if let Some(id) = part.split("</task-id>").next() {
                self.awaited.remove(id.trim());
            }
        }
    }
    /// Declared tasks hold the reply until the model has received their outcome, and so does
    /// a report the CLI carries into the turn it starts next.
    pub fn holds_reply(&self) -> bool {
        !self.awaited.is_empty() || self.folded
    }
    pub fn turn_active(&self) -> bool {
        !self.idle
    }
    /// The last result left its report to the turn the CLI starts next.
    pub fn folded(&self) -> bool {
        self.folded
    }
    /// Only finished declared tasks remain, or a report the CLI carries on, and no turn has
    /// started to deliver them.
    pub fn expects_follow_up(&self) -> bool {
        self.idle
            && (self.folded || !self.awaited.is_empty())
            && self.awaited.values().all(|finished| *finished)
    }
    /// The CLI started no turn for the finished tasks, so the model already has them.
    pub fn release(&mut self) {
        self.awaited.clear();
        self.folded = false;
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
                "Provide task_ids with one or more background task IDs.".into(),
            );
        };
        let (mut waiting, mut finished, mut unknown) = (vec![], vec![], vec![]);
        for id in ids {
            match self.tasks.get(&id) {
                Some(task) if task.running && task.background => {
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
            text.push(format!(
                "Not a running background task started in this reply: {}. Running background tasks: {}.",
                unknown.join(", "),
                if running.is_empty() { "none".into() } else { running.join(", ") }
            ));
            // Workflow runs are named by UUIDs, which no task ID of the CLI is.
            if unknown.iter().any(|id| uuid::Uuid::parse_str(id).is_ok()) {
                text.push(WORKFLOW_RUN.into());
            }
        }
        (waiting.is_empty(), text.join(" "))
    }
}

fn filled(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(String::from)
}

/// The run a line reports, when it reports a finished task's notification: a monitor's event
/// names none.
fn notified_run(origin: &Value) -> Option<&str> {
    if origin["kind"] != "task-notification" {
        return None;
    }
    origin["runId"].as_str().filter(|run| !run.is_empty())
}

fn task_ids(arguments: &Value) -> Option<Vec<String>> {
    let object = arguments.as_object().filter(|o| o.len() == 1)?;
    let ids = object
        .get("task_ids")?
        .as_array()
        .filter(|ids| !ids.is_empty())?;
    let mut valid: Vec<String> = vec![];
    for id in ids {
        let id = id.as_str().filter(|id| {
            !id.is_empty()
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
    /// As Claude Code 2.1.332 reports a task: its lines name the task's run.
    fn launch_run(state: &mut AwaitedTasks, task: &str, run: &str) {
        let call = format!("{task}-call");
        state.observe(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":call,"name":"Bash","input":{"command":"x","run_in_background":true}}]}}));
        state.observe(&json!({"type":"system","subtype":"task_started","task_id":task,"run_id":run,"tool_use_id":call,"task_type":"local_bash"}));
        state.observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":call,"content":"Command running in background"}]},"tool_use_result":{"backgroundTaskId":task}}));
    }
    fn finished_run(task: &str, run: &str) -> Value {
        json!({"type":"system","subtype":"task_notification","task_id":task,"run_id":run,"status":"completed"})
    }
    fn init() -> Value {
        json!({"type":"system","subtype":"init","parent_tool_use_id":null})
    }
    /// The result of a turn the CLI started for a notification: a task's names its run, a
    /// monitor's event none.
    fn reported(run: Option<&str>, turns: u64) -> Value {
        let mut origin = json!({"kind":"task-notification","producer":"session-task"});
        if let Some(run) = run {
            origin["runId"] = run.into();
        }
        json!({"type":"result","subtype":"success","parent_tool_use_id":null,"is_error":false,"num_turns":turns,"result":"","origin":origin})
    }

    #[test]
    fn a_monitor_event_taking_the_next_turn_does_not_report_a_finished_task() {
        let mut state = AwaitedTasks::default();
        launch_run(&mut state, "build", "run-build");
        declare(&mut state, "await", json!({"task_ids":["build"]}));
        state.observe(&result());
        state.observe(&finished_run("build", "run-build"));
        assert!(state.holds_reply() && state.expects_follow_up());
        // A log watch's event was queued first: its turn starts and ends, the build's report
        // still waits in the queue.
        state.observe(&init());
        assert!(state.holds_reply() && !state.expects_follow_up());
        state.observe(&reported(None, 1));
        assert!(state.holds_reply(), "a monitor's event reports no task");
        assert!(state.expects_follow_up() && !state.folded());
        state.observe(&init());
        state.observe(&reported(Some("run-build"), 3));
        assert!(!state.holds_reply());
    }

    #[test]
    fn reports_that_share_a_turn_hold_the_reply_until_that_turn_ends() {
        let mut state = AwaitedTasks::default();
        launch_run(&mut state, "left", "run-left");
        launch_run(&mut state, "right", "run-right");
        declare(&mut state, "await", json!({"task_ids":["left","right"]}));
        state.observe(&result());
        state.observe(&finished_run("left", "run-left"));
        state.observe(&finished_run("right", "run-right"));
        // The CLI ends the first report's command with an empty result and carries it into the
        // turn of the last.
        state.observe(&init());
        state.observe(&reported(Some("run-left"), 0));
        assert!(state.holds_reply() && state.folded());
        assert_eq!(state.running().count(), 0);
        assert!(state.expects_follow_up(), "that turn follows at once");
        state.observe(&init());
        assert!(state.holds_reply() && !state.expects_follow_up());
        state.observe(&reported(Some("run-right"), 1));
        assert!(!state.holds_reply() && !state.folded());
        // A monitor's event folded ahead of a report holds the reply the same way.
        let mut state = AwaitedTasks::default();
        launch_run(&mut state, "tests", "run-tests");
        declare(&mut state, "await", json!({"task_ids":["tests"]}));
        state.observe(&result());
        state.observe(&finished_run("tests", "run-tests"));
        state.observe(&init());
        state.observe(&reported(None, 0));
        assert!(state.holds_reply() && state.folded());
        state.observe(&init());
        state.observe(&reported(Some("run-tests"), 1));
        assert!(!state.holds_reply());
    }

    #[test]
    fn a_report_replayed_inside_a_turn_or_left_without_one_ends_the_wait() {
        let mut state = AwaitedTasks::default();
        launch_run(&mut state, "tests", "run-tests");
        declare(&mut state, "await", json!({"task_ids":["tests"]}));
        state.observe(&finished_run("tests", "run-tests"));
        // Injected after a call of the running turn, it replays with its run.
        state.observe(&json!({"type":"user","parent_tool_use_id":null,"isReplay":true,"origin":{"kind":"task-notification","producer":"session-task","runId":"run-tests"},"message":{"role":"user","content":[{"type":"text","text":"Tests done"}]}}));
        state.observe(&result());
        assert!(!state.holds_reply());
        // An empty result whose turn never comes is released after the grace.
        let mut state = AwaitedTasks::default();
        state.observe(&reported(None, 0));
        assert!(state.holds_reply() && state.expects_follow_up());
        state.release();
        assert!(!state.holds_reply() && !state.folded());
        // An error ends a turn without carrying anything on.
        let mut failed = reported(Some("run-x"), 0);
        failed["is_error"] = true.into();
        state.observe(&failed);
        assert!(!state.holds_reply());
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
    fn a_workflow_run_s_id_is_pointed_to_its_own_wait() {
        let mut state = AwaitedTasks::default();
        let run = "3ed997f3-ff48-426c-9f80-dfc889a51b11";
        let refused = declare(&mut state, "await", json!({ "task_ids": [run] }));
        assert_eq!(refused["isError"], true);
        let text = refused["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("workflow_status and wait: true"), "{text}");
        // A CLI task's ID gets no such note.
        let refused = declare(&mut state, "await-2", json!({ "task_ids": ["b43tu3ps3"] }));
        let text = refused["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("workflow"), "{text}");
        assert!(!state.holds_reply());
        // The tool's own description says so before it is called.
        assert!(DESCRIPTION.contains("workflow_status and wait: true"));
    }

    #[test]
    fn the_tool_is_always_loaded_and_read_only() {
        let tool = tool();
        assert_eq!(tool["name"], TOOL);
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert!(tool["inputSchema"]["properties"]["task_ids"]
            .get("maxItems")
            .is_none());
    }

    #[test]
    fn a_reply_waits_for_any_number_of_declared_tasks() {
        // Past the 8 IDs a call and 32 tasks a reply earlier releases took.
        let mut state = AwaitedTasks::default();
        let ids: Vec<String> = (0..40).map(|i| format!("task_{i}")).collect();
        for (index, id) in ids.iter().enumerate() {
            launch(&mut state, id, &format!("call{index}"));
        }
        let accepted = declare(&mut state, "await", json!({ "task_ids": ids }));
        assert_eq!(accepted["isError"], false);
        assert_eq!(state.running().count(), 40);
    }
}
