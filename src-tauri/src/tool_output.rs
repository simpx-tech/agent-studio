//! Tool results kept on the computer that ran them. Commands and result sizes travel with
//! the synced activity record; the text and images themselves stay here, bounded, and are
//! read on demand through transport, so the workspace and relay sync never carry them.
//!
//! Layout: `tool-output/<run id>/<key>.json` per call, where the key is a name-based UUID of
//! the call's activity ID, plus `run.json` with the run's conversation, start and size.
use crate::protocol::activity::{CapturedOutput, ImageSource, IMAGE_LIMIT};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DIRECTORY: &str = "tool-output";
/// Bytes one run may keep; later results record only that they were not kept.
const RUN_LIMIT: u64 = 256 * 1024 * 1024;
/// Decoded image bytes kept for one call.
const CALL_IMAGE_LIMIT: usize = 8 * 1024 * 1024;
/// Total bytes kept on this computer. Pruning removes the oldest runs beyond it.
const TOTAL_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const PRUNE_TARGET: u64 = TOTAL_LIMIT / 10 * 9;
/// Results older than this are removed, like the CLIs' own transcripts.
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Runs not yet saved in the workspace keep their results this long.
const UNSAVED_GRACE: Duration = Duration::from_secs(60 * 60);
/// A stored call file larger than this is not read.
const FILE_LIMIT: u64 = 24 * 1024 * 1024;
const KEY_NAMESPACE: uuid::Uuid = uuid::Uuid::from_u128(0x6d1f_1c8e_52a4_4f0e_9a4b_7c1e_2d3f_4a5b);
pub const NOT_KEPT: &str =
    "This output is no longer kept on the computer that ran it. Outputs are kept for 30 days, up to 2 GB.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredImage {
    pub media_type: String,
    pub data: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}
/// One call's result as stored and as returned to a window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub version: u32,
    pub tool_id: String,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    #[serde(default)]
    pub images: Vec<StoredImage>,
    /// Images reported but not kept: unreadable, unsupported or over the size limits.
    #[serde(default)]
    pub images_omitted: u32,
    /// The run had reached its storage limit, so nothing was kept.
    #[serde(default)]
    pub omitted: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    conversation_id: String,
    /// Milliseconds since the Unix epoch.
    created_at: u64,
    bytes: u64,
}

#[derive(Default)]
struct Slot {
    value: Mutex<Option<Arc<Stored>>>,
    ready: tokio::sync::Notify,
}
/// Results still being written, so a window that asks right away still gets them, and the
/// runs that are recording, which pruning leaves alone.
#[derive(Default)]
pub struct Pending {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    active: Mutex<HashSet<String>>,
}

pub fn key(tool_id: &str) -> String {
    uuid::Uuid::new_v5(&KEY_NAMESPACE, tool_id.as_bytes()).to_string()
}
fn slot_key(run_id: &str, tool_id: &str) -> String {
    format!("{run_id}/{}", key(tool_id))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
fn valid_tool_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 240 && !id.chars().any(char::is_control)
}
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the app data directory")?
        .join(DIRECTORY))
}

/// The image type named by a file's first bytes, with its dimensions when readable.
pub fn sniff(bytes: &[u8]) -> Option<(&'static str, Option<(u32, u32)>)> {
    let be = |i: usize| -> Option<u32> {
        Some(u32::from_be_bytes(bytes.get(i..i + 4)?.try_into().ok()?))
    };
    let (kind, size) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let size = (bytes.get(12..16) == Some(b"IHDR")).then(|| Some((be(16)?, be(20)?)));
        ("image/png", size.flatten())
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let size = bytes.get(6..10).map(|d| {
            (
                u16::from_le_bytes([d[0], d[1]]) as u32,
                u16::from_le_bytes([d[2], d[3]]) as u32,
            )
        });
        ("image/gif", size)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        ("image/webp", webp_size(bytes))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", jpeg_size(bytes))
    } else {
        return None;
    };
    Some((
        kind,
        size.filter(|(w, h)| (1..=100_000).contains(w) && (1..=100_000).contains(h)),
    ))
}
fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    match b.get(12..16)? {
        b"VP8 " => {
            let d = b.get(26..30)?;
            Some((
                (u16::from_le_bytes([d[0], d[1]]) & 0x3fff) as u32,
                (u16::from_le_bytes([d[2], d[3]]) & 0x3fff) as u32,
            ))
        }
        b"VP8L" => {
            let d = b.get(21..25)?;
            let bits = u32::from_le_bytes([d[0], d[1], d[2], d[3]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8X" => {
            let d = b.get(24..30)?;
            Some((
                u32::from_le_bytes([d[0], d[1], d[2], 0]) + 1,
                u32::from_le_bytes([d[3], d[4], d[5], 0]) + 1,
            ))
        }
        _ => None,
    }
}
fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 9 < b.len() {
        if b[i] != 0xff {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd8) {
            i += 2;
            continue;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let height = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
            let width = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
            return Some((width, height));
        }
        i += 2 + u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
    }
    None
}
/// A checked image; `encoded` is the bytes' standard base64 when the provider sent it.
fn stored_image(bytes: &[u8], encoded: Option<&str>) -> Option<StoredImage> {
    if bytes.is_empty() || bytes.len() > IMAGE_LIMIT {
        return None;
    }
    let (media_type, size) = sniff(bytes)?;
    Some(StoredImage {
        media_type: media_type.into(),
        data: encoded.map_or_else(
            || base64::engine::general_purpose::STANDARD.encode(bytes),
            str::to_owned,
        ),
        bytes: bytes.len() as u64,
        width: size.map(|s| s.0),
        height: size.map(|s| s.1),
    })
}

/// A captured result with its base64 images decoded and checked by their own bytes, not the
/// type the provider named. Reported image files are left for the worker to read.
fn prepare(output: &CapturedOutput) -> (Stored, Vec<String>) {
    let mut stored = Stored {
        version: 1,
        tool_id: output.tool_id.clone(),
        stdout: output.stdout.clone(),
        stderr: output.stderr.clone(),
        truncated: output.truncated,
        exit_code: output.exit_code,
        start_line: output.start_line,
        images: vec![],
        images_omitted: 0,
        omitted: false,
    };
    let mut files = vec![];
    for image in &output.images {
        match image {
            ImageSource::Base64 { data, .. } => {
                match base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .ok()
                    .and_then(|bytes| stored_image(&bytes, Some(data)))
                {
                    Some(image) => add_image(&mut stored, image),
                    None => stored.images_omitted += 1,
                }
            }
            ImageSource::File { path } => files.push(path.clone()),
        }
    }
    (stored, files)
}
fn add_image(stored: &mut Stored, image: StoredImage) {
    let used: u64 = stored.images.iter().map(|i| i.bytes).sum();
    if used + image.bytes <= CALL_IMAGE_LIMIT as u64 {
        stored.images.push(image);
    } else {
        stored.images_omitted += 1;
    }
}
/// Reads an image file a provider reported viewing: a regular file of a supported type.
fn read_image_file(path: &Path) -> Option<StoredImage> {
    let text = path.to_string_lossy();
    if !path.is_absolute() || text.starts_with(r"\\.\") || text.starts_with(r"\\?\") {
        return None;
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > IMAGE_LIMIT as u64 {
        return None;
    }
    stored_image(&std::fs::read(path).ok()?, None)
}

/// Writes `value` to `path` through a temporary file, so readers see all of it or nothing.
fn write_atomic(path: &Path, value: &impl Serialize) -> Result<u64, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot serialize a tool output")?;
    let parent = path.parent().ok_or("Invalid tool output path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create the tool output folder")?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot prepare a tool output")?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| "Cannot write a tool output")?;
    file.persist(path)
        .map_err(|_| "Cannot finish writing a tool output")?;
    Ok(bytes.len() as u64)
}

enum Job {
    Output {
        slot_key: String,
        slot: Arc<Slot>,
        output: Box<CapturedOutput>,
    },
    Distribution(Option<String>),
}
/// Stores one run's results in order on a background worker.
#[derive(Clone)]
pub struct Recorder {
    run_id: String,
    pending: Arc<Pending>,
    jobs: tokio::sync::mpsc::UnboundedSender<Job>,
}
impl Recorder {
    pub fn new(app: &tauri::AppHandle, conversation_id: &str, run_id: &str) -> Option<Self> {
        uuid::Uuid::parse_str(run_id).ok()?;
        uuid::Uuid::parse_str(conversation_id).ok()?;
        let root = root(app).ok()?;
        let pending = app.try_state::<Arc<Pending>>()?.inner().clone();
        let (jobs, receiver) = tokio::sync::mpsc::unbounded_channel();
        pending.active.lock().ok()?.insert(run_id.into());
        let worker = Worker {
            root,
            run_id: run_id.into(),
            conversation_id: conversation_id.into(),
            pending: pending.clone(),
            distribution: None,
            bytes: 0,
            created_at: now_ms(),
        };
        tauri::async_runtime::spawn(worker.run(receiver));
        Some(Self {
            run_id: run_id.into(),
            pending,
            jobs,
        })
    }
    /// The WSL distribution whose Linux paths the run's image files use, if any.
    pub fn distribution(&self, distribution: Option<String>) {
        let _ = self.jobs.send(Job::Distribution(distribution));
    }
    /// Queues a result. A window that asks for it before it is written waits for the worker.
    pub fn record(&self, output: CapturedOutput) {
        if !valid_tool_id(&output.tool_id) {
            return;
        }
        let slot = Arc::new(Slot::default());
        let slot_key = slot_key(&self.run_id, &output.tool_id);
        if let Ok(mut slots) = self.pending.slots.lock() {
            slots.insert(slot_key.clone(), slot.clone());
        }
        let _ = self.jobs.send(Job::Output {
            slot_key,
            slot,
            output: Box::new(output),
        });
    }
}
struct Worker {
    root: PathBuf,
    run_id: String,
    conversation_id: String,
    pending: Arc<Pending>,
    distribution: Option<String>,
    bytes: u64,
    created_at: u64,
}
impl Worker {
    async fn run(mut self, mut jobs: tokio::sync::mpsc::UnboundedReceiver<Job>) {
        while let Some(job) = jobs.recv().await {
            match job {
                Job::Distribution(distribution) => self.distribution = distribution,
                Job::Output {
                    slot_key,
                    slot,
                    output,
                } => {
                    let Ok((mut stored, files)) =
                        tauri::async_runtime::spawn_blocking(move || prepare(&output)).await
                    else {
                        self.release(&slot_key, &slot);
                        continue;
                    };
                    for path in files {
                        match self.image_file(&path).await {
                            Some(image) => add_image(&mut stored, image),
                            None => stored.images_omitted += 1,
                        }
                    }
                    self.write(stored, &slot_key, &slot).await;
                }
            }
        }
        if let Ok(mut active) = self.pending.active.lock() {
            active.remove(&self.run_id);
        }
        let root = self.root.clone();
        let pending = self.pending.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || prune(&root, &pending)).await;
    }
    async fn image_file(&self, path: &str) -> Option<StoredImage> {
        let path = match &self.distribution {
            // Linux paths reach Windows through the distribution's own translation.
            Some(distribution) => {
                let (folder, name) = path.rsplit_once('/')?;
                let folder = if folder.is_empty() { "/" } else { folder };
                if name.is_empty() {
                    return None;
                }
                crate::folders::windows_path(distribution, folder)
                    .await
                    .ok()?
                    .join(name)
            }
            None => PathBuf::from(path),
        };
        tauri::async_runtime::spawn_blocking(move || read_image_file(&path))
            .await
            .ok()
            .flatten()
    }
    async fn write(&mut self, stored: Stored, slot_key: &str, slot: &Arc<Slot>) {
        let size = (stored.stdout.len()
            + stored.stderr.len()
            + stored.images.iter().map(|i| i.data.len()).sum::<usize>()) as u64;
        let stored = if self.bytes + size > RUN_LIMIT {
            Stored {
                stdout: String::new(),
                stderr: String::new(),
                images: vec![],
                omitted: true,
                ..stored
            }
        } else {
            stored
        };
        let stored = Arc::new(stored);
        {
            let mut value = slot.value.lock().unwrap_or_else(|e| e.into_inner());
            *value = Some(stored.clone());
        }
        slot.ready.notify_waiters();
        let directory = self.root.join(&self.run_id);
        let path = directory.join(format!("{}.json", key(&stored.tool_id)));
        let manifest_path = directory.join("run.json");
        let written = {
            let stored = stored.clone();
            let conversation_id = self.conversation_id.clone();
            let created_at = self.created_at;
            let previous = self.bytes;
            tauri::async_runtime::spawn_blocking(move || {
                let bytes = write_atomic(&path, &*stored)?;
                write_atomic(
                    &manifest_path,
                    &Manifest {
                        conversation_id,
                        created_at,
                        bytes: previous + bytes,
                    },
                )?;
                Ok::<u64, String>(bytes)
            })
            .await
        };
        if let Ok(Ok(bytes)) = written {
            self.bytes += bytes;
        }
        self.release(slot_key, slot);
    }
    /// Ends a slot's time in memory; readers then use the file, if one was written.
    fn release(&self, slot_key: &str, slot: &Arc<Slot>) {
        // A later result for the same call may have replaced this slot.
        if let Ok(mut slots) = self.pending.slots.lock() {
            if slots.get(slot_key).is_some_and(|s| Arc::ptr_eq(s, slot)) {
                slots.remove(slot_key);
            }
        }
        slot.ready.notify_waiters();
    }
}

/// The result of one call of one run, from memory while it is being written, else from disk.
pub async fn read(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
) -> Result<Stored, String> {
    if uuid::Uuid::parse_str(&run_id).is_err() || !valid_tool_id(&tool_id) {
        return Err("Invalid tool output request".into());
    }
    let slot = pending
        .slots
        .lock()
        .ok()
        .and_then(|slots| slots.get(&slot_key(&run_id, &tool_id)).cloned());
    if let Some(slot) = slot {
        let ready = slot.ready.notified();
        tokio::pin!(ready);
        ready.as_mut().enable();
        let current = slot.value.lock().ok().and_then(|v| v.clone());
        if let Some(stored) = current {
            return Ok((*stored).clone());
        }
        let _ = tokio::time::timeout(Duration::from_secs(20), ready).await;
        if let Some(stored) = slot.value.lock().ok().and_then(|v| v.clone()) {
            return Ok((*stored).clone());
        }
    }
    let path = root.join(&run_id).join(format!("{}.json", key(&tool_id)));
    tauri::async_runtime::spawn_blocking(move || {
        let metadata = std::fs::metadata(&path).map_err(|_| NOT_KEPT.to_string())?;
        if metadata.len() > FILE_LIMIT {
            return Err(NOT_KEPT.to_string());
        }
        let bytes = std::fs::read(&path).map_err(|_| NOT_KEPT.to_string())?;
        let stored: Stored = serde_json::from_slice(&bytes).map_err(|_| NOT_KEPT.to_string())?;
        if stored.tool_id != tool_id {
            return Err(NOT_KEPT.to_string());
        }
        Ok(stored)
    })
    .await
    .map_err(|_| "Cannot read the tool output".to_string())?
}

/// Runs the saved workspace still references, or `None` when it cannot be read.
fn referenced_runs(workspace: &Path) -> Option<HashSet<String>> {
    #[derive(Deserialize)]
    struct Message {
        #[serde(default, rename = "runId")]
        run_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct Rewind {
        #[serde(default)]
        removed: Vec<Message>,
    }
    #[derive(Deserialize)]
    struct Conversation {
        #[serde(default)]
        messages: Vec<Message>,
        #[serde(default)]
        rewind: Option<Rewind>,
    }
    #[derive(Deserialize)]
    struct Saved {
        conversations: Vec<Conversation>,
    }
    let bytes = std::fs::read(workspace).ok()?;
    let saved: Saved = serde_json::from_slice(&bytes).ok()?;
    Some(
        saved
            .conversations
            .into_iter()
            .flat_map(|c| {
                c.messages
                    .into_iter()
                    .chain(c.rewind.into_iter().flat_map(|r| r.removed))
            })
            .filter_map(|m| m.run_id)
            .collect(),
    )
}
fn directory_bytes(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}
static PRUNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Removes results of runs the workspace no longer has, results older than 30 days, and
/// the oldest runs beyond the total limit. Runs still recording are kept.
pub fn prune(root: &Path, pending: &Pending) {
    use std::sync::atomic::Ordering;
    if PRUNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let referenced = root
        .parent()
        .and_then(|data| referenced_runs(&data.join("workspace.json")));
    let active = pending.active.lock().map(|a| a.clone()).unwrap_or_default();
    let now = now_ms();
    let mut runs = vec![];
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if uuid::Uuid::parse_str(&name).is_err() || !path.is_dir() || active.contains(&name) {
            continue;
        }
        let manifest: Option<Manifest> = std::fs::read(path.join("run.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let created_at = manifest.as_ref().map(|m| m.created_at).unwrap_or_else(|| {
            entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64)
        });
        let age = Duration::from_millis(now.saturating_sub(created_at));
        let unsaved = referenced
            .as_ref()
            .is_some_and(|runs| !runs.contains(&name));
        if age > MAX_AGE || (unsaved && age > UNSAVED_GRACE) {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let bytes = manifest
            .map(|m| m.bytes)
            .unwrap_or_else(|| directory_bytes(&path));
        runs.push((created_at, bytes, path));
    }
    let mut total: u64 = runs.iter().map(|r| r.1).sum();
    if total > TOTAL_LIMIT {
        runs.sort_by_key(|r| r.0);
        for (_, bytes, path) in runs {
            if total <= PRUNE_TARGET {
                break;
            }
            if std::fs::remove_dir_all(&path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
    }
    PRUNING.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
        0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0,
    ];

    fn output(tool_id: &str) -> CapturedOutput {
        CapturedOutput {
            tool_id: tool_id.into(),
            stdout: "hello\n".into(),
            stderr: "warning\n".into(),
            truncated: false,
            exit_code: Some(1),
            start_line: None,
            images: vec![
                ImageSource::Base64 {
                    media_type: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(PNG),
                },
                ImageSource::Base64 {
                    media_type: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(b"<svg/>"),
                },
            ],
        }
    }

    #[test]
    fn images_are_sniffed_with_their_dimensions() {
        assert_eq!(sniff(PNG), Some(("image/png", Some((4, 3)))));
        assert_eq!(
            sniff(b"GIF89a\x10\x00\x20\x00rest"),
            Some(("image/gif", Some((16, 32))))
        );
        let jpeg = [
            0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 40, 3, 0, 0, 0,
        ];
        assert_eq!(sniff(&jpeg), Some(("image/jpeg", Some((40, 20)))));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0".to_vec();
        webp.extend([99, 0, 0, 49, 0, 0]);
        assert_eq!(sniff(&webp), Some(("image/webp", Some((100, 50)))));
        assert_eq!(sniff(b"<svg/>"), None);
    }

    #[test]
    fn prepared_results_keep_valid_images_and_count_the_rest() {
        let (stored, files) = prepare(&output("claude:one"));
        assert!(files.is_empty());
        assert_eq!(stored.images.len(), 1);
        assert_eq!(stored.images[0].width, Some(4));
        assert_eq!(stored.images_omitted, 1);
        assert_eq!(stored.exit_code, Some(1));
        let mut large = output("claude:two");
        large.images = (0..3)
            .map(|_| ImageSource::Base64 {
                media_type: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD
                    .encode([PNG, &vec![0u8; 3 * 1024 * 1024]].concat()),
            })
            .collect();
        let (stored, _) = prepare(&large);
        assert_eq!((stored.images.len(), stored.images_omitted), (2, 1));
    }

    #[tokio::test]
    async fn results_are_read_from_pending_slots_then_disk_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let run = "11111111-1111-4111-8111-111111111111";
        let (stored, _) = prepare(&output("claude:one"));
        let slot = Arc::new(Slot::default());
        pending
            .slots
            .lock()
            .unwrap()
            .insert(slot_key(run, "claude:one"), slot.clone());
        let waiting = tokio::spawn(read(
            root.clone(),
            pending.clone(),
            run.into(),
            "claude:one".into(),
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        *slot.value.lock().unwrap() = Some(Arc::new(stored.clone()));
        slot.ready.notify_waiters();
        assert_eq!(waiting.await.unwrap().unwrap(), stored);
        pending.slots.lock().unwrap().clear();
        let path = root.join(run).join(format!("{}.json", key("claude:one")));
        write_atomic(&path, &stored).unwrap();
        assert_eq!(
            read(
                root.clone(),
                pending.clone(),
                run.into(),
                "claude:one".into()
            )
            .await
            .unwrap(),
            stored
        );
        assert_eq!(
            read(
                root.clone(),
                pending.clone(),
                run.into(),
                "claude:two".into()
            )
            .await,
            Err(NOT_KEPT.into())
        );
        for (run, tool) in [("../escape", "claude:one"), (run, ""), (run, "a\nb")] {
            assert!(read(root.clone(), pending.clone(), run.into(), tool.into())
                .await
                .unwrap_err()
                .contains("Invalid"));
        }
    }

    #[test]
    fn pruning_removes_unsaved_old_and_excess_runs_but_keeps_active_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let run = |n: u32| format!("{n:08}-1111-4111-8111-111111111111");
        let day = 24 * 60 * 60 * 1000;
        let now = now_ms();
        for (n, age, bytes) in [
            (1, 0, 10),
            (2, 2 * day, 10),
            (3, 31 * day, 10),
            (4, 3 * day, TOTAL_LIMIT),
            (5, 2 * day, 10),
            (6, 2 * 60 * 60 * 1000, 10),
            (7, 60 * 1000, 10),
        ] {
            write_atomic(
                &root.join(run(n)).join("run.json"),
                &Manifest {
                    conversation_id: "c".into(),
                    created_at: now - age,
                    bytes,
                },
            )
            .unwrap();
        }
        let saved: Vec<_> = [1, 3, 4, 5].iter().map(|n| run(*n)).collect();
        std::fs::write(
            dir.path().join("workspace.json"),
            serde_json::json!({"conversations":[{"messages":[{"runId":saved[0]},{"runId":saved[1]}],"rewind":{"removed":[{"runId":saved[2]}]}},{"messages":[{"runId":saved[3]}]}]}).to_string(),
        )
        .unwrap();
        let pending = Pending::default();
        pending.active.lock().unwrap().insert(run(2));
        prune(&root, &pending);
        let kept: HashSet<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        // 2 is recording, 3 is too old, 4 is the oldest beyond the total limit, 6 was never
        // saved, and 7 may not be saved yet.
        assert_eq!(kept, HashSet::from([run(1), run(2), run(5), run(7)]));
    }
}
