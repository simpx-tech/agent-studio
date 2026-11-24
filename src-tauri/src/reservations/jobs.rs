//! Which chat a process belongs to. On Windows each chat's CLI runs in a job object of its own,
//! which every process it starts joins, an editor it leaves open included, so a reservation can
//! tell a chat's processes from the user's and from Windows' own however they were started. Jobs
//! limit nothing: they let a process break away when it asks, never end their processes, and go
//! once none of their processes runs. Elsewhere, and for a process that broke away, a chat's
//! processes are those its CLI started (`machine::Owners`).
use std::collections::HashMap;
use std::sync::Mutex;

/// The chats' processes, by process id.
#[derive(Clone, Debug, Default)]
pub struct Members {
    /// Processes in a chat's job.
    pub chats: HashMap<u32, String>,
    /// Each chat CLI's own process, whose descendants belong to its chat.
    pub roots: HashMap<u32, String>,
}

#[derive(Default)]
pub struct Jobs(Mutex<Vec<Job>>);
struct Job {
    conversation: String,
    pid: u32,
    #[cfg(windows)]
    job: windows::Handle,
}

impl Jobs {
    /// A chat's CLI started: what it runs belongs to the chat.
    pub fn adopt(&self, conversation: &str, child: &tokio::process::Child) {
        let Some(pid) = child.id() else { return };
        // Without a job, Windows reuses a process id soon enough to mistake another program's
        // processes for the chat's: a CLI whose job could not be made is left unfollowed.
        #[cfg(windows)]
        let Some(job) = child.raw_handle().and_then(windows::job_for) else {
            return;
        };
        if let Ok(mut jobs) = self.0.lock() {
            jobs.push(Job {
                conversation: conversation.into(),
                pid,
                #[cfg(windows)]
                job,
            });
        }
    }

    /// The chats' processes now. A chat whose CLI ended and left nothing running goes.
    pub fn members(&self) -> Members {
        let mut members = Members::default();
        let Ok(mut jobs) = self.0.lock() else {
            return members;
        };
        jobs.retain(|job| {
            #[cfg(windows)]
            {
                let Some(pids) = windows::pids(&job.job).filter(|pids| !pids.is_empty()) else {
                    return false;
                };
                for pid in pids {
                    members.chats.insert(pid, job.conversation.clone());
                }
            }
            #[cfg(unix)]
            if !std::path::Path::new(&format!("/proc/{}", job.pid)).exists() {
                return false;
            }
            members.roots.insert(job.pid, job.conversation.clone());
            true
        });
        members
    }
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };

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
    /// start theirs outside any job ask to.
    pub fn job_for(process: RawHandle) -> Option<Handle> {
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
            if set == 0 || AssignProcessToJobObject(job.0, process as HANDLE) == 0 {
                return None;
            }
            Some(job)
        }
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
        jobs.adopt("chat-a", &child);
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
