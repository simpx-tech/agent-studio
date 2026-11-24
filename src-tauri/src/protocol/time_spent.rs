//! Where a reply's time went (requested 2026-11-24, to learn what to change so that later chats
//! take less of it). Every moment of a reply goes to the one thing the reply waited on then:
//! the model, before it answers a request, while it thinks, writes, or writes a call; a command,
//! another tool, a sub-agent or a hook; the user; background work; a compaction. The computer
//! running the reply keeps this ledger as the provider's lines arrive, since only it sees them
//! when they happen, and the reply saves what it reports.
//!
//! The model's part comes from the provider's own lines (`claude`, `codex`), everything else from
//! the events the reply already reports (`event`). Only times and counts are kept: no text.
use super::activity::Wait;
use super::RunEvent;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

/// How often a running reply reports its ledger, so that one cut off keeps most of it.
const REPORT_EVERY: Duration = Duration::from_secs(60);

/// What a reply waits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Kind {
    /// Before the CLI was ready for the reply's turn: its process, session and startup hooks.
    Startup,
    /// A request the model has not begun to answer.
    Waiting,
    Thinking,
    Writing,
    /// The model writes a tool call.
    Calls,
    Commands,
    Tools,
    Agents,
    Hooks,
    /// A question, form or plan decision waits for the user.
    User,
    /// The reply's turn ended and it waits for background work.
    Background,
    Compaction,
    Other,
}
impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Startup => "startup",
            Kind::Waiting => "waiting",
            Kind::Thinking => "thinking",
            Kind::Writing => "writing",
            Kind::Calls => "calls",
            Kind::Commands => "commands",
            Kind::Tools => "tools",
            Kind::Agents => "agents",
            Kind::Hooks => "hooks",
            Kind::User => "user",
            Kind::Background => "background",
            Kind::Compaction => "compaction",
            Kind::Other => "other",
        }
    }
}

/// What the model does, as its provider last reported.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Model {
    /// No request is under way: calls run, or the turn ended.
    #[default]
    Idle,
    /// A request went out and nothing of its answer has arrived.
    Waiting,
    Thinking,
    Writing,
    Calling,
    /// It finished one part of its answer, and what it writes next shows only once that arrives:
    /// Codex reports a call when it runs, never while the model writes it.
    Unsettled,
}
impl Model {
    fn answering(self) -> bool {
        !matches!(self, Model::Idle | Model::Waiting)
    }
}

/// A reply's ledger as it is saved: milliseconds by what the reply waited on.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSpent {
    pub version: u8,
    pub revision: u64,
    pub run_id: String,
    /// Kinds that took no time are left out.
    pub spent: BTreeMap<&'static str, u64>,
    /// Requests the model answered.
    #[serde(skip_serializing_if = "is_zero")]
    pub requests: u64,
    /// Requests the CLI sent again after the provider failed them.
    #[serde(skip_serializing_if = "is_zero")]
    pub retries: u64,
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[derive(Default)]
pub struct Ledger {
    run_id: String,
    /// The moment accounted for last; none before the reply begins and after it ends.
    since: Option<Instant>,
    spent: HashMap<Kind, Duration>,
    /// Time the model spent on a part of its answer not yet known.
    unsettled: Duration,
    /// Time before the reply's turn began that is not yet known to be the CLI getting ready or
    /// the first request under way.
    opening: Duration,
    /// The reply's turn began: the CLI took its message, or the model answers.
    started: bool,
    model: Model,
    /// Claude: why the answer being written ends, which says whether another request follows.
    stop_reason: Option<String>,
    /// The calls, hooks and sub-agents of the reply's own that run, by record.
    waits: HashMap<String, Wait>,
    /// Questions, forms and plan decisions waiting for the user.
    asking: HashSet<String>,
    compacting: HashSet<String>,
    background: bool,
    requests: u64,
    retries: u64,
    revision: u64,
    reported: Option<Instant>,
}

impl Ledger {
    pub fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.into(),
            ..Self::default()
        }
    }

    /// The reply's own time starts here.
    pub fn begin(&mut self, now: Instant) {
        self.since = Some(now);
        self.reported = Some(now);
    }

    fn add(&mut self, kind: Kind, time: Duration) {
        *self.spent.entry(kind).or_default() += time;
    }

    /// Gives the time since the last moment accounted for to what the reply waited on. One thing
    /// at a time: the user before anything else, then a compaction, then the model while it
    /// answers, since a call that runs meanwhile holds nothing up, then hooks, calls and
    /// sub-agents, background work, and the request not yet answered.
    fn advance(&mut self, now: Instant) {
        let Some(since) = self.since else { return };
        let time = now.saturating_duration_since(since);
        self.since = Some(now);
        if time.is_zero() {
            return;
        }
        if !self.started {
            self.opening += time;
            return;
        }
        if !self.asking.is_empty() {
            return self.add(Kind::User, time);
        }
        if !self.compacting.is_empty() {
            return self.add(Kind::Compaction, time);
        }
        match self.model {
            Model::Thinking => return self.add(Kind::Thinking, time),
            Model::Writing => return self.add(Kind::Writing, time),
            Model::Calling => return self.add(Kind::Calls, time),
            Model::Unsettled => {
                self.unsettled += time;
                return;
            }
            Model::Idle | Model::Waiting => {}
        }
        let waits = |wait: Wait| self.waits.values().any(|w| *w == wait);
        if waits(Wait::Hook) {
            return self.add(Kind::Hooks, time);
        }
        // Calls of several kinds running side by side share the time.
        let running: Vec<Kind> = [
            (Wait::Command, Kind::Commands),
            (Wait::Tool, Kind::Tools),
            (Wait::Agents, Kind::Agents),
        ]
        .into_iter()
        .filter(|(wait, _)| waits(*wait))
        .map(|(_, kind)| kind)
        .collect();
        if !running.is_empty() {
            let share = time / running.len() as u32;
            for kind in running {
                self.add(kind, share);
            }
            return;
        }
        self.add(
            if self.background {
                Kind::Background
            } else if self.model == Model::Waiting {
                Kind::Waiting
            } else {
                Kind::Other
            },
            time,
        );
    }

    /// The model turned to `next`. Time it spent on a part not yet known was spent on this one.
    fn model(&mut self, next: Model, now: Instant) {
        self.advance(now);
        if next == self.model {
            return;
        }
        if self.model == Model::Waiting && next.answering() {
            self.requests += 1;
        }
        let unsettled = std::mem::take(&mut self.unsettled);
        if !unsettled.is_zero() {
            self.add(
                match next {
                    Model::Thinking => Kind::Thinking,
                    Model::Calling => Kind::Calls,
                    _ => Kind::Writing,
                },
                unsettled,
            );
        }
        self.model = next;
    }

    /// A line of the Claude CLI, the reply's own: a sub-agent's lines say nothing of what the
    /// reply waits on.
    pub fn claude(&mut self, value: &Value) {
        self.claude_at(value, Instant::now());
    }
    fn claude_at(&mut self, value: &Value, now: Instant) {
        if self.since.is_none() || !value["parent_tool_use_id"].is_null() {
            return;
        }
        match value["type"].as_str().unwrap_or_default() {
            "stream_event" => {
                self.start(now);
                let event = &value["event"];
                match event["type"].as_str().unwrap_or_default() {
                    "content_block_start" => {
                        match event["content_block"]["type"].as_str().unwrap_or_default() {
                            "thinking" | "redacted_thinking" => self.model(Model::Thinking, now),
                            "text" => self.model(Model::Writing, now),
                            "tool_use" | "server_tool_use" | "mcp_tool_use" => {
                                self.model(Model::Calling, now)
                            }
                            _ => {}
                        }
                    }
                    "content_block_delta" => {
                        match event["delta"]["type"].as_str().unwrap_or_default() {
                            "thinking_delta" | "signature_delta" => {
                                self.model(Model::Thinking, now)
                            }
                            "text_delta" => self.model(Model::Writing, now),
                            "input_json_delta" => self.model(Model::Calling, now),
                            _ => {}
                        }
                    }
                    "message_delta" => {
                        if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                            self.stop_reason = Some(reason.into());
                        }
                    }
                    "message_stop" => {
                        // An answer that ends in calls is followed by another request once they
                        // return; until then the calls outrank it.
                        let goes_on = matches!(
                            self.stop_reason.take().as_deref(),
                            Some("tool_use" | "pause_turn")
                        );
                        self.model(if goes_on { Model::Waiting } else { Model::Idle }, now);
                    }
                    _ => {}
                }
            }
            // The CLI replays the reply's message once its first request is answered, so the
            // request was under way since the CLI was last ready. Other lines of the kind are a
            // call's result, or begin a turn the CLI started by itself.
            "user" => {
                if value["uuid"].as_str() == Some(self.run_id.as_str()) {
                    self.start(now);
                }
                if self.started && self.model == Model::Idle {
                    self.model(Model::Waiting, now);
                }
            }
            "result" if self.started => self.model(Model::Idle, now),
            // Each turn begins with this line, also the one that only takes earlier context.
            "system" if value["subtype"] == "init" => self.ready(now),
            "system" if value["subtype"] == "api_retry" => self.retries += 1,
            _ => {}
        }
    }

    /// A notification of the Codex app-server about the reply's own thread.
    pub fn codex(&mut self, value: &Value, thread: &str) {
        self.codex_at(value, thread, Instant::now());
    }
    fn codex_at(&mut self, value: &Value, thread: &str, now: Instant) {
        let params = &value["params"];
        if self.since.is_none() || thread.is_empty() || params["threadId"] != thread {
            return;
        }
        let item = params["item"]["type"].as_str().unwrap_or_default();
        let written = matches!(item, "reasoning" | "agentMessage" | "plan");
        let call = matches!(
            item,
            "commandExecution"
                | "fileChange"
                | "mcpToolCall"
                | "dynamicToolCall"
                | "webSearch"
                | "imageView"
                | "collabAgentToolCall"
        );
        match value["method"].as_str().unwrap_or_default() {
            "turn/started" => {
                self.ready(now);
                self.start(now);
            }
            "item/started" if item == "reasoning" => self.model(Model::Thinking, now),
            "item/started" if written => self.model(Model::Writing, now),
            // The model had written the call by the time it runs.
            "item/started" if call => {
                self.model(Model::Calling, now);
                self.model(Model::Idle, now);
            }
            "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/reasoning/summaryPartAdded" => self.model(Model::Thinking, now),
            "item/agentMessage/delta" | "item/plan/delta" => self.model(Model::Writing, now),
            "item/completed" if written => self.model(Model::Unsettled, now),
            // The next request goes out once every call returned, which outrank it meanwhile.
            "item/completed" if call && self.model == Model::Idle => {
                self.model(Model::Waiting, now)
            }
            "turn/completed" => self.model(Model::Idle, now),
            _ => {}
        }
    }

    /// The CLI is ready for a turn: until here it was starting.
    fn ready(&mut self, now: Instant) {
        if !self.started {
            self.advance(now);
            let opening = std::mem::take(&mut self.opening);
            self.add(Kind::Startup, opening);
        }
    }

    /// The reply's turn began. A request was under way since the CLI was ready.
    fn start(&mut self, now: Instant) {
        if !self.started {
            self.advance(now);
            let opening = std::mem::take(&mut self.opening);
            self.add(Kind::Waiting, opening);
            self.started = true;
            self.model = Model::Waiting;
        }
    }

    /// An event the reply reports: what runs, what waits for the user, and what the reply waits
    /// for besides. Returns the ledger when a running reply is due to report it.
    pub fn event(&mut self, event: &RunEvent) -> Option<TimeSpent> {
        self.event_at(event, Instant::now())
    }
    fn event_at(&mut self, event: &RunEvent, now: Instant) -> Option<TimeSpent> {
        self.since?;
        self.advance(now);
        // Work the reply reports began its turn, whatever its provider's lines told: a
        // compaction is asked for without a message. Hooks also run while the CLI starts.
        let works = match event {
            RunEvent::Tool { tool } => tool.category != "hook" && tool.status == "running",
            RunEvent::Compaction { compaction } => compaction.status == "running",
            RunEvent::Question { .. } | RunEvent::Elicitation { .. } => true,
            _ => false,
        };
        if works {
            self.start(now);
        }
        let pending = |set: &mut HashSet<String>, id: String, waits: bool| {
            if waits {
                set.insert(id);
            } else {
                set.remove(&id);
            }
        };
        match event {
            RunEvent::Tool { tool } => match tool.wait() {
                Some(wait) => {
                    self.waits.insert(tool.id.clone(), wait);
                }
                None => {
                    self.waits.remove(&tool.id);
                }
            },
            RunEvent::Question { question, .. } => pending(
                &mut self.asking,
                format!("question:{}", question.id),
                question.status == "pending",
            ),
            RunEvent::Elicitation { elicitation } => pending(
                &mut self.asking,
                format!("elicitation:{}", elicitation.id),
                elicitation.status == "pending",
            ),
            RunEvent::Compaction { compaction } => pending(
                &mut self.compacting,
                compaction.id.clone(),
                compaction.status == "running",
            ),
            RunEvent::BackgroundWait { wait } => self.background = wait.is_some(),
            _ => {}
        }
        let due = self
            .reported
            .is_some_and(|at| now.saturating_duration_since(at) >= REPORT_EVERY);
        due.then(|| self.report(now))
    }

    fn report(&mut self, now: Instant) -> TimeSpent {
        self.reported = Some(now);
        self.revision += 1;
        let mut spent = self.spent.clone();
        // What the model spends on a part not yet known reads as writing until it is, and a
        // reply whose turn never began was starting.
        for (kind, time) in [
            (Kind::Writing, self.unsettled),
            (Kind::Startup, self.opening),
        ] {
            if !time.is_zero() {
                *spent.entry(kind).or_default() += time;
            }
        }
        TimeSpent {
            version: 1,
            revision: self.revision,
            run_id: self.run_id.clone(),
            spent: spent
                .into_iter()
                .map(|(kind, time)| (kind.key(), time.as_millis() as u64))
                .filter(|(_, ms)| *ms > 0)
                .collect(),
            requests: self.requests,
            retries: self.retries,
        }
    }

    /// The reply ended: its ledger, complete. None when the reply never began.
    pub fn end(&mut self) -> Option<TimeSpent> {
        self.end_at(Instant::now())
    }
    fn end_at(&mut self, now: Instant) -> Option<TimeSpent> {
        self.since?;
        self.advance(now);
        let report = self.report(now);
        self.since = None;
        Some(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Decoder;
    use serde_json::json;

    struct Run {
        ledger: Ledger,
        decoder: Decoder,
        start: Instant,
        now: Instant,
    }
    impl Run {
        fn new() -> Self {
            let start = Instant::now();
            let mut ledger = Ledger::new("run");
            ledger.begin(start);
            Self {
                ledger,
                decoder: Decoder::default(),
                start,
                now: start,
            }
        }
        fn wait(&mut self, ms: u64) -> &mut Self {
            self.now += Duration::from_millis(ms);
            self
        }
        /// A line of the Claude CLI, as the runner hands it over: to the ledger, then decoded.
        fn claude(&mut self, value: Value) -> &mut Self {
            self.ledger.claude_at(&value, self.now);
            for event in self.decoder.decode_value("claude", &value) {
                self.ledger.event_at(&event, self.now);
            }
            self
        }
        fn stream(&mut self, event: Value) -> &mut Self {
            self.claude(json!({"type":"stream_event","parent_tool_use_id":null,"event":event}))
        }
        fn codex(&mut self, value: Value) -> &mut Self {
            self.ledger.codex_at(&value, "root", self.now);
            for event in self.decoder.decode_codex_server(&value, "root") {
                self.ledger.event_at(&event, self.now);
            }
            self
        }
        fn event(&mut self, event: RunEvent) -> &mut Self {
            self.ledger.event_at(&event, self.now);
            self
        }
        fn spent(&mut self) -> Vec<(&'static str, u64)> {
            let report = self.ledger.end_at(self.now).unwrap();
            let total: u64 = report.spent.values().sum();
            assert_eq!(
                total,
                (self.now - self.start).as_millis() as u64,
                "every moment of the reply is accounted for once"
            );
            report.spent.into_iter().collect()
        }
    }
    fn prompt() -> Value {
        json!({"type":"user","uuid":"run","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"PRIVATE"}]}})
    }
    fn block(index: u64, block: Value) -> Value {
        json!({"type":"content_block_start","index":index,"content_block":block})
    }
    fn stop(index: u64) -> Value {
        json!({"type":"content_block_stop","index":index})
    }
    fn ends(reason: &str) -> Value {
        json!({"type":"message_delta","delta":{"stop_reason":reason}})
    }
    fn result(id: &str) -> Value {
        json!({"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"PRIVATE"}]}})
    }

    #[test]
    fn a_claude_reply_gives_each_moment_to_what_it_waited_on() {
        let mut run = Run::new();
        let init = || json!({"type":"system","subtype":"init","parent_tool_use_id":null});
        // A new process takes the chat's earlier context in a turn of its own first.
        run.wait(600).claude(init());
        run.claude(json!({"type":"user","uuid":"context","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"PRIVATE"}]}}));
        run.claude(
            json!({"type":"result","parent_tool_use_id":null,"subtype":"success","result":""}),
        );
        run.wait(100).claude(init());
        // The CLI replays the message as the answer to its first request begins.
        run.wait(1200).claude(prompt());
        run.stream(json!({"type":"message_start","message":{"id":"m1"}}));
        run.wait(300)
            .stream(block(0, json!({"type":"thinking","thinking":""})));
        run.wait(4000).stream(stop(0));
        run.stream(block(1, json!({"type":"text","text":""})));
        run.wait(900).stream(stop(1));
        run.stream(block(
            2,
            json!({"type":"tool_use","id":"c1","name":"Bash","input":{}}),
        ));
        run.wait(2500).stream(json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"npm test\"}"}}));
        run.stream(stop(2));
        run.stream(ends("tool_use"))
            .stream(json!({"type":"message_stop"}));
        run.wait(30_000).claude(result("c1"));
        run.wait(800)
            .stream(json!({"type":"message_start","message":{"id":"m2"}}));
        run.stream(block(0, json!({"type":"text","text":""})));
        run.wait(1500).stream(stop(0));
        run.stream(ends("end_turn"))
            .stream(json!({"type":"message_stop"}));
        run.wait(200).claude(
            json!({"type":"result","parent_tool_use_id":null,"subtype":"success","result":"Done"}),
        );
        let requests = run.ledger.requests;
        assert_eq!(
            run.spent(),
            [
                ("calls", 2500),
                ("commands", 30_000),
                ("other", 200),
                ("startup", 700),
                ("thinking", 4000),
                ("waiting", 2300),
                ("writing", 2400),
            ]
        );
        assert_eq!(requests, 2);
    }

    #[test]
    fn a_call_running_while_the_model_writes_on_holds_nothing_up() {
        // Claude Code runs a call as soon as it is written, while the model writes the next.
        let mut run = Run::new();
        run.claude(prompt());
        run.wait(1000).stream(block(
            0,
            json!({"type":"tool_use","id":"read","name":"Read","input":{}}),
        ));
        run.wait(500).stream(stop(0));
        run.stream(block(
            1,
            json!({"type":"tool_use","id":"write","name":"Write","input":{}}),
        ));
        run.wait(200).claude(result("read"));
        run.wait(20_000).stream(stop(1));
        run.stream(ends("tool_use"))
            .stream(json!({"type":"message_stop"}));
        run.wait(100).claude(result("write"));
        run.wait(900);
        assert_eq!(
            run.spent(),
            [("calls", 20_700), ("tools", 100), ("waiting", 1900)]
        );
    }

    #[test]
    fn a_sub_agents_own_lines_and_calls_count_as_the_sub_agent() {
        let mut run = Run::new();
        run.claude(prompt());
        run.wait(1000).stream(block(
            0,
            json!({"type":"tool_use","id":"agent","name":"Agent","input":{}}),
        ));
        run.wait(3000).stream(stop(0));
        run.stream(ends("tool_use"))
            .stream(json!({"type":"message_stop"}));
        // The child thinks and runs a command of its own.
        run.wait(5000).claude(json!({"type":"stream_event","parent_tool_use_id":"agent","event":block(0, json!({"type":"thinking","thinking":""}))}));
        run.wait(5000).claude(json!({"type":"assistant","parent_tool_use_id":"agent","message":{"id":"child","content":[{"type":"tool_use","id":"child-call","name":"Bash","input":{"command":"ls"}}]}}));
        run.wait(50_000).claude(result("agent"));
        run.wait(2000);
        assert_eq!(
            run.spent(),
            [("agents", 60_000), ("calls", 3000), ("waiting", 3000)]
        );
    }

    #[test]
    fn a_question_a_compaction_and_background_work_outrank_what_else_goes_on() {
        let mut run = Run::new();
        run.claude(prompt());
        let question = |status: &str| RunEvent::Question {
            question: crate::providers::questions::Request {
                id: "q".into(),
                revision: 1,
                status: status.into(),
                questions: vec![],
                plan_approval: None,
                response: None,
            },
            draft: None,
        };
        run.wait(1000).stream(block(
            0,
            json!({"type":"tool_use","id":"ask","name":"AskUserQuestion","input":{}}),
        ));
        run.wait(2000).stream(stop(0));
        run.stream(ends("tool_use"))
            .stream(json!({"type":"message_stop"}));
        run.wait(100).event(question("pending"));
        run.wait(90_000).event(question("answered"));
        run.wait(50).claude(result("ask"));
        let compaction = |status: &str| RunEvent::Compaction {
            compaction: crate::protocol::compaction::Compaction {
                id: "c".into(),
                revision: 1,
                status: status.into(),
                trigger: "auto".into(),
                pre_tokens: None,
                post_tokens: None,
                usage_revision: 0,
            },
        };
        run.wait(500).event(compaction("running"));
        // The summary is an answer of the model like any other.
        run.stream(block(0, json!({"type":"text","text":""})));
        run.wait(40_000).event(compaction("complete"));
        run.stream(ends("end_turn"))
            .stream(json!({"type":"message_stop"}));
        run.claude(
            json!({"type":"result","parent_tool_use_id":null,"subtype":"success","result":"Done"}),
        );
        run.event(RunEvent::BackgroundWait { wait: Some(1) });
        run.wait(120_000)
            .event(RunEvent::BackgroundWait { wait: None });
        assert_eq!(
            run.spent(),
            [
                ("background", 120_000),
                ("calls", 2000),
                ("compaction", 40_000),
                ("tools", 150),
                ("user", 90_000),
                ("waiting", 1500),
            ]
        );
    }

    #[test]
    fn a_codex_reply_settles_what_the_model_wrote_once_it_shows() {
        let mut run = Run::new();
        let about = |method: &str, item: Value| json!({"method":method,"params":{"threadId":"root","turnId":"t","item":item}});
        run.wait(400)
            .codex(json!({"method":"turn/started","params":{"threadId":"root","turn":{"id":"t"}}}));
        run.wait(1500)
            .codex(about("item/started", json!({"id":"r1","type":"reasoning"})));
        run.wait(6000).codex(about(
            "item/completed",
            json!({"id":"r1","type":"reasoning"}),
        ));
        // Codex names the command once it runs: the model wrote it meanwhile.
        run.wait(3000).codex(about(
            "item/started",
            json!({"id":"c1","type":"commandExecution","command":"npm test","status":"inProgress"}),
        ));
        run.wait(45_000).codex(about("item/completed", json!({"id":"c1","type":"commandExecution","command":"npm test","status":"completed","exitCode":0})));
        run.wait(2000).codex(about(
            "item/started",
            json!({"id":"m1","type":"agentMessage","text":""}),
        ));
        run.wait(1000).codex(about(
            "item/completed",
            json!({"id":"m1","type":"agentMessage","text":"Done"}),
        ));
        run.wait(100).codex(
            json!({"method":"turn/completed","params":{"threadId":"root","turn":{"id":"t","status":"completed"}}}),
        );
        // Another thread's lines, such as a sub-agent's, are not the reply's.
        run.codex(json!({"method":"item/started","params":{"threadId":"child","item":{"id":"x","type":"reasoning"}}}));
        let requests = run.ledger.requests;
        assert_eq!(
            run.spent(),
            [
                ("calls", 3000),
                ("commands", 45_000),
                ("startup", 400),
                ("thinking", 6000),
                ("waiting", 3500),
                ("writing", 1100),
            ]
        );
        assert_eq!(requests, 2);
    }

    #[test]
    fn a_reply_without_a_message_of_its_own_begins_with_its_work() {
        // A compaction is asked for by a command, which the CLI never replays.
        let mut run = Run::new();
        let compaction = |status: &str| RunEvent::Compaction {
            compaction: crate::protocol::compaction::Compaction {
                id: "c".into(),
                revision: 1,
                status: status.into(),
                trigger: "manual".into(),
                pre_tokens: None,
                post_tokens: None,
                usage_revision: 0,
            },
        };
        run.wait(300)
            .claude(json!({"type":"system","subtype":"init","parent_tool_use_id":null}));
        run.wait(200).event(compaction("running"));
        run.wait(30_000).event(compaction("complete"));
        assert_eq!(
            run.spent(),
            [("compaction", 30_000), ("startup", 300), ("waiting", 200)]
        );
        // A reply that failed before its turn began was starting.
        let mut failed = Run::new();
        failed.wait(900);
        assert_eq!(failed.spent(), [("startup", 900)]);
    }

    #[test]
    fn a_running_reply_reports_once_a_minute_and_keeps_no_text() {
        let mut run = Run::new();
        run.claude(prompt());
        let tick = RunEvent::Activity {
            text: "PRIVATE".into(),
        };
        let now = run.wait(59_000).now;
        assert!(run.ledger.event_at(&tick, now).is_none());
        let now = run.wait(1000).now;
        let first = run.ledger.event_at(&tick, now).expect("due after a minute");
        assert_eq!((first.revision, first.spent["waiting"]), (1, 60_000));
        let now = run.wait(1000).now;
        assert!(run.ledger.event_at(&tick, now).is_none());
        run.claude(json!({"type":"system","subtype":"api_retry","parent_tool_use_id":null,"error":"PRIVATE"}));
        let last = run.ledger.end_at(run.now).unwrap();
        assert_eq!((last.revision, last.retries), (2, 1));
        let saved = serde_json::to_string(&last).unwrap();
        assert_eq!(
            saved,
            r#"{"version":1,"revision":2,"runId":"run","spent":{"waiting":61000},"retries":1}"#
        );
        // Nothing is counted once the reply ended, or before it began.
        assert!(run.ledger.end_at(run.now).is_none());
        assert!(Ledger::new("idle").end().is_none());
    }

    #[test]
    fn a_call_claude_streams_records_how_long_the_model_took_to_write_it() {
        let mut decoder = Decoder::default();
        let mut decode = |event: Value| {
            let line = json!({"type":"stream_event","parent_tool_use_id":null,"event":event});
            decoder
                .decode_value("claude", &line)
                .into_iter()
                .filter_map(|event| match event {
                    RunEvent::Tool { tool } => Some(tool),
                    _ => None,
                })
                .next_back()
        };
        let started = decode(block(
            0,
            json!({"type":"tool_use","id":"c1","name":"Bash","input":{}}),
        ))
        .expect("The call shows as it is written");
        assert_eq!(started.write_ms, None);
        std::thread::sleep(Duration::from_millis(30));
        decode(
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"npm test\"}"}}),
        );
        let written = decode(stop(0)).expect("The written call is reported");
        let wrote = written.write_ms.expect("How long the call took to write");
        assert!((30..5000).contains(&wrote), "{wrote}");
        // Its result keeps that, beside the whole time the record ran.
        let done = decoder
            .decode_value("claude", &result("c1"))
            .into_iter()
            .find_map(|event| match event {
                RunEvent::Tool { tool } => Some(tool),
                _ => None,
            })
            .expect("The call's result");
        assert_eq!(done.status, "complete");
        assert_eq!(done.write_ms, Some(wrote));
        assert!(done.elapsed_ms.is_some_and(|elapsed| elapsed >= wrote));
        let saved = serde_json::to_value(&*done).unwrap();
        assert_eq!(saved["writeMs"], wrote);
    }
}
