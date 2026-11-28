//! Where a reply's time went (requested 2026-11-24, to learn what to change so that later chats
//! take less of it). Every moment of a reply goes to the one thing the reply waited on then:
//! the model, before it answers a request, while it thinks, writes, or writes a call; a command,
//! another tool, a sub-agent or a hook; the user; background work; a compaction. The computer
//! running the reply keeps this ledger as the provider's lines arrive, since only it sees them
//! when they happen, and the reply saves what it reports: the time by kind, the same as a
//! timeline, and when each step of the reply's plan and each of its notes began, so that a
//! report can say what a step took and what it was made of.
//!
//! The model's part comes from the provider's own lines (`claude`, `codex`), everything else from
//! the events the reply already reports (`event`). Times, counts, the ids of notes and the
//! titles of plan steps are kept, all of which the reply saves anyway: nothing it said or ran.
use super::activity::Wait;
use super::RunEvent;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

/// How often a running reply reports its ledger, so that one cut off keeps most of it.
const REPORT_EVERY: Duration = Duration::from_secs(60);

/// How finely the saved timeline tells a reply's time apart: stretches shorter than this share
/// of it join their neighbours, the kind that took most of them standing for all. A chart of
/// the timeline is no wider than this many points, and a long reply's stays small.
const TIMELINE_STRETCHES: u32 = 1500;

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
    /// Another chat holds this computer for a measurement (`reservations`).
    Held,
    /// A build waits for a slot beside the builds running (`reservations::builds`).
    Slot,
    /// The reply waits for its turn at a named reservation, such as its repository's landing
    /// (`reservations::named`).
    Turn,
    Compaction,
    Other,
    /// Before the reply's turn began, not yet known to be the CLI getting ready or the first
    /// request under way.
    Opening,
    /// The model writes a part of its answer that shows only once it arrives.
    Unsettled,
}
impl Kind {
    fn key(self) -> &'static str {
        match self {
            // A reply whose turn never began was starting.
            Kind::Startup | Kind::Opening => "startup",
            Kind::Waiting => "waiting",
            Kind::Thinking => "thinking",
            // What the model spends on a part not yet known reads as writing until it is.
            Kind::Writing | Kind::Unsettled => "writing",
            Kind::Calls => "calls",
            Kind::Commands => "commands",
            Kind::Tools => "tools",
            Kind::Agents => "agents",
            Kind::Hooks => "hooks",
            Kind::User => "user",
            Kind::Background => "background",
            Kind::Held => "held",
            Kind::Slot => "slot",
            Kind::Turn => "turn",
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

/// The reply's time in the order it passed: what it waited on, stretch after stretch.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Timeline {
    pub kinds: Vec<&'static str>,
    /// For each stretch its kind's place in `kinds`, then its milliseconds.
    pub runs: Vec<u64>,
}

/// From `at` milliseconds into the reply, this step of its plan was in progress, or none was.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StepMark {
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// At `at` milliseconds into the reply, the model began the note with this id.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NoteMark {
    pub at: u64,
    pub id: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<Timeline>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<StepMark>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<NoteMark>,
}
fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[derive(Default)]
pub struct Ledger {
    run_id: String,
    began: Option<Instant>,
    /// The moment accounted for last; none before the reply begins and after it ends.
    since: Option<Instant>,
    /// What the reply waited on, stretch after stretch.
    runs: Vec<(Kind, Duration)>,
    /// Where the stretches before the turn that are not yet known begin.
    opening_from: usize,
    /// Where the stretches of an answer's part not yet known begin, while the model writes one.
    unsettled_from: Option<usize>,
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
    /// What a running `pc_wait` waits for, as the broker tells it: `slot`, `turn`, or else the
    /// computer.
    held_for: Option<&'static str>,
    /// The step of the reply's plan in progress, and when each began.
    step: Option<String>,
    steps: Vec<StepMark>,
    /// When the model began each of the reply's notes.
    noted: HashSet<String>,
    notes: Vec<NoteMark>,
    requests: u64,
    retries: u64,
    revision: u64,
    reported: Option<Instant>,
}

fn push(runs: &mut Vec<(Kind, Duration)>, kind: Kind, time: Duration) {
    match runs.last_mut() {
        Some((last, total)) if *last == kind => *total += time,
        _ => runs.push((kind, time)),
    }
}

/// The timeline of `runs` at the fineness it is saved with.
fn timeline(runs: &[(Kind, Duration)]) -> Option<Timeline> {
    let total: Duration = runs.iter().map(|run| run.1).sum();
    let shortest = total / TIMELINE_STRETCHES;
    let mut kept: Vec<(Kind, Duration)> = vec![];
    // Short stretches gather until together they are long enough to show.
    let mut short: Vec<(Kind, Duration)> = vec![];
    let gathered = |short: &[(Kind, Duration)]| short.iter().map(|run| run.1).sum::<Duration>();
    let settle = |short: &mut Vec<(Kind, Duration)>, kept: &mut Vec<(Kind, Duration)>| {
        let mut most: Option<(Kind, Duration)> = None;
        for &(kind, _) in short.iter() {
            let time: Duration = short.iter().filter(|r| r.0 == kind).map(|r| r.1).sum();
            if most.is_none_or(|(_, longest)| time > longest) {
                most = Some((kind, time));
            }
        }
        if let Some((kind, _)) = most {
            push(kept, kind, gathered(short));
        }
        short.clear();
    };
    for &(kind, time) in runs {
        if time >= shortest {
            settle(&mut short, &mut kept);
            push(&mut kept, kind, time);
        } else {
            short.push((kind, time));
            if gathered(&short) >= shortest {
                settle(&mut short, &mut kept);
            }
        }
    }
    settle(&mut short, &mut kept);
    // Whole milliseconds that add up to the reply's: each stretch ends where its time does.
    let mut timeline = Timeline::default();
    let (mut passed, mut counted) = (Duration::ZERO, 0);
    for (kind, time) in kept {
        passed += time;
        let end = passed.as_millis() as u64;
        let ms = end - counted;
        counted = end;
        if ms == 0 {
            continue;
        }
        let key = kind.key();
        let place = match timeline.kinds.iter().position(|k| *k == key) {
            Some(place) => place,
            None => {
                timeline.kinds.push(key);
                timeline.kinds.len() - 1
            }
        } as u64;
        match timeline.runs.as_mut_slice() {
            [.., last, total] if *last == place => *total += ms,
            _ => timeline.runs.extend([place, ms]),
        }
    }
    (!timeline.runs.is_empty()).then_some(timeline)
}

impl Ledger {
    pub fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.into(),
            ..Self::default()
        }
    }

    /// What the reply's `pc_wait` waits for from now on (`reservations::Broker::wait`): the
    /// time before goes to what it waited for until now.
    pub fn held_for(&mut self, reason: Option<&'static str>) {
        self.held_for_at(reason, Instant::now());
    }
    fn held_for_at(&mut self, reason: Option<&'static str>, now: Instant) {
        self.advance(now);
        self.held_for = reason;
    }

    /// The reply's own time starts here.
    pub fn begin(&mut self, now: Instant) {
        self.began = Some(now);
        self.since = Some(now);
        self.reported = Some(now);
    }

    /// When the reply's time started, which what it records is counted from.
    pub fn began(&self) -> Option<Instant> {
        self.began
    }

    fn add(&mut self, kind: Kind, time: Duration) {
        push(&mut self.runs, kind, time);
    }

    /// What was counted as `was` from the stretch `from` on turned out to be `is`.
    fn settle(&mut self, from: usize, was: Kind, is: Kind) {
        for run in self.runs.iter_mut().skip(from) {
            if run.0 == was {
                run.0 = is;
            }
        }
    }

    /// Milliseconds into the reply.
    fn at(&self, now: Instant) -> u64 {
        self.began.map_or(0, |began| {
            now.saturating_duration_since(began).as_millis() as u64
        })
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
            return self.add(Kind::Opening, time);
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
            Model::Unsettled => return self.add(Kind::Unsettled, time),
            Model::Idle | Model::Waiting => {}
        }
        let waits = |wait: Wait| self.waits.values().any(|w| *w == wait);
        if waits(Wait::Hook) {
            return self.add(Kind::Hooks, time);
        }
        // Waiting for the computer another chat measures with, a build slot or a turn is on
        // hold, whatever else runs.
        if waits(Wait::Held) {
            return self.add(
                match self.held_for {
                    Some("slot") => Kind::Slot,
                    Some("turn") => Kind::Turn,
                    _ => Kind::Held,
                },
                time,
            );
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
        if let Some(from) = self.unsettled_from.take() {
            let written = match next {
                Model::Thinking => Kind::Thinking,
                Model::Calling => Kind::Calls,
                _ => Kind::Writing,
            };
            self.settle(from, Kind::Unsettled, written);
        }
        if next == Model::Unsettled {
            self.unsettled_from = Some(self.runs.len());
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
            self.settle(self.opening_from, Kind::Opening, Kind::Startup);
            self.opening_from = self.runs.len();
        }
    }

    /// The reply's turn began. A request was under way since the CLI was ready.
    fn start(&mut self, now: Instant) {
        if !self.started {
            self.advance(now);
            self.settle(self.opening_from, Kind::Opening, Kind::Waiting);
            self.started = true;
            self.model = Model::Waiting;
        }
    }

    /// An event the reply reports: what runs, what waits for the user, what the reply waits for
    /// besides, and which step and note it is at. Returns the ledger when a running reply is due
    /// to report it.
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
            // The step in progress is the one the reply is at, from when its plan says so.
            RunEvent::Plan { plan } => {
                let step = plan
                    .steps
                    .iter()
                    .find(|step| step.status == "running")
                    .map(|step| step.title.clone());
                if step != self.step {
                    self.steps.push(StepMark {
                        at: self.at(now),
                        title: step.clone(),
                    });
                    self.step = step;
                }
            }
            // A note of the model's own begins a stretch of the reply's work. Agent Studio's
            // notices about the session are not the model's.
            RunEvent::Progress { id, .. }
                if !id.starts_with("studio-") && self.noted.insert(id.clone()) =>
            {
                self.notes.push(NoteMark {
                    at: self.at(now),
                    id: id.clone(),
                });
            }
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
        let mut spent: HashMap<&'static str, Duration> = HashMap::new();
        for (kind, time) in &self.runs {
            *spent.entry(kind.key()).or_default() += *time;
        }
        TimeSpent {
            version: 1,
            revision: self.revision,
            run_id: self.run_id.clone(),
            spent: spent
                .into_iter()
                .map(|(kind, time)| (kind, time.as_millis() as u64))
                .filter(|(_, ms)| *ms > 0)
                .collect(),
            requests: self.requests,
            retries: self.retries,
            timeline: timeline(&self.runs),
            steps: self.steps.clone(),
            notes: self.notes.clone(),
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
            let elapsed = (self.now - self.start).as_millis() as u64;
            let total: u64 = report.spent.values().sum();
            assert_eq!(
                total, elapsed,
                "every moment of the reply is accounted for once"
            );
            let timeline = report
                .timeline
                .expect("a reply that took time has a timeline");
            let stretches: u64 = timeline.runs.chunks(2).map(|run| run[1]).sum();
            assert_eq!(stretches, elapsed, "the timeline is the same time in order");
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
    fn a_wait_for_the_computer_a_build_slot_or_a_turn_is_held_time_with_its_reason() {
        let mut run = Run::new();
        run.claude(prompt());
        run.wait(500).claude(json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"w","name":"mcp__agent_studio__pc_wait","input":{}}]}}));
        run.wait(1_000);
        let now = run.now;
        run.ledger.held_for_at(Some("slot"), now);
        run.wait(3_000);
        let now = run.now;
        run.ledger.held_for_at(Some("turn"), now);
        run.wait(2_000);
        let now = run.now;
        run.ledger.held_for_at(None, now);
        run.wait(100).claude(result("w"));
        assert_eq!(
            run.spent(),
            [
                ("held", 1_100),
                ("slot", 3_000),
                ("turn", 2_000),
                ("waiting", 500)
            ]
        );
    }

    #[test]
    fn a_wait_for_a_workflow_run_is_time_its_agents_took() {
        let mut run = Run::new();
        run.claude(prompt());
        run.wait(500).claude(json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"w","name":"mcp__agent_studio__workflow_status","input":{"id":"3ed997f3-ff48-426c-9f80-dfc889a51b11","wait":true}}]}}));
        run.wait(60_000).claude(result("w"));
        assert_eq!(run.spent(), [("agents", 60_000), ("waiting", 500)]);
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
            r#"{"version":1,"revision":2,"runId":"run","spent":{"waiting":61000},"retries":1,"timeline":{"kinds":["waiting"],"runs":[0,61000]}}"#
        );
        // Nothing is counted once the reply ended, or before it began.
        assert!(run.ledger.end_at(run.now).is_none());
        assert!(Ledger::new("idle").end().is_none());
    }

    #[test]
    fn the_timeline_keeps_the_order_and_marks_say_when_each_step_and_note_began() {
        use crate::protocol::plan::{Plan, Step};
        let mut run = Run::new();
        run.claude(prompt());
        let plan = |statuses: [&str; 2]| RunEvent::Plan {
            plan: Plan {
                revision: 1,
                explanation: None,
                steps: ["Implement the fix", "Document it"]
                    .into_iter()
                    .zip(statuses)
                    .enumerate()
                    .map(|(index, (title, status))| Step {
                        id: index.to_string(),
                        title: title.into(),
                        status: status.into(),
                        active_form: None,
                    })
                    .collect(),
            },
        };
        let note = |id: &str, revision: u64| RunEvent::Progress {
            id: id.into(),
            revision,
            text: "PRIVATE".into(),
        };
        run.wait(2000)
            .stream(block(0, json!({"type":"thinking","thinking":""})));
        run.wait(3000).event(plan(["running", "pending"]));
        run.event(note("msg-1", 1));
        run.wait(4000).event(plan(["complete", "running"]));
        // The same note written on, Agent Studio's own notice, and a plan that says the same.
        run.event(note("msg-1", 2));
        run.event(note("studio-session-missing", 1));
        run.event(plan(["complete", "running"]));
        run.wait(500).event(note("msg-2", 1));
        run.wait(500).event(plan(["complete", "complete"]));
        let report = run.ledger.end_at(run.now).unwrap();
        let step = |at: u64, title: Option<&str>| StepMark {
            at,
            title: title.map(String::from),
        };
        assert_eq!(
            report.steps,
            [
                step(5000, Some("Implement the fix")),
                step(9000, Some("Document it")),
                step(10_000, None),
            ]
        );
        let noted = |at: u64, id: &str| NoteMark { at, id: id.into() };
        assert_eq!(report.notes, [noted(5000, "msg-1"), noted(9500, "msg-2")]);
        assert_eq!(
            report.timeline,
            Some(Timeline {
                kinds: vec!["waiting", "thinking"],
                runs: vec![0, 2000, 1, 8000],
            })
        );
        let saved = serde_json::to_value(&report).unwrap();
        assert_eq!(
            saved["steps"],
            json!([{"at":5000,"title":"Implement the fix"},{"at":9000,"title":"Document it"},{"at":10000}])
        );
        assert_eq!(saved["notes"][1], json!({"at":9500,"id":"msg-2"}));
    }

    #[test]
    fn a_long_replys_timeline_joins_stretches_too_short_to_show() {
        let seconds = Duration::from_secs;
        let mut runs = vec![(Kind::Waiting, seconds(1000))];
        // Forty seconds of the model thinking and writing in turns of a moment each.
        for _ in 0..100 {
            runs.push((Kind::Thinking, Duration::from_millis(300)));
            runs.push((Kind::Unsettled, Duration::from_millis(100)));
        }
        runs.push((Kind::Commands, seconds(1960)));
        runs.push((Kind::Opening, Duration::from_micros(400)));
        assert_eq!(
            timeline(&runs),
            Some(Timeline {
                kinds: vec!["waiting", "thinking", "commands"],
                runs: vec![0, 1_000_000, 1, 40_000, 2, 1_960_000],
            })
        );
        // A short reply keeps every stretch, and one that took no time has no timeline.
        let short = [
            (Kind::Opening, Duration::from_millis(12)),
            (Kind::Thinking, Duration::from_millis(3)),
            (Kind::Opening, Duration::from_millis(40)),
        ];
        assert_eq!(
            timeline(&short).unwrap().runs,
            [0, 12, 1, 3, 0, 40],
            "kinds: startup, thinking"
        );
        assert_eq!(timeline(&[]), None);
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
        // A transcript read after the fact has no moment to count from.
        assert_eq!(saved.get("startMs"), None);
    }

    #[test]
    fn calls_and_sub_agents_record_when_they_began_and_how_long_a_sub_agent_ran() {
        let mut decoder = Decoder::default();
        // The reply began two seconds ago.
        decoder.time_from(Instant::now() - Duration::from_secs(2));
        let mut records = |line: Value| {
            decoder
                .decode_value("claude", &line)
                .into_iter()
                .filter_map(|event| match event {
                    RunEvent::Tool { tool } => Some(serde_json::to_value(&*tool).unwrap()),
                    _ => None,
                })
                .next_back()
        };
        let call = |id: &str, name: &str| json!({"type":"assistant","parent_tool_use_id":null,"message":{"id":format!("m-{id}"),"content":[{"type":"tool_use","id":id,"name":name,"input":{"command":"ls","description":"Explore","prompt":"PRIVATE"}}]}});
        let command = records(call("c1", "Bash")).expect("The command's record");
        let began = command["startMs"].as_u64().expect("When the command began");
        assert!((2000..7000).contains(&began), "{began}");
        let done = records(result("c1")).expect("The command's result");
        assert_eq!(done["startMs"], began);

        let started = records(call("a1", "Agent")).expect("The sub-agent's record");
        let agent = &started["agents"][0];
        assert!(agent["startMs"].as_u64().is_some_and(|at| at >= began));
        assert_eq!(agent.get("elapsedMs"), None, "it runs");
        std::thread::sleep(Duration::from_millis(30));
        let ended = records(result("a1")).expect("The sub-agent's result");
        let agent = &ended["agents"][0];
        assert_eq!(agent["status"], "complete");
        assert_eq!(agent["startMs"], started["agents"][0]["startMs"]);
        let ran = agent["elapsedMs"].as_u64().expect("How long it ran");
        assert!((30..5000).contains(&ran), "{ran}");
    }
}
