//! Reserving this computer for a performance measurement (docs/RESERVATIONS.md; requested
//! 2026-11-24, after chats threw benchmark results away because other chats started Unreal
//! sessions while they measured). Chats work side by side as before; only a measurement takes the
//! computer for itself, and it does so as a reservation rather than by waiting for quiet, which
//! never comes while several chats work.
//!
//! A chat reserves the computer (`pc_reserve`). From that moment no other chat starts a command
//! other than a light one (`light`): Claude chats' commands are refused before they start by a
//! `PreToolUse` hook (`tools::gate`), which tells them to call `pc_wait`, a tool that returns once
//! the computer is free. The reservation's window opens once no other chat runs a command, or
//! background work a running reply of its own still waits on; the chat that reserved waits for it
//! with `pc_wait` too. While the window is open the computer is measured (`machine`), and
//! releasing it (`pc_release`, or the end of the reply that reserved it) gives a report: what kept
//! the window closed and for how long, what else ran while it was open, what the computer did,
//! and how long the other chats waited and because of what. Each report is kept in app data
//! `reservations/history.jsonl`. Reservations take turns, first come first served, and nothing is
//! capped: a reservation, a wait and a queue last as long as their chats need.
pub mod codex_gate;
pub mod jobs;
mod light;
pub mod machine;
pub mod tools;

use crate::protocol::activity::ToolActivity;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// The event this computer's window follows reservations with.
pub const EVENT: &str = "studio-pc";
/// How often a reservation looks at the computer while it waits or is open.
const TICK: Duration = Duration::from_secs(2);

/// Background work a chat's CLI keeps running (`background_work`), as reservations see it.
#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundWork {
    pub conversation: String,
    /// The tool activity identity of the call that launched it.
    pub id: String,
    pub label: String,
}

pub type Emit = Box<dyn Fn(&Snapshot) + Send + Sync>;
pub type Titles = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
pub type Background = Box<dyn Fn() -> Vec<BackgroundWork> + Send + Sync>;

/// What this computer's window shows of the reservations.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub reservations: Vec<View>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub conversation_id: String,
    pub purpose: String,
    /// `queued` behind another, `draining` while other chats' work finishes, or `open`.
    pub phase: &'static str,
    pub asked_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<f64>,
    /// What the window still waits for.
    pub waiting_for: Vec<Blocker>,
    /// The chats that wait for this reservation to end.
    pub held: usize,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub conversation_id: String,
    pub label: String,
}

/// A report on a reservation that ended, for the chat that held it and the history.
#[derive(Clone, Debug)]
pub struct Report {
    pub text: String,
    pub record: Value,
}

pub struct Broker {
    state: Mutex<State>,
    version: watch::Sender<u64>,
    emit: Emit,
    titles: Titles,
    background: Background,
    history: Option<PathBuf>,
    /// Which chat each process belongs to.
    pub jobs: jobs::Jobs,
}

#[derive(Default)]
struct State {
    /// The replies running on this computer, by run id.
    runs: HashMap<String, Run>,
    /// First come first served: the first holds the computer, the rest wait their turn.
    queue: Vec<Reservation>,
    /// Chats waiting in `pc_wait` for the computer to be free, kept until no reservation they
    /// overlap is left to report them.
    waits: Vec<Wait>,
    /// Calls the gate refused, which Claude Code reports as started before it asks the gate:
    /// they never ran, so they count for nothing until they end.
    refused: HashSet<String>,
    next: u64,
    ticking: bool,
}
struct Run {
    conversation: String,
    /// The commands it runs, by tool activity identity.
    calls: HashMap<String, Call>,
}
struct Call {
    label: String,
    light: bool,
    /// The lengths of the command and description it was read from: Claude streams a call's
    /// input, so its first report may name neither.
    read: (usize, usize),
}
struct Wait {
    id: u64,
    conversation: String,
    from: Instant,
    until: Option<Instant>,
}
struct Reservation {
    id: String,
    conversation: String,
    run_id: String,
    purpose: String,
    minutes: Option<f64>,
    asked: Instant,
    asked_at: u64,
    /// When it came first in line.
    first: Option<Instant>,
    opened: Option<Instant>,
    opened_at: Option<u64>,
    /// What kept the window closed, and for how long.
    blockers: Vec<Span>,
    /// Other chats' work that ran while the window was open.
    others: Vec<Span>,
    /// Commands of other chats refused while it held the computer.
    refused: u32,
    /// Those commands' calls, which its report leaves out of what ran.
    refused_calls: HashSet<String>,
    measure: machine::Window,
}
#[derive(Clone, Debug)]
struct Span {
    key: String,
    conversation: String,
    label: String,
    from: Instant,
    until: Option<Instant>,
}
/// Work another chat runs now.
struct Item {
    key: String,
    conversation: String,
    label: String,
    light: bool,
    /// Its reply still runs, so it is work in progress rather than something left running.
    in_progress: bool,
}

impl Broker {
    pub fn new(
        emit: Emit,
        titles: Titles,
        background: Background,
        history: Option<PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            version: watch::channel(0).0,
            emit,
            titles,
            background,
            history,
            jobs: jobs::Jobs::default(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Tells waiters and the window that something changed.
    fn publish(&self, snapshot: Snapshot) {
        self.version.send_modify(|version| *version += 1);
        (self.emit)(&snapshot);
    }

    /// A reply of `conversation` began on this computer.
    pub fn run_started(&self, run_id: &str, conversation: &str) {
        self.lock().runs.insert(
            run_id.into(),
            Run {
                conversation: conversation.into(),
                calls: HashMap::new(),
            },
        );
    }

    /// A call a running reply reported. Commands and monitors count while they run.
    pub fn tool(&self, run_id: &str, tool: &ToolActivity) {
        if !(tool.runs_command() || tool.is_monitor()) {
            return;
        }
        let update = {
            let mut state = self.lock();
            if state.refused.contains(&tool.id) {
                if tool.status != "running" {
                    state.refused.remove(&tool.id);
                }
                return;
            }
            let Some(run) = state.runs.get_mut(run_id) else {
                return;
            };
            if tool.status == "running" {
                let command = tool.command().unwrap_or_default();
                let read = (command.len(), tool.detail().map_or(0, str::len));
                if run
                    .calls
                    .get(&tool.id)
                    .is_some_and(|call| call.read == read)
                {
                    return;
                }
                run.calls.insert(
                    tool.id.clone(),
                    Call {
                        label: label_of(tool),
                        light: !command.is_empty() && light::is_light(command),
                        read,
                    },
                );
            } else if run.calls.remove(&tool.id).is_none() {
                return;
            }
            self.settled(&mut state, Instant::now())
        };
        if let Some(snapshot) = update {
            self.publish(snapshot);
        }
    }

    /// The reply `run_id` ended: its commands with it, and a reservation it held.
    pub fn run_ended(&self, run_id: &str) {
        let (report, snapshot) = {
            let mut state = self.lock();
            state.runs.remove(run_id);
            let report = state
                .queue
                .iter()
                .position(|r| r.run_id == run_id)
                .map(|index| self.end(&mut state, index, Instant::now(), "reply"));
            let changed = self.settled(&mut state, Instant::now());
            let snapshot = match (&report, changed) {
                (_, Some(snapshot)) => Some(snapshot),
                (Some(_), None) => Some(self.view(&state)),
                (None, None) => None,
            };
            (report, snapshot)
        };
        if let Some(report) = &report {
            self.keep(report);
        }
        if let Some(snapshot) = snapshot {
            self.publish(snapshot);
        }
    }

    /// Background work moved: what a reservation waits for may have changed.
    pub fn changed(&self) {
        let update = {
            let mut state = self.lock();
            if state.queue.is_empty() {
                return;
            }
            self.settled(&mut state, Instant::now())
        };
        if let Some(snapshot) = update {
            self.publish(snapshot);
        }
    }

    /// Settles the first reservation against what runs now, and returns the window's view when
    /// anything changed.
    fn settled(&self, state: &mut State, now: Instant) -> Option<Snapshot> {
        if state.queue.is_empty() {
            return None;
        }
        let items = items(state, &(self.background)());
        settle(state, &items, now).then(|| self.view(state))
    }

    /// Reserves the computer for `conversation`'s reply `run_id`, or brings up to date the
    /// reservation it has. The answer says where it stands.
    pub fn reserve(
        self: &Arc<Self>,
        run_id: &str,
        conversation: &str,
        purpose: &str,
        minutes: Option<f64>,
    ) -> String {
        let (text, snapshot, tick) = {
            let mut state = self.lock();
            let now = Instant::now();
            if let Some(existing) = state
                .queue
                .iter_mut()
                .find(|r| r.conversation == conversation)
            {
                if !purpose.trim().is_empty() {
                    existing.purpose = purpose.trim().into();
                }
                existing.minutes = minutes.or(existing.minutes);
                existing.run_id = run_id.into();
            } else {
                state.next += 1;
                let id = format!("pc-{}", state.next);
                state.queue.push(Reservation {
                    id,
                    conversation: conversation.into(),
                    run_id: run_id.into(),
                    purpose: purpose.trim().into(),
                    minutes,
                    asked: now,
                    asked_at: epoch_ms(),
                    first: None,
                    opened: None,
                    opened_at: None,
                    blockers: vec![],
                    others: vec![],
                    refused: 0,
                    refused_calls: HashSet::new(),
                    measure: machine::Window::default(),
                });
            }
            let items = items(&state, &(self.background)());
            settle(&mut state, &items, now);
            let text = self.standing(&state, conversation, &items);
            let tick = !std::mem::replace(&mut state.ticking, true);
            (text, self.view(&state), tick)
        };
        self.publish(snapshot);
        if tick {
            let broker = self.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(TICK).await;
                    if !broker.tick().await {
                        break;
                    }
                }
            });
        }
        text
    }

    /// Looks at the computer: settles the first reservation and measures an open window.
    /// Returns whether any reservation is left to look after.
    async fn tick(self: &Arc<Self>) -> bool {
        let measuring = {
            let mut state = self.lock();
            if state.queue.is_empty() {
                state.ticking = false;
                return false;
            }
            state.queue[0].opened.is_some()
        };
        let reading = if measuring {
            tauri::async_runtime::spawn_blocking(machine::read)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let members = reading.as_ref().map(|_| self.jobs.members());
        let update = {
            let mut state = self.lock();
            if state.queue.is_empty() {
                state.ticking = false;
                return false;
            }
            if let (Some(reading), Some(members)) = (reading, members) {
                let holder = state.queue[0].conversation.clone();
                if state.queue[0].opened.is_some() {
                    let owners = machine::Owners::new(&reading, &members, std::process::id());
                    state.queue[0].measure.add(reading, &owners, &holder);
                }
            }
            self.settled(&mut state, Instant::now())
        };
        if let Some(snapshot) = update {
            self.publish(snapshot);
        }
        true
    }

    /// Ends `conversation`'s reservation and reports on it.
    pub fn release(&self, conversation: &str) -> Option<Report> {
        let (report, snapshot) = {
            let mut state = self.lock();
            let index = state
                .queue
                .iter()
                .position(|r| r.conversation == conversation)?;
            let report = self.end(&mut state, index, Instant::now(), "release");
            self.settled(&mut state, Instant::now());
            (report, self.view(&state))
        };
        self.keep(&report);
        self.publish(snapshot);
        Some(report)
    }

    /// Takes reservation `index` out of line and reports on it.
    fn end(&self, state: &mut State, index: usize, now: Instant, by: &str) -> Report {
        let mut reservation = state.queue.remove(index);
        for span in reservation
            .blockers
            .iter_mut()
            .chain(reservation.others.iter_mut())
            .filter(|s| s.until.is_none())
        {
            span.until = Some(now);
        }
        let report = self.report(&reservation, &state.waits, now, by);
        // Waits that ended before every reservation still in line began report nothing more.
        let oldest = state.queue.iter().map(|r| r.asked).min();
        state
            .waits
            .retain(|w| w.until.is_none() || oldest.is_some_and(|o| w.until > Some(o)));
        report
    }

    /// Whether a command `conversation` wants to start must wait: the reason to give, or None.
    /// `call` is the tool activity identity of the call asking, which then never ran, and `wait`
    /// the name the asking agent calls `pc_wait` by.
    pub fn gate(
        &self,
        conversation: &str,
        command: &str,
        call: Option<&str>,
        wait: &str,
    ) -> Option<String> {
        let (reason, snapshot) = {
            let mut state = self.lock();
            let first = state.queue.first_mut()?;
            if first.conversation == conversation || light::is_light(command) {
                return None;
            }
            first.refused += 1;
            if let Some(call) = call {
                first.refused_calls.insert(call.into());
                state.refused.insert(call.into());
                for run in state.runs.values_mut() {
                    run.calls.remove(call);
                }
            }
            let reason = self.refusal(&state.queue[0], wait);
            (reason, self.settled(&mut state, Instant::now()))
        };
        if let Some(snapshot) = snapshot {
            self.publish(snapshot);
        }
        Some(reason)
    }

    fn refusal(&self, first: &Reservation, wait: &str) -> String {
        format!(
            "This command did not run: {} reserved this computer for a performance measurement ({}), and other chats' commands wait until it ends, {}. Call {wait}, which returns once the computer is free, then run the same command again. Meanwhile keep reading and editing files; light commands such as git status, ls and rg still run.",
            self.chat(&first.conversation),
            first.purpose,
            match first.opened {
                Some(opened) => format!(
                    "and it has been measuring for {}{}",
                    duration(opened.elapsed()),
                    first
                        .minutes
                        .map(|m| format!(" of about {}", duration(Duration::from_secs_f64(m.max(0.0) * 60.0))))
                        .unwrap_or_default()
                ),
                None => "and it waits for other chats' commands to finish first".into(),
            }
        )
    }

    /// Waits for `conversation`'s turn: the window of its own reservation, or else for no other
    /// chat to hold the computer. The answer says how long it waited and what for.
    pub async fn wait(
        &self,
        conversation: &str,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        let mut changes = self.version.subscribe();
        let began = Instant::now();
        let own = self
            .lock()
            .queue
            .iter()
            .any(|r| r.conversation == conversation);
        let mut guard = None;
        loop {
            let mut registered = false;
            {
                let mut state = self.lock();
                if own {
                    let Some(index) = state
                        .queue
                        .iter()
                        .position(|r| r.conversation == conversation)
                    else {
                        return Err(
                            "This chat's reservation ended before its window opened.".into()
                        );
                    };
                    let reservation = &state.queue[index];
                    if index == 0 && reservation.opened.is_some() {
                        return Ok(self.opened_text(reservation, began.elapsed()));
                    }
                } else {
                    let holder = state
                        .queue
                        .first()
                        .filter(|r| r.conversation != conversation)
                        .map(|r| r.conversation.clone());
                    match holder {
                        None => {
                            drop(state);
                            let waited = guard.take().is_some();
                            return Ok(if waited {
                                format!(
                                    "The computer is free again after {}: run your command now.",
                                    duration(began.elapsed())
                                )
                            } else {
                                "The computer is not reserved: run your command now.".into()
                            });
                        }
                        Some(_) if guard.is_none() => {
                            state.next += 1;
                            let id = state.next;
                            state.waits.push(Wait {
                                id,
                                conversation: conversation.into(),
                                from: Instant::now(),
                                until: None,
                            });
                            guard = Some(WaitGuard { broker: self, id });
                            registered = true;
                        }
                        Some(_) => {}
                    }
                }
            }
            if registered {
                // The window shows how many chats wait.
                let snapshot = self.view(&self.lock());
                (self.emit)(&snapshot);
            }
            tokio::select! {
                changed = changes.changed() => if changed.is_err() { return Err("Agent Studio stopped following reservations.".into()) },
                _ = cancel.cancelled() => return Err("Stopped while waiting for the computer.".into()),
            }
        }
    }

    fn opened_text(&self, reservation: &Reservation, waited: Duration) -> String {
        let mut text = format!(
            "The window is open: no other chat runs a command now, and their new commands wait until you call pc_release. Measure now, then release at once and analyze afterwards. You waited {}.",
            duration(waited)
        );
        let blockers = summed(
            &reservation.blockers,
            reservation.opened.unwrap_or_else(Instant::now),
        );
        if !blockers.is_empty() {
            text.push_str(" Before it opened: ");
            text.push_str(&self.spans_text(&blockers));
            text.push('.');
        }
        text
    }

    /// What the window shows now.
    pub fn snapshot(&self) -> Snapshot {
        self.view(&self.lock())
    }

    fn view(&self, state: &State) -> Snapshot {
        let waiting: HashSet<&str> = state
            .waits
            .iter()
            .filter(|w| w.until.is_none())
            .map(|w| w.conversation.as_str())
            .collect();
        Snapshot {
            reservations: state
                .queue
                .iter()
                .enumerate()
                .map(|(index, r)| View {
                    id: r.id.clone(),
                    conversation_id: r.conversation.clone(),
                    purpose: r.purpose.clone(),
                    phase: match (index, r.opened) {
                        (0, Some(_)) => "open",
                        (0, None) => "draining",
                        _ => "queued",
                    },
                    asked_at: r.asked_at,
                    opened_at: r.opened_at,
                    minutes: r.minutes,
                    waiting_for: if index == 0 && r.opened.is_none() {
                        r.blockers
                            .iter()
                            .filter(|s| s.until.is_none())
                            .map(|s| Blocker {
                                conversation_id: s.conversation.clone(),
                                label: s.label.clone(),
                            })
                            .collect()
                    } else {
                        vec![]
                    },
                    held: if index == 0 { waiting.len() } else { 0 },
                })
                .collect(),
        }
    }

    /// The name a chat goes by in text for agents.
    fn chat(&self, conversation: &str) -> String {
        match (self.titles)(conversation).filter(|t| !t.trim().is_empty()) {
            Some(title) => format!("the chat \"{}\"", title.trim()),
            None => "another chat".into(),
        }
    }

    /// Where `conversation` stands, with what other chats run now.
    fn standing(&self, state: &State, conversation: &str, items: &[Item]) -> String {
        let Some(index) = state
            .queue
            .iter()
            .position(|r| r.conversation == conversation)
        else {
            return "This chat holds no reservation.".into();
        };
        let mine = &state.queue[index];
        let mut text = if index > 0 {
            let first = &state.queue[0];
            format!(
                "Reserved, after {} ({}), whose turn comes first{}. Other chats' new commands, yours included, wait until it ends. Call pc_wait: it returns once your window opens.",
                self.chat(&first.conversation),
                first.purpose,
                if index > 1 { format!(", and {} more before you", index - 1) } else { String::new() }
            )
        } else if mine.opened.is_some() {
            "Reserved, and the window is open: no other chat runs a command now. Measure, then call pc_release.".into()
        } else {
            "Reserved: from now on other chats' commands wait, except light ones such as git status. Call pc_wait: it returns once the work below has finished and the window opens.".into()
        };
        let others: Vec<&Item> = items
            .iter()
            .filter(|i| i.conversation != conversation && !i.light)
            .collect();
        let (progress, left): (Vec<&&Item>, Vec<&&Item>) =
            others.iter().partition(|i| i.in_progress);
        if !progress.is_empty() {
            text.push_str("\nStill running in other chats (the window waits for these):");
            for item in progress {
                text.push_str(&format!(
                    "\n- {}: {}",
                    self.chat(&item.conversation),
                    item.label
                ));
            }
        }
        if !left.is_empty() {
            text.push_str("\nLeft running by other chats whose replies ended (the window does not wait for these; ask the user before measuring if they matter):");
            for item in left {
                text.push_str(&format!(
                    "\n- {}: {}",
                    self.chat(&item.conversation),
                    item.label
                ));
            }
        }
        text
    }

    /// Where the computer stands for `conversation`, with what runs on it now.
    pub fn status(&self, conversation: &str, now: Option<&machine::Now>) -> String {
        let state = self.lock();
        let items = items(&state, &(self.background)());
        let mut text = match state.queue.first() {
            None => "The computer is not reserved.".to_string(),
            Some(first) if first.conversation == conversation => {
                if first.opened.is_some() {
                    "This chat holds the computer and its window is open.".into()
                } else {
                    "This chat holds the computer; its window opens once the work listed below finishes. Call pc_wait.".into()
                }
            }
            Some(first) => format!(
                "{} holds the computer ({}); {}. Other chats' commands wait until it ends: call pc_wait before running one.",
                capitalized(&self.chat(&first.conversation)),
                first.purpose,
                if first.opened.is_some() { "its window is open" } else { "it waits for other chats' commands to finish" }
            ),
        };
        if let Some(index) = state
            .queue
            .iter()
            .position(|r| r.conversation == conversation)
            .filter(|i| *i > 0)
        {
            text.push_str(&format!(
                " This chat's reservation is number {} in line.",
                index + 1
            ));
        }
        let others: Vec<&Item> = items
            .iter()
            .filter(|i| i.conversation != conversation)
            .collect();
        if others.is_empty() {
            text.push_str("\nNo other chat runs a command or background work now.");
        } else {
            text.push_str("\nOther chats' work now:");
            for item in others {
                text.push_str(&format!(
                    "\n- {}: {}{}",
                    self.chat(&item.conversation),
                    item.label,
                    match (item.in_progress, item.light) {
                        (_, true) => " (light)",
                        (true, false) => "",
                        (false, false) => " (left running after its reply ended)",
                    }
                ));
            }
        }
        if let Some(now) = now {
            text.push('\n');
            text.push_str(&now.text(|conversation| self.chat(conversation)));
        }
        text
    }

    /// Spans summed by what they were, longest first, as text.
    fn spans_text(&self, spans: &[(String, String, Duration)]) -> String {
        spans
            .iter()
            .map(|(conversation, label, time)| {
                format!(
                    "{} {} for {}",
                    self.chat(conversation),
                    label,
                    duration(*time)
                )
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    fn report(&self, r: &Reservation, waits: &[Wait], now: Instant, by: &str) -> Report {
        let opened_after = r.opened.map(|o| o.saturating_duration_since(r.asked));
        let window = r.opened.map(|o| now.saturating_duration_since(o));
        let mut lines = vec![format!(
            "Released the computer (reserved for: {}){}.",
            r.purpose,
            if by == "reply" {
                " when the reply that reserved it ended"
            } else {
                ""
            }
        )];
        match (opened_after, window) {
            (Some(after), Some(window)) => lines.push(format!(
                "The window opened {} after the reservation and stayed open {}.",
                duration(after),
                duration(window)
            )),
            _ => lines.push(format!(
                "It ended before its window opened, {} after the reservation.",
                duration(now.saturating_duration_since(r.asked))
            )),
        }
        // A command the gate refused never ran, though Claude Code reported it as started.
        let ran = |spans: &[Span]| -> Vec<Span> {
            spans
                .iter()
                .filter(|s| !r.refused_calls.contains(&s.key))
                .cloned()
                .collect()
        };
        let blockers = summed(&ran(&r.blockers), r.opened.unwrap_or(now));
        if blockers.is_empty() {
            lines.push("Nothing of other chats' kept the window closed.".into());
        } else {
            lines.push(format!("Before it opened: {}.", self.spans_text(&blockers)));
        }
        if r.opened.is_some() {
            let others = summed(&ran(&r.others), now);
            if others.is_empty() {
                lines.push("During it, no other chat ran a command.".into());
            } else {
                lines.push(format!(
                    "Other chats' work that ran during it anyway: {}.",
                    self.spans_text(&others)
                ));
            }
            if let Some(text) = r.measure.text(|conversation| self.chat(conversation)) {
                lines.push(text);
            }
        }
        let held = held(r, waits, now);
        if held.chats > 0 || r.refused > 0 {
            let mut line = format!(
                "Other chats meanwhile: {} waited {} in all",
                plural(held.chats, "chat", "chats"),
                duration(held.total)
            );
            let causes: Vec<String> = held
                .causes
                .iter()
                .filter(|(_, _, time)| !time.is_zero())
                .map(|(conversation, label, time)| {
                    format!(
                        "{} while {} ran {}",
                        duration(*time),
                        self.chat(conversation),
                        label
                    )
                })
                .collect();
            if !causes.is_empty() {
                line.push_str(&format!(" ({})", causes.join("; ")));
            }
            line.push_str(&format!(
                ", and {} waited.",
                plural(r.refused as usize, "command", "commands")
            ));
            lines.push(line);
        }
        let record = json!({
            "id": r.id,
            "conversationId": r.conversation,
            "purpose": r.purpose,
            "minutes": r.minutes,
            "askedAt": r.asked_at,
            "openedAt": r.opened_at,
            "endedAt": epoch_ms(),
            "endedBy": by,
            "waitedMs": opened_after.map(ms),
            "windowMs": window.map(ms),
            "blockers": blockers.iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
            "others": summed(&ran(&r.others), now).iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
            "held": {
                "chats": held.chats,
                "ms": ms(held.total),
                "refused": r.refused,
                "causes": held.causes.iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
            },
            "machine": r.measure.record(),
        });
        Report {
            text: lines.join("\n"),
            record,
        }
    }

    /// Appends a report to this computer's history of reservations.
    fn keep(&self, report: &Report) {
        let Some(path) = &self.history else { return };
        if let Some(folder) = path.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{}", report.record);
        }
    }
}

/// Ends a chat's wait when `pc_wait` returns, is stopped or its reply goes.
struct WaitGuard<'a> {
    broker: &'a Broker,
    id: u64,
}
impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let snapshot = {
            let mut state = self.broker.lock();
            if let Some(wait) = state.waits.iter_mut().find(|w| w.id == self.id) {
                wait.until = Some(Instant::now());
            }
            if state.queue.is_empty() {
                state.waits.clear();
            }
            self.broker.view(&state)
        };
        (self.broker.emit)(&snapshot);
    }
}

/// The work other chats run now: their commands, and the background work their CLIs keep.
fn items(state: &State, background: &[BackgroundWork]) -> Vec<Item> {
    let mut items: Vec<Item> = state
        .runs
        .values()
        .flat_map(|run| {
            run.calls.iter().map(|(id, call)| Item {
                key: id.clone(),
                conversation: run.conversation.clone(),
                label: call.label.clone(),
                light: call.light,
                in_progress: true,
            })
        })
        .collect();
    let running: HashSet<&str> = state
        .runs
        .values()
        .map(|r| r.conversation.as_str())
        .collect();
    for work in background {
        if items.iter().any(|item| item.key == work.id) {
            continue;
        }
        items.push(Item {
            key: work.id.clone(),
            conversation: work.conversation.clone(),
            label: format!("background {}", work.label),
            light: false,
            in_progress: running.contains(work.conversation.as_str()),
        });
    }
    items.sort_by(|a, b| a.conversation.cmp(&b.conversation).then(a.key.cmp(&b.key)));
    items
}

/// Brings the first reservation up to date with `items`: what keeps its window closed, whether
/// it opens, and what else runs once it is open. Returns whether anything changed.
fn settle(state: &mut State, items: &[Item], now: Instant) -> bool {
    let Some(first) = state.queue.first_mut() else {
        return false;
    };
    let mut changed = false;
    if first.first.is_none() {
        first.first = Some(now);
        changed = true;
    }
    let others: Vec<&Item> = items
        .iter()
        .filter(|i| i.conversation != first.conversation && !i.light)
        .collect();
    if first.opened.is_none() {
        let blocking: Vec<&Item> = others.iter().copied().filter(|i| i.in_progress).collect();
        changed |= track(&mut first.blockers, &blocking, now);
        if blocking.is_empty() {
            first.opened = Some(now);
            first.opened_at = Some(epoch_ms());
            changed = true;
        }
    }
    if first.opened.is_some() {
        changed |= track(&mut first.others, &others, now);
    }
    changed
}

/// Starts a span for each item not yet followed, ends those whose work ended, and names the
/// others as their work is now known: a call's first report may lack its command.
fn track(spans: &mut Vec<Span>, items: &[&Item], now: Instant) -> bool {
    let mut changed = false;
    let live: HashMap<&str, &Item> = items.iter().map(|i| (i.key.as_str(), *i)).collect();
    for span in spans.iter_mut().filter(|s| s.until.is_none()) {
        match live.get(span.key.as_str()) {
            None => {
                span.until = Some(now);
                changed = true;
            }
            Some(item) if item.label != span.label => {
                span.label = item.label.clone();
                changed = true;
            }
            Some(_) => {}
        }
    }
    for item in items {
        if !spans.iter().any(|s| s.until.is_none() && s.key == item.key) {
            spans.push(Span {
                key: item.key.clone(),
                conversation: item.conversation.clone(),
                label: item.label.clone(),
                from: now,
                until: None,
            });
            changed = true;
        }
    }
    changed
}

/// Spans by chat and label, each with the time they ran up to `end`, longest first.
fn summed(spans: &[Span], end: Instant) -> Vec<(String, String, Duration)> {
    let mut sums: Vec<(String, String, Duration)> = vec![];
    for span in spans {
        let until = span.until.unwrap_or(end).min(end);
        let time = until.saturating_duration_since(span.from);
        match sums
            .iter_mut()
            .find(|(c, l, _)| *c == span.conversation && *l == span.label)
        {
            Some(sum) => sum.2 += time,
            None => sums.push((span.conversation.clone(), span.label.clone(), time)),
        }
    }
    sums.sort_by_key(|sum| std::cmp::Reverse(sum.2));
    sums
}

/// How long other chats waited for a reservation, and what kept them waiting.
struct Held {
    chats: usize,
    total: Duration,
    /// Time attributed to what kept the window closed, by chat and work, longest first. Time
    /// several things shared is split between them; the rest is the window itself.
    causes: Vec<(String, String, Duration)>,
}
fn held(r: &Reservation, waits: &[Wait], now: Instant) -> Held {
    let start = r.first.unwrap_or(r.asked);
    let mut chats = HashSet::new();
    let mut total = Duration::ZERO;
    let mut causes: Vec<(String, String, Duration)> = vec![];
    for wait in waits.iter().filter(|w| w.conversation != r.conversation) {
        let from = wait.from.max(start);
        let until = wait.until.unwrap_or(now).min(now);
        if until <= from {
            continue;
        }
        chats.insert(wait.conversation.as_str());
        total += until - from;
        // While the window was closed, the wait went to what kept it closed.
        let closed_until = r.opened.unwrap_or(now).min(until);
        if closed_until <= from {
            continue;
        }
        let mut points: Vec<Instant> = vec![from, closed_until];
        for span in r
            .blockers
            .iter()
            .filter(|s| !r.refused_calls.contains(&s.key))
        {
            for point in [Some(span.from), span.until].into_iter().flatten() {
                if point > from && point < closed_until {
                    points.push(point);
                }
            }
        }
        points.sort();
        points.dedup();
        for pair in points.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let active: Vec<&Span> = r
                .blockers
                .iter()
                .filter(|s| !r.refused_calls.contains(&s.key))
                .filter(|s| s.from <= a && s.until.unwrap_or(now) >= b)
                .collect();
            if active.is_empty() {
                continue;
            }
            let share = (b - a) / active.len() as u32;
            for span in active {
                match causes
                    .iter_mut()
                    .find(|(c, l, _)| *c == span.conversation && *l == span.label)
                {
                    Some(cause) => cause.2 += share,
                    None => causes.push((span.conversation.clone(), span.label.clone(), share)),
                }
            }
        }
    }
    causes.sort_by_key(|cause| std::cmp::Reverse(cause.2));
    Held {
        chats: chats.len(),
        total,
        causes,
    }
}

/// A call's label for text: its description, else the first line of its command.
fn label_of(tool: &ToolActivity) -> String {
    let command = tool
        .command()
        .and_then(|c| c.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(|line| format!("`{}`", shortened(line, 160)));
    match (tool.detail(), command) {
        (Some(detail), Some(command)) if !detail.trim().is_empty() => {
            format!("{} {command}", shortened(detail.trim(), 120))
        }
        (_, Some(command)) => command,
        (Some(detail), None) => shortened(detail.trim(), 160),
        (None, None) => tool.name.clone(),
    }
}

/// Text cut at a character boundary, for labels only.
fn shortened(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.into(),
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn ms(time: Duration) -> u64 {
    time.as_millis().min(u64::MAX as u128) as u64
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(ms)
        .unwrap_or_default()
}

/// A duration as the app writes one: tenths of a second under a minute, then whole seconds with
/// minutes and hours (4.6s, 28m 31s, 1h 7m 32s).
pub fn duration(time: Duration) -> String {
    let tenths = time.as_millis() / 100;
    if tenths < 600 {
        return format!("{}.{}s", tenths / 10, tenths % 10);
    }
    let seconds = time.as_secs();
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}h {minutes}m {seconds}s")
    } else {
        format!("{minutes}m {seconds}s")
    }
}

#[cfg(test)]
mod tests;
