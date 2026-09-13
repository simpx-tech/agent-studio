//! Host-local bindings to CLI-owned transcripts. Never accept a transcript ID or
//! path from a renderer/relay, and never put native transcripts in workspace sync.
use super::RunRequest;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    scope: String,
    id: String,
    history: Vec<String>,
    instructions: String,
    received: bool,
}

#[derive(Clone)]
pub struct Session {
    path: PathBuf,
    // An OS lock is released even if the app crashes. Clones retain ownership.
    _lock: Arc<File>,
    record: Record,
    pub resumed: bool,
    pub retry: bool,
    pub instructions_changed: bool,
    pub unconfirmed_message: Option<usize>,
}

fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode session identity")?;
    Ok(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &bytes).to_string())
}

fn scope(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<String, String> {
    let profile = crate::profiles::current();
    fingerprint(&serde_json::json!({
        "provider": provider, "connection": profile.id,
        "profile": profile.root, "isolated": profile.isolated,
        "distribution": profile.distribution, "folderDistribution": profile.folder_distribution,
        "namespace": profile.namespace, "location": location,
        "inheritedProfile": std::env::var_os(if provider == "codex" { "CODEX_HOME" } else { "CLAUDE_CONFIG_DIR" }).map(|p| p.to_string_lossy().into_owned()),
    }))
}

/// Read an existing binding without creating a session, taking its run lock, or changing history.
pub fn bound_id(
    root: &Path,
    conversation: &str,
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<Option<String>, String> {
    use std::io::Read;
    let conversation =
        uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    let file = match File::open(
        root.join("native-sessions")
            .join(format!("{conversation}.json")),
    ) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read the native session binding".into()),
    };
    let mut bytes = Vec::new();
    file.take(32_001)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the native session binding")?;
    if bytes.len() > 32_000 {
        return Err("The native session binding exceeds its size limit".into());
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|_| "The native session binding is unreadable")?;
    if record.version != 1
        || record.history.is_empty()
        || uuid::Uuid::parse_str(&record.id).is_err()
        || record.scope != scope(provider, location)?
    {
        return Err(
            "The native session does not match this conversation's account, computer, and folder"
                .into(),
        );
    }
    Ok(Some(record.id))
}

impl Session {
    pub fn prepare(root: &Path, request: &RunRequest) -> Result<Option<Self>, String> {
        let Some(conversation) = &request.conversation_id else {
            return Ok(None);
        };
        if !request.tools_enabled()
            || !matches!(request.agent.provider.as_str(), "claude" | "codex")
        {
            return Ok(None);
        }
        let conversation =
            uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
        let scope = scope(&request.agent.provider, request.location.as_ref())?;
        let history = request
            .messages
            .iter()
            .map(fingerprint)
            .collect::<Result<Vec<_>, _>>()?;
        let instructions = fingerprint(&request.agent.instructions)?;
        let directory = root.join("native-sessions");
        std::fs::create_dir_all(&directory)
            .map_err(|_| "Cannot create native session directory")?;
        let path = directory.join(format!("{conversation}.json"));
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!("{conversation}.lock")))
            .map_err(|_| "Cannot open native session lock")?;
        lock.try_lock().map_err(|_| {
            "This conversation is already running in another app window. Wait for it to finish."
        })?;
        let previous: Option<Record> = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 32_000 => Some(serde_json::from_slice(&bytes).map_err(|_| "Native session binding is unreadable. It was preserved; start a new conversation.")?),
            Ok(_) => return Err("Native session binding exceeds its limit. Start a new conversation.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Cannot read native session binding".into()),
        };
        if let Some(previous) = &previous {
            if previous.version != 1
                || uuid::Uuid::parse_str(&previous.id).is_err()
                || previous.history.is_empty()
            {
                return Err("Native session binding is invalid. It was preserved; start a new conversation.".into());
            }
            if previous.scope != scope {
                return Err("This conversation's native session belongs to a different account, computer, or folder. Start a new conversation there.".into());
            }
            if !history.starts_with(&previous.history) {
                return Err("This conversation's history differs from its native session. Start a new conversation to keep the histories separate.".into());
            }
            // Ordinary follow-ups add the previous final answer (or answered
            // question context after interruption), followed by one human input.
            if history.len() > previous.history.len()
                && request.messages[previous.history.len()..request.messages.len() - 1]
                    .iter()
                    .any(|m| {
                        m.role != "assistant"
                            && !m
                                .text
                                .starts_with("\n\nUser question responses (earlier context):\n")
                    })
            {
                return Err("This conversation has messages the native session has not received. Start a new conversation to include the saved history.".into());
            }
        }
        Ok(Some(Self {
            path,
            _lock: Arc::new(lock),
            resumed: previous.is_some(),
            retry: previous.as_ref().is_some_and(|p| p.history == history),
            instructions_changed: previous
                .as_ref()
                .is_some_and(|p| !p.received || p.instructions != instructions),
            unconfirmed_message: previous
                .as_ref()
                .filter(|p| !p.received)
                .map(|p| p.history.len() - 1),
            record: Record {
                version: 1,
                scope,
                id: previous
                    .map(|p| p.id)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                history,
                instructions,
                received: false,
            },
        }))
    }

    pub fn id(&self) -> &str {
        &self.record.id
    }

    // Persist immediately when the provider confirms its parent identity, before
    // forwarding further output, so stopped/failed replies can resume as well.
    pub fn bind(&self, id: &str, received: bool) -> Result<(), String> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| "The provider returned an invalid native session identity")?;
        if self.resumed && id != self.id() {
            return Err(
                "The provider did not resume the requested native session. The reply was stopped."
                    .into(),
            );
        }
        let mut record = self.record.clone();
        record.id = id.into();
        record.received = received;
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|_| "Cannot prepare native session binding")?;
        file.write_all(
            &serde_json::to_vec(&record).map_err(|_| "Cannot encode native session binding")?,
        )
        .map_err(|_| "Cannot save native session binding")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot flush native session binding")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot replace native session binding")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> RunRequest {
        serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"","instructions":"Private guidance"},"messages":[{"role":"user","text":"Private request"}]})).unwrap()
    }
    fn message(role: &str, text: &str) -> super::super::ChatMessage {
        serde_json::from_value(json!({"role":role,"text":text})).unwrap()
    }
    #[tokio::test]
    async fn inspection_is_read_only_and_checks_the_same_profile_scope_as_execution() {
        let root = tempfile::tempdir().unwrap();
        let r = request();
        assert_eq!(
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None
            )
            .unwrap(),
            None
        );
        assert!(!root.path().join("native-sessions").exists());
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        let before = std::fs::read(&session.path).unwrap();
        assert_eq!(
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None
            )
            .unwrap()
            .as_deref(),
            Some(session.id())
        );
        assert!(bound_id(
            root.path(),
            r.conversation_id.as_deref().unwrap(),
            "codex",
            None
        )
        .is_err());
        let other = crate::profiles::Profile {
            id: "other-profile".into(),
            ..Default::default()
        };
        assert!(crate::profiles::scope(other, async {
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None,
            )
        })
        .await
        .is_err());
        assert_eq!(std::fs::read(&session.path).unwrap(), before);
    }
    #[test]
    fn disk_resume_reuses_id_without_storing_conversation_content() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!session.resumed);
        let id = session.id().to_string();
        session.bind(&id, true).unwrap();
        let saved = std::fs::read_to_string(&session.path).unwrap();
        assert!(!saved.contains("Private"));
        assert!(
            Session::prepare(root.path(), &r).is_err(),
            "Concurrent writers must be excluded"
        );
        drop(session);
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let resumed = r.native_session.as_ref().unwrap();
        assert!(resumed.resumed);
        assert_eq!(resumed.id(), id);
        assert!(!resumed.retry);
        assert_eq!(r.native_context(), None);
        assert_eq!(r.native_user_text(), "Continue");
        assert!(resumed
            .bind(&uuid::Uuid::new_v4().to_string(), true)
            .is_err());
    }
    #[test]
    fn retries_preserve_partial_work_and_unconfirmed_input_is_explicit() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), false).unwrap();
        drop(session);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(r.native_session.as_ref().unwrap().retry);
        assert!(r
            .native_user_text()
            .contains("do not blindly repeat completed side effects"));
        assert!(r.native_image_message(0));
        r.native_session = None;
        r.messages.push(message("user", "Where did you stop?"));
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert!(r
            .native_context()
            .unwrap()
            .contains("before acknowledgment"));
        assert!(r.native_image_message(0));
    }
    #[test]
    fn rejects_changed_history_and_unseen_user_messages() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        drop(session);
        let original = r.messages[0].text.clone();
        r.messages[0].text = "Edited history".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.messages[0].text = original;
        r.messages.extend([
            message("user", "Unseen remote turn"),
            message("user", "Next"),
        ]);
        assert!(Session::prepare(root.path(), &r).is_err());
    }
    #[test]
    fn isolated_conversations_and_changed_provider_do_not_share_sessions() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        let id = session.id().to_string();
        session.bind(&id, true).unwrap();
        drop(session);
        r.agent.provider = "codex".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        let other = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!other.resumed);
        assert_ne!(other.id(), id);
    }
    #[test]
    fn malformed_bindings_fail_closed_and_legacy_callers_stay_ephemeral() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        std::fs::write(&session.path, "{}").unwrap();
        drop(session);
        assert!(Session::prepare(root.path(), &r).is_err());
        r.conversation_id = None;
        assert!(Session::prepare(root.path(), &r).unwrap().is_none());
    }
    #[tokio::test]
    async fn account_environment_and_folder_changes_cannot_resume_each_other() {
        let root = tempfile::tempdir().unwrap();
        let r = request();
        let profile = crate::profiles::Profile {
            id: uuid::Uuid::new_v4().to_string(),
            provider: "claude".into(),
            namespace: "sessions-test".into(),
            ..Default::default()
        };
        crate::profiles::scope(profile.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        let mut other = profile.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut other = profile.clone();
        other.distribution = Some("Different Ubuntu".into());
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut moved = r.clone();
        moved.location = Some(serde_json::from_value(json!({"computerId":uuid::Uuid::new_v4(),"environmentId":uuid::Uuid::new_v4(),"path":"C:/other"})).unwrap());
        assert!(
            crate::profiles::scope(profile, async {
                Session::prepare(root.path(), &moved).is_err()
            })
            .await
        );
    }
    #[test]
    fn claude_bootstraps_once_and_changes_instructions_without_replaying_history() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let first: Vec<serde_json::Value> = r
            .stdin_payload()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["shouldQuery"], false);
        assert!(first[0].get("origin").is_none());
        assert_eq!(first[1]["origin"]["kind"], "human");
        let s = r.native_session.take().unwrap();
        s.bind(s.id(), true).unwrap();
        drop(s);
        r.messages
            .extend([message("assistant", "Answer"), message("user", "Next")]);
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        assert_eq!(r.stdin_payload().lines().count(), 1);
        assert!(!r.stdin_payload().contains("Private request"));
        r.native_session = None;
        r.agent.instructions = "New instructions".into();
        r.native_session = Session::prepare(root.path(), &r).unwrap();
        let payload = r.stdin_payload();
        assert_eq!(payload.lines().count(), 2);
        assert!(payload.contains("New instructions"));
        assert!(!payload.contains("Private request"));
    }
}
