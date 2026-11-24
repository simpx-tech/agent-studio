//! Programs chats left running on this computer (docs/RESERVATIONS.md): processes in a chat's job
//! (`jobs`) outside its CLI's own process tree, such as an editor, a game or a server a command
//! started and let go. Each program is the topmost such process with the processes it started.
//! A chat may stop its own before a measurement, any chat those of a chat that is not replying
//! (`pc_stop`), and a chat that hands over to a measurement has its own closed
//! (`Broker::hand_over`). A program with a window is asked to close as its close button asks, so
//! it may still ask about unsaved work; one without a window is ended. Windows only: elsewhere a
//! process outlives the CLI that started it without saying whose it was.
use super::jobs::Members;
use super::machine::{Process, Reading};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

/// How often a program asked to close is looked at.
const POLL: Duration = Duration::from_millis(500);
/// A program asked to close that works this little over this long is waiting for something,
/// such as an answer about unsaved work: 2% of one core over fifteen seconds.
const IDLE: Duration = Duration::from_secs(15);
const IDLE_CPU_MS: u64 = 300;
/// A program asked to close that still works after this long is left to finish by itself.
const CLOSING: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    /// Its topmost process, whose id names it.
    pub pid: u32,
    pub name: String,
    /// Its processes, each with when it began, which tells it from a later process that takes
    /// its id.
    pub processes: Vec<(u32, u64)>,
    pub memory: u64,
    /// Its share of the whole computer over the last second, when measured.
    pub cpu: Option<f64>,
    /// Whether one of its processes shows a window.
    pub window: bool,
}

/// The programs each chat left running, by conversation, largest first. `cpu` is each process's
/// share of the computer over the last second, and `windows` the processes that show a window.
pub fn left_running(
    reading: &Reading,
    members: &Members,
    cpu: Option<&HashMap<u32, f64>>,
    windows: &HashSet<u32>,
) -> HashMap<String, Vec<Program>> {
    let index: HashMap<u32, &Process> = reading.processes.iter().map(|p| (p.pid, p)).collect();
    // A process's parent, unless its id now belongs to a process that began after it.
    let parent = |p: &Process| {
        index
            .get(&p.parent)
            .copied()
            .filter(|q| q.pid != p.pid && q.began <= p.began)
    };
    let mut left: HashMap<u32, &str> = HashMap::new();
    for process in &reading.processes {
        let Some(chat) = members.chats.get(&process.pid) else {
            continue;
        };
        // Its CLI's when a chain of parents within the chat's job reaches the CLI.
        let mut current = process;
        let mut cli = false;
        for _ in 0..256 {
            if members.roots.get(&current.pid) == Some(chat) {
                cli = true;
                break;
            }
            match parent(current) {
                Some(next) if members.chats.get(&next.pid) == Some(chat) => current = next,
                _ => break,
            }
        }
        if !cli {
            left.insert(process.pid, chat);
        }
    }
    let mut programs: HashMap<(&str, u32), Program> = HashMap::new();
    for (&pid, &chat) in &left {
        let process = index[&pid];
        let mut top = process;
        for _ in 0..256 {
            match parent(top) {
                Some(next) if left.get(&next.pid) == Some(&chat) => top = next,
                _ => break,
            }
        }
        let program = programs.entry((chat, top.pid)).or_insert_with(|| Program {
            pid: top.pid,
            name: top.name.clone(),
            processes: vec![],
            memory: 0,
            cpu: cpu.map(|_| 0.0),
            window: false,
        });
        program.processes.push((pid, process.began));
        program.memory += process.memory;
        if let (Some(total), Some(cpu)) = (program.cpu.as_mut(), cpu) {
            *total += cpu.get(&pid).copied().unwrap_or_default();
        }
        program.window |= windows.contains(&pid);
    }
    let mut by_chat: HashMap<String, Vec<Program>> = HashMap::new();
    for ((chat, _), mut program) in programs {
        program.processes.sort_unstable();
        by_chat.entry(chat.to_string()).or_default().push(program);
    }
    for list in by_chat.values_mut() {
        list.sort_by(|a, b| b.memory.cmp(&a.memory).then(a.pid.cmp(&b.pid)));
    }
    by_chat
}

/// The processes that show a window now.
pub fn windows() -> HashSet<u32> {
    platform::windows()
}

/// The programs each chat left running now, from one reading of the computer.
pub async fn now(members: Members) -> HashMap<String, Vec<Program>> {
    tauri::async_runtime::spawn_blocking(move || {
        super::machine::read()
            .map(|reading| left_running(&reading, &members, None, &windows()))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// What became of a program asked to stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Its windows closed when asked, and it ended.
    Closed,
    /// It had no window and was ended.
    Ended,
    /// It was asked to close and still runs without working: it may be asking about unsaved work.
    Asking,
    /// It was asked to close and still worked on it when it was left to finish.
    Closing,
    /// It could not be ended.
    Failed,
    /// It had already ended.
    Gone,
}

#[derive(Clone, Debug)]
pub struct Stopped {
    pub program: Program,
    pub outcome: Outcome,
}

impl Stopped {
    /// What became of it, for text.
    pub fn text(&self) -> String {
        let name = &self.program.name;
        match self.outcome {
            Outcome::Closed => format!("{name} closed"),
            Outcome::Ended => format!("{name} ended"),
            Outcome::Asking => format!(
                "{name} was asked to close and is still open, waiting: it may be asking about unsaved work, so ask the user"
            ),
            Outcome::Closing => format!(
                "{name} was asked to close and was still closing after {}",
                super::duration(CLOSING)
            ),
            Outcome::Failed => format!("{name} could not be ended"),
            Outcome::Gone => format!("{name} had already ended"),
        }
    }
    pub fn key(&self) -> &'static str {
        match self.outcome {
            Outcome::Closed => "closed",
            Outcome::Ended => "ended",
            Outcome::Asking => "asking",
            Outcome::Closing => "closing",
            Outcome::Failed => "failed",
            Outcome::Gone => "gone",
        }
    }
}

/// Stops programs: those with a window are asked to close, as their close button asks, and
/// waited for while they work on it; the others are ended. What each program left without a
/// window ends once its windows closed.
pub async fn stop(programs: Vec<Program>) -> Vec<Stopped> {
    let blocking = |f: Box<dyn FnOnce() -> Outcome + Send>| async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .unwrap_or(Outcome::Failed)
    };
    let mut stopped = vec![];
    let mut closing = vec![];
    for program in programs {
        let processes = program.processes.clone();
        let asked = blocking(Box::new(move || {
            let alive = platform::alive(&processes);
            if alive.is_empty() {
                return Outcome::Gone;
            }
            if platform::close_windows(&alive) > 0 {
                // Waited for below.
                return Outcome::Closing;
            }
            if platform::end(&alive) {
                Outcome::Ended
            } else {
                Outcome::Failed
            }
        }))
        .await;
        if asked == Outcome::Closing {
            closing.push(Closing {
                program,
                asked: Instant::now(),
                samples: VecDeque::new(),
            });
        } else {
            stopped.push(Stopped {
                program,
                outcome: asked,
            });
        }
    }
    while !closing.is_empty() {
        tokio::time::sleep(POLL).await;
        let mut still = vec![];
        for mut entry in closing {
            let processes = entry.program.processes.clone();
            let (alive, windowed, cpu) = tauri::async_runtime::spawn_blocking(move || {
                let alive = platform::alive(&processes);
                let windowed = platform::with_windows(&alive);
                let cpu = platform::cpu_ms(&alive);
                (alive, windowed, cpu)
            })
            .await
            .unwrap_or_default();
            let now = Instant::now();
            let outcome = if alive.is_empty() {
                Some(Outcome::Closed)
            } else if windowed.is_empty() {
                // Its windows closed: what it leaves running without one ends with it.
                let ended = tauri::async_runtime::spawn_blocking(move || platform::end(&alive))
                    .await
                    .unwrap_or(false);
                Some(if ended {
                    Outcome::Closed
                } else {
                    Outcome::Failed
                })
            } else {
                entry.verdict(now, cpu)
            };
            match outcome {
                Some(outcome) => stopped.push(Stopped {
                    program: entry.program,
                    outcome,
                }),
                None => still.push(entry),
            }
        }
        closing = still;
    }
    stopped
}

struct Closing {
    program: Program,
    asked: Instant,
    /// Its CPU time in milliseconds, read every half second over the last fifteen.
    samples: VecDeque<(Instant, u64)>,
}

impl Closing {
    /// What became of a program asked to close that still shows a window, having used `cpu`
    /// milliseconds of CPU time by `now`: None while it works on closing.
    fn verdict(&mut self, now: Instant, cpu: u64) -> Option<Outcome> {
        self.samples.push_back((now, cpu));
        while self
            .samples
            .front()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) > IDLE)
        {
            self.samples.pop_front();
        }
        let idle = now.saturating_duration_since(self.asked) >= IDLE
            && self.samples.front().is_some_and(|(at, first)| {
                now.saturating_duration_since(*at) >= IDLE - POLL * 2
                    && cpu.saturating_sub(*first) < IDLE_CPU_MS
            });
        if idle {
            Some(Outcome::Asking)
        } else if now.saturating_duration_since(self.asked) >= CLOSING {
            Some(Outcome::Closing)
        } else {
            None
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::collections::HashSet;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HANDLE, HWND, LPARAM, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, GW_OWNER,
        WM_CLOSE,
    };

    fn time(value: &FILETIME) -> u64 {
        (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
    }

    /// A process opened with `access`, when it is still the one that began at `began`.
    struct Opened(HANDLE);
    impl Drop for Opened {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn open(pid: u32, began: u64, access: u32) -> Option<(Opened, u64)> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | access, 0, pid);
            if handle.is_null() {
                return None;
            }
            let handle = Opened(handle);
            let (mut created, mut exited, mut kernel, mut user) = (
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
            );
            if GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) == 0
                || time(&created) != began
            {
                return None;
            }
            Some((handle, (time(&kernel) + time(&user)) / 10_000))
        }
    }

    /// Those of `processes` still running.
    pub fn alive(processes: &[(u32, u64)]) -> Vec<(u32, u64)> {
        processes
            .iter()
            .copied()
            .filter(|(pid, began)| {
                open(*pid, *began, PROCESS_SYNCHRONIZE).is_some_and(
                    |(handle, _)| unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0,
                )
            })
            .collect()
    }

    /// The CPU time `processes` used, in milliseconds.
    pub fn cpu_ms(processes: &[(u32, u64)]) -> u64 {
        processes
            .iter()
            .filter_map(|(pid, began)| open(*pid, *began, 0).map(|(_, cpu)| cpu))
            .sum()
    }

    /// The top-level windows shown now, with the processes that own them.
    fn shown() -> Vec<(HWND, u32)> {
        unsafe extern "system" fn each(window: HWND, found: LPARAM) -> BOOL {
            let found = &mut *(found as *mut Vec<(HWND, u32)>);
            // A window another shown window owns, such as a dialog, closes with its owner.
            let owner = GetWindow(window, GW_OWNER);
            if IsWindowVisible(window) != 0 && (owner.is_null() || IsWindowVisible(owner) == 0) {
                let mut pid = 0u32;
                GetWindowThreadProcessId(window, &mut pid);
                if pid != 0 {
                    found.push((window, pid));
                }
            }
            1
        }
        let mut found: Vec<(HWND, u32)> = vec![];
        unsafe {
            EnumWindows(Some(each), &mut found as *mut _ as LPARAM);
        }
        found
    }

    pub fn windows() -> HashSet<u32> {
        shown().into_iter().map(|(_, pid)| pid).collect()
    }

    /// Those of `processes` that show a window.
    pub fn with_windows(processes: &[(u32, u64)]) -> Vec<(u32, u64)> {
        let shown = windows();
        processes
            .iter()
            .copied()
            .filter(|(pid, _)| shown.contains(pid))
            .collect()
    }

    /// Asks the windows of `processes` to close, as their close button does. Returns how many.
    pub fn close_windows(processes: &[(u32, u64)]) -> usize {
        let pids: HashSet<u32> = processes.iter().map(|(pid, _)| *pid).collect();
        shown()
            .into_iter()
            .filter(|(_, pid)| pids.contains(pid))
            .filter(|(window, _)| unsafe { PostMessageW(*window, WM_CLOSE, 0, 0) } != 0)
            .count()
    }

    /// Ends `processes`. Returns whether all of them ended.
    pub fn end(processes: &[(u32, u64)]) -> bool {
        let mut ended = true;
        for (pid, began) in processes {
            // One that cannot be opened as itself is gone already, or another took its id.
            if let Some((handle, _)) = open(*pid, *began, PROCESS_TERMINATE | PROCESS_SYNCHRONIZE) {
                unsafe {
                    if WaitForSingleObject(handle.0, 0) != WAIT_OBJECT_0
                        && (TerminateProcess(handle.0, 1) == 0
                            || WaitForSingleObject(handle.0, 5_000) != WAIT_OBJECT_0)
                    {
                        ended = false;
                    }
                }
            }
        }
        ended
    }
}

#[cfg(not(windows))]
mod platform {
    use std::collections::HashSet;
    pub fn alive(_: &[(u32, u64)]) -> Vec<(u32, u64)> {
        vec![]
    }
    pub fn cpu_ms(_: &[(u32, u64)]) -> u64 {
        0
    }
    pub fn windows() -> HashSet<u32> {
        HashSet::new()
    }
    pub fn with_windows(_: &[(u32, u64)]) -> Vec<(u32, u64)> {
        vec![]
    }
    pub fn close_windows(_: &[(u32, u64)]) -> usize {
        0
    }
    pub fn end(_: &[(u32, u64)]) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, name: &str, memory: u64, began: u64) -> Process {
        Process {
            pid,
            parent,
            name: name.into(),
            cpu_ms: 0,
            memory,
            began,
            system: false,
        }
    }

    #[test]
    fn what_a_chat_left_running_is_outside_its_cli_and_grouped_under_its_top() {
        let reading = Reading {
            at: Instant::now(),
            busy_ms: 0,
            total_ms: 0,
            memory_total: 64 << 30,
            memory_available: 32 << 30,
            cores: 8,
            processes: vec![
                process(10, 1, "agent-studio.exe", 0, 10),
                // The chat's CLI, a command it runs and an MCP server it keeps.
                process(11, 10, "claude.exe", 1 << 28, 11),
                process(12, 11, "bash.exe", 1 << 20, 12),
                process(13, 11, "node.exe", 1 << 26, 13),
                // An editor a command started and let go: its parent is gone.
                process(20, 99, "UnrealEditor.exe", 14 << 30, 20),
                process(21, 20, "ShaderCompileWorker.exe", 1 << 29, 21),
                // A server whose parent id another, later process took.
                process(30, 40, "node.exe", 1 << 28, 30),
                process(40, 1, "chrome.exe", 1 << 28, 40),
                // Another chat's CLI ended, leaving a game.
                process(50, 77, "Game.exe", 2 << 30, 50),
                // The user's own.
                process(60, 1, "Code.exe", 1 << 29, 60),
            ],
        };
        let members = Members {
            chats: HashMap::from([
                (11, "a".to_string()),
                (12, "a".to_string()),
                (13, "a".to_string()),
                (20, "a".to_string()),
                (21, "a".to_string()),
                (30, "a".to_string()),
                (50, "b".to_string()),
            ]),
            roots: HashMap::from([(11, "a".to_string()), (77, "b".to_string())]),
        };
        let cpu = HashMap::from([(20, 3.0), (21, 1.5), (30, 0.2)]);
        let left = left_running(&reading, &members, Some(&cpu), &HashSet::from([20, 60]));
        let a = &left["a"];
        assert_eq!(a.len(), 2, "{a:?}");
        assert_eq!(a[0].name, "UnrealEditor.exe");
        assert_eq!(a[0].pid, 20);
        assert_eq!(a[0].processes, vec![(20, 20), (21, 21)]);
        assert_eq!(a[0].memory, (14 << 30) + (1 << 29));
        assert_eq!(a[0].cpu, Some(4.5));
        assert!(a[0].window);
        assert_eq!(a[1].name, "node.exe");
        assert_eq!(a[1].pid, 30);
        assert!(!a[1].window);
        assert_eq!(left["b"][0].name, "Game.exe");
        assert_eq!(left.len(), 2);
        // Without a reading of the CPU, none is claimed.
        let left = left_running(&reading, &members, None, &HashSet::new());
        assert_eq!(left["a"][0].cpu, None);
    }

    #[test]
    fn a_program_asked_to_close_is_waited_for_while_it_works_on_it() {
        let asked = Instant::now();
        let at = |seconds: f64| asked + Duration::from_secs_f64(seconds);
        let program = Program {
            pid: 1,
            name: "UnrealEditor.exe".into(),
            processes: vec![(1, 1)],
            memory: 0,
            cpu: None,
            window: true,
        };
        let closing = || Closing {
            program: program.clone(),
            asked,
            samples: VecDeque::new(),
        };
        // Saving and shutting down uses the CPU: it is waited for.
        let mut busy = closing();
        let mut cpu = 0;
        for tick in 1..=60 {
            cpu += 400;
            assert_eq!(busy.verdict(at(tick as f64 * 0.5), cpu), None, "{tick}");
        }
        // A program that waits on a question uses next to none.
        let mut asking = closing();
        let mut verdict = None;
        for tick in 1..=40 {
            verdict = asking.verdict(at(tick as f64 * 0.5), 10_000 + tick * 5);
            if verdict.is_some() {
                assert!(tick >= 30, "{tick}");
                break;
            }
        }
        assert_eq!(verdict, Some(Outcome::Asking));
        // One that works on and on is left to finish.
        let mut long = closing();
        let mut cpu = 0;
        let mut verdict = None;
        for tick in 1..=300 {
            cpu += 400;
            verdict = long.verdict(at(tick as f64 * 0.5), cpu);
            if verdict.is_some() {
                assert_eq!(tick, 240);
                break;
            }
        }
        assert_eq!(verdict, Some(Outcome::Closing));
    }

    /// A window of its own: a small form, out of sight, that closes when asked.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_program_with_a_window_is_asked_to_close_and_closes() {
        use std::os::windows::process::CommandExt;
        let script = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(-3000, -3000); $f.Text = 'agent-studio-test'; [System.Windows.Forms.Application]::Run($f)";
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdout(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut shown = false;
        for _ in 0..150 {
            if windows().contains(&pid) {
                shown = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(shown, "the form never showed");
        let began = super::super::machine::read()
            .unwrap()
            .processes
            .iter()
            .find(|p| p.pid == pid)
            .unwrap()
            .began;
        let stopped = stop(vec![Program {
            pid,
            name: "powershell.exe".into(),
            processes: vec![(pid, began)],
            memory: 0,
            cpu: None,
            window: true,
        }])
        .await;
        assert_eq!(stopped[0].outcome, Outcome::Closed);
        assert_eq!(stopped[0].text(), "powershell.exe closed");
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_program_without_a_window_is_ended_and_one_already_gone_is_said_so() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let pid = child.id();
        let reading = super::super::machine::read().unwrap();
        let began = reading
            .processes
            .iter()
            .find(|p| p.pid == pid)
            .unwrap()
            .began;
        let program = Program {
            pid,
            name: "PING.EXE".into(),
            processes: vec![(pid, began)],
            memory: 0,
            cpu: None,
            window: false,
        };
        let stopped = stop(vec![program.clone()]).await;
        assert_eq!(stopped[0].outcome, Outcome::Ended);
        assert!(platform::alive(&[(pid, began)]).is_empty());
        let _ = child.wait();
        let again = stop(vec![program]).await;
        assert_eq!(again[0].outcome, Outcome::Gone);
        assert_eq!(again[0].text(), "PING.EXE had already ended");
    }
}
