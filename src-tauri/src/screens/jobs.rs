//! A screen's jobs (docs/SCREENS.md): every action or command a screen runs is a job on the
//! computer that keeps the screen. Its output goes to a log in app data `screens/jobs/` as it
//! arrives, and the job goes on while no page shows it, so a page that was closed and opened
//! again, a reloaded window or another device finds it running or finds what it printed and how
//! it ended. A job a page started to keep stays until a page forgets it or the screen is
//! deleted; any other job goes once a page received its end. A job still running when the app
//! quits is stopped, and one the app could not see end reads as interrupted.
use super::run::{self, Script, Stream};
use super::{Shell, Site};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as Shared, MutexGuard};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

/// How long a request for new output waits for some before it answers without any. A page asks
/// again at once, so this only bounds how long one request stays open.
const WAIT: Duration = Duration::from_secs(25);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    /// It ended by itself, or at its time limit.
    Done,
    /// A page, the user or quitting the app stopped it.
    Stopped,
    /// It was running when the app ended without stopping it.
    Interrupted,
    /// It never ran: its shell or folder was unavailable.
    Failed,
}

/// A job as its computer keeps it, and as lists show it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    /// The action it runs, or none for a command the page passed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// What lists name it by: the action, or the command's first line.
    pub label: String,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
    /// The place it runs in when it is not the screen's own.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// Kept until a page forgets it; otherwise it goes once a page received its end.
    pub keep: bool,
    pub state: State,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Why it never ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// How much its log holds, which lists report and the file does not keep.
    #[serde(default, skip_deserializing)]
    pub bytes: u64,
}

/// What a page or a chat asks to run as a job, checked and placed.
pub struct Spec {
    pub action: Option<String>,
    pub label: String,
    pub params: Map<String, Value>,
    pub place: Option<String>,
    pub site: Site,
    /// The name PowerShell errors give the script: the action's, or `command`.
    pub name: String,
    pub shell: Shell,
    pub script: String,
    pub timeout: Option<u64>,
    pub variables: Vec<(String, String)>,
    pub keep: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct Progress {
    /// Bytes of the log written whole; readers read no further.
    bytes: u64,
    ended: bool,
}

struct Live {
    screen: String,
    stop: CancellationToken,
    progress: watch::Sender<Progress>,
    /// Forgotten while it ran: its end leaves nothing behind.
    forgotten: AtomicBool,
}

type Registry = Arc<Shared<HashMap<String, Arc<Live>>>>;

/// The jobs running on this computer, by id. Their records and logs are on disk.
#[derive(Default)]
pub struct Jobs {
    live: Registry,
}

fn lock<T>(mutex: &Shared<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn folder(root: &Path, screen: &str) -> PathBuf {
    root.join("jobs").join(screen)
}
fn record_file(root: &Path, screen: &str, job: &str) -> PathBuf {
    folder(root, screen).join(format!("{job}.json"))
}
fn log_file(root: &Path, screen: &str, job: &str) -> PathBuf {
    folder(root, screen).join(format!("{job}.log"))
}

const MISSING: &str = "This job is no longer kept on this computer.";

fn checked(job: &str) -> Result<(), String> {
    if super::valid_id(job) {
        Ok(())
    } else {
        Err("Invalid job id".into())
    }
}

fn write_record(root: &Path, screen: &str, record: &Record) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|_| "Cannot keep this job")?;
    super::replace(&record_file(root, screen, &record.id), &bytes)
}

/// A job's record as the app last wrote it; a record left running by an app that ended
/// without stopping it is interrupted.
fn read_record(root: &Path, screen: &str, job: &str, live: bool) -> Result<Record, String> {
    let bytes = match std::fs::read(record_file(root, screen, job)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(MISSING.into()),
        Err(_) => return Err("Cannot read this job.".into()),
    };
    let mut record: Record = serde_json::from_slice(&bytes)
        .ok()
        .filter(|record: &Record| record.id == job)
        .ok_or("This job's record is unreadable.")?;
    if record.state == State::Running && !live {
        record.state = State::Interrupted;
        let _ = write_record(root, screen, &record);
    }
    record.bytes = std::fs::metadata(log_file(root, screen, job)).map_or(0, |m| m.len());
    Ok(record)
}

/// Text from a stream's bytes, holding back the start of a character a later chunk finishes.
fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(valid) => {
                text.push_str(valid);
                carry.clear();
                return text;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                text.push_str(std::str::from_utf8(&carry[..valid]).unwrap_or_default());
                match error.error_len() {
                    Some(invalid) => {
                        text.push(char::REPLACEMENT_CHARACTER);
                        carry.drain(..valid + invalid);
                    }
                    None => {
                        carry.drain(..valid);
                        return text;
                    }
                }
            }
        }
    }
}

/// One line of a job's log: which stream printed the text.
fn line(stream: Stream, text: &str) -> String {
    let key = match stream {
        Stream::Out => "o",
        Stream::Err => "e",
    };
    let mut line = json!({ key: text }).to_string();
    line.push('\n');
    line
}

/// Writes what the command prints to its log as it arrives, whole lines at a time, and tells
/// whoever follows the job.
async fn write_log(
    path: PathBuf,
    mut chunks: mpsc::UnboundedReceiver<(Stream, Vec<u8>)>,
    live: Arc<Live>,
) {
    let file = tokio::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .await;
    let Ok(mut file) = file else {
        while chunks.recv().await.is_some() {}
        return;
    };
    let mut carry: [Vec<u8>; 2] = Default::default();
    let index = |stream: Stream| match stream {
        Stream::Out => 0,
        Stream::Err => 1,
    };
    let mut ended = false;
    while !ended {
        let Some(first) = chunks.recv().await else {
            break;
        };
        // What else arrived meanwhile goes in the same write.
        let mut pieces: Vec<(Stream, String)> = vec![];
        let mut push = |stream: Stream, bytes: &[u8], carry: &mut [Vec<u8>; 2]| {
            let text = decode(&mut carry[index(stream)], bytes);
            if text.is_empty() {
                return;
            }
            match pieces.last_mut() {
                Some((last, joined)) if *last == stream => joined.push_str(&text),
                _ => pieces.push((stream, text)),
            }
        };
        push(first.0, &first.1, &mut carry);
        loop {
            match chunks.try_recv() {
                Ok((stream, bytes)) => push(stream, &bytes, &mut carry),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    ended = true;
                    break;
                }
            }
        }
        let text: String = pieces
            .iter()
            .map(|(stream, text)| line(*stream, text))
            .collect();
        if text.is_empty() {
            continue;
        }
        if file.write_all(text.as_bytes()).await.is_err() || file.flush().await.is_err() {
            continue;
        }
        live.progress
            .send_modify(|progress| progress.bytes += text.len() as u64);
    }
    // A character the command never finished is written as it is.
    let mut rest = String::new();
    for (stream, bytes) in [(Stream::Out, &carry[0]), (Stream::Err, &carry[1])] {
        if !bytes.is_empty() {
            rest.push_str(&line(stream, &String::from_utf8_lossy(bytes)));
        }
    }
    if !rest.is_empty()
        && file.write_all(rest.as_bytes()).await.is_ok()
        && file.flush().await.is_ok()
    {
        live.progress
            .send_modify(|progress| progress.bytes += rest.len() as u64);
    }
}

/// The output of a log from byte `after` up to `length`, as chunks of each stream in the order
/// printed, and where the next read starts.
fn read_log(path: &Path, after: u64, length: u64) -> (Vec<Value>, u64) {
    if length <= after {
        return (vec![], after);
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return (vec![], after);
    };
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(after)).is_err()
        || file
            .by_ref()
            .take(length - after)
            .read_to_end(&mut bytes)
            .is_err()
    {
        return (vec![], after);
    }
    let mut chunks: Vec<(&str, String)> = vec![];
    let mut consumed = 0usize;
    for piece in bytes.split_inclusive(|byte| *byte == b'\n') {
        if piece.last() != Some(&b'\n') {
            break;
        }
        consumed += piece.len();
        let Ok(Value::Object(entry)) = serde_json::from_slice::<Value>(piece) else {
            continue;
        };
        let (stream, text) = match (entry.get("o"), entry.get("e")) {
            (Some(Value::String(text)), _) => ("stdout", text),
            (_, Some(Value::String(text))) => ("stderr", text),
            _ => continue,
        };
        match chunks.last_mut() {
            Some((last, joined)) if *last == stream => joined.push_str(text),
            _ => chunks.push((stream, text.clone())),
        }
    }
    (
        chunks
            .into_iter()
            .map(|(stream, text)| json!({ "stream": stream, "text": text }))
            .collect(),
        after + consumed as u64,
    )
}

fn remove(root: &Path, screen: &str, job: &str) {
    let _ = std::fs::remove_file(record_file(root, screen, job));
    let _ = std::fs::remove_file(log_file(root, screen, job));
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Could not finish this job request".to_string())?
}

/// Waits until a live job ended, or at most `limit`.
async fn ended(live: &Live, limit: Option<Duration>) {
    let mut progress = live.progress.subscribe();
    let wait = async {
        while !progress.borrow_and_update().ended {
            if progress.changed().await.is_err() {
                return;
            }
        }
    };
    match limit {
        Some(limit) => {
            let _ = tokio::time::timeout(limit, wait).await;
        }
        None => wait.await,
    }
}

impl Jobs {
    /// How many jobs run on this computer now.
    pub fn running(&self) -> usize {
        lock(&self.live).len()
    }
    /// How many jobs of a screen run now.
    pub fn running_for(&self, screen: &str) -> usize {
        lock(&self.live)
            .values()
            .filter(|live| live.screen == screen)
            .count()
    }

    fn find(&self, screen: &str, job: &str) -> Option<Arc<Live>> {
        lock(&self.live)
            .get(job)
            .filter(|live| live.screen == screen)
            .cloned()
    }

    /// Starts a job and returns its record at once; it runs until it ends or is stopped.
    pub async fn start(
        &self,
        root: &Path,
        namespace: &str,
        screen: &str,
        spec: Spec,
    ) -> Result<Record, String> {
        super::checked_id(screen)?;
        let record = Record {
            id: uuid::Uuid::new_v4().to_string(),
            action: spec.action.clone(),
            label: spec.label.clone(),
            params: spec.params.clone(),
            place: spec.place.clone(),
            keep: spec.keep,
            state: State::Running,
            started_at: super::now(),
            ended_at: None,
            exit_code: None,
            timed_out: false,
            duration_ms: None,
            error: None,
            bytes: 0,
        };
        {
            let (root, screen, record) = (root.to_path_buf(), screen.to_string(), record.clone());
            blocking(move || {
                std::fs::create_dir_all(folder(&root, &screen))
                    .map_err(|_| "Cannot keep this screen's jobs")?;
                std::fs::write(log_file(&root, &screen, &record.id), b"")
                    .map_err(|_| "Cannot keep this job's output")?;
                write_record(&root, &screen, &record)
            })
            .await?;
        }
        let (progress, _) = watch::channel(Progress::default());
        let live = Arc::new(Live {
            screen: screen.into(),
            stop: CancellationToken::new(),
            progress,
            forgotten: AtomicBool::new(false),
        });
        lock(&self.live).insert(record.id.clone(), live.clone());
        let (registry, root, namespace, screen) = (
            self.live.clone(),
            root.to_path_buf(),
            namespace.to_string(),
            screen.to_string(),
        );
        let mut finished = record.clone();
        tokio::spawn(async move {
            let (sender, receiver) = mpsc::unbounded_channel();
            let writer = tokio::spawn(write_log(
                log_file(&root, &screen, &finished.id),
                receiver,
                live.clone(),
            ));
            let script = Script {
                name: &spec.name,
                shell: spec.shell,
                text: &spec.script,
                timeout: spec.timeout,
            };
            let outcome = run::execute(
                &root,
                &namespace,
                &spec.site,
                &script,
                spec.variables,
                sender,
                &live.stop,
            )
            .await;
            let _ = writer.await;
            match outcome {
                Ok(ended) => {
                    finished.state = if ended.stopped {
                        State::Stopped
                    } else {
                        State::Done
                    };
                    finished.exit_code = ended.exit_code;
                    finished.timed_out = ended.timed_out;
                    finished.duration_ms = Some(ended.duration_ms);
                }
                Err(error) => {
                    finished.state = State::Failed;
                    finished.error = Some(error);
                }
            }
            finished.ended_at = Some(super::now());
            if !live.forgotten.load(Ordering::SeqCst) {
                let (root, screen) = (root.clone(), screen.clone());
                let _ = blocking(move || write_record(&root, &screen, &finished)).await;
            }
            live.progress.send_modify(|progress| progress.ended = true);
            lock(&registry).retain(|_, known| !Arc::ptr_eq(known, &live));
        });
        Ok(record)
    }

    /// The screen's jobs, the newest first.
    pub async fn list(&self, root: &Path, screen: &str) -> Result<Vec<Record>, String> {
        super::checked_id(screen)?;
        let live: Vec<String> = lock(&self.live)
            .iter()
            .filter(|(_, live)| live.screen == screen)
            .map(|(id, _)| id.clone())
            .collect();
        let (root, screen) = (root.to_path_buf(), screen.to_string());
        blocking(move || {
            let Ok(entries) = std::fs::read_dir(folder(&root, &screen)) else {
                return Ok(vec![]);
            };
            let mut records: Vec<Record> = entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().into_string().ok()?;
                    let id = name
                        .strip_suffix(".json")
                        .filter(|id| super::valid_id(id))?;
                    read_record(&root, &screen, id, live.iter().any(|known| known == id)).ok()
                })
                .collect();
            records.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            Ok(records)
        })
        .await
    }

    /// A job's output from byte `after`, waiting for some while it runs when asked to, with its
    /// record. Once a page received the end of a job that is not kept, the job goes; `peek`
    /// reads it without that, as the window's own job list does.
    pub async fn output(
        &self,
        root: &Path,
        screen: &str,
        job: &str,
        after: u64,
        wait: bool,
        peek: bool,
    ) -> Result<Value, String> {
        super::checked_id(screen)?;
        checked(job)?;
        let live = self.find(screen, job);
        if let (Some(live), true) = (&live, wait) {
            let mut progress = live.progress.subscribe();
            let _ = tokio::time::timeout(WAIT, async {
                loop {
                    let now = *progress.borrow_and_update();
                    if now.bytes > after || now.ended {
                        return;
                    }
                    if progress.changed().await.is_err() {
                        return;
                    }
                }
            })
            .await;
        }
        let written = live.as_ref().map(|live| *live.progress.borrow());
        let (root, screen, job) = (root.to_path_buf(), screen.to_string(), job.to_string());
        blocking(move || {
            let running = written.is_some_and(|progress| !progress.ended);
            let mut record = read_record(&root, &screen, &job, written.is_some())?;
            let path = log_file(&root, &screen, &job);
            let length = match written {
                Some(progress) if !progress.ended => progress.bytes,
                _ => std::fs::metadata(&path).map_or(0, |m| m.len()),
            };
            let (chunks, next) = read_log(&path, after, length);
            record.bytes = length;
            let whole = !running && record.state != State::Running && next >= length;
            if whole && !record.keep && !peek {
                remove(&root, &screen, &job);
            }
            Ok(json!({ "chunks": chunks, "next": next, "job": record }))
        })
        .await
    }

    /// Waits until a job ended and returns everything it printed with how it ended, as a page
    /// that asked to run an action and wait receives it. A job that is not kept goes then.
    pub async fn outcome(&self, root: &Path, screen: &str, job: &str) -> Result<Value, String> {
        if let Some(live) = self.find(screen, job) {
            ended(&live, None).await;
        }
        let (root, screen, job) = (root.to_path_buf(), screen.to_string(), job.to_string());
        blocking(move || {
            let record = read_record(&root, &screen, &job, false)?;
            let path = log_file(&root, &screen, &job);
            let length = std::fs::metadata(&path).map_or(0, |m| m.len());
            let (chunks, _) = read_log(&path, 0, length);
            if !record.keep {
                remove(&root, &screen, &job);
            }
            if let (State::Failed, Some(error)) = (record.state, &record.error) {
                return Err(error.clone());
            }
            let (mut stdout, mut stderr) = (String::new(), String::new());
            for chunk in &chunks {
                let text = chunk["text"].as_str().unwrap_or_default();
                if chunk["stream"] == "stderr" {
                    stderr.push_str(text);
                } else {
                    stdout.push_str(text);
                }
            }
            Ok(json!({
                "exitCode": record.exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": false,
                "timedOut": record.timed_out,
                "stopped": matches!(record.state, State::Stopped | State::Interrupted),
                "durationMs": record.duration_ms.unwrap_or_default(),
                "job": record.id,
            }))
        })
        .await
    }

    /// Stops a running job with everything it started, and returns how it ended.
    pub async fn stop(&self, root: &Path, screen: &str, job: &str) -> Result<Record, String> {
        super::checked_id(screen)?;
        checked(job)?;
        if let Some(live) = self.find(screen, job) {
            live.stop.cancel();
            ended(&live, Some(Duration::from_secs(30))).await;
        }
        let (root, screen, job) = (root.to_path_buf(), screen.to_string(), job.to_string());
        let live = self.find(&screen, &job).is_some();
        blocking(move || read_record(&root, &screen, &job, live)).await
    }

    /// Removes a job and its output, stopping it first when it still runs.
    pub async fn forget(&self, root: &Path, screen: &str, job: &str) -> Result<(), String> {
        super::checked_id(screen)?;
        checked(job)?;
        if let Some(live) = self.find(screen, job) {
            live.forgotten.store(true, Ordering::SeqCst);
            live.stop.cancel();
            ended(&live, Some(Duration::from_secs(30))).await;
        }
        let (root, screen, job) = (root.to_path_buf(), screen.to_string(), job.to_string());
        blocking(move || {
            remove(&root, &screen, &job);
            Ok(())
        })
        .await
    }

    /// Stops and removes every job of a deleted screen.
    pub async fn forget_screen(&self, root: &Path, screen: &str) {
        let running: Vec<Arc<Live>> = lock(&self.live)
            .values()
            .filter(|live| live.screen == screen)
            .cloned()
            .collect();
        for live in &running {
            live.forgotten.store(true, Ordering::SeqCst);
            live.stop.cancel();
        }
        for live in &running {
            ended(live, Some(Duration::from_secs(30))).await;
        }
        let path = folder(root, screen);
        let _ = blocking(move || {
            let _ = std::fs::remove_dir_all(path);
            Ok(())
        })
        .await;
    }

    /// Stops every job as the app quits; each keeps what it printed, read as stopped.
    pub async fn shutdown(&self) {
        let running: Vec<Arc<Live>> = lock(&self.live).values().cloned().collect();
        for live in &running {
            live.stop.cancel();
        }
        for live in &running {
            ended(live, Some(Duration::from_secs(20))).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(site: &Site, shell: Shell, script: &str, keep: bool) -> Spec {
        Spec {
            action: Some("probe".into()),
            label: "probe".into(),
            params: Map::new(),
            place: None,
            site: site.clone(),
            name: "probe".into(),
            shell,
            script: script.into(),
            timeout: None,
            variables: vec![],
            keep,
        }
    }
    fn shell() -> Shell {
        if cfg!(windows) {
            Shell::Powershell
        } else {
            Shell::Bash
        }
    }

    #[test]
    fn text_keeps_characters_split_across_chunks() {
        let mut carry = vec![];
        let bytes = "aé😀".as_bytes();
        // é is two bytes, 😀 four: split each.
        assert_eq!(decode(&mut carry, &bytes[..2]), "a");
        assert_eq!(decode(&mut carry, &bytes[2..4]), "é");
        assert_eq!(decode(&mut carry, &bytes[4..6]), "");
        assert_eq!(decode(&mut carry, &bytes[6..]), "😀");
        assert!(carry.is_empty());
        // A byte no character starts with is replaced, and the rest is kept.
        assert_eq!(decode(&mut carry, b"x\xffy"), "x\u{fffd}y");
    }

    #[test]
    fn logs_read_in_order_from_where_a_reader_stopped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("job.log");
        let text = [
            line(Stream::Out, "one\n"),
            line(Stream::Out, "two\n"),
            line(Stream::Err, "warned\n"),
            line(Stream::Out, "three"),
        ]
        .concat();
        std::fs::write(&path, &text).unwrap();
        let length = text.len() as u64;
        let (chunks, next) = read_log(&path, 0, length);
        assert_eq!(
            chunks,
            [
                json!({"stream": "stdout", "text": "one\ntwo\n"}),
                json!({"stream": "stderr", "text": "warned\n"}),
                json!({"stream": "stdout", "text": "three"}),
            ]
        );
        assert_eq!(next, length);
        // A reader that stopped after the first line reads the rest, and nothing past the
        // length written whole.
        let first = line(Stream::Out, "one\n").len() as u64;
        let (rest, _) = read_log(&path, first, length);
        assert_eq!(rest[0]["text"], "two\n");
        let (none, at) = read_log(&path, length, length);
        assert!(none.is_empty() && at == length);
        let (partial, at) = read_log(&path, 0, length - 1);
        assert_eq!(partial.len(), 2);
        assert_eq!(at, length - line(Stream::Out, "three").len() as u64);
    }

    #[tokio::test]
    async fn a_job_runs_on_while_followed_from_anywhere_and_keeps_its_output() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screen = uuid::Uuid::new_v4().to_string();
        let jobs = Jobs::default();
        let site = run::tests::site(directory.path());
        let script = if cfg!(windows) {
            "Write-Output 'first'\nStart-Sleep -Milliseconds 1500\n[Console]::Error.WriteLine('warned')\nWrite-Output 'second'\nexit 3"
        } else {
            "echo first\nsleep 1.5\necho warned >&2\necho second\nexit 3"
        };
        let started = jobs
            .start(&root, "test", &screen, spec(&site, shell(), script, true))
            .await
            .unwrap();
        assert_eq!(started.state, State::Running);
        assert_eq!(jobs.running(), 1);
        // The list names it running; a reader waits for output and follows it to its end.
        let listed = jobs.list(&root, &screen).await.unwrap();
        assert_eq!(listed[0].id, started.id);
        assert_eq!(listed[0].state, State::Running);
        let mut next = 0;
        let mut text = String::new();
        let mut stderr = String::new();
        let record = loop {
            let answer = jobs
                .output(&root, &screen, &started.id, next, true, false)
                .await
                .unwrap();
            for chunk in answer["chunks"].as_array().unwrap() {
                if chunk["stream"] == "stderr" {
                    stderr.push_str(chunk["text"].as_str().unwrap());
                } else {
                    text.push_str(chunk["text"].as_str().unwrap());
                }
            }
            next = answer["next"].as_u64().unwrap();
            let record: Record = serde_json::from_value(answer["job"].clone()).unwrap();
            if record.state != State::Running {
                break record;
            }
        };
        assert!(text.contains("first") && text.contains("second"), "{text}");
        assert!(stderr.contains("warned"), "{stderr}");
        assert_eq!(record.state, State::Done);
        assert_eq!(record.exit_code, Some(3));
        assert_eq!(jobs.running(), 0);
        // A kept job stays, its output whole, for another page.
        let again = jobs
            .output(&root, &screen, &started.id, 0, false, false)
            .await
            .unwrap();
        assert!(again["chunks"].to_string().contains("second"));
        assert_eq!(jobs.list(&root, &screen).await.unwrap().len(), 1);
        jobs.forget(&root, &screen, &started.id).await.unwrap();
        assert!(jobs.list(&root, &screen).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_job_not_kept_goes_once_a_page_received_its_end() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screen = uuid::Uuid::new_v4().to_string();
        let jobs = Jobs::default();
        let site = run::tests::site(directory.path());
        let started = jobs
            .start(
                &root,
                "test",
                &screen,
                spec(&site, shell(), "Write-Output 'done'", false),
            )
            .await
            .unwrap();
        // Waiting for it to end gives everything it printed, and the job then goes.
        let outcome = jobs.outcome(&root, &screen, &started.id).await.unwrap();
        if cfg!(windows) {
            assert_eq!(outcome["stdout"].as_str().unwrap().trim(), "done");
            assert_eq!(outcome["exitCode"], 0);
        }
        assert_eq!(outcome["job"], started.id);
        assert!(jobs.list(&root, &screen).await.unwrap().is_empty());
        // A page that closed before the end leaves it for the next one, which receives it
        // once, unless it only peeks.
        let left = jobs
            .start(
                &root,
                "test",
                &screen,
                spec(&site, shell(), "Write-Output 'later'", false),
            )
            .await
            .unwrap();
        if let Some(live) = jobs.find(&screen, &left.id) {
            ended(&live, None).await;
        }
        let peeked = jobs
            .output(&root, &screen, &left.id, 0, false, true)
            .await
            .unwrap();
        assert_ne!(peeked["job"]["state"], "running");
        assert_eq!(jobs.list(&root, &screen).await.unwrap().len(), 1);
        jobs.output(&root, &screen, &left.id, 0, false, false)
            .await
            .unwrap();
        assert!(jobs.list(&root, &screen).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stopping_and_quitting_end_running_jobs_with_their_output() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screen = uuid::Uuid::new_v4().to_string();
        let jobs = Jobs::default();
        let site = run::tests::site(directory.path());
        let slow = if cfg!(windows) {
            "Write-Output 'started'\nStart-Sleep -Seconds 120"
        } else {
            "echo started\nsleep 120"
        };
        let first = jobs
            .start(&root, "test", &screen, spec(&site, shell(), slow, true))
            .await
            .unwrap();
        // Its first line arrives before it is stopped.
        let answer = jobs
            .output(&root, &screen, &first.id, 0, true, true)
            .await
            .unwrap();
        assert!(answer["chunks"].to_string().contains("started"));
        let stopped = jobs.stop(&root, &screen, &first.id).await.unwrap();
        assert_eq!(stopped.state, State::Stopped);
        assert_eq!(stopped.exit_code, None);
        let second = jobs
            .start(&root, "test", &screen, spec(&site, shell(), slow, true))
            .await
            .unwrap();
        jobs.shutdown().await;
        assert_eq!(jobs.running(), 0);
        let records = jobs.list(&root, &screen).await.unwrap();
        assert!(records
            .iter()
            .any(|r| r.id == second.id && r.state == State::Stopped));
        // A record an app left running without seeing it end reads as interrupted.
        let mut orphan = records[0].clone();
        orphan.id = uuid::Uuid::new_v4().to_string();
        orphan.state = State::Running;
        orphan.started_at = super::super::now();
        write_record(&root, &screen, &orphan).unwrap();
        let listed = jobs.list(&root, &screen).await.unwrap();
        assert_eq!(listed[0].id, orphan.id);
        assert_eq!(listed[0].state, State::Interrupted);
        // Deleting the screen takes every job with it.
        jobs.forget_screen(&root, &screen).await;
        assert!(jobs.list(&root, &screen).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_job_that_cannot_run_says_why() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screen = uuid::Uuid::new_v4().to_string();
        let jobs = Jobs::default();
        let site = run::tests::site(&directory.path().join("missing"));
        let started = jobs
            .start(
                &root,
                "test",
                &screen,
                spec(&site, shell(), "echo hi", false),
            )
            .await
            .unwrap();
        let error = jobs.outcome(&root, &screen, &started.id).await.unwrap_err();
        assert!(error.contains("folder is unavailable"), "{error}");
        assert!(jobs.list(&root, &screen).await.unwrap().is_empty());
        assert_eq!(
            jobs.output(&root, &screen, "nope", 0, false, false)
                .await
                .unwrap_err(),
            "Invalid job id"
        );
    }
}
