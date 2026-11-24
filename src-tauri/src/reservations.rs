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
//!
//! Chats coordinate by themselves (`chat_message`): a message reaches a replying chat with its
//! next tool call. The chat holding the computer may ask a replying chat to hand over what it
//! holds, such as an editor it still works with: that chat's commands then run again while it
//! finishes, the window waits for it, and once it hands over (`pc_release`) Agent Studio closes
//! the programs it left running (`programs`) and holds its commands like the others'. Programs a
//! chat that no longer replies left running are stopped with `pc_stop`.
pub mod codex_gate;
pub mod jobs;
mod light;
pub mod machine;
pub mod programs;
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
/// Shows a record in a reply's Work history: the messages it read.
pub type Sink = Arc<dyn Fn(ToolActivity) + Send + Sync>;
/// Releases the CLI a chat keeps between replies, with the background work it runs. Returns
/// whether one was kept.
pub type Release =
    Box<dyn Fn(String) -> futures_util::future::BoxFuture<'static, bool> + Send + Sync>;

/// What keeps a window closed while a chat asked to hand over finishes.
const HANDING_OVER: &str = "handing over";
/// How an ask to hand over ended.
const HANDED_OVER: &str = "handed over";
const REPLY_ENDED: &str = "reply ended";

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
    /// A chat asked to hand over what it holds, rather than a command.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hand_over: bool,
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
    release: std::sync::OnceLock<Release>,
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
    /// Messages their chats have not read yet, oldest first.
    messages: Vec<Message>,
    /// The replies that read messages, by run id.
    readers: HashMap<String, Reader>,
    next: u64,
    ticking: bool,
}
/// A message to a chat, from another chat or from Agent Studio.
struct Message {
    from: Option<String>,
    to: String,
    text: String,
    /// The chat holding the computer asks the reader to hand over what it holds.
    hand_over: bool,
}
/// A reply that reads messages: where it shows them, and for Codex the thread of its own agent,
/// whose commands alone take them.
struct Reader {
    conversation: String,
    sink: Option<Sink>,
    thread: Option<String>,
}
/// A chat asked to hand over what it holds before a window opens.
struct Ask {
    conversation: String,
    asked: Instant,
    read: Option<Instant>,
    /// When and how it ended.
    ended: Option<(Instant, &'static str)>,
    /// What it left running is being closed.
    closing: bool,
    closed: Vec<programs::Stopped>,
}
/// Programs a chat stopped while a reservation held the computer.
struct Stopping {
    by: String,
    conversation: String,
    outcomes: Vec<programs::Stopped>,
    /// Its background work stopped with its CLI.
    background: bool,
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
    /// Chats it asked to hand over what they hold.
    asks: Vec<Ask>,
    /// Programs chats stopped while it held the computer.
    stopped: Vec<Stopping>,
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
#[derive(Clone)]
struct Item {
    key: String,
    conversation: String,
    label: String,
    light: bool,
    /// Its reply still runs, so it is work in progress rather than something left running.
    in_progress: bool,
    /// Background work its CLI keeps.
    background: bool,
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
            release: std::sync::OnceLock::new(),
            jobs: jobs::Jobs::default(),
        })
    }

    /// How `pc_stop` releases a chat's CLI with its background work.
    pub fn set_release(&self, release: Release) {
        let _ = self.release.set(release);
    }

    /// A reply of `conversation` reads its messages, shown with `sink` when it has one.
    pub fn attach(&self, run_id: &str, conversation: &str, sink: Option<Sink>) {
        self.lock().readers.insert(
            run_id.into(),
            Reader {
                conversation: conversation.into(),
                sink,
                thread: None,
            },
        );
    }

    pub fn detach(&self, run_id: &str) {
        self.lock().readers.remove(run_id);
    }

    /// The Codex thread a reply's own agent works in.
    pub fn thread(&self, run_id: &str, thread: &str) {
        if let Some(reader) = self.lock().readers.get_mut(run_id) {
            reader.thread = Some(thread.into());
        }
    }

    /// Whether `thread` is the one `conversation`'s own Codex agent works in, rather than a
    /// sub-agent's, which does not read its messages.
    pub fn main_thread(&self, conversation: &str, thread: &str) -> bool {
        self.lock()
            .readers
            .values()
            .any(|r| r.conversation == conversation && r.thread.as_deref() == Some(thread))
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
            let now = Instant::now();
            let ended = state.runs.remove(run_id).map(|run| run.conversation);
            state.readers.remove(run_id);
            let report = state
                .queue
                .iter()
                .position(|r| r.run_id == run_id)
                .map(|index| self.end(&mut state, index, now, "reply"));
            // Unless another reply of its chat took over, what the chat was asked ends with it.
            let asks_ended = match ended {
                Some(conversation)
                    if !state.runs.values().any(|r| r.conversation == conversation) =>
                {
                    self.reply_gone(&mut state, &conversation, now)
                }
                _ => false,
            };
            let changed = self.settled(&mut state, now);
            let snapshot = match (&report, changed) {
                (_, Some(snapshot)) => Some(snapshot),
                (Some(_), None) => Some(self.view(&state)),
                (None, None) if asks_ended => Some(self.view(&state)),
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

    /// `conversation` no longer replies: what it was asked to hand over ends, and the messages
    /// it did not read go back to their senders as a notice. Returns whether an ask ended.
    fn reply_gone(&self, state: &mut State, conversation: &str, now: Instant) -> bool {
        let mut ended = false;
        for reservation in state.queue.iter_mut() {
            for ask in reservation
                .asks
                .iter_mut()
                .filter(|a| a.conversation == conversation && a.ended.is_none() && !a.closing)
            {
                ask.ended = Some((now, REPLY_ENDED));
                ended = true;
            }
        }
        let (unread, rest): (Vec<Message>, Vec<Message>) = std::mem::take(&mut state.messages)
            .into_iter()
            .partition(|m| m.to == conversation);
        state.messages = rest;
        for message in unread {
            let Some(from) = message.from else { continue };
            if state.runs.values().any(|r| r.conversation == from) {
                state.messages.push(Message {
                    from: None,
                    to: from,
                    text: format!(
                        "Your message to {} was not read: its reply ended first. pc_status lists what it left running, which pc_stop stops.",
                        self.named(conversation)
                    ),
                    hand_over: false,
                });
            }
        }
        ended
    }

    /// Sends `text` from `from` to the chat `to` names, which reads it with its next tool call.
    /// With `hand_over`, the chat holding the computer asks that chat to hand over what it holds:
    /// its commands run again until it does, and the window waits for it.
    pub fn message(
        &self,
        from: &str,
        to: &str,
        text: &str,
        hand_over: bool,
    ) -> Result<String, String> {
        let to = self.resolve(to)?;
        if to == from {
            return Err("That is this chat.".into());
        }
        let snapshot = {
            let mut state = self.lock();
            if !state.runs.values().any(|r| r.conversation == to) {
                return Err(format!(
                    "{} is not replying now, so it cannot read messages. pc_status lists what it left running, which pc_stop stops.",
                    capitalized(&self.named(&to))
                ));
            }
            let now = Instant::now();
            if hand_over {
                let Some(first) = state.queue.first_mut().filter(|r| r.conversation == from) else {
                    return Err("Only the chat holding the computer, first in line, asks another to hand over: reserve it with pc_reserve, and ask once pc_status says this chat holds it.".into());
                };
                if !first
                    .asks
                    .iter()
                    .any(|a| a.conversation == to && a.ended.is_none())
                {
                    first.asks.push(Ask {
                        conversation: to.clone(),
                        asked: now,
                        read: None,
                        ended: None,
                        closing: false,
                        closed: vec![],
                    });
                }
                // An open window closes again until the chat hands over.
                if first.opened.take().is_some() {
                    first.opened_at = None;
                    first.measure = machine::Window::default();
                    first.others.clear();
                }
            }
            state.messages.push(Message {
                from: Some(from.into()),
                to: to.clone(),
                text: text.trim().into(),
                hand_over,
            });
            self.settled(&mut state, now);
            self.view(&state)
        };
        self.publish(snapshot);
        Ok(if hand_over {
            format!(
                "Sent: {} reads it with its next tool call, and its commands run again until it hands over. Your window stays closed until it hands over or its reply ends: call pc_wait.",
                self.named(&to)
            )
        } else {
            format!(
                "Sent: {} reads it with its next tool call.",
                self.named(&to)
            )
        })
    }

    /// Takes the messages waiting for `conversation`, as text for its agent, and shows each in its
    /// reply's Work history. None when none waits.
    pub fn deliver(&self, conversation: &str) -> Option<String> {
        let (text, sink, shown) = {
            let mut state = self.lock();
            if !state.messages.iter().any(|m| m.to == conversation) {
                return None;
            }
            let (mine, rest): (Vec<Message>, Vec<Message>) = std::mem::take(&mut state.messages)
                .into_iter()
                .partition(|m| m.to == conversation);
            state.messages = rest;
            let now = Instant::now();
            let mut texts = vec![];
            let mut shown = vec![];
            for message in &mine {
                state.next += 1;
                let from = message
                    .from
                    .as_deref()
                    .map(|from| self.named(from))
                    .unwrap_or_else(|| "Agent Studio".into());
                let ask = message.hand_over.then(|| {
                    state
                        .queue
                        .first_mut()
                        .filter(|r| Some(r.conversation.as_str()) == message.from.as_deref())
                });
                texts.push(match ask.flatten() {
                    Some(first) => {
                        if let Some(ask) = first
                            .asks
                            .iter_mut()
                            .find(|a| a.conversation == conversation && a.ended.is_none())
                        {
                            ask.read.get_or_insert(now);
                        }
                        format!(
                            "{}, another agent working on this computer (not the user), holds it for a performance measurement ({}) and asks you to hand over what you hold: {}\nUntil you hand over, your commands still run while that measurement waits for you. Finish what you need from what you already run, without starting new heavy work, and stop the background work you no longer need. Then hand over with pc_release (Claude: mcp__agent_studio__pc_release): Agent Studio closes the programs you left running, and your commands wait until the measurement ends. If that takes long, say so with chat_message.",
                            capitalized(&from),
                            first.purpose,
                            message.text
                        )
                    }
                    None if message.from.is_some() => format!(
                        "A message from {from}, another agent working on this computer (not the user): {}\nAnswer it with chat_message (Claude: mcp__agent_studio__chat_message) when it asks you something.",
                        message.text
                    ),
                    None => format!("Agent Studio: {}", message.text),
                });
                shown.push((
                    format!("studio-message:{conversation}:{}", state.next),
                    from,
                    message.text.clone(),
                    message.hand_over,
                ));
            }
            let sink = state
                .readers
                .values()
                .find(|r| r.conversation == conversation)
                .and_then(|r| r.sink.clone());
            (texts.join("\n\n"), sink, shown)
        };
        if let Some(sink) = sink {
            for (id, from, text, hand_over) in shown {
                sink(ToolActivity::received_message(&id, &from, &text, hand_over));
            }
        }
        // An ask read changes nothing the window shows, and a sender may wait on its reader.
        self.version.send_modify(|version| *version += 1);
        Some(text)
    }

    /// The chat `name` names: its title, its id or the start of its id, among the chats that
    /// work on this computer now or left something running here.
    fn resolve(&self, name: &str) -> Result<String, String> {
        let mut wanted = name.trim();
        // As pc_status names chats: the chat "Title" (id 1a2b3c4d).
        if let Some(start) = wanted.find("(id ") {
            let id = &wanted[start + 4..];
            wanted = id[..id.find(')').unwrap_or(id.len())].trim();
        }
        let wanted = wanted
            .trim_start_matches("the chat ")
            .trim_matches(|c| matches!(c, '"' | '\'' | '\u{201C}' | '\u{201D}'))
            .trim();
        let mut known: Vec<String> = {
            let state = self.lock();
            state
                .runs
                .values()
                .map(|r| r.conversation.clone())
                .chain(state.readers.values().map(|r| r.conversation.clone()))
                .chain(state.queue.iter().map(|r| r.conversation.clone()))
                .collect()
        };
        let members = self.jobs.members();
        known.extend(members.chats.into_values());
        known.extend(members.roots.into_values());
        known.extend((self.background)().into_iter().map(|w| w.conversation));
        known.sort();
        known.dedup();
        if known.iter().any(|c| c == wanted) {
            return Ok(wanted.into());
        }
        let by_id: Vec<&String> = known
            .iter()
            .filter(|c| wanted.len() >= 4 && c.starts_with(wanted))
            .collect();
        if let [one] = by_id.as_slice() {
            return Ok((*one).clone());
        }
        let by_title: Vec<&String> = known
            .iter()
            .filter(|c| (self.titles)(c).is_some_and(|t| t.trim().eq_ignore_ascii_case(wanted)))
            .collect();
        match by_title.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!(
                "No chat named \"{wanted}\" works on this computer now: pc_status lists them."
            )),
            several => Err(format!(
                "Several chats are named \"{wanted}\": {}. Name one by its id.",
                several
                    .iter()
                    .map(|c| self.named(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }

    /// Ends what `conversation` was asked to hand over: closes the programs it left running, and
    /// from then on holds its commands like the others'. None when nothing was asked of it.
    pub async fn hand_over(&self, conversation: &str) -> Option<Result<String, String>> {
        let (holder, purpose) = {
            let mut state = self.lock();
            let first = state.queue.first_mut()?;
            let (holder, purpose) = (first.conversation.clone(), first.purpose.clone());
            let ask = first
                .asks
                .iter_mut()
                .find(|a| a.conversation == conversation && a.ended.is_none())?;
            if ask.closing {
                return Some(Err(
                    "Agent Studio is already closing what this chat left running.".into(),
                ));
            }
            ask.closing = true;
            ask.read.get_or_insert(Instant::now());
            (holder, purpose)
        };
        let left = programs::now(self.jobs.members())
            .await
            .remove(conversation)
            .unwrap_or_default();
        let closed = programs::stop(left).await;
        let snapshot = {
            let mut state = self.lock();
            let now = Instant::now();
            if let Some(ask) = state
                .queue
                .first_mut()
                .filter(|r| r.conversation == holder)
                .and_then(|r| {
                    r.asks
                        .iter_mut()
                        .find(|a| a.conversation == conversation && a.ended.is_none())
                })
            {
                ask.ended = Some((now, HANDED_OVER));
                ask.closing = false;
                ask.closed = closed.clone();
            }
            self.settled(&mut state, now);
            self.view(&state)
        };
        self.publish(snapshot);
        let mut text = format!("Handed over to {} ({purpose}). ", self.named(&holder));
        if closed.is_empty() {
            text.push_str("This chat left no programs running.");
        } else {
            text.push_str(&format!(
                "What this chat left running: {}.",
                closed
                    .iter()
                    .map(programs::Stopped::text)
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        text.push_str(" From now on your commands wait until that measurement ends, except light ones: call pc_wait before running one.");
        Some(Ok(text))
    }

    /// Stops programs the chat `name` names left running (`programs`, as pc_status lists them),
    /// and with `background` the background work its CLI keeps, by releasing that CLI. Only a
    /// chat that is not replying, or the asking chat's own programs.
    pub async fn stop(
        &self,
        caller: &str,
        name: &str,
        pids: &[u32],
        background: bool,
    ) -> Result<String, String> {
        let conversation = self.resolve(name)?;
        let own = conversation == caller;
        let replying = self
            .lock()
            .runs
            .values()
            .any(|r| r.conversation == conversation);
        if replying && !own {
            return Err(format!(
                "{} is replying now: ask it to hand over what it holds with chat_message and hand_over: true.",
                capitalized(&self.named(&conversation))
            ));
        }
        if background && own {
            return Err("Stop this chat's own background work with its own tools.".into());
        }
        if pids.is_empty() && !background {
            return Err(
                "Name the programs to stop as pc_status lists them, background: true, or both."
                    .into(),
            );
        }
        let left = if pids.is_empty() {
            vec![]
        } else {
            programs::now(self.jobs.members())
                .await
                .remove(&conversation)
                .unwrap_or_default()
        };
        let mut chosen = vec![];
        for pid in pids {
            match left.iter().find(|p| p.pid == *pid) {
                Some(program) => chosen.push(program.clone()),
                None => {
                    return Err(format!(
                        "{} left no program {pid} running. {}",
                        capitalized(&self.named(&conversation)),
                        if left.is_empty() {
                            "It left none.".to_string()
                        } else {
                            format!(
                                "Its programs: {}.",
                                left.iter()
                                    .map(|p| format!("{} (program {})", p.name, p.pid))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )
                        }
                    ))
                }
            }
        }
        let outcomes = programs::stop(chosen).await;
        let has_background = background
            && (self.background)()
                .iter()
                .any(|w| w.conversation == conversation);
        let released = match self.release.get() {
            Some(release) if has_background => release(conversation.clone()).await,
            _ => false,
        };
        // The reservation holding the computer reports it.
        let snapshot = {
            let mut state = self.lock();
            match state.queue.first_mut() {
                Some(first) => {
                    first.stopped.push(Stopping {
                        by: caller.into(),
                        conversation: conversation.clone(),
                        outcomes: outcomes.clone(),
                        background: released,
                    });
                    self.settled(&mut state, Instant::now());
                    Some(self.view(&state))
                }
                None => None,
            }
        };
        if let Some(snapshot) = snapshot {
            self.publish(snapshot);
        }
        let mut lines = vec![];
        if !outcomes.is_empty() {
            lines.push(format!(
                "{}.",
                outcomes
                    .iter()
                    .map(programs::Stopped::text)
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        if background {
            lines.push(if released {
                "Its background work stopped with its CLI, which starts again with its next reply."
                    .into()
            } else {
                "It runs no background work.".into()
            });
        }
        Ok(lines.join(" "))
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
                    asks: vec![],
                    stopped: vec![],
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
        // What it asked others to hand over ends with it.
        let holder = reservation.conversation.as_str();
        state
            .messages
            .retain(|m| !(m.hand_over && m.from.as_deref() == Some(holder)));
        for ask in reservation
            .asks
            .iter()
            .filter(|a| a.ended.is_none() && a.read.is_some() && !a.closing)
        {
            state.messages.push(Message {
                from: None,
                to: ask.conversation.clone(),
                text: format!(
                    "{} no longer needs you to hand over: its measurement ended.",
                    capitalized(&self.named(holder))
                ),
                hand_over: false,
            });
        }
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
            // A chat asked to hand over finishes what it needs first.
            let asked = first
                .asks
                .iter()
                .any(|a| a.conversation == conversation && a.ended.is_none() && !a.closing);
            if first.conversation == conversation || asked || light::is_light(command) {
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
        enum Step {
            Opened(String),
            Done(String),
            Ended,
            Wait(bool),
        }
        loop {
            // A message ends the wait: the agent reads it, and waits again when it must.
            if let Some(messages) = self.deliver(conversation) {
                return Ok(format!("{messages}\n\n{}", self.wait_status(conversation)));
            }
            let step = {
                let mut state = self.lock();
                let asked = state
                    .queue
                    .first()
                    .filter(|first| first.conversation != conversation)
                    .filter(|first| {
                        first.asks.iter().any(|a| {
                            a.conversation == conversation && a.ended.is_none() && !a.closing
                        })
                    })
                    .map(|first| (first.conversation.clone(), first.purpose.clone()));
                if let Some((holder, purpose)) = asked {
                    Step::Done(format!(
                        "{} asked this chat to hand over what it holds for its measurement ({purpose}). Your commands run again until you do: finish what you need, then call pc_release.",
                        capitalized(&self.named(&holder))
                    ))
                } else if own {
                    match state
                        .queue
                        .iter()
                        .position(|r| r.conversation == conversation)
                    {
                        None => Step::Ended,
                        Some(0) if state.queue[0].opened.is_some() => {
                            Step::Opened(self.opened_text(&state.queue[0], began.elapsed()))
                        }
                        Some(_) => Step::Wait(false),
                    }
                } else {
                    let held = state
                        .queue
                        .first()
                        .is_some_and(|r| r.conversation != conversation);
                    if !held {
                        Step::Done(if guard.is_some() {
                            format!(
                                "The computer is free again after {}: run your command now.",
                                duration(began.elapsed())
                            )
                        } else {
                            "The computer is not reserved: run your command now.".into()
                        })
                    } else if guard.is_none() {
                        state.next += 1;
                        let id = state.next;
                        state.waits.push(Wait {
                            id,
                            conversation: conversation.into(),
                            from: Instant::now(),
                            until: None,
                        });
                        guard = Some(WaitGuard { broker: self, id });
                        Step::Wait(true)
                    } else {
                        Step::Wait(false)
                    }
                }
            };
            match step {
                Step::Opened(text) => {
                    let left = programs::now(self.jobs.members()).await;
                    return Ok(format!("{text}{}", self.left_text(conversation, &left)));
                }
                Step::Done(text) => {
                    drop(guard.take());
                    return Ok(text);
                }
                Step::Ended => {
                    return Err("This chat's reservation ended before its window opened.".into())
                }
                // The window shows how many chats wait.
                Step::Wait(true) => {
                    let snapshot = self.view(&self.lock());
                    (self.emit)(&snapshot);
                }
                Step::Wait(false) => {}
            }
            tokio::select! {
                changed = changes.changed() => if changed.is_err() { return Err("Agent Studio stopped following reservations.".into()) },
                _ = cancel.cancelled() => return Err("Stopped while waiting for the computer.".into()),
            }
        }
    }

    /// Where `conversation` stands after reading its messages in `pc_wait`.
    fn wait_status(&self, conversation: &str) -> &'static str {
        let state = self.lock();
        match state
            .queue
            .iter()
            .position(|r| r.conversation == conversation)
        {
            Some(0) if state.queue[0].opened.is_some() => {
                "Your window is open: measure now, then call pc_release."
            }
            Some(_) => "Your window has not opened yet: call pc_wait again to wait for it.",
            None => match state.queue.first() {
                None => "The computer is not reserved: run your command now.",
                Some(first)
                    if first
                        .asks
                        .iter()
                        .any(|a| a.conversation == conversation && a.ended.is_none()) =>
                {
                    "Your commands run again until you hand over with pc_release."
                }
                Some(_) => {
                    "The computer is still reserved: call pc_wait again before running a command."
                }
            },
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
                                hand_over: s.key.starts_with("ask:"),
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
            text.push_str("\nLeft running by other chats whose replies ended (the window does not wait for these; pc_stop stops them when they would disturb the measurement):");
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
        let mut text = {
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
                    capitalized(&self.named(&first.conversation)),
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
            if let Some(first) = state.queue.first() {
                if first
                    .asks
                    .iter()
                    .any(|a| a.conversation == conversation && a.ended.is_none())
                {
                    text.push_str(" It asked this chat to hand over what it holds: your commands run until you do, so finish what you need, then call pc_release.");
                }
                if first.conversation == conversation {
                    for ask in first.asks.iter().filter(|a| a.ended.is_none()) {
                        text.push_str(&format!(
                            "\nAsked {} to hand over: {}.",
                            self.named(&ask.conversation),
                            match (ask.closing, ask.read) {
                                (true, _) => "it handed over, and Agent Studio is closing what it left running",
                                (false, Some(_)) => "it read the request and has not handed over yet",
                                (false, None) => "it has not read the request yet",
                            }
                        ));
                    }
                }
            }
            for message in state
                .messages
                .iter()
                .filter(|m| m.from.as_deref() == Some(conversation))
            {
                text.push_str(&format!(
                    "\nYour message to {} is not read yet.",
                    self.named(&message.to)
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
                        self.named(&item.conversation),
                        item.label,
                        match (item.in_progress, item.light) {
                            (_, true) => " (light)",
                            (true, false) => "",
                            (false, false) => " (left running after its reply ended)",
                        }
                    ));
                }
            }
            text
        };
        if let Some(now) = now {
            text.push_str(&self.left_text(conversation, &now.left));
            text.push('\n');
            text.push_str(&now.text(|conversation| self.chat(conversation)));
        }
        text
    }

    /// A chat as tools name it: its title and the start of its id.
    fn named(&self, conversation: &str) -> String {
        let id: String = conversation.chars().take(8).collect();
        match (self.titles)(conversation).filter(|t| !t.trim().is_empty()) {
            Some(title) => format!("the chat \"{}\" (id {id})", title.trim()),
            None => format!("another chat (id {id})"),
        }
    }

    /// The programs chats left running, as text for `conversation`'s agent: what it may stop
    /// itself, and what it asks another chat to hand over. Empty when there are none.
    fn left_text(
        &self,
        conversation: &str,
        left: &HashMap<String, Vec<programs::Program>>,
    ) -> String {
        if left.values().all(Vec::is_empty) {
            return String::new();
        }
        let replying: HashSet<String> = self
            .lock()
            .runs
            .values()
            .map(|r| r.conversation.clone())
            .collect();
        let mut chats: Vec<(&String, &Vec<programs::Program>)> =
            left.iter().filter(|(_, list)| !list.is_empty()).collect();
        // This chat's first, then the largest.
        chats.sort_by_key(|(chat, list)| {
            (
                *chat != conversation,
                std::cmp::Reverse(list.iter().map(|p| p.memory).sum::<u64>()),
            )
        });
        let mut text = String::from(
            "\nPrograms chats left running, outside their CLIs (pc_stop takes each by its program number):",
        );
        for (chat, list) in chats {
            let whose = if chat == conversation {
                "this chat (stop what you no longer need before measuring)".to_string()
            } else if replying.contains(chat) {
                format!(
                    "{}, replying (to have them closed, ask it to hand over with chat_message and hand_over: true)",
                    self.named(chat)
                )
            } else {
                format!("{}, not replying (pc_stop stops them)", self.named(chat))
            };
            text.push_str(&format!(
                "\n- {whose}: {}",
                list.iter()
                    .map(|p| {
                        format!(
                            "{}{} (program {}{}), {}{}",
                            p.name,
                            if p.processes.len() > 1 {
                                format!(" ×{}", p.processes.len())
                            } else {
                                String::new()
                            },
                            p.pid,
                            if p.window { ", a window" } else { "" },
                            machine::bytes(p.memory),
                            p.cpu
                                .map(|cpu| format!(", {} CPU", machine::percent(cpu)))
                                .unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
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
        for ask in &r.asks {
            let after = |at: Instant| duration(at.saturating_duration_since(ask.asked));
            lines.push(format!(
                "Asked {} to hand over: {}.",
                self.chat(&ask.conversation),
                match (ask.read, ask.ended) {
                    (_, Some((at, HANDED_OVER))) => format!(
                        "it handed over {} after the request{}",
                        after(at),
                        if ask.closed.is_empty() {
                            String::new()
                        } else {
                            format!(
                                " ({})",
                                ask.closed
                                    .iter()
                                    .map(programs::Stopped::text)
                                    .collect::<Vec<_>>()
                                    .join("; ")
                            )
                        }
                    ),
                    (Some(read), Some((at, _))) => format!(
                        "it read the request after {}, and its reply ended {} after it, before it handed over",
                        after(read),
                        after(at)
                    ),
                    (None, Some((at, _))) => format!(
                        "its reply ended {} after the request, before it read it",
                        after(at)
                    ),
                    (Some(read), None) => format!(
                        "it read the request after {} and had not handed over when the reservation ended",
                        after(read)
                    ),
                    (None, None) => "it had not read the request when the reservation ended".into(),
                }
            ));
        }
        for stop in &r.stopped {
            let mut done: Vec<String> = stop.outcomes.iter().map(programs::Stopped::text).collect();
            if stop.background {
                done.push("its background work stopped with its CLI".into());
            }
            lines.push(format!(
                "{} stopped what {} left running: {}.",
                if stop.by == r.conversation {
                    "This chat".to_string()
                } else {
                    capitalized(&self.chat(&stop.by))
                },
                if stop.conversation == stop.by {
                    "it".to_string()
                } else {
                    self.chat(&stop.conversation)
                },
                if done.is_empty() {
                    "nothing".to_string()
                } else {
                    done.join("; ")
                }
            ));
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
                    if label == HANDING_OVER {
                        format!(
                            "{} while {} finished before handing over",
                            duration(*time),
                            self.chat(conversation)
                        )
                    } else {
                        format!(
                            "{} while {} ran {}",
                            duration(*time),
                            self.chat(conversation),
                            label
                        )
                    }
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
            "asks": r.asks.iter().map(|a| json!({
                "conversationId": a.conversation,
                "readMs": a.read.map(|t| ms(t.saturating_duration_since(a.asked))),
                "endedMs": a.ended.map(|(t, _)| ms(t.saturating_duration_since(a.asked))),
                "ended": a.ended.map(|(_, how)| how),
                "programs": a.closed.iter().map(|s| json!({"name": s.program.name, "outcome": s.key()})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "stopped": r.stopped.iter().map(|s| json!({
                "by": s.by,
                "conversationId": s.conversation,
                "background": s.background,
                "programs": s.outcomes.iter().map(|o| json!({"name": o.program.name, "outcome": o.key()})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
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
                background: false,
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
            background: true,
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
    // A chat that handed over leaves its background work as one whose reply ended does.
    let handed: HashSet<&str> = first
        .asks
        .iter()
        .filter(|a| a.ended.is_some_and(|(_, how)| how == HANDED_OVER))
        .map(|a| a.conversation.as_str())
        .collect();
    let mut work: Vec<Item> = items
        .iter()
        .filter(|i| i.conversation != first.conversation && !i.light)
        .map(|i| {
            let mut item = i.clone();
            item.in_progress &= !(item.background && handed.contains(item.conversation.as_str()));
            item
        })
        .collect();
    // A chat asked to hand over keeps the window closed until it does, or its reply ends.
    work.extend(
        first
            .asks
            .iter()
            .filter(|a| a.ended.is_none())
            .map(|a| Item {
                key: format!("ask:{}", a.conversation),
                conversation: a.conversation.clone(),
                label: HANDING_OVER.into(),
                light: false,
                in_progress: true,
                background: false,
            }),
    );
    let others: Vec<&Item> = work.iter().collect();
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
