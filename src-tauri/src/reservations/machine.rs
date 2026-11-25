//! What this computer runs and how busy it is: read every two seconds while a reservation's
//! window is open, for its report, and over one second when a chat asks (`pc_status`). Each
//! process is the chat's that started it (`jobs`), Agent Studio's own, the system's (Windows'
//! services, outside the signed-in session; Linux's kernel threads) or the user's. Readings stay
//! in memory; only a report's totals are kept.
use super::jobs::Members;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    /// The CPU time it used since it began, in milliseconds.
    pub cpu_ms: u64,
    /// Its memory in use, in bytes.
    pub memory: u64,
    /// When it began, comparable between the processes of a reading only, which tells a parent
    /// from a later process that took its id.
    pub began: u64,
    pub system: bool,
}

#[derive(Clone, Debug)]
pub struct Reading {
    pub at: Instant,
    /// CPU time the computer's cores spent busy, and in all, in milliseconds.
    pub busy_ms: u64,
    pub total_ms: u64,
    pub memory_total: u64,
    pub memory_available: u64,
    /// Memory programs may still commit (Windows' available commit), where it can be read.
    pub commit_available: Option<u64>,
    pub cores: u32,
    pub processes: Vec<Process>,
}
impl Reading {
    /// The memory a new program can still take: available commit on Windows, which binds before
    /// physical memory does, else available memory.
    pub fn free(&self) -> u64 {
        self.commit_available.unwrap_or(self.memory_available)
    }
}

/// Whose a process is.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    Chat(String),
    App,
    System,
    /// WSL's virtual machine, which runs every process of the WSL distributions.
    Wsl,
    /// A Claude Code or Codex session outside Agent Studio, with what it runs (`SESSIONS`).
    Session(&'static str),
    Yours,
}

/// Sessions outside Agent Studio, by key: the Claude app and what its Code sessions run, Claude
/// Code in a terminal or an editor, and Codex anywhere.
pub const SESSIONS: [(&str, &str); 3] = [
    ("claude-app", "the Claude app"),
    ("claude-cli", "Claude Code outside Agent Studio"),
    ("codex", "Codex outside Agent Studio"),
];
/// Programs a terminal or an editor runs Claude Code in.
const TERMINALS: &[&str] = &[
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "zsh",
    "fish",
    "wsl",
    "windowsterminal",
    "openconsole",
    "conhost",
    "wezterm-gui",
    "alacritty",
    "mintty",
    "code",
    "cursor",
    "windsurf",
    "idea64",
    "rider64",
    "rustrover64",
];

/// A reading of this computer, or None where it cannot be read.
pub fn read() -> Option<Reading> {
    platform::read()
}

/// Whose each process of a reading is.
pub struct Owners(HashMap<u32, Owner>);
impl Owners {
    pub fn new(reading: &Reading, members: &Members, app: u32) -> Self {
        let index: HashMap<u32, &Process> = reading.processes.iter().map(|p| (p.pid, p)).collect();
        Self(
            reading
                .processes
                .iter()
                .map(|process| (process.pid, owner(process, &index, members, app)))
                .collect(),
        )
    }
    pub fn of(&self, pid: u32) -> Owner {
        self.0.get(&pid).cloned().unwrap_or(Owner::Yours)
    }
}

fn owner(process: &Process, index: &HashMap<u32, &Process>, members: &Members, app: u32) -> Owner {
    let mut current = process;
    let mut chain = vec![process];
    // The chain of parents: a chat's CLI or this app started it, unless a parent's id now
    // belongs to a process that began after its child.
    for _ in 0..256 {
        if let Some(chat) = members
            .chats
            .get(&current.pid)
            .or_else(|| members.roots.get(&current.pid))
        {
            return Owner::Chat(chat.clone());
        }
        if current.pid == app {
            return Owner::App;
        }
        match index.get(&current.parent) {
            Some(parent) if parent.pid != current.pid && parent.began <= current.began => {
                current = parent;
                chain.push(parent);
            }
            _ => break,
        }
    }
    if let Some(session) = session(&chain) {
        return Owner::Session(session);
    }
    if wsl_machine(&process.name) {
        Owner::Wsl
    } else if process.system {
        Owner::System
    } else {
        Owner::Yours
    }
}

/// The session outside Agent Studio a chain of parents runs under, nearest first: Claude Code
/// (`claude`), whose topmost process is the Claude app's own unless a terminal or an editor
/// started it, or Codex.
fn session(chain: &[&Process]) -> Option<&'static str> {
    let name = |p: &Process| super::light::program_name(&p.name);
    let at = chain
        .iter()
        .position(|p| matches!(name(p).as_str(), "claude" | "codex"))?;
    if name(chain[at]) == "codex" {
        return Some("codex");
    }
    // The Claude app runs its windows and its Code sessions as processes of the same name.
    let mut top = at;
    while chain.get(top + 1).is_some_and(|p| name(p) == "claude") {
        top += 1;
    }
    let started_by = chain.get(top + 1).map(|p| name(p));
    Some(
        if started_by.is_some_and(|parent| TERMINALS.contains(&parent.as_str())) {
            "claude-cli"
        } else {
            "claude-app"
        },
    )
}

/// WSL's virtual machine process (`vmmemWSL`, `vmmem` before it), which Windows shows for
/// everything its distributions run.
fn wsl_machine(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("vmmem")
}

/// How busy the computer and each process was between two readings, in percent of the whole
/// computer. A process counts from the second reading it appears in.
struct Usage {
    cpu: f64,
    processes: Vec<(u32, f64)>,
}
fn usage(previous: &Reading, current: &Reading) -> Option<Usage> {
    let total = current
        .total_ms
        .checked_sub(previous.total_ms)
        .filter(|t| *t > 0)?;
    let busy = current.busy_ms.saturating_sub(previous.busy_ms).min(total);
    let capacity = current
        .at
        .saturating_duration_since(previous.at)
        .as_secs_f64()
        * 1000.0
        * f64::from(current.cores.max(1));
    let before: HashMap<(u32, u64), u64> = previous
        .processes
        .iter()
        .map(|p| ((p.pid, p.began), p.cpu_ms))
        .collect();
    let processes = current
        .processes
        .iter()
        .filter_map(|p| {
            let earlier = before.get(&(p.pid, p.began))?;
            let used = p.cpu_ms.saturating_sub(*earlier) as f64;
            Some((
                p.pid,
                if capacity > 0.0 {
                    (used * 100.0 / capacity).min(100.0)
                } else {
                    0.0
                },
            ))
        })
        .collect();
    Some(Usage {
        cpu: busy as f64 * 100.0 / total as f64,
        processes,
    })
}

/// Work that keeps less than this much of one core busy is idle: it waits, as a watcher, a server
/// or a poll between its checks does, and a reservation's window does not wait for it (requested
/// 2026-11-25, after a pull request watcher that slept between its polls, for up to three hours,
/// kept a window closed while four chats waited on a computer at 3.6% CPU).
pub const IDLE_CORE: f64 = 0.25;

/// How much of a core each chat's work kept busy between two readings, each with the chats' jobs
/// then: what the chat's job ran, short-lived processes included (`Members::jobs`), less its CLI
/// itself and the programs it left running outside the CLI's tree, which are not its work in
/// progress. Only chats whose CLI both readings saw are listed.
pub fn work(previous: (&Reading, &Members), current: (&Reading, &Members)) -> HashMap<String, f64> {
    let (before, then) = previous;
    let (after, now) = current;
    let mut work = HashMap::new();
    let seconds = after.at.saturating_duration_since(before.at).as_secs_f64();
    if seconds <= 0.0 {
        return work;
    }
    let earlier: HashMap<(u32, u64), u64> = before
        .processes
        .iter()
        .map(|p| ((p.pid, p.began), p.cpu_ms))
        .collect();
    let index: HashMap<u32, &Process> = after.processes.iter().map(|p| (p.pid, p)).collect();
    let began = |reading: &Reading, pid: u32| {
        reading
            .processes
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| p.began)
    };
    for (root, job) in &now.jobs {
        let (Some(conversation), Some(last)) = (now.roots.get(root), then.jobs.get(root)) else {
            continue;
        };
        // The same CLI both times, since a later process may take a CLI's id.
        let cli = began(after, *root);
        if then.roots.get(root) != Some(conversation)
            || cli.is_none()
            || began(before, *root) != cli
        {
            continue;
        }
        let mut ms = job.cpu_ms.saturating_sub(last.cpu_ms) as f64;
        let members: HashSet<u32> = job.pids.iter().copied().collect();
        for process in job.pids.iter().filter_map(|pid| index.get(pid)) {
            if process.pid == *root || !under(process, *root, &index, &members) {
                if let Some(used) = earlier.get(&(process.pid, process.began)) {
                    ms -= process.cpu_ms.saturating_sub(*used) as f64;
                }
            }
        }
        *work.entry(conversation.clone()).or_insert(0.0) += ms.max(0.0) / 1000.0 / seconds;
    }
    work
}

/// Whether `process` descends from the CLI `root` through processes of its job, unless an id on
/// the way belongs to a process that began after its child.
fn under(process: &Process, root: u32, index: &HashMap<u32, &Process>, job: &HashSet<u32>) -> bool {
    let mut current = process;
    for _ in 0..256 {
        if current.pid == root {
            return true;
        }
        match index.get(&current.parent) {
            Some(next)
                if next.pid != current.pid
                    && next.began <= current.began
                    && job.contains(&next.pid) =>
            {
                current = next
            }
            _ => return false,
        }
    }
    false
}

/// A program as a report shows it: its processes of one owner, together.
#[derive(Default)]
struct Group {
    pids: HashSet<u32>,
    cpu_sum: f64,
    cpu_peak: f64,
    memory_peak: u64,
}

/// What the computer did while a reservation's window was open.
#[derive(Default)]
pub struct Window {
    previous: Option<Reading>,
    samples: u32,
    cpu_sum: f64,
    cpu_peak: f64,
    holder_sum: f64,
    others_sum: f64,
    others_peak: f64,
    memory_total: u64,
    used_peak: u64,
    available_min: Option<u64>,
    groups: HashMap<(Owner, String), Group>,
    /// The measuring chat runs in WSL, so WSL's virtual machine counted as its own.
    inside_wsl: bool,
    /// Heavy work beside the measurement, by whose it was (`HEAVY`).
    beside: HashMap<Owner, Beside>,
}

/// An owner whose processes used at least a whole core and 5% of the computer between two
/// readings ran heavy work beside the measurement; one that did so in two readings or more
/// disturbed it (requested 2026-11-24: mark each measurement that ran beside other heavy work,
/// whoever ran it).
const HEAVY_PERCENT: f64 = 5.0;
const HEAVY_READINGS: u32 = 2;

#[derive(Default)]
struct Beside {
    readings: u32,
    ms: u64,
    cpu_sum: f64,
    cpu_peak: f64,
    /// CPU by program, to name the busiest.
    programs: HashMap<String, f64>,
}

/// Heavy work that ran beside a measurement.
#[derive(Clone, Debug, PartialEq)]
pub struct BesideWork {
    pub owner: Owner,
    /// Its busiest program.
    pub name: String,
    /// How long it ran heavy work, and how much of the CPU it used meanwhile.
    pub ms: u64,
    pub cpu_average: f64,
    pub cpu_peak: f64,
}

impl Window {
    /// Adds a reading, whose processes `owners` attributes; `holder` is the chat measuring,
    /// whose own processes include WSL's virtual machine when it runs in WSL (`inside_wsl`): the
    /// other chats' commands wait meanwhile, so what the machine does is mostly the measurement.
    pub fn add(&mut self, reading: Reading, owners: &Owners, holder: &str, inside_wsl: bool) {
        self.inside_wsl |= inside_wsl;
        self.memory_total = reading.memory_total;
        self.used_peak = self.used_peak.max(
            reading
                .memory_total
                .saturating_sub(reading.memory_available),
        );
        self.available_min = Some(self.available_min.map_or(reading.memory_available, |m| {
            m.min(reading.memory_available)
        }));
        if let Some(usage) = self.previous.as_ref().and_then(|p| usage(p, &reading)) {
            self.samples += 1;
            self.cpu_sum += usage.cpu;
            self.cpu_peak = self.cpu_peak.max(usage.cpu);
            let mut sample: HashMap<(Owner, String), (f64, u64)> = HashMap::new();
            let mut by_owner: HashMap<Owner, (f64, HashMap<String, f64>)> = HashMap::new();
            let mut holder_cpu = 0.0;
            let memory: HashMap<u32, (&str, u64)> = reading
                .processes
                .iter()
                .map(|p| (p.pid, (p.name.as_str(), p.memory)))
                .collect();
            for (pid, cpu) in &usage.processes {
                let owner = owners.of(*pid);
                if owner == Owner::Chat(holder.into()) || (inside_wsl && owner == Owner::Wsl) {
                    holder_cpu += cpu;
                    continue;
                }
                let (name, bytes) = memory.get(pid).copied().unwrap_or(("", 0));
                let entry = sample.entry((owner.clone(), name.to_string())).or_default();
                entry.0 += cpu;
                entry.1 += bytes;
                let whose = by_owner.entry(owner.clone()).or_default();
                whose.0 += cpu;
                *whose.1.entry(name.to_string()).or_default() += cpu;
                self.groups
                    .entry((owner, name.to_string()))
                    .or_default()
                    .pids
                    .insert(*pid);
            }
            let heavy = (100.0 / f64::from(reading.cores.max(1))).max(HEAVY_PERCENT);
            let interval = self.previous.as_ref().map_or(0, |p| {
                reading.at.saturating_duration_since(p.at).as_millis() as u64
            });
            for (owner, (cpu, programs)) in by_owner {
                if cpu < heavy {
                    continue;
                }
                let beside = self.beside.entry(owner).or_default();
                beside.readings += 1;
                beside.ms += interval;
                beside.cpu_sum += cpu;
                beside.cpu_peak = beside.cpu_peak.max(cpu);
                for (name, used) in programs {
                    *beside.programs.entry(name).or_default() += used;
                }
            }
            for (key, (cpu, bytes)) in sample {
                let group = self.groups.entry(key).or_default();
                group.cpu_sum += cpu;
                group.cpu_peak = group.cpu_peak.max(cpu);
                group.memory_peak = group.memory_peak.max(bytes);
            }
            let others = (usage.cpu - holder_cpu).max(0.0);
            self.holder_sum += holder_cpu.min(usage.cpu);
            self.others_sum += others;
            self.others_peak = self.others_peak.max(others);
        }
        self.previous = Some(reading);
    }

    /// Heavy work that ran beside the measurement, whoever's it was, the most first.
    pub fn beside(&self) -> Vec<BesideWork> {
        let mut work: Vec<BesideWork> = self
            .beside
            .iter()
            .filter(|(_, b)| b.readings >= HEAVY_READINGS)
            .map(|(owner, b)| BesideWork {
                owner: owner.clone(),
                name: b
                    .programs
                    .iter()
                    .filter(|(name, _)| !name.is_empty())
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .map(|(name, _)| name.clone())
                    .unwrap_or_default(),
                ms: b.ms,
                cpu_average: round(b.cpu_sum / f64::from(b.readings)),
                cpu_peak: round(b.cpu_peak),
            })
            .collect();
        work.sort_by(|a, b| {
            (b.cpu_average * b.ms as f64).total_cmp(&(a.cpu_average * a.ms as f64))
        });
        work
    }

    /// The busiest programs that were not the measuring chat's, by their average CPU, then the
    /// largest in memory.
    fn busiest(&self) -> Vec<(&Owner, &str, &Group)> {
        let samples = f64::from(self.samples.max(1));
        let mut groups: Vec<_> = self
            .groups
            .iter()
            .filter(|((_, name), _)| !name.is_empty())
            .map(|((owner, name), group)| (owner, name.as_str(), group))
            .collect();
        groups.sort_by(|a, b| b.2.cpu_sum.total_cmp(&a.2.cpu_sum));
        let mut shown: Vec<_> = groups
            .iter()
            .filter(|(_, _, g)| g.cpu_sum / samples >= 0.1)
            .take(5)
            .copied()
            .collect();
        groups.sort_by_key(|g| std::cmp::Reverse(g.2.memory_peak));
        for group in groups.into_iter().take(3) {
            if !shown.iter().any(|g| g.0 == group.0 && g.1 == group.1) {
                shown.push(group);
            }
        }
        shown
    }

    /// The report's lines on the computer, naming chats with `chat`.
    pub fn text(&self, chat: impl Fn(&str) -> String) -> Option<String> {
        if self.samples == 0 {
            return Some("The window closed before the computer could be measured.".into());
        }
        let samples = f64::from(self.samples);
        let mut text = format!(
            "CPU while it was open: {} on average, {} at most; this chat's processes{} {} on average; everything else {} on average, {} at most. Memory: at most {} of {} in use, at least {} free.",
            percent(self.cpu_sum / samples),
            percent(self.cpu_peak),
            if self.inside_wsl {
                " (WSL's virtual machine with them)"
            } else {
                ""
            },
            percent(self.holder_sum / samples),
            percent(self.others_sum / samples),
            percent(self.others_peak),
            bytes(self.used_peak),
            bytes(self.memory_total),
            bytes(self.available_min.unwrap_or_default()),
        );
        let busiest = self.busiest();
        if !busiest.is_empty() {
            text.push_str(" Other programs: ");
            text.push_str(
                &busiest
                    .iter()
                    .map(|(owner, name, group)| {
                        format!(
                            "{}{} ({}) {} CPU on average, {} at most, {}",
                            name,
                            count(group.pids.len()),
                            owner_text(owner, &chat),
                            percent(group.cpu_sum / samples),
                            percent(group.cpu_peak),
                            bytes(group.memory_peak)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            );
            text.push('.');
        }
        Some(text)
    }

    /// The same as numbers, for the history.
    pub fn record(&self) -> Value {
        let samples = f64::from(self.samples.max(1));
        json!({
            "samples": self.samples,
            "cpuAverage": round(self.cpu_sum / samples),
            "cpuPeak": round(self.cpu_peak),
            "holderAverage": round(self.holder_sum / samples),
            "insideWsl": self.inside_wsl,
            "othersAverage": round(self.others_sum / samples),
            "othersPeak": round(self.others_peak),
            "memoryTotal": self.memory_total,
            "memoryUsedPeak": self.used_peak,
            "memoryAvailableLeast": self.available_min,
            "programs": self.busiest().iter().map(|(owner, name, group)| json!({
                "name": name,
                "owner": owner_key(owner),
                "processes": group.pids.len(),
                "cpuAverage": round(group.cpu_sum / samples),
                "cpuPeak": round(group.cpu_peak),
                "memoryPeak": group.memory_peak,
            })).collect::<Vec<_>>(),
        })
    }
}

/// The computer over the last second, for a chat that asks.
pub struct Now {
    cpu: f64,
    memory_total: u64,
    memory_available: u64,
    /// Programs by owner: processes, CPU and memory.
    programs: Vec<(Owner, String, usize, f64, u64)>,
    /// What each chat left running, by conversation (`programs`).
    pub left: HashMap<String, Vec<super::programs::Program>>,
}

/// Reads the computer twice, a second apart.
pub async fn now(members: Members) -> Option<Now> {
    let first = tauri::async_runtime::spawn_blocking(read).await.ok()??;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let (second, windows) =
        tauri::async_runtime::spawn_blocking(|| (read(), super::programs::windows()))
            .await
            .ok()?;
    Some(now_from(
        &first,
        &second?,
        &members,
        std::process::id(),
        &windows,
    ))
}

fn now_from(
    first: &Reading,
    second: &Reading,
    members: &Members,
    app: u32,
    windows: &HashSet<u32>,
) -> Now {
    let owners = Owners::new(second, members, app);
    let cpu: HashMap<u32, f64> = usage(first, second)
        .map(|u| u.processes.into_iter().collect())
        .unwrap_or_default();
    let mut programs: HashMap<(Owner, String), (usize, f64, u64)> = HashMap::new();
    for process in second.processes.iter().filter(|p| !p.name.is_empty()) {
        let entry = programs
            .entry((owners.of(process.pid), process.name.clone()))
            .or_default();
        entry.0 += 1;
        entry.1 += cpu.get(&process.pid).copied().unwrap_or_default();
        entry.2 += process.memory;
    }
    Now {
        cpu: usage(first, second).map(|u| u.cpu).unwrap_or_default(),
        memory_total: second.memory_total,
        memory_available: second.memory_available,
        programs: programs
            .into_iter()
            .map(|((owner, name), (count, cpu, memory))| (owner, name, count, cpu, memory))
            .collect(),
        left: super::programs::left_running(second, members, Some(&cpu), windows),
    }
}

impl Now {
    /// The busiest and largest programs with their owners, naming chats with `chat`.
    pub fn text(&self, chat: impl Fn(&str) -> String) -> String {
        let mut programs: Vec<&(Owner, String, usize, f64, u64)> = self.programs.iter().collect();
        programs.sort_by(|a, b| b.3.total_cmp(&a.3));
        let mut shown: Vec<&(Owner, String, usize, f64, u64)> = programs
            .iter()
            .filter(|p| p.3 >= 0.5)
            .take(8)
            .copied()
            .collect();
        programs.sort_by_key(|p| std::cmp::Reverse(p.4));
        for program in programs.into_iter().take(6) {
            if !shown.iter().any(|p| p.0 == program.0 && p.1 == program.1) {
                shown.push(program);
            }
        }
        let mut text = format!(
            "The computer now: CPU {}, memory {} of {} in use.",
            percent(self.cpu),
            bytes(self.memory_total.saturating_sub(self.memory_available)),
            bytes(self.memory_total)
        );
        if !shown.is_empty() {
            text.push_str(" Its busiest and largest programs over the last second (\"yours\" are programs the user started, which only the user should close):");
            for (owner, name, processes, cpu, memory) in shown {
                text.push_str(&format!(
                    "\n- {}{} ({}): {} CPU, {}",
                    name,
                    count(*processes),
                    owner_text(owner, &chat),
                    percent(*cpu),
                    bytes(*memory)
                ));
            }
        }
        text
    }
}

pub(super) fn owner_text(owner: &Owner, chat: &impl Fn(&str) -> String) -> String {
    match owner {
        Owner::Chat(conversation) => chat(conversation),
        Owner::App => "Agent Studio".into(),
        Owner::System => "the system".into(),
        Owner::Wsl => "WSL".into(),
        Owner::Session(key) => session_name(key).into(),
        Owner::Yours => "yours".into(),
    }
}
pub(super) fn session_name(key: &str) -> &'static str {
    SESSIONS
        .iter()
        .find(|(k, _)| *k == key)
        .map_or("a session outside Agent Studio", |(_, name)| name)
}
pub(super) fn owner_key(owner: &Owner) -> Value {
    match owner {
        Owner::Chat(conversation) => json!({"chat": conversation}),
        Owner::App => json!("app"),
        Owner::System => json!("system"),
        Owner::Wsl => json!("wsl"),
        Owner::Session(key) => json!({"session": key}),
        Owner::Yours => json!("user"),
    }
}
fn count(processes: usize) -> String {
    if processes > 1 {
        format!(" ×{processes}")
    } else {
        String::new()
    }
}
pub(super) fn percent(value: f64) -> String {
    if value < 10.0 {
        format!("{value:.1}%")
    } else {
        format!("{value:.0}%")
    }
}
fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}
pub(super) fn bytes(value: u64) -> String {
    let gb = value as f64 / 1_073_741_824.0;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", value as f64 / 1_048_576.0)
    }
}

#[cfg(windows)]
mod platform {
    use super::{Process, Reading};
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn time(value: &FILETIME) -> u64 {
        (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
    }

    pub fn read() -> Option<Reading> {
        let at = Instant::now();
        unsafe {
            let (mut idle, mut kernel, mut user) = (
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
            );
            if GetSystemTimes(&mut idle, &mut kernel, &mut user) == 0 {
                return None;
            }
            // Kernel time includes the idle time.
            let total_ms = (time(&kernel) + time(&user)) / 10_000;
            let busy_ms = total_ms.saturating_sub(time(&idle) / 10_000);
            let mut memory: MEMORYSTATUSEX = std::mem::zeroed();
            memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut memory) == 0 {
                return None;
            }
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
                return None;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut processes = vec![];
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32ProcessID != 0 {
                        processes.push(process(&entry));
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
            Some(Reading {
                at,
                busy_ms,
                total_ms,
                memory_total: memory.ullTotalPhys,
                memory_available: memory.ullAvailPhys,
                commit_available: Some(memory.ullAvailPageFile),
                cores: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
                processes,
            })
        }
    }

    unsafe fn process(entry: &PROCESSENTRY32W) -> Process {
        let length = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let pid = entry.th32ProcessID;
        let mut process = Process {
            pid,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..length]),
            cpu_ms: 0,
            memory: 0,
            began: 0,
            system: true,
        };
        let mut session = 0u32;
        if ProcessIdToSessionId(pid, &mut session) != 0 {
            process.system = session == 0;
        }
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return process;
        }
        let (mut created, mut exited, mut kernel, mut user) = (
            std::mem::zeroed::<FILETIME>(),
            std::mem::zeroed::<FILETIME>(),
            std::mem::zeroed::<FILETIME>(),
            std::mem::zeroed::<FILETIME>(),
        );
        if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0 {
            process.began = time(&created);
            process.cpu_ms = (time(&kernel) + time(&user)) / 10_000;
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if K32GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
            process.memory = counters.WorkingSetSize as u64;
        }
        CloseHandle(handle);
        process
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{Process, Reading};
    use std::time::Instant;

    pub fn read() -> Option<Reading> {
        let at = Instant::now();
        let tick_ms = 1000.0 / (unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64);
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(1) as u64;
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let cpu: Vec<u64> = stat
            .lines()
            .next()?
            .split_whitespace()
            .skip(1)
            .filter_map(|v| v.parse().ok())
            .collect();
        let ticks: u64 = cpu.iter().take(8).sum();
        let idle =
            cpu.get(3).copied().unwrap_or_default() + cpu.get(4).copied().unwrap_or_default();
        let total_ms = (ticks as f64 * tick_ms) as u64;
        let busy_ms = (ticks.saturating_sub(idle) as f64 * tick_ms) as u64;
        let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
        let field = |name: &str| {
            meminfo
                .lines()
                .find(|l| l.starts_with(name))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024)
        };
        let mut processes = vec![];
        for entry in std::fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let (Some(open), Some(close)) = (text.find('('), text.rfind(')')) else {
                continue;
            };
            let name = text[open + 1..close].to_string();
            let rest: Vec<&str> = text[close + 1..].split_whitespace().collect();
            let number = |index: usize| {
                rest.get(index)
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or_default()
            };
            let parent = number(1) as u32;
            let rss = std::fs::read_to_string(entry.path().join("statm"))
                .ok()
                .and_then(|s| {
                    s.split_whitespace()
                        .nth(1)
                        .and_then(|v| v.parse::<u64>().ok())
                })
                .unwrap_or_default();
            processes.push(Process {
                pid,
                parent,
                name,
                cpu_ms: ((number(11) + number(12)) as f64 * tick_ms) as u64,
                memory: rss * page,
                began: number(19),
                // Kernel threads.
                system: pid == 2 || parent == 2,
            });
        }
        Some(Reading {
            at,
            busy_ms,
            total_ms,
            memory_total: field("MemTotal:")?,
            memory_available: field("MemAvailable:")?,
            commit_available: None,
            cores: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
            processes,
        })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    pub fn read() -> Option<super::Reading> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, name: &str, cpu_ms: u64, memory: u64, began: u64) -> Process {
        Process {
            pid,
            parent,
            name: name.into(),
            cpu_ms,
            memory,
            began,
            system: false,
        }
    }
    fn reading(at: Instant, busy_ms: u64, total_ms: u64, processes: Vec<Process>) -> Reading {
        Reading {
            at,
            busy_ms,
            total_ms,
            memory_total: 64 << 30,
            memory_available: 24 << 30,
            commit_available: None,
            cores: 4,
            processes,
        }
    }

    #[test]
    fn processes_belong_to_their_chat_this_app_the_system_or_the_user() {
        let mut system = process(7, 1, "svchost.exe", 0, 0, 5);
        system.system = true;
        let r = reading(
            Instant::now(),
            0,
            0,
            vec![
                process(1, 0, "explorer.exe", 0, 0, 1),
                process(10, 1, "agent-studio.exe", 0, 0, 10),
                process(11, 10, "claude.exe", 0, 0, 11),
                process(12, 11, "bash.exe", 0, 0, 12),
                process(13, 12, "UnrealEditor.exe", 0, 0, 13),
                process(14, 10, "msedgewebview2.exe", 0, 0, 14),
                process(20, 1, "chrome.exe", 0, 0, 20),
                // A parent id that a later process took: no longer its parent.
                process(30, 99, "orphan.exe", 0, 0, 30),
                process(99, 1, "late.exe", 0, 0, 40),
                system,
            ],
        );
        let members = Members {
            chats: HashMap::from([(11, "chat-a".to_string())]),
            roots: HashMap::new(),
            ..Default::default()
        };
        let owners = Owners::new(&r, &members, 10);
        assert_eq!(owners.of(13), Owner::Chat("chat-a".into()));
        assert_eq!(owners.of(11), Owner::Chat("chat-a".into()));
        assert_eq!(owners.of(14), Owner::App);
        assert_eq!(owners.of(20), Owner::Yours);
        assert_eq!(owners.of(30), Owner::Yours);
        assert_eq!(owners.of(7), Owner::System);
        assert_eq!(owners.of(404), Owner::Yours);
    }

    #[test]
    fn a_chat_s_work_is_what_its_job_ran_less_its_cli_and_what_it_left_running() {
        use super::super::jobs::JobTime;
        let start = Instant::now();
        let chat = |pairs: &[(u32, &str)]| -> HashMap<u32, String> {
            pairs.iter().map(|(pid, c)| (*pid, c.to_string())).collect()
        };
        let job = |pids: &[u32], cpu_ms: u64| JobTime {
            pids: pids.to_vec(),
            cpu_ms,
        };
        let before = reading(
            start,
            0,
            0,
            vec![
                // A chat's CLI, its command and an MCP server, and an editor a command left
                // running, whose parent is gone.
                process(11, 10, "claude.exe", 1_000, 0, 11),
                process(12, 11, "bash.exe", 0, 0, 12),
                process(13, 11, "node.exe", 100, 0, 13),
                process(20, 99, "UnrealEditor.exe", 5_000, 0, 20),
                // A Codex chat whose command sleeps.
                process(30, 10, "codex.exe", 400, 0, 30),
                process(31, 30, "python.exe", 10, 0, 31),
                // A CLI whose id a later process takes.
                process(40, 10, "claude.exe", 0, 0, 40),
            ],
        );
        let then = Members {
            chats: chat(&[
                (11, "a"),
                (12, "a"),
                (13, "a"),
                (20, "a"),
                (30, "b"),
                (31, "b"),
                (40, "c"),
            ]),
            roots: chat(&[(11, "a"), (30, "b"), (40, "c")]),
            jobs: HashMap::from([
                (11, job(&[11, 12, 13, 20], 10_000)),
                (30, job(&[30, 31], 410)),
                (40, job(&[40], 0)),
            ]),
        };
        let after = reading(
            start + Duration::from_secs(2),
            0,
            0,
            vec![
                process(11, 10, "claude.exe", 1_200, 0, 11),
                process(12, 11, "bash.exe", 300, 0, 12),
                process(13, 11, "node.exe", 100, 0, 13),
                process(20, 99, "UnrealEditor.exe", 6_000, 0, 20),
                process(30, 10, "codex.exe", 440, 0, 30),
                process(31, 30, "python.exe", 20, 0, 31),
                process(40, 10, "claude.exe", 0, 0, 41),
                process(50, 10, "claude.exe", 0, 0, 50),
            ],
        );
        let now = Members {
            chats: chat(&[
                (11, "a"),
                (12, "a"),
                (13, "a"),
                (20, "a"),
                (30, "b"),
                (31, "b"),
                (40, "c"),
                (50, "d"),
            ]),
            roots: chat(&[(11, "a"), (30, "b"), (40, "c"), (50, "d")]),
            jobs: HashMap::from([
                // 200 ms of the CLI, 300 of the command, 1,000 of the editor, and 500 of short
                // processes that began and ended between the readings.
                (11, job(&[11, 12, 13, 20], 12_000)),
                (30, job(&[30, 31], 460)),
                (40, job(&[40], 900)),
                (50, job(&[50], 900)),
            ]),
        };
        let work = work((&before, &then), (&after, &now));
        // The command and the short processes, 800 ms over two seconds.
        assert!((work["a"] - 0.4).abs() < 1e-9, "{work:?}");
        assert!(work["a"] >= IDLE_CORE);
        // 10 ms of a sleeping command over two seconds: idle.
        assert!((work["b"] - 0.005).abs() < 1e-9, "{work:?}");
        assert!(work["b"] < IDLE_CORE);
        // A CLI a later process replaced, and one the last reading did not see.
        assert_eq!(work.len(), 2, "{work:?}");
    }

    /// A chat whose command waits is idle, and one whose command starts short processes one after
    /// another is busy, though each of them ends between two readings.
    #[cfg(windows)]
    #[tokio::test]
    async fn real_jobs_tell_a_waiting_command_from_one_that_works() {
        let jobs = super::super::jobs::Jobs::default();
        let spawn = |command: &str| {
            tokio::process::Command::new("cmd.exe")
                .args(["/C", command])
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let mut waits = spawn("ping -n 12 127.0.0.1 >NUL");
        jobs.adopt("waits", &waits, None);
        let mut works =
            spawn("for /L %i in (1,1,60) do @powershell -NoProfile -NonInteractive -Command exit");
        jobs.adopt("works", &works, None);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let first = (read().unwrap(), jobs.members());
        tokio::time::sleep(Duration::from_secs(3)).await;
        let second = (read().unwrap(), jobs.members());
        let work = work((&first.0, &first.1), (&second.0, &second.1));
        crate::runner::kill_tree(&mut waits).await;
        crate::runner::kill_tree(&mut works).await;
        assert!(work["waits"] < IDLE_CORE, "{work:?}");
        assert!(work["works"] >= IDLE_CORE, "{work:?}");
    }

    #[test]
    fn a_window_reports_the_measuring_chat_apart_from_everything_else() {
        let start = Instant::now();
        let members = Members {
            chats: HashMap::from([(11, "bench".to_string()), (21, "other".to_string())]),
            roots: HashMap::new(),
            ..Default::default()
        };
        let mut window = Window::default();
        let first = reading(
            start,
            0,
            8_000,
            vec![
                process(11, 1, "Game.exe", 0, 8 << 30, 11),
                process(20, 1, "chrome.exe", 0, 1 << 30, 20),
                process(22, 1, "chrome.exe", 0, 1 << 30, 22),
            ],
        );
        // Two seconds on four cores: 8,000 ms of CPU time, 6,000 busy.
        let second = reading(
            start + Duration::from_secs(2),
            6_000,
            16_000,
            vec![
                process(11, 1, "Game.exe", 5_600, 8 << 30, 11),
                process(20, 1, "chrome.exe", 200, 1 << 30, 20),
                process(22, 1, "chrome.exe", 200, 1 << 30, 22),
                // Began between the readings: counts from the next one.
                process(30, 1, "MsMpEng.exe", 900, 0, 30),
            ],
        );
        for r in [first, second] {
            let owners = Owners::new(&r, &members, 10);
            window.add(r, &owners, "bench", false);
        }
        assert_eq!(window.samples, 1);
        assert!((window.cpu_sum - 75.0).abs() < 0.01);
        assert!((window.holder_sum - 70.0).abs() < 0.01);
        assert!((window.others_sum - 5.0).abs() < 0.01);
        let text = window.text(|c| format!("the chat {c}")).unwrap();
        assert!(text.contains("75% on average"), "{text}");
        assert!(
            text.contains("this chat's processes 70% on average"),
            "{text}"
        );
        assert!(
            text.contains("chrome.exe ×2 (yours) 5.0% CPU on average"),
            "{text}"
        );
        assert!(text.contains("at most 40.0 GB of 64.0 GB in use"), "{text}");
        assert!(!text.contains("Game.exe"), "{text}");
        let record = window.record();
        assert_eq!(record["cpuAverage"], 75.0);
        assert_eq!(record["programs"][0]["owner"], "user");
        assert_eq!(record["programs"][0]["processes"], 2);
    }

    #[test]
    fn wsl_s_machine_is_wsl_s_and_counts_for_a_measurement_made_inside_it() {
        let start = Instant::now();
        let members = Members {
            chats: HashMap::from([(11, "bench".to_string())]),
            roots: HashMap::from([(11, "bench".to_string())]),
            ..Default::default()
        };
        // WSL's machine runs as a system process; the chat's own process is its wsl.exe.
        let processes = |vm_ms, chrome_ms| {
            let mut vm = process(40, 4, "vmmemWSL", vm_ms, 6 << 30, 40);
            vm.system = true;
            vec![
                process(11, 1, "wsl.exe", 0, 1 << 20, 11),
                process(20, 1, "chrome.exe", chrome_ms, 1 << 30, 20),
                vm,
            ]
        };
        let first = reading(start, 0, 8_000, processes(0, 0));
        let second = reading(
            start + Duration::from_secs(2),
            5_600,
            16_000,
            processes(5_200, 400),
        );
        let owners = Owners::new(&second, &members, 10);
        assert_eq!(owners.of(40), Owner::Wsl);
        let measure = |inside_wsl| {
            let mut window = Window::default();
            for r in [first.clone(), second.clone()] {
                let owners = Owners::new(&r, &members, 10);
                window.add(r, &owners, "bench", inside_wsl);
            }
            window
        };
        // A measurement inside WSL: the machine is the measuring chat's.
        let inside = measure(true);
        assert!((inside.holder_sum - 65.0).abs() < 0.01);
        assert!((inside.others_sum - 5.0).abs() < 0.01);
        let text = inside.text(|c| format!("the chat {c}")).unwrap();
        assert!(
            text.contains("this chat's processes (WSL's virtual machine with them) 65% on average"),
            "{text}"
        );
        assert_eq!(inside.record()["insideWsl"], true);
        // A measurement on Windows: the machine is another program, WSL's.
        let outside = measure(false);
        assert!((outside.holder_sum - 0.0).abs() < 0.01);
        assert!((outside.others_sum - 70.0).abs() < 0.01);
        let text = outside.text(|c| format!("the chat {c}")).unwrap();
        assert!(text.contains("vmmemWSL (WSL) 65% CPU on average"), "{text}");
        assert_eq!(outside.record()["programs"][0]["owner"], "wsl");
    }

    #[test]
    fn sessions_outside_agent_studio_are_told_apart() {
        let r = reading(
            Instant::now(),
            0,
            0,
            vec![
                process(1, 0, "explorer.exe", 0, 0, 1),
                // The Claude app, its window, a Code session it runs and what that runs.
                process(10, 1, "Claude.exe", 0, 0, 10),
                process(11, 10, "Claude.exe", 0, 0, 11),
                process(12, 10, "claude.exe", 0, 0, 12),
                process(13, 12, "cargo.exe", 0, 0, 13),
                // Claude Code in a terminal.
                process(20, 1, "WindowsTerminal.exe", 0, 0, 20),
                process(21, 20, "pwsh.exe", 0, 0, 21),
                process(22, 21, "claude.exe", 0, 0, 22),
                process(23, 22, "node.exe", 0, 0, 23),
                // Codex, from the same terminal.
                process(30, 21, "codex.exe", 0, 0, 30),
                process(31, 30, "rg.exe", 0, 0, 31),
            ],
        );
        let members = Members {
            chats: HashMap::new(),
            roots: HashMap::new(),
            ..Default::default()
        };
        let owners = Owners::new(&r, &members, 999);
        assert_eq!(owners.of(11), Owner::Session("claude-app"));
        assert_eq!(owners.of(13), Owner::Session("claude-app"));
        assert_eq!(owners.of(23), Owner::Session("claude-cli"));
        assert_eq!(owners.of(31), Owner::Session("codex"));
        assert_eq!(owners.of(21), Owner::Yours);
        assert_eq!(
            owner_text(&Owner::Session("claude-cli"), &|c: &str| c.to_string()),
            "Claude Code outside Agent Studio"
        );
        assert_eq!(
            owner_key(&Owner::Session("codex")),
            json!({"session": "codex"})
        );
    }

    #[test]
    fn heavy_work_beside_a_measurement_is_whoever_s_ran_it() {
        // Four cores: heavy is a whole core, 25% of the computer, in two readings or more.
        let start = Instant::now();
        let members = Members {
            chats: HashMap::from([(11, "bench".to_string())]),
            roots: HashMap::new(),
            ..Default::default()
        };
        let processes = |game: u64, chrome: u64, defender: u64| {
            let mut scanner = process(30, 1, "MsMpEng.exe", defender, 1 << 28, 30);
            scanner.system = true;
            vec![
                process(11, 1, "Game.exe", game, 1 << 30, 11),
                process(20, 1, "chrome.exe", chrome, 1 << 30, 20),
                scanner,
            ]
        };
        let mut window = Window::default();
        for (second, game, chrome, defender) in [
            (0, 0, 0, 0),
            (2, 4_000, 2_400, 600),
            (4, 8_000, 4_800, 1_200),
            (6, 12_000, 5_000, 1_300),
        ] {
            let r = reading(
                start + Duration::from_secs(second),
                second * 2_000,
                second * 4_000,
                processes(game, chrome, defender),
            );
            let owners = Owners::new(&r, &members, 10);
            window.add(r, &owners, "bench", false);
        }
        // Chrome was heavy twice, Defender never, and the measuring game never counts.
        assert_eq!(
            window.beside(),
            [BesideWork {
                owner: Owner::Yours,
                name: "chrome.exe".into(),
                ms: 4_000,
                cpu_average: 30.0,
                cpu_peak: 30.0,
            }]
        );
        // One heavy reading alone is not enough.
        let mut brief = Window::default();
        for (second, chrome) in [(0, 0), (2, 2_400), (4, 2_500)] {
            let r = reading(
                start + Duration::from_secs(second),
                0,
                second * 4_000,
                processes(0, chrome, 0),
            );
            let owners = Owners::new(&r, &members, 10);
            brief.add(r, &owners, "bench", false);
        }
        assert!(brief.beside().is_empty());
    }

    #[test]
    fn a_window_too_short_to_measure_says_so() {
        assert_eq!(
            Window::default().text(|c| c.to_string()).unwrap(),
            "The window closed before the computer could be measured."
        );
    }

    #[test]
    fn now_lists_busy_and_large_programs_with_their_owners() {
        let start = Instant::now();
        let first = reading(
            start,
            0,
            4_000,
            vec![
                process(5, 1, "UnrealEditor.exe", 0, 14 << 30, 5),
                process(6, 1, "Code.exe", 0, 1 << 29, 6),
            ],
        );
        let second = reading(
            start + Duration::from_secs(1),
            1_000,
            8_000,
            vec![
                process(5, 1, "UnrealEditor.exe", 400, 14 << 30, 5),
                process(6, 1, "Code.exe", 0, 1 << 29, 6),
            ],
        );
        let members = Members {
            chats: HashMap::from([(5, "art".to_string())]),
            roots: HashMap::new(),
            ..Default::default()
        };
        let text = now_from(&first, &second, &members, 10, &HashSet::new())
            .text(|c| format!("the chat \"{c}\""));
        assert!(
            text.starts_with("The computer now: CPU 25%, memory 40.0 GB of 64.0 GB in use."),
            "{text}"
        );
        assert!(
            text.contains("- UnrealEditor.exe (the chat \"art\"): 10% CPU, 14.0 GB"),
            "{text}"
        );
        assert!(
            text.contains("- Code.exe (yours): 0.0% CPU, 512 MB"),
            "{text}"
        );
    }

    #[test]
    fn this_computer_can_be_read_where_it_runs() {
        if cfg!(any(windows, target_os = "linux")) {
            let reading = read().expect("a reading");
            assert!(reading.total_ms >= reading.busy_ms);
            assert!(reading.memory_total >= reading.memory_available);
            assert!(reading
                .processes
                .iter()
                .any(|p| p.pid == std::process::id()));
        }
    }
}
