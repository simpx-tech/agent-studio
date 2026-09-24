//! On-demand, bounded instruction records from the conversation's own native session.
//! This is not a transcript export or a reconstruction of the complete model request.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_FILE: u64 = 64 * 1024 * 1024;
// Structured image inputs can exceed 10 MiB in one native JSONL record.
const MAX_LINE: usize = 32 * 1024 * 1024;
const MAX_TEXT: usize = 512 * 1024;
const MAX_TOTAL: usize = 1024 * 1024;
const MAX_BLOCKS: usize = 40;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionBlock {
    label: String,
    text: String,
    captured_at: Option<String>,
    version: Option<String>,
    model: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstructions {
    provider: String,
    checked_at: u64,
    blocks: Vec<InstructionBlock>,
    notice: String,
    studio_guidance: String,
}

fn bounded_metadata(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 100 && !s.chars().any(char::is_control))
        .map(String::from)
}

// Do not accept native IDs, filesystem paths, or alternate locations from callers.
pub async fn read(
    app: tauri::AppHandle,
    conversation_id: String,
    provider: String,
    connection_id: Option<String>,
) -> Result<NativeInstructions, String> {
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    if !crate::providers::valid_provider(&provider) {
        return Err("Invalid provider".into());
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let mut bytes = Vec::new();
    File::open(root.join("workspace.json"))
        .map_err(|_| "Save this conversation before inspecting its native instructions")?
        .take(20_000_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the saved conversation")?;
    if bytes.len() > 20_000_000 {
        return Err("The saved workspace exceeds its size limit".into());
    }
    let conversations =
        crate::saved::conversations(&bytes).ok_or("Cannot read the saved conversation")?;
    let location = conversation_location(
        &conversations,
        &conversation_id,
        &provider,
        connection_id.as_deref(),
    )?;
    crate::folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
    let mut profile = crate::profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profile.folder_distribution = location
        .as_ref()
        .map(|l| crate::folders::environment_distribution(&app, &l.environment_id))
        .transpose()?
        .flatten();
    crate::profiles::scope(profile, async move {
        let guidance_request: crate::providers::RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::nil(),"agent":{"provider":provider,"model":"","instructions":""},"messages":[]})).map_err(|_| "Cannot inspect Agent Studio guidance")?;
        let mut result = NativeInstructions { provider: provider.clone(), checked_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64, blocks: vec![], notice: String::new(), studio_guidance: guidance_request.guidance() };
        if !matches!(provider.as_str(), "claude" | "codex") {
            result.notice = "This provider does not expose a supported native prompt record.".into();
            return Ok(result);
        }
        let Some(id) = crate::providers::sessions::bound_id(&root, &conversation_id, &provider, location.as_ref())? else {
            result.notice = "No native session has been recorded for this conversation. Send a message to create one; older imported chats may have no native record on this computer.".into();
            return Ok(result);
        };
        let config = crate::context::native_profile_root(&provider).await?;
        tokio::task::spawn_blocking(move || {
            let Some(path) = find_record(&config, &provider, &id)? else {
                result.notice = "The bound native session record is unavailable in the selected CLI profile. It may have been moved or deleted.".into();
                return Ok(result);
            };
            result.blocks = parse_file(&path, &provider, &id)?;
            result.notice = if result.blocks.is_empty() {
                "This native session has no supported instruction snapshot yet. Refresh after its first request, or check whether this CLI version records prompts."
            } else if provider == "codex" {
                "Base instructions, when available, describe the session start. Developer messages are unique recorded messages in chronological order and may belong to earlier turns. Model changes and compaction can change later input. Tool definitions, project files, and conversation history are separate."
            } else {
                "Latest system-prompt snapshot recorded by this Claude Code session. Compaction can replace it. Tool definitions, project files, and conversation history are separate."
            }.into();
            Ok(result)
        }).await.map_err(|_| "Native instruction inspection failed")?
    }).await
}

fn conversation_location(
    conversations: &[crate::saved::Conversation],
    id: &str,
    provider: &str,
    connection: Option<&str>,
) -> Result<Option<crate::folders::ChatLocation>, String> {
    let conversation = conversations
        .iter()
        .find(|c| c.id == id)
        .ok_or("This conversation is not in the current workspace")?;
    if conversation.settings["provider"] != provider
        || conversation.settings["connectionId"].as_str() != connection
    {
        return Err("The selected account does not match this conversation".into());
    }
    // RunRequest omits the standalone path, retaining its execution identity in the connection.
    if conversation.location["path"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return Ok(None);
    }
    serde_json::from_value(conversation.location.clone())
        .map(Some)
        .map_err(|_| "The saved conversation location is invalid".into())
}

pub(crate) fn find_record(
    config: &Path,
    provider: &str,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid native session identity")?;
    let directory = config.join(if provider == "claude" {
        "projects"
    } else {
        "sessions"
    });
    if !directory.exists() {
        return Ok(None);
    }
    let root = directory
        .canonicalize()
        .map_err(|_| "Cannot access native session storage")?;
    let mut queue = vec![(root.clone(), 0)];
    let mut visited = 0;
    let mut found = None;
    while let Some((dir, depth)) = queue.pop() {
        for entry in std::fs::read_dir(dir).map_err(|_| "Cannot inspect native session storage")? {
            let entry = entry.map_err(|_| "Cannot inspect native session storage")?;
            visited += 1;
            if visited > 30_000 {
                return Err("Native session storage exceeds the inspection limit".into());
            }
            let kind = entry
                .file_type()
                .map_err(|_| "Cannot inspect a native session record")?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() && depth < if provider == "claude" { 1 } else { 3 } {
                let path = path
                    .canonicalize()
                    .map_err(|_| "Cannot access native session storage")?;
                if path.starts_with(&root) {
                    queue.push((path, depth + 1));
                }
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let matches = if provider == "claude" {
                    name == format!("{id}.jsonl")
                } else {
                    name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl"))
                };
                if matches {
                    let path = path
                        .canonicalize()
                        .map_err(|_| "Cannot access the native session record")?;
                    if !path.starts_with(&root) {
                        return Err(
                            "The native session record is outside the selected profile".into()
                        );
                    }
                    if found.replace(path).is_some() {
                        return Err("Multiple records match this native session; its instructions cannot be identified safely".into());
                    }
                }
            }
        }
    }
    Ok(found)
}

fn add(blocks: &mut Vec<InstructionBlock>, block: InstructionBlock) -> Result<(), String> {
    if block.text.len() > MAX_TEXT
        || blocks.len() >= MAX_BLOCKS
        || blocks.iter().map(|b| b.text.len()).sum::<usize>() + block.text.len() > MAX_TOTAL
    {
        return Err(
            "The recorded instructions exceed the display limit. No partial prompt is shown."
                .into(),
        );
    }
    blocks.push(block);
    Ok(())
}

fn parse_file(path: &Path, provider: &str, id: &str) -> Result<Vec<InstructionBlock>, String> {
    let file = File::open(path).map_err(|_| "Cannot read the native session record")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect the native session record")?
        .len()
        > MAX_FILE
    {
        return Err("The native session record exceeds the inspection limit".into());
    }
    let mut reader = BufReader::new(file.take(MAX_FILE + 1));
    let mut blocks = vec![];
    let mut verified = false;
    let mut total = 0;
    loop {
        let mut bytes = Vec::new();
        (&mut reader)
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "Cannot read the native session record")?;
        if bytes.is_empty() {
            break;
        }
        total += bytes.len();
        if bytes.len() > MAX_LINE || total as u64 > MAX_FILE {
            return Err("The native session record exceeds the inspection limit".into());
        }
        // A running provider may still be appending the final JSONL record.
        if bytes.last() != Some(&b'\n') {
            break;
        }
        let row: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "The native session record is unreadable")?;
        let captured_at = bounded_metadata(&row["timestamp"]);
        if provider == "claude" {
            if row["sessionId"].as_str().is_some_and(|value| value != id) {
                return Err("Native session identity mismatch".into());
            }
            if row["type"] == "attachment"
                && row["attachment"]["type"] == "prompt_snapshot"
                && row["isSidechain"] == false
            {
                if row["sessionId"] != id {
                    return Err("Native session identity is missing".into());
                }
                verified = true;
                let sections = row["attachment"]["systemPrompt"]
                    .as_array()
                    .ok_or("Unsupported native system-prompt snapshot")?;
                if sections.is_empty() || sections.len() > MAX_BLOCKS {
                    return Err("Unsupported native system-prompt snapshot".into());
                }
                blocks.clear();
                for (index, section) in sections.iter().enumerate() {
                    add(
                        &mut blocks,
                        InstructionBlock {
                            label: format!("System prompt · section {}", index + 1),
                            text: section
                                .as_str()
                                .ok_or("Unsupported native system-prompt section")?
                                .into(),
                            captured_at: captured_at.clone(),
                            version: bounded_metadata(&row["version"]),
                            model: None,
                        },
                    )?;
                }
            }
        } else if row["type"] == "session_meta" {
            let meta = &row["payload"];
            if verified || meta["id"] != id {
                return Err("Native session identity mismatch".into());
            }
            verified = true;
            let version = bounded_metadata(&meta["cli_version"]);
            if let Some(text) = meta["base_instructions"]["text"].as_str() {
                add(
                    &mut blocks,
                    InstructionBlock {
                        label: "Base instructions at session start".into(),
                        text: text.into(),
                        captured_at: bounded_metadata(&meta["timestamp"]).or(captured_at),
                        version: version.clone(),
                        model: bounded_metadata(&meta["base_instructions"]["provenance"]["model"]),
                    },
                )?;
            }
        } else if provider == "codex"
            && verified
            && row["type"] == "response_item"
            && row["payload"]["type"] == "message"
            && row["payload"]["role"] == "developer"
        {
            if let Some(content) = row["payload"]["content"].as_array() {
                let parts: Option<Vec<_>> = content
                    .iter()
                    .map(|part| {
                        if part["type"] == "input_text" {
                            part["text"].as_str()
                        } else {
                            None
                        }
                    })
                    .collect();
                let text = parts
                    .ok_or("Unsupported recorded developer message")?
                    .join("\n\n");
                if !blocks
                    .iter()
                    .any(|b| b.label == "Recorded developer message" && b.text == text)
                {
                    add(
                        &mut blocks,
                        InstructionBlock {
                            label: "Recorded developer message".into(),
                            text,
                            captured_at,
                            version: bounded_metadata(&row["cli_version"]),
                            model: None,
                        },
                    )?;
                }
            }
        }
    }
    if !verified && !blocks.is_empty() {
        return Err("Native session identity is unverified".into());
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    fn file(rows: &[Value]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for row in rows {
            writeln!(file, "{row}").unwrap();
        }
        file
    }
    fn claude(id: &str, text: &str) -> Value {
        json!({"type":"attachment","sessionId":id,"isSidechain":false,"timestamp":"2026-09-13T10:00:00Z","version":"2.1.267","attachment":{"type":"prompt_snapshot","systemPrompt":[text,"Another exact section\nwith newlines"]}})
    }
    #[test]
    fn claude_uses_latest_parent_snapshot_and_excludes_other_context() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut child = claude(&id, "child instructions");
        child["isSidechain"] = json!(true);
        let file = file(&[
            claude(&id, "old prompt"),
            json!({"type":"user","sessionId":id,"message":{"content":"private user content"}}),
            child,
            claude(&id, "Exact <script>inert</script> & text"),
        ]);
        let blocks = parse_file(file.path(), "claude", &id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "Exact <script>inert</script> & text");
        assert_eq!(blocks[0].version.as_deref(), Some("2.1.267"));
        assert_eq!(blocks[1].text, "Another exact section\nwith newlines");
        assert!(!serde_json::to_string(&blocks)
            .unwrap()
            .contains("private user"));
    }
    #[test]
    fn codex_reports_base_and_unique_developer_messages_without_user_or_tool_data() {
        let id = uuid::Uuid::new_v4().to_string();
        let message = |role, text| json!({"type":"response_item","timestamp":"2026-09-13T10:00:00Z","payload":{"type":"message","role":role,"content":[{"type":"input_text","text":text}]}});
        let file = file(&[
            json!({"type":"session_meta","payload":{"id":id,"cli_version":"0.153.4","base_instructions":{"text":"Exact base","provenance":{"model":"fixture"}},"dynamic_tools":["tool schema never exported"]}}),
            message("developer", "Developer A"),
            message("user", "private input"),
            message("assistant", "private answer"),
            message("developer", "Developer A"),
            message("developer", "Developer B"),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"private tool result"}}),
        ]);
        let blocks = parse_file(file.path(), "codex", &id).unwrap();
        assert_eq!(
            blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(),
            ["Exact base", "Developer A", "Developer B"]
        );
        assert_eq!(blocks[0].model.as_deref(), Some("fixture"));
    }
    #[test]
    fn rejects_wrong_identity_malformed_and_oversized_records_without_partial_prompts() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(parse_file(
            file(&[claude("another-id", "prompt")]).path(),
            "claude",
            &id
        )
        .is_err());
        assert!(parse_file(
            file(&[claude(&id, &"x".repeat(MAX_TEXT + 1))]).path(),
            "claude",
            &id
        )
        .is_err());
        let mut corrupt = file(&[claude(&id, "prompt")]);
        writeln!(corrupt, "invalid json").unwrap();
        assert!(parse_file(corrupt.path(), "claude", &id).is_err());
        let mut partial = file(&[claude(&id, "prompt")]);
        write!(partial, "{{\"type\":").unwrap();
        assert_eq!(
            parse_file(partial.path(), "claude", &id).unwrap()[0].text,
            "prompt"
        );
        let mut oversized = tempfile::NamedTempFile::new().unwrap();
        oversized.write_all(&vec![b'x'; MAX_LINE + 1]).unwrap();
        assert!(parse_file(oversized.path(), "codex", &id).is_err());
    }
    #[test]
    fn missing_snapshot_does_not_fabricate_prompt() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(parse_file(
            file(&[json!({"type":"user","sessionId":id,"message":"hello"})]).path(),
            "claude",
            &id
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn image_sized_user_records_do_not_hide_native_instructions_or_enter_output() {
        let id = uuid::Uuid::new_v4().to_string();
        let file = file(&[
            json!({"type":"user","sessionId":id,"message":{"content":[{"type":"image","source":{"data":"a".repeat(3*1024*1024)}}]}}),
            claude(&id, "  \n"),
        ]);
        let blocks = parse_file(file.path(), "claude", &id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "  \n");
        assert!(serde_json::to_string(&blocks).unwrap().len() < 1000);
    }
    #[test]
    fn lookup_uses_exact_bound_id_and_rejects_duplicate_matches() {
        let root = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let folder = root.path().join("sessions/2026/09/13");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join(format!("rollout-2026-09-13-{id}.jsonl"));
        std::fs::write(&path, "{}").unwrap();
        std::fs::write(folder.join(format!("wrong-prefix-{id}.jsonl")), "{}").unwrap();
        assert_eq!(
            find_record(root.path(), "codex", &id).unwrap(),
            Some(path.canonicalize().unwrap())
        );
        assert!(
            find_record(root.path(), "codex", &uuid::Uuid::new_v4().to_string())
                .unwrap()
                .is_none()
        );
        std::fs::write(folder.join(format!("rollout-duplicate-{id}.jsonl")), "{}").unwrap();
        assert!(find_record(root.path(), "codex", &id).is_err());
        assert!(find_record(root.path(), "codex", "../escape").is_err());
    }
    #[test]
    fn saved_conversation_pins_provider_connection_and_folder() {
        let mut workspace = json!({"conversations":[{"id":"chat","settings":{"provider":"claude","connectionId":"account"},"location":{"computerId":"host","environmentId":"env","path":"/project"}}]});
        let saved = crate::saved::conversations(workspace.to_string().as_bytes()).unwrap();
        assert_eq!(
            conversation_location(&saved, "chat", "claude", Some("account"))
                .unwrap()
                .unwrap()
                .path,
            "/project"
        );
        assert!(conversation_location(&saved, "chat", "codex", Some("account")).is_err());
        assert!(conversation_location(&saved, "chat", "claude", Some("other")).is_err());
        assert!(
            conversation_location(&saved, "other-workspace-chat", "claude", Some("account"))
                .is_err()
        );
        workspace["conversations"][0]["location"]["path"] = json!("");
        let standalone = crate::saved::conversations(workspace.to_string().as_bytes()).unwrap();
        assert!(
            conversation_location(&standalone, "chat", "claude", Some("account"))
                .unwrap()
                .is_none()
        );
    }
}
