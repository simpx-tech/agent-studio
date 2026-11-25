//! Reserving this computer for a performance measurement (docs/RESERVATIONS.md; requested
//! 2026-11-24, after chats threw benchmark results away because other chats started Unreal
//! sessions while they measured). Chats work side by side as before; only a measurement takes the
//! computer for itself, and it does so as a reservation rather than by waiting for quiet, which
//! never comes while several chats work.
//!
//! A chat reserves the computer (`pc_reserve`). First in line, it waits for a lull: its window
//! opens at the first moment no other chat runs busy work, a command, an MCP tool call or
//! background work a running reply of its own still waits on, while other chats work on. Work that
//! has kept less than a quarter of a core busy for ten seconds is idle and never keeps the window
//! closed (`machine::IDLE_CORE`, read from each chat job's CPU time, inside WSL by a reading
//! there), so a watcher between its polls or a server waiting for requests does not; the report
//! says whether such work woke while the window was open. Only once that has not come within a set
//! wait (`Settings::lull_minutes`, a few minutes; requested 2026-11-24, since holding everyone at
//! once cost other chats hours) does it hold their new work: from then on, and once its window
//! opens, no other chat starts a command other than a light one (`light`): Claude chats'
//! commands are refused before they start by a `PreToolUse` hook (`tools::gate`), which tells
//! them to call `pc_wait`, a tool that returns once the computer is free. The chat that reserved
//! waits for its window with `pc_wait` too. While the window is open the computer is measured
//! (`machine`), and releasing it (`pc_release`, or the end of the reply that reserved it) gives a
//! report: what kept the window closed and for how long, what else ran while it was open, what
//! the computer did, whether the measurement ran beside other heavy work and whose, and how long
//! the other chats waited and because of what. Each report is kept in app data
//! `reservations/history.jsonl`. Reservations take turns, first come first served, and nothing is
//! capped: a reservation, a wait and a queue last as long as their chats need.
//!
//! The same broker hands out build slots (`builds`): a chat's build waits at its gate while the
//! builds already running leave no room for it, and named reservations (`named`), such as a
//! repository's landing turn, which one chat at a time holds across its calls.
//!
//! Chats coordinate by themselves (`chat_message`): a message reaches a replying chat with its
//! next tool call. The chat holding the computer may ask a replying chat to hand over what it
//! holds, such as an editor it still works with: that chat's commands then run again while it
//! finishes, the window waits for it, and once it hands over (`pc_release`) Agent Studio closes
//! the programs it left running (`programs`) and holds its commands like the others'. Programs a
//! chat that no longer replies left running are stopped with `pc_stop`. A process such a program
//! starts while the window is open waits, frozen at birth, until the reservation ends (`hold`).
pub mod builds;
pub mod codex_gate;
mod hold;
pub mod jobs;
mod light;
pub mod machine;
pub mod named;
pub mod programs;
pub mod tools;

use crate::protocol::activity::ToolActivity;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// The event this computer's window follows reservations with.
pub const EVENT: &str = "studio-pc";
/// How often a reservation looks at the computer while it waits or is open, and builds waiting
/// for a slot look at what runs.
const TICK: Duration = Duration::from_secs(2);
/// How long a build slot a chat was given waits for its build to start.
const GRANT: Duration = Duration::from_secs(120);
/// How long other chats' work in progress must stay idle (`machine::IDLE_CORE`) before a window
/// stops waiting for it.
const IDLE_FOR: Duration = Duration::from_secs(10);
/// A reading of a chat's work older than this no longer tells whether it is idle.
const STALE: Duration = Duration::from_secs(15);
/// The file beside the history that keeps this computer's settings of reservations.
const SETTINGS: &str = "settings.json";

/// This computer's settings of reservations (app data `reservations/settings.json`, never
/// synced), which Settings → Reservations changes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// How long a reservation first in line waits for a lull, a moment when no other chat runs
    /// heavy work, before it holds other chats' new work. Zero holds it at once.
    pub lull_minutes: f64,
}
impl Default for Settings {
    fn default() -> Self {
        Self { lull_minutes: 3.0 }
    }
}
impl Settings {
    fn valid(self) -> Option<Self> {
        (self.lull_minutes.is_finite() && self.lull_minutes >= 0.0).then_some(self)
    }
    fn lull(self) -> Duration {
        Duration::from_secs_f64(self.lull_minutes * 60.0)
    }
}

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
    /// Named reservations, each name's holder before those waiting for it.
    pub turns: Vec<TurnView>,
    /// Chats whose builds wait for a slot, first come first served.
    pub slots: Vec<SlotView>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView {
    pub id: String,
    pub name: String,
    pub landing: bool,
    pub conversation_id: String,
    pub purpose: String,
    pub asked_at: u64,
    /// When this chat's turn came: it holds the name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub conversation_id: String,
    /// The build it asked to run.
    pub label: String,
    pub since: u64,
    /// A slot is free for it, until its build starts.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub granted: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: String,
    pub conversation_id: String,
    pub purpose: String,
    /// `queued` behind another; first in line, `lull` while it waits for a moment when no other
    /// chat runs heavy work, `draining` while it holds other chats' new work and theirs finishes,
    /// or `open`.
    pub phase: &'static str,
    pub asked_at: u64,
    /// While it waits for a lull: when it holds other chats' new work if none comes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holds_at: Option<u64>,
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
    settings: Mutex<Settings>,
    /// How it reads the computer: `machine::read`, or nothing in tests, which give their own.
    read: Mutex<fn() -> Option<machine::Reading>>,
    /// The broker itself, for the loop that looks at the computer.
    me: std::sync::Weak<Broker>,
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
    /// What chats stopped before they reserved, for the reservation each makes next.
    prepared: Vec<Stopping>,
    /// Named reservations in the order they were asked for: the first of each name holds it.
    turns: Vec<Turn>,
    /// Chats whose builds wait for a slot, first come first served.
    slots: Vec<SlotWait>,
    /// When the last build started, which the next one beside it gives time to grow.
    last_build: Option<Instant>,
    /// When each chat last released the computer, and in which reply.
    released: HashMap<String, (String, Instant)>,
    /// What readings found of each chat's work, which a window does not wait for while idle.
    idle: HashMap<String, Idle>,
    /// The last reading of the computer, with the chats' jobs then, from which the next measures
    /// each chat's work (`machine::work`).
    last: Option<(machine::Reading, jobs::Members)>,
    /// The chats whose CLIs run inside a WSL distribution, whose work a reading there tells.
    in_wsl: HashSet<String>,
    /// A reading inside WSL is under way (`programs::wsl_work`).
    reading_wsl: bool,
    next: u64,
    ticking: bool,
}
/// What readings found of a chat's work: on this computer (`machine::work`), and inside WSL for a
/// chat whose CLI runs there (`programs::wsl_work`), whose processes this computer sees only as
/// WSL's virtual machine.
#[derive(Default)]
struct Idle {
    here: Option<Streak>,
    wsl: Option<Streak>,
}
#[derive(Clone, Copy, Debug)]
struct Streak {
    /// Since when its readings found it idle; None while the last found it busy.
    since: Option<Instant>,
    /// When it was last read.
    read: Instant,
    /// When a reading last found it busy.
    busy: Option<Instant>,
}
impl Streak {
    /// After `previous`, a reading of the time between `from` and `now` that found the work busy or
    /// idle. A reading too old to tell starts afresh.
    fn heard(previous: Option<Streak>, busy: bool, from: Instant, now: Instant) -> Streak {
        let previous = previous.filter(|s| now.saturating_duration_since(s.read) <= STALE);
        Streak {
            since: (!busy).then(|| previous.and_then(|s| s.since).unwrap_or(from)),
            read: now,
            busy: if busy {
                Some(now)
            } else {
                previous.and_then(|s| s.busy)
            },
        }
    }
    /// Idle for `IDLE_FOR`, by a reading recent enough to tell.
    fn idle(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.read) <= STALE
            && self
                .since
                .is_some_and(|since| now.saturating_duration_since(since) >= IDLE_FOR)
    }
}
/// A chat's turn at a named reservation (`named`).
struct Turn {
    id: String,
    key: String,
    name: String,
    landing: bool,
    conversation: String,
    run_id: String,
    purpose: String,
    asked: Instant,
    asked_at: u64,
    granted: Option<Instant>,
    granted_at: Option<u64>,
}
/// A chat whose build waits for a slot (`builds`).
struct SlotWait {
    conversation: String,
    label: String,
    since: Instant,
    since_at: u64,
    /// When a slot was kept for it.
    granted: Option<Instant>,
}
/// A build running on the computer now.
struct Running {
    conversation: Option<String>,
    label: String,
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
/// What a chat asks to start while another may hold the computer.
#[derive(Clone, Copy)]
enum Asked {
    Command,
    /// A call of an MCP server's tool.
    Tool,
}
struct Call {
    label: String,
    light: bool,
    /// It builds (`builds::is_build`), and so takes a build slot while it runs.
    build: bool,
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
    /// When it began to hold other chats' new work: its lull wait ran out, or its window opened.
    holding: Option<Instant>,
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
    /// Processes other chats' programs started while its window was open, held until it ends.
    frozen: Vec<Frozen>,
    measure: machine::Window,
}
/// A process another chat's program started while a window was open (`hold`).
struct Frozen {
    conversation: String,
    name: String,
    /// Suspended until the reservation ends, or until its program is stopped.
    held: Option<hold::Held>,
}
#[derive(Clone, Debug)]
struct Span {
    key: String,
    conversation: String,
    label: String,
    /// Background work its CLI keeps, rather than a call a reply runs.
    background: bool,
    /// Its chat's work was idle as it began: work the window opened beside.
    idle: bool,
    /// A reading found its chat's work busy after it began idle.
    woke: bool,
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
    /// Its chat's work has stayed idle (`Idle`), so a window does not wait for it.
    idle: bool,
}

impl Broker {
    pub fn new(
        emit: Emit,
        titles: Titles,
        background: Background,
        history: Option<PathBuf>,
    ) -> Arc<Self> {
        // Processes a run that ended without resuming them held wait no longer.
        if let Some(history) = &history {
            hold::resume_saved(&history.with_file_name(FROZEN));
        }
        let settings = history
            .as_ref()
            .and_then(|history| std::fs::read(history.with_file_name(SETTINGS)).ok())
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .and_then(Settings::valid)
            .unwrap_or_default();
        let broker = Arc::new_cyclic(|me| Self {
            state: Mutex::new(State::default()),
            version: watch::channel(0).0,
            emit,
            titles,
            background,
            history,
            release: std::sync::OnceLock::new(),
            settings: Mutex::new(settings),
            read: Mutex::new(if cfg!(test) { || None } else { machine::read }),
            me: me.clone(),
            jobs: jobs::Jobs::default(),
        });
        let weak = Arc::downgrade(&broker);
        broker.jobs.watch(move |key, pid| {
            if let Some(broker) = weak.upgrade() {
                broker.born(key, pid);
            }
        });
        broker
    }

    /// A process began in a chat's job. While another chat's window is open it waits, frozen,
    /// until that reservation ends (`hold`), unless it is plumbing or its chat's CLI's own:
    /// anything a replying chat's CLI started, which its gate looks after, or what the CLI of a
    /// chat that no longer replies started itself since the window opened, such as an MCP server
    /// it connects again. What a program or background work begun before then starts waits. A
    /// chat asked to hand over works on.
    fn born(&self, key: usize, pid: u32) {
        let Some((conversation, cli)) = self.jobs.job(key) else {
            return;
        };
        if pid == cli {
            return;
        }
        let (replying, opened_at) = {
            let state = self.lock();
            let Some(first) = state.queue.first() else {
                return;
            };
            if first.opened.is_none()
                || first.conversation == conversation
                || first
                    .asks
                    .iter()
                    .any(|a| a.conversation == conversation && a.ended.is_none())
            {
                return;
            }
            (
                state.runs.values().any(|r| r.conversation == conversation),
                first.opened_at.unwrap_or_default(),
            )
        };
        // At once, before it does much; let go below when it may run.
        let Some(held) = hold::suspend(pid) else {
            return;
        };
        let parents = hold::ancestry(pid);
        let own = match parents.iter().position(|(parent, _)| *parent == cli) {
            None => false,
            Some(_) if replying => true,
            Some(0) => true,
            // The process the CLI started on the way to this one.
            Some(at) => hold::epoch_ms(parents[at - 1].1) >= opened_at,
        };
        if own || hold::plumbing(&held.name) {
            return;
        }
        let mut state = self.lock();
        // The window may have closed meanwhile: then it runs.
        if let Some(first) = state
            .queue
            .first_mut()
            .filter(|r| r.opened.is_some() && r.conversation != conversation)
        {
            first.frozen.push(Frozen {
                conversation,
                name: held.name.clone(),
                held: Some(held),
            });
            self.save_frozen(&state);
        }
    }

    /// Keeps which processes wait (`hold::save`).
    fn save_frozen(&self, state: &State) {
        let Some(history) = &self.history else {
            return;
        };
        let held: Vec<(u32, u64)> = state
            .queue
            .iter()
            .flat_map(|r| r.frozen.iter())
            .filter_map(|f| f.held.as_ref().map(|h| (h.pid, h.began)))
            .collect();
        hold::save(&history.with_file_name(FROZEN), &held);
    }

    /// Lets the processes held among `processes` run again, so that their programs can be
    /// stopped.
    fn thaw(&self, processes: &[(u32, u64)]) {
        let mut state = self.lock();
        let mut thawed = false;
        for frozen in state.queue.iter_mut().flat_map(|r| r.frozen.iter_mut()) {
            if frozen
                .held
                .as_ref()
                .is_some_and(|h| processes.contains(&(h.pid, h.began)))
            {
                frozen.held.take();
                thawed = true;
            }
        }
        if thawed {
            self.save_frozen(&state);
        }
    }

    /// Lets every process held run again: the app quits.
    pub fn thaw_all(&self) {
        let mut state = self.lock();
        for frozen in state.queue.iter_mut().flat_map(|r| r.frozen.iter_mut()) {
            frozen.held.take();
        }
        self.save_frozen(&state);
    }

    /// How `pc_stop` releases a chat's CLI with its background work.
    pub fn set_release(&self, release: Release) {
        let _ = self.release.set(release);
    }

    /// A reading of the computer.
    fn read(&self) -> Option<machine::Reading> {
        (*self.read.lock().unwrap_or_else(|e| e.into_inner()))()
    }

    /// Reads the computer with `read`, as a test gives it.
    #[cfg(test)]
    pub fn read_with(&self, read: fn() -> Option<machine::Reading>) {
        *self.read.lock().unwrap_or_else(|e| e.into_inner()) = read;
    }

    /// This computer's settings of reservations.
    pub fn settings(&self) -> Settings {
        *self.settings.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Changes this computer's settings, which apply at once: a reservation waiting for a lull
    /// may hold other chats' work from now on, or wait longer.
    pub fn set_settings(&self, settings: Settings) -> Result<Settings, String> {
        let settings = settings
            .valid()
            .ok_or("The wait for a lull is a number of minutes, zero or more.")?;
        if let Some(history) = &self.history {
            let path = history.with_file_name(SETTINGS);
            let folder = path
                .parent()
                .ok_or("Cannot save the reservations setting")?;
            std::fs::create_dir_all(folder).map_err(|_| "Cannot save the reservations setting")?;
            let mut file = tempfile::NamedTempFile::new_in(folder)
                .map_err(|_| "Cannot save the reservations setting")?;
            use std::io::Write;
            file.write_all(&serde_json::to_vec(&settings).unwrap_or_default())
                .and_then(|_| file.as_file().sync_all())
                .map_err(|_| "Cannot save the reservations setting")?;
            file.persist(path)
                .map_err(|_| "Cannot finish saving the reservations setting")?;
        }
        *self.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings;
        let snapshot = {
            let mut state = self.lock();
            self.settled(&mut state, Instant::now());
            self.view(&state)
        };
        self.publish(snapshot);
        Ok(settings)
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

    /// A call a running reply reported. Commands, monitors and calls of MCP servers' tools count
    /// while they run.
    pub fn tool(&self, run_id: &str, tool: &ToolActivity) {
        if !(tool.runs_command() || tool.is_monitor() || tool.connected().is_some()) {
            return;
        }
        let mut regrant = false;
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
                // As its agent wrote it: a CLI hook may put a line of its own before it.
                let command = light::own(tool.command().unwrap_or_default());
                let read = (command.len(), tool.detail().map_or(0, str::len));
                if run
                    .calls
                    .get(&tool.id)
                    .is_some_and(|call| call.read == read)
                {
                    return;
                }
                let light = match tool.connected() {
                    Some((server, _)) => light::remote_server(server),
                    None => !command.is_empty() && light::is_light(&command),
                };
                let build = !light && builds::is_build(&command);
                run.calls.insert(
                    tool.id.clone(),
                    Call {
                        label: label_of(tool),
                        light,
                        build,
                        read,
                    },
                );
            } else {
                match run.calls.remove(&tool.id) {
                    None => return,
                    Some(call) => regrant = call.build,
                }
            }
            regrant &= !state.slots.is_empty();
            self.settled(&mut state, Instant::now())
        };
        if let Some(snapshot) = update {
            self.publish(snapshot);
        }
        // A build that ended leaves its slot to the next in line.
        if regrant {
            self.regrant();
        }
    }

    /// Looks at the builds running now and keeps slots for those waiting that fit.
    fn regrant(&self) {
        let Some(broker) = self.me.upgrade() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            let read = *broker.read.lock().unwrap_or_else(|e| e.into_inner());
            let reading = tauri::async_runtime::spawn_blocking(read)
                .await
                .ok()
                .flatten();
            let members = reading.as_ref().map(|_| broker.jobs.members());
            let owners = reading
                .as_ref()
                .zip(members.as_ref())
                .map(|(r, m)| machine::Owners::new(r, m, std::process::id()));
            let snapshot = {
                let mut state = broker.lock();
                broker
                    .grant(
                        &mut state,
                        reading.as_ref(),
                        owners.as_ref(),
                        Instant::now(),
                    )
                    .then(|| broker.view(&state))
            };
            if let Some(snapshot) = snapshot {
                broker.publish(snapshot);
            }
        });
    }

    /// Keeps slots for the builds waiting that fit beside the builds running now, as `reading`
    /// shows them with their `owners`. Returns whether anything changed.
    fn grant(
        &self,
        state: &mut State,
        reading: Option<&machine::Reading>,
        owners: Option<&machine::Owners>,
        now: Instant,
    ) -> bool {
        if state.slots.is_empty() {
            return false;
        }
        let running = running_builds(state, reading.zip(owners), None);
        let free = reading.map(machine::Reading::free);
        let cores = reading.map_or_else(cores, |r| r.cores);
        Self::grant_slots(state, running.len(), free, cores, now)
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
            // The names it held or waited for go with the reply that took them.
            let turns = self.end_turns(&mut state, |t| t.run_id == run_id, now, "reply");
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
                (None, None) if asks_ended || !turns.is_empty() => Some(self.view(&state)),
                (None, None) => None,
            };
            (
                report.into_iter().chain(turns).collect::<Vec<_>>(),
                snapshot,
            )
        };
        for report in &report {
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
        // What it stopped without reserving afterwards reports nowhere.
        state.prepared.retain(|s| s.by != conversation);
        // A build it waited a slot for will not start.
        let waiting = state.slots.len();
        state.slots.retain(|w| w.conversation != conversation);
        ended |= state.slots.len() != waiting;
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
                            "{}, another agent working on this computer (not the user), holds it for a performance measurement ({}) and asks you to hand over what you hold: {}\nUntil you hand over, your commands and MCP tool calls still run while that measurement waits for you. Finish what you need from what you already run, without starting new heavy work, and stop the background work you no longer need. Then hand over with pc_release (Claude: mcp__agent_studio__pc_release): Agent Studio closes the programs you left running, and your commands and MCP tool calls wait until the measurement ends. If that takes long, say so with chat_message.",
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
        let left = self
            .left_running()
            .await
            .remove(conversation)
            .unwrap_or_default();
        self.thaw(
            &left
                .iter()
                .flat_map(|p| p.processes.clone())
                .collect::<Vec<_>>(),
        );
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
        let mut text = format!(
            "Handed over to {} for its measurement ({purpose}). ",
            self.named(&holder)
        );
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
        text.push_str(" From now on your commands and MCP tool calls wait until that measurement ends, except light commands: call pc_wait before running one.");
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
            self.left_running()
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
        // A program closes, or ends, with its processes running.
        self.thaw(
            &chosen
                .iter()
                .flat_map(|p| p.processes.clone())
                .collect::<Vec<_>>(),
        );
        let outcomes = programs::stop(chosen).await;
        let has_background = background
            && (self.background)()
                .iter()
                .any(|w| w.conversation == conversation);
        let released = match self.release.get() {
            Some(release) if has_background => release(conversation.clone()).await,
            _ => false,
        };
        // The caller's reservation reports it: the one it holds, or the one it makes next, since
        // a chat clears the computer before it reserves as often as after.
        let stopping = Stopping {
            by: caller.into(),
            conversation: conversation.clone(),
            outcomes: outcomes.clone(),
            background: released,
        };
        let snapshot = {
            let mut state = self.lock();
            match state.queue.iter_mut().find(|r| r.conversation == caller) {
                Some(reservation) => {
                    reservation.stopped.push(stopping);
                    self.settled(&mut state, Instant::now());
                    Some(self.view(&state))
                }
                None => {
                    state.prepared.push(stopping);
                    None
                }
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
        let items = items(state, &(self.background)(), now);
        settle(state, &items, now, self.settings().lull()).then(|| self.view(state))
    }

    /// Starts looking at the computer every `TICK` while a reservation or a build slot needs it.
    fn look(&self) {
        let Some(broker) = self.me.upgrade() else {
            return;
        };
        if std::mem::replace(&mut self.lock().ticking, true) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(TICK).await;
                if !broker.tick().await {
                    break;
                }
            }
        });
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
        let (text, snapshot) = {
            let mut state = self.lock();
            let now = Instant::now();
            // The same reply reserving again soon after it released: one series, two waits.
            let again = state
                .released
                .get(conversation)
                .filter(|(run, at)| {
                    run == run_id && now.saturating_duration_since(*at) < Duration::from_secs(600)
                })
                .map(|(_, at)| now.saturating_duration_since(*at));
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
                // What it stopped while it prepared belongs to this reservation.
                let (prepared, rest): (Vec<Stopping>, Vec<Stopping>) =
                    std::mem::take(&mut state.prepared)
                        .into_iter()
                        .partition(|s| s.by == conversation);
                state.prepared = rest;
                state.queue.push(Reservation {
                    id,
                    conversation: conversation.into(),
                    run_id: run_id.into(),
                    purpose: purpose.trim().into(),
                    minutes,
                    asked: now,
                    asked_at: epoch_ms(),
                    first: None,
                    holding: None,
                    opened: None,
                    opened_at: None,
                    blockers: vec![],
                    others: vec![],
                    refused: 0,
                    refused_calls: HashSet::new(),
                    asks: vec![],
                    stopped: prepared,
                    frozen: vec![],
                    measure: machine::Window::default(),
                });
            }
            let items = items(&state, &(self.background)(), now);
            settle(&mut state, &items, now, self.settings().lull());
            let mut text = self.standing(&state, conversation, &items);
            if let Some(since) = again {
                text.push_str(&format!(
                    "\nThis reply released the computer {} ago: keep one reservation for a whole series of measured runs, and release it after the last, so the wait for other chats' work is paid once.",
                    duration(since)
                ));
            }
            (text, self.view(&state))
        };
        self.publish(snapshot);
        self.look();
        text
    }

    /// Looks at the computer: tells which of other chats' work is idle while a window waits,
    /// settles the first reservation and measures an open window. Returns whether any
    /// reservation is left to look after.
    async fn tick(self: &Arc<Self>) -> bool {
        let done = |state: &State| state.queue.is_empty() && state.slots.is_empty();
        let (measuring, waiting, slots) = {
            let mut state = self.lock();
            if done(&state) {
                state.ticking = false;
                state.last = None;
                return false;
            }
            let first = state.queue.first();
            (
                first.is_some_and(|r| r.opened.is_some()),
                first.is_some_and(|r| r.opened.is_none()),
                !state.slots.is_empty(),
            )
        };
        let reading = if measuring || waiting || slots {
            let read = *self.read.lock().unwrap_or_else(|e| e.into_inner());
            tauri::async_runtime::spawn_blocking(read)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let members = reading.as_ref().map(|_| self.jobs.members());
        let launches = reading.as_ref().map(|_| self.jobs.wsl());
        let (update, inside) = {
            let mut state = self.lock();
            if done(&state) {
                state.ticking = false;
                state.last = None;
                return false;
            }
            let now = Instant::now();
            let replying: HashSet<String> = state
                .runs
                .values()
                .map(|r| r.conversation.clone())
                .collect();
            state
                .idle
                .retain(|conversation, _| replying.contains(conversation));
            if let Some(launches) = &launches {
                state.in_wsl = launches.iter().map(|j| j.conversation.clone()).collect();
            }
            // How busy each chat's work was since the last reading, unless that is too long ago
            // to tell of now.
            if let (Some(reading), Some(members)) = (&reading, &members) {
                if let Some((before, then)) = state
                    .last
                    .take()
                    .filter(|(before, _)| reading.at.saturating_duration_since(before.at) <= STALE)
                {
                    let work = machine::work((&before, &then), (reading, members));
                    heard_work(&mut state, false, replying, &work, before.at, reading.at);
                }
                state.last = Some((reading.clone(), members.clone()));
            }
            let owners = reading
                .as_ref()
                .zip(members.as_ref())
                .map(|(r, m)| machine::Owners::new(r, m, std::process::id()));
            // Builds waiting for a slot, beside what builds now.
            let changed = self.grant(&mut state, reading.as_ref(), owners.as_ref(), now);
            if let (Some(reading), Some(owners), Some(launches)) = (reading, owners, &launches) {
                if let Some(first) = state.queue.first_mut().filter(|r| r.opened.is_some()) {
                    let holder = first.conversation.clone();
                    let inside_wsl = launches.iter().any(|j| j.conversation == holder);
                    first.measure.add(reading, &owners, &holder, inside_wsl);
                }
            }
            // Inside WSL, one reading at a time, of the chats there whose work in progress the
            // window waits for.
            let inside: Vec<jobs::WslJob> = match (&launches, state.queue.first()) {
                (Some(launches), Some(first)) if waiting && !state.reading_wsl => {
                    let items = items(&state, &(self.background)(), now);
                    let wanted: HashSet<&str> = items
                        .iter()
                        .filter(|i| {
                            i.in_progress && !i.light && i.conversation != first.conversation
                        })
                        .map(|i| i.conversation.as_str())
                        .collect();
                    launches
                        .iter()
                        .filter(|j| wanted.contains(j.conversation.as_str()))
                        .cloned()
                        .collect()
                }
                _ => vec![],
            };
            state.reading_wsl |= !inside.is_empty();
            let update = match self.settled(&mut state, now) {
                Some(snapshot) => Some(snapshot),
                None if changed => Some(self.view(&state)),
                None => None,
            };
            (update, inside)
        };
        if let Some(snapshot) = update {
            self.publish(snapshot);
        }
        if !inside.is_empty() {
            self.read_wsl(inside);
        }
        true
    }

    /// Reads inside WSL how busy the work of `launches`' chats is (`programs::wsl_work`), then
    /// settles the first reservation with it.
    fn read_wsl(self: &Arc<Self>, launches: Vec<jobs::WslJob>) {
        let broker = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let from = Instant::now();
            let read: HashSet<String> = launches.iter().map(|j| j.conversation.clone()).collect();
            let work = programs::wsl_work(launches).await;
            let update = {
                let mut state = broker.lock();
                state.reading_wsl = false;
                let now = Instant::now();
                heard_work(&mut state, true, read, &work, from, now);
                broker.settled(&mut state, now)
            };
            if let Some(snapshot) = update {
                broker.publish(snapshot);
            }
        });
    }

    /// Ends `conversation`'s reservation and reports on it.
    pub fn release(&self, conversation: &str) -> Option<Report> {
        let (report, snapshot) = {
            let mut state = self.lock();
            let index = state
                .queue
                .iter()
                .position(|r| r.conversation == conversation)?;
            let run_id = state.queue[index].run_id.clone();
            let report = self.end(&mut state, index, Instant::now(), "release");
            state
                .released
                .insert(conversation.into(), (run_id, Instant::now()));
            self.settled(&mut state, Instant::now());
            (report, self.view(&state))
        };
        self.keep(&report);
        self.publish(snapshot);
        Some(report)
    }

    /// Takes a turn at the named reservation `key` (`named`) for `conversation`'s reply
    /// `run_id`, or brings up to date the turn it has. The answer says where it stands.
    pub fn take_turn(
        &self,
        run_id: &str,
        conversation: &str,
        key: &str,
        name: &str,
        landing: bool,
        purpose: &str,
    ) -> String {
        let (text, snapshot) = {
            let mut state = self.lock();
            let now = Instant::now();
            match state
                .turns
                .iter_mut()
                .find(|t| t.conversation == conversation && t.key == key)
            {
                Some(turn) => {
                    turn.purpose = purpose.trim().into();
                    turn.run_id = run_id.into();
                }
                None => {
                    state.next += 1;
                    let id = format!("turn-{}", state.next);
                    state.turns.push(Turn {
                        id,
                        key: key.into(),
                        name: name.trim().into(),
                        landing,
                        conversation: conversation.into(),
                        run_id: run_id.into(),
                        purpose: purpose.trim().into(),
                        asked: now,
                        asked_at: epoch_ms(),
                        granted: None,
                        granted_at: None,
                    });
                }
            }
            grant_turns(&mut state.turns, now);
            (
                self.turn_standing(&state, conversation, key),
                self.view(&state),
            )
        };
        self.publish(snapshot);
        text
    }

    /// Where `conversation`'s turn at `key` stands.
    fn turn_standing(&self, state: &State, conversation: &str, key: &str) -> String {
        let Some(mine) = state
            .turns
            .iter()
            .find(|t| t.conversation == conversation && t.key == key)
        else {
            return "This chat has no turn at that name.".into();
        };
        let release = release_hint(mine);
        if mine.granted.is_some() {
            return format!(
                "This chat holds {} now: another chat that asks for it waits until you release it with pc_release ({release}), or until this reply ends. Release it as soon as you are done with it.",
                mine.name
            );
        }
        let same: Vec<&Turn> = state.turns.iter().filter(|t| t.key == key).collect();
        let holder = same[0];
        let before = same
            .iter()
            .position(|t| t.conversation == conversation)
            .unwrap_or_default()
            .saturating_sub(1);
        format!(
            "Asked for {}: {} holds it ({}) since {} ago{}. Call pc_wait: it returns once your turn comes. Meanwhile keep working on what does not need it.",
            mine.name,
            self.named(&holder.conversation),
            holder.purpose,
            duration(holder.granted.map_or(Duration::ZERO, |at| at.elapsed())),
            if before > 0 {
                format!(", and {} before you", plural(before, "chat waits", "chats wait"))
            } else {
                String::new()
            }
        )
    }

    /// Ends `conversation`'s turns at `key`, or at every name when `key` is None, and reports
    /// on each: the text for its agent, or None when it held none.
    pub fn release_turns(&self, conversation: &str, key: Option<&str>) -> Option<String> {
        let (reports, snapshot) = {
            let mut state = self.lock();
            let reports = self.end_turns(
                &mut state,
                |t| t.conversation == conversation && key.is_none_or(|key| t.key == key),
                Instant::now(),
                "release",
            );
            if reports.is_empty() {
                return None;
            }
            (reports, self.view(&state))
        };
        for report in &reports {
            self.keep(report);
        }
        self.publish(snapshot);
        Some(
            reports
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    /// Takes the turns `ended` picks out of line, gives their names to the next in line, and
    /// reports on each.
    fn end_turns(
        &self,
        state: &mut State,
        ended: impl Fn(&Turn) -> bool,
        now: Instant,
        by: &str,
    ) -> Vec<Report> {
        let (gone, kept): (Vec<Turn>, Vec<Turn>) = std::mem::take(&mut state.turns)
            .into_iter()
            .partition(ended);
        state.turns = kept;
        grant_turns(&mut state.turns, now);
        gone.iter()
            .map(|turn| {
                let next = state
                    .turns
                    .iter()
                    .find(|t| t.key == turn.key && t.granted.is_some());
                let waiting = state
                    .turns
                    .iter()
                    .filter(|t| t.key == turn.key && t.granted.is_none())
                    .count();
                let waited = turn
                    .granted
                    .unwrap_or(now)
                    .saturating_duration_since(turn.asked);
                let held = turn.granted.map(|at| now.saturating_duration_since(at));
                let text = match held {
                    Some(held) => format!(
                        "Released {} ({}){}: this chat held it {}{}. {}",
                        turn.name,
                        turn.purpose,
                        if by == "reply" {
                            " when the reply that took it ended"
                        } else {
                            ""
                        },
                        duration(held),
                        if waited >= Duration::from_secs(1) {
                            format!(", after waiting {} for its turn", duration(waited))
                        } else {
                            String::new()
                        },
                        match (next, waiting) {
                            (None, _) => "Nobody waits for it.".to_string(),
                            (Some(next), 0) => format!(
                                "{} has it now.",
                                capitalized(&self.named(&next.conversation))
                            ),
                            (Some(next), _) => format!(
                                "{} has it now, and {} after it.",
                                capitalized(&self.named(&next.conversation)),
                                plural(waiting, "chat waits", "chats wait")
                            ),
                        }
                    ),
                    None => format!(
                        "Left the line for {} ({}) after {}, before its turn came.",
                        turn.name,
                        turn.purpose,
                        duration(waited)
                    ),
                };
                Report {
                    text,
                    record: json!({
                        "kind": "turn",
                        "id": turn.id,
                        "conversationId": turn.conversation,
                        "name": turn.name,
                        "landing": turn.landing,
                        "purpose": turn.purpose,
                        "askedAt": turn.asked_at,
                        "grantedAt": turn.granted_at,
                        "endedAt": epoch_ms(),
                        "endedBy": by,
                        "waitedMs": ms(waited),
                        "heldMs": held.map(ms),
                        "waiting": waiting + usize::from(next.is_some()),
                    }),
                }
            })
            .collect()
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
        // What waited for its window runs again.
        drop(std::mem::take(&mut reservation.frozen));
        self.save_frozen(state);
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
        let own = light::own(command);
        let light = light::is_light(&own);
        if let Some(reason) = self.hold(conversation, light, Asked::Command, call, wait) {
            return Some(reason);
        }
        if light || !builds::is_build(&own) {
            return None;
        }
        self.slot(conversation, &own, call, wait)
    }

    /// Whether a build `conversation` wants to start waits for a slot (`builds`): the reason to
    /// give, or None. A slot kept for the chat is its build's; otherwise builds take their turns
    /// first come first served, and one starts while the builds running leave room for it.
    fn slot(
        &self,
        conversation: &str,
        command: &str,
        call: Option<&str>,
        wait: &str,
    ) -> Option<String> {
        {
            let mut state = self.lock();
            if let Some(index) = state
                .slots
                .iter()
                .position(|w| w.conversation == conversation && w.granted.is_some())
            {
                state.slots.remove(index);
                state.last_build = Some(Instant::now());
                let snapshot = self.view(&state);
                drop(state);
                self.publish(snapshot);
                return None;
            }
        }
        let reading = self.read();
        let members = reading.as_ref().map(|_| self.jobs.members());
        let owners = reading
            .as_ref()
            .zip(members.as_ref())
            .map(|(r, m)| machine::Owners::new(r, m, std::process::id()));
        let (reason, snapshot) = {
            let mut state = self.lock();
            let now = Instant::now();
            let running = running_builds(&state, reading.as_ref().zip(owners.as_ref()), call);
            let granted = state.slots.iter().filter(|w| w.granted.is_some()).count();
            let ahead = state
                .slots
                .iter()
                .take_while(|w| w.conversation != conversation)
                .count();
            let cores = reading.as_ref().map_or_else(cores, |r| r.cores);
            let free = reading.as_ref().map(machine::Reading::free);
            let since = state.last_build.map(|at| now.saturating_duration_since(at));
            let taken = running.len() + granted;
            if ahead == 0 && builds::admits(taken, free, cores, since) {
                let waited = state.slots.len();
                state.slots.retain(|w| w.conversation != conversation);
                state.last_build = Some(now);
                let snapshot = (state.slots.len() != waited).then(|| self.view(&state));
                drop(state);
                if let Some(snapshot) = snapshot {
                    self.publish(snapshot);
                }
                return None;
            }
            // It never ran, though Claude Code reported it as started.
            if let Some(call) = call {
                state.refused.insert(call.into());
                for run in state.runs.values_mut() {
                    run.calls.remove(call);
                }
            }
            if !state.slots.iter().any(|w| w.conversation == conversation) {
                state.slots.push(SlotWait {
                    conversation: conversation.into(),
                    label: command_label(command),
                    since: now,
                    since_at: epoch_ms(),
                    granted: None,
                });
            }
            let why = if ahead > 0 {
                format!(
                    "{} {} before it",
                    plural(ahead, "chat's build waits", "chats' builds wait"),
                    if ahead == 1 {
                        "its turn"
                    } else {
                        "their turns"
                    }
                )
            } else if taken >= builds::slots(cores) {
                format!(
                    "this computer runs {} at once (one for each eight cores)",
                    plural(builds::slots(cores), "build", "builds")
                )
            } else if free.is_some_and(|free| free < builds::BESIDE_FREE) {
                format!(
                    "a build beside them needs {} of free memory (commit) and {} is free",
                    machine::bytes(builds::BESIDE_FREE),
                    machine::bytes(free.unwrap_or_default())
                )
            } else {
                format!(
                    "the last build started {} ago and is still taking its memory",
                    duration(since.unwrap_or_default())
                )
            };
            let list = running
                .iter()
                .map(|build| match &build.conversation {
                    Some(chat) => format!("{}: {}", self.chat(chat), build.label),
                    None => build.label.clone(),
                })
                .collect::<Vec<_>>();
            (
                format!(
                    "This build did not run: {} on this computer now{}, and {why}. Call {wait}, which returns once a build slot is free for this chat, then run the same command again. Meanwhile keep working on what does not need the build.",
                    match taken {
                        0 => "no build runs".to_string(),
                        _ => plural(taken, "build runs", "builds run"),
                    },
                    if list.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", list.join("; "))
                    }
                ),
                self.view(&state),
            )
        };
        self.publish(snapshot);
        self.look();
        Some(reason)
    }

    /// Keeps a slot for the first builds in line that fit beside what runs now, one at a time
    /// beside other builds. A slot its build did not take in time goes to the next. Returns
    /// whether anything changed.
    fn grant_slots(
        state: &mut State,
        running: usize,
        free: Option<u64>,
        cores: u32,
        now: Instant,
    ) -> bool {
        let waiting = state.slots.len();
        state.slots.retain(|w| {
            w.granted
                .is_none_or(|at| now.saturating_duration_since(at) < GRANT)
        });
        let mut changed = state.slots.len() != waiting;
        let mut taken = running + state.slots.iter().filter(|w| w.granted.is_some()).count();
        // While a measurement holds the computer, only its own chat may build.
        let holder = state
            .queue
            .first()
            .filter(|r| r.holding.is_some())
            .map(|r| r.conversation.clone());
        for index in 0..state.slots.len() {
            if state.slots[index].granted.is_some() {
                continue;
            }
            if holder
                .as_ref()
                .is_some_and(|holder| *holder != state.slots[index].conversation)
            {
                break;
            }
            let since = state.last_build.map(|at| now.saturating_duration_since(at));
            if !builds::admits(taken, free, cores, since) {
                break;
            }
            state.slots[index].granted = Some(now);
            state.last_build = Some(now);
            taken += 1;
            changed = true;
        }
        changed
    }

    /// Whether a call of the MCP server `server`'s tool that `conversation` wants to make must
    /// wait, as `gate` tells for a command: a server may drive a program here, as unreal-mcp
    /// drives an editor. Agent Studio's own tools and servers whose tools run elsewhere go ahead.
    pub fn gate_call(
        &self,
        conversation: &str,
        server: &str,
        call: Option<&str>,
        wait: &str,
    ) -> Option<String> {
        let light = server == "agent_studio" || light::remote_server(server);
        self.hold(conversation, light, Asked::Tool, call, wait)
    }

    fn hold(
        &self,
        conversation: &str,
        light: bool,
        asked: Asked,
        call: Option<&str>,
        wait: &str,
    ) -> Option<String> {
        let (reason, snapshot) = {
            let mut state = self.lock();
            let first = state.queue.first_mut()?;
            // While it waits for a lull, other chats work on.
            first.holding?;
            // A chat asked to hand over finishes what it needs first.
            let handing = first
                .asks
                .iter()
                .any(|a| a.conversation == conversation && a.ended.is_none() && !a.closing);
            if first.conversation == conversation || handing || light {
                return None;
            }
            // A command waited once however often its call asks.
            if call.is_none_or(|call| first.refused_calls.insert(call.into())) {
                first.refused += 1;
            }
            if let Some(call) = call {
                state.refused.insert(call.into());
                for run in state.runs.values_mut() {
                    run.calls.remove(call);
                }
            }
            let reason = self.refusal(&state.queue[0], asked, wait);
            (reason, self.settled(&mut state, Instant::now()))
        };
        if let Some(snapshot) = snapshot {
            self.publish(snapshot);
        }
        Some(reason)
    }

    fn refusal(&self, first: &Reservation, asked: Asked, wait: &str) -> String {
        let (what, again) = match asked {
            Asked::Command => ("This command", "run the same command again"),
            Asked::Tool => ("This tool call", "make the same call again"),
        };
        format!(
            "{what} did not run: {} reserved this computer for a performance measurement ({}), and other chats' commands and MCP tool calls wait until it ends, {}. Call {wait}, which returns once the computer is free, then {again}. Meanwhile keep reading and editing files; light commands such as git status, ls and rg still run.",
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
                None => "and it waits for other chats' commands and tool calls to finish first".into(),
            }
        )
    }

    /// Waits for `conversation`'s turn: the window of its own reservation, or else for no other
    /// chat to hold the computer. The answer says how long it waited and what for.
    /// `reason` hears what the chat waits for while it waits, for its reply's time report: the
    /// computer (`held`), a build slot (`slot`) or its turn at a name (`turn`), and None once it
    /// no longer waits.
    pub async fn wait(
        &self,
        conversation: &str,
        cancel: &CancellationToken,
        reason: &(dyn Fn(Option<&'static str>) + Send + Sync),
    ) -> Result<String, String> {
        let mut changes = self.version.subscribe();
        let began = Instant::now();
        let (own, slot, turns) = {
            let state = self.lock();
            (
                state.queue.iter().any(|r| r.conversation == conversation),
                state.slots.iter().any(|w| w.conversation == conversation),
                state
                    .turns
                    .iter()
                    .filter(|t| t.conversation == conversation && t.granted.is_none())
                    .map(|t| t.key.clone())
                    .collect::<Vec<_>>(),
            )
        };
        let mut guard = None;
        let mut heard = None;
        reason(None);
        let hear = |now: Option<&'static str>, heard: &mut Option<&'static str>| {
            if now != *heard {
                reason(now);
                *heard = now;
            }
        };
        enum Step {
            Opened(String),
            Done(String),
            Ended,
            /// What it waits for, and whether its wait for the computer just began.
            Wait(&'static str, bool),
        }
        let result = loop {
            // A message ends the wait: the agent reads it, and waits again when it must.
            if let Some(messages) = self.deliver(conversation) {
                break Ok(format!("{messages}\n\n{}", self.wait_status(conversation)));
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
                let held = state
                    .queue
                    .first()
                    .is_some_and(|r| r.conversation != conversation && r.holding.is_some());
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
                        Some(_) => Step::Wait("held", false),
                    }
                } else if held {
                    if guard.is_none() {
                        state.next += 1;
                        let id = state.next;
                        state.waits.push(Wait {
                            id,
                            conversation: conversation.into(),
                            from: Instant::now(),
                            until: None,
                        });
                        guard = Some(WaitGuard { broker: self, id });
                        Step::Wait("held", true)
                    } else {
                        Step::Wait("held", false)
                    }
                } else if let Some(wait) =
                    state.slots.iter().find(|w| w.conversation == conversation)
                {
                    match wait.granted {
                        Some(at) => Step::Done(format!(
                            "A build slot is free for this chat{}: run your build now. The slot waits {} for it.",
                            if slot {
                                format!(" after {}", duration(began.elapsed()))
                            } else {
                                String::new()
                            },
                            duration(GRANT.saturating_sub(at.elapsed()))
                        )),
                        None => Step::Wait("slot", false),
                    }
                } else if state
                    .turns
                    .iter()
                    .any(|t| t.conversation == conversation && t.granted.is_none())
                {
                    Step::Wait("turn", false)
                } else {
                    let came: Vec<&str> = state
                        .turns
                        .iter()
                        .filter(|t| t.conversation == conversation && turns.contains(&t.key))
                        .map(|t| t.name.as_str())
                        .collect();
                    Step::Done(if !came.is_empty() {
                        format!(
                            "Your turn came after {}: this chat holds {} now. Release it with pc_release as soon as you are done.",
                            duration(began.elapsed()),
                            came.join(" and ")
                        )
                    } else if guard.is_some() {
                        format!(
                            "The computer is free again after {}: run your command or tool call now.",
                            duration(began.elapsed())
                        )
                    } else if slot || !turns.is_empty() {
                        "This chat no longer waits for a build slot or a turn.".into()
                    } else if !state.queue.is_empty() {
                        "A measurement waits for a moment when no other chat runs heavy work, and holds nothing yet: run your command or tool call now.".into()
                    } else {
                        "The computer is not reserved: run your command or tool call now.".into()
                    })
                }
            };
            // A wait for the computer ends once nothing holds the chat for it.
            if !matches!(step, Step::Wait("held", _)) {
                drop(guard.take());
            }
            match step {
                Step::Opened(text) => {
                    let left = self.left_running().await;
                    break Ok(format!("{text}{}", self.left_text(conversation, &left)));
                }
                Step::Done(text) => break Ok(text),
                Step::Ended => {
                    break Err("This chat's reservation ended before its window opened.".into())
                }
                Step::Wait(what, fresh) => {
                    hear(Some(what), &mut heard);
                    // The window shows how many chats wait.
                    if fresh {
                        let snapshot = self.view(&self.lock());
                        (self.emit)(&snapshot);
                    }
                }
            }
            tokio::select! {
                changed = changes.changed() => if changed.is_err() { break Err("Agent Studio stopped following reservations.".into()) },
                _ = cancel.cancelled() => break Err("Stopped while waiting for the computer.".into()),
            }
        };
        hear(None, &mut heard);
        result
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
                Some(first)
                    if first
                        .asks
                        .iter()
                        .any(|a| a.conversation == conversation && a.ended.is_none()) =>
                {
                    "Your commands and tool calls run again until you hand over with pc_release."
                }
                Some(first) if first.holding.is_some() => {
                    "The computer is still reserved: call pc_wait again before running a command or an MCP tool call."
                }
                _ if state
                    .slots
                    .iter()
                    .any(|w| w.conversation == conversation && w.granted.is_none()) =>
                {
                    "Your build still waits for a slot: call pc_wait again before running it."
                }
                _ if state
                    .turns
                    .iter()
                    .any(|t| t.conversation == conversation && t.granted.is_none()) =>
                {
                    "Your turn has not come yet: call pc_wait again to wait for it."
                }
                _ => "The computer is not reserved: run your command or tool call now.",
            },
        }
    }

    fn opened_text(&self, reservation: &Reservation, waited: Duration) -> String {
        let mut text = format!(
            "The window is open: no other chat runs busy work now, and their new commands and MCP tool calls wait until you call pc_release. Run every measured run of the series now, then release at once, before reading logs or writing up: other chats wait until you do. You waited {}.",
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
        let idle: Vec<String> = reservation
            .others
            .iter()
            .filter(|s| s.idle && !s.woke && s.until.is_none())
            .map(|s| format!("{} {}", self.chat(&s.conversation), s.label))
            .collect();
        if !idle.is_empty() {
            text.push_str(&format!(
                " Idle work of other chats goes on beside it: {}; the report says whether it woke while you measured.",
                idle.join("; ")
            ));
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
        let lull = self.settings().lull();
        Snapshot {
            turns: state
                .turns
                .iter()
                .map(|t| TurnView {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    landing: t.landing,
                    conversation_id: t.conversation.clone(),
                    purpose: t.purpose.clone(),
                    asked_at: t.asked_at,
                    granted_at: t.granted_at,
                })
                .collect(),
            slots: state
                .slots
                .iter()
                .map(|w| SlotView {
                    conversation_id: w.conversation.clone(),
                    label: w.label.clone(),
                    since: w.since_at,
                    granted: w.granted.is_some(),
                })
                .collect(),
            reservations: state
                .queue
                .iter()
                .enumerate()
                .map(|(index, r)| View {
                    id: r.id.clone(),
                    conversation_id: r.conversation.clone(),
                    purpose: r.purpose.clone(),
                    phase: match (index, r.opened, r.holding) {
                        (0, Some(_), _) => "open",
                        (0, None, Some(_)) => "draining",
                        (0, None, None) => "lull",
                        _ => "queued",
                    },
                    asked_at: r.asked_at,
                    holds_at: (index == 0 && r.opened.is_none() && r.holding.is_none()).then(
                        || {
                            let first = r.first.unwrap_or(r.asked);
                            r.asked_at + ms(first.saturating_duration_since(r.asked) + lull)
                        },
                    ),
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
                "Reserved, after {} ({}), whose turn comes first{}. Other chats' new commands and MCP tool calls, yours included, wait until it ends. Call pc_wait: it returns once your window opens.",
                self.chat(&first.conversation),
                first.purpose,
                if index > 1 { format!(", and {} more before you", index - 1) } else { String::new() }
            )
        } else if mine.opened.is_some() {
            "Reserved, and the window is open: no other chat runs busy work now. Measure, then call pc_release.".into()
        } else if mine.holding.is_none() {
            format!(
                "Reserved: your window opens at the first moment no other chat runs busy work: a command, an MCP tool call or background work its reply waits on, unless it has stayed idle, as a watcher between its checks does. Until then other chats work on, and if no such moment comes within {}, their new commands and MCP tool calls wait from then on, except light ones such as git status. Call pc_wait: it returns once the window opens.",
                duration(self.settings().lull())
            )
        } else {
            "Reserved: from now on other chats' commands and MCP tool calls wait, except light commands such as git status. Call pc_wait: it returns once the work below has finished or gone idle and the window opens.".into()
        };
        let others: Vec<&Item> = items
            .iter()
            .filter(|i| i.conversation != conversation && !i.light)
            .collect();
        let (progress, left): (Vec<&&Item>, Vec<&&Item>) =
            others.iter().partition(|i| i.in_progress);
        let (idle, progress): (Vec<&&Item>, Vec<&&Item>) =
            progress.into_iter().partition(|i| i.idle);
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
        if !idle.is_empty() {
            text.push_str(
                "\nIdle in other chats (the window does not wait for these while they stay idle):",
            );
            for item in idle {
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
            let items = items(&state, &(self.background)(), Instant::now());
            let lull_left = |first: &Reservation| {
                let first_at = first.first.unwrap_or(first.asked);
                duration(self.settings().lull().saturating_sub(first_at.elapsed()))
            };
            let mut text = match state.queue.first() {
                None => "The computer is not reserved.".to_string(),
                Some(first) if first.conversation == conversation => {
                    if first.opened.is_some() {
                        "This chat holds the computer and its window is open.".into()
                    } else if first.holding.is_none() {
                        format!(
                            "This chat holds the computer and waits for a lull: its window opens at the first moment no other chat runs the work listed below, and other chats' new work waits in {} if none comes. Call pc_wait.",
                            lull_left(first)
                        )
                    } else {
                        "This chat holds the computer; its window opens once the work listed below finishes. Call pc_wait.".into()
                    }
                }
                Some(first) if first.holding.is_none() => format!(
                    "{} reserved the computer ({}) and waits for a moment when no other chat runs heavy work. Other chats' commands and MCP tool calls still run; in {} without such a moment, their new ones wait until its measurement ends.",
                    capitalized(&self.named(&first.conversation)),
                    first.purpose,
                    lull_left(first)
                ),
                Some(first) => format!(
                    "{} holds the computer ({}); {}. Other chats' commands and MCP tool calls wait until it ends: call pc_wait before running one.",
                    capitalized(&self.named(&first.conversation)),
                    first.purpose,
                    if first.opened.is_some() { "its window is open" } else { "it waits for other chats' busy commands and tool calls to finish or go idle" }
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
                    text.push_str(" It asked this chat to hand over what it holds: your commands and tool calls run until you do, so finish what you need, then call pc_release.");
                }
                if first.conversation == conversation {
                    let frozen = frozen_groups(&first.frozen);
                    if !frozen.is_empty() {
                        text.push_str(&format!(
                            "\nProcesses other chats' programs started while your window is open wait for it to end: {}.",
                            self.frozen_text(&frozen)
                        ));
                    }
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
            text.push_str(&self.turns_text(&state, conversation));
            let builds = running_builds(&state, None, None);
            if !builds.is_empty() || !state.slots.is_empty() {
                text.push_str(&format!(
                    "\nBuilds of chats now ({} at once here, one for each eight cores, while memory lasts):",
                    plural(builds::slots(cores()), "build runs", "builds run")
                ));
                for build in &builds {
                    text.push_str(&format!(
                        "\n- {}: {}",
                        build
                            .conversation
                            .as_deref()
                            .map(|c| self.named(c))
                            .unwrap_or_default(),
                        build.label
                    ));
                }
                for (index, wait) in state.slots.iter().enumerate() {
                    let who = if wait.conversation == conversation {
                        "this chat".to_string()
                    } else {
                        self.named(&wait.conversation)
                    };
                    text.push_str(&if wait.granted.is_some() {
                        format!("\n- A slot is kept for {who}'s build {}", wait.label)
                    } else {
                        format!(
                            "\n- {} waits for a slot ({} in line, for {}): {}",
                            capitalized(&who),
                            index + 1,
                            duration(wait.since.elapsed()),
                            wait.label
                        )
                    });
                }
            }
            let others: Vec<&Item> = items
                .iter()
                .filter(|i| i.conversation != conversation)
                .collect();
            if others.is_empty() {
                text.push_str(
                    "\nNo other chat runs a command, an MCP tool call or background work now.",
                );
            } else {
                text.push_str("\nOther chats' work now:");
                for item in others {
                    text.push_str(&format!(
                        "\n- {}: {}{}",
                        self.named(&item.conversation),
                        item.label,
                        match (item.in_progress, item.light, item.idle) {
                            (_, true, _) => " (light)",
                            (true, false, false) => "",
                            (true, false, true) =>
                                " (idle, so a reservation's window does not wait for it)",
                            (false, false, _) => " (left running after its reply ended)",
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

    /// The named reservations, each with its holder and the chats waiting for it, as text for
    /// `conversation`'s agent. Empty when there are none.
    fn turns_text(&self, state: &State, conversation: &str) -> String {
        let mut keys: Vec<&str> = vec![];
        for turn in &state.turns {
            if !keys.contains(&turn.key.as_str()) {
                keys.push(&turn.key);
            }
        }
        let mut text = String::new();
        for key in keys {
            let same: Vec<&Turn> = state.turns.iter().filter(|t| t.key == key).collect();
            let who = |turn: &Turn| {
                if turn.conversation == conversation {
                    "this chat".to_string()
                } else {
                    self.named(&turn.conversation)
                }
            };
            let holder = same[0];
            text.push_str(&format!(
                "\nNamed reservation, {}: held by {} ({}) for {}",
                holder.name,
                who(holder),
                holder.purpose,
                duration(holder.granted.map_or(Duration::ZERO, |at| at.elapsed()))
            ));
            if same.len() > 1 {
                text.push_str(&format!(
                    "; waiting: {}",
                    same[1..]
                        .iter()
                        .map(|t| format!("{} ({})", who(t), duration(t.asked.elapsed())))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            text.push('.');
        }
        text
    }

    /// The programs chats left running now, by conversation: on Windows from one reading of the
    /// computer, and inside each WSL distribution a chat's CLI runs in from one reading there.
    async fn left_running(&self) -> HashMap<String, Vec<programs::Program>> {
        let (mut left, inside) = tokio::join!(
            programs::now(self.jobs.members()),
            programs::wsl_left(self.jobs.wsl())
        );
        add_left(&mut left, inside);
        left
    }

    /// The computer over the last second, with what chats left running inside WSL too.
    pub async fn now(&self) -> Option<machine::Now> {
        let (now, inside) = tokio::join!(
            machine::now(self.jobs.members()),
            programs::wsl_left(self.jobs.wsl())
        );
        let mut now = now?;
        add_left(&mut now.left, inside);
        Some(now)
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
                            "{}{} (program {}{}{}), {}{}",
                            p.name,
                            if p.processes.len() > 1 {
                                format!(" ×{}", p.processes.len())
                            } else {
                                String::new()
                            },
                            p.pid,
                            if p.window { ", a window" } else { "" },
                            p.place
                                .as_ref()
                                .map(|place| format!(", in WSL {place}"))
                                .unwrap_or_default(),
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
        let first = r.first.unwrap_or(r.asked);
        match (opened_after, window) {
            (Some(after), Some(window)) => lines.push(format!(
                "The window opened {} after the reservation{} and stayed open {}.",
                duration(after),
                match (r.holding, r.opened) {
                    (Some(holding), Some(opened)) if holding < opened => format!(
                        " ({} waiting for a lull, then {} holding other chats' new work while theirs finished)",
                        duration(holding.saturating_duration_since(first)),
                        duration(opened.saturating_duration_since(holding))
                    ),
                    _ => ", at a moment no other chat ran heavy work".into(),
                },
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
        let (idle, busy) = beside_spans(r, now);
        if r.opened.is_some() {
            if !busy.is_empty() {
                lines.push(format!(
                    "Other chats' work that ran during it anyway: {}.",
                    self.spans_text(&busy)
                ));
            }
            if !idle.is_empty() {
                lines.push(format!(
                    "It opened beside other chats' work that stayed idle: {}.",
                    self.spans_text(&idle)
                ));
            }
            if busy.is_empty() && idle.is_empty() {
                lines.push("During it, no other chat ran a command or an MCP tool call.".into());
            }
            if let Some(text) = r.measure.text(|conversation| self.chat(conversation)) {
                lines.push(text);
            }
        }
        // Whether the measurement ran beside other heavy work, whoever ran it.
        let beside = r.opened.map(|_| self.beside(r, now));
        if let Some(beside) = &beside {
            lines.push(if beside.is_empty() {
                "Measurement: clean, no other heavy work ran while the window was open.".into()
            } else {
                format!(
                    "Measurement: ran beside other heavy work, so its numbers may be off: {}. Tell the user, and offer to measure again.",
                    beside
                        .iter()
                        .map(|(text, _)| text.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                )
            });
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
        let frozen = frozen_groups(&r.frozen);
        if !frozen.is_empty() {
            lines.push(format!(
                "Processes other chats' programs started while the window was open waited for it to end: {}.",
                self.frozen_text(&frozen)
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
                plural(
                    r.refused as usize,
                    "command or tool call",
                    "commands and tool calls"
                )
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
            // How long it waited for a lull before it held other chats' new work, or before its
            // window opened at one.
            "lullMs": ms(r.holding.or(r.opened).unwrap_or(now).saturating_duration_since(first)),
            "contaminated": beside.as_ref().map(|beside| !beside.is_empty()),
            "ranBeside": beside.iter().flatten().map(|(_, record)| record.clone()).collect::<Vec<_>>(),
            "blockers": blockers.iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
            "others": busy.iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
            // Other chats' work in progress the window opened beside, which stayed idle.
            "idle": idle.iter().map(|(conversation, label, time)| json!({"conversationId": conversation, "label": label, "ms": ms(*time)})).collect::<Vec<_>>(),
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
            "frozen": frozen.iter().map(|(conversation, name, count)| json!({"conversationId": conversation, "name": name, "processes": count})).collect::<Vec<_>>(),
            "machine": r.measure.record(),
        });
        Report {
            text: lines.join("\n"),
            record,
        }
    }

    /// Heavy work that ran beside a reservation's measurement, each as text and as a record:
    /// other chats' commands and MCP tool calls that ran while its window was open, unless they
    /// stayed idle, then what the computer's readings show used it heavily
    /// (`machine::Window::beside`), whoever's it was: a chat's programs, a Claude or Codex
    /// session outside Agent Studio, Agent Studio, the system or the user's own.
    fn beside(&self, r: &Reservation, now: Instant) -> Vec<(String, Value)> {
        let calls: Vec<Span> = r
            .others
            .iter()
            .filter(|s| !s.background && !s.key.starts_with("ask:"))
            .filter(|s| !s.idle || s.woke)
            .filter(|s| !r.refused_calls.contains(&s.key))
            .cloned()
            .collect();
        let mut chats = HashSet::new();
        let mut list = vec![];
        for (conversation, label, time) in summed(&calls, now) {
            if time.is_zero() {
                continue;
            }
            chats.insert(conversation.clone());
            list.push((
                format!(
                    "{} ran {} for {}",
                    self.chat(&conversation),
                    label,
                    duration(time)
                ),
                json!({"conversationId": conversation, "label": label, "ms": ms(time)}),
            ));
        }
        for work in r.measure.beside() {
            let whose = match &work.owner {
                machine::Owner::Chat(chat) if chats.contains(chat) => continue,
                machine::Owner::Chat(chat) => format!("processes of {}", self.chat(chat)),
                machine::Owner::Yours => "programs of yours".into(),
                owner => machine::owner_text(owner, &|c: &str| self.chat(c)),
            };
            list.push((
                format!(
                    "{whose} ({}) at {} of the CPU, {} at most, for {}",
                    work.name,
                    machine::percent(work.cpu_average),
                    machine::percent(work.cpu_peak),
                    duration(Duration::from_millis(work.ms))
                ),
                json!({
                    "owner": machine::owner_key(&work.owner),
                    "name": work.name,
                    "ms": work.ms,
                    "cpuAverage": work.cpu_average,
                    "cpuPeak": work.cpu_peak,
                }),
            ));
        }
        list
    }

    /// Processes held, by chat and program, as text.
    fn frozen_text(&self, frozen: &[(String, String, usize)]) -> String {
        frozen
            .iter()
            .map(|(conversation, name, count)| {
                format!(
                    "{name}{} ({})",
                    if *count > 1 {
                        format!(" ×{count}")
                    } else {
                        String::new()
                    },
                    self.chat(conversation)
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The reservations this computer kept, oldest first, as its history records them.
    pub fn history(&self) -> Vec<Value> {
        self.history
            .as_deref()
            .map(read_history)
            .unwrap_or_default()
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

/// The reservations a history file holds, one JSON object a line; a line that is not one, such
/// as the end of a write the app did not finish, is left out.
fn read_history(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(Value::is_object)
                .collect()
        })
        .unwrap_or_default()
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

/// Gives each name to the first chat in line for it. Returns whether any turn came.
fn grant_turns(turns: &mut [Turn], now: Instant) -> bool {
    let mut seen = HashSet::new();
    let mut changed = false;
    for turn in turns.iter_mut() {
        if seen.insert(turn.key.clone()) && turn.granted.is_none() {
            turn.granted = Some(now);
            turn.granted_at = Some(epoch_ms());
            changed = true;
        }
    }
    changed
}

/// How an agent names its turn to release it.
fn release_hint(turn: &Turn) -> String {
    if turn.landing {
        "landing: true".into()
    } else {
        format!("name: \"{}\"", turn.name)
    }
}

/// The builds running on the computer now, besides the call `except`: chats' calls that build,
/// then from `machine`'s compilers the builds no such call stands for, such as a chat's build
/// left in the background, a Claude app session's or one started by hand.
fn running_builds(
    state: &State,
    machine: Option<(&machine::Reading, &machine::Owners)>,
    except: Option<&str>,
) -> Vec<Running> {
    let mut running = vec![];
    let mut tracked = HashSet::new();
    for run in state.runs.values() {
        for (id, call) in &run.calls {
            if call.build && Some(id.as_str()) != except {
                tracked.insert(run.conversation.clone());
                running.push(Running {
                    conversation: Some(run.conversation.clone()),
                    label: call.label.clone(),
                });
            }
        }
    }
    if let Some((reading, owners)) = machine {
        for build in builds::compiling(reading, owners) {
            let what = format!(
                "{} with {}",
                build.name,
                plural(build.compilers, "compiler", "compilers")
            );
            match build.owner {
                machine::Owner::Chat(chat) if tracked.contains(&chat) => {}
                machine::Owner::Chat(chat) => running.push(Running {
                    conversation: Some(chat),
                    label: what,
                }),
                owner => {
                    let whose = match &owner {
                        machine::Owner::Yours => "a build of yours".to_string(),
                        other => machine::owner_text(other, &|c: &str| c.to_string()),
                    };
                    running.push(Running {
                        conversation: None,
                        label: format!("{}: {what}", capitalized(&whose)),
                    })
                }
            }
        }
    }
    running
}

/// The computer's cores, where no reading tells them.
fn cores() -> u32 {
    std::thread::available_parallelism().map_or(1, |n| n.get() as u32)
}

/// A command as a label: its first line of its own, in backticks.
fn command_label(command: &str) -> String {
    command
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !light::hook_line(l))
        .map(|line| format!("`{}`", shortened(line, 160)))
        .unwrap_or_else(|| "a build".into())
}

/// Whether `conversation`'s work has stayed idle by every reading that can tell (`Idle`): on this
/// computer, and inside WSL for a chat whose CLI runs there.
fn idle_now(state: &State, conversation: &str, now: Instant) -> bool {
    let Some(idle) = state.idle.get(conversation) else {
        return false;
    };
    idle.here.is_some_and(|s| s.idle(now))
        && (!state.in_wsl.contains(conversation) || idle.wsl.is_some_and(|s| s.idle(now)))
}

/// Takes what readings found of chats' work between `from` and `now`, in cores, on this computer
/// or inside WSL: each chat of `read` that `work` lacks could not be read, and counts as busy.
fn heard_work(
    state: &mut State,
    wsl: bool,
    read: impl IntoIterator<Item = String>,
    work: &HashMap<String, f64>,
    from: Instant,
    now: Instant,
) {
    for conversation in read {
        let busy = work
            .get(&conversation)
            .is_none_or(|cores| *cores >= machine::IDLE_CORE);
        let idle = state.idle.entry(conversation).or_default();
        let streak = if wsl { &mut idle.wsl } else { &mut idle.here };
        *streak = Some(Streak::heard(*streak, busy, from, now));
    }
}

/// The work other chats run now: their commands, and the background work their CLIs keep.
fn items(state: &State, background: &[BackgroundWork], now: Instant) -> Vec<Item> {
    let mut items: Vec<Item> = state
        .runs
        .values()
        .flat_map(|run| {
            let idle = idle_now(state, &run.conversation, now);
            run.calls.iter().map(move |(id, call)| Item {
                key: id.clone(),
                conversation: run.conversation.clone(),
                label: call.label.clone(),
                light: call.light,
                in_progress: true,
                background: false,
                idle,
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
            idle: idle_now(state, &work.conversation, now),
        });
    }
    items.sort_by(|a, b| a.conversation.cmp(&b.conversation).then(a.key.cmp(&b.key)));
    items
}

/// Brings the first reservation up to date with `items`: what keeps its window closed, whether
/// it opens, and what else runs once it is open. Work in progress that has stayed idle never keeps
/// it closed. Returns whether anything changed.
fn settle(state: &mut State, items: &[Item], now: Instant, lull: Duration) -> bool {
    // When a reading last found each chat's work busy.
    let busy: HashMap<String, Instant> = state
        .idle
        .iter()
        .filter_map(|(conversation, idle)| {
            let at = idle
                .here
                .and_then(|s| s.busy)
                .max(idle.wsl.and_then(|s| s.busy))?;
            Some((conversation.clone(), at))
        })
        .collect();
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
                idle: false,
            }),
    );
    let others: Vec<&Item> = work.iter().collect();
    if first.opened.is_none() {
        let blocking: Vec<&Item> = others
            .iter()
            .copied()
            .filter(|i| i.in_progress && !i.idle)
            .collect();
        changed |= track(&mut first.blockers, &blocking, now);
        if blocking.is_empty() {
            first.opened = Some(now);
            first.opened_at = Some(epoch_ms());
            // From its window on, other chats' new work waits.
            first.holding.get_or_insert(now);
            changed = true;
        } else if first.holding.is_none()
            && now.saturating_duration_since(first.first.unwrap_or(now)) >= lull
        {
            // No lull came in time: other chats' new work waits from now on, so the work
            // running now is the last to finish before the window.
            first.holding = Some(now);
            changed = true;
        }
    }
    if first.opened.is_some() {
        changed |= track(&mut first.others, &others, now);
        // Idle work the window opened beside that a reading then found busy ran beside it.
        for span in first.others.iter_mut().filter(|s| s.idle && !s.woke) {
            let until = span.until.unwrap_or(now);
            if busy
                .get(&span.conversation)
                .is_some_and(|at| *at > span.from && *at <= until)
            {
                span.woke = true;
                changed = true;
            }
        }
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
                background: item.background,
                idle: item.idle,
                woke: false,
                from: now,
                until: None,
            });
            changed = true;
        }
    }
    changed
}

/// Other chats' work during `r`'s window, by chat and label: what stayed idle, then what ran,
/// busy from the start or once a reading found it so. Calls the gate refused never ran.
type Summed = Vec<(String, String, Duration)>;
fn beside_spans(r: &Reservation, now: Instant) -> (Summed, Summed) {
    let (idle, busy): (Vec<Span>, Vec<Span>) = r
        .others
        .iter()
        .filter(|s| !r.refused_calls.contains(&s.key))
        .cloned()
        .partition(|s| s.idle && !s.woke);
    (summed(&idle, now), summed(&busy, now))
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
    if let Some((server, called)) = tool.connected() {
        return format!("{} of {}", shortened(called, 80), shortened(server, 80));
    }
    let command = tool
        .command()
        .and_then(|c| {
            c.lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !light::hook_line(l))
        })
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

/// The file beside the history that keeps which processes wait (`hold::save`).
const FROZEN: &str = "frozen.json";

/// Processes held, by chat and program name, in the order they began.
fn frozen_groups(frozen: &[Frozen]) -> Vec<(String, String, usize)> {
    let mut groups: Vec<(String, String, usize)> = vec![];
    for f in frozen {
        match groups
            .iter_mut()
            .find(|(conversation, name, _)| *conversation == f.conversation && *name == f.name)
        {
            Some(group) => group.2 += 1,
            None => groups.push((f.conversation.clone(), f.name.clone(), 1)),
        }
    }
    groups
}

/// Adds the programs chats left running inside WSL to those found on Windows, largest first.
fn add_left(
    left: &mut HashMap<String, Vec<programs::Program>>,
    inside: HashMap<String, Vec<programs::Program>>,
) {
    for (conversation, programs) in inside {
        let list = left.entry(conversation).or_default();
        list.extend(programs);
        list.sort_by(|a, b| b.memory.cmp(&a.memory).then(a.pid.cmp(&b.pid)));
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
