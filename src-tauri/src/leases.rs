//! What a chat's work holds while the chat stays open (requested 2026-11-26: "Agent Studio knows
//! when a chat is closed"). Each chat's CLI on Windows starts with a folder of its own in its
//! environment, `AGENT_STUDIO_LEASE` (`reservations::chat_env`), where a project's scripts write
//! what the chat holds: bluevox's `Tools/Claim-Worktree.ps1` writes there its claim on a built
//! worktree of its pool, which no other chat then takes. Agent Studio removes the folder when the
//! chat is closed, moved to History or deleted (`release_conversation` with `closed`), and as it
//! starts for every chat that is no longer open (`prune`), so what a chat held, and never gave
//! back itself, is free for the others.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The variable that names a chat's lease folder to its commands.
pub const ENV: &str = "AGENT_STUDIO_LEASE";
/// The folder in app data that holds every chat's.
const FOLDER: &str = "leases";

/// `conversation`'s lease folder in app data `data`. Nothing makes it but a script that holds
/// something.
pub fn folder(data: &Path, conversation: &str) -> PathBuf {
    data.join(FOLDER).join(conversation)
}

/// Lets go of what `conversation` held: removes its lease folder. Returns whether it had one.
pub fn close(data: &Path, conversation: &str) -> bool {
    if conversation.is_empty() || conversation.contains(['/', '\\', '.']) {
        return false;
    }
    std::fs::remove_dir_all(folder(data, conversation)).is_ok()
}

/// Lets go of what every chat but the `open` ones held. Returns how many folders went.
pub fn prune(data: &Path, open: &HashSet<String>) -> usize {
    let Ok(entries) = std::fs::read_dir(data.join(FOLDER)) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !open.contains(entry.file_name().to_string_lossy().as_ref()))
        .filter(|entry| std::fs::remove_dir_all(entry.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_chat_and_chats_no_longer_open_let_go_of_what_they_held() {
        let data = tempfile::tempdir().unwrap();
        let (open, closed, gone) = (
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
        );
        for chat in [open, closed, gone] {
            let held = folder(data.path(), chat);
            std::fs::create_dir_all(&held).unwrap();
            std::fs::write(held.join("bluevox-worktree-square-pin"), "D:/w").unwrap();
        }
        // Closing a chat removes its folder, and only once.
        assert!(close(data.path(), closed));
        assert!(!folder(data.path(), closed).exists());
        assert!(!close(data.path(), closed));
        // A name that is no chat's never reaches outside the leases.
        assert!(!close(data.path(), ".."));
        assert!(!close(data.path(), ""));
        // As the app starts, only the chats still open keep theirs.
        let still = HashSet::from([open.to_string()]);
        assert_eq!(prune(data.path(), &still), 1);
        assert!(folder(data.path(), open).exists());
        assert!(!folder(data.path(), gone).exists());
        assert_eq!(prune(data.path(), &still), 0);
        // With no lease folder at all, nothing to do.
        assert_eq!(prune(&data.path().join("none"), &still), 0);
    }
}
