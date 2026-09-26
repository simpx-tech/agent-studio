//! Typed reads of the saved workspace file. Commands read the file again on every call, so it
//! stays the source of truth, but most need only the account registry or a few fields of each
//! conversation. Deserializing into these types lets serde skip everything else, chiefly
//! conversation history, without building a `Value` tree of the whole file.
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use std::path::Path;

/// The whole saved workspace file. It has no size limit: a reader that stopped short would
/// silently drop the conversations past its bound and report the file as unreadable.
pub fn bytes(root: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(root.join("workspace.json"))
}

/// The computer and account registry (`fleet`) as saved in `root`'s workspace file.
pub fn fleet(root: &Path, missing: &str, unreadable: &str) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct Saved {
        #[serde(default)]
        fleet: Value,
    }
    let bytes = bytes(root).map_err(|_| missing)?;
    parse::<Saved>(&bytes)
        .map(|saved| saved.fleet)
        .ok_or_else(|| unreadable.into())
}

/// The fields of a saved conversation that commands check requests against. Messages keep
/// only their role, status and run; their content is skipped.
#[derive(Deserialize)]
pub struct Conversation {
    #[serde(default)]
    pub id: Value,
    #[serde(default, rename = "historyRevision")]
    pub history_revision: Value,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub location: Value,
    pub messages: Option<Vec<Message>>,
}
#[derive(Deserialize)]
pub struct Message {
    #[serde(default)]
    pub role: Value,
    #[serde(default)]
    pub status: Value,
    #[serde(default, rename = "runId")]
    pub run_id: Value,
}
/// The conversations of a workspace file's contents, or `None` if it is unreadable.
pub fn conversations(bytes: &[u8]) -> Option<Vec<Conversation>> {
    #[derive(Deserialize)]
    struct Saved {
        conversations: Option<Vec<Conversation>>,
    }
    parse::<Saved>(bytes).map(|saved| saved.conversations.unwrap_or_default())
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Option<T> {
    // Skipped strings are not decoded, but a file with invalid text anywhere stays unreadable.
    std::str::from_utf8(bytes).ok()?;
    serde_json::from_slice(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved(workspace: &Value) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("workspace.json"),
            serde_json::to_vec(workspace).unwrap(),
        )
        .unwrap();
        root
    }
    // Written by the app, keys are sorted, so conversations come before the registry.
    fn workspace() -> Value {
        json!({
            "conversations": [
                {"id": "chat", "historyRevision": 3, "settings": {"provider": "claude", "connectionId": "one"},
                 "location": {"computerId": "host", "environmentId": "env", "path": "/project"},
                 "messages": [
                    {"id": "m1", "role": "user", "status": "complete",
                     "blocks": [{"type": "markdown", "text": "{\"fleet\":{\"connections\":[]}} \\\" \u{1F600}"}]},
                    {"id": "m2", "role": "assistant", "status": "running", "runId": "run",
                     "fileChanges": {"edits": [{"id": "e", "files": [{"path": "a", "kind": "added",
                        "hunks": [{"oldStart": 0, "oldLines": 0, "newStart": 1, "newLines": 1, "lines": ["+\"fleet\": 1e300"]}]}]}],
                        "limited": false, "revision": 1},
                     "settings": {"fleet": {"connections": [{"id": "nested"}]}}}
                 ]},
                {"id": "standalone", "settings": {}, "title": "No messages"}
            ],
            "fleet": {
                "accounts": [{"id": "a", "provider": "codex"}],
                "computers": [{"id": "host", "name": "Host"}],
                "connections": [{"id": "one", "accountId": "a", "environmentId": "env", "profile": "isolated"}],
                "environments": [{"id": "env", "computerId": "host", "platform": "windows"}]
            },
            "preferences": {},
            "version": 3
        })
    }

    #[test]
    fn reads_the_registry_a_whole_parse_would_find_without_history() {
        let workspace = workspace();
        let root = saved(&workspace);
        let whole: Value =
            serde_json::from_slice(&std::fs::read(root.path().join("workspace.json")).unwrap())
                .unwrap();
        let fleet = super::fleet(root.path(), "missing", "unreadable").unwrap();
        assert_eq!(fleet, whole["fleet"]);
        assert_eq!(fleet["connections"][0]["id"], "one");
        let bare = saved(&json!({"version": 3, "conversations": []}));
        assert_eq!(
            super::fleet(bare.path(), "missing", "unreadable"),
            Ok(Value::Null)
        );
    }

    #[test]
    fn unreadable_files_stay_unreadable() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            super::fleet(empty.path(), "missing", "unreadable"),
            Err("missing".into())
        );
        let text = serde_json::to_string(&workspace()).unwrap();
        // Files a whole-file parse rejected, most damaged only in history the typed reads skip.
        let mut undecodable = text.clone().into_bytes();
        undecodable[text.find("No messages").unwrap()] = 0xff;
        for broken in [
            text.as_bytes()[..text.len() - 1].to_vec(),
            text.replace("\"id\":\"m1\"", "\"id\":m1").into_bytes(),
            text.replace("No messages", "No \\x messages").into_bytes(),
            text.replace("No messages", "No\u{1}messages").into_bytes(),
            undecodable,
            format!("{text} {{}}").into_bytes(),
            b"[".to_vec(),
        ] {
            assert!(serde_json::from_slice::<Value>(&broken).is_err());
            std::fs::write(empty.path().join("workspace.json"), &broken).unwrap();
            assert_eq!(
                super::fleet(empty.path(), "missing", "unreadable"),
                Err("unreadable".into())
            );
            assert!(conversations(&broken).is_none());
        }
    }

    #[test]
    fn conversations_keep_request_checks_and_skip_content() {
        let workspace = workspace();
        let list = conversations(&serde_json::to_vec(&workspace).unwrap()).unwrap();
        assert_eq!(list.len(), 2);
        let (chat, standalone) = (&list[0], &list[1]);
        let whole = &workspace["conversations"];
        for (typed, whole) in list.iter().zip(whole.as_array().unwrap()) {
            assert_eq!(typed.id, whole["id"]);
            assert_eq!(typed.history_revision, whole["historyRevision"]);
            assert_eq!(typed.settings, whole["settings"]);
            assert_eq!(typed.location, whole["location"]);
        }
        assert_eq!(chat.history_revision.as_u64(), Some(3));
        let messages = chat.messages.as_ref().unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages[0].role == "user" && messages[0].run_id.is_null());
        assert!(messages[1].status == "running" && messages[1].run_id == "run");
        assert!(standalone.messages.is_none() && standalone.location.is_null());
        assert!(conversations(br#"{"version":3}"#).unwrap().is_empty());
        assert!(conversations(br#"{"conversations":null}"#)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reads_a_workspace_past_the_former_twenty_megabyte_limit() {
        let root = tempfile::tempdir().unwrap();
        let padding = "x".repeat(25_000_000);
        let saved = format!(
            r#"{{"fleet":{{"computers":[{{"id":"a"}}]}},"conversations":[{{"id":"c","messages":[{{"role":"user","text":"{padding}"}}]}}]}}"#
        );
        std::fs::write(root.path().join("workspace.json"), &saved).unwrap();
        let read = bytes(root.path()).unwrap();
        assert_eq!(read.len(), saved.len());
        assert!(read.len() > 20_000_000);
        // Both the registry and the conversations survive a file past the old limit.
        assert_eq!(
            fleet(root.path(), "missing", "unreadable").unwrap()["computers"][0]["id"],
            "a"
        );
        let chats = conversations(&read).unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].messages.as_ref().unwrap().len(), 1);
    }
}
