//! Files a reply shows the user. Paths reach this module only through our registered tool,
//! are checked on the computer running the conversation, and their bytes stay there with the
//! run's other tool results. The saved reply keeps bounded metadata and each image is read on
//! demand, so the workspace, exports and relay sync never carry file contents.
use crate::protocol::activity::{CapturedOutput, ImageSource};
use crate::protocol::RunEvent;
use crate::runner::EventSink;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

pub const NAME: &str = "send_files";
/// Files one call shows.
const MAX_FILES: usize = 8;
/// Groups one reply shows.
pub const MAX_GROUPS: usize = 12;
/// The largest file a reply shows, matching one chat attachment.
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PATH: usize = 4096;
const MAX_CAPTION: usize = 300;
const MAX_NAME: usize = 120;

pub const GUIDANCE: &str = "To show the user an image or a 3D model that exists on the computer running this conversation, call the send_files tool (Claude: mcp__agent_studio__send_files) with a stable id, its absolute paths, and an optional one-line caption. Use it for a render, a screenshot, a chart, a diagram or a model the user should see now, instead of only naming its path; skip routine working files. After a successful call, put <!-- files:ID --> on its own line between blank lines where the files belong in your final answer, replacing ID with the submitted id; each group appears once, and reusing an id replaces that group. PNG, JPEG, GIF and WebP images of up to 16 MiB and glTF, GLB, OBJ, STL and FBX models of up to 12 MiB are shown, at most 8 files per call and 12 groups per reply. A model opens in a viewer the reader can turn and zoom, and animations inside it play there. Send a self-contained file: a .glb rather than a .gltf that loads separate buffers, and expect OBJ, STL and FBX to appear untextured when their textures are separate files beside them. Paths must be absolute on that computer; other files, unreadable paths and Markdown image links are not displayed. The reader's window loads each file from that computer when it opens the reply.";

/// One shown file, as the saved reply records it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentFile {
    /// This image's position in the call's stored result.
    pub index: usize,
    pub name: String,
    pub media_type: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
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
}

pub fn tool() -> Value {
    json!({"name":NAME,"description":GUIDANCE,"inputSchema":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1,"maxLength":80,"pattern":"^[a-zA-Z0-9_-]+$","description":"Stable identifier; reuse to replace this group within the current reply."},
            "files":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":4096},"description":"Absolute paths on the computer running this conversation: PNG, JPEG, GIF or WebP images, or glTF, GLB, OBJ, STL or FBX models."},
            "caption":{"type":"string","minLength":1,"maxLength":300,"description":"Optional single line shown above the files."}
        },"required":["id","files"],"additionalProperties":false}})
}
pub fn codex_tool() -> Value {
    let mut tool = tool();
    tool["type"] = json!("function");
    tool["deferLoading"] = json!(false);
    tool
}

const INVALID: &str = "Provide id (letters, digits, _ or -, at most 80), files (1 to 8 absolute paths of at most 4096 characters) and an optional single-line caption of at most 300 characters. No other fields are accepted.";

struct Submission {
    id: String,
    files: Vec<String>,
    caption: Option<String>,
}
fn parse(args: &Value) -> Result<Submission, String> {
    let object = args.as_object().ok_or(INVALID)?;
    if object.len() > 3
        || object
            .keys()
            .any(|k| !["id", "files", "caption"].contains(&k.as_str()))
    {
        return Err(INVALID.into());
    }
    let id = args["id"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or(INVALID)?;
    let files = args["files"].as_array().ok_or(INVALID)?;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(INVALID.into());
    }
    let files: Option<Vec<String>> = files
        .iter()
        .map(|file| {
            file.as_str()
                .map(str::trim)
                .filter(|path| {
                    !path.is_empty()
                        && path.len() <= MAX_PATH
                        && !path.chars().any(char::is_control)
                })
                .map(String::from)
        })
        .collect();
    let caption = match &args["caption"] {
        Value::Null => None,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() || text.chars().count() > MAX_CAPTION {
                return Err(INVALID.into());
            }
            Some(text.replace(['\r', '\n'], " "))
        }
        _ => return Err(INVALID.into()),
    };
    Ok(Submission {
        id: id.into(),
        files: files.ok_or(INVALID)?,
        caption,
    })
}

/// The run that is answering: where its files are checked and kept.
pub struct Staging {
    run_id: String,
    /// The WSL distribution whose Linux paths this conversation reports, if any.
    distribution: Option<String>,
    recorder: Option<crate::tool_output::Recorder>,
}
impl Staging {
    pub fn new(run_id: &str, distribution: Option<String>, channel: Option<&EventSink>) -> Self {
        Self {
            run_id: run_id.into(),
            distribution,
            recorder: channel.and_then(EventSink::recorder),
        }
    }
    /// A reported path on this computer. Linux paths reach Windows through the
    /// distribution's own translation; nothing else resolves a caller's path.
    async fn host_path(&self, path: &str) -> Result<PathBuf, String> {
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
        if name.is_empty() {
            return Err("names a folder, not a file".into());
        }
        let folder = if folder.is_empty() { "/" } else { folder };
        Ok(crate::folders::windows_path(distribution, folder)
            .await
            .map_err(|_| "is in a folder this computer cannot reach".to_string())?
            .join(name))
    }
}

/// What a checked path turned out to be. A picture is shown as an image; a model opens in
/// the reply's 3D viewer.
enum Checked {
    Image(crate::tool_output::ImageFile),
    Model(crate::tool_output::ModelFile),
}
/// Recognizes one offered path on this computer, preferring the kind its name suggests for
/// the explanation when neither matches.
async fn inspect(host: PathBuf, reported: &str) -> Result<Checked, String> {
    let named_model = matches!(
        extension(reported).as_deref(),
        Some("glb" | "gltf" | "obj" | "stl" | "fbx")
    );
    tokio::task::spawn_blocking(move || {
        let image = crate::tool_output::inspect_image(&host, MAX_BYTES);
        if let Ok(image) = image.as_ref() {
            return Ok(Checked::Image(image.clone()));
        }
        match crate::tool_output::inspect_model(&host, crate::tool_output::MODEL_BYTES) {
            Ok(model) => Ok(Checked::Model(model)),
            Err(model) => Err(if named_model {
                model
            } else {
                image.expect_err("image check failed")
            }),
        }
    })
    .await
    .unwrap_or_else(|_| Err("could not be checked".into()))
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
    /// Only the parent assistant's actual tool calls can show files (Claude).
    pending: HashMap<String, Value>,
    accepted: HashMap<String, SentFiles>,
}
impl FileSender {
    async fn submit(
        &mut self,
        args: &Value,
        tool_id: &str,
        staging: &Staging,
    ) -> Result<String, String> {
        let submission = parse(args)?;
        let index = self.groups.iter().position(|g| g.id == submission.id);
        if index.is_none() && self.groups.len() >= MAX_GROUPS {
            return Err(format!(
                "This reply already shows {MAX_GROUPS} groups of files. Reuse an existing id."
            ));
        }
        let Some(recorder) = &staging.recorder else {
            return Err(
                "This conversation does not keep files on the computer that ran it.".into(),
            );
        };
        let mut files = vec![];
        let mut images = vec![];
        let mut models = vec![];
        let mut rejected = vec![];
        for path in &submission.files {
            let checked = match staging.host_path(path).await {
                Ok(host) => inspect(host, path).await,
                Err(reason) => Err(reason),
            };
            match checked {
                Ok(Checked::Image(image)) => {
                    files.push(SentFile {
                        index: images.len(),
                        name: file_name(path),
                        media_type: image.media_type,
                        bytes: image.bytes,
                        width: image.width,
                        height: image.height,
                    });
                    images.push(path.clone());
                }
                Ok(Checked::Model(model)) => {
                    files.push(SentFile {
                        index: models.len(),
                        name: file_name(path),
                        media_type: model_media_type(&model.format).into(),
                        bytes: model.bytes,
                        width: None,
                        height: None,
                    });
                    models.push(path.clone());
                }
                Err(reason) => rejected.push(format!("  {path}: {reason}")),
            }
        }
        if files.is_empty() {
            return Err(format!(
                "No file could be shown:\n{}\nTell the user, and do not claim the files are visible.",
                rejected.join("\n")
            ));
        }
        let mut output = CapturedOutput::new(tool_id);
        output.images = images
            .into_iter()
            .map(|path| ImageSource::File { path })
            .collect();
        output.models = models;
        recorder.record(output);
        let record = SentFiles {
            id: submission.id,
            revision: index.map_or(1, |i| self.groups[i].revision + 1),
            run_id: staging.run_id.clone(),
            tool_id: tool_id.into(),
            caption: submission.caption,
            files,
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
        if value["method"] != "item/tool/call" || p["tool"] != NAME {
            return None;
        }
        let call = format!("{}-{}", NAME, value["id"]);
        let result = if !root.is_empty() && p["threadId"] == root && p["namespace"].is_null() {
            self.submit(&p["arguments"], &call, staging).await
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
            if value["type"] == "assistant"
                && block["type"] == "tool_use"
                && block["name"] == format!("mcp__agent_studio__{NAME}")
            {
                if let Some(id) = block["id"].as_str().filter(|id| id.len() <= 240) {
                    if self.pending.len() < MAX_GROUPS && parse(&block["input"]).is_ok() {
                        self.pending.insert(id.into(), block["input"].clone());
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
    /// A Claude SDK tool call for this conversation's files. Other requests of the
    /// agent_studio server are left to their own handlers.
    pub async fn claude(&mut self, value: &Value, staging: &Staging) -> Option<Value> {
        let r = &value["request"];
        let m = &r["message"];
        if r["subtype"] != "mcp_message"
            || r["server_name"] != "agent_studio"
            || m["method"] != "tools/call"
            || m["params"]["name"] != NAME
        {
            return None;
        }
        let args = &m["params"]["arguments"];
        let parent = self
            .pending
            .iter()
            .find(|(id, input)| *input == args && !self.accepted.contains_key(*id))
            .map(|(id, _)| id.clone());
        let result = match parent {
            Some(id) => {
                let result = self.submit(args, &id, staging).await;
                if result.is_ok() {
                    if let Some(record) = self.latest(args["id"].as_str().unwrap_or_default()) {
                        self.accepted.insert(id, record);
                    }
                }
                result
            }
            None => {
                Err("Only a registered parent-conversation send_files call can show files.".into())
            }
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
    let mut text = format!(
        "{count} {noun} shown to the user. Place <!-- files:{} --> on its own line between blank lines in your final answer, where the {} belong{} in the explanation. Do not repeat the paths as Markdown image links.",
        record.id,
        if count == 1 { "file" } else { "files" },
        if count == 1 { "s" } else { "" }
    );
    if !rejected.is_empty() {
        text.push_str(&format!(
            "\n\nNot shown:\n{}\nTell the user which files could not be shown and why.",
            rejected.join("\n")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(files: Value) -> Value {
        json!({"id":"shots","files":files,"caption":"Before and after"})
    }

    #[test]
    fn rejects_unknown_fields_and_malformed_input() {
        assert!(parse(&args(json!(["/tmp/a.png"]))).is_ok());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"display":"render"})).is_err());
        assert!(parse(&json!({"id":"shots"})).is_err());
        assert!(parse(&args(json!([]))).is_err());
        assert!(parse(&args(json!(vec!["/tmp/a.png"; MAX_FILES + 1]))).is_err());
        assert!(parse(&args(json!(["/tmp/a.png", ""]))).is_err());
        assert!(parse(&args(json!(["/tmp/a\u{0}.png"]))).is_err());
        assert!(parse(&json!({"id":"shots and more","files":["/tmp/a.png"]})).is_err());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"caption":["x"]})).is_err());
        assert!(parse(&json!({"id":"shots","files":["/tmp/a.png"],"caption":"  "})).is_err());
    }

    #[test]
    fn keeps_captions_on_one_line_and_names_from_paths() {
        let parsed = parse(&json!({"id":"a","files":["/tmp/a.png"],"caption":"one\ntwo"})).unwrap();
        assert_eq!(parsed.caption.as_deref(), Some("one two"));
        assert_eq!(file_name("/home/me/shot.png"), "shot.png");
        assert_eq!(file_name(r"C:\renders\front.png"), "front.png");
        assert_eq!(file_name("/home/me/"), "me");
    }

    #[tokio::test]
    async fn a_run_without_a_store_cannot_show_files() {
        let staging = Staging::new("run", None, None);
        let mut sender = FileSender::default();
        let error = sender
            .submit(&args(json!(["/tmp/a.png"])), "call", &staging)
            .await
            .unwrap_err();
        assert!(error.contains("does not keep files"));
    }

    #[tokio::test]
    async fn unreadable_paths_are_reported_without_a_group() {
        let staging = Staging::new("run", Some("Ubuntu".into()), None);
        assert!(staging.host_path("relative.png").await.is_err());
        assert!(staging.host_path("/home/me/").await.is_err());
        let local = Staging::new("run", None, None);
        assert!(local.host_path("relative.png").await.is_err());
    }

    #[tokio::test]
    async fn only_a_registered_parent_call_of_this_conversation_shows_files() {
        let staging = Staging::new("run", None, None);
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
    async fn codex_files_come_from_the_parent_thread_alone() {
        let staging = Staging::new("run", None, None);
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
        std::fs::write(&model, b"glTF\x02\x00\x00\x00\x14\x00\x00\x00").unwrap();
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
            .contains("is not a PNG, JPEG, GIF or WebP image"));
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
            }],
        };
        let text = outcome(&record, &["  /tmp/b.txt: not an image".into()]);
        assert!(text.contains("<!-- files:shots -->"));
        assert!(text.contains("1 file is shown"));
        assert!(text.contains("/tmp/b.txt: not an image"));
    }
}
