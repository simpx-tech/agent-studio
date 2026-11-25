//! Which chat a process belongs to. On Windows each chat's CLI runs in a job object of its own,
//! which every process it starts joins, an editor it leaves open included, so a reservation can
//! tell a chat's processes from the user's and from Windows' own however they were started. Jobs
//! limit nothing: they let a process break away when it asks, never end their processes, and go
//! once none of their processes runs. Elsewhere, and for a process that broke away, a chat's
//! processes are those its CLI started (`machine::Owners`).
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// The chats' processes, by process id.
#[derive(Clone, Debug, Default)]
pub struct Members {
    /// Processes in a chat's job.
    pub chats: HashMap<u32, String>,
    /// Each chat CLI's own process, whose descendants belong to its chat.
    pub roots: HashMap<u32, String>,
    /// What each chat's job ran, by its CLI's process (Windows).
    pub jobs: HashMap<u32, JobTime>,
}

/// What a chat's job ran: its processes now, and the CPU time of every process it ever held,
/// those that already ended included, so that a command's short processes, which begin and end
/// between two readings of the computer, still count (`machine::work`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobTime {
    pub pids: Vec<u32>,
    /// In milliseconds, since the job began.
    pub cpu_ms: u64,
}

#[derive(Default)]
pub struct Jobs {
    jobs: Mutex<Vec<Job>>,
    /// Tells of each process that begins in a chat's job (`watch`).
    #[cfg(windows)]
    port: std::sync::OnceLock<windows::Port>,
    keys: AtomicUsize,
}

/// A chat CLI launched inside a WSL distribution this computer manages, by the `wsl.exe` in the
/// chat's job: its processes there carry its launch's job in their environment
/// (`AGENT_STUDIO_JOB`, wsl-launch.sh), and end with the launch.
#[derive(Clone, Debug, PartialEq)]
pub struct WslJob {
    pub conversation: String,
    pub distribution: String,
    pub namespace: String,
    pub job: String,
}
struct Job {
    /// Names the job in what its port tells.
    key: usize,
    conversation: String,
    pid: u32,
    #[cfg(windows)]
    job: windows::Handle,
    /// The launch inside WSL this job's `wsl.exe` runs.
    wsl: Option<WslJob>,
}

impl Jobs {
    /// Tells `births` of each process that begins in a chat's job from now on, with its job's
    /// key (`job`) and its process id (`hold`). Windows only.
    pub fn watch(&self, births: impl Fn(usize, u32) + Send + 'static) {
        #[cfg(windows)]
        if let Some(port) = windows::Port::new(births) {
            let _ = self.port.set(port);
        }
        #[cfg(not(windows))]
        let _ = births;
    }

    /// The chat the job `key` belongs to, and its CLI's process.
    pub fn job(&self, key: usize) -> Option<(String, u32)> {
        let jobs = self.jobs.lock().ok()?;
        let job = jobs.iter().find(|job| job.key == key)?;
        Some((job.conversation.clone(), job.pid))
    }

    /// A chat's CLI started: what it runs belongs to the chat, inside WSL too when `wsl` names
    /// the launch the CLI's `wsl.exe` runs there.
    pub fn adopt(
        &self,
        conversation: &str,
        child: &tokio::process::Child,
        wsl: Option<&crate::wsl::Launch>,
    ) {
        let Some(pid) = child.id() else { return };
        let key = self.keys.fetch_add(1, Ordering::Relaxed) + 1;
        // Without a job, Windows reuses a process id soon enough to mistake another program's
        // processes for the chat's: a CLI whose job could not be made is left unfollowed.
        #[cfg(windows)]
        let Some(job) = child
            .raw_handle()
            .and_then(|process| windows::job_for(process, self.port.get(), key))
        else {
            return;
        };
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.push(Job {
                key,
                conversation: conversation.into(),
                pid,
                #[cfg(windows)]
                job,
                wsl: wsl.map(|launch| WslJob {
                    conversation: conversation.into(),
                    distribution: launch.distribution.clone(),
                    namespace: launch.namespace.clone(),
                    job: launch.job.clone(),
                }),
            });
        }
    }

    /// The chats' processes now. A chat whose CLI ended and left nothing running goes.
    pub fn members(&self) -> Members {
        let mut members = Members::default();
        self.live(|job, pids| {
            for pid in pids {
                members.chats.insert(*pid, job.conversation.clone());
            }
            members.roots.insert(job.pid, job.conversation.clone());
            #[cfg(windows)]
            if let Some(cpu_ms) = windows::cpu_ms(&job.job) {
                members.jobs.insert(
                    job.pid,
                    JobTime {
                        pids: pids.to_vec(),
                        cpu_ms,
                    },
                );
            }
        });
        members
    }

    /// The chats' launches inside WSL distributions whose `wsl.exe` still runs.
    pub fn wsl(&self) -> Vec<WslJob> {
        let mut launches = vec![];
        self.live(|job, _| launches.extend(job.wsl.clone()));
        launches
    }

    /// Calls `each` with every job that still holds a process and the processes it holds, and
    /// forgets the others.
    fn live(&self, mut each: impl FnMut(&Job, &[u32])) {
        let Ok(mut jobs) = self.jobs.lock() else {
            return;
        };
        jobs.retain(|job| {
            #[cfg(windows)]
            let Some(pids) = windows::pids(&job.job).filter(|pids| !pids.is_empty()) else {
                return false;
            };
            #[cfg(not(windows))]
            let pids: Vec<u32> = vec![];
            #[cfg(unix)]
            if !std::path::Path::new(&format!("/proc/{}", job.pid)).exists() {
                return false;
            }
            each(job, &pids);
            true
        });
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::io::RawHandle;
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
        JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::IO::{
        CreateIoCompletionPort, GetQueuedCompletionStatus, PostQueuedCompletionStatus,
    };

    /// JOB_OBJECT_MSG_NEW_PROCESS: a process began in the job; the message carries its id.
    const NEW_PROCESS: u32 = 6;
    /// What `Port` posts when it is dropped, under key 0, which no job has.
    const QUIT: u32 = u32::MAX;

    /// A completion port the chats' jobs tell of their new processes, read by a thread of its
    /// own, which closes it once this is dropped.
    pub struct Port(Arc<Raw>);
    struct Raw(HANDLE);
    // A kernel handle is valid from any thread.
    unsafe impl Send for Raw {}
    unsafe impl Sync for Raw {}
    impl Drop for Raw {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    impl Drop for Port {
        fn drop(&mut self) {
            unsafe {
                PostQueuedCompletionStatus(self.0 .0, QUIT, 0, std::ptr::null());
            }
        }
    }

    impl Port {
        pub fn new(births: impl Fn(usize, u32) + Send + 'static) -> Option<Port> {
            let port =
                unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
            if port.is_null() {
                return None;
            }
            let raw = Arc::new(Raw(port));
            let reader = raw.clone();
            std::thread::Builder::new()
                .name("chat-job-births".into())
                .spawn(move || loop {
                    let (mut message, mut key, mut overlapped) =
                        (0u32, 0usize, std::ptr::null_mut());
                    let read = unsafe {
                        GetQueuedCompletionStatus(
                            reader.0,
                            &mut message,
                            &mut key,
                            &mut overlapped,
                            u32::MAX,
                        )
                    };
                    if read == 0 || (key == 0 && message == QUIT) {
                        break;
                    }
                    if message == NEW_PROCESS {
                        births(key, overlapped as usize as u32);
                    }
                })
                .ok()?;
            Some(Port(raw))
        }
    }

    /// A job object this app holds open while any of its processes runs.
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

    /// A new job holding `process`, which may let its own processes break away, as tools that
    /// start theirs outside any job ask to, and tells `port` of the processes that begin in it
    /// under `key`.
    pub fn job_for(process: RawHandle, port: Option<&Port>, key: usize) -> Option<Handle> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = Handle(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let set = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            // Before the CLI joins, so that its first processes are told of too. A job that
            // tells nothing still says whose its processes are.
            if let Some(port) = port {
                let associate = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                    CompletionKey: key as *mut c_void,
                    CompletionPort: port.0 .0,
                };
                SetInformationJobObject(
                    job.0,
                    JobObjectAssociateCompletionPortInformation,
                    &associate as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                );
            }
            if set == 0 || AssignProcessToJobObject(job.0, process as HANDLE) == 0 {
                return None;
            }
            Some(job)
        }
    }

    /// The CPU time every process the job held used since it began, those that ended included,
    /// in milliseconds; None when it cannot be read.
    pub fn cpu_ms(job: &Handle) -> Option<u64> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let read = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        // In units of 100 nanoseconds.
        (read != 0)
            .then(|| (info.TotalUserTime.max(0) + info.TotalKernelTime.max(0)) as u64 / 10_000)
    }

    /// The processes in a job now, or None when it cannot be read.
    pub fn pids(job: &Handle) -> Option<Vec<u32>> {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two 32-bit counts, then one id per pointer-sized slot.
        let mut slots = 64usize;
        loop {
            let mut list = vec![0usize; 1 + slots];
            let read = unsafe {
                QueryInformationJobObject(
                    job.0,
                    JobObjectBasicProcessIdList,
                    list.as_mut_ptr() as *mut c_void,
                    (list.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut(),
                )
            };
            let header = list[0] as u64;
            let (assigned, listed) = (header as u32 as usize, (header >> 32) as u32 as usize);
            if read != 0 && listed >= assigned {
                return Some(
                    list[1..1 + listed.min(slots)]
                        .iter()
                        .map(|id| *id as u32)
                        .collect(),
                );
            }
            if assigned <= slots && read == 0 {
                return None;
            }
            slots = assigned.max(slots * 2);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_chats_cli_and_what_it_starts_belong_to_its_chat() {
        let mut child = tokio::process::Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let jobs = Jobs::default();
        jobs.adopt("chat-a", &child, None);
        // The ping cmd.exe started joins the job too.
        let mut members = jobs.members();
        for _ in 0..50 {
            if members.chats.len() >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            members = jobs.members();
        }
        let pid = child.id().unwrap();
        assert_eq!(members.chats.get(&pid).map(String::as_str), Some("chat-a"));
        assert_eq!(members.roots.get(&pid).map(String::as_str), Some("chat-a"));
        assert!(members.chats.len() >= 2, "{members:?}");
        crate::runner::kill_tree(&mut child).await;
        // Once nothing of the chat runs, it is no longer followed.
        for _ in 0..50 {
            if jobs.members().roots.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(jobs.members().roots.is_empty());
    }
}
