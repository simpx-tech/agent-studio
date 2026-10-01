//! Claude Code transcripts (`projects/<folder>/<session>.jsonl` in a CLI profile). Listing reads
//! bounded parts of each file; importing reads the conversation's active branch, from its latest
//! record back to its start, and turns each human prompt and the work after it into one reply
//! through the same decoder a live reply uses.
use super::{Conversion, ImageInput, Reply, Turn, UserInput};
use crate::protocol::{Decoder, RunEvent, TokenUsage};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Files whose whole contents a listing reads; larger ones are read at their ends.
const WHOLE_LISTING: u64 = 1024 * 1024;
/// How much of each end of a larger file a listing reads.
const LISTING_WINDOW: u64 = 512 * 1024;
/// Records a listing skips: a pasted image makes one line many megabytes long.
const LISTING_LINE: usize = 1024 * 1024;
/// The longest record an import reads; longer ones (rare, image-heavy) are left out.
const IMPORT_LINE: usize = 128 * 1024 * 1024;
const PREVIEW: usize = 300;
/// What Agent Studio's own first input to a session starts with.
pub const STUDIO_GUIDANCE: &str = "You are having a conversation in Agent Studio";
/// Inputs Agent Studio sends ahead of a prompt, which are context rather than the user's words.
const STUDIO_CONTEXT: [&str; 4] = [
    STUDIO_GUIDANCE,
    "Current user instructions for this conversation",
    "Delivery of this earlier user message was interrupted",
    "Account context sharing is now disabled",
];

/// What a listing shows of one transcript.
#[derive(Clone, Debug, Default)]
pub struct Summary {
    pub session: String,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub entrypoint: Option<String>,
    /// The session began with Agent Studio's own guidance.
    pub studio: bool,
    pub model: Option<String>,
}

/// The transcripts of a profile, newest first: `projects/<folder>/<uuid>.jsonl` only, never a
/// sub-agent's own file inside a session folder.
pub fn sessions(root: &Path, limit: usize) -> (Vec<(PathBuf, u64, u128)>, bool) {
    let mut found = vec![];
    let Ok(folders) = std::fs::read_dir(root.join("projects")) else {
        return (found, false);
    };
    let mut visited = 0;
    for folder in folders.flatten() {
        if !folder.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(folder.path()) else {
            continue;
        };
        for file in files.flatten() {
            visited += 1;
            if visited > 200_000 {
                break;
            }
            let name = file.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if uuid::Uuid::parse_str(stem).is_err() {
                continue;
            }
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            if !metadata.is_file() || metadata.len() == 0 {
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            found.push((file.path(), metadata.len(), modified));
        }
    }
    found.sort_by_key(|file| std::cmp::Reverse(file.2));
    // A session the desktop app moved can be in two project folders: the newest file is the one
    // that went on.
    let mut sessions = HashSet::new();
    found.retain(|(path, _, _)| sessions.insert(path.file_name().map(|n| n.to_os_string())));
    let truncated = found.len() > limit;
    found.truncate(limit);
    (found, truncated)
}

/// Reads one line of at most `cap` bytes into `line`; a longer one is consumed and reported
/// as `Some(false)`. `None` at the end of the file.
fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>, cap: usize) -> Option<(usize, bool)> {
    line.clear();
    let mut consumed = 0;
    let mut whole = true;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(_) => return None,
        };
        if available.is_empty() {
            return (consumed > 0).then_some((consumed, whole));
        }
        let (length, done) = match available.iter().position(|b| *b == b'\n') {
            Some(end) => (end + 1, true),
            None => (available.len(), false),
        };
        if whole {
            if line.len() + length > cap {
                whole = false;
                line.clear();
            } else {
                line.extend_from_slice(&available[..length]);
            }
        }
        reader.consume(length);
        consumed += length;
        if done {
            return Some((consumed, whole));
        }
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// Text inside the first `<tag>…</tag>` of `text`.
fn tagged<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// Claude Code's reminders ahead of the words a person typed.
fn without_reminders(mut text: &str) -> &str {
    loop {
        let trimmed = text.trim_start();
        let Some(rest) = trimmed.strip_prefix("<system-reminder>") else {
            return trimmed;
        };
        match rest.find("</system-reminder>") {
            Some(end) => text = &rest[end + "</system-reminder>".len()..],
            None => return trimmed,
        }
    }
}

pub fn interruption(text: &str) -> bool {
    text.trim_start()
        .starts_with("[Request interrupted by user")
}

/// The words and images of a human prompt, or `None` for every other user record: tool
/// results, notices Claude Code wrote itself, compaction summaries, task notifications and the
/// context Agent Studio sends ahead of a prompt.
pub fn prompt(v: &Value) -> Option<(String, Vec<ImageInput>)> {
    if v["type"] != "user"
        || v["isSidechain"] == true
        || v["isMeta"] == true
        || v["isCompactSummary"] == true
        || v["isVisibleInTranscriptOnly"] == true
        || v["origin"]["kind"]
            .as_str()
            .is_some_and(|kind| kind != "human")
    {
        return None;
    }
    let content = &v["message"]["content"];
    if content
        .as_array()
        .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"))
    {
        return None;
    }
    let raw = text_of(content);
    let mut text = without_reminders(&raw).to_string();
    for skipped in [
        "<task-notification>",
        "<local-command-stdout>",
        "<local-command-stderr>",
        "<local-command-caveat>",
        "<bash-stdout>",
        "<bash-stderr>",
    ] {
        if text.starts_with(skipped) {
            return None;
        }
    }
    if interruption(&text) || STUDIO_CONTEXT.iter().any(|p| text.starts_with(p)) {
        return None;
    }
    // A slash command reads as the person typed it.
    if let Some(name) = tagged(&text, "command-name") {
        let args = tagged(&text, "command-args").unwrap_or_default().trim();
        text = if args.is_empty() {
            name.trim().to_string()
        } else {
            format!("{} {args}", name.trim())
        };
    } else if let Some(command) = tagged(&text, "bash-input") {
        text = format!("!{command}");
    }
    let images: Vec<_> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "image" && b["source"]["type"] == "base64")
        .filter_map(|b| b["source"]["data"].as_str())
        .map(|data| ImageInput::Base64(data.to_string()))
        .collect();
    if text.trim().is_empty() && images.is_empty() {
        return None;
    }
    Some((text.trim().to_string(), images))
}

fn preview(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = line.chars();
    let start: String = chars.by_ref().take(PREVIEW).collect();
    if chars.next().is_some() {
        format!("{start}…")
    } else {
        start
    }
}

#[derive(Default)]
struct Titles {
    custom: Option<String>,
    ai: Option<String>,
    summary: Option<String>,
    agent: Option<String>,
}
impl Titles {
    fn note(&mut self, v: &Value) {
        let take = |key: &str| {
            v[key]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| t.chars().take(200).collect::<String>())
        };
        match v["type"].as_str() {
            Some("custom-title") => self.custom = take("customTitle").or(self.custom.take()),
            Some("ai-title") => self.ai = take("aiTitle").or(self.ai.take()),
            Some("summary") => self.summary = take("summary").or(self.summary.take()),
            Some("agent-name") => self.agent = take("agentName").or(self.agent.take()),
            _ => {}
        }
    }
    fn best(self) -> Option<String> {
        self.custom.or(self.ai).or(self.summary).or(self.agent)
    }
}

/// The few fields a listing reads of each record. Serde skips the rest unbuilt, chiefly the
/// content of messages and tool results.
#[derive(Deserialize)]
struct Peek {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    cwd: Option<String>,
    entrypoint: Option<String>,
    #[serde(rename = "isSidechain", default)]
    sidechain: bool,
    #[serde(rename = "customTitle")]
    custom_title: Option<Value>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<Value>,
    summary: Option<Value>,
    #[serde(rename = "agentName")]
    agent_name: Option<Value>,
    message: Option<PeekMessage>,
}
#[derive(Deserialize)]
struct PeekMessage {
    model: Option<Value>,
}

/// What a listing shows of one transcript, read whole when small and at both ends otherwise.
pub fn summarize(path: &Path, bytes: u64) -> Option<Summary> {
    let session = path.file_stem()?.to_string_lossy().into_owned();
    uuid::Uuid::parse_str(&session).ok()?;
    let mut file = std::fs::File::open(path).ok()?;
    let mut summary = Summary {
        session,
        ..Summary::default()
    };
    let mut titles = Titles::default();
    let whole = bytes <= WHOLE_LISTING;
    let mut first_user = true;
    let mut note = |line: &[u8], head: bool, summary: &mut Summary| {
        let Ok(peek) = serde_json::from_slice::<Peek>(line) else {
            return;
        };
        let kind = peek.kind.as_deref().unwrap_or_default();
        let take = |value: &Option<Value>| {
            value
                .as_ref()
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| t.chars().take(200).collect::<String>())
        };
        match kind {
            "custom-title" => titles.custom = take(&peek.custom_title).or(titles.custom.take()),
            "ai-title" => titles.ai = take(&peek.ai_title).or(titles.ai.take()),
            "summary" => titles.summary = take(&peek.summary).or(titles.summary.take()),
            "agent-name" => titles.agent = take(&peek.agent_name).or(titles.agent.take()),
            _ => {}
        }
        if let Some(time) = peek.timestamp {
            if head && summary.created.is_none() {
                summary.created = Some(time.clone());
            }
            summary.updated = Some(time);
        }
        if let Some(cwd) = peek.cwd.filter(|c| !c.is_empty()) {
            summary.cwd = Some(cwd);
        }
        if kind == "assistant" {
            if let Some(model) = peek
                .message
                .as_ref()
                .and_then(|m| m.model.as_ref())
                .and_then(Value::as_str)
                .filter(|m| *m != crate::protocol::usage_limit::SYNTHETIC_MODEL)
            {
                summary.model = Some(model.chars().take(100).collect());
            }
        }
        if kind != "user" || peek.sidechain {
            return;
        }
        if summary.entrypoint.is_none() {
            summary.entrypoint = peek.entrypoint.map(|e| e.chars().take(40).collect());
        }
        // Only the first prompt and the first user record need the record's content.
        if !(head && (first_user || summary.prompt.is_none())) {
            return;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        if head && first_user {
            first_user = false;
            summary.studio = text_of(&v["message"]["content"]).starts_with(STUDIO_GUIDANCE);
        }
        if let Some((text, images)) = prompt(&v) {
            if head && summary.prompt.is_none() {
                summary.prompt = Some(if text.is_empty() && !images.is_empty() {
                    "An image".into()
                } else {
                    preview(&text)
                });
            }
        }
    };
    let mut line = Vec::new();
    {
        let mut reader = BufReader::with_capacity(
            256 * 1024,
            (&mut file).take(if whole { bytes } else { LISTING_WINDOW }),
        );
        while let Some((_, complete)) = read_line(&mut reader, &mut line, LISTING_LINE) {
            if complete {
                note(&line, true, &mut summary);
            }
        }
    }
    if !whole {
        // Titles are written again as a session goes on, so its end holds the latest.
        file.seek(SeekFrom::Start(bytes.saturating_sub(LISTING_WINDOW)))
            .ok()?;
        let mut reader = BufReader::with_capacity(256 * 1024, &mut file);
        // The window starts inside a record; the first line is never whole.
        read_line(&mut reader, &mut line, LISTING_LINE);
        while let Some((_, complete)) = read_line(&mut reader, &mut line, LISTING_LINE) {
            if complete {
                note(&line, false, &mut summary);
            }
        }
    }
    summary.title = titles.best();
    Some(summary)
}

/// The fields of a record that place it on a branch.
#[derive(Deserialize)]
struct Link {
    uuid: Option<String>,
    #[serde(rename = "parentUuid")]
    parent: Option<String>,
    #[serde(rename = "logicalParentUuid")]
    logical: Option<String>,
    #[serde(rename = "isSidechain", default)]
    sidechain: bool,
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// The offsets of the records on the active branch: from the latest main-chain record back to
/// the start, through compaction boundaries to the history they summarized.
fn active_branch(path: &Path) -> Result<HashSet<u64>, String> {
    let file = std::fs::File::open(path).map_err(|_| "Cannot read this chat's transcript")?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut line = Vec::new();
    let mut offset = 0u64;
    let mut records: HashMap<String, (Option<String>, u64)> = HashMap::new();
    let mut leaf = None;
    while let Some((consumed, complete)) = read_line(&mut reader, &mut line, IMPORT_LINE) {
        let at = offset;
        offset += consumed as u64;
        if !complete {
            continue;
        }
        let Ok(link) = serde_json::from_slice::<Link>(&line) else {
            continue;
        };
        let Some(uuid) = link.uuid else {
            continue;
        };
        if link.sidechain {
            continue;
        }
        let parent = link.parent.or(link.logical);
        if matches!(
            link.kind.as_deref(),
            Some("user" | "assistant" | "system" | "attachment")
        ) {
            leaf = Some(uuid.clone());
        }
        records.insert(uuid, (parent, at));
    }
    let mut chain = HashSet::new();
    let mut seen = HashSet::new();
    let mut current = leaf;
    while let Some(uuid) = current {
        if !seen.insert(uuid.clone()) {
            break;
        }
        let Some((parent, at)) = records.get(&uuid) else {
            break;
        };
        chain.insert(*at);
        current = parent.clone();
    }
    Ok(chain)
}

/// Transcript records name some fields as the CLI's stream does not.
fn as_streamed(mut v: Value) -> Value {
    if let Some(object) = v.as_object_mut() {
        if let Some(result) = object.remove("toolUseResult") {
            object.insert("tool_use_result".into(), result);
        }
        if let Some(metadata) = object.remove("compactMetadata") {
            object.insert(
                "compact_metadata".into(),
                json!({
                    "trigger": metadata["trigger"],
                    "pre_tokens": metadata["preTokens"],
                    "post_tokens": metadata["postTokens"],
                }),
            );
        }
    }
    v
}

fn input_tokens(usage: &Value) -> Option<u64> {
    Some(
        usage["input_tokens"].as_u64()?
            + usage["cache_read_input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
    )
}

fn millis(time: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|t| t.timestamp_millis())
}

const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// One prompt's reply while it is read.
#[derive(Default)]
struct Building {
    user: Option<UserInput>,
    decoder: Decoder,
    events: Vec<RunEvent>,
    outputs: Vec<crate::protocol::activity::CapturedOutput>,
    started: Option<String>,
    last: Option<String>,
    duration: Option<u64>,
    interrupted: bool,
    /// Each assistant message's text in order, by message id.
    texts: Vec<(String, String)>,
    /// The latest usage reported for each assistant message.
    usage: Vec<(String, Value)>,
    model: Option<String>,
    effort: Option<String>,
    /// When each call began, by tool use id.
    calls: HashMap<String, i64>,
    any: bool,
}
impl Building {
    fn feed(&mut self, v: Value) {
        self.any = true;
        let time = v["timestamp"].as_str().map(String::from);
        if self.started.is_none() {
            self.started = time.clone();
        }
        if time.is_some() {
            self.last = time.clone();
        }
        let at = time.as_deref().and_then(millis);
        if v["type"] == "assistant" {
            let message = &v["message"];
            let id = message["id"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("message-{}", self.texts.len()));
            if message["model"] != crate::protocol::usage_limit::SYNTHETIC_MODEL {
                if let Some(model) = message["model"].as_str() {
                    self.model = Some(model.chars().take(100).collect());
                }
                if !message["usage"].is_null() {
                    match self.usage.iter_mut().find(|(m, _)| *m == id) {
                        Some(entry) => entry.1 = message["usage"].clone(),
                        None => self.usage.push((id.clone(), message["usage"].clone())),
                    }
                }
            }
            if let Some(effort) = v["effort"].as_str().filter(|e| EFFORTS.contains(e)) {
                self.effort = Some(effort.into());
            }
            for block in message["content"].as_array().into_iter().flatten() {
                if block["type"] == "text" {
                    let text = block["text"].as_str().unwrap_or_default();
                    match self.texts.last_mut().filter(|(m, _)| *m == id) {
                        Some((_, joined)) if !joined.is_empty() => {
                            joined.push_str("\n\n");
                            joined.push_str(text);
                        }
                        Some((_, joined)) => joined.push_str(text),
                        None => self.texts.push((id.clone(), text.to_string())),
                    }
                } else if block["type"] == "tool_use" || block["type"] == "server_tool_use" {
                    if let (Some(call), Some(at)) = (block["id"].as_str(), at) {
                        self.calls.insert(call.to_string(), at);
                    }
                }
            }
        }
        if v["type"] == "system" && v["subtype"] == "turn_duration" {
            self.duration = v["durationMs"].as_u64();
        }
        let streamed = as_streamed(v);
        for mut event in self.decoder.decode_value("claude", &streamed) {
            if let RunEvent::Tool { tool } = &mut event {
                // A transcript is read at once: the time between a call and its result is in
                // the records, not the decoder's clock.
                let call = tool.id.strip_prefix("claude:").unwrap_or_default();
                tool.elapsed_ms = match (self.calls.get(call), at) {
                    (Some(begun), Some(ended)) if tool.status != "running" => {
                        u64::try_from(ended - begun).ok()
                    }
                    _ => None,
                };
            }
            self.events.push(event);
        }
        self.outputs.extend(self.decoder.take_tool_outputs());
    }
    fn finish(mut self) -> Turn {
        let answer = self
            .texts
            .iter()
            .rev()
            .find(|(_, text)| !text.trim().is_empty())
            .cloned();
        let limited = self.decoder.usage_limit.clone();
        if let Some((id, text)) = answer.filter(|_| limited.is_none()) {
            // The answer's own progress entry reads as the answer, which hides it in history.
            self.events.push(RunEvent::Progress {
                id,
                revision: u64::MAX >> 12,
                text: text.chars().take(16000).collect(),
            });
            self.events.push(RunEvent::Text { text });
        }
        let mut usage = TokenUsage {
            model: self.model.clone(),
            scope: Some("reply".into()),
            revision: Some(1),
            ..TokenUsage::default()
        };
        let sum = |key: &str, values: &[(String, Value)]| -> Option<u64> {
            values
                .iter()
                .filter_map(|(_, u)| u[key].as_u64())
                .reduce(|a, b| a + b)
        };
        usage.input = self
            .usage
            .iter()
            .filter_map(|(_, u)| input_tokens(u))
            .reduce(|a, b| a + b);
        usage.output = sum("output_tokens", &self.usage);
        usage.cached_input = sum("cache_read_input_tokens", &self.usage);
        usage.reasoning_output = self
            .usage
            .iter()
            .filter_map(|(_, u)| u["output_tokens_details"]["thinking_tokens"].as_u64())
            .reduce(|a, b| a + b);
        usage.context_input = self.usage.last().and_then(|(_, u)| input_tokens(u));
        if usage.input.is_some() || usage.output.is_some() {
            self.events.push(RunEvent::Usage { usage });
        }
        let duration = self.duration.or_else(|| {
            let start = self
                .user
                .as_ref()
                .and_then(|u| u.created_at.as_deref())
                .or(self.started.as_deref())
                .and_then(millis)?;
            u64::try_from(millis(self.last.as_deref()?)? - start).ok()
        });
        let (status, error) = if let Some(limit) = limited {
            ("error", Some(limit.text))
        } else if self.interrupted {
            ("cancelled", None)
        } else {
            ("complete", None)
        };
        Turn {
            user: self.user,
            reply: self.any.then(|| Reply {
                events: super::coalesce(self.events),
                outputs: self.outputs,
                status,
                error,
                created_at: self.started.clone(),
                duration_ms: duration,
                model: self.model,
                reasoning: self.effort,
                steering: vec![],
            }),
        }
    }
}

/// The conversation on a transcript's active branch, one reply per human prompt.
pub fn convert(path: &Path) -> Result<Conversion, String> {
    let chain = active_branch(path)?;
    let file = std::fs::File::open(path).map_err(|_| "Cannot read this chat's transcript")?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut line = Vec::new();
    let mut offset = 0u64;
    let mut titles = Titles::default();
    let mut turns = vec![];
    let mut current: Option<Building> = None;
    let mut skipped = 0;
    let mut cwd = None;
    let mut updated = None;
    while let Some((consumed, complete)) = read_line(&mut reader, &mut line, IMPORT_LINE) {
        let at = offset;
        offset += consumed as u64;
        if !complete {
            skipped += 1;
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        titles.note(&v);
        if !chain.contains(&at) {
            continue;
        }
        if let Some(time) = v["timestamp"].as_str() {
            updated = Some(time.to_string());
        }
        if let Some(path) = v["cwd"].as_str().filter(|c| !c.is_empty()) {
            cwd = Some(path.to_string());
        }
        if let Some((text, images)) = prompt(&v) {
            if let Some(building) = current.take() {
                turns.push(building.finish());
            }
            current = Some(Building {
                user: Some(UserInput {
                    text,
                    images,
                    created_at: v["timestamp"].as_str().map(String::from),
                }),
                ..Building::default()
            });
            continue;
        }
        if v["type"] == "user" && interruption(&text_of(&v["message"]["content"])) {
            if let Some(building) = current.as_mut() {
                building.interrupted = true;
            }
            continue;
        }
        if !matches!(v["type"].as_str(), Some("assistant" | "user" | "system")) {
            continue;
        }
        // Context Claude Code or Agent Studio added before the first prompt.
        if current.is_none() && v["type"] != "assistant" {
            continue;
        }
        current.get_or_insert_with(Building::default).feed(v);
    }
    if let Some(building) = current.take() {
        turns.push(building.finish());
    }
    let last = turns.iter().rev().find_map(|t| t.reply.as_ref());
    let model = last.and_then(|r| r.model.clone());
    let reasoning = last.and_then(|r| r.reasoning.clone());
    let created = turns
        .iter()
        .find_map(|t| t.user.as_ref().and_then(|u| u.created_at.clone()));
    let mut notes = vec![];
    if skipped > 0 {
        notes.push(format!(
            "{skipped} oversized {} could not be read and {} left out.",
            if skipped == 1 { "record" } else { "records" },
            if skipped == 1 { "was" } else { "were" }
        ));
    }
    Ok(Conversion {
        title: titles.best(),
        model,
        reasoning,
        cwd,
        created,
        updated,
        turns,
        notes,
    })
}

/// A Code session the Claude desktop app keeps for one of its accounts.
#[derive(Clone, Debug, Default)]
pub struct DesktopSession {
    pub organization: String,
    pub title: Option<String>,
    pub archived: bool,
    pub cwd: Option<String>,
    /// The WSL distribution the app ran the session in. Its Claude Code there keeps the
    /// original transcript in the distribution's own directory, and the app a copy here.
    pub distribution: Option<String>,
}

/// One index file's session, by its CLI session id.
fn desktop_session(v: &Value, organization: &str) -> Option<(String, DesktopSession)> {
    let id = v["cliSessionId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())?;
    Some((
        id.to_string(),
        DesktopSession {
            organization: organization.to_string(),
            title: v["title"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| t.chars().take(200).collect()),
            archived: v["isArchived"] == true,
            cwd: v["cwd"].as_str().map(String::from),
            distribution: v["wslConfig"]["distro"]
                .as_str()
                .filter(|d| {
                    !d.is_empty()
                        && d.len() <= 64
                        && d.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                })
                .map(String::from),
        },
    ))
}

/// Where the Claude desktop app keeps its per-account lists of Code sessions; their
/// transcripts are in the default CLI profile.
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = vec![];
    #[cfg(windows)]
    {
        if let Some(roaming) = std::env::var_os("APPDATA") {
            roots.push(PathBuf::from(roaming).join("Claude"));
        }
        // A Microsoft Store installation keeps it in its package's own copy of AppData.
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            if let Ok(packages) = std::fs::read_dir(PathBuf::from(local).join("Packages")) {
                for package in packages.flatten() {
                    if package.file_name().to_string_lossy().starts_with("Claude_") {
                        roots.push(package.path().join("LocalCache/Roaming/Claude"));
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Library/Application Support/Claude"));
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".config/Claude"));
    }
    roots
}

/// The Claude desktop app's Code sessions by CLI session id, from its own bounded index files
/// (`claude-code-sessions/<account>/<organization>/local_<id>.json`).
pub fn desktop_index() -> HashMap<String, DesktopSession> {
    desktop_index_in(&desktop_roots())
}

/// The WSL distributions the Claude desktop app ran Code sessions in.
pub fn desktop_distributions() -> HashSet<String> {
    desktop_index()
        .into_values()
        .filter_map(|session| session.distribution)
        .collect()
}

fn desktop_index_in(roots: &[PathBuf]) -> HashMap<String, DesktopSession> {
    let mut sessions = HashMap::new();
    let mut read = 0;
    for root in roots {
        let Ok(accounts) = std::fs::read_dir(root.join("claude-code-sessions")) else {
            continue;
        };
        for account in accounts.flatten() {
            let Ok(organizations) = std::fs::read_dir(account.path()) else {
                continue;
            };
            for organization in organizations.flatten() {
                let org = organization.file_name().to_string_lossy().into_owned();
                if uuid::Uuid::parse_str(&org).is_err() {
                    continue;
                }
                let Ok(files) = std::fs::read_dir(organization.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().into_owned();
                    if !name.starts_with("local_") || !name.ends_with(".json") {
                        continue;
                    }
                    read += 1;
                    if read > 20_000 {
                        return sessions;
                    }
                    if file.metadata().map_or(true, |m| m.len() > 4 * 1024 * 1024) {
                        continue;
                    }
                    let Ok(bytes) = std::fs::read(file.path()) else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
                        continue;
                    };
                    if let Some((id, session)) = desktop_session(&v, &org) {
                        sessions.insert(id, session);
                    }
                }
            }
        }
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(lines: &[Value]) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut file = tempfile::Builder::new()
            .suffix(".jsonl")
            .tempfile()
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        file
    }
    fn user(uuid: &str, parent: Option<&str>, content: Value, time: &str) -> Value {
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"isSidechain":false,"message":{"role":"user","content":content},"timestamp":time,"cwd":"C:\\project","entrypoint":"cli","sessionId":"s"})
    }
    fn assistant(uuid: &str, parent: &str, id: &str, content: Value, time: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"parentUuid":parent,"isSidechain":false,"message":{"id":id,"model":"claude-opus-5-5","role":"assistant","content":content,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}},"timestamp":time,"effort":"high","cwd":"C:\\project","sessionId":"s"})
    }

    #[test]
    fn prompts_exclude_tool_results_notices_and_studio_context() {
        let typed = user(
            "a",
            None,
            json!("<system-reminder>Be brief.</system-reminder>\nFix the build"),
            "2026-09-01T10:00:00Z",
        );
        assert_eq!(prompt(&typed).unwrap().0, "Fix the build");
        let command = user("b", None, json!("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep tests</command-args>"), "t");
        assert_eq!(prompt(&command).unwrap().0, "/compact keep tests");
        for skipped in [
            json!([{"type":"tool_result","tool_use_id":"x","content":"out"}]),
            json!("<task-notification><task-id>1</task-id></task-notification>"),
            json!("<local-command-stdout>ok</local-command-stdout>"),
            json!("[Request interrupted by user]"),
            json!("You are having a conversation in Agent Studio. Answer…"),
            json!("   "),
        ] {
            assert!(
                prompt(&user("c", None, skipped.clone(), "t")).is_none(),
                "{skipped}"
            );
        }
        let mut meta = user("d", None, json!("Caveat"), "t");
        meta["isMeta"] = json!(true);
        assert!(prompt(&meta).is_none());
        let mut notified = user("e", None, json!("Done"), "t");
        notified["origin"] = json!({"kind":"task-notification"});
        assert!(prompt(&notified).is_none());
        let image = user(
            "f",
            None,
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},{"type":"text","text":"What is this?"}]),
            "t",
        );
        let (text, images) = prompt(&image).unwrap();
        assert_eq!(text, "What is this?");
        assert_eq!(images.len(), 1);
    }

    #[test]
    fn imports_the_active_branch_as_one_reply_per_prompt() {
        let file = write(&[
            json!({"type":"custom-title","customTitle":"Old name","sessionId":"s"}),
            user("u1", None, json!("First question"), "2026-09-01T10:00:00Z"),
            assistant(
                "a1",
                "u1",
                "m1",
                json!([{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]),
                "2026-09-01T10:00:02Z",
            ),
            json!({"type":"user","uuid":"r1","parentUuid":"a1","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"stdout":"ok","stderr":""},"timestamp":"2026-09-01T10:00:07Z"}),
            assistant(
                "a2",
                "r1",
                "m2",
                json!([{"type":"text","text":"Tests pass."}]),
                "2026-09-01T10:00:09Z",
            ),
            // An abandoned branch: the person rewound and asked again.
            user(
                "u2",
                Some("a2"),
                json!("Abandoned follow-up"),
                "2026-09-01T10:01:00Z",
            ),
            assistant(
                "a3",
                "u2",
                "m3",
                json!([{"type":"text","text":"Abandoned answer"}]),
                "2026-09-01T10:01:05Z",
            ),
            user(
                "u3",
                Some("a2"),
                json!("Second question"),
                "2026-09-01T10:02:00Z",
            ),
            json!({"type":"user","uuid":"i1","parentUuid":"u3","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"2026-09-01T10:02:01Z"}),
            json!({"type":"custom-title","customTitle":"Build fixes","sessionId":"s"}),
        ]);
        let conversion = convert(file.path()).unwrap();
        assert_eq!(conversion.title.as_deref(), Some("Build fixes"));
        assert_eq!(conversion.turns.len(), 2);
        let first = &conversion.turns[0];
        assert_eq!(first.user.as_ref().unwrap().text, "First question");
        let reply = first.reply.as_ref().unwrap();
        assert_eq!(reply.status, "complete");
        assert_eq!(reply.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(reply.reasoning.as_deref(), Some("high"));
        assert_eq!(reply.duration_ms, Some(9000));
        let tool = reply
            .events
            .iter()
            .find_map(|e| match e {
                RunEvent::Tool { tool } => Some(tool),
                _ => None,
            })
            .unwrap();
        assert_eq!(tool.status, "complete");
        assert_eq!(tool.elapsed_ms, Some(5000));
        assert!(reply
            .events
            .iter()
            .any(|e| matches!(e, RunEvent::Text { text } if text == "Tests pass.")));
        let usage = reply
            .events
            .iter()
            .find_map(|e| match e {
                RunEvent::Usage { usage } => Some(usage),
                _ => None,
            })
            .unwrap();
        assert_eq!((usage.input, usage.output), (Some(200), Some(10)));
        assert_eq!(reply.outputs.len(), 1);
        let second = &conversion.turns[1];
        assert_eq!(second.user.as_ref().unwrap().text, "Second question");
        assert_eq!(second.reply.as_ref().map(|r| r.status), None);
        let replies: Vec<&Vec<RunEvent>> = conversion
            .turns
            .iter()
            .filter_map(|t| t.reply.as_ref().map(|r| &r.events))
            .collect();
        let text = serde_json::to_string(&replies).unwrap();
        assert!(!text.contains("Abandoned"));
    }

    #[test]
    fn compaction_boundaries_keep_the_history_they_summarized() {
        let file = write(&[
            user(
                "u1",
                None,
                json!("Before compaction"),
                "2026-09-01T10:00:00Z",
            ),
            assistant(
                "a1",
                "u1",
                "m1",
                json!([{"type":"text","text":"Early answer"}]),
                "2026-09-01T10:00:02Z",
            ),
            json!({"type":"system","subtype":"compact_boundary","uuid":"c1","parentUuid":null,"logicalParentUuid":"a1","isSidechain":false,"compactMetadata":{"trigger":"auto","preTokens":1000,"postTokens":100},"timestamp":"2026-09-01T11:00:00Z"}),
            json!({"type":"user","uuid":"s1","parentUuid":"c1","isSidechain":false,"isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"Summary of earlier work"},"timestamp":"2026-09-01T11:00:00Z"}),
            user(
                "u2",
                Some("s1"),
                json!("After compaction"),
                "2026-09-01T11:01:00Z",
            ),
            assistant(
                "a2",
                "u2",
                "m2",
                json!([{"type":"text","text":"Later answer"}]),
                "2026-09-01T11:01:03Z",
            ),
        ]);
        let conversion = convert(file.path()).unwrap();
        let prompts: Vec<_> = conversion
            .turns
            .iter()
            .map(|t| t.user.as_ref().unwrap().text.as_str())
            .collect();
        assert_eq!(prompts, ["Before compaction", "After compaction"]);
        let compacted = conversion.turns[0]
            .reply
            .as_ref()
            .unwrap()
            .events
            .iter()
            .find_map(|e| match e {
                RunEvent::Compaction { compaction } => Some(compaction),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            (compacted.pre_tokens, compacted.post_tokens),
            (Some(1000), Some(100))
        );
        assert!(
            !serde_json::to_string(&conversion.turns[1].user.as_ref().unwrap().text)
                .unwrap()
                .contains("Summary of earlier work")
        );
    }

    #[test]
    fn listings_read_titles_prompts_and_agent_studio_sessions() {
        let file = write(&[
            json!({"type":"user","uuid":"g","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"You are having a conversation in Agent Studio. Context"}]},"timestamp":"2026-09-01T10:00:00Z","cwd":"C:\\work","entrypoint":"sdk-cli"}),
            user(
                "u1",
                Some("g"),
                json!("Plan the release"),
                "2026-09-01T10:00:01Z",
            ),
            assistant(
                "a1",
                "u1",
                "m1",
                json!([{"type":"text","text":"Sure"}]),
                "2026-09-01T10:00:05Z",
            ),
            json!({"type":"ai-title","aiTitle":"Release planning","sessionId":"s"}),
        ]);
        let path = file
            .path()
            .with_file_name(format!("{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::copy(file.path(), &path).unwrap();
        let bytes = std::fs::metadata(&path).unwrap().len();
        let summary = summarize(&path, bytes).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(summary.studio);
        assert_eq!(summary.title.as_deref(), Some("Release planning"));
        assert_eq!(summary.prompt.as_deref(), Some("Plan the release"));
        assert_eq!(summary.cwd.as_deref(), Some("C:\\project"));
        assert_eq!(summary.created.as_deref(), Some("2026-09-01T10:00:00Z"));
        assert_eq!(summary.updated.as_deref(), Some("2026-09-01T10:00:05Z"));
        assert_eq!(summary.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(summary.entrypoint.as_deref(), Some("sdk-cli"));
    }

    #[test]
    fn a_session_in_two_project_folders_is_listed_once_from_its_newest_file() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        for (folder, age) in [("C--old", 60), ("C--new", 0)] {
            let directory = root.path().join("projects").join(folder);
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join(format!("{id}.jsonl"));
            std::fs::write(&path, "{}\n").unwrap();
            let file = std::fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age))
                .unwrap();
        }
        // Sub-agents' own files and other names are never sessions of their own.
        std::fs::create_dir_all(
            root.path()
                .join("projects/C--new")
                .join(&id)
                .join("subagents"),
        )
        .unwrap();
        std::fs::write(root.path().join("projects/C--new/notes.jsonl"), "{}\n").unwrap();
        let (found, truncated) = sessions(root.path(), 10);
        assert!(!truncated);
        assert_eq!(found.len(), 1);
        assert!(found[0].0.parent().unwrap().ends_with("C--new"));
    }

    #[test]
    fn oversized_records_are_skipped_without_losing_the_rest() {
        let mut reader = BufReader::new(&b"short\nthis line is too long\nok\n"[..]);
        let mut line = Vec::new();
        assert_eq!(read_line(&mut reader, &mut line, 8), Some((6, true)));
        assert_eq!(line, b"short\n");
        assert_eq!(read_line(&mut reader, &mut line, 8), Some((22, false)));
        assert_eq!(read_line(&mut reader, &mut line, 8), Some((3, true)));
        assert_eq!(line, b"ok\n");
        assert_eq!(read_line(&mut reader, &mut line, 8), None);
    }

    #[test]
    fn the_desktop_index_names_each_sessions_account_and_wsl_distribution() {
        let root = tempfile::tempdir().unwrap();
        let organization = "9a7f1fc2-0000-4000-8000-000000000001";
        let folder = root
            .path()
            .join("claude-code-sessions/account")
            .join(organization);
        std::fs::create_dir_all(&folder).unwrap();
        let wsl = "2a9bf331-d087-4fd2-9b1f-c72507ebf93e";
        let windows = "00af4507-cf22-428b-aa77-11fe8c35ba28";
        for (name, value) in [
            (
                "local_1.json",
                json!({"cliSessionId":wsl,"cwd":"/home/me/app","title":" Booking ","isArchived":false,"wslConfig":{"distro":"Ubuntu-24.04"}}),
            ),
            (
                "local_2.json",
                json!({"cliSessionId":windows,"cwd":"C:\\work","isArchived":true}),
            ),
            (
                "local_3.json",
                json!({"cliSessionId":"not-a-session","cwd":"/srv"}),
            ),
            (
                "local_4.json",
                json!({"cliSessionId":"5f79341e-88e9-413d-a7b5-8d11fd36d861","wslConfig":{"distro":"..\\Ubuntu"}}),
            ),
            (
                "other.json",
                json!({"cliSessionId":"bf56c7fe-d51e-430c-be0f-108e8684875b"}),
            ),
        ] {
            std::fs::write(folder.join(name), value.to_string()).unwrap();
        }
        let index = desktop_index_in(&[root.path().to_path_buf()]);
        assert_eq!(index.len(), 3);
        let session = &index[wsl];
        assert_eq!(session.organization, organization);
        assert_eq!(session.title.as_deref(), Some("Booking"));
        assert_eq!(session.distribution.as_deref(), Some("Ubuntu-24.04"));
        assert!(index[windows].archived && index[windows].distribution.is_none());
        // A distribution name that is not one is ignored, never used to build a path.
        assert!(index["5f79341e-88e9-413d-a7b5-8d11fd36d861"]
            .distribution
            .is_none());
    }
}
