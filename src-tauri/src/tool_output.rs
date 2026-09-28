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
/// The largest model file a reply shows: what a window on this computer loads whole, as raw
/// bytes. Senders keep their models at full detail below it instead of shrinking them.
pub const MODEL_BYTES: u64 = 1024 * 1024 * 1024;
/// The largest model another device reads whole, so one relay request carries it. Other
/// devices see a larger one through views this computer's window renders (`MODEL_VIEWS`).
pub const RELAY_MODEL_BYTES: u64 = 12 * 1024 * 1024;
/// Views of a model, a turn apart, for devices that do not read the model itself.
pub const MODEL_VIEWS: usize = 8;
/// The largest view kept, and all of a model's views together, which one relay request
/// carries as base64 with room to spare.
const VIEW_BYTES: u64 = 4 * 1024 * 1024;
const VIEWS_BYTES: u64 = 12 * 1024 * 1024;
/// The widest or tallest view kept.
const VIEW_SIDE: u32 = 4096;
/// The largest image a reply shows, matching one chat attachment.
pub const IMAGE_BYTES: u64 = 16 * 1024 * 1024;
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
impl ImageMeta {
    /// The place of a file a reply shows that could not be kept. Its empty name reads as
    /// not kept, so the files after it keep the numbers the reply gave them.
    fn missing() -> Self {
        Self {
            file: String::new(),
            media_type: String::new(),
            bytes: 0,
            width: None,
            height: None,
        }
    }
}
/// A 3D model a reply shows, kept whole beside the call's images.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelMeta {
    file: String,
    format: String,
    bytes: u64,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    models: Vec<ModelMeta>,
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
/// One 3D model of a call's result as a window receives it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelData {
    pub format: String,
    pub data: String,
    pub bytes: u64,
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
/// A model's kept views, with what rendering them needs: the model's own format and size.
/// `views` stays empty until this computer's window has rendered and kept them.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelViews {
    pub format: String,
    pub bytes: u64,
    /// The version of the window's renderer that drew the kept views.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renderer: Option<u32>,
    pub views: Vec<ImageData>,
}
/// The views kept beside a model, written once they all are.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewsMeta {
    renderer: u32,
    views: Vec<ImageMeta>,
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
/// What a reply shows about a file before its bytes are copied: the type its own first
/// bytes report and its size. The path is checked here, on the computer that runs the
/// conversation, and never opened for its content.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageFile {
    pub media_type: String,
    pub bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
/// Whether a path names a place for ordinary files: an absolute path on a drive or a share,
/// never a device such as a named pipe, which reading could hang on.
fn plain_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    if !path.is_absolute() {
        return false;
    }
    match path.components().next() {
        Some(Component::Prefix(prefix)) => matches!(
            prefix.kind(),
            Prefix::Disk(_) | Prefix::UNC(..) | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(..)
        ),
        _ => true,
    }
}
/// A file the conversation offers to show, checked before its bytes are copied.
fn offered_file(path: &Path, limit: u64) -> Result<std::fs::Metadata, String> {
    if !plain_path(path) {
        return Err("needs an absolute path to a file".into());
    }
    let metadata = std::fs::metadata(path).map_err(|_| "cannot be read here".to_string())?;
    if !metadata.is_file() {
        return Err("is not a file".into());
    }
    if metadata.len() > limit {
        return Err(format!(
            "is {}, larger than the {} a reply can show",
            human(metadata.len()),
            human(limit)
        ));
    }
    Ok(metadata)
}
/// Recognizes a file a conversation offers to show, with the reason when it cannot.
pub fn inspect_image(path: &Path, limit: u64) -> Result<ImageFile, String> {
    let metadata = offered_file(path, limit)?;
    let mut file = std::fs::File::open(path).map_err(|_| "cannot be opened".to_string())?;
    let mut head = Vec::with_capacity(SNIFF_BYTES.min(metadata.len() as usize + 1));
    (&mut file)
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|_| "cannot be read".to_string())?;
    let (media_type, size) = sniff(&head).ok_or("is not a PNG, JPEG, GIF or WebP image")?;
    Ok(ImageFile {
        media_type: media_type.into(),
        bytes: metadata.len(),
        width: size.map(|s| s.0),
        height: size.map(|s| s.1),
    })
}
/// A 3D model a conversation offers to show: the format its own bytes report and its size.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelFile {
    pub format: String,
    pub bytes: u64,
}
/// Recognizes glTF, GLB, OBJ, STL and FBX from a file's own content. A glTF document that
/// names files beside it is refused, because only the file itself is sent.
pub fn inspect_model(path: &Path, limit: u64) -> Result<ModelFile, String> {
    let metadata = offered_file(path, limit)?;
    let size = metadata.len();
    let mut file = std::fs::File::open(path).map_err(|_| "cannot be opened".to_string())?;
    let mut head = Vec::with_capacity(SNIFF_BYTES.min(size as usize + 1));
    (&mut file)
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|_| "cannot be read".to_string())?;
    let format = model_format(&head, size).ok_or(
        "is not a glTF, GLB, OBJ, STL or FBX model, or its content does not match its name",
    )?;
    if format == "gltf" {
        let document = gltf_document(&mut file)?;
        gltf_is_viewable(&document, "glTF document")?;
    } else if format == "glb" {
        // A GLB carries the same document in its first chunk, which may be larger than the
        // sniffed head, so it is read from the file.
        let document = glb_document(&mut file, &head, size)?;
        gltf_is_viewable(&document, "GLB")?;
    }
    Ok(ModelFile {
        format: format.into(),
        bytes: size,
    })
}
/// The model format a file's first bytes report, using its size for binary STL.
fn model_format(head: &[u8], size: u64) -> Option<&'static str> {
    if head.starts_with(b"glTF") {
        return Some("glb");
    }
    if head.starts_with(b"Kaydara FBX Binary") {
        return Some("fbx");
    }
    if size >= 84 && head.len() >= 84 {
        let count = u32::from_le_bytes([head[80], head[81], head[82], head[83]]) as u64;
        if size == 84 + count * 50 {
            return Some("stl");
        }
    }
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    if text.contains("FBXHeaderExtension") {
        return Some("fbx");
    }
    if trimmed.starts_with('{') && text.contains("\"asset\"") {
        return Some("gltf");
    }
    if trimmed.starts_with("solid") && text.contains("facet normal") {
        return Some("stl");
    }
    let obj = trimmed.lines().filter(|line| {
        let line = line.trim_start();
        line.starts_with("v ") || line.starts_with("f ") || line.starts_with("vn ")
    });
    if obj.count() >= 3 {
        return Some("obj");
    }
    None
}
/// What decides whether a glTF document can be shown: where its buffers and images come from
/// and which extensions it lists. Everything else is skipped as the document is read, so a
/// document of hundreds of megabytes with its buffers inline is never held whole.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GltfDocument {
    #[serde(default)]
    buffers: Vec<Resource>,
    #[serde(default)]
    images: Vec<Resource>,
    #[serde(default)]
    extensions_used: Vec<serde_json::Value>,
    #[serde(default)]
    extensions_required: Vec<serde_json::Value>,
}
#[derive(Debug, Deserialize)]
struct Resource {
    #[serde(default)]
    uri: Option<Uri>,
}
/// Where a resource of a glTF document comes from, told without keeping a `data:` URI's bytes.
#[derive(Debug, PartialEq)]
enum Uri {
    Inline,
    Beside,
}
impl<'de> Deserialize<'de> for Uri {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl serde::de::Visitor<'_> for Visitor {
            type Value = Uri;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a URI")
            }
            fn visit_str<E: serde::de::Error>(self, uri: &str) -> Result<Uri, E> {
                Ok(if uri.starts_with("data:") {
                    Uri::Inline
                } else {
                    Uri::Beside
                })
            }
        }
        deserializer.deserialize_str(Visitor)
    }
}
/// A glTF document read from the start of its file, past a byte-order mark as the viewer reads.
fn gltf_document(file: &mut std::fs::File) -> Result<GltfDocument, String> {
    use std::io::BufRead;
    let unreadable = || "is not a readable glTF document".to_string();
    file.seek(SeekFrom::Start(0)).map_err(|_| unreadable())?;
    let mut reader = std::io::BufReader::new(file);
    let marked = reader
        .fill_buf()
        .map_err(|_| unreadable())?
        .starts_with("\u{feff}".as_bytes());
    if marked {
        reader.consume(3);
    }
    serde_json::from_reader(reader).map_err(|_| unreadable())
}
/// The document of a GLB. The container is a 12-byte header (magic, version, total length)
/// and then length-prefixed chunks, the first of which is the document.
fn glb_document(file: &mut std::fs::File, head: &[u8], size: u64) -> Result<GltfDocument, String> {
    let invalid = || "is not a readable GLB file".to_string();
    let word = |at: usize| {
        head.get(at..at + 4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(invalid)
    };
    let version = word(4)?;
    if version != 2 {
        return Err(format!(
            "is a version {version} GLB, which the 3D viewer cannot read; export glTF 2.0"
        ));
    }
    let total = u64::from(word(8)?);
    let length = u64::from(word(12)?);
    if total > size || total < 20 + length || head.get(16..20) != Some(b"JSON".as_slice()) {
        return Err(invalid());
    }
    file.seek(SeekFrom::Start(20)).map_err(|_| invalid())?;
    serde_json::from_reader(std::io::BufReader::new(file.take(length))).map_err(|_| invalid())
}

/// An extension the document cannot be read without, and the viewer cannot read. The viewer
/// parses the bytes it was given and fetches nothing (src/lib/model-scene.ts), so it carries
/// no Draco, meshopt or Basis decoder: those load their own decoder over the network, which
/// is exactly what that viewer refuses to do. Naming them here turns a model that would open
/// as an empty box into a refusal the sender can act on.
fn undecodable_extension(name: &str) -> Option<&'static str> {
    match name {
        "KHR_draco_mesh_compression" => Some("Draco mesh compression"),
        "EXT_meshopt_compression" | "KHR_meshopt_compression" => Some("meshopt compression"),
        "KHR_texture_basisu" => Some("Basis Universal textures"),
        _ => None,
    }
}

/// A glTF document renders only when its buffers and images are inside it and nothing it
/// requires needs a decoder the viewer does not carry.
fn gltf_is_viewable(document: &GltfDocument, kind_name: &str) -> Result<(), String> {
    for (kind, entries) in [("buffers", &document.buffers), ("images", &document.images)] {
        if entries.iter().any(|entry| entry.uri == Some(Uri::Beside)) {
            return Err(format!(
                "is a {kind_name} that loads its {kind} from files beside it; send a self-contained .glb instead"
            ));
        }
    }
    let names = |list: &[serde_json::Value]| {
        list.iter()
            .filter_map(serde_json::Value::as_str)
            .map(String::from)
            .collect::<Vec<_>>()
    };
    // meshopt and Basis fall back to data the document carries unless it requires them, but
    // three.js sets up Draco for any document that lists it as used and fails without a
    // decoder, so Draco is refused whenever it is listed.
    let draco = names(&document.extensions_used)
        .into_iter()
        .filter(|name| name == "KHR_draco_mesh_compression");
    for name in names(&document.extensions_required)
        .into_iter()
        .chain(draco)
    {
        if let Some(compression) = undecodable_extension(&name) {
            return Err(format!(
                "needs {compression} ({name}), which the 3D viewer cannot decode; \
                 export it uncompressed, at full detail: a reply shows models up to {}",
                human(MODEL_BYTES)
            ));
        }
    }
    Ok(())
}
/// Copies `source`, at most `limit` bytes of it when one applies, and fails when there are
/// more: the file may have grown since it was checked.
fn copy_within(
    source: &mut std::fs::File,
    target: &mut impl Write,
    limit: Option<u64>,
) -> Option<u64> {
    let Some(limit) = limit else {
        return std::io::copy(source, target).ok();
    };
    let bytes = std::io::copy(&mut source.take(limit + 1), target).ok()?;
    (bytes <= limit).then_some(bytes)
}
/// Copies a model file the conversation offered, keeping its recognized format.
fn copy_model(path: &Path, directory: &Path, index: usize, limit: u64) -> Option<ModelMeta> {
    let model = inspect_model(path, limit).ok()?;
    let file = format!("model-{index}.{}", model.format);
    let mut source = std::fs::File::open(path).ok()?;
    let mut target = tempfile::NamedTempFile::new_in(directory).ok()?;
    let bytes = copy_within(&mut source, &mut target, Some(limit))?;
    target.persist(directory.join(&file)).ok()?;
    Some(ModelMeta {
        file,
        format: model.format,
        bytes,
    })
}
/// Copies an image file a provider reported viewing or a reply shows: a regular file of a
/// supported type, within `limit` when one applies.
fn copy_image(
    path: &Path,
    directory: &Path,
    index: usize,
    limit: Option<u64>,
) -> Option<ImageMeta> {
    if !plain_path(path) {
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
    let bytes = copy_within(&mut source, &mut target, limit)?;
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
    models: &[Option<PathBuf>],
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
    // Files a reply shows keep their place when one cannot be kept, since the reply names each
    // by its position, and stay within the sizes they were checked against.
    let limit = output.sent.then_some(IMAGE_BYTES);
    for path in files {
        match path
            .as_deref()
            .and_then(|path| copy_image(path, directory, images.len(), limit))
        {
            Some(image) => {
                written += image.bytes;
                images.push(image);
            }
            None if output.sent => images.push(ImageMeta::missing()),
            None => omitted += 1,
        }
    }
    let mut kept = vec![];
    for path in models {
        match path
            .as_deref()
            .and_then(|path| copy_model(path, directory, kept.len(), MODEL_BYTES))
        {
            Some(model) => {
                written += model.bytes;
                kept.push(model);
            }
            None => kept.push(ModelMeta {
                file: String::new(),
                format: String::new(),
                bytes: 0,
            }),
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
        models: kept,
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
                    let mut models = vec![];
                    for path in &output.models {
                        models.push(self.image_path(path).await);
                    }
                    self.write(output, files, models, &slot_key, &slot).await;
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
        models: Vec<Option<PathBuf>>,
        slot_key: &str,
        slot: &Arc<Slot>,
    ) {
        let run = self.root.join(&self.run_id);
        let directory = run.join(key(&output.tool_id));
        let conversation_id = self.conversation_id.clone();
        let created_at = self.created_at;
        let previous = self.bytes;
        let written = tauri::async_runtime::spawn_blocking(move || {
            let bytes = write_call(&directory, &output, &files, &models)?;
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
    let mb = kb / 1024.0;
    if mb < 1024.0 {
        return format!("{mb:.1} MB");
    }
    let gb = mb / 1024.0;
    if gb.fract() == 0.0 {
        format!("{gb:.0} GB")
    } else {
        format!("{gb:.1} GB")
    }
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
                .filter(|(_, image)| !image.file.is_empty())
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

/// A kept model of a call and the path of its file, which is never larger than `limit`.
fn kept_model(
    directory: &Path,
    tool_id: &str,
    index: usize,
    limit: u64,
) -> Result<(ModelMeta, PathBuf), String> {
    let meta = read_meta(directory, tool_id)?;
    let model = meta.models.into_iter().nth(index).ok_or(NOT_KEPT)?;
    // Stored names only; a name never reaches outside the call's folder.
    if model.file.contains(['/', '\\']) || !model.file.starts_with("model-") {
        return Err(NOT_KEPT.to_string());
    }
    let path = directory.join(&model.file);
    let size = std::fs::metadata(&path).map_err(|_| NOT_KEPT)?.len();
    if size > MODEL_BYTES {
        return Err(NOT_KEPT.to_string());
    }
    if size > limit {
        return Err(format!(
            "This model is {}, larger than the {} another device reads whole; it shows views of it instead.",
            human(size),
            human(limit)
        ));
    }
    Ok((model, path))
}

/// One 3D model of a call's result, whole, for a window on another device: as base64 within
/// what one relay request carries.
pub async fn read_model(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<ModelData, String> {
    valid_request(&run_id, &tool_id)?;
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        let (model, path) = kept_model(&directory, &tool_id, index, RELAY_MODEL_BYTES)?;
        let bytes = std::fs::read(&path).map_err(|_| NOT_KEPT)?;
        Ok(ModelData {
            format: model.format,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            bytes: bytes.len() as u64,
        })
    })
    .await
    .map_err(|_| "Cannot read the tool output".to_string())?
}

/// One 3D model of a call's result, whole and however large, as raw bytes for a window on
/// this computer, which loads it without the base64 a relay request needs.
pub async fn read_model_file(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<Vec<u8>, String> {
    valid_request(&run_id, &tool_id)?;
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        let (_, path) = kept_model(&directory, &tool_id, index, MODEL_BYTES)?;
        std::fs::read(&path).map_err(|_| NOT_KEPT.to_string())
    })
    .await
    .map_err(|_| "Cannot read the tool output".to_string())?
}

/// The file listing a model's kept views, written after them.
fn views_file(index: usize) -> String {
    format!("model-{index}-views.json")
}
/// Views kept beside a model, whole, or none when any of them is missing or unreadable.
fn kept_views(directory: &Path, index: usize) -> Option<(u32, Vec<ImageData>)> {
    let path = directory.join(views_file(index));
    if std::fs::metadata(&path).ok()?.len() > META_LIMIT {
        return None;
    }
    let meta: ViewsMeta = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    let prefix = format!("model-{index}-view-");
    let views = meta
        .views
        .iter()
        .map(|view| {
            // Stored names only; a name never reaches outside the call's folder.
            if view.file.contains(['/', '\\']) || !view.file.starts_with(&prefix) {
                return None;
            }
            let bytes = std::fs::read(directory.join(&view.file)).ok()?;
            let (media_type, _) = sniff(&bytes)?;
            Some(ImageData {
                media_type: media_type.into(),
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
                bytes: bytes.len() as u64,
                width: view.width,
                height: view.height,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    (views.len() == MODEL_VIEWS).then_some((meta.renderer, views))
}

/// A model's views as this computer keeps them for other devices, with the model's format and
/// size, which rendering them needs when none are kept yet.
pub async fn read_model_views(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    index: usize,
) -> Result<ModelViews, String> {
    valid_request(&run_id, &tool_id)?;
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        let (model, path) = kept_model(&directory, &tool_id, index, MODEL_BYTES)?;
        let bytes = std::fs::metadata(&path).map_err(|_| NOT_KEPT)?.len();
        let (renderer, views) = kept_views(&directory, index).unzip();
        Ok(ModelViews {
            format: model.format,
            bytes,
            renderer,
            views: views.unwrap_or_default(),
        })
    })
    .await
    .map_err(|_| "Cannot read the tool output".to_string())?
}

/// Keeps the views this computer's window rendered of one of its models, beside the model,
/// so other devices get them without another rendering until the call's result goes. Each
/// must be a PNG, JPEG or WebP image within the size one relay request carries for all of
/// them, and there must be exactly `MODEL_VIEWS`.
pub async fn store_model_views(
    root: PathBuf,
    pending: Arc<Pending>,
    run_id: String,
    tool_id: String,
    index: usize,
    renderer: u32,
    views: Vec<String>,
) -> Result<(), String> {
    valid_request(&run_id, &tool_id)?;
    if views.len() != MODEL_VIEWS {
        return Err(format!("A model has {MODEL_VIEWS} views"));
    }
    written(&pending, &run_id, &tool_id).await;
    let directory = root.join(&run_id).join(key(&tool_id));
    tauri::async_runtime::spawn_blocking(move || {
        kept_model(&directory, &tool_id, index, MODEL_BYTES)?;
        let mut decoded = vec![];
        let mut total = 0;
        for data in &views {
            if data.len() as u64 > VIEW_BYTES / 3 * 4 + 4 {
                return Err("A view is too large to keep".to_string());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "A view is not an image")?;
            let (media_type, size) = sniff(&bytes)
                .filter(|(media_type, _)| *media_type != "image/gif")
                .ok_or("A view is not a PNG, JPEG or WebP image")?;
            let (width, height) = size.ok_or("A view has no readable size")?;
            if width == 0 || height == 0 || width > VIEW_SIDE || height > VIEW_SIDE {
                return Err("A view is too large to keep".into());
            }
            total += bytes.len() as u64;
            if bytes.len() as u64 > VIEW_BYTES || total > VIEWS_BYTES {
                return Err("The views are too large to keep".into());
            }
            decoded.push((bytes, media_type, width, height));
        }
        // Earlier views are unlisted before any is replaced, so none is read half replaced.
        let _ = std::fs::remove_file(directory.join(views_file(index)));
        let mut kept = vec![];
        for (view, (bytes, media_type, width, height)) in decoded.into_iter().enumerate() {
            let file = format!("model-{index}-view-{view}.{}", extension(media_type));
            write_file(&directory.join(&file), &bytes)?;
            kept.push(ImageMeta {
                file,
                media_type: media_type.into(),
                bytes: bytes.len() as u64,
                width: Some(width),
                height: Some(height),
            });
        }
        write_json(
            &directory.join(views_file(index)),
            &ViewsMeta {
                renderer,
                views: kept,
            },
        )?;
        Ok(())
    })
    .await
    .map_err(|_| "Cannot keep the views".to_string())?
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
            models: vec![],
            sent: false,
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

    /// The smallest valid GLB: a header, a JSON chunk and a binary chunk.
    fn glb(json: &str) -> Vec<u8> {
        let mut chunk = json.as_bytes().to_vec();
        while !chunk.len().is_multiple_of(4) {
            chunk.push(b' ');
        }
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2u32.to_le_bytes());
        bytes.extend((12 + 8 + chunk.len() as u32).to_le_bytes());
        bytes.extend((chunk.len() as u32).to_le_bytes());
        bytes.extend(b"JSON");
        bytes.extend(chunk);
        bytes
    }

    #[test]
    fn models_are_recognized_by_their_own_content() {
        assert_eq!(model_format(&glb("{}"), 40), Some("glb"));
        assert_eq!(model_format(b"Kaydara FBX Binary  \0", 200), Some("fbx"));
        assert_eq!(
            model_format(b"; FBX 7.4\nFBXHeaderExtension: {", 200),
            Some("fbx")
        );
        assert_eq!(
            model_format(b"{\n \"asset\": {\"version\": \"2.0\"}\n}", 30),
            Some("gltf")
        );
        assert_eq!(
            model_format(b"solid cube\n facet normal 0 0 1\n", 30),
            Some("stl")
        );
        assert_eq!(
            model_format(b"# cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", 40),
            Some("obj")
        );
        // Binary STL is recognized by the triangle count its header reports.
        let mut stl = vec![0u8; 84];
        stl[80] = 1;
        stl.extend(vec![0u8; 50]);
        assert_eq!(model_format(&stl, stl.len() as u64), Some("stl"));
        assert_eq!(model_format(&stl[..84], 134), Some("stl"));
        assert_eq!(model_format(PNG, PNG.len() as u64), None);
        assert_eq!(model_format(b"just some notes\n", 16), None);
    }

    #[test]
    fn a_gltf_document_that_needs_files_beside_it_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let self_contained = dir.path().join("scene.gltf");
        std::fs::write(
            &self_contained,
            r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AA=="}]}"#,
        )
        .unwrap();
        assert_eq!(
            inspect_model(&self_contained, MODEL_BYTES).map(|m| m.format),
            Ok("gltf".into())
        );
        let external = dir.path().join("external.gltf");
        std::fs::write(
            &external,
            r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"scene.bin"}]}"#,
        )
        .unwrap();
        let error = inspect_model(&external, MODEL_BYTES).unwrap_err();
        assert!(
            error.contains("send a self-contained .glb instead"),
            "{error}"
        );
        // A GLB carries the same document, so the same two faults are caught there: the
        // viewer decodes nothing it would have to fetch a decoder for, and a Draco GLB used
        // to reach the reader as a box that could not be opened.
        let compressed = dir.path().join("compressed.glb");
        std::fs::write(
            &compressed,
            glb(
                r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"],"extensionsRequired":["KHR_draco_mesh_compression"]}"#,
            ),
        )
        .unwrap();
        let error = inspect_model(&compressed, MODEL_BYTES).unwrap_err();
        assert!(error.contains("Draco mesh compression"), "{error}");
        assert!(error.contains("export it uncompressed"), "{error}");
        let binary_external = dir.path().join("external.glb");
        std::fs::write(
            &binary_external,
            glb(r#"{"asset":{"version":"2.0"},"buffers":[{"uri":"scene.bin"}]}"#),
        )
        .unwrap();
        let error = inspect_model(&binary_external, MODEL_BYTES).unwrap_err();
        assert!(error.contains("loads its buffers"), "{error}");
        // meshopt the document merely uses has fallback data beside it and still opens, and
        // an extension the viewer implements itself is never refused. three.js sets up Draco
        // for any document that lists it, so a listed Draco is refused even when optional.
        let optional = dir.path().join("optional.glb");
        std::fs::write(
            &optional,
            glb(
                r#"{"asset":{"version":"2.0"},"extensionsUsed":["EXT_meshopt_compression"],"extensionsRequired":["KHR_materials_specular"]}"#,
            ),
        )
        .unwrap();
        assert_eq!(
            inspect_model(&optional, MODEL_BYTES).map(|m| m.format),
            Ok("glb".into())
        );
        for (name, document) in [
            (
                "draco.glb",
                r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_draco_mesh_compression"]}"#,
            ),
            (
                "meshopt.glb",
                r#"{"asset":{"version":"2.0"},"extensionsUsed":["KHR_meshopt_compression"],"extensionsRequired":["KHR_meshopt_compression"]}"#,
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, glb(document)).unwrap();
            let error = inspect_model(&path, MODEL_BYTES).unwrap_err();
            assert!(
                error.contains("the 3D viewer cannot decode"),
                "{name}: {error}"
            );
        }
        // Size, kind and path are reported before anything is copied.
        let big = dir.path().join("big.glb");
        std::fs::write(&big, glb(&format!("{{\"x\":\"{}\"}}", "0".repeat(2048)))).unwrap();
        let error = inspect_model(&big, 512).unwrap_err();
        assert!(error.contains("larger than"), "{error}");
        assert!(inspect_model(&dir.path().join("gone.glb"), MODEL_BYTES).is_err());
        assert!(inspect_model(Path::new("relative.glb"), MODEL_BYTES).is_err());
        // A GLB is read by its own header: a glTF 1.0 container and a cut file are named.
        let mut version_one = glb(r#"{"asset":{"version":"1.0"}}"#);
        version_one[4] = 1;
        let old = dir.path().join("old.glb");
        std::fs::write(&old, version_one).unwrap();
        let error = inspect_model(&old, MODEL_BYTES).unwrap_err();
        assert!(error.contains("version 1 GLB"), "{error}");
        let mut cut = glb(r#"{"asset":{"version":"2.0"}}"#);
        cut.truncate(cut.len() - 4);
        let truncated = dir.path().join("truncated.glb");
        std::fs::write(&truncated, cut).unwrap();
        let error = inspect_model(&truncated, MODEL_BYTES).unwrap_err();
        assert!(error.contains("not a readable GLB file"), "{error}");
        // The document is read whole past the sniffed head, where a buffer beside the file
        // listed after a long node list used to go unnoticed.
        let nodes = vec![r#"{"name":"part"}"#; SNIFF_BYTES / 10].join(",");
        let large = dir.path().join("large.glb");
        std::fs::write(
            &large,
            glb(&format!(
                r#"{{"asset":{{"version":"2.0"}},"nodes":[{nodes}],"buffers":[{{"uri":"scene.bin"}}]}}"#
            )),
        )
        .unwrap();
        let error = inspect_model(&large, MODEL_BYTES).unwrap_err();
        assert!(error.contains("loads its buffers"), "{error}");
        // A byte-order mark before a glTF document is read past, as the viewer does.
        let marked = dir.path().join("marked.gltf");
        std::fs::write(&marked, "\u{feff}{\"asset\":{\"version\":\"2.0\"}}").unwrap();
        assert_eq!(
            inspect_model(&marked, MODEL_BYTES).map(|m| m.format),
            Ok("gltf".into())
        );
    }

    #[test]
    fn a_document_is_checked_as_it_is_read() {
        let dir = tempfile::tempdir().unwrap();
        // A buffer inline for megabytes is only seen to be inline, and a texture beside the
        // document after it is still found.
        let data = "A".repeat(3 * 1024 * 1024);
        let inline = dir.path().join("inline.gltf");
        std::fs::write(
            &inline,
            format!(
                r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"uri":"data:application/octet-stream;base64,{data}"}}],"images":[{{"uri":"texture.png"}}]}}"#
            ),
        )
        .unwrap();
        let error = inspect_model(&inline, MODEL_BYTES).unwrap_err();
        assert!(error.contains("loads its images"), "{error}");
        let embedded = dir.path().join("embedded.glb");
        std::fs::write(
            &embedded,
            glb(&format!(
                r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"uri":"data:application/octet-stream;base64,{data}"}}]}}"#
            )),
        )
        .unwrap();
        assert_eq!(
            inspect_model(&embedded, MODEL_BYTES).map(|m| m.format),
            Ok("glb".into())
        );
        // A URI that is not text, or a document cut short, is no readable document.
        for (name, document) in [
            (
                "number.gltf",
                r#"{"asset":{"version":"2.0"},"buffers":[{"uri":5}]}"#,
            ),
            ("cut.gltf", r#"{"asset":{"version":"2.0"},"buffers":["#),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, document).unwrap();
            let error = inspect_model(&path, MODEL_BYTES).unwrap_err();
            assert!(
                error.contains("not a readable glTF document"),
                "{name}: {error}"
            );
        }
        // Sizes past a megabyte read in the unit a person would use.
        assert_eq!(human(MODEL_BYTES), "1 GB");
        assert_eq!(human(3 * MODEL_BYTES / 2), "1.5 GB");
        assert_eq!(human(RELAY_MODEL_BYTES), "12.0 MB");
    }

    #[test]
    fn only_places_for_ordinary_files_are_offered() {
        assert!(!plain_path(Path::new("relative.png")));
        #[cfg(windows)]
        {
            assert!(plain_path(Path::new(r"C:\renders\front.png")));
            assert!(plain_path(Path::new(r"\\server\share\front.png")));
            assert!(plain_path(Path::new(
                r"\\wsl.localhost\Ubuntu\home\front.png"
            )));
            assert!(plain_path(Path::new(r"\\?\C:\renders\front.png")));
            // Devices, which a read could hang on, are never files a reply shows.
            assert!(!plain_path(Path::new(r"\\.\pipe\agent")));
            assert!(!plain_path(Path::new(r"\\?\GLOBALROOT\Device\Null")));
        }
        #[cfg(not(windows))]
        assert!(plain_path(Path::new("/home/me/front.png")));
    }

    #[test]
    fn a_copy_stops_at_the_size_its_file_was_checked_against() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grown.png");
        std::fs::write(&path, [7u8; 10]).unwrap();
        let copy = |limit| {
            let mut source = std::fs::File::open(&path).unwrap();
            let mut target = vec![];
            copy_within(&mut source, &mut target, limit).map(|bytes| (bytes, target.len()))
        };
        assert_eq!(copy(None), Some((10, 10)));
        assert_eq!(copy(Some(10)), Some((10, 10)));
        assert_eq!(copy(Some(9)), None);
    }

    #[tokio::test]
    async fn models_are_kept_beside_images_and_read_whole() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let mut captured = output("claude:model");
        captured.images.clear();
        let model = dir.path().join("figure.glb");
        let bytes = glb(r#"{"asset":{"version":"2.0"}}"#);
        std::fs::write(&model, &bytes).unwrap();
        captured.models = vec![model.to_string_lossy().into()];
        let directory = root.join(RUN).join(key("claude:model"));
        write_call(
            &directory,
            &captured,
            &[],
            &[Some(dir.path().join("missing.glb")), Some(model)],
        )
        .unwrap();
        let data = read_model(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:model".into(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(data.format, "glb");
        assert_eq!(data.bytes, bytes.len() as u64);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&data.data)
                .unwrap(),
            bytes
        );
        // An unreadable path is not kept, and the model after it keeps the number the reply
        // gave it; no other index appears.
        for index in [0, 2] {
            assert!(read_model(
                root.clone(),
                pending.clone(),
                RUN.into(),
                "claude:model".into(),
                index
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn a_model_larger_than_one_relay_request_opens_only_on_its_computer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let mut captured = output("claude:large");
        captured.images.clear();
        // Kept whole at full detail, a little past what one relay request carries.
        let mut bytes = glb(r#"{"asset":{"version":"2.0"}}"#);
        bytes.resize(RELAY_MODEL_BYTES as usize + 4096, 0);
        let model = dir.path().join("large.glb");
        std::fs::write(&model, &bytes).unwrap();
        assert_eq!(
            inspect_model(&model, MODEL_BYTES).map(|m| m.bytes),
            Ok(bytes.len() as u64)
        );
        captured.models = vec![model.to_string_lossy().into()];
        let directory = root.join(RUN).join(key("claude:large"));
        write_call(&directory, &captured, &[], &[Some(model)]).unwrap();
        // This computer's window reads the raw bytes.
        let raw = read_model_file(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:large".into(),
            0,
        )
        .await
        .unwrap();
        assert!(raw == bytes);
        // Another device is told to show views instead of receiving it through the relay.
        let error = read_model(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:large".into(),
            0,
        )
        .await
        .unwrap_err();
        assert!(error.contains("another device reads whole"), "{error}");
        assert!(error.contains("views"), "{error}");
        assert!(
            read_model_file(root, pending, RUN.into(), "claude:large".into(), 1)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn views_are_kept_beside_their_model_for_other_devices() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let mut captured = output("claude:views");
        captured.images.clear();
        let model = dir.path().join("figure.glb");
        std::fs::write(&model, glb(r#"{"asset":{"version":"2.0"}}"#)).unwrap();
        captured.models = vec![model.to_string_lossy().into()];
        let directory = root.join(RUN).join(key("claude:views"));
        write_call(
            &directory,
            &captured,
            &[],
            &[Some(model), Some(dir.path().join("gone.glb"))],
        )
        .unwrap();
        let read = |index| {
            read_model_views(
                root.clone(),
                pending.clone(),
                RUN.into(),
                "claude:views".into(),
                index,
            )
        };
        let store = |index, views: Vec<String>| {
            store_model_views(
                root.clone(),
                pending.clone(),
                RUN.into(),
                "claude:views".into(),
                index,
                1,
                views,
            )
        };
        // None are kept at first, and the window learns what it needs to draw them.
        let first = read(0).await.unwrap();
        assert_eq!(first.format, "glb");
        assert_eq!((first.renderer, first.views.len()), (None, 0));
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let png = encode(PNG);
        // Exactly eight PNG, JPEG or WebP pictures are kept, and only beside a kept model.
        assert!(store(0, vec![png.clone(); 7]).await.is_err());
        let mut animated = vec![png.clone(); 7];
        animated.push(encode(b"GIF89a\x04\x00\x03\x00rest"));
        assert!(store(0, animated).await.is_err());
        assert!(store(0, vec!["not base64!".into(); 8]).await.is_err());
        assert!(store(1, vec![png.clone(); 8]).await.is_err());
        assert!(store(2, vec![png.clone(); 8]).await.is_err());
        let mut large = PNG.to_vec();
        large.resize(VIEWS_BYTES as usize / 7, 0);
        let error = store(0, vec![encode(&large); 8]).await.unwrap_err();
        assert!(error.contains("too large"), "{error}");
        assert!(read(0).await.unwrap().views.is_empty());
        store(0, vec![png.clone(); 8]).await.unwrap();
        let kept = read(0).await.unwrap();
        assert_eq!(kept.renderer, Some(1));
        assert_eq!(kept.views.len(), MODEL_VIEWS);
        assert!(kept.views.iter().all(|view| view.media_type == "image/png"
            && view.data == png
            && (view.width, view.height) == (Some(4), Some(3))));
        // A view that goes missing leaves none listed, so the window draws them again.
        std::fs::remove_file(directory.join("model-0-view-3.png")).unwrap();
        assert!(read(0).await.unwrap().views.is_empty());
        // Views go with the call's result when it is recorded again.
        store(0, vec![png.clone(); 8]).await.unwrap();
        write_call(&directory, &captured, &[], &[]).unwrap();
        assert!(read(0).await.is_err());
    }

    #[tokio::test]
    async fn images_a_reply_shows_keep_their_numbers_when_one_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(DIRECTORY);
        let pending = Arc::new(Pending::default());
        let mut captured = CapturedOutput::new("claude:sent");
        captured.sent = true;
        let file = dir.path().join("shot.png");
        std::fs::write(&file, PNG).unwrap();
        let files = [Some(dir.path().join("gone.png")), Some(file)];
        let directory = root.join(RUN).join(key("claude:sent"));
        write_call(&directory, &captured, &files, &[]).unwrap();
        let view = read(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:sent".into(),
            false,
        )
        .await
        .unwrap();
        // The reply numbers the second file 1, so it is read as 1.
        let indexes: Vec<_> = view.images.iter().map(|image| image.index).collect();
        assert_eq!((indexes, view.images_omitted), (vec![1], 0));
        let image = read_image(
            root.clone(),
            pending.clone(),
            RUN.into(),
            "claude:sent".into(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(image.media_type, "image/png");
        assert_eq!(
            read_image(root, pending, RUN.into(), "claude:sent".into(), 0).await,
            Err(NOT_KEPT.into())
        );
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
        write_call(&directory, &captured, &files, &[]).unwrap();
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
        write_call(&root.join(RUN).join(key("claude:long")), &long, &[], &[]).unwrap();
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
