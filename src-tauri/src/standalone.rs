//! Host-local working-folder bindings. Folder contents never enter workspace sync.
use crate::{folders::ChatLocation, providers::RunRequest};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Directory {
    Legacy,
    Dedicated,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    scope: String,
    directory: Directory,
}

pub fn lookup(
    root: &Path,
    conversation: &str,
    provider: &str,
    location: Option<&ChatLocation>,
) -> Result<Option<Directory>, String> {
    let id = uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    let file = match File::open(root.join("standalone-bindings").join(format!("{id}.json"))) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read this chat's working-folder binding".into()),
    };
    let mut bytes = Vec::new();
    file.take(1025)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read this chat's working-folder binding")?;
    if bytes.len() > 1024 {
        return Err("This chat's working-folder binding is invalid".into());
    }
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| "This chat's working-folder binding is invalid; it was preserved")?;
    if record.version != 1 || record.scope != crate::providers::sessions::scope(provider, location)?
    {
        return Err(
            "This chat's working folder belongs to a different account, computer, or folder".into(),
        );
    }
    Ok(Some(record.directory))
}

pub fn prepare(root: &Path, request: &RunRequest) -> Result<Option<uuid::Uuid>, String> {
    if request.conversation_only || request.location.is_some() {
        return Ok(None);
    }
    let Some(conversation) = &request.conversation_id else {
        return Ok(None);
    };
    let id = uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    let bindings = root.join("standalone-bindings");
    std::fs::create_dir_all(&bindings)
        .map_err(|_| "Cannot prepare this chat's working-folder binding")?;
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(bindings.join(format!("{id}.lock")))
        .map_err(|_| "Cannot open working-folder lock")?;
    lock.try_lock().map_err(|_| {
        "This chat's working folder is being prepared in another window. Try again."
    })?;
    let directory = match lookup(root, conversation, &request.agent.provider, None)? {
        Some(directory) => directory,
        None => {
            // Old native sessions must resume in their original cwd (particularly Claude).
            // Imported/saved history without a binding also retains the legacy folder.
            let legacy = request.messages.len() > 1
                || request.native_session.as_ref().is_some_and(|s| s.resumed)
                || root
                    .join("native-sessions")
                    .join(format!("{id}.json"))
                    .exists();
            let directory = if legacy {
                Directory::Legacy
            } else {
                Directory::Dedicated
            };
            let record = Record {
                version: 1,
                scope: crate::providers::sessions::scope(&request.agent.provider, None)?,
                directory,
            };
            let mut file = tempfile::NamedTempFile::new_in(&bindings)
                .map_err(|_| "Cannot prepare working-folder binding")?;
            file.write_all(
                &serde_json::to_vec(&record).map_err(|_| "Cannot encode working-folder binding")?,
            )
            .map_err(|_| "Cannot save working-folder binding")?;
            file.as_file()
                .sync_all()
                .map_err(|_| "Cannot flush working-folder binding")?;
            file.persist(bindings.join(format!("{id}.json")))
                .map_err(|_| "Cannot save working-folder binding")?;
            directory
        }
    };
    Ok((directory == Directory::Dedicated).then_some(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> RunRequest {
        serde_json::from_value(serde_json::json!({"conversationId":uuid::Uuid::new_v4(),"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","instructions":""},"messages":[{"role":"user","text":"hello"}]})).unwrap()
    }
    #[test]
    fn legacy_history_and_native_sessions_keep_their_folder() {
        let root = tempfile::tempdir().unwrap();
        let mut old = request();
        old.messages.push(old.messages[0].clone());
        assert_eq!(prepare(root.path(), &old).unwrap(), None);
        old.messages.truncate(1); // Retrying never reclassifies a bound chat.
        assert_eq!(prepare(root.path(), &old).unwrap(), None);
        let native = request();
        let folder = root.path().join("native-sessions");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(
            folder.join(format!("{}.json", native.conversation_id.as_ref().unwrap())),
            "existing",
        )
        .unwrap();
        assert_eq!(prepare(root.path(), &native).unwrap(), None);
        assert!(prepare(root.path(), &request()).unwrap().is_some());
    }
    #[test]
    fn corrupt_and_wrong_account_bindings_do_not_fall_back() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        assert!(prepare(root.path(), &r).unwrap().is_some());
        r.agent.provider = "claude".into();
        assert!(prepare(root.path(), &r)
            .unwrap_err()
            .contains("different account"));
        r.agent.provider = "codex".into();
        let path = root
            .path()
            .join("standalone-bindings")
            .join(format!("{}.json", r.conversation_id.as_ref().unwrap()));
        std::fs::write(&path, "broken").unwrap();
        assert!(prepare(root.path(), &r).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        r.conversation_id = Some("../../other".into());
        assert!(prepare(root.path(), &r).is_err());
    }
    #[test]
    fn background_and_anonymous_runs_do_not_create_chat_folders() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.conversation_only = true;
        assert_eq!(prepare(root.path(), &r).unwrap(), None);
        r.conversation_only = false;
        r.conversation_id = None;
        assert_eq!(prepare(root.path(), &r).unwrap(), None);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
