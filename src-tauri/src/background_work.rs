//! Background work a Claude chat's CLI keeps running after the reply that started it.
//! A reply follows its own tasks through the tool decoder. When it ends, whatever it left
//! running stays with the parked process, whose output Agent Studio still observes, until
//! the CLI reports each outcome or the process tree is terminated. The running list is
//! transient state for this computer's window; only final outcomes update the saved reply.
use crate::pool::OutputObserver;
use crate::protocol::activity::{status, ToolActivity};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

pub const EVENT: &str = "studio-background-work";
const MAX_TRACKED: usize = 32;
const MAX_TASKS: usize = 256;
const MAX_ELAPSED_MS: u64 = 31_536_000_000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// The tool activity identity of the launching call.
    pub id: String,
    pub run_id: String,
    pub kind: &'static str,
    pub label: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub conversation_id: String,
    pub runs: Vec<Run>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub conversation_id: String,
    pub run_id: String,
    pub tool: ToolActivity,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// The conversation's running background work, replacing its previous list.
    Snapshot(Snapshot),
    /// The outcome of work that finished after its reply ended, for that saved reply.
    Tool(Box<Outcome>),
}

struct Tracked {
    run_id: String,
    /// The latest state its reply reported.
    tool: ToolActivity,
    /// When the call started by this watch's clock. Reported times arrive in whole seconds,
    /// so a report only ever moves it earlier.
    started: Instant,
    /// The reply ended, so this watch reports the outcome instead of its decoder.
    detached: bool,
}

impl Tracked {
    fn start(tool: &ToolActivity) -> Instant {
        let now = Instant::now();
        now.checked_sub(Duration::from_millis(tool.elapsed_ms.unwrap_or(0)))
            .unwrap_or(now)
    }
    fn elapsed(&self) -> u64 {
        (self.started.elapsed().as_millis() as u64)
            .max(self.tool.elapsed_ms.unwrap_or(0))
            .min(MAX_ELAPSED_MS)
    }
    fn run(&self) -> Run {
        let monitor = self.tool.is_monitor();
        Run {
            id: self.tool.id.clone(),
            run_id: self.run_id.clone(),
            kind: if monitor { "monitor" } else { "command" },
            label: self.tool.detail().map(str::to_owned).unwrap_or_else(|| {
                if monitor {
                    "Monitor"
                } else {
                    "Background command"
                }
                .into()
            }),
            elapsed_ms: self.elapsed(),
        }
    }
}

#[derive(Default)]
struct State {
    tracked: Vec<Tracked>,
    /// CLI task identities and the tool call that launched each one.
    tasks: HashMap<String, String>,
}

pub type Emit = Box<dyn Fn(Event) + Send + Sync>;

pub struct Watch {
    conversation: String,
    state: Mutex<State>,
    emit: Emit,
}

impl Watch {
    pub fn new(conversation: &str, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            conversation: conversation.into(),
            state: Mutex::new(State::default()),
            emit,
        })
    }
    fn list(&self, state: &State) -> Event {
        Event::Snapshot(Snapshot {
            conversation_id: self.conversation.clone(),
            runs: state.tracked.iter().map(Tracked::run).collect(),
        })
    }
    fn outcome(&self, tracked: Tracked, status: &str) -> Event {
        let elapsed = tracked.elapsed();
        let mut tool = tracked.tool;
        tool.status = status.into();
        tool.elapsed_ms = Some(elapsed);
        tool.revision += 1;
        Event::Tool(Box::new(Outcome {
            conversation_id: self.conversation.clone(),
            run_id: tracked.run_id,
            tool,
        }))
    }
    fn send(&self, events: Vec<Event>) {
        for event in events {
            (self.emit)(event);
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        match self.state.lock() {
            Ok(state) => Snapshot {
                conversation_id: self.conversation.clone(),
                runs: state.tracked.iter().map(Tracked::run).collect(),
            },
            Err(_) => Snapshot {
                conversation_id: self.conversation.clone(),
                runs: vec![],
            },
        }
    }
    /// A running reply reported this call. Background launches are listed while they run;
    /// an outcome the reply reports ends the listing, since its history already has it.
    pub fn tool(&self, run_id: &str, tool: &ToolActivity) {
        let mut events = vec![];
        if let Ok(mut state) = self.state.lock() {
            match state.tracked.iter().position(|t| t.tool.id == tool.id) {
                Some(index) if state.tracked[index].detached => {}
                Some(index) if tool.status == "running" => {
                    let tracked = &mut state.tracked[index];
                    tracked.started = tracked.started.min(Tracked::start(tool));
                    tracked.tool = tool.clone();
                }
                Some(index) => {
                    state.tracked.remove(index);
                    events.push(self.list(&state));
                }
                None if tool.background
                    && tool.status == "running"
                    && state.tracked.len() < MAX_TRACKED =>
                {
                    state.tracked.push(Tracked {
                        run_id: run_id.into(),
                        tool: tool.clone(),
                        started: Tracked::start(tool),
                        detached: false,
                    });
                    events.push(self.list(&state));
                }
                None => {}
            }
        }
        self.send(events);
    }
    /// The reply ended. Later outcomes of the work it left running come from this watch.
    pub fn detach(&self, run_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            for tracked in state.tracked.iter_mut().filter(|t| t.run_id == run_id) {
                tracked.detached = true;
            }
        }
    }
    /// Each stdout line of the CLI, including while its process is parked between replies.
    pub fn observe(&self, line: &str) {
        if line.len() > 64_000 || !line.contains("\"task_") {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if value["type"] != "system" {
            return;
        }
        let task = value["task_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 64);
        let call = value["tool_use_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 240);
        let mut events = vec![];
        if let Ok(mut state) = self.state.lock() {
            match value["subtype"].as_str() {
                Some("task_started") => {
                    if let (Some(task), Some(call)) = (task, call) {
                        if state.tasks.len() >= MAX_TASKS {
                            let tracked: Vec<_> =
                                state.tracked.iter().map(|t| t.tool.id.clone()).collect();
                            state
                                .tasks
                                .retain(|_, call| tracked.contains(&format!("claude:{call}")));
                        }
                        if state.tasks.len() < MAX_TASKS {
                            state.tasks.insert(task.into(), call.into());
                        }
                    }
                }
                Some("task_notification") => {
                    let call = call
                        .map(str::to_owned)
                        .or_else(|| task.and_then(|task| state.tasks.get(task).cloned()));
                    let outcome = status(value["status"].as_str().unwrap_or_default());
                    let id = call.map(|call| format!("claude:{call}"));
                    // A running reply's decoder reports the outcome of its own calls.
                    let index = state
                        .tracked
                        .iter()
                        .position(|t| t.detached && Some(&t.tool.id) == id.as_ref());
                    if let Some(index) = index.filter(|_| outcome != "running") {
                        let tracked = state.tracked.remove(index);
                        events.push(self.outcome(tracked, outcome));
                        events.push(self.list(&state));
                    }
                }
                _ => {}
            }
        }
        self.send(events);
    }
    /// The process tree was terminated, taking its background work with it. Calls of a
    /// running reply keep that reply's own stopped or unconfirmed outcome.
    pub fn ended(&self) {
        let mut events = vec![];
        if let Ok(mut state) = self.state.lock() {
            let tracked = std::mem::take(&mut state.tracked);
            if !tracked.is_empty() {
                for item in tracked.into_iter().filter(|t| t.detached) {
                    events.push(self.outcome(item, "cancelled"));
                }
                events.push(self.list(&state));
            }
        }
        self.send(events);
    }
}

/// Live watches by conversation, so a window that loads later can ask for current lists.
#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Weak<Watch>>>);

impl Registry {
    pub fn register(&self, watch: &Arc<Watch>) {
        if let Ok(mut watches) = self.0.lock() {
            watches.retain(|_, watch| watch.strong_count() > 0);
            watches.insert(watch.conversation.clone(), Arc::downgrade(watch));
        }
    }
    pub fn snapshots(&self) -> Vec<Snapshot> {
        let Ok(watches) = self.0.lock() else {
            return vec![];
        };
        watches
            .values()
            .filter_map(Weak::upgrade)
            .map(|watch| watch.snapshot())
            .filter(|snapshot| !snapshot.runs.is_empty())
            .collect()
    }
}

/// A watch for one conversation's Claude process that reports to this computer's window.
pub fn watch(app: &tauri::AppHandle, conversation: &str) -> Arc<Watch> {
    let emitter = app.clone();
    let watch = Watch::new(
        conversation,
        Box::new(move |event| {
            let _ = emitter.emit(EVENT, event);
        }),
    );
    if let Some(registry) = app.try_state::<Registry>() {
        registry.register(&watch);
    }
    watch
}

/// Feed the CLI's output to the account usage observer and the background watch.
pub fn observer(
    usage: Option<OutputObserver>,
    watch: Option<Arc<Watch>>,
) -> Option<OutputObserver> {
    if usage.is_none() && watch.is_none() {
        return None;
    }
    Some(Arc::new(move |line: &str| {
        if let Some(usage) = &usage {
            usage(line);
        }
        if let Some(watch) = &watch {
            watch.observe(line);
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::activity::ToolDecoder;
    use serde_json::json;

    fn watch() -> (Arc<Watch>, Arc<Mutex<Vec<Event>>>) {
        let events = Arc::new(Mutex::new(vec![]));
        let sink = events.clone();
        let watch = Watch::new(
            "conversation",
            Box::new(move |event| sink.lock().unwrap().push(event)),
        );
        (watch, events)
    }
    fn taken(events: &Arc<Mutex<Vec<Event>>>) -> Vec<Event> {
        std::mem::take(&mut *events.lock().unwrap())
    }
    fn runs(event: &Event) -> Vec<(&str, &str, &str)> {
        match event {
            Event::Snapshot(snapshot) => snapshot
                .runs
                .iter()
                .map(|r| (r.id.as_str(), r.kind, r.label.as_str()))
                .collect(),
            Event::Tool(_) => panic!("expected a snapshot"),
        }
    }
    /// Launch a background call through the real decoder, as a reply reports it.
    fn launch(
        decoder: &mut ToolDecoder,
        call: &str,
        name: &str,
        input: Value,
        result: Value,
    ) -> ToolActivity {
        decoder.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":call,"name":name,"input":input}]}}));
        decoder.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":call,"content":"PRIVATE_OUTPUT"}]},"tool_use_result":result})).remove(0)
    }
    fn line(value: Value) -> String {
        value.to_string()
    }

    #[test]
    fn work_left_running_is_listed_until_the_cli_reports_its_outcome() {
        let (watch, events) = watch();
        let mut decoder = ToolDecoder::default();
        let server = launch(
            &mut decoder,
            "server",
            "Bash",
            json!({"description":"Start the preview server","command":"npm run preview","run_in_background":true}),
            json!({"backgroundTaskId":"b1"}),
        );
        let monitor = launch(
            &mut decoder,
            "watch",
            "Monitor",
            json!({"description":"Build failures","command":"tail -f build.log"}),
            json!({"taskId":"b2"}),
        );
        watch.tool("run-1", &server);
        watch.tool("run-1", &monitor);
        let listed = taken(&events);
        assert_eq!(
            runs(listed.last().unwrap()),
            [
                ("claude:server", "command", "Start the preview server"),
                ("claude:watch", "monitor", "Build failures")
            ]
        );
        // The list names work by its description; the call record keeps the command.
        assert!(!serde_json::to_string(&listed)
            .unwrap()
            .contains("npm run preview"));
        // Revisions from the running reply refresh the timer without another list.
        watch.tool("run-1", &server);
        assert!(taken(&events).is_empty());
        // While the reply runs, its decoder reports outcomes, never this watch.
        watch.observe(&line(
            json!({"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"server","task_type":"local_bash"}),
        ));
        watch.observe(&line(
            json!({"type":"system","subtype":"task_notification","task_id":"b2","tool_use_id":"watch","status":"stopped"}),
        ));
        assert!(taken(&events).is_empty());
        watch.detach("run-1");
        {
            let mut state = watch.state.lock().unwrap();
            state.tracked[0].started -= Duration::from_secs(90);
        }
        assert!(watch.snapshot().runs[0].elapsed_ms >= 90_000);
        // A notification without a tool identity resolves through task_started.
        watch.observe(&line(
            json!({"type":"system","subtype":"task_notification","task_id":"b1","status":"completed","summary":"PRIVATE_SUMMARY","output_file":"PRIVATE_PATH"}),
        ));
        let finished = taken(&events);
        let Event::Tool(outcome) = &finished[0] else {
            panic!("expected an outcome")
        };
        assert_eq!(outcome.run_id, "run-1");
        assert_eq!(outcome.tool.id, "claude:server");
        assert_eq!(outcome.tool.status, "complete");
        assert!(outcome.tool.background);
        assert_eq!(outcome.tool.revision, server.revision + 1);
        assert!(outcome.tool.elapsed_ms.unwrap() >= 90_000);
        assert_eq!(
            runs(&finished[1]),
            [("claude:watch", "monitor", "Build failures")]
        );
        let serialized = serde_json::to_string(&finished).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(serialized.contains("\"kind\":\"tool\""));
        assert!(serialized.contains("\"conversationId\":\"conversation\""));
        // Duplicate, foreign and malformed lines change nothing.
        for text in [
            line(
                json!({"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}),
            ),
            line(
                json!({"type":"system","subtype":"task_notification","task_id":"other","tool_use_id":"other","status":"failed"}),
            ),
            line(
                json!({"type":"user","subtype":"task_notification","tool_use_id":"watch","status":"failed"}),
            ),
            "{\"type\":\"system\",\"subtype\":\"task_notification\"".into(),
        ] {
            watch.observe(&text);
        }
        assert!(taken(&events).is_empty());
        assert_eq!(watch.snapshot().runs.len(), 1);
    }

    #[test]
    fn a_reported_outcome_ends_the_listing_and_process_end_stops_detached_work() {
        let (watch, events) = watch();
        let mut decoder = ToolDecoder::default();
        let tests = launch(
            &mut decoder,
            "tests",
            "Bash",
            json!({"description":"Run the tests","run_in_background":true}),
            json!({"backgroundTaskId":"b1"}),
        );
        let server = launch(
            &mut decoder,
            "server",
            "PowerShell",
            json!({"description":"Start the server","run_in_background":true}),
            json!({"backgroundTaskId":"b2"}),
        );
        // Foreground calls are never listed.
        let plain = launch(
            &mut decoder,
            "plain",
            "Bash",
            json!({"description":"List files"}),
            json!({"stdout":"PRIVATE_OUTPUT"}),
        );
        for tool in [&tests, &server, &plain] {
            watch.tool("run-1", tool);
        }
        assert_eq!(watch.snapshot().runs.len(), 2);
        let finished = decoder.decode("claude", &json!({"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"tests","status":"completed"})).remove(0);
        watch.tool("run-1", &finished);
        assert_eq!(runs(&taken(&events).pop().unwrap()).len(), 1);
        // The next reply reuses the process; its own work is listed beside the earlier server.
        watch.detach("run-1");
        let mut next = ToolDecoder::default();
        let build = launch(
            &mut next,
            "build",
            "Bash",
            json!({"description":"Build the image","run_in_background":true}),
            json!({"backgroundTaskId":"b3"}),
        );
        watch.tool("run-2", &build);
        assert_eq!(watch.snapshot().runs.len(), 2);
        taken(&events);
        watch.ended();
        let ended = taken(&events);
        assert_eq!(
            ended.len(),
            2,
            "one outcome for the detached server, one empty list"
        );
        let Event::Tool(outcome) = &ended[0] else {
            panic!("expected an outcome")
        };
        assert_eq!(
            (outcome.tool.id.as_str(), outcome.tool.status.as_str()),
            ("claude:server", "cancelled")
        );
        assert!(runs(&ended[1]).is_empty());
        watch.ended();
        assert!(taken(&events).is_empty());
    }

    #[test]
    fn registry_lists_live_watches_with_current_elapsed_time() {
        let registry = Registry::default();
        let (first, _) = watch();
        registry.register(&first);
        assert!(registry.snapshots().is_empty());
        let mut decoder = ToolDecoder::default();
        let server = launch(
            &mut decoder,
            "server",
            "Bash",
            json!({"run_in_background":true}),
            json!({"backgroundTaskId":"b1"}),
        );
        first.tool("run-1", &server);
        first.state.lock().unwrap().tracked[0].started -= Duration::from_secs(5);
        let snapshots = registry.snapshots();
        assert_eq!(snapshots[0].runs[0].label, "Background command");
        assert!(snapshots[0].runs[0].elapsed_ms >= 5000);
        drop(first);
        assert!(registry.snapshots().is_empty());
        let (bounded, _) = watch();
        for index in 0..MAX_TRACKED + 4 {
            let call = format!("call{index}");
            let tool = launch(
                &mut decoder,
                &call,
                "Bash",
                json!({"run_in_background":true}),
                json!({"backgroundTaskId":call}),
            );
            bounded.tool("run", &tool);
        }
        assert_eq!(bounded.snapshot().runs.len(), MAX_TRACKED);
    }
}
