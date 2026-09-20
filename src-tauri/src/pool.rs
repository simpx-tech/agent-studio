//! Parked per-conversation CLI processes. A completed or interrupted reply leaves its
//! Claude or Codex process waiting on stdin so the conversation's next reply can continue
//! in the same process, keeping its integrations, background work, and token counters.
//! A process is reused only when the launch identity still matches; anything else restarts.
use crate::providers::{Executable, RunRequest};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
    time::Instant,
};

/// Parked processes are released after this much idle time.
pub const IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);
/// Bound idle memory: each Claude process is a Node runtime plus its MCP servers.
pub const MAX_PARKED: usize = 4;
/// How long an in-band interrupt may take before the process tree is killed instead.
pub const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

pub enum Line {
    Out(String),
    Err(String),
}

pub type OutputObserver = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Process {
    pub exe: Executable,
    pub child: Child,
    pub stdin: ChildStdin,
    pub lines: mpsc::Receiver<Line>,
    idle: Arc<AtomicBool>,
    /// Launch identity: provider, account/profile, computer, folder, executable, model,
    /// reasoning, and native session.
    pub fingerprint: String,
    pub session_id: String,
    /// False once the protocol state is unknown (an interrupt that never confirmed, a
    /// desynchronized response); such a process is killed instead of parked.
    pub healthy: bool,
    /// Codex: the loaded thread, its reported model, and the next JSON-RPC request id.
    pub thread: String,
    pub reported_model: Option<String>,
    pub next_id: u64,
    pub turns: u64,
}

impl Process {
    pub fn new(
        exe: Executable,
        child: Child,
        fingerprint: String,
        session_id: String,
    ) -> Result<Self, String> {
        Self::new_observed(exe, child, fingerprint, session_id, None)
    }
    pub fn new_observed(
        exe: Executable,
        mut child: Child,
        fingerprint: String,
        session_id: String,
        observer: Option<OutputObserver>,
    ) -> Result<Self, String> {
        let stdin = child.stdin.take().ok_or("CLI stdin is unavailable")?;
        let stdout = child.stdout.take().ok_or("CLI stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("CLI stderr is unavailable")?;
        let (tx, lines) = mpsc::channel(256);
        let idle = Arc::new(AtomicBool::new(false));
        // Readers live as long as the process. While parked, output is dropped so an idle
        // CLI can never fill its pipe or accumulate unbounded memory.
        let (out_tx, out_idle) = (tx.clone(), idle.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(observer) = &observer {
                    observer(&line);
                }
                if out_idle.load(Ordering::Relaxed) {
                    continue;
                }
                if out_tx.send(Line::Out(line)).await.is_err() {
                    break;
                }
            }
        });
        let err_idle = idle.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if err_idle.load(Ordering::Relaxed) {
                    continue;
                }
                if tx.send(Line::Err(line)).await.is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            exe,
            child,
            stdin,
            lines,
            idle,
            fingerprint,
            session_id,
            healthy: true,
            thread: String::new(),
            reported_model: None,
            next_id: 1,
            turns: 0,
        })
    }
    pub fn alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
    /// Whether this parked process can serve a reply with the given launch identity and
    /// native session. The session ID is the provider-reported one recorded at bind time.
    pub fn serves(
        &mut self,
        fingerprint: &str,
        session: &crate::providers::sessions::Session,
    ) -> bool {
        self.alive()
            && self.healthy
            && self.fingerprint == fingerprint
            && session.resumed
            && !session.switched_account
            && self.session_id == session.id()
    }
    fn drain(&mut self) {
        while self.lines.try_recv().is_ok() {}
    }
    /// Stop forwarding output between replies.
    pub fn park(&mut self) {
        self.idle.store(true, Ordering::Relaxed);
        self.drain();
    }
    /// Resume forwarding output for the next reply.
    pub fn claim(&mut self) {
        self.drain();
        self.idle.store(false, Ordering::Relaxed);
    }
    pub async fn kill(&mut self) {
        self.exe.kill(&mut self.child).await;
    }
}

/// The identity a parked process must share with the reply that wants to reuse it.
pub fn fingerprint(request: &RunRequest, exe: &Executable) -> Result<String, String> {
    let scope =
        crate::providers::sessions::scope(&request.agent.provider, request.location.as_ref())?;
    Ok(serde_json::json!({
        "scope": scope,
        "provider": request.agent.provider,
        "model": request.agent.model,
        "reasoning": request.agent.reasoning,
        "autoCompactTokens": request.agent.auto_compact_tokens,
        "outputSchema": if request.agent.provider == "claude" && !request.compact { request.agent.output_schema.as_deref() } else { None },
        "planMode": request.agent.plan_mode,
        "plugins": crate::plugins::for_run(request),
        "program": exe.program,
        "prefix": exe.prefix,
    })
    .to_string())
}

#[derive(Default)]
pub struct Pool(Mutex<HashMap<String, (Process, Instant)>>);

impl Pool {
    /// Remove the conversation's parked process so a reply can decide to reuse or replace it.
    pub fn take(&self, conversation: &str) -> Option<Process> {
        self.0
            .lock()
            .ok()?
            .remove(conversation)
            .map(|(process, _)| process)
    }
    pub fn len(&self) -> usize {
        self.0.lock().map(|parked| parked.len()).unwrap_or(0)
    }
    /// Keep the process for the conversation's next reply, evicting the oldest idle
    /// process beyond the bound and any previous process of the same conversation.
    pub async fn park(&self, conversation: &str, mut process: Process) {
        process.park();
        let mut evicted = Vec::new();
        {
            let Ok(mut parked) = self.0.lock() else {
                evicted.push(process);
                for process in evicted.iter_mut() {
                    process.kill().await;
                }
                return;
            };
            if let Some((previous, _)) = parked.remove(conversation) {
                evicted.push(previous);
            }
            while parked.len() >= MAX_PARKED {
                let oldest = parked
                    .iter()
                    .min_by_key(|(_, (_, at))| *at)
                    .map(|(id, _)| id.clone());
                match oldest.and_then(|id| parked.remove(&id)) {
                    Some((process, _)) => evicted.push(process),
                    None => break,
                }
            }
            parked.insert(conversation.into(), (process, Instant::now()));
        }
        for process in evicted.iter_mut() {
            process.kill().await;
        }
    }
    /// Release a conversation's process, for deletion or an explicit restart.
    pub async fn release(&self, conversation: &str) {
        if let Some(mut process) = self.take(conversation) {
            process.kill().await;
        }
    }
    /// Kill processes idle beyond the limit and any that exited on their own.
    pub async fn sweep(&self) {
        let mut expired = Vec::new();
        if let Ok(mut parked) = self.0.lock() {
            let now = Instant::now();
            let mut ids = Vec::new();
            for (id, (process, at)) in parked.iter_mut() {
                if now.duration_since(*at) >= IDLE_LIMIT || !process.alive() {
                    ids.push(id.clone());
                }
            }
            for id in ids {
                if let Some((process, _)) = parked.remove(&id) {
                    expired.push(process);
                }
            }
        }
        for process in expired.iter_mut() {
            process.kill().await;
        }
    }
    pub async fn shutdown(&self) {
        let mut all = Vec::new();
        if let Ok(mut parked) = self.0.lock() {
            all.extend(parked.drain().map(|(_, (process, _))| process));
        }
        for process in all.iter_mut() {
            process.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn exe() -> Executable {
        Executable {
            provider: "codex".into(),
            program: if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "sh".into()
            },
            prefix: vec![],
            wsl: None,
        }
    }
    // A child that waits on stdin like an idle CLI and echoes each line back.
    fn idle_child() -> Child {
        let mut command = exe().command();
        if cfg!(windows) {
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }",
            ]);
        } else {
            command.args(["-c", "cat"]);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().unwrap()
    }
    fn process(id: &str) -> Process {
        Process::new(exe(), idle_child(), format!("fingerprint-{id}"), id.into()).unwrap()
    }

    #[tokio::test]
    async fn account_observer_receives_output_while_parked_without_replaying_chat_lines() {
        use tokio::io::AsyncWriteExt;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut process = Process::new_observed(
            exe(),
            idle_child(),
            "live".into(),
            "session".into(),
            Some(Arc::new(move |line| {
                tx.send(line.to_owned()).unwrap();
            })),
        )
        .unwrap();
        process.park();
        process
            .stdin
            .write_all(b"{\"method\":\"account/updated\"}\n")
            .await
            .unwrap();
        let observed = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(observed.contains("account/updated"));
        assert!(process.lines.try_recv().is_err());
        process.claim();
        process.stdin.write_all(b"active\n").await.unwrap();
        assert!(
            matches!(tokio::time::timeout(Duration::from_secs(10),process.lines.recv()).await.unwrap(),Some(Line::Out(line)) if line == "active")
        );
        process.kill().await;
    }

    #[tokio::test]
    async fn parked_output_is_dropped_and_claimed_output_is_forwarded() {
        use tokio::io::AsyncWriteExt;
        let mut process = process("echo");
        process.stdin.write_all(b"live\n").await.unwrap();
        let line = tokio::time::timeout(Duration::from_secs(10), process.lines.recv())
            .await
            .unwrap();
        assert!(matches!(line, Some(Line::Out(text)) if text == "live"));
        process.park();
        process.stdin.write_all(b"idle\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        process.claim();
        process.stdin.write_all(b"again\n").await.unwrap();
        let line = tokio::time::timeout(Duration::from_secs(10), process.lines.recv())
            .await
            .unwrap();
        assert!(matches!(line, Some(Line::Out(text)) if text == "again"));
        assert!(process.alive());
        process.kill().await;
        assert!(!process.alive());
    }

    fn running(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("tasklist.exe")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        }
        #[cfg(unix)]
        {
            unsafe { libc::kill(pid as i32, 0) == 0 }
        }
    }

    #[tokio::test]
    async fn pool_reuses_by_conversation_bounds_idle_processes_and_expires_them() {
        let pool = Pool::default();
        let first = process("a");
        let first_pid = first.child.id().unwrap();
        pool.park("a", first).await;
        pool.park("a", process("a2")).await;
        assert!(
            !running(first_pid),
            "re-parking a conversation kills its previous process"
        );
        assert_eq!(pool.len(), 1);
        let current = pool.take("a").unwrap();
        assert_eq!(current.fingerprint, "fingerprint-a2");
        assert!(pool.take("a").is_none());
        pool.park("a", current).await;
        for id in ["b", "c", "d", "e"] {
            pool.park(id, process(id)).await;
        }
        assert_eq!(pool.len(), MAX_PARKED);
        assert!(
            pool.take("a").is_none(),
            "the oldest process is evicted first"
        );
        let mut latest = pool.take("e").unwrap();
        assert!(latest.alive());
        latest.kill().await;
        let released = pool.take("b").unwrap();
        let released_pid = released.child.id().unwrap();
        pool.park("b", released).await;
        pool.release("b").await;
        assert!(!running(released_pid));
        assert!(pool.take("b").is_none());
        pool.shutdown().await;
        assert_eq!(pool.len(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn sweep_releases_processes_past_the_idle_limit() {
        let pool = Pool::default();
        pool.park("old", process("old")).await;
        tokio::time::advance(IDLE_LIMIT / 2).await;
        pool.park("young", process("young")).await;
        tokio::time::advance(IDLE_LIMIT / 2).await;
        pool.sweep().await;
        assert!(pool.take("old").is_none());
        let mut young = pool.take("young").unwrap();
        assert!(young.alive());
        young.kill().await;
    }

    #[tokio::test]
    async fn a_parked_process_serves_only_the_session_the_provider_reported() {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"codex","model":"fixture","reasoning":"low","instructions":""},"messages":[{"role":"user","text":"First"}]})).unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let identity = fingerprint(&request, &exe()).unwrap();
        let first = request.native_session.take().unwrap();
        let mut process = process("codex");
        process.session_id = first.id().to_string();
        // Codex names its own thread; the binding records that identity.
        let thread = uuid::Uuid::new_v4().to_string();
        first.bind(&thread, true).unwrap();
        drop(first);
        request.messages.push(
            serde_json::from_value(serde_json::json!({"role":"assistant","text":"READY"})).unwrap(),
        );
        request.messages.push(
            serde_json::from_value(serde_json::json!({"role":"user","text":"Second"})).unwrap(),
        );
        let second = crate::providers::sessions::Session::prepare(root.path(), &request)
            .unwrap()
            .unwrap();
        assert!(second.resumed);
        assert!(!second.switched_account);
        assert_eq!(second.id(), thread);
        assert_eq!(process.fingerprint, "fingerprint-codex");
        process.fingerprint = identity.clone();
        assert!(
            !process.serves(&identity, &second),
            "the pre-bind identity must not match the reported thread"
        );
        process.session_id = thread.clone();
        assert!(process.serves(&identity, &second));
        let mut changed = request.clone();
        changed.agent.model = "other".into();
        assert!(!process.serves(&fingerprint(&changed, &exe()).unwrap(), &second));
        process.healthy = false;
        assert!(!process.serves(&identity, &second));
        process.healthy = true;
        process.kill().await;
        assert!(!process.serves(&identity, &second));
    }

    #[test]
    fn fingerprint_covers_model_reasoning_and_executable() {
        let request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","reasoning":"high","instructions":""},"messages":[{"role":"user","text":"hi"}]})).unwrap();
        let mut other = exe();
        let base = fingerprint(&request, &exe()).unwrap();
        other.prefix = vec!["--wsl".into()];
        assert_ne!(base, fingerprint(&request, &other).unwrap());
        let mut changed = request.clone();
        changed.agent.reasoning = "low".into();
        assert_ne!(base, fingerprint(&changed, &exe()).unwrap());
        changed.agent.reasoning = "high".into();
        changed.agent.model = "other".into();
        assert_ne!(base, fingerprint(&changed, &exe()).unwrap());
        changed.agent.model = "fixture".into();
        changed.agent.instructions = "changed".into();
        assert_eq!(
            base,
            fingerprint(&changed, &exe()).unwrap(),
            "instructions travel in-band and do not restart the process"
        );
    }
}
