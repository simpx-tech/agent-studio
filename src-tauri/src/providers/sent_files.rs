//! Files a reply shows the user. Paths reach this module only through our registered tool,
//! are checked on the computer running the conversation, and their bytes stay there with the
//! run's other tool results. The saved reply keeps metadata and each image is read on demand,
//! so the workspace, exports and relay sync never carry file contents.
use crate::protocol::activity::{CapturedOutput, ImageSource};
use crate::protocol::RunEvent;
use crate::runner::EventSink;
use crate::tool_output::files;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

pub const NAME: &str = "send_files";
/// The comparison variant: two or more files side by side, which the reader turns, pans and
/// zooms one at a time or all together.
pub const COMPARE_NAME: &str = "compare_files";
/// The longest file name a reply shows.
const MAX_NAME: usize = 120;

pub const GUIDANCE: &str = "To show the user an image, a 3D model, a table, a document, a video or audio that exists on the computer running this conversation, call the send_files tool (Claude: mcp__agent_studio__send_files) with a stable id, the absolute paths in files, and an optional one-line caption. Those three field names are exact: a call that renames one is refused. Use it for a render, a screenshot, a chart, a diagram, a model, a data table, a written report, a recording or a sound the user should see or hear now, instead of only naming its path; skip routine working files. After a successful call, put <!-- files:ID --> on its own line between blank lines where the files belong in your final answer, replacing ID with the submitted id; each group appears once, and reusing an id replaces that group. PNG, JPEG, GIF and WebP images, glTF, GLB, OBJ, STL and FBX models, CSV, TSV and XLSX tables, Markdown documents (.md), MP4, WebM and MOV videos, and MP3, M4A, AAC, WAV, FLAC, Ogg (Vorbis or Opus) and WebM audio are shown whatever their size, in as many files and groups as the reply needs: a table as a sheet the reader scrolls through, every worksheet of a workbook included, a document rendered as formatted text, and a video or audio in a player. A model opens in a viewer the reader can turn and zoom, and animations inside it play there; a device that cannot load a model shows eight views rendered from it. Send a model at its full detail: never decimate, simplify, shrink its textures or compress it for the viewer, whatever its size. Send a self-contained file: a .glb rather than a .gltf that loads separate buffers, without Draco, meshopt or Basis compression, which the viewer cannot decode (export an uncompressed copy of a model that uses one), and expect OBJ, STL and FBX to appear untextured when their textures are separate files beside them. Paths must be absolute on that computer; other files, unreadable paths and Markdown image links are not displayed. The reader's window loads each file from that computer when it opens the reply.";

pub const COMPARE_GUIDANCE: &str = "To compare images or 3D models side by side (not tables, documents, videos or audio, which send_files shows), call compare_files (Claude: mcp__agent_studio__compare_files) with a stable id, two or more absolute paths in files in the order to show them, optional labels (one short single-line label per file, in the same order, such as Before and After) and an optional one-line caption; those four field names are exact. Use it for before and after, variants, or a reference beside a result: the reader sees the files as panes side by side, in Free mode, where each pane turns, pans and zooms on its own, or Synced, where the models keep one rotation, position and zoom and the images one zoom and position. Files are checked and shown as send_files shows them, and <!-- files:ID --> places the comparison in your final answer the same way; a comparison and a send_files group share their ids.";

/// One shown file, as the saved reply records it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentFile {
    /// This file's place among the call's images, its models, or its other files (tables,
    /// documents, videos and audio) in the stored result, each counted from 0.
    pub index: usize,
    pub name: String,
    pub media_type: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// The label a comparison gave this file, such as Before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One call's files, placed in the reply by its marker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentFiles {
    pub id: String,
    pub revision: u64,
    /// The run and call whose stored result holds these images on the executing computer.
    pub run_id: String,
    pub tool_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    pub files: Vec<SentFile>,
    /// Shown side by side for comparison, as compare_files shows them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compare: bool,
}

pub fn tool() -> Value {
    json!({"name":NAME,"description":GUIDANCE,"inputSchema":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","description":"Stable identifier; reuse to replace this group within the current reply."},
            "files":{"type":"array","minItems":1,"items":{"type":"string","minLength":1},"description":"Absolute paths on the computer running this conversation: PNG, JPEG, GIF or WebP images, glTF, GLB, OBJ, STL or FBX models, CSV, TSV or XLSX tables, Markdown documents, MP4, WebM or MOV videos, or MP3, M4A, AAC, WAV, FLAC, Ogg or WebM audio."},
            "caption":{"type":"string","minLength":1,"description":"Optional single line shown below the files."}
        },"required":["id","files"],"additionalProperties":false}})
}
pub fn codex_tool() -> Value {
    codex(tool())
}
pub fn compare_tool() -> Value {
    json!({"name":COMPARE_NAME,"description":COMPARE_GUIDANCE,"inputSchema":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","description":"Stable identifier; reuse to replace this comparison within the current reply."},
            "files":{"type":"array","minItems":2,"items":{"type":"string","minLength":1},"description":"Two or more absolute paths on the computer running this conversation, in the order to show them side by side: PNG, JPEG, GIF or WebP images, or glTF, GLB, OBJ, STL or FBX models."},
            "labels":{"type":"array","items":{"type":"string","minLength":1},"description":"Optional single-line label for each file, in the order of files, such as Before and After."},
            "caption":{"type":"string","minLength":1,"description":"Optional single line shown below the comparison."}
        },"required":["id","files"],"additionalProperties":false}})
}
pub fn codex_compare_tool() -> Value {
    codex(compare_tool())
}
fn codex(mut tool: Value) -> Value {
    tool["type"] = json!("function");
    tool["deferLoading"] = json!(false);
    tool
}

/// Which of the two tools a call used: send_files shows a group, compare_files a comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tool {
    Send,
    Compare,
}
impl Tool {
    fn named(name: &str) -> Option<Self> {
        match name {
            NAME => Some(Self::Send),
            COMPARE_NAME => Some(Self::Compare),
            _ => None,
        }
    }
    /// A Claude call's tool, by the name the SDK reports for our server's tools.
    fn claude(name: &Value) -> Option<Self> {
        Self::named(name.as_str()?.strip_prefix("mcp__agent_studio__")?)
    }
    fn name(self) -> &'static str {
        match self {
            Self::Send => NAME,
            Self::Compare => COMPARE_NAME,
        }
    }
    fn fields(self) -> &'static [&'static str] {
        match self {
            Self::Send => &["id", "files", "caption"],
            Self::Compare => &["id", "files", "labels", "caption"],
        }
    }
    fn invalid(self) -> &'static str {
        match self {
            Self::Send => INVALID,
            Self::Compare => COMPARE_INVALID,
        }
    }
}

const INVALID: &str = "Provide id (letters, digits, _ or -), files (one or more absolute paths) and an optional single-line caption. No other fields are accepted.";
const COMPARE_INVALID: &str = "Provide id (letters, digits, _ or -), files (two or more absolute paths), optional labels (one single-line label per file, in the order of files) and an optional single-line caption. No other fields are accepted.";

struct Submission {
    id: String,
    files: Vec<String>,
    /// One per file, for a comparison that names its files.
    labels: Option<Vec<String>>,
    caption: Option<String>,
    compare: bool,
}
/// One line, as the reply shows it: tabs, line breaks and every other control character become
/// spaces. Nothing but spaces is no text.
fn one_line(text: &str) -> Option<String> {
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.into())
}
fn parse(args: &Value, tool: Tool) -> Result<Submission, String> {
    let invalid = tool.invalid();
    if !args.is_object() {
        return Err(invalid.into());
    }
    // Keys are unique, so rejecting every unaccepted name leaves only the tool's own fields.
    let unexpected = super::unexpected_fields(args, tool.fields());
    if !unexpected.is_empty() {
        return Err(super::unexpected_message(&unexpected, invalid));
    }
    let id = args["id"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or(invalid)?;
    let files = args["files"].as_array().ok_or(invalid)?;
    if files.is_empty() {
        return Err(invalid.into());
    }
    if tool == Tool::Compare && files.len() < 2 {
        return Err(format!(
            "A comparison needs two or more files; send_files shows one. {invalid}"
        ));
    }
    let labels = match &args["labels"] {
        Value::Null => None,
        Value::Array(labels) if labels.len() == files.len() => Some(
            labels
                .iter()
                .map(|label| label.as_str().and_then(one_line))
                .collect::<Option<Vec<_>>>()
                .ok_or(invalid)?,
        ),
        Value::Array(labels) => {
            return Err(format!(
                "This call sent {} labels for {} files: give one label per file, in the order of files. {invalid}",
                labels.len(),
                files.len()
            ))
        }
        _ => return Err(invalid.into()),
    };
    let files: Option<Vec<String>> = files
        .iter()
        .map(|file| {
            file.as_str()
                .map(str::trim)
                .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
                .map(String::from)
        })
        .collect();
    let caption = match &args["caption"] {
        Value::Null => None,
        Value::String(text) => Some(one_line(text).ok_or(invalid)?),
        _ => return Err(invalid.into()),
    };
    Ok(Submission {
        id: id.into(),
        files: files.ok_or(invalid)?,
        labels,
        caption,
        compare: tool == Tool::Compare,
    })
}

/// The run that is answering: where its files are checked and kept.
pub struct Staging {
    run_id: String,
    /// The WSL distribution whose Linux paths this conversation reports, if any.
    distribution: Option<String>,
    recorder: Option<crate::tool_output::Recorder>,
    /// The reply's Stop. A check of a hung share or mount takes as long as it takes, but the
    /// reply waits for the call, so Stop ends the check.
    cancel: CancellationToken,
}
impl Staging {
    pub fn new(
        run_id: &str,
        distribution: Option<String>,
        channel: Option<&EventSink>,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            distribution,
            recorder: channel.and_then(EventSink::recorder),
            cancel,
        }
    }
    /// The reply's Stop, which ends a check or a preview under way.
    pub(super) fn cancel(&self) -> &CancellationToken {
        &self.cancel
    }
    /// A reported path on this computer. Linux paths reach Windows through the
    /// distribution's own translation; nothing else resolves a caller's path.
    pub(super) async fn host_path(&self, path: &str) -> Result<PathBuf, String> {
        let Some(distribution) = &self.distribution else {
            let resolved = PathBuf::from(path);
            if !resolved.is_absolute() {
                return Err("needs an absolute path".into());
            }
            return Ok(resolved);
        };
        if !path.starts_with('/') {
            return Err("needs an absolute path in this Linux distribution".into());
        }
        let (folder, name) = path.rsplit_once('/').ok_or("needs an absolute path")?;
        if name.is_empty() || name == "." || name == ".." {
            return Err("names a folder, not a file".into());
        }
        // Windows reads a backslash or a colon in the name as a path of its own, and drops
        // trailing dots and spaces, which would name another file.
        if name.contains(['\\', ':']) || name.ends_with(['.', ' ']) {
            return Err("has a name this computer cannot reach from Windows".into());
        }
        let folder = if folder.is_empty() { "/" } else { folder };
        Ok(crate::folders::windows_path(distribution, folder)
            .await
            .map_err(|_| "is in a folder this computer cannot reach".to_string())?
            .join(name))
    }
}

/// What a checked path turned out to be. A picture is shown as an image, a model opens in the
/// reply's 3D viewer, and a table, a document, a video or a sound in a view of its own.
enum Checked {
    Image(crate::tool_output::ImageFile),
    Model(crate::tool_output::ModelFile),
    Other(files::ShownFile),
}
/// Recognizes one offered path on this computer. Pictures, models, videos, sound and workbooks
/// are recognized by their own bytes; any text could be a CSV, TSV or Markdown file, so the name
/// decides those, and a name asking for one of them is checked first, since a few lines of text
/// can read like an OBJ model. The explanation follows the kind the name suggests.
async fn inspect(host: PathBuf, reported: &str) -> Result<Checked, String> {
    let reported = reported.to_string();
    tokio::task::spawn_blocking(move || {
        let image = crate::tool_output::inspect_image(&host);
        if let Ok(image) = image.as_ref() {
            return Ok(Checked::Image(image.clone()));
        }
        let named = extension(&reported);
        let named_model = matches!(
            named.as_deref(),
            Some("glb" | "gltf" | "obj" | "stl" | "fbx")
        );
        let named_other = files::named(&reported).is_some();
        if named_other {
            return files::inspect(&host, &reported).map(Checked::Other);
        }
        match crate::tool_output::inspect_model(&host) {
            Ok(model) => return Ok(Checked::Model(model)),
            Err(model) if named_model => return Err(model),
            Err(_) => {}
        }
        files::inspect(&host, &reported)
            .map(Checked::Other)
            .map_err(|other| {
                if other == files::NOT_SHOWN && named.as_deref().is_some_and(is_image_name) {
                    image.expect_err("image check failed")
                } else {
                    other
                }
            })
    })
    .await
    .unwrap_or_else(|_| Err("could not be checked".into()))
}
/// A name that asks for one of the pictures the viewer shows.
fn is_image_name(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp")
}
fn extension(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let (_, extension) = name.rsplit_once('.')?;
    Some(extension.to_ascii_lowercase())
}
/// The media type a reply records for a model, so one field names every kind of file.
fn model_media_type(format: &str) -> &'static str {
    match format {
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" => "model/obj",
        "stl" => "model/stl",
        _ => "model/fbx",
    }
}

fn file_name(path: &str) -> String {
    let name = path
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path);
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    if name.chars().count() > MAX_NAME {
        return name.chars().take(MAX_NAME).collect();
    }
    name
}

#[derive(Default)]
pub struct FileSender {
    groups: Vec<SentFiles>,
    published: bool,
    /// Only the parent assistant's actual tool calls can show files (Claude), each with the
    /// tool it called.
    pending: HashMap<String, (Tool, Value)>,
    accepted: HashMap<String, SentFiles>,
}
impl FileSender {
    async fn submit(
        &mut self,
        args: &Value,
        tool: Tool,
        tool_id: &str,
        staging: &Staging,
    ) -> Result<String, String> {
        let submission = parse(args, tool)?;
        let index = self.groups.iter().position(|g| g.id == submission.id);
        let Some(recorder) = &staging.recorder else {
            return Err(
                "This conversation does not keep files on the computer that ran it.".into(),
            );
        };
        let mut shown = vec![];
        let mut images = vec![];
        let mut models = vec![];
        let mut others = vec![];
        let mut rejected = vec![];
        for (position, path) in submission.files.iter().enumerate() {
            let check = async {
                match staging.host_path(path).await {
                    Ok(host) => inspect(host, path).await,
                    Err(reason) => Err(reason),
                }
            };
            let checked = tokio::select! {
                checked = check => checked,
                _ = staging.cancel.cancelled() => Err("was not checked: the reply stopped".into()),
            };
            // A label stays with its own file, whichever files before it could not be shown.
            let label = submission
                .labels
                .as_ref()
                .and_then(|labels| labels.get(position))
                .cloned();
            match checked {
                Ok(Checked::Other(other)) if submission.compare => rejected.push(format!(
                    "  {path}: is {}, which compare_files does not compare; send it with send_files",
                    match other.kind {
                        files::Kind::Table => "a table",
                        files::Kind::Document => "a document",
                        files::Kind::Video => "a video",
                        files::Kind::Audio => "audio",
                    }
                )),
                Ok(Checked::Other(other)) => {
                    shown.push(SentFile {
                        index: others.len(),
                        name: file_name(path),
                        media_type: other.media_type.into(),
                        bytes: other.bytes,
                        width: other.width,
                        height: other.height,
                        label,
                    });
                    others.push(path.clone());
                }
                Ok(Checked::Image(image)) => {
                    shown.push(SentFile {
                        index: images.len(),
                        name: file_name(path),
                        media_type: image.media_type,
                        bytes: image.bytes,
                        width: image.width,
                        height: image.height,
                        label,
                    });
                    images.push(path.clone());
                }
                Ok(Checked::Model(model)) => {
                    shown.push(SentFile {
                        index: models.len(),
                        name: file_name(path),
                        media_type: model_media_type(&model.format).into(),
                        bytes: model.bytes,
                        width: None,
                        height: None,
                        label,
                    });
                    models.push(path.clone());
                }
                Err(reason) => rejected.push(format!("  {path}: {reason}")),
            }
        }
        if shown.is_empty() {
            return Err(format!(
                "No file could be shown:\n{}\nTell the user, and do not claim the files are visible.",
                rejected.join("\n")
            ));
        }
        if submission.compare && shown.len() < 2 {
            return Err(format!(
                "Only one file could be shown, and a comparison needs two:\n{}\nTell the user, and do not claim the comparison is visible.",
                rejected.join("\n")
            ));
        }
        let mut output = CapturedOutput::new(tool_id);
        output.images = images
            .into_iter()
            .map(|path| ImageSource::File { path })
            .collect();
        output.models = models;
        output.others = others;
        output.sent = true;
        recorder.record(output);
        let record = SentFiles {
            id: submission.id,
            revision: index.map_or(1, |i| self.groups[i].revision + 1),
            run_id: staging.run_id.clone(),
            tool_id: tool_id.into(),
            caption: submission.caption,
            files: shown,
            compare: submission.compare,
        };
        let outcome = outcome(&record, &rejected);
        match index {
            Some(i) => self.groups[i] = record,
            None => self.groups.push(record),
        }
        Ok(outcome)
    }
    /// Whether this reply has shown files, so files alone are a complete answer.
    pub fn has_files(&self) -> bool {
        self.published
    }
    fn latest(&self, id: &str) -> Option<SentFiles> {
        self.groups.iter().find(|g| g.id == id).cloned()
    }
    /// A Codex dynamic tool call, answered after its paths are checked here.
    pub async fn codex(
        &mut self,
        value: &Value,
        root: &str,
        staging: &Staging,
    ) -> Option<(Value, Option<RunEvent>)> {
        let p = &value["params"];
        if value["method"] != "item/tool/call" {
            return None;
        }
        let tool = Tool::named(p["tool"].as_str()?)?;
        let call = format!("{}-{}", tool.name(), value["id"]);
        let result = if !root.is_empty() && p["threadId"] == root && p["namespace"].is_null() {
            self.submit(&p["arguments"], tool, &call, staging).await
        } else {
            Err("Files must be sent by the parent conversation.".into())
        };
        let id = p["arguments"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let sent = result.is_ok();
        let text = match &result {
            Ok(text) => text.clone(),
            Err(error) => error.clone(),
        };
        let response = json!({"id":value["id"],"result":{"success":sent,"contentItems":[{"type":"inputText","text":text}]}});
        let event = sent
            .then(|| self.latest(&id))
            .flatten()
            .map(|sent_files| RunEvent::SentFiles { sent_files });
        self.published |= event.is_some();
        Some((response, event))
    }
    /// Claude reports its parent tool calls before the SDK asks this server to run them,
    /// and their results when they finish. A file group is published only with its result.
    pub fn observe_claude(&mut self, value: &Value) -> Vec<RunEvent> {
        let mut events = vec![];
        if !value["parent_tool_use_id"].is_null() {
            return events;
        }
        let Some(blocks) = value["message"]["content"].as_array() else {
            return events;
        };
        for block in blocks {
            if value["type"] == "assistant" && block["type"] == "tool_use" {
                if let (Some(tool), Some(id)) = (Tool::claude(&block["name"]), block["id"].as_str())
                {
                    if parse(&block["input"], tool).is_ok() {
                        self.pending
                            .insert(id.into(), (tool, block["input"].clone()));
                    }
                }
            }
            if value["type"] == "user" && block["type"] == "tool_result" {
                if let Some(id) = block["tool_use_id"].as_str() {
                    self.pending.remove(id);
                    if let Some(sent_files) = self.accepted.remove(id) {
                        if block["is_error"] != true {
                            self.published = true;
                            events.push(RunEvent::SentFiles { sent_files });
                        }
                    }
                }
            }
        }
        events
    }
    /// Why a call that matches no registered parent cannot show files. A call is registered
    /// only when its arguments parse, so name the fault the caller can act on: reporting
    /// malformed arguments as an unregistered caller reads as a capability this conversation
    /// lacks, and a model that believes that stops retrying.
    fn unmatched(&self, args: &Value, tool: Tool) -> String {
        if let Err(invalid) = parse(args, tool) {
            return invalid;
        }
        format!(
            "Only a registered parent-conversation {} call can show files.",
            tool.name()
        )
    }
    /// A Claude SDK tool call for this conversation's files. Other requests of the
    /// agent_studio server are left to their own handlers.
    pub async fn claude(&mut self, value: &Value, staging: &Staging) -> Option<Value> {
        let r = &value["request"];
        let m = &r["message"];
        if r["subtype"] != "mcp_message"
            || r["server_name"] != "agent_studio"
            || m["method"] != "tools/call"
        {
            return None;
        }
        let tool = Tool::named(m["params"]["name"].as_str()?)?;
        let args = &m["params"]["arguments"];
        let parent = self
            .pending
            .iter()
            .find(|(id, (called, input))| {
                *called == tool && input == args && !self.accepted.contains_key(*id)
            })
            .map(|(id, _)| id.clone());
        let result = match parent {
            Some(id) => {
                let result = self.submit(args, tool, &id, staging).await;
                if result.is_ok() {
                    if let Some(record) = self.latest(args["id"].as_str().unwrap_or_default()) {
                        self.accepted.insert(id, record);
                    }
                }
                result
            }
            None => Err(self.unmatched(args, tool)),
        };
        let text = match &result {
            Ok(text) => text.clone(),
            Err(error) => error.clone(),
        };
        let response = json!({"jsonrpc":"2.0","id":m["id"],"result":{"isError":result.is_err(),"content":[{"type":"text","text":text}]}});
        Some(
            json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"mcp_response":response}}}),
        )
    }
}

fn outcome(record: &SentFiles, rejected: &[String]) -> String {
    let count = record.files.len();
    let noun = if count == 1 { "file is" } else { "files are" };
    let mut text = if record.compare {
        format!(
            "{count} files are shown side by side for comparison. Place <!-- files:{} --> on its own line between blank lines in your final answer, where the comparison belongs in the explanation. Do not repeat the paths as Markdown image links.",
            record.id
        )
    } else {
        format!(
            "{count} {noun} shown to the user. Place <!-- files:{} --> on its own line between blank lines in your final answer, where the {} belong{} in the explanation. Do not repeat the paths as Markdown image links.",
            record.id,
            if count == 1 { "file" } else { "files" },
            if count == 1 { "s" } else { "" }
        )
    };
    if !rejected.is_empty() {
        text.push_str(&format!(
            "\n\nNot shown:\n{}\nTell the user which files could not be shown and why.",
            rejected.join("\n")
        ));
    }
    text
}

/// A PNG header, which the image check reads a picture's size from, for tests that show files.
#[cfg(test)]
pub(crate) fn test_png(path: &std::path::Path, width: u8, height: u8) {
    std::fs::write(
        path,
        [
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, width, 0, 0, 0, height, 8, 2, 0, 0, 0,
        ],
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(distribution: Option<String>) -> Staging {
        Staging::new("run", distribution, None, CancellationToken::new())
    }
    /// A run that keeps its files, as a conversation's run does.
    fn kept() -> Staging {
        Staging {
            recorder: Some(crate::tool_output::Recorder::detached("run")),
            ..stage(None)
        }
    }
    fn args(files: Value) -> Value {
        json!({"id":"shots","files":files,"caption":"Before and after"})
    }
    fn parse_send(args: &Value) -> Result<Submission, String> {
        parse(args, Tool::Send)
    }

    #[test]
    fn rejects_unknown_fields_and_malformed_input() {
        let parse = parse_send;
        assert!(parse(&args(json!(["/tmp/a.png"]))).is_ok());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"display":"render"})).is_err());
        assert!(parse(&json!({"id":"shots"})).is_err());
        assert!(parse(&args(json!([]))).is_err());
        // Any number of files, ids, paths and captions of any length, past the 8 files, 80, 4,096
        // and 300 characters earlier releases accepted.
        let long = format!("/tmp/{}.png", "a".repeat(5000));
        let many = parse(&json!({"id":"a".repeat(200),"files":vec![long.as_str(); 20],"caption":"c".repeat(1000)})).unwrap();
        assert_eq!(many.files.len(), 20);
        assert!(parse(&args(json!(["/tmp/a.png", ""]))).is_err());
        assert!(parse(&args(json!(["/tmp/a\u{0}.png"]))).is_err());
        assert!(parse(&json!({"id":"shots and more","files":["/tmp/a.png"]})).is_err());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"caption":["x"]})).is_err());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"caption":"  "})).is_err());
        // Labels belong to comparisons.
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"labels":["A"]})).is_err());
    }

    #[test]
    fn keeps_captions_on_one_line_and_names_from_paths() {
        let parse = parse_send;
        let parsed = parse(&json!({"id":"a","files":["/tmp/a.png"],"caption":"one\ntwo"})).unwrap();
        assert_eq!(parsed.caption.as_deref(), Some("one two"));
        let parsed =
            parse(&json!({"id":"a","files":["/tmp/a.png"],"caption":"Front\tBack\u{7}"})).unwrap();
        assert_eq!(parsed.caption.as_deref(), Some("Front Back"));
        assert_eq!(file_name("/home/me/shot.png"), "shot.png");
        assert_eq!(file_name(r"C:\renders\front.png"), "front.png");
        assert_eq!(file_name("/home/me/"), "me");
    }

    #[test]
    fn a_comparison_names_two_or_more_files_and_one_label_for_each() {
        let parse = |args: Value| parse(&args, Tool::Compare);
        let pair = json!(["/tmp/before.png", "/tmp/after.png"]);
        let parsed = parse(
            json!({"id":"ab","files":pair,"labels":["Before\n","  After\t"],"caption":"Upscaled"}),
        )
        .unwrap();
        assert!(parsed.compare);
        assert_eq!(
            parsed.labels,
            Some(vec!["Before".to_string(), "After".to_string()])
        );
        assert!(parse(json!({"id":"ab","files":pair}))
            .unwrap()
            .labels
            .is_none());
        // One file is a group for send_files, which the refusal names.
        let one = parse(json!({"id":"ab","files":["/tmp/a.png"]}))
            .err()
            .unwrap();
        assert!(one.contains("two or more files"), "{one}");
        assert!(one.contains("send_files shows one"), "{one}");
        // Any number of files, past two.
        let many = vec!["/tmp/a.png"; 12];
        assert_eq!(
            parse(json!({"id":"ab","files":many})).unwrap().files.len(),
            12
        );
        // Labels follow the files one for one.
        let short = parse(json!({"id":"ab","files":pair,"labels":["Before"]}))
            .err()
            .unwrap();
        assert!(short.contains("1 labels for 2 files"), "{short}");
        assert!(parse(json!({"id":"ab","files":pair,"labels":["Before","  "]})).is_err());
        assert!(parse(json!({"id":"ab","files":pair,"labels":["Before",3]})).is_err());
        assert!(parse(json!({"id":"ab","files":pair,"labels":"Before, After"})).is_err());
        // The send_files fields alone are not enough to rename one.
        let renamed = parse(json!({"id":"ab","paths":pair})).err().unwrap();
        assert!(renamed.contains("sent paths"), "{renamed}");
        assert!(
            renamed.contains("labels (one single-line label per file"),
            "{renamed}"
        );
    }

    #[tokio::test]
    async fn a_run_without_a_store_cannot_show_files() {
        let staging = stage(None);
        let mut sender = FileSender::default();
        let error = sender
            .submit(&args(json!(["/tmp/a.png"])), Tool::Send, "call", &staging)
            .await
            .unwrap_err();
        assert!(error.contains("does not keep files"));
    }

    fn png(path: &std::path::Path) {
        test_png(path, 4, 3);
    }

    #[tokio::test]
    async fn a_comparison_keeps_each_label_with_its_file_and_needs_two_shown() {
        let dir = tempfile::tempdir().unwrap();
        let [before, after] = ["before.png", "after.png"].map(|name| dir.path().join(name));
        png(&before);
        png(&after);
        let missing = dir.path().join("missing.png");
        let path = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let staging = kept();
        let mut sender = FileSender::default();
        let input = json!({"id":"ab","files":[path(&before), path(&missing), path(&after)],"labels":["Before","Gone","After"]});
        let text = sender
            .submit(&input, Tool::Compare, "call", &staging)
            .await
            .unwrap();
        assert!(text.contains("2 files are shown side by side"), "{text}");
        assert!(text.contains("<!-- files:ab -->"), "{text}");
        assert!(text.contains("missing.png"), "{text}");
        let record = sender.latest("ab").unwrap();
        assert!(record.compare);
        let labels: Vec<_> = record.files.iter().map(|f| f.label.as_deref()).collect();
        assert_eq!(labels, [Some("Before"), Some("After")]);
        // The images keep their places in the stored result.
        assert_eq!(
            record.files.iter().map(|f| f.index).collect::<Vec<_>>(),
            [0, 1]
        );
        // A saved comparison says so; a plain group's record carries no flag.
        let saved = serde_json::to_value(&record).unwrap();
        assert_eq!(saved["compare"], true);
        assert_eq!(saved["files"][0]["label"], "Before");

        // One file left is no comparison, and nothing is shown or replaced.
        let input = json!({"id":"ab","files":[path(&before), path(&missing)]});
        let error = sender
            .submit(&input, Tool::Compare, "call2", &staging)
            .await
            .unwrap_err();
        assert!(error.contains("a comparison needs two"), "{error}");
        assert_eq!(sender.latest("ab").unwrap().revision, 1);

        // The same id sent by send_files replaces the comparison with a plain group.
        sender
            .submit(
                &json!({"id":"ab","files":[path(&after)]}),
                Tool::Send,
                "call3",
                &staging,
            )
            .await
            .unwrap();
        let replaced = sender.latest("ab").unwrap();
        assert_eq!(replaced.revision, 2);
        assert!(!replaced.compare);
        assert!(replaced.files[0].label.is_none());
        let saved = serde_json::to_value(&replaced).unwrap();
        assert!(saved.get("compare").is_none());
        assert!(saved["files"][0].get("label").is_none());
    }

    #[tokio::test]
    async fn unreadable_paths_are_reported_without_a_group() {
        let staging = stage(Some("Ubuntu".into()));
        assert!(staging.host_path("relative.png").await.is_err());
        assert!(staging.host_path("/home/me/").await.is_err());
        assert!(staging.host_path("/home/me/..").await.is_err());
        // A Linux name Windows would read as a path of its own is refused before translation.
        let error = staging
            .host_path("/tmp/C:\\Users\\me\\x.png")
            .await
            .unwrap_err();
        assert!(error.contains("cannot reach from Windows"), "{error}");
        assert!(staging.host_path("/tmp/shot.png.").await.is_err());
        let local = stage(None);
        assert!(local.host_path("relative.png").await.is_err());
    }

    #[tokio::test]
    async fn only_a_registered_parent_call_of_this_conversation_shows_files() {
        let staging = stage(None);
        let mut sender = FileSender::default();
        let call = json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":NAME,"arguments":args(json!(["/tmp/a.png"]))}}}});
        // Another server's request and other methods belong to their own handlers.
        assert!(sender
            .claude(
                &json!({"request":{"subtype":"mcp_message","server_name":"other","message":{"method":"tools/call","params":{"name":NAME}}}}),
                &staging
            )
            .await
            .is_none());
        assert!(sender
            .claude(&json!({"request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"method":"tools/list"}}}), &staging)
            .await
            .is_none());
        let refused = sender.claude(&call, &staging).await.unwrap();
        let content = &refused["response"]["response"]["mcp_response"]["result"];
        assert_eq!(content["isError"], true);
        assert!(content["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("registered parent-conversation"));
        // A sub-agent's tool call never registers a parent call.
        sender.observe_claude(&json!({"type":"assistant","parent_tool_use_id":"child","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__agent_studio__send_files","input":args(json!(["/tmp/a.png"]))}]}}));
        let refused = sender.claude(&call, &staging).await.unwrap();
        assert_eq!(
            refused["response"]["response"]["mcp_response"]["result"]["isError"],
            true
        );
        // The parent's own call reaches the checks, which need this run's store.
        sender.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__agent_studio__send_files","input":args(json!(["/tmp/a.png"]))}]}}));
        let answered = sender.claude(&call, &staging).await.unwrap();
        let text = answered["response"]["response"]["mcp_response"]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("does not keep files"));
    }

    #[tokio::test]
    async fn a_parent_call_hears_the_fault_it_can_act_on() {
        let staging = stage(None);
        let control = |arguments: Value| json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":NAME,"arguments":arguments}}}});
        let observed = |tool: &str, input: Value| json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":tool,"name":format!("mcp__agent_studio__{NAME}"),"input":input}]}});
        let refusal = |answer: &Value| {
            answer["response"]["response"]["mcp_response"]["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        };
        // The schema names the paths `files`. A call that misnames them cannot register, and
        // hearing about registration instead reads as a capability this conversation lacks.
        let mut sender = FileSender::default();
        let misnamed = json!({"id":"shots","paths":["/tmp/a.png"]});
        sender.observe_claude(&observed("t1", misnamed.clone()));
        let answer = sender.claude(&control(misnamed), &staging).await.unwrap();
        let text = refusal(&answer);
        assert!(
            text.contains("sent paths, which this tool does not accept"),
            "{text}"
        );
        assert!(text.contains("files (one or more absolute paths"), "{text}");
        assert!(!text.contains("registered parent-conversation"), "{text}");
        // A reply registers any number of groups.
        let mut sender = FileSender::default();
        for index in 0..20 {
            let input = json!({"id":format!("g{index}"),"files":["/tmp/a.png"]});
            sender.observe_claude(&observed(&format!("t{index}"), input));
        }
        assert_eq!(sender.pending.len(), 20);
        // A well-formed call still needs its registered parent.
        let mut sender = FileSender::default();
        let answer = sender
            .claude(&control(args(json!(["/tmp/a.png"]))), &staging)
            .await
            .unwrap();
        assert!(refusal(&answer).contains("registered parent-conversation"));
    }
    #[tokio::test]
    async fn codex_files_come_from_the_parent_thread_alone() {
        let staging = stage(None);
        let mut sender = FileSender::default();
        let call = |thread: &str, namespace: Value| json!({"id":7,"method":"item/tool/call","params":{"threadId":thread,"tool":NAME,"namespace":namespace,"arguments":args(json!(["/tmp/a.png"]))}});
        assert!(sender
            .codex(
                &json!({"id":7,"method":"item/tool/call","params":{"threadId":"root","tool":"visualize"}}),
                "root",
                &staging
            )
            .await
            .is_none());
        for value in [call("child", Value::Null), call("root", json!("mcp"))] {
            let (response, event) = sender.codex(&value, "root", &staging).await.unwrap();
            assert_eq!(response["result"]["success"], false);
            assert!(event.is_none());
            assert!(response["result"]["contentItems"][0]["text"]
                .as_str()
                .unwrap()
                .contains("parent conversation"));
        }
        let (response, event) = sender
            .codex(&call("root", Value::Null), "root", &staging)
            .await
            .unwrap();
        assert_eq!(response["result"]["success"], false);
        assert!(event.is_none());
    }

    #[tokio::test]
    async fn a_comparison_comes_from_its_own_registered_call() {
        let dir = tempfile::tempdir().unwrap();
        let [before, after] = ["before.png", "after.png"].map(|name| {
            let path = dir.path().join(name);
            png(&path);
            path.to_string_lossy().into_owned()
        });
        let staging = kept();
        let control = |tool: &str, arguments: &Value| json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":tool,"arguments":arguments}}}});
        let observed = |id: &str, tool: &str, input: &Value| json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":id,"name":format!("mcp__agent_studio__{tool}"),"input":input}]}});
        let answer =
            |value: &Value| value["response"]["response"]["mcp_response"]["result"].clone();
        // Arguments both tools accept: a send_files call never lets compare_files through.
        let input = json!({"id":"ab","files":[before, after]});
        let mut sender = FileSender::default();
        sender.observe_claude(&observed("t1", NAME, &input));
        let refused = answer(
            &sender
                .claude(&control(COMPARE_NAME, &input), &staging)
                .await
                .unwrap(),
        );
        assert_eq!(refused["isError"], true);
        assert!(refused["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("registered parent-conversation compare_files call"));
        sender.observe_claude(&observed("t2", COMPARE_NAME, &input));
        let answered = answer(
            &sender
                .claude(&control(COMPARE_NAME, &input), &staging)
                .await
                .unwrap(),
        );
        assert_eq!(answered["isError"], false, "{answered}");
        assert!(answered["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("side by side"));
        // It is published with the call's result, as a comparison.
        let events = sender.observe_claude(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"shown"}]}}));
        let [RunEvent::SentFiles { sent_files }] = events.as_slice() else {
            panic!("one comparison is published: {events:?}");
        };
        assert!(sent_files.compare);
        assert_eq!(sent_files.tool_id, "t2");

        // Codex: the parent thread's call, under its own call id.
        let mut sender = FileSender::default();
        let call = json!({"id":9,"method":"item/tool/call","params":{"threadId":"root","tool":COMPARE_NAME,"namespace":null,"arguments":{"id":"ab","files":[before, after],"labels":["Before","After"]}}});
        let (response, event) = sender.codex(&call, "root", &staging).await.unwrap();
        assert_eq!(response["result"]["success"], true, "{response}");
        let Some(RunEvent::SentFiles { sent_files }) = event else {
            panic!("the comparison is published at once");
        };
        assert!(sent_files.compare);
        assert_eq!(sent_files.tool_id, "compare_files-9");
        assert_eq!(sent_files.files[1].label.as_deref(), Some("After"));
        assert!(sender.has_files());
    }

    #[tokio::test]
    async fn tables_documents_videos_and_audio_are_shown_but_never_compared() {
        let dir = tempfile::tempdir().unwrap();
        let path = |name: &str, bytes: &[u8]| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        };
        let image = dir.path().join("chart.png");
        png(&image);
        let image = image.to_string_lossy().into_owned();
        let table = path("sales.csv", b"Region,Sales\nNorth,12\n");
        let document = path("notes.md", b"# Notes\n");
        let video = path(
            "clip.mp4",
            &crate::tool_output::files::tests::mp4(1280, 720),
        );
        let sound = path("voice.wav", b"RIFF\x24\0\0\0WAVEfmt \x10\0\0\0");
        let staging = kept();
        let mut sender = FileSender::default();
        let input = json!({"id":"mixed","files":[image, table, document, video, sound]});
        let text = sender
            .submit(&input, Tool::Send, "call", &staging)
            .await
            .unwrap();
        assert!(text.contains("5 files are shown"), "{text}");
        let record = sender.latest("mixed").unwrap();
        let shown: Vec<_> = record
            .files
            .iter()
            .map(|f| (f.media_type.as_str(), f.index))
            .collect();
        // Images, models and the other files are each numbered from 0.
        assert_eq!(
            shown,
            [
                ("image/png", 0),
                ("text/csv", 0),
                ("text/markdown", 1),
                ("video/mp4", 2),
                ("audio/wav", 3)
            ]
        );
        assert_eq!(
            (record.files[3].width, record.files[3].height),
            (Some(1280), Some(720))
        );
        // A comparison takes images and models alone, and says where the others belong.
        let input = json!({"id":"pair","files":[table, video, sound]});
        let error = sender
            .submit(&input, Tool::Compare, "call2", &staging)
            .await
            .unwrap_err();
        assert!(
            error.contains("is a table, which compare_files does not compare"),
            "{error}"
        );
        assert!(error.contains("is a video"), "{error}");
        assert!(
            error.contains("voice.wav: is audio, which compare_files does not compare; send it with send_files"),
            "{error}"
        );
        // A name asking for text is checked as text, even when its lines read like a model's.
        let lines = path("faces.md", b"v 1 2 3\nv 4 5 6\nf 1 2 3\n");
        let input = json!({"id":"lines","files":[lines]});
        sender
            .submit(&input, Tool::Send, "call3", &staging)
            .await
            .unwrap();
        assert_eq!(
            sender.latest("lines").unwrap().files[0].media_type,
            "text/markdown"
        );
    }

    #[test]
    fn both_tools_are_offered_with_their_own_schema() {
        assert_eq!(compare_tool()["name"], COMPARE_NAME);
        assert_eq!(
            compare_tool()["inputSchema"]["properties"]["files"]["minItems"],
            2
        );
        assert!(compare_tool()["inputSchema"]["properties"]["labels"].is_object());
        assert!(tool()["inputSchema"]["properties"]["labels"].is_null());
        assert_eq!(codex_compare_tool()["type"], "function");
        assert_eq!(codex_compare_tool()["deferLoading"], false);
        assert!(COMPARE_GUIDANCE.contains("mcp__agent_studio__compare_files"));
        assert!(COMPARE_GUIDANCE.contains("<!-- files:ID -->"));
    }

    #[tokio::test]
    async fn each_path_is_recognized_as_an_image_or_a_model_where_it_runs() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        std::fs::write(
            &png,
            [
                0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D',
                b'R', 0, 0, 0, 4, 0, 0, 0, 3, 8, 2, 0, 0, 0,
            ],
        )
        .unwrap();
        let model = dir.path().join("figure.glb");
        // A GLB header and the document chunk it carries.
        let document = br#"{"asset":{"version":"2.0"}} "#;
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend((20 + document.len() as u32).to_le_bytes());
        glb.extend((document.len() as u32).to_le_bytes());
        glb.extend(b"JSON");
        glb.extend(document);
        std::fs::write(&model, glb).unwrap();
        let broken = dir.path().join("broken.glb");
        std::fs::write(&broken, b"not a model at all").unwrap();
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, b"plain text").unwrap();
        let checked = |path: &std::path::Path| {
            let host = path.to_path_buf();
            let reported = path.to_string_lossy().into_owned();
            async move { inspect(host, &reported).await }
        };
        assert!(matches!(checked(&png).await, Ok(Checked::Image(_))));
        let Ok(Checked::Model(model)) = checked(&model).await else {
            panic!("a GLB is shown as a model");
        };
        assert_eq!(model.format, "glb");
        assert_eq!(model_media_type(&model.format), "model/gltf-binary");
        // The explanation follows what the file was meant to be.
        assert!(checked(&broken)
            .await
            .err()
            .unwrap()
            .contains("is not a glTF, GLB, OBJ, STL or FBX model"));
        assert!(checked(&notes)
            .await
            .err()
            .unwrap()
            .contains("is not a file a reply can show"));
    }

    #[test]
    fn outcome_names_the_marker_and_the_rejected_files() {
        let record = SentFiles {
            id: "shots".into(),
            revision: 1,
            run_id: "run".into(),
            tool_id: "call".into(),
            caption: None,
            files: vec![SentFile {
                index: 0,
                name: "a.png".into(),
                media_type: "image/png".into(),
                bytes: 12,
                width: Some(4),
                height: Some(3),
                label: None,
            }],
            compare: false,
        };
        let text = outcome(&record, &["  /tmp/b.txt: not an image".into()]);
        assert!(text.contains("<!-- files:shots -->"));
        assert!(text.contains("1 file is shown"));
        assert!(text.contains("/tmp/b.txt: not an image"));
    }
}
