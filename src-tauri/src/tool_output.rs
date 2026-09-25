//! Tool results kept on the computer that ran them: complete, as the provider sent them, and
//! for as long as their conversation exists. Commands and result sizes travel with the synced
//! activity record; text, images and complete commands stay here and are read on demand
//! through transport, so the workspace and relay sync never carry them.
//!
//! Layout: `tool-output/<run id>/run.json` (conversation, start, bytes) and one folder per
//! call, named by a name-based UUID of the call's activity ID, holding `stdout.txt` and
//! `stderr.txt` as received, `image-<n>.<ext>` files, and `meta.json`, written last.
use crate::protocol::activity::{terminal_text, CapturedOutput, ImageSource};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const DIRECTORY: &str = "tool-output";
/// Text of each stream a window receives when it opens a call.
pub const PREVIEW_BYTES: u64 = 512 * 1024;
/// Text of each stream a full read returns, so both fit in one relay request of 20 MB.
pub const FULL_BYTES: u64 = 8 * 1024 * 1024;
/// Runs not yet saved in the workspace keep their results this long.
const UNSAVED_GRACE: Duration = Duration::from_secs(60 * 60);
/// A call's `meta.json` larger than this is not read.
const META_LIMIT: u64 = 64 * 1024 * 1024;
/// Bytes read to recognize an image file and its dimensions.
const SNIFF_BYTES: usize = 512 * 1024;
const KEY_NAMESPACE: uuid::Uuid = uuid::Uuid::from_u128(0x6d1f_1c8e_52a4_4f0e_9a4b_7c1e_2d3f_4a5b);
pub const NOT_KEPT: &str = "This output was not kept on the computer that ran it.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageMeta {
    file: String,
    media_type: String,
    bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    version: u32,
    tool_id: String,
    #[serde(default)]
    exit_code: Option<i64>,
    #[serde(default)]
    start_line: Option<u64>,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    images: Vec<ImageMeta>,
    /// Images reported but not kept: unreadable or not a supported image type.
    #[serde(default)]
    images_omitted: u32,
    /// The complete command or input when the activity record shows a shortened one.
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    input: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    conversation_id: String,
    /// Milliseconds since the Unix epoch.
    created_at: u64,
    bytes: u64,
}

/// One stream of a result as a window receives it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    /// Cleaned for display; the beginning and end of a longer stream, with a marker between.
    pub text: String,
    /// The whole stream's size as kept.
    pub bytes: u64,
    pub complete: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageView {
    pub index: usize,
    pub media_type: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}
/// A call's result as a window receives it. Images are read one at a time.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub version: u32,
    pub tool_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    pub truncated: bool,
    pub stdout: Text,
    pub stderr: Text,
    pub images: Vec<ImageView>,
    pub images_omitted: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageData {
    pub media_type: String,
    pub data: String,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Default)]
struct Slot {
    done: AtomicBool,
    ready: tokio::sync::Notify,
}
/// Results still being written, so a window that asks right away waits for them, and the
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
fn valid_request(run_id: &str, tool_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(run_id).is_err() || !valid_tool_id(tool_id) {
        return Err("Invalid tool output request".into());
    }
    Ok(())
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
fn extension(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// Writes `bytes` to `path` through a temporary file, so readers see all of it or nothing.
fn write_file(path: &Path, bytes: &[u8]) -> Result<u64, String> {
    let parent = path.parent().ok_or("Invalid tool output path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create the tool output folder")?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot prepare a tool output")?;
    file.write_all(bytes)
        .map_err(|_| "Cannot write a tool output")?;
    file.persist(path)
        .map_err(|_| "Cannot finish writing a tool output")?;
    Ok(bytes.len() as u64)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<u64, String> {
    write_file(
        path,
        &serde_json::to_vec(value).map_err(|_| "Cannot serialize a tool output")?,
    )
}
/// Copies an image file a provider reported viewing: a regular file of a supported type.
fn copy_image(path: &Path, directory: &Path, index: usize) -> Option<ImageMeta> {
    let text = path.to_string_lossy();
    if !path.is_absolute() || text.starts_with(r"\\.\") || text.starts_with(r"\\?\") {
        return None;
    }
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut source = std::fs::File::open(path).ok()?;
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    (&mut source)
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .ok()?;
    let (media_type, size) = sniff(&head)?;
    source.seek(SeekFrom::Start(0)).ok()?;
    let file = format!("image-{index}.{}", extension(media_type));
    let mut target = tempfile::NamedTempFile::new_in(directory).ok()?;
    let bytes = std::io::copy(&mut source, &mut target).ok()?;
    target.persist(directory.join(&file)).ok()?;
    Some(ImageMeta {
        file,
        media_type: media_type.into(),
        bytes,
        width: size.map(|s| s.0),
        height: size.map(|s| s.1),
    })
}
/// Writes one call's result, replacing an earlier one, and returns the bytes written.
fn write_call(
    directory: &Path,
    output: &CapturedOutput,
    files: &[Option<PathBuf>],
) -> Result<u64, String> {
    let _ = std::fs::remove_dir_all(directory);
    std::fs::create_dir_all(directory).map_err(|_| "Cannot create the tool output folder")?;
    let mut written = 0;
    for (name, text) in [
        ("stdout.txt", &output.stdout),
        ("stderr.txt", &output.stderr),
    ] {
        if !text.is_empty() {
            written += write_file(&directory.join(name), text.as_bytes())?;
        }
    }
    let mut images = vec![];
    let mut omitted = 0;
    for image in &output.images {
        let ImageSource::Base64 { data, .. } = image else {
            continue;
        };
        let decoded = base64::engine::general_purpose::STANDARD.decode(data).ok();
        let Some((bytes, (media_type, size))) =
            decoded.and_then(|bytes| sniff(&bytes).map(|kind| (bytes, kind)))
        else {
            omitted += 1;
            continue;
        };
        let file = format!("image-{}.{}", images.len(), extension(media_type));
        written += write_file(&directory.join(&file), &bytes)?;
        images.push(ImageMeta {
            file,
            media_type: media_type.into(),
            bytes: bytes.len() as u64,
            width: size.map(|s| s.0),
            height: size.map(|s| s.1),
        });
    }
    for path in files {
        match path
            .as_deref()
            .and_then(|path| copy_image(path, directory, images.len()))
        {
            Some(image) => {
                written += image.bytes;
                images.push(image);
            }
            None => omitted += 1,
        }
    }
    let meta = Meta {
        version: 2,
        tool_id: output.tool_id.clone(),
        exit_code: output.exit_code,
        start_line: output.start_line,
        truncated: output.truncated,
        images,
        images_omitted: omitted,
        command: output.command.clone(),
        input: output.input.clone(),
    };
    Ok(written + write_json(&directory.join("meta.json"), &meta)?)
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
                    let mut files = vec![];
                    for image in &output.images {
                        if let ImageSource::File { path } = image {
                            files.push(self.image_path(path).await);
                        }
                    }
                    self.write(output, files, &slot_key, &slot).await;
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
    /// A reported image path on this computer; Linux paths reach Windows through the
    /// distribution's own translation.
    async fn image_path(&self, path: &str) -> Option<PathBuf> {
        let Some(distribution) = &self.distribution else {
            return Some(PathBuf::from(path));
        };
        let (folder, name) = path.rsplit_once('/')?;
        let folder = if folder.is_empty() { "/" } else { folder };
        if name.is_empty() {
            return None;
        }
        Some(
            crate::folders::windows_path(distribution, folder)
                .await
                .ok()?
                .join(name),
        )
    }
    async fn write(
        &mut self,
        output: Box<CapturedOutput>,
        files: Vec<Option<PathBuf>>,
        slot_key: &str,
        slot: &Arc<Slot>,
    ) {
        let run = self.root.join(&self.run_id);
        let directory = run.join(key(&output.tool_id));
        let conversation_id = self.conversation_id.clone();
        let created_at = self.created_at;
        let previous = self.bytes;
        let written = tauri::async_runtime::spawn_blocking(move || {
            let bytes = write_call(&directory, &output, &files)?;
            write_json(
                &run.join("run.json"),
                &Manifest {
                    conversation_id,
                    created_at,
                    bytes: previous + bytes,
                },
            )?;
            Ok::<u64, String>(bytes)
        })
        .await;
        if let Ok(Ok(bytes)) = written {
            self.bytes += bytes;
        }
        // A later result for the same call may have replaced this slot.
        if let Ok(mut slots) = self.pending.slots.lock() {
            if slots.get(slot_key).is_some_and(|s| Arc::ptr_eq(s, slot)) {
                slots.remove(slot_key);
            }
        }
        slot.done.store(true, Ordering::SeqCst);
        slot.ready.notify_waiters();
    }
}

/// Waits while a result of this call is still being written.
async fn written(pending: &Pending, run_id: &str, tool_id: &str) {
    let slot = pending
        .slots
        .lock()
        .ok()
        .and_then(|slots| slots.get(&slot_key(run_id, tool_id)).cloned());
    if let Some(slot) = slot {
        let ready = slot.ready.notified();
        tokio::pin!(ready);
        ready.as_mut().enable();
        if !slot.done.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(Duration::from_secs(20), ready).await;
        }
    }
}
fn read_meta(directory: &Path, tool_id: &str) -> Result<Meta, String> {
    let path = directory.join("meta.json");
    let metadata = std::fs::metadata(&path).map_err(|_| NOT_KEPT.to_string())?;
    if metadata.len() > META_LIMIT {
        return Err(NOT_KEPT.into());
    }
    let meta: Meta = serde_json::from_slice(&std::fs::read(&path).map_err(|_| NOT_KEPT)?)
        .map_err(|_| NOT_KEPT.to_string())?;
    if meta.tool_id != tool_id {
        return Err(NOT_KEPT.into());
    }
    Ok(meta)
}
fn human(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let kb = bytes as f64 / 1024.0;
    if kb < 1024.0 {
        return format!("{kb:.0} KB");
    }
    format!("{:.1} MB", kb / 1024.0)
}
/// A stream as a window shows it: whole when it fits in `limit`, otherwise its beginning and
/// end on line boundaries with a marker for what is not shown.
fn read_text(path: &Path, limit: u64) -> Text {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Text {
            complete: true,
            ..Text::default()
        };
    };
    let size = file.metadata().map_or(0, |m| m.len());
    let mut read = |length: u64| {
        let mut buffer = Vec::with_capacity(length as usize);
        let _ = (&mut file).take(length).read_to_end(&mut buffer);
        buffer
    };
    if size <= limit {
        return Text {
            text: terminal_text(&String::from_utf8_lossy(&read(size))),
            bytes: size,
            complete: true,
        };
    }
    let head = read(limit / 4 * 3);
    let mut tail = vec![];
    if file.seek(SeekFrom::End(-((limit / 4) as i64))).is_ok() {
        let _ = file.read_to_end(&mut tail);
    }
    // Whole characters and lines only at the cuts.
    let head = match std::str::from_utf8(&head) {
        Ok(text) => text,
        Err(error) => std::str::from_utf8(&head[..error.valid_up_to()]).unwrap_or_default(),
    };
    let head = head.rfind('\n').map_or(head, |i| &head[..=i]);
    let start = tail
        .iter()
        .position(|b| (*b as i8) >= -0x40)
        .unwrap_or(tail.len());
    let tail = String::from_utf8_lossy(&tail[start..]);
    let tail = tail.find('\n').map_or(&tail[..], |i| &tail[i + 1..]);
    let hidden = size.saturating_sub((head.len() + tail.len()) as u64);
    Text {
        text: format!(
            "{}[… {} not shown …]\n{}",
            terminal_text(head),
            human(hidden),
            terminal_text(tail)
        ),
        bytes: size,
        complete: false,
    }
}

/// One call's result for a window: whole streams up to the preview size, or up to the full
/// size when asked, and its images' descriptions.
pub async fn read(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    full: bool,
) -> Result<View, String> {
    valid_request(&run_id, &tool_id)?;
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        let meta = read_meta(&directory, &tool_id)?;
        let limit = if full { FULL_BYTES } else { PREVIEW_BYTES };
        Ok(View {
            version: meta.version,
            tool_id,
            exit_code: meta.exit_code,
            start_line: meta.start_line,
            truncated: meta.truncated,
            stdout: read_text(&directory.join("stdout.txt"), limit),
            stderr: read_text(&directory.join("stderr.txt"), limit),
            images: meta
                .images
                .into_iter()
                .enumerate()
                .map(|(index, image)| ImageView {
                    index,
                    media_type: image.media_type,
                    bytes: image.bytes,
                    width: image.width,
                    height: image.height,
                })
                .collect(),
            images_omitted: meta.images_omitted,
            command: meta.command,
            input: meta.input,
        })
    })
    .await
    .map_err(|_| "Cannot read the tool output".to_string())?
}

/// One image of a call's result.
pub async fn read_image(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<ImageData, String> {
    valid_request(&run_id, &tool_id)?;
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        let meta = read_meta(&directory, &tool_id)?;
        let image = meta.images.get(index).ok_or(NOT_KEPT)?;
        // Stored names only; a name never reaches outside the call's folder.
        if image.file.contains(['/', '\\']) || !image.file.starts_with("image-") {
            return Err(NOT_KEPT.to_string());
        }
        let bytes = std::fs::read(directory.join(&image.file)).map_err(|_| NOT_KEPT)?;
        let (media_type, _) = sniff(&bytes).ok_or(NOT_KEPT)?;
        Ok(ImageData {
            media_type: media_type.into(),
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            bytes: bytes.len() as u64,
            width: image.width,
            height: image.height,
        })
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
static PRUNING: AtomicBool = AtomicBool::new(false);
/// Removes the results of runs the saved workspace no longer has, such as deleted chats.
/// Results of saved chats are kept, whatever their age or size; runs still recording and
/// runs saved within the last hour are left alone.
pub fn prune(root: &Path, pending: &Pending) {
    if PRUNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let referenced = root
        .parent()
        .and_then(|data| referenced_runs(&data.join("workspace.json")));
    let active = pending.active.lock().map(|a| a.clone()).unwrap_or_default();
    let now = now_ms();
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let Some(referenced) = &referenced else {
            break;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if uuid::Uuid::parse_str(&name).is_err()
            || !path.is_dir()
            || active.contains(&name)
            || referenced.contains(&name)
        {
            continue;
        }
        let created_at = std::fs::read(path.join("run.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .map(|m| m.created_at)
            .or_else(|| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
            })
            .unwrap_or(0);
        if Duration::from_millis(now.saturating_sub(created_at)) > UNSAVED_GRACE {
            let _ = std::fs::remove_dir_all(&path);
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
    const RUN: &str = "11111111-1111-4111-8111-111111111111";

    fn output(tool_id: &str) -> CapturedOutput {
        let mut output = CapturedOutput {
            tool_id: tool_id.into(),
            stdout: "\u{1b}[32mhello\u{1b}[0m\r\n".into(),
            stderr: "warning\n".into(),
            truncated: false,
            exit_code: Some(1),
            start_line: None,
            images: vec![],
            command: Some("npm test -- --long".into()),
            input: None,
        };
        output.images = [PNG, b"<svg/>".as_slice()]
            .iter()
            .map(|bytes| ImageSource::Base64 {
                media_type: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
            .collect();
        output
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

    #[tokio::test]
    async fn results_are_kept_whole_and_read_as_previews_full_views_and_images() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let mut captured = output("claude:one");
        // A reported file image is copied; a missing one is counted as not kept.
        let file = dir.path().join("shot.png");
        std::fs::write(&file, PNG).unwrap();
        captured.images.push(ImageSource::File {
            path: file.to_string_lossy().into(),
        });
        let files = [Some(file), Some(dir.path().join("missing.png"))];
        let directory = root.join(RUN).join(key("claude:one"));
        write_call(&directory, &captured, &files).unwrap();
        let view = read(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:one".into(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(view.stdout.text, "hello\n");
        assert!(view.stdout.complete && view.stderr.complete);
        assert_eq!(view.exit_code, Some(1));
        assert_eq!(view.command.as_deref(), Some("npm test -- --long"));
        assert_eq!((view.images.len(), view.images_omitted), (2, 2));
        assert_eq!(view.images[1].width, Some(4));
        // The raw stream is kept as the provider sent it.
        assert_eq!(
            std::fs::read_to_string(directory.join("stdout.txt")).unwrap(),
            "\u{1b}[32mhello\u{1b}[0m\r\n"
        );
        let image = read_image(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:one".into(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(image.media_type, "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(image.data)
                .unwrap(),
            PNG
        );
        assert!(read_image(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:one".into(),
            2
        )
        .await
        .is_err());
        // A long stream is previewed by its ends and read whole on request.
        let mut long = CapturedOutput::new("claude:long");
        long.stdout = (0..40_000).map(|i| format!("line {i} é\n")).collect();
        write_call(&root.join(RUN).join(key("claude:long")), &long, &[]).unwrap();
        let preview = read(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:long".into(),
            false,
        )
        .await
        .unwrap();
        assert!(!preview.stdout.complete);
        assert_eq!(preview.stdout.bytes, long.stdout.len() as u64);
        assert!(preview.stdout.text.starts_with("line 0 é\n"));
        assert!(preview.stdout.text.ends_with("line 39999 é\n"));
        assert!(preview.stdout.text.contains(" not shown …]\n"));
        assert!(preview.stdout.text.len() <= PREVIEW_BYTES as usize + 64);
        let whole = read(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:long".into(),
            true,
        )
        .await
        .unwrap();
        assert!(whole.stdout.complete);
        assert_eq!(whole.stdout.text, long.stdout);
        assert_eq!(
            read(
                root.clone(),
                pending.clone(),
                RUN.into(),
                "claude:two".into(),
                false
            )
            .await,
            Err(NOT_KEPT.into())
        );
        for (run, tool) in [("../escape", "claude:one"), (RUN, ""), (RUN, "a\nb")] {
            assert!(read(
                root.clone(),
                pending.clone(),
                run.into(),
                tool.into(),
                false
            )
            .await
            .unwrap_err()
            .contains("Invalid"));
        }
    }

    #[tokio::test]
    async fn a_read_waits_for_a_result_being_written() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let slot = Arc::new(Slot::default());
        pending
            .slots
            .lock()
            .unwrap()
            .insert(slot_key(RUN, "claude:one"), slot.clone());
        let waiting = tokio::spawn(read(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:one".into(),
            false,
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        write_call(
            &root.join(RUN).join(key("claude:one")),
            &output("claude:one"),
            &[],
        )
        .unwrap();
        slot.done.store(true, Ordering::SeqCst);
        slot.ready.notify_waiters();
        assert_eq!(waiting.await.unwrap().unwrap().stdout.text, "hello\n");
    }

    #[test]
    fn pruning_removes_only_runs_no_saved_chat_references() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let run = |n: u32| format!("{n:08}-1111-4111-8111-111111111111");
        let day = 24 * 60 * 60 * 1000;
        let now = now_ms();
        for (n, age) in [
            (1, 0),
            (2, 2 * day),
            (3, 400 * day),
            (4, 3 * day),
            (5, 2 * 60 * 60 * 1000),
            (6, 60 * 1000),
        ] {
            write_json(
                &root.join(run(n)).join("run.json"),
                &Manifest {
                    conversation_id: "c".into(),
                    created_at: now - age,
                    bytes: 3 * 1024 * 1024 * 1024,
                },
            )
            .unwrap();
        }
        let saved: Vec<_> = [1, 3, 4].iter().map(|n| run(*n)).collect();
        std::fs::write(
            dir.path().join("workspace.json"),
            serde_json::json!({"conversations":[{"messages":[{"runId":saved[0]},{"runId":saved[1]}],"rewind":{"removed":[{"runId":saved[2]}]}}]}).to_string(),
        )
        .unwrap();
        let pending = Pending::default();
        pending.active.lock().unwrap().insert(run(2));
        prune(&root, &pending);
        let kept: HashSet<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        // Saved runs stay whatever their age or size; 2 is recording, 5 was never saved, and
        // 6 may not be saved yet.
        assert_eq!(
            kept,
            HashSet::from([run(1), run(2), run(3), run(4), run(6)])
        );
        // Without a readable workspace nothing is removed.
        std::fs::write(dir.path().join("workspace.json"), "not json").unwrap();
        prune(&root, &Pending::default());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 5);
    }
}
