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
    // Version 2 also records the account and location parts of the scope separately, so a
    // deliberate account switch (same computer and folder, another profile) can be told
    // apart from a chat that was moved. Version 1 bindings carry only the combined scope.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    account: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    location: String,
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
    /// The selected account differs from the bound one: this reply starts a fresh native
    /// session for it from the saved messages instead of resuming the old transcript.
    pub switched_account: bool,
    pub instructions_changed: bool,
    pub unconfirmed_message: Option<usize>,
}

struct Identity {
    scope: String,
    account: String,
    location: String,
}

fn fingerprint(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode session identity")?;
    Ok(uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, &bytes).to_string())
}

fn inherited_profile(provider: &str) -> Option<String> {
    std::env::var_os(if provider == "codex" {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    })
    .map(|p| p.to_string_lossy().into_owned())
}

/// The combined scope. Its encoding must stay stable: version 1 bindings compare against it.
pub(crate) fn scope(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<String, String> {
    let profile = crate::profiles::current();
    fingerprint(&serde_json::json!({
        "provider": provider, "connection": profile.id,
        "profile": profile.root, "isolated": profile.isolated,
        "distribution": profile.distribution, "folderDistribution": profile.folder_distribution,
        "namespace": profile.namespace, "location": location,
        "inheritedProfile": inherited_profile(provider),
    }))
}

/// The part of the scope that must not change for a conversation: provider, execution
/// environment, app installation namespace, and folder. Accounts are excluded on purpose.
pub(crate) fn location_scope(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<String, String> {
    let profile = crate::profiles::current();
    fingerprint(&serde_json::json!({
        "provider": provider, "distribution": profile.distribution,
        "folderDistribution": profile.folder_distribution,
        "namespace": profile.namespace, "location": location,
    }))
}

fn identity(
    provider: &str,
    location: Option<&crate::folders::ChatLocation>,
) -> Result<Identity, String> {
    let profile = crate::profiles::current();
    Ok(Identity {
        scope: scope(provider, location)?,
        account: fingerprint(&serde_json::json!({
            "connection": profile.id, "profile": profile.root, "isolated": profile.isolated,
            "inheritedProfile": inherited_profile(provider),
        }))?,
        location: location_scope(provider, location)?,
    })
}

fn valid(record: &Record) -> bool {
    matches!(record.version, 1 | 2)
        && uuid::Uuid::parse_str(&record.id).is_ok()
        && !record.history.is_empty()
        && (record.version == 1 || (!record.account.is_empty() && !record.location.is_empty()))
}

/// A version 2 binding for the same computer and folder under another account.
fn other_account(record: &Record, identity: &Identity) -> bool {
    record.version >= 2
        && record.scope != identity.scope
        && record.location == identity.location
        && record.account != identity.account
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
    let identity = identity(provider, location)?;
    if !valid(&record) {
        return Err("The native session binding is unreadable".into());
    }
    if other_account(&record, &identity) {
        return Err("This conversation's native session belongs to its previously selected account. Send a message to start a session for the selected account.".into());
    }
    if record.scope != identity.scope {
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
        let identity = identity(&request.agent.provider, request.location.as_ref())?;
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
        let mut switched_account = false;
        if let Some(previous) = &previous {
            if !valid(previous) {
                return Err("Native session binding is invalid. It was preserved; start a new conversation.".into());
            }
            if previous.scope != identity.scope {
                // A version 2 binding proves only the account changed. Version 1 bindings
                // cannot tell an account switch from a moved chat, so they require the
                // renderer's explicit account-switch request instead of guessing.
                if !(other_account(previous, &identity)
                    || (previous.version == 1 && request.account_switch))
                {
                    return Err("This conversation's native session belongs to a different account, computer, or folder. Start a new conversation there.".into());
                }
                switched_account = true;
            } else {
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
                                && !m.text.starts_with("\n\nUser steering accepted during this reply (earlier context):\n")
                        })
                {
                    return Err("This conversation has messages the native session has not received. Start a new conversation to include the saved history.".into());
                }
            }
        }
        if request.compact && (previous.is_none() || switched_account) {
            return Err("Send a message with this account first to establish its native session before compacting.".into());
        }
        // Retrying the same request under another account still continues the earlier
        // attempt's work instead of treating it as a new independent task.
        let retry = previous.as_ref().is_some_and(|p| p.history == history);
        // The old account's transcript is not resumed; a fresh session receives the saved
        // messages as earlier context, like an older chat's first native reply.
        let previous = previous.filter(|_| !switched_account);
        Ok(Some(Self {
            path,
            _lock: Arc::new(lock),
            resumed: previous.is_some(),
            retry,
            switched_account,
            instructions_changed: previous
                .as_ref()
                .is_some_and(|p| !p.received || p.instructions != instructions),
            unconfirmed_message: previous
                .as_ref()
                .filter(|p| !p.received)
                .map(|p| p.history.len() - 1),
            record: Record {
                version: 2,
                scope: identity.scope,
                account: identity.account,
                location: identity.location,
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
    fn profile(provider: &str) -> crate::profiles::Profile {
        crate::profiles::Profile {
            id: uuid::Uuid::new_v4().to_string(),
            provider: provider.into(),
            namespace: "sessions-test".into(),
            ..Default::default()
        }
    }
    fn saved(session: &Session) -> Record {
        serde_json::from_slice(&std::fs::read(&session.path).unwrap()).unwrap()
    }
    #[test]
    fn manual_compaction_requires_an_existing_binding_and_cannot_switch_accounts() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.compact = true;
        r.messages[0].text = "/compact".into();
        assert!(Session::prepare(root.path(), &r).is_err());
        r.compact = false;
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        session.bind(session.id(), true).unwrap();
        let before = std::fs::read(&session.path).unwrap();
        let path = session.path.clone();
        drop(session);
        r.compact = true;
        assert!(Session::prepare(root.path(), &r).unwrap().unwrap().resumed);
        let mut previous: Record = serde_json::from_slice(&before).unwrap();
        previous.account = "another-account".into();
        previous.scope = "another-scope".into();
        std::fs::write(&path, serde_json::to_vec(&previous).unwrap()).unwrap();
        let foreign = std::fs::read(&path).unwrap();
        r.account_switch = true;
        assert!(Session::prepare(root.path(), &r).is_err());
        assert_eq!(std::fs::read(path).unwrap(), foreign);
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
        let error = crate::profiles::scope(other, async {
            bound_id(
                root.path(),
                r.conversation_id.as_deref().unwrap(),
                "claude",
                None,
            )
        })
        .await
        .unwrap_err();
        assert!(error.contains("previously selected account"), "{error}");
        assert_eq!(std::fs::read(&session.path).unwrap(), before);
    }
    #[test]
    fn disk_resume_reuses_id_without_storing_conversation_content() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let session = Session::prepare(root.path(), &r).unwrap().unwrap();
        assert!(!session.resumed);
        assert!(!session.switched_account);
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
        r.account_switch = true;
        assert!(
            Session::prepare(root.path(), &r).is_err(),
            "The agent itself never changes within a conversation"
        );
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
        r.account_switch = true;
        assert!(Session::prepare(root.path(), &r).is_err());
        r.conversation_id = None;
        assert!(Session::prepare(root.path(), &r).unwrap().is_none());
    }
    #[tokio::test]
    async fn environment_and_folder_changes_cannot_resume_or_switch_each_other() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.account_switch = true;
        let profile = profile("claude");
        crate::profiles::scope(profile.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
        })
        .await;
        let mut other = profile.clone();
        other.distribution = Some("Different Ubuntu".into());
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut other = profile.clone();
        other.namespace = "another-installation".into();
        assert!(
            crate::profiles::scope(other, async { Session::prepare(root.path(), &r).is_err() })
                .await
        );
        let mut moved = r.clone();
        moved.location = Some(serde_json::from_value(json!({"computerId":uuid::Uuid::new_v4(),"environmentId":uuid::Uuid::new_v4(),"path":"C:/other"})).unwrap());
        assert!(
            crate::profiles::scope(profile.clone(), async {
                Session::prepare(root.path(), &moved).is_err()
            })
            .await
        );
        let mut elsewhere = profile.clone();
        elsewhere.id = uuid::Uuid::new_v4().to_string();
        assert!(
            crate::profiles::scope(elsewhere, async {
                Session::prepare(root.path(), &moved).is_err()
            })
            .await,
            "Another account at another folder is a moved chat, not an account switch"
        );
    }
    #[tokio::test]
    async fn account_switches_start_a_fresh_session_from_saved_history_at_the_same_location() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("claude");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        let first_id = crate::profiles::scope(first.clone(), async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), true).unwrap();
            s.id().to_string()
        })
        .await;
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        // A version 2 binding recognizes the same location under another account by itself.
        assert!(!r.account_switch);
        let switched = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account);
        assert!(!switched.resumed && !switched.retry && !switched.instructions_changed);
        assert_eq!(switched.unconfirmed_message, None);
        let second_id = switched.id().to_string();
        assert_ne!(second_id, first_id);
        r.native_session = Some(switched);
        let context = r.native_context().unwrap();
        assert!(context.contains("Private request") && context.contains("Done"));
        assert!(context.contains("earlier context only"));
        assert_eq!(r.native_user_text(), "Continue");
        assert!(r.native_image_message(0));
        assert_eq!(r.stdin_payload().lines().count(), 2);
        let switched = r.native_session.take().unwrap();
        switched.bind(&second_id, true).unwrap();
        let record = saved(&switched);
        assert_eq!(record.version, 2);
        assert!(!record.account.is_empty() && !record.location.is_empty());
        drop(switched);
        // The old account's binding is gone: inspection under it reports the switch.
        let conversation = r.conversation_id.clone().unwrap();
        let error = crate::profiles::scope(first.clone(), async {
            bound_id(root.path(), &conversation, "claude", None).unwrap_err()
        })
        .await;
        assert!(error.contains("previously selected account"), "{error}");
        assert_eq!(
            crate::profiles::scope(second.clone(), async {
                bound_id(root.path(), &conversation, "claude", None).unwrap()
            })
            .await
            .as_deref(),
            Some(second_id.as_str())
        );
        // Later replies resume the new account's own session.
        r.messages
            .extend([message("assistant", "Again"), message("user", "More")]);
        let resumed = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(resumed.resumed && !resumed.switched_account);
        assert_eq!(resumed.id(), second_id);
        drop(resumed);
        // Switching back never resumes the first account's stale transcript.
        let back = crate::profiles::scope(first, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(back.switched_account && !back.resumed);
        assert_ne!(back.id(), first_id);
        assert_ne!(back.id(), second_id);
    }
    #[tokio::test]
    async fn retrying_under_another_account_continues_the_interrupted_attempt() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("codex");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        crate::profiles::scope(first, async {
            let s = Session::prepare(root.path(), &r).unwrap().unwrap();
            s.bind(s.id(), false).unwrap();
        })
        .await;
        r.native_session =
            crate::profiles::scope(second, async { Session::prepare(root.path(), &r).unwrap() })
                .await;
        let session = r.native_session.as_ref().unwrap();
        assert!(session.switched_account && session.retry && !session.resumed);
        assert!(r
            .native_user_text()
            .contains("do not blindly repeat completed side effects"));
        assert!(
            r.native_context().unwrap().contains("earlier context only"),
            "A fresh session still receives the (empty) saved history framing"
        );
    }
    #[tokio::test]
    async fn legacy_bindings_switch_accounts_only_on_an_explicit_request() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let first = profile("claude");
        let mut second = first.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        let legacy_scope =
            crate::profiles::scope(first.clone(), async { scope("claude", None).unwrap() }).await;
        let directory = root.path().join("native-sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{}.json", r.conversation_id.as_ref().unwrap()));
        let legacy_id = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            &path,
            json!({"version":1,"scope":legacy_scope,"id":legacy_id,"history":[fingerprint(&r.messages[0]).unwrap()],"instructions":fingerprint(&r.agent.instructions).unwrap(),"received":true}).to_string(),
        )
        .unwrap();
        let conversation = r.conversation_id.clone().unwrap();
        // The legacy binding still resumes under its own account and cannot name the other one.
        let resumed = crate::profiles::scope(first.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(resumed.resumed && !resumed.switched_account);
        assert_eq!(resumed.id(), legacy_id);
        drop(resumed);
        let error = crate::profiles::scope(second.clone(), async {
            bound_id(root.path(), &conversation, "claude", None).unwrap_err()
        })
        .await;
        assert!(error.contains("does not match"), "{error}");
        assert!(
            crate::profiles::scope(second.clone(), async {
                Session::prepare(root.path(), &r).is_err()
            })
            .await,
            "A mismatch without an explicit switch still fails closed"
        );
        r.account_switch = true;
        let switched = crate::profiles::scope(second.clone(), async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(switched.switched_account && !switched.resumed);
        assert_ne!(switched.id(), legacy_id);
        switched.bind(switched.id(), true).unwrap();
        assert_eq!(saved(&switched).version, 2);
        let switched_id = switched.id().to_string();
        drop(switched);
        // Once upgraded, the explicit request is no longer needed to detect the account.
        r.account_switch = false;
        r.messages
            .extend([message("assistant", "Done"), message("user", "Continue")]);
        let back = crate::profiles::scope(first, async {
            Session::prepare(root.path(), &r).unwrap().unwrap()
        })
        .await;
        assert!(back.switched_account);
        assert_ne!(back.id(), switched_id);
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
