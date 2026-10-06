//! Chats the Claude Code and Codex CLIs saved on this computer, imported as conversations.
//!
//! Every account keeps its own sessions: a separate profile in its own directory, while the
//! terminal and the desktop apps share their environment's default CLI directory. A source is
//! one of those directories on this computer or one of its managed WSL distributions. Listing
//! reads bounded metadata and hands out opaque keys, so a native session id or transcript path
//! never comes from a window. Importing reads one session whole through the decoders a live
//! reply uses, keeps its images and tool results on this computer, and records where it came
//! from in `imports/<conversation>.json`. The conversation's first reply then forks that
//! session into the selected account's profile (`sessions::Session::prepare`), so the model
//! keeps its native context and the original stays as it was in its app.
use crate::protocol::{activity::CapturedOutput, RunEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

mod claude;
mod codex;

/// Sessions one source lists at most, newest first.
const LISTED: usize = 5_000;
const OUT_OF_DATE: &str = "This list of chats is out of date. Refresh it and try again.";

/// Inputs Agent Studio sends ahead of a prompt: context, never the person's own words.
const STUDIO_CONTEXT: [&str; 4] = [
    claude::STUDIO_GUIDANCE,
    "Current user instructions for this conversation",
    "Delivery of this earlier user message was interrupted",
    "Account context sharing is now disabled",
];
pub(crate) fn studio_context(text: &str) -> bool {
    STUDIO_CONTEXT.iter().any(|prefix| text.starts_with(prefix))
}

pub enum ImageInput {
    Base64(String),
    /// A file the CLI reported, on the source's own computer.
    File(String),
}
pub struct UserInput {
    pub text: String,
    pub images: Vec<ImageInput>,
    pub created_at: Option<String>,
}
pub struct Reply {
    pub events: Vec<RunEvent>,
    pub outputs: Vec<CapturedOutput>,
    pub status: &'static str,
    pub error: Option<String>,
    pub created_at: Option<String>,
    pub duration_ms: Option<u64>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    /// Messages the person sent while the reply ran.
    pub steering: Vec<String>,
}
pub struct Turn {
    pub user: Option<UserInput>,
    pub reply: Option<Reply>,
}
pub struct Conversion {
    pub title: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub cwd: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub turns: Vec<Turn>,
    pub notes: Vec<String>,
}

/// The newest state of each call, progress message and reasoning block, where it first
/// appeared: a reply read at once needs none of the states in between.
pub(crate) fn coalesce(events: Vec<RunEvent>) -> Vec<RunEvent> {
    let mut kept: Vec<Option<RunEvent>> = vec![];
    let mut places: HashMap<String, usize> = HashMap::new();
    for event in events {
        let key = match &event {
            RunEvent::Tool { tool } => Some(format!("tool\n{}", tool.id)),
            RunEvent::Progress { id, .. } => Some(format!("progress\n{id}")),
            RunEvent::Reasoning { id, .. } => Some(format!("reasoning\n{id}")),
            RunEvent::Compaction { compaction } => Some(format!("compaction\n{}", compaction.id)),
            RunEvent::Plan { .. } => Some("plan".into()),
            RunEvent::FileChanges { .. } => Some("files".into()),
            RunEvent::NativeWorkflow { .. } => Some("workflows".into()),
            RunEvent::Text { .. } => Some("text".into()),
            RunEvent::Usage { .. } => Some("usage".into()),
            RunEvent::Activity { .. } => continue,
            _ => None,
        };
        match key.and_then(|key| match places.get(&key) {
            Some(index) => Some(*index),
            None => {
                places.insert(key, kept.len());
                None
            }
        }) {
            Some(index) => kept[index] = Some(event),
            None => kept.push(Some(event)),
        }
    }
    kept.into_iter().flatten().collect()
}

/// A session store.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub provider: String,
    pub environment_id: String,
    /// An account's separate profile; absent for the environment's default CLI directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}
impl Source {
    fn id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.provider,
            self.environment_id,
            self.connection_id.as_deref().unwrap_or("default")
        )
    }
    fn parse(id: &str) -> Option<Self> {
        let mut parts = id.splitn(3, ':');
        let provider = parts.next()?;
        let environment = parts.next()?;
        let connection = parts.next()?;
        if !matches!(provider, "claude" | "codex") || uuid::Uuid::parse_str(environment).is_err() {
            return None;
        }
        Some(Self {
            provider: provider.into(),
            environment_id: environment.into(),
            connection_id: match connection {
                "default" => None,
                id => Some(uuid::Uuid::parse_str(id).ok()?.to_string()),
            },
        })
    }
}

/// Where an import came from, kept beside the conversation's native session binding.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u32,
    pub source: Source,
    pub session: String,
    pub imported_at: u64,
    /// A Claude transcript's path inside its source profile, as it was imported: a session the
    /// desktop app moved can be in two project folders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// A Claude transcript in one of `root`'s project folders, named for `session`.
pub(crate) fn transcript_in(root: &Path, path: &Path, session: &str) -> Option<PathBuf> {
    let projects = root.join("projects").canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    let named = path.file_name() == Some(std::ffi::OsStr::new(&format!("{session}.jsonl")));
    (named && path.parent().and_then(Path::parent) == Some(projects.as_path()) && path.is_file())
        .then_some(path)
}

fn records_dir(root: &Path) -> PathBuf {
    root.join("imports")
}

/// The import record of a conversation, if it was imported on this computer.
pub fn record(root: &Path, conversation: &str) -> Result<Option<Record>, String> {
    let conversation =
        uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    let path = records_dir(root).join(format!("{conversation}.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() <= 16_000 => bytes,
        Ok(_) => return Err("This chat's import record is unreadable".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read this chat's import record".into()),
    };
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| "This chat's import record is unreadable")?;
    if record.version != 1 || uuid::Uuid::parse_str(&record.session).is_err() {
        return Err("This chat's import record is unreadable".into());
    }
    Ok(Some(record))
}

pub(crate) fn write_record(root: &Path, conversation: &str, record: &Record) -> Result<(), String> {
    use std::io::Write;
    let directory = records_dir(root);
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot keep the import record")?;
    let mut file =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| "Cannot keep the import record")?;
    file.write_all(&serde_json::to_vec(record).map_err(|_| "Cannot keep the import record")?)
        .map_err(|_| "Cannot keep the import record")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot keep the import record")?;
    file.persist_noclobber(directory.join(format!("{conversation}.json")))
        .map_err(|_| "This conversation was already imported".to_string())?;
    Ok(())
}

/// The profile of a source, resolved from this computer's own registry.
pub(crate) fn source_profile(
    app: &tauri::AppHandle,
    source: &Source,
) -> Result<crate::profiles::Profile, String> {
    match &source.connection_id {
        Some(connection) => {
            let profile = crate::profiles::resolve(app, &source.provider, Some(connection))?;
            let local = crate::profiles::installation(app)?;
            let expected = if source.environment_id == local.id {
                None
            } else {
                crate::profiles::environment_profile(app, &source.provider, &source.environment_id)?
                    .distribution
            };
            if profile.distribution != expected {
                return Err(
                    "This account no longer belongs to the computer its chats came from".into(),
                );
            }
            Ok(profile)
        }
        None => crate::profiles::environment_profile(app, &source.provider, &source.environment_id),
    }
}

/// The directory a source's sessions live in, found without its CLI.
pub(crate) async fn source_root(
    app: &tauri::AppHandle,
    source: &Source,
) -> Result<PathBuf, String> {
    let profile = source_profile(app, source)?;
    let provider = source.provider.clone();
    crate::profiles::scope(profile, async move {
        crate::context::profile_store(&provider).await
    })
    .await
}

struct Entry {
    source: Source,
    session: String,
    /// A Claude transcript, found by this listing inside its source.
    path: Option<PathBuf>,
    cwd: String,
    account: Option<String>,
    /// The WSL distribution a Windows app recorded for the chat's Linux folder.
    recorded: Option<String>,
}

/// Listings and the keys they handed out, for this run of the app.
pub struct Catalog {
    salt: String,
    entries: Mutex<HashMap<String, Entry>>,
    summaries: Mutex<HashMap<PathBuf, (u64, u128, claude::Summary)>>,
    organizations: Mutex<HashMap<String, (std::time::Instant, Option<String>)>>,
    /// Held while accounts report their organizations, so listings read together ask once.
    checking: tokio::sync::Mutex<()>,
}
impl Default for Catalog {
    fn default() -> Self {
        Self {
            salt: uuid::Uuid::new_v4().to_string(),
            entries: Mutex::default(),
            summaries: Mutex::default(),
            organizations: Mutex::default(),
            checking: tokio::sync::Mutex::default(),
        }
    }
}
impl Catalog {
    fn digest(&self, value: &str) -> String {
        let digest = Sha256::digest(format!("{}\n{value}", self.salt));
        digest[..16].iter().map(|b| format!("{b:02x}")).collect()
    }
    fn key(&self, source: &Source, session: &str) -> String {
        self.digest(&format!("{}\n{session}", source.id()))
    }
    /// Shared by the copies of one session in several sources, as account switches copy a
    /// Codex thread into another profile.
    fn session(&self, provider: &str, session: &str) -> String {
        self.digest(&format!("session\n{provider}\n{session}"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    id: String,
    provider: String,
    environment_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    key: String,
    session: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    origin: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    /// Why the chat can be read here but not continued.
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable: Option<String>,
    /// The conversation that already holds this session.
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    imported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChats {
    source: String,
    chats: Vec<Chat>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    truncated: bool,
}

fn app_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data".into())
}

fn fleet(app: &tauri::AppHandle) -> Result<Value, String> {
    crate::saved::fleet(
        &app_root(app)?,
        "Save Connections before importing chats",
        "Cannot read the connection registry",
    )
}

fn list<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value[key].as_array().into_iter().flatten()
}

fn connection_provider<'a>(fleet: &'a Value, connection: &Value) -> Option<&'a str> {
    list(fleet, "accounts")
        .find(|a| a["id"] == connection["accountId"])
        .and_then(|a| a["provider"].as_str())
}

/// Environments whose CLIs this computer runs: its own and the WSL distributions it manages.
fn managed_environments(fleet: &Value, local: &str) -> Vec<Value> {
    list(fleet, "environments")
        .filter(|e| {
            e["id"] == local
                || (cfg!(windows) && e["platform"] == "wsl" && e["discoveredOn"] == local)
        })
        .cloned()
        .collect()
}

/// `default_exists(provider, distribution)` says whether an environment's default CLI directory
/// holds chats without an account connected there: this computer's (no distribution), or a
/// distribution's that a Windows app ran chats in.
fn sources_in(
    fleet: &Value,
    local: &str,
    default_exists: &dyn Fn(&str, Option<&str>) -> bool,
    linked: &dyn Fn(&Value) -> bool,
) -> Vec<Source> {
    let mut sources = vec![];
    for provider in ["claude", "codex"] {
        for environment in managed_environments(fleet, local) {
            let environment_id = environment["id"].as_str().unwrap_or_default();
            let connections: Vec<_> = list(fleet, "connections")
                .filter(|c| {
                    c["environmentId"] == environment_id
                        && connection_provider(fleet, c) == Some(provider)
                })
                .collect();
            let distribution = environment["distribution"].as_str();
            if !connections.is_empty()
                || (environment_id == local && default_exists(provider, None))
                || (environment_id != local
                    && distribution.is_some_and(|d| default_exists(provider, Some(d))))
            {
                sources.push(Source {
                    provider: provider.into(),
                    environment_id: environment_id.into(),
                    connection_id: None,
                });
            }
            for connection in connections {
                // A profile linked to the environment's own Claude directory keeps its chats
                // there, which the environment's own source lists.
                if connection["profile"] == "isolated" && !linked(connection) {
                    if let Some(id) = connection["id"].as_str() {
                        sources.push(Source {
                            provider: provider.into(),
                            environment_id: environment_id.into(),
                            connection_id: Some(id.into()),
                        });
                    }
                }
            }
        }
    }
    sources
}

fn default_exists(provider: &str, distribution: Option<&str>) -> bool {
    if let Some(distribution) = distribution {
        // The Claude desktop app keeps the chats it ran in WSL in the distribution's own directory.
        return provider == "claude" && claude::desktop_distributions().contains(distribution);
    }
    let variable = if provider == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    let root = std::env::var_os(variable).map(PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|home| {
            PathBuf::from(home).join(if provider == "codex" {
                ".codex"
            } else {
                ".claude"
            })
        })
    });
    root.is_some_and(|root| {
        root.join(if provider == "codex" {
            "sessions"
        } else {
            "projects"
        })
        .is_dir()
    })
}

/// Whether a Claude connection's profile keeps its chats in its environment's own Claude
/// directory (`linking`): a profile in a managed WSL distribution is linked by its launch, and one
/// on this computer once its folders are.
fn linked_profile(fleet: &Value, connection: &Value, local: &str, data: &Path) -> bool {
    if connection_provider(fleet, connection) != Some("claude")
        || connection["profile"] != "isolated"
        || connection.get("sharedContextConnectionId").is_some()
        || connection["sharedContext"] == "none"
    {
        return false;
    }
    if connection["environmentId"] != local {
        return true;
    }
    let (Some(id), Some(source)) = (
        connection["id"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok()),
        crate::context::native_default_root("claude"),
    ) else {
        return false;
    };
    crate::linking::folders_linked(&data.join("profiles").join("claude").join(id), &source)
}

/// The sources of this computer and its WSL distributions, read off the async runtime.
async fn current_sources(fleet: &Value, local: &str, data: &Path) -> Result<Vec<Source>, String> {
    let (fleet, local, data) = (fleet.clone(), local.to_string(), data.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || {
        sources_in(&fleet, &local, &default_exists, &|connection| {
            linked_profile(&fleet, connection, &local, &data)
        })
    })
    .await
    .map_err(|_| "Cannot find this computer's chats".into())
}

/// The sources of this computer and its WSL distributions.
pub async fn sources(app: &tauri::AppHandle) -> Result<Vec<SourceView>, String> {
    let local = crate::profiles::installation(app)?;
    let fleet = fleet(app)?;
    Ok(current_sources(&fleet, &local.id, &app_root(app)?)
        .await?
        .into_iter()
        .map(|source| SourceView {
            id: source.id(),
            provider: source.provider,
            environment_id: source.environment_id,
            connection_id: source.connection_id,
        })
        .collect())
}

/// Sessions already in this workspace: bound to a conversation's native session, or imported
/// from any copy of the session (the desktop app keeps a WSL chat in two places).
#[derive(Default)]
struct Known {
    bound: HashMap<String, String>,
    /// By provider and session.
    imported: HashMap<(String, String), String>,
}
impl Known {
    fn read(root: &Path) -> Self {
        let mut known = Self::default();
        let existing: HashSet<String> = crate::saved::bytes(root)
            .ok()
            .and_then(|bytes| crate::saved::conversations(&bytes))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|c| c.id.as_str().map(String::from))
            .collect();
        let files = |directory: PathBuf| {
            std::fs::read_dir(directory)
                .into_iter()
                .flatten()
                .flatten()
                .take(200_000)
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let conversation = name.strip_suffix(".json")?.to_string();
                    existing
                        .contains(&conversation)
                        .then(|| (conversation, entry.path()))
                })
                .collect::<Vec<_>>()
        };
        for (conversation, path) in files(root.join("native-sessions")) {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if let Some(id) = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v["id"].as_str().map(String::from))
            {
                known.bound.insert(id, conversation);
            }
        }
        for (conversation, _) in files(records_dir(root)) {
            if let Ok(Some(record)) = record(root, &conversation) {
                known
                    .imported
                    .insert((record.source.provider, record.session), conversation);
            }
        }
        known
    }
    fn conversation(&self, provider: &str, session: &str) -> (Option<String>, bool) {
        if let Some(conversation) = self
            .imported
            .get(&(provider.to_string(), session.to_string()))
        {
            return (Some(conversation.clone()), true);
        }
        (self.bound.get(session).cloned(), false)
    }
}

fn windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || path.starts_with("\\\\")
}

/// A Windows path into a WSL distribution: its name and the Linux path.
fn wsl_share(path: &str) -> Option<(String, String)> {
    let lower = path.to_lowercase();
    let rest = [
        "\\\\wsl.localhost\\",
        "\\\\wsl$\\",
        "//wsl.localhost/",
        "//wsl$/",
    ]
    .iter()
    .find_map(|prefix| lower.starts_with(prefix).then(|| &path[prefix.len()..]))?;
    let (distribution, linux) = rest.split_once(['\\', '/']).unwrap_or((rest, ""));
    Some((
        distribution.to_string(),
        format!("/{}", linux.replace('\\', "/").trim_start_matches('/')),
    ))
}

/// How Windows reaches a folder of a WSL distribution.
fn share_path(distribution: &str, linux: &str) -> PathBuf {
    PathBuf::from(format!(
        "\\\\wsl.localhost\\{distribution}{}",
        linux.replace('/', "\\")
    ))
}

/// The Windows folder of a path on a drive WSL mounts: `/mnt/c/Users` is `C:\Users`.
fn mounted_drive(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/mnt/")?;
    let mut chars = rest.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    let folder = chars.as_str();
    if !(folder.is_empty() || folder.starts_with('/')) {
        return None;
    }
    Some(format!(
        "{}:\\{}",
        drive.to_ascii_uppercase(),
        folder.trim_start_matches('/').replace('/', "\\")
    ))
}

#[derive(Clone)]
struct Placement {
    location: Value,
    /// The environment whose CLI continues the chat.
    execution: String,
    missing: bool,
}

/// Where imported chats open: in the folder each one ran in, run where that folder is, as the
/// Claude app runs a chat. A folder in a WSL distribution runs inside that distribution with its
/// Linux CLI, though a Windows app made the chat, and a folder on this computer, including a
/// drive WSL mounts, with this computer's CLI.
struct Places<'a> {
    fleet: &'a Value,
    local: &'a str,
    folder: &'a dyn Fn(&Path) -> bool,
    checked: HashMap<PathBuf, bool>,
}
impl<'a> Places<'a> {
    fn new(fleet: &'a Value, local: &'a str) -> Self {
        Self {
            fleet,
            local,
            folder: &|path| path.is_dir(),
            checked: HashMap::new(),
        }
    }
    fn exists(&mut self, path: PathBuf) -> bool {
        let folder = self.folder;
        *self
            .checked
            .entry(path)
            .or_insert_with_key(|path| folder(path))
    }
    fn environment(&self, id: &str) -> Option<&Value> {
        list(self.fleet, "environments").find(|e| e["id"] == id)
    }
    /// The distributions this computer manages.
    fn distributions(&self) -> Vec<String> {
        list(self.fleet, "environments")
            .filter(|e| e["platform"] == "wsl" && e["discoveredOn"] == self.local)
            .filter_map(|e| e["distribution"].as_str().map(String::from))
            .collect()
    }
    /// `recorded` is the distribution a Windows app recorded for the chat's Linux folder.
    fn place(&mut self, source: &str, cwd: &str, recorded: Option<&str>) -> Option<Placement> {
        let environment = self.environment(source)?.clone();
        if cwd.is_empty() || cwd.len() > 4096 || cwd.chars().any(char::is_control) {
            return None;
        }
        if source != self.local {
            let distribution = environment["distribution"].as_str()?.to_string();
            if !cwd.starts_with('/') {
                return None;
            }
            let missing = !self.exists(share_path(&distribution, cwd));
            return self.in_wsl(&distribution, cwd, missing);
        }
        if let Some((distribution, linux)) = wsl_share(cwd) {
            let missing = !self.exists(PathBuf::from(cwd));
            return self.in_wsl(&distribution, &linux, missing);
        }
        let windows = mounted_drive(cwd).or_else(|| windows_absolute(cwd).then(|| cwd.to_string()));
        if let Some(path) = windows {
            return Some(Placement {
                missing: !self.exists(PathBuf::from(&path)),
                location: json!({"computerId":environment["computerId"].as_str()?,"environmentId":self.local,"path":path}),
                execution: self.local.to_string(),
            });
        }
        if !cwd.starts_with('/') {
            return None;
        }
        // A Windows app ran this chat in a Linux folder, through WSL: the distribution it
        // recorded, or else the one that has the folder.
        let distributions = self.distributions();
        if let Some(named) = recorded.filter(|named| distributions.iter().any(|d| d == named)) {
            let missing = !self.exists(share_path(named, cwd));
            return self.in_wsl(named, cwd, missing);
        }
        for distribution in &distributions {
            if self.exists(share_path(distribution, cwd)) {
                return self.in_wsl(distribution, cwd, false);
            }
        }
        self.in_wsl(distributions.first()?, cwd, true)
    }
    /// A folder of one of this computer's distributions, run by that distribution's own CLI.
    fn in_wsl(&self, distribution: &str, linux: &str, missing: bool) -> Option<Placement> {
        let wsl = list(self.fleet, "environments").find(|e| {
            e["platform"] == "wsl"
                && e["discoveredOn"] == self.local
                && e["distribution"] == distribution
        })?;
        Some(Placement {
            location: json!({"computerId":wsl["computerId"],"environmentId":wsl["id"],"path":linux}),
            execution: wsl["id"].as_str()?.to_string(),
            missing,
        })
    }
}

/// The account that made a chat, or whose profile holds it, by name, when that account has no
/// connection of this agent on the environment that continues the chat.
fn absent_account(
    fleet: &Value,
    provider: &str,
    execution: &str,
    own: Option<&str>,
    account: Option<&str>,
) -> Option<String> {
    let own_account = own.and_then(|own| {
        list(fleet, "connections")
            .find(|c| c["id"] == own)
            .and_then(|c| c["accountId"].as_str())
    });
    let wanted = account.or(own_account)?;
    let connected = list(fleet, "connections").any(|c| {
        c["environmentId"] == execution
            && c["accountId"] == wanted
            && connection_provider(fleet, c) == Some(provider)
    });
    (!connected).then(|| {
        list(fleet, "accounts")
            .find(|a| a["id"] == wanted)
            .and_then(|a| a["name"].as_str())
            .unwrap_or("the account that made it")
            .to_string()
    })
}

/// The account a chat continues with: on the environment that runs it, the source's own
/// account, the account that made it, or that environment's CLI login.
fn choose_connection(
    fleet: &Value,
    provider: &str,
    execution: &str,
    own: Option<&str>,
    account: Option<&str>,
) -> Option<String> {
    let candidates: Vec<&Value> = list(fleet, "connections")
        .filter(|c| {
            c["environmentId"] == execution && connection_provider(fleet, c) == Some(provider)
        })
        .collect();
    let id = |c: &&Value| c["id"].as_str().map(String::from);
    if let Some(own) = own {
        if let Some(found) = candidates.iter().find(|c| c["id"] == own) {
            return id(found);
        }
    }
    let own_account = own.and_then(|own| {
        list(fleet, "connections")
            .find(|c| c["id"] == own)
            .and_then(|c| c["accountId"].as_str())
    });
    for wanted in [account, own_account].into_iter().flatten() {
        if let Some(found) = candidates.iter().find(|c| c["accountId"] == wanted) {
            return id(found);
        }
    }
    candidates
        .iter()
        .find(|c| c["profile"] == "existing")
        .or(candidates.first())
        .and_then(id)
}

/// The computer an environment is, as Connections names it: a WSL distribution by its own name.
fn computer_name(fleet: &Value, environment: &str) -> String {
    let environment = list(fleet, "environments").find(|e| e["id"] == environment);
    let name = match environment {
        Some(e) if e["platform"] == "wsl" => e["name"].as_str(),
        Some(e) => list(fleet, "computers")
            .find(|c| c["id"] == e["computerId"])
            .and_then(|c| c["name"].as_str()),
        None => None,
    };
    name.unwrap_or("this computer").to_string()
}

fn claude_origin(summary: &claude::Summary, desktop: bool, path: &Path) -> &'static str {
    let remote = path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|folder| folder.to_string_lossy().starts_with("ssh-"));
    if summary.studio {
        "studio"
    } else if desktop || remote {
        "desktop"
    } else {
        match summary.entrypoint.as_deref() {
            Some("claude-desktop") => "desktop",
            Some("cli") => "cli",
            Some(entry) if entry.starts_with("sdk") => "sdk",
            Some(entry) if entry.contains("vscode") || entry.contains("jetbrains") => "ide",
            _ => "other",
        }
    }
}

fn codex_origin(thread: &codex::Thread) -> &'static str {
    match (thread.originator.as_deref(), thread.source.as_str()) {
        (Some("agent_studio"), _) => "studio",
        (Some("Codex Desktop"), _) => "desktop",
        (Some("codex_exec"), _) | (_, "exec") => "exec",
        (Some("codex_vscode"), _) | (_, "vscode") => "ide",
        (Some("codex-tui" | "codex_cli_rs"), _) | (_, "cli") => "cli",
        _ => "other",
    }
}

fn short_title(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let start: String = chars.by_ref().take(99).collect();
    if chars.next().is_some() {
        format!("{}…", start.trim_end())
    } else {
        start
    }
}

/// Organizations of this computer's Claude accounts, by fleet account id, from each one's own
/// CLI status. The Claude desktop app files its Code sessions under the account's organization.
async fn organizations(
    app: &tauri::AppHandle,
    catalog: &Catalog,
    fleet: &Value,
    local: &str,
) -> HashMap<String, String> {
    let environments: Vec<String> = managed_environments(fleet, local)
        .iter()
        .filter_map(|e| e["id"].as_str().map(String::from))
        .collect();
    let connections: Vec<(String, String)> = list(fleet, "connections")
        .filter(|c| {
            connection_provider(fleet, c) == Some("claude")
                && c["environmentId"]
                    .as_str()
                    .is_some_and(|e| environments.iter().any(|m| m == e))
        })
        .filter_map(|c| Some((c["id"].as_str()?.into(), c["accountId"].as_str()?.into())))
        .collect();
    let _checking = catalog.checking.lock().await;
    let mut found = HashMap::new();
    let mut checks = vec![];
    for (connection, account) in connections {
        let cached = catalog
            .organizations
            .lock()
            .ok()
            .and_then(|known| known.get(&connection).cloned())
            .filter(|(at, _)| at.elapsed() < std::time::Duration::from_secs(600));
        if let Some((_, organization)) = cached {
            if let Some(organization) = organization {
                found.insert(organization, account);
            }
            continue;
        }
        let app = app.clone();
        checks.push((
            connection.clone(),
            account,
            tauri::async_runtime::spawn(async move {
                let profile = crate::profiles::resolve(&app, "claude", Some(&connection)).ok()?;
                crate::profiles::scope(profile, crate::providers::claude_organization()).await
            }),
        ));
    }
    for (connection, account, check) in checks {
        let organization = check.await.ok().flatten();
        if let Ok(mut known) = catalog.organizations.lock() {
            known.insert(
                connection,
                (std::time::Instant::now(), organization.clone()),
            );
        }
        if let Some(organization) = organization {
            found.insert(organization, account);
        }
    }
    found
}

/// One source's chats, newest first.
pub async fn chats(
    app: &tauri::AppHandle,
    catalog: &Catalog,
    source_id: &str,
) -> Result<SourceChats, String> {
    let source = Source::parse(source_id).ok_or("Unknown chat source")?;
    let local = crate::profiles::installation(app)?;
    let fleet = fleet(app)?;
    if !current_sources(&fleet, &local.id, &app_root(app)?)
        .await?
        .contains(&source)
    {
        return Err("This chat source is no longer on this computer".into());
    }
    let root = source_root(app, &source).await?;
    let data = app_root(app)?;
    let known = tauri::async_runtime::spawn_blocking(move || Known::read(&data))
        .await
        .map_err(|_| "Cannot read this workspace's chats")?;
    // The desktop app's chats are in an environment's default directory: this computer's, or a
    // WSL distribution's for the chats it ran there.
    let desktop_store = source.provider == "claude" && source.connection_id.is_none();
    let (sessions, truncated) = if source.provider == "claude" {
        let cached: HashMap<PathBuf, (u64, u128, claude::Summary)> = catalog
            .summaries
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let scan_root = root.clone();
        let (summaries, truncated) = tauri::async_runtime::spawn_blocking(move || {
            let (files, truncated) = claude::sessions(&scan_root, LISTED);
            let summaries: Vec<(PathBuf, u64, u128, claude::Summary)> = files
                .into_iter()
                .filter_map(|(path, bytes, modified)| {
                    let summary = match cached.get(&path) {
                        Some((b, m, s)) if *b == bytes && *m == modified => s.clone(),
                        _ => claude::summarize(&path, bytes)?,
                    };
                    Some((path, bytes, modified, summary))
                })
                .collect();
            (summaries, truncated)
        })
        .await
        .map_err(|_| "Cannot read Claude's chats")?;
        if let Ok(mut cache) = catalog.summaries.lock() {
            if cache.len() > 50_000 {
                cache.clear();
            }
            for (path, bytes, modified, summary) in &summaries {
                cache.insert(path.clone(), (*bytes, *modified, summary.clone()));
            }
        }
        let desktop = if desktop_store {
            tauri::async_runtime::spawn_blocking(claude::desktop_index)
                .await
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        let accounts = if desktop.is_empty() {
            HashMap::new()
        } else {
            organizations(app, catalog, &fleet, &local.id).await
        };
        let sessions = summaries
            .into_iter()
            .map(|(path, bytes, _, summary)| {
                let index = desktop.get(&summary.session);
                let title = summary
                    .title
                    .clone()
                    .or_else(|| index.and_then(|d| d.title.clone()))
                    .or_else(|| summary.prompt.as_deref().map(short_title))
                    .unwrap_or_else(|| "Untitled chat".into());
                Listed {
                    session: summary.session.clone(),
                    title,
                    preview: summary.prompt.clone(),
                    cwd: summary
                        .cwd
                        .clone()
                        .or_else(|| index.and_then(|d| d.cwd.clone()))
                        .unwrap_or_default(),
                    created: summary.created.clone(),
                    updated: summary.updated.clone(),
                    model: summary.model.clone(),
                    origin: claude_origin(&summary, index.is_some(), &path),
                    archived: index.is_some_and(|d| d.archived),
                    bytes: Some(bytes),
                    account: index.and_then(|d| accounts.get(&d.organization).cloned()),
                    recorded: index.and_then(|d| d.distribution.clone()),
                    path: Some(path),
                }
            })
            .collect::<Vec<_>>();
        (sessions, truncated)
    } else {
        // A profile without threads lists none, even where Codex is not installed.
        let store = root.clone();
        let empty = tauri::async_runtime::spawn_blocking(move || {
            !store.join("sessions").is_dir() && !store.join("archived_sessions").is_dir()
        })
        .await
        .map_err(|_| "Cannot read Codex's chats")?;
        let profile = source_profile(app, &source)?;
        let (threads, truncated) = if empty {
            (vec![], false)
        } else {
            crate::profiles::scope(profile, codex::list(LISTED)).await?
        };
        let sessions = threads
            .into_iter()
            .map(|thread| Listed {
                recorded: None,
                title: thread
                    .name
                    .clone()
                    .or_else(|| thread.preview.as_deref().map(short_title))
                    .unwrap_or_else(|| "Untitled chat".into()),
                preview: thread.preview.clone(),
                cwd: thread.cwd.clone(),
                created: codex::iso(thread.created),
                updated: codex::iso(thread.updated),
                model: thread.model.clone(),
                origin: codex_origin(&thread),
                archived: thread.archived,
                bytes: None,
                account: None,
                path: None,
                session: thread.id,
            })
            .collect::<Vec<_>>();
        (sessions, truncated)
    };
    let placed = {
        let fleet = fleet.clone();
        let local = local.id.clone();
        let source = source.clone();
        let chats: Vec<(String, Option<String>)> = sessions
            .iter()
            .map(|s| (s.cwd.clone(), s.recorded.clone()))
            .collect();
        tauri::async_runtime::spawn_blocking(move || {
            let mut places = Places::new(&fleet, &local);
            chats
                .iter()
                .map(|(cwd, recorded)| {
                    places.place(&source.environment_id, cwd, recorded.as_deref())
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|_| "Cannot check this computer's folders")?
    };
    let mut entries = vec![];
    let mut chats = vec![];
    for (listed, placement) in sessions.into_iter().zip(placed) {
        let (conversation_id, imported) = known.conversation(&source.provider, &listed.session);
        let connection_id = placement.as_ref().and_then(|p| {
            choose_connection(
                &fleet,
                &source.provider,
                &p.execution,
                source.connection_id.as_deref(),
                listed.account.as_deref(),
            )
        });
        let unavailable = match &placement {
            None => Some("This chat has no folder this computer can open.".to_string()),
            Some(p) if p.missing => Some(format!(
                "Its folder, {}, is not on this computer.",
                listed.cwd
            )),
            Some(p) if connection_id.is_none() => Some(format!(
                "Connect a {} account on {} to continue it.",
                if source.provider == "codex" {
                    "Codex"
                } else {
                    "Claude"
                },
                computer_name(&fleet, &p.execution)
            )),
            Some(p) => absent_account(
                &fleet,
                &source.provider,
                &p.execution,
                source.connection_id.as_deref(),
                listed.account.as_deref(),
            )
            .map(|account| {
                format!(
                    "Connect {account} on {} to continue it with the account that made it.",
                    computer_name(&fleet, &p.execution)
                )
            }),
        };
        let key = catalog.key(&source, &listed.session);
        entries.push((
            key.clone(),
            Entry {
                source: source.clone(),
                session: listed.session.clone(),
                path: listed.path.clone(),
                cwd: listed.cwd.clone(),
                account: listed.account.clone(),
                recorded: listed.recorded.clone(),
            },
        ));
        chats.push(Chat {
            key,
            session: catalog.session(&source.provider, &listed.session),
            title: listed.title,
            preview: listed.preview,
            path: listed.cwd,
            created_at: listed.created,
            updated_at: listed.updated,
            model: listed.model,
            origin: if conversation_id.is_some() && !imported {
                "studio"
            } else {
                listed.origin
            },
            archived: listed.archived,
            bytes: listed.bytes,
            location: placement.map(|p| p.location),
            connection_id,
            unavailable,
            conversation_id,
            imported,
        });
    }
    if let Ok(mut catalog_entries) = catalog.entries.lock() {
        if catalog_entries.len() > 200_000 {
            catalog_entries.clear();
        }
        catalog_entries.extend(entries);
    }
    Ok(SourceChats {
        source: source.id(),
        chats,
        truncated,
    })
}

struct Listed {
    session: String,
    title: String,
    preview: Option<String>,
    cwd: String,
    created: Option<String>,
    updated: Option<String>,
    model: Option<String>,
    origin: &'static str,
    archived: bool,
    bytes: Option<u64>,
    account: Option<String>,
    recorded: Option<String>,
    path: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    id: String,
    name: String,
    media_type: &'static str,
    hash: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMessage {
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    images: Vec<ImageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    events: Vec<RunEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    title: String,
    provider: String,
    model: String,
    reasoning: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_id: Option<String>,
    created_at: String,
    updated_at: String,
    messages: Vec<ImportedMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notes: Vec<String>,
}

fn valid_model(model: Option<String>) -> Option<String> {
    model.filter(|m| {
        !m.is_empty() && m.len() <= 100 && !m.starts_with('-') && !m.chars().any(char::is_control)
    })
}

fn valid_reasoning(provider: &str, reasoning: Option<String>) -> Option<String> {
    let allowed: &[&str] = if provider == "codex" {
        &[
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
    } else {
        &["low", "medium", "high", "xhigh", "max"]
    };
    reasoning.filter(|r| allowed.contains(&r.as_str()))
}

/// The bytes of an image the session holds or names, on the computer that kept it.
fn image_bytes(image: &ImageInput, distribution: Option<&str>) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Read;
    match image {
        ImageInput::Base64(data) => {
            if data.len() > crate::chat_images::MAX_IMAGE_BYTES.div_ceil(3) * 4 {
                return None;
            }
            STANDARD.decode(data).ok()
        }
        ImageInput::File(path) => {
            let path = match distribution {
                Some(distribution) if path.starts_with('/') => share_path(distribution, path),
                _ => PathBuf::from(path),
            };
            let file = std::fs::File::open(path).ok()?;
            if !file.metadata().ok()?.is_file() {
                return None;
            }
            let mut bytes = vec![];
            file.take(crate::chat_images::MAX_IMAGE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            Some(bytes)
        }
    }
}

fn now_iso() -> String {
    chrono::DateTime::from_timestamp_millis(now_ms() as i64)
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// One session, read whole into a conversation that continues it.
pub async fn import(
    app: &tauri::AppHandle,
    catalog: &Catalog,
    key: &str,
    conversation_id: &str,
    connection_id: Option<String>,
) -> Result<Imported, String> {
    let conversation =
        uuid::Uuid::parse_str(conversation_id).map_err(|_| "Invalid conversation id")?;
    let conversation = conversation.to_string();
    let data = app_root(app)?;
    let exists = crate::saved::bytes(&data)
        .ok()
        .and_then(|bytes| crate::saved::conversations(&bytes))
        .unwrap_or_default()
        .iter()
        .any(|c| c.id == conversation.as_str());
    if exists
        || data
            .join("native-sessions")
            .join(format!("{conversation}.json"))
            .exists()
        || record(&data, &conversation)?.is_some()
    {
        return Err("Import each chat into a new conversation".into());
    }
    let (source, session, path, listed_cwd, account, recorded) = {
        let entries = catalog.entries.lock().map_err(|_| OUT_OF_DATE)?;
        let entry = entries.get(key).ok_or(OUT_OF_DATE)?;
        (
            entry.source.clone(),
            entry.session.clone(),
            entry.path.clone(),
            entry.cwd.clone(),
            entry.account.clone(),
            entry.recorded.clone(),
        )
    };
    let local = crate::profiles::installation(app)?;
    let fleet = fleet(app)?;
    if !current_sources(&fleet, &local.id, &app_root(app)?)
        .await?
        .contains(&source)
    {
        return Err("This chat source is no longer on this computer".into());
    }
    let profile = source_profile(app, &source)?;
    let mut distribution = profile.distribution.clone();
    let root = source_root(app, &source).await?;
    let mut transcript = None;
    let conversion = if source.provider == "claude" {
        let path = path.ok_or(OUT_OF_DATE)?;
        // The transcript the listing found, still inside its profile.
        let (found, relative) = {
            let root = root.clone();
            let session = session.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let found = transcript_in(&root, &path, &session)?;
                let relative = found.strip_prefix(root.canonicalize().ok()?).ok()?;
                Some((found.clone(), relative.to_string_lossy().into_owned()))
            })
            .await
            .map_err(|_| "Cannot read this chat")?
            .ok_or("This chat is no longer in its CLI profile")?
        };
        transcript = Some(relative);
        tauri::async_runtime::spawn_blocking(move || claude::convert(&found))
            .await
            .map_err(|_| "Cannot read this chat")??
    } else {
        let (thread, turns) = crate::profiles::scope(profile, codex::read(&session)).await?;
        if thread["id"] != session.as_str() {
            return Err("Codex returned another chat".into());
        }
        tauri::async_runtime::spawn_blocking(move || codex::convert(&thread, &turns))
            .await
            .map_err(|_| "Cannot read this chat")?
    };
    if conversion.turns.is_empty() {
        return Err("This chat has no messages to import".into());
    }
    let cwd = conversion
        .cwd
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or(listed_cwd);
    let placement = {
        let fleet = fleet.clone();
        let local = local.id.clone();
        let environment = source.environment_id.clone();
        let cwd = cwd.clone();
        tauri::async_runtime::spawn_blocking(move || {
            Places::new(&fleet, &local).place(&environment, &cwd, recorded.as_deref())
        })
        .await
        .map_err(|_| "Cannot check this chat's folder")?
    };
    // A Windows app that ran the chat in WSL named its files by their Linux paths there.
    if distribution.is_none() {
        distribution = placement.as_ref().and_then(|p| {
            let environment = p.location["environmentId"].as_str()?;
            list(&fleet, "environments")
                .find(|e| e["id"] == environment && e["platform"] == "wsl")?["distribution"]
                .as_str()
                .map(String::from)
        });
    }
    let connection_id = match (connection_id, &placement) {
        (Some(requested), Some(placement)) => {
            let valid = list(&fleet, "connections").any(|c| {
                c["id"] == requested.as_str()
                    && c["environmentId"] == placement.execution.as_str()
                    && connection_provider(&fleet, c) == Some(source.provider.as_str())
            });
            if !valid {
                return Err(
                    "Choose an account of this agent on the computer that holds the chat".into(),
                );
            }
            Some(requested)
        }
        (None, Some(placement)) => choose_connection(
            &fleet,
            &source.provider,
            &placement.execution,
            source.connection_id.as_deref(),
            account.as_deref(),
        ),
        (_, None) => return Err("This chat has no folder this computer can open".into()),
    };
    let mut notes = conversion.notes;
    let fallback_time = conversion
        .created
        .clone()
        .or_else(|| conversion.updated.clone())
        .unwrap_or_else(now_iso);
    let images_root = crate::chat_images::root(app)?;
    let mut messages = vec![];
    let mut skipped_images = 0;
    let mut recorders = vec![];
    for turn in conversion.turns {
        if let Some(user) = turn.user {
            let mut images = vec![];
            for image in user
                .images
                .iter()
                .take(crate::providers::MAX_IMAGES_PER_MESSAGE)
            {
                let stored = image_bytes(image, distribution.as_deref())
                    .and_then(|bytes| crate::chat_images::store(&images_root, &bytes).ok());
                match stored {
                    Some(stored) => {
                        let extension = stored
                            .media_type
                            .trim_start_matches("image/")
                            .replace("jpeg", "jpg");
                        images.push(ImageRef {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: format!("image-{}.{extension}", images.len() + 1),
                            media_type: stored.media_type,
                            hash: stored.hash,
                            bytes: stored.bytes,
                        });
                    }
                    None => skipped_images += 1,
                }
            }
            skipped_images += user
                .images
                .len()
                .saturating_sub(crate::providers::MAX_IMAGES_PER_MESSAGE);
            let text = if user.text.is_empty() && images.is_empty() {
                "An image that could not be imported".to_string()
            } else {
                user.text
            };
            messages.push(ImportedMessage {
                role: "user",
                text: Some(text),
                images,
                run_id: None,
                status: "complete",
                error: None,
                created_at: user.created_at.unwrap_or_else(|| fallback_time.clone()),
                duration_ms: None,
                model: None,
                reasoning: None,
                events: vec![],
            });
        }
        if let Some(reply) = turn.reply {
            let run_id = uuid::Uuid::new_v4().to_string();
            let mut events = reply.events;
            for (index, text) in reply.steering.into_iter().enumerate() {
                events.push(RunEvent::Steering {
                    steering: crate::providers::steering::Receipt {
                        id: uuid::Uuid::new_v4().to_string(),
                        text,
                        run_id: run_id.clone(),
                        sequence: index + 1,
                    },
                });
            }
            if !reply.outputs.is_empty() {
                if let Some(recorder) =
                    crate::tool_output::Recorder::new(app, &conversation, &run_id)
                {
                    recorder.distribution(distribution.clone());
                    for output in reply.outputs {
                        recorder.record(output);
                    }
                    recorders.push(recorder);
                }
            }
            messages.push(ImportedMessage {
                role: "assistant",
                text: None,
                images: vec![],
                run_id: Some(run_id),
                status: reply.status,
                error: reply.error,
                created_at: reply.created_at.unwrap_or_else(|| fallback_time.clone()),
                duration_ms: reply.duration_ms,
                model: valid_model(reply.model),
                reasoning: valid_reasoning(&source.provider, reply.reasoning),
                events,
            });
        }
    }
    // Each recorder's worker finishes writing its results once the last handle goes.
    drop(recorders);
    if skipped_images > 0 {
        notes.push(format!(
            "{skipped_images} {} could not be imported.",
            if skipped_images == 1 {
                "image"
            } else {
                "images"
            }
        ));
    }
    write_record(
        &data,
        &conversation,
        &Record {
            version: 1,
            source: source.clone(),
            session,
            imported_at: now_ms(),
            path: transcript,
        },
    )?;
    let first_prompt = messages
        .iter()
        .find_map(|m| m.text.as_deref())
        .map(short_title);
    let title: String = conversion
        .title
        .map(|t| short_title(&t))
        .or(first_prompt)
        .unwrap_or_else(|| "Imported chat".into());
    let updated = conversion
        .updated
        .clone()
        .or_else(|| messages.last().map(|m| m.created_at.clone()))
        .unwrap_or_else(|| fallback_time.clone());
    Ok(Imported {
        title,
        provider: source.provider.clone(),
        model: valid_model(conversion.model).unwrap_or_default(),
        reasoning: valid_reasoning(&source.provider, conversion.reasoning).unwrap_or_default(),
        location: placement.map(|p| p.location),
        connection_id,
        created_at: fallback_time,
        updated_at: updated,
        messages,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fleet() -> Value {
        json!({
            "computers": [{"id": "c0000000-0000-4000-8000-000000000001", "name": "Desktop"}],
            "environments": [
                {"id": "e0000000-0000-4000-8000-000000000001", "computerId": "c0000000-0000-4000-8000-000000000001", "name": "Windows", "platform": "windows"},
                {"id": "e0000000-0000-4000-8000-000000000002", "computerId": "c0000000-0000-4000-8000-000000000001", "name": "Ubuntu", "platform": "wsl", "distribution": "Ubuntu", "discoveredOn": "e0000000-0000-4000-8000-000000000001"},
                {"id": "e0000000-0000-4000-8000-000000000003", "computerId": "c0000000-0000-4000-8000-000000000009", "name": "Laptop", "platform": "macos"},
                {"id": "e0000000-0000-4000-8000-000000000004", "computerId": "c0000000-0000-4000-8000-000000000001", "name": "Debian", "platform": "wsl", "distribution": "Debian", "discoveredOn": "e0000000-0000-4000-8000-000000000001"}
            ],
            "accounts": [
                {"id": "a1", "name": "Work", "provider": "claude", "purpose": "work"},
                {"id": "a2", "name": "Personal", "provider": "claude", "purpose": "personal"},
                {"id": "a3", "name": "Codex", "provider": "codex", "purpose": "personal"}
            ],
            "connections": [
                {"id": "10000000-0000-4000-8000-000000000001", "accountId": "a1", "environmentId": "e0000000-0000-4000-8000-000000000001", "profile": "existing"},
                {"id": "10000000-0000-4000-8000-000000000002", "accountId": "a2", "environmentId": "e0000000-0000-4000-8000-000000000001", "profile": "isolated"},
                {"id": "10000000-0000-4000-8000-000000000003", "accountId": "a2", "environmentId": "e0000000-0000-4000-8000-000000000002", "profile": "existing"},
                {"id": "10000000-0000-4000-8000-000000000004", "accountId": "a3", "environmentId": "e0000000-0000-4000-8000-000000000003", "profile": "existing"}
            ]
        })
    }
    const COMPUTER: &str = "c0000000-0000-4000-8000-000000000001";
    const LOCAL: &str = "e0000000-0000-4000-8000-000000000001";
    const WSL: &str = "e0000000-0000-4000-8000-000000000002";
    const DEBIAN: &str = "e0000000-0000-4000-8000-000000000004";

    #[test]
    fn every_account_profile_and_default_directory_on_this_computer_is_a_source() {
        let exists = |provider: &str, distribution: Option<&str>| {
            match distribution {
                None => provider == "codex",
                // The Claude desktop app ran chats in Debian, where no account is connected.
                Some(distribution) => provider == "claude" && distribution == "Debian",
            }
        };
        let sources = sources_in(&fleet(), LOCAL, &exists, &|_| false);
        let ids: Vec<String> = sources.iter().map(Source::id).collect();
        // A profile linked to this computer's Claude directory keeps its chats in the
        // computer's own source, which lists them once.
        let linked: Vec<String> = sources_in(&fleet(), LOCAL, &exists, &|connection| {
            connection["id"] == "10000000-0000-4000-8000-000000000002"
        })
        .iter()
        .map(Source::id)
        .collect();
        assert_eq!(
            linked,
            ids.iter()
                .filter(|id| !id.ends_with("10000000-0000-4000-8000-000000000002"))
                .cloned()
                .collect::<Vec<_>>()
        );
        assert_eq!(
            ids,
            [
                format!("claude:{LOCAL}:default"),
                format!("claude:{LOCAL}:10000000-0000-4000-8000-000000000002"),
                format!("claude:{WSL}:default"),
                format!("claude:{DEBIAN}:default"),
                format!("codex:{LOCAL}:default"),
            ]
        );
        // Another computer's accounts are read there, never here.
        assert!(!ids
            .iter()
            .any(|id| id.contains("e0000000-0000-4000-8000-000000000003")));
        for id in &ids {
            assert_eq!(Source::parse(id).unwrap().id(), *id);
        }
        assert!(Source::parse("gemini:e0000000-0000-4000-8000-000000000001:default").is_none());
        assert!(Source::parse(&format!("claude:{LOCAL}:../escape")).is_none());
    }

    #[test]
    fn chats_run_where_their_folder_is_and_continue_with_their_own_account() {
        let fleet = fleet();
        let existing = [
            "C:\\Projects\\game",
            "C:\\Users\\me",
            "\\\\wsl.localhost\\Ubuntu\\home\\me\\app",
            "\\\\wsl.localhost\\Debian\\srv\\api",
        ];
        let folders = |path: &Path| existing.contains(&path.to_string_lossy().as_ref());
        let mut places = Places::new(&fleet, LOCAL);
        places.folder = &folders;
        let windows = places.place(LOCAL, "C:\\Projects\\game", None).unwrap();
        assert!(!windows.missing);
        assert_eq!(
            windows.location,
            json!({"computerId": COMPUTER, "environmentId": LOCAL, "path": "C:\\Projects\\game"})
        );
        assert_eq!(windows.execution, LOCAL);
        assert!(places.place(LOCAL, "D:\\Gone", None).unwrap().missing);
        // A Windows app's chat in a WSL folder runs inside that distribution, as the Claude app
        // runs it, with the folder's Linux path.
        let linux = places.place(LOCAL, "/home/me/app", None).unwrap();
        assert_eq!(
            linux.location,
            json!({"computerId": COMPUTER, "environmentId": WSL, "path": "/home/me/app"})
        );
        assert_eq!(linux.execution, WSL);
        assert!(!linux.missing);
        let share = places
            .place(LOCAL, "\\\\wsl.localhost\\Ubuntu\\home\\me\\app", None)
            .unwrap();
        assert_eq!(share.location, linux.location);
        assert_eq!(share.execution, WSL);
        // In the distribution the app recorded, even when another has a folder of that name.
        let api = places.place(LOCAL, "/srv/api", Some("Debian")).unwrap();
        assert_eq!(api.location["environmentId"], DEBIAN);
        assert_eq!(api.execution, DEBIAN);
        assert!(!api.missing);
        let moved = places.place(LOCAL, "/home/me/app", Some("Debian")).unwrap();
        assert_eq!(moved.execution, DEBIAN);
        assert!(moved.missing);
        // A distribution this computer no longer manages leaves the one that has the folder.
        assert_eq!(
            places
                .place(LOCAL, "/home/me/app", Some("Arch"))
                .unwrap()
                .location,
            linux.location
        );
        // A folder no distribution has can still be imported to read.
        let lost = places.place(LOCAL, "/opt/lost", None).unwrap();
        assert!(lost.missing);
        assert_eq!(lost.execution, WSL);
        // A drive WSL mounts is this computer's own folder.
        assert_eq!(
            places
                .place(LOCAL, "/mnt/c/Users/me", None)
                .unwrap()
                .location,
            json!({"computerId": COMPUTER, "environmentId": LOCAL, "path": "C:\\Users\\me"})
        );
        assert!(places
            .place(LOCAL, "\\\\wsl$\\Fedora\\home", None)
            .is_none());
        // A chat a distribution keeps runs there, whichever app made it.
        let kept = places.place(WSL, "/home/me/app", None).unwrap();
        assert_eq!(kept.location, linux.location);
        assert_eq!(kept.execution, WSL);
        assert_eq!(
            places.place(WSL, "/mnt/c/Users/me", None).unwrap().location["path"],
            "/mnt/c/Users/me"
        );
        assert!(places.place(WSL, "C:\\Projects", None).is_none());
        assert!(places.place(LOCAL, "relative/path", None).is_none());
        // The account that made a chat, by name, when it is not connected where the chat runs.
        assert_eq!(
            absent_account(&fleet, "claude", WSL, None, Some("a1")).as_deref(),
            Some("Work")
        );
        assert_eq!(
            absent_account(&fleet, "claude", WSL, None, Some("a2")),
            None
        );
        assert_eq!(
            absent_account(
                &fleet,
                "claude",
                WSL,
                Some("10000000-0000-4000-8000-000000000001"),
                None
            )
            .as_deref(),
            Some("Work")
        );
        assert_eq!(
            absent_account(
                &fleet,
                "claude",
                WSL,
                Some("10000000-0000-4000-8000-000000000002"),
                None
            ),
            None
        );
        assert_eq!(absent_account(&fleet, "claude", WSL, None, None), None);
        // A separate profile continues with itself; the default directory with the account
        // that made the chat, or else the CLI login.
        assert_eq!(
            choose_connection(
                &fleet,
                "claude",
                LOCAL,
                Some("10000000-0000-4000-8000-000000000002"),
                None
            )
            .as_deref(),
            Some("10000000-0000-4000-8000-000000000002")
        );
        assert_eq!(
            choose_connection(&fleet, "claude", LOCAL, None, Some("a2")).as_deref(),
            Some("10000000-0000-4000-8000-000000000002")
        );
        assert_eq!(
            choose_connection(&fleet, "claude", LOCAL, None, None).as_deref(),
            Some("10000000-0000-4000-8000-000000000001")
        );
        assert_eq!(
            choose_connection(&fleet, "claude", WSL, None, Some("a1")).as_deref(),
            Some("10000000-0000-4000-8000-000000000003")
        );
        assert_eq!(choose_connection(&fleet, "codex", LOCAL, None, None), None);
        assert_eq!(computer_name(&fleet, WSL), "Ubuntu");
        assert_eq!(computer_name(&fleet, LOCAL), "Desktop");
    }

    #[test]
    fn import_records_round_trip_and_reject_damage() {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        assert!(record(root.path(), &conversation).unwrap().is_none());
        let saved = Record {
            version: 1,
            source: Source {
                provider: "claude".into(),
                environment_id: LOCAL.into(),
                connection_id: None,
            },
            session: uuid::Uuid::new_v4().to_string(),
            imported_at: 1,
            path: Some("projects/C--work/session.jsonl".into()),
        };
        write_record(root.path(), &conversation, &saved).unwrap();
        let read = record(root.path(), &conversation).unwrap().unwrap();
        assert_eq!(read.session, saved.session);
        assert!(write_record(root.path(), &conversation, &saved).is_err());
        std::fs::write(
            records_dir(root.path()).join(format!("{conversation}.json")),
            "{}",
        )
        .unwrap();
        assert!(record(root.path(), &conversation).is_err());
        assert!(record(root.path(), "../outside").is_err());
    }

    #[test]
    fn coalescing_keeps_each_record_once_at_its_first_place() {
        let progress = |id: &str, revision: u64, text: &str| RunEvent::Progress {
            id: id.into(),
            revision,
            text: text.into(),
        };
        let events = coalesce(vec![
            progress("a", 1, "one"),
            RunEvent::Activity {
                text: "Using Bash".into(),
            },
            progress("b", 1, "two"),
            progress("a", 2, "one, finished"),
            RunEvent::Text {
                text: "draft".into(),
            },
            RunEvent::Text {
                text: "answer".into(),
            },
        ]);
        let texts: Vec<String> = events
            .iter()
            .map(|e| match e {
                RunEvent::Progress { text, .. } | RunEvent::Text { text } => text.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(texts, ["one, finished", "two", "answer"]);
    }

    #[test]
    fn titles_and_wsl_paths_read_as_people_wrote_them() {
        assert_eq!(short_title("  Fix   the\nbuild  "), "Fix the build");
        assert_eq!(short_title(&"a".repeat(150)).chars().count(), 100);
        assert_eq!(
            wsl_share("\\\\wsl$\\Ubuntu-24.04\\srv\\app"),
            Some(("Ubuntu-24.04".into(), "/srv/app".into()))
        );
        assert_eq!(wsl_share("C:\\Users"), None);
        assert!(windows_absolute("D:/Unreal Projects") && !windows_absolute("/home/me"));
        assert_eq!(mounted_drive("/mnt/c").as_deref(), Some("C:\\"));
        assert_eq!(
            mounted_drive("/mnt/d/Unreal Projects/Bluevox").as_deref(),
            Some("D:\\Unreal Projects\\Bluevox")
        );
        assert_eq!(mounted_drive("/mnt/cdrom"), None);
        assert_eq!(mounted_drive("/mnt/"), None);
        assert_eq!(mounted_drive("/home/me"), None);
    }

    #[test]
    fn a_chat_imported_from_one_copy_is_known_in_every_copy() {
        let root = tempfile::tempdir().unwrap();
        let imported = uuid::Uuid::new_v4().to_string();
        let bound = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            root.path().join("workspace.json"),
            json!({"conversations": [{"id": imported}, {"id": bound}]}).to_string(),
        )
        .unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        // Imported from the original that WSL keeps; the Windows copy lists the same session.
        write_record(
            root.path(),
            &imported,
            &Record {
                version: 1,
                source: Source {
                    provider: "claude".into(),
                    environment_id: WSL.into(),
                    connection_id: None,
                },
                session: session.clone(),
                imported_at: 1,
                path: Some(format!("projects/-home-me-app/{session}.jsonl")),
            },
        )
        .unwrap();
        let native = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(root.path().join("native-sessions")).unwrap();
        std::fs::write(
            root.path()
                .join("native-sessions")
                .join(format!("{bound}.json")),
            json!({"id": native}).to_string(),
        )
        .unwrap();
        let known = Known::read(root.path());
        assert_eq!(
            known.conversation("claude", &session),
            (Some(imported.clone()), true)
        );
        assert_eq!(known.conversation("codex", &session), (None, false));
        assert_eq!(known.conversation("claude", &native), (Some(bound), false));
    }

    /// Reads this computer's real Claude sessions (STUDIO_IMPORT_CLAUDE, default ~/.claude) and
    /// prints only counts and timings. cargo test --lib -- --ignored installed_claude_imports --nocapture
    #[test]
    #[ignore]
    fn installed_claude_imports_read_this_computers_sessions() {
        let root = std::env::var_os("STUDIO_IMPORT_CLAUDE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("USERPROFILE").unwrap()).join(".claude")
            });
        let started = std::time::Instant::now();
        let (files, truncated) = claude::sessions(&root, LISTED);
        let summaries: Vec<_> = files
            .iter()
            .filter_map(|(path, bytes, _)| {
                claude::summarize(path, *bytes).map(|s| (path.clone(), *bytes, s))
            })
            .collect();
        println!(
            "listed {} of {} sessions (truncated {truncated}) in {:?}; titled {}, with prompt {}, with cwd {}, studio {}",
            summaries.len(),
            files.len(),
            started.elapsed(),
            summaries.iter().filter(|s| s.2.title.is_some()).count(),
            summaries.iter().filter(|s| s.2.prompt.is_some()).count(),
            summaries.iter().filter(|s| s.2.cwd.is_some()).count(),
            summaries.iter().filter(|s| s.2.studio).count(),
        );
        let started = std::time::Instant::now();
        let index = claude::desktop_index();
        println!(
            "desktop index {} sessions in {:?}",
            index.len(),
            started.elapsed()
        );
        let mut largest = summaries.clone();
        largest.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        let picked: Vec<_> = summaries
            .iter()
            .take(25)
            .chain(largest.iter().take(5))
            .collect();
        for (path, bytes, summary) in picked {
            let started = std::time::Instant::now();
            match claude::convert(path) {
                Ok(conversion) => {
                    let replies: Vec<_> = conversion
                        .turns
                        .iter()
                        .filter_map(|t| t.reply.as_ref())
                        .collect();
                    let events: usize = replies.iter().map(|r| r.events.len()).sum();
                    let tools = replies
                        .iter()
                        .flat_map(|r| &r.events)
                        .filter(|e| matches!(e, RunEvent::Tool { .. }))
                        .count();
                    let answers = replies
                        .iter()
                        .filter(|r| r.events.iter().any(|e| matches!(e, RunEvent::Text { .. })))
                        .count();
                    let outputs: usize = replies.iter().map(|r| r.outputs.len()).sum();
                    let payload = serde_json::to_string(
                        &replies.iter().map(|r| &r.events).collect::<Vec<_>>(),
                    )
                    .unwrap()
                    .len();
                    let statuses: Vec<&str> = replies.iter().map(|r| r.status).collect();
                    println!(
                        "{:>7} KB  turns {:>3} prompts {:>3} answers {:>3} tools {:>4} events {:>5} outputs {:>4} payload {:>6} KB {:?} cancelled {} errors {} title {} notes {}",
                        bytes / 1024,
                        conversion.turns.len(),
                        conversion.turns.iter().filter(|t| t.user.is_some()).count(),
                        answers,
                        tools,
                        events,
                        outputs,
                        payload / 1024,
                        started.elapsed(),
                        statuses.iter().filter(|s| **s == "cancelled").count(),
                        statuses.iter().filter(|s| **s == "error").count(),
                        conversion.title.is_some() || summary.title.is_some(),
                        conversion.notes.len(),
                    );
                }
                Err(error) => println!("{:>7} KB  failed: {error}", bytes / 1024),
            }
        }
    }

    /// Reads this computer's Claude stores, its own and its WSL distributions' (found without
    /// their CLI), against the installed app's Connections (STUDIO_IMPORT_DATA, default its app
    /// data), and prints only counts: where each chat runs and whether its copies agree.
    /// cargo test --lib -- --ignored installed_wsl_chats --nocapture
    #[tokio::test]
    #[ignore]
    async fn installed_wsl_chats_run_in_their_distribution() {
        let data = std::env::var_os("STUDIO_IMPORT_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
                    .join("com.vinicius.agentstudio")
            });
        let fleet = crate::saved::fleet(&data, "No workspace", "Unreadable workspace").unwrap();
        let name = |id: &str| {
            list(&fleet, "environments")
                .find(|e| e["id"] == id)
                .and_then(|e| e["name"].as_str())
                .unwrap_or("?")
                .to_string()
        };
        let local = list(&fleet, "environments")
            .find(|e| e["platform"] == "windows")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let index = claude::desktop_index();
        let mut stores = vec![(
            local.clone(),
            PathBuf::from(std::env::var_os("USERPROFILE").unwrap()).join(".claude"),
        )];
        for environment in list(&fleet, "environments").filter(|e| e["platform"] == "wsl") {
            let profile = crate::profiles::Profile {
                provider: "claude".into(),
                distribution: environment["distribution"].as_str().map(String::from),
                ..Default::default()
            };
            let started = std::time::Instant::now();
            let root = crate::profiles::scope(profile, crate::context::profile_store("claude"))
                .await
                .unwrap();
            println!(
                "{} keeps its chats in {} (found without its CLI in {:?})",
                name(environment["id"].as_str().unwrap()),
                root.display(),
                started.elapsed()
            );
            stores.push((environment["id"].as_str().unwrap().into(), root));
        }
        // Each copy of a session: its store, when it was last used, its size and where it opens.
        type Copy = (String, Option<String>, u64, Value);
        let mut copies: HashMap<String, Vec<Copy>> = HashMap::new();
        for (environment, root) in &stores {
            let started = std::time::Instant::now();
            let (files, _) = claude::sessions(root, LISTED);
            let mut places = Places::new(&fleet, &local);
            let mut placed: HashMap<String, usize> = HashMap::new();
            for (path, bytes, _) in &files {
                let Some(summary) = claude::summarize(path, *bytes) else {
                    continue;
                };
                let desktop = index.get(&summary.session);
                let recorded = desktop.and_then(|d| d.distribution.clone());
                let cwd = summary
                    .cwd
                    .clone()
                    .or_else(|| desktop.and_then(|d| d.cwd.clone()))
                    .unwrap_or_default();
                let placement = places.place(environment, &cwd, recorded.as_deref());
                let label = match &placement {
                    None => "no folder".to_string(),
                    Some(p) => format!(
                        "{} folder run by {}{}",
                        name(p.location["environmentId"].as_str().unwrap()),
                        name(&p.execution),
                        if p.missing { ", missing" } else { "" }
                    ),
                };
                *placed.entry(label).or_default() += 1;
                if environment != &local {
                    assert!(transcript_in(root, path, &summary.session).is_some());
                }
                copies.entry(summary.session.clone()).or_default().push((
                    environment.clone(),
                    summary.updated.clone(),
                    *bytes,
                    placement.map_or(Value::Null, |p| {
                        json!([
                            p.location["environmentId"],
                            p.location["executionEnvironmentId"]
                        ])
                    }),
                ));
            }
            println!(
                "{}: {} chats in {:?}: {placed:?}",
                name(environment),
                files.len(),
                started.elapsed()
            );
        }
        // The dialog keeps the copy used last, and of copies as recent the longest.
        let (mut both, mut differ, mut original, mut shorter) = (0, 0, 0, 0);
        for copies in copies.values().filter(|c| c.len() > 1) {
            both += 1;
            differ += usize::from(copies.iter().any(|c| c.3 != copies[0].3));
            let kept = copies
                .iter()
                .max_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)))
                .unwrap();
            original += usize::from(kept.0 != local);
            shorter += usize::from(copies.iter().any(|c| c.2 > kept.2));
        }
        println!(
            "{both} chats in two stores: {differ} on another computer, {original} kept from WSL, {shorter} kept a shorter copy"
        );
        assert_eq!((differ, shorter), (0, 0));
    }

    /// Reads this computer's real Codex threads through its app-server and prints only counts.
    /// cargo test --lib -- --ignored installed_codex_imports --nocapture
    #[tokio::test]
    #[ignore]
    async fn installed_codex_imports_read_this_computers_threads() {
        let started = std::time::Instant::now();
        let (threads, truncated) = codex::list(LISTED).await.unwrap();
        println!(
            "listed {} threads (truncated {truncated}) in {:?}; named {}, archived {}, desktop {}, studio {}",
            threads.len(),
            started.elapsed(),
            threads.iter().filter(|t| t.name.is_some()).count(),
            threads.iter().filter(|t| t.archived).count(),
            threads.iter().filter(|t| codex_origin(t) == "desktop").count(),
            threads.iter().filter(|t| codex_origin(t) == "studio").count(),
        );
        for thread in threads
            .iter()
            .filter(|t| codex_origin(t) != "studio")
            .take(12)
        {
            let started = std::time::Instant::now();
            match codex::read(&thread.id).await {
                Ok((value, turns)) => {
                    let conversion = codex::convert(&value, &turns);
                    let replies: Vec<_> = conversion
                        .turns
                        .iter()
                        .filter_map(|t| t.reply.as_ref())
                        .collect();
                    let tools = replies
                        .iter()
                        .flat_map(|r| &r.events)
                        .filter(|e| matches!(e, RunEvent::Tool { .. }))
                        .count();
                    let answers = replies
                        .iter()
                        .filter(|r| r.events.iter().any(|e| matches!(e, RunEvent::Text { .. })))
                        .count();
                    let steering: usize = replies.iter().map(|r| r.steering.len()).sum();
                    let images: usize = conversion
                        .turns
                        .iter()
                        .filter_map(|t| t.user.as_ref())
                        .map(|u| u.images.len())
                        .sum();
                    let payload = serde_json::to_string(
                        &replies.iter().map(|r| &r.events).collect::<Vec<_>>(),
                    )
                    .unwrap()
                    .len();
                    println!(
                        "turns {:>3} prompts {:>3} answers {:>3} tools {:>4} steering {} images {} payload {:>6} KB {:?} {}",
                        turns.len(),
                        conversion.turns.iter().filter(|t| t.user.is_some()).count(),
                        answers,
                        tools,
                        steering,
                        images,
                        payload / 1024,
                        started.elapsed(),
                        codex_origin(thread),
                    );
                }
                Err(error) => println!("failed: {error}"),
            }
        }
    }
}
