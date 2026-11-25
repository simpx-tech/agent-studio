//! Processes that other chats' programs start while a measurement's window is open wait, frozen
//! at birth, until that reservation ends (docs/RESERVATIONS.md). A program a chat left running,
//! such as an editor compiling shaders or a server rebuilding after a change, starts work that no
//! command gate sees. On Windows each chat's job (`jobs`) tells of every process that begins in
//! it, and `Broker::born` decides whether it waits. A process that waits is suspended as a
//! debugger suspends one, before it can do much, and resumed when the reservation ends, before
//! its program is stopped, and when the app quits. Those suspended are kept in `frozen.json`
//! beside the history, so that a start after a crash resumes them. Elsewhere nothing is held.
use std::path::Path;

/// A process held: suspended until this is dropped.
pub struct Held {
    pub pid: u32,
    /// When it began, which tells it from a later process that takes its id.
    pub began: u64,
    pub name: String,
    #[cfg(windows)]
    handle: platform::Handle,
}

/// Lets it run again.
impl Drop for Held {
    fn drop(&mut self) {
        #[cfg(windows)]
        platform::resume(&self.handle);
    }
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.name, self.pid)
    }
}

/// Suspends the process `pid`. None when it cannot be, such as one that already ended.
pub fn suspend(pid: u32) -> Option<Held> {
    #[cfg(windows)]
    {
        let handle = platform::open(pid)?;
        let began = platform::began(&handle)?;
        if !platform::suspend(&handle) {
            return None;
        }
        Some(Held {
            pid,
            began,
            name: platform::name(&handle),
            handle,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// The processes `pid` descends from, its parent first, each with when it began: each began
/// before the one it started, so that an id a later process took is no parent.
pub fn ancestry(pid: u32) -> Vec<(u32, u64)> {
    #[cfg(windows)]
    {
        let parents = platform::parents();
        let mut chain: Vec<(u32, u64)> = vec![];
        let (mut current, mut began) = (pid, platform::began_of(pid).unwrap_or(u64::MAX));
        for _ in 0..256 {
            let Some(&parent) = parents.get(&current) else {
                break;
            };
            if parent == 0 || parent == pid || chain.iter().any(|(p, _)| *p == parent) {
                break;
            }
            match platform::began_of(parent) {
                Some(parent_began) if parent_began <= began => {
                    chain.push((parent, parent_began));
                    (current, began) = (parent, parent_began);
                }
                _ => break,
            }
        }
        chain
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        vec![]
    }
}

/// When a process began, as `Held::began` and `ancestry` read it, in milliseconds since 1970.
pub fn epoch_ms(began: u64) -> u64 {
    // Windows counts 100 ns intervals from 1601.
    (began / 10_000).saturating_sub(11_644_473_600_000)
}

/// Processes others need to go on (consoles, WSL, error reporting, this app's own gate) or that
/// do light work (Git, ripgrep), which never wait.
pub fn plumbing(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let own = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
        })
        .is_some_and(|own| own == name);
    own || matches!(
        name.as_str(),
        "conhost.exe"
            | "openconsole.exe"
            | "wsl.exe"
            | "wslhost.exe"
            | "wslrelay.exe"
            | "werfault.exe"
            | "werfaultsecure.exe"
            | "git.exe"
            | "rg.exe"
    )
}

/// Keeps which processes wait, so that a start after a crash resumes them; nothing waiting
/// removes the file.
pub fn save(path: &Path, held: &[(u32, u64)]) {
    if held.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Some(folder) = path.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let text = serde_json::to_string(held).unwrap_or_default();
    let partial = path.with_extension("json.partial");
    if std::fs::write(&partial, text).is_ok() {
        let _ = std::fs::rename(&partial, path);
    }
}

/// Resumes the processes `path` lists, which a run of the app that ended without resuming them
/// held, and forgets them.
pub fn resume_saved(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let held: Vec<(u32, u64)> = serde_json::from_str(&text).unwrap_or_default();
    #[cfg(windows)]
    for (pid, began) in held {
        if let Some(handle) = platform::open(pid) {
            if platform::began(&handle) == Some(began) {
                platform::resume(&handle);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = held;
    let _ = std::fs::remove_file(path);
}

#[cfg(windows)]
mod platform {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME,
    };

    // What Task Manager's and Process Explorer's Suspend call: every thread of the process,
    // counted, so that one resume undoes one suspension.
    #[link(name = "ntdll", kind = "raw-dylib")]
    extern "system" {
        fn NtSuspendProcess(process: HANDLE) -> i32;
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    pub struct Handle(HANDLE);
    // A kernel handle is valid from any thread.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn open(pid: u32) -> Option<Handle> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        (!handle.is_null()).then_some(Handle(handle))
    }

    pub fn suspend(handle: &Handle) -> bool {
        unsafe { NtSuspendProcess(handle.0) >= 0 }
    }

    pub fn resume(handle: &Handle) -> bool {
        unsafe { NtResumeProcess(handle.0) >= 0 }
    }

    fn time(value: &FILETIME) -> u64 {
        (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
    }

    /// When the process began, as `machine::read` reads it.
    pub fn began(handle: &Handle) -> Option<u64> {
        unsafe {
            let (mut created, mut exited, mut kernel, mut user) = (
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
                std::mem::zeroed::<FILETIME>(),
            );
            (GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) != 0)
                .then(|| time(&created))
        }
    }

    pub fn began_of(pid: u32) -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let handle = Handle(handle);
        began(&handle)
    }

    /// The name of the program file it runs, as the computer's readings name processes.
    pub fn name(handle: &Handle) -> String {
        let mut buffer = vec![0u16; 1024];
        let mut length = buffer.len() as u32;
        let read = unsafe {
            QueryFullProcessImageNameW(
                handle.0,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            )
        };
        if read == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or_default()
            .to_string()
    }

    /// Every process's parent, by process id.
    pub fn parents() -> HashMap<u32, u32> {
        let mut parents = HashMap::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
                return parents;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        parents
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};

    fn ping(seconds: u32) -> std::process::Child {
        std::process::Command::new("ping.exe")
            .args(["-n", &(seconds + 1).to_string(), "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap()
    }

    fn ended_within(child: &mut std::process::Child, time: Duration) -> bool {
        let until = Instant::now() + time;
        while Instant::now() < until {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn a_held_process_waits_until_it_is_resumed() {
        let mut child = ping(1);
        let held = suspend(child.id()).unwrap();
        assert_eq!(held.name.to_ascii_lowercase(), "ping.exe");
        let parents = ancestry(child.id());
        assert_eq!(parents[0].0, std::process::id());
        // It began moments ago.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(now.abs_diff(epoch_ms(held.began)) < 5_000);
        // A second's ping, held for three.
        assert!(!ended_within(&mut child, Duration::from_secs(3)));
        drop(held);
        assert!(ended_within(&mut child, Duration::from_secs(10)));
    }

    #[test]
    fn a_start_after_a_crash_resumes_what_the_run_before_held() {
        let folder = std::env::temp_dir().join(format!("agent-studio-hold-{}", std::process::id()));
        let path = folder.join("frozen.json");
        let mut child = ping(1);
        let held = suspend(child.id()).unwrap();
        save(&path, &[(held.pid, held.began), (4_000_000, 1)]);
        // The app ended without resuming it.
        std::mem::forget(held);
        assert!(!ended_within(&mut child, Duration::from_secs(3)));
        resume_saved(&path);
        assert!(ended_within(&mut child, Duration::from_secs(10)));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn consoles_wsl_and_light_tools_never_wait() {
        assert!(plumbing("conhost.exe"));
        assert!(plumbing("Git.exe"));
        assert!(plumbing("wslhost.exe"));
        assert!(!plumbing("ShaderCompileWorker.exe"));
        assert!(!plumbing("cargo.exe"));
    }
}
