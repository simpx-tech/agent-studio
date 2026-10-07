//! Claude Code deletes transcripts and other session files older than `cleanupPeriodDays` (30
//! days by default) once a day, from whichever of its sessions on a directory starts first,
//! headless ones included. Saved chats continue from those transcripts, so Agent Studio keeps
//! them: every Claude process it starts passes a ten-year period in its `--settings`, and the
//! directory its chats share with the Claude app and the terminal (`~/.claude`, used by the CLI
//! login and by separate profiles linked to it) gets the same period in its `settings.json` when
//! that file sets none, since those programs sweep it too. A period the user set is left alone,
//! and a chat whose transcript is gone anyway continues from its saved messages
//! (`sessions::Session::verify_transcript`). Inside a WSL distribution the launch script does
//! the same (`share_retain` in `wsl-share.sh`).
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// Claude Code's own example for long retention, about ten years.
pub const DAYS: u32 = 3650;
/// The Claude Code setting that sets the period.
pub const KEY: &str = "cleanupPeriodDays";

/// The `--settings` of a Claude process that needs no other settings.
pub fn settings() -> String {
    format!("{{\"{KEY}\":{DAYS}}}")
}

/// Adds the period to the computer's own Claude directory before a CLI of the current profile
/// starts, when that profile keeps its transcripts there: the CLI login and profiles linked to
/// it. Once per directory in each run of the app; a profile in a WSL distribution is handled by
/// its launch.
pub async fn prepare() {
    if cfg!(test) {
        // Tests never touch this computer's own Claude directory.
        return;
    }
    let profile = crate::profiles::current();
    if profile.distribution.is_some() {
        return;
    }
    let own = profile.provider == "claude" && profile.root.is_some();
    if own && !profile.folders_linked() {
        return;
    }
    let Some(directory) = crate::context::native_default_root("claude") else {
        return;
    };
    static DONE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    if !DONE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(directory.clone())
    {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || keep(&directory)).await;
}

/// Adds the period to `settings.json` in `directory` when the file sets none, leaving the rest
/// of the file as it was, and creates the file when the directory has none. A file that is a
/// link, read-only or not a plain JSON object is left alone. Reports whether the file changed.
pub fn keep(directory: &Path) -> Result<bool, String> {
    if !directory.is_dir() {
        return Ok(false);
    }
    let path = directory.join("settings.json");
    let text = match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !meta.permissions().readonly() => {
            match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(_) => return Ok(false),
            }
        }
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return create(&path);
        }
        Err(_) => return Ok(false),
    };
    let Some(updated) = with_period(&text) else {
        return Ok(false);
    };
    replace(&path, &updated)?;
    Ok(true)
}

/// The text with the period added after the object's opening brace, or `None` when the text is
/// not a JSON object or already sets it. The result is checked to hold the same settings plus
/// the period.
fn with_period(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.contains_key(KEY) {
        return None;
    }
    let start = text.len() - text.trim_start().len();
    let rest = text[start..].strip_prefix('{')?;
    let separator = if object.is_empty() { "" } else { "," };
    let updated = format!("{}{{\n  \"{KEY}\": {DAYS}{separator}{rest}", &text[..start]);
    let mut expected = object.clone();
    expected.insert(KEY.into(), DAYS.into());
    let check: serde_json::Value = serde_json::from_str(&updated).ok()?;
    (check.as_object() == Some(&expected)).then_some(updated)
}

fn create(path: &Path) -> Result<bool, String> {
    let mut file = match std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        // Something wrote it meanwhile: that file is the user's.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(_) => return Err("Cannot create Claude settings".into()),
    };
    file.write_all(format!("{{\n  \"{KEY}\": {DAYS}\n}}\n").as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot write Claude settings")?;
    Ok(true)
}

/// Writes beside the file and moves the copy over it, so the file is never left half written.
fn replace(path: &Path, text: &str) -> Result<(), String> {
    let directory = path.parent().ok_or("Cannot locate Claude settings")?;
    let mut file = tempfile::Builder::new()
        .prefix(".settings.json.")
        .tempfile_in(directory)
        .map_err(|_| "Cannot prepare Claude settings")?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot write Claude settings")?;
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(file.path(), meta.permissions());
    }
    file.persist(path)
        .map_err(|_| "Cannot replace Claude settings")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_period_is_added_after_the_brace_and_everything_else_stays() {
        let text = "{\n  \"model\": \"opus\",\n  \"env\": {\"A\": \"1\"}\n}\n";
        assert_eq!(
            with_period(text).unwrap(),
            "{\n  \"cleanupPeriodDays\": 3650,\n  \"model\": \"opus\",\n  \"env\": {\"A\": \"1\"}\n}\n"
        );
        assert_eq!(
            with_period("{}").unwrap(),
            "{\n  \"cleanupPeriodDays\": 3650}"
        );
        assert_eq!(
            with_period("\r\n {\r\n}\r\n").unwrap(),
            "\r\n {\n  \"cleanupPeriodDays\": 3650\r\n}\r\n"
        );
        assert_eq!(
            with_period("{\"a\":1}").unwrap(),
            "{\n  \"cleanupPeriodDays\": 3650,\"a\":1}"
        );
    }

    #[test]
    fn a_period_the_user_set_or_a_file_that_is_not_an_object_stays_as_it_is() {
        for text in [
            "{\"cleanupPeriodDays\": 30}",
            "{\"cleanupPeriodDays\": 0, \"model\": \"opus\"}",
            "[]",
            "\"text\"",
            "",
            "{\"model\": }",
            "// comment\n{}",
            "\u{feff}{}",
        ] {
            assert_eq!(with_period(text), None, "{text:?}");
        }
    }

    #[test]
    fn the_settings_file_gains_the_period_once_and_keeps_its_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(&path, "{\n  \"model\": \"opus\"\n}\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        assert!(keep(directory.path()).unwrap());
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["cleanupPeriodDays"], DAYS);
        assert_eq!(value["model"], "opus");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o640);
        }
        assert!(!keep(directory.path()).unwrap());
        let names: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["settings.json"]);
    }

    #[test]
    fn a_missing_file_is_created_but_a_missing_directory_or_a_link_is_left_alone() {
        let directory = tempfile::tempdir().unwrap();
        assert!(keep(directory.path()).unwrap());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("settings.json")).unwrap(),
            "{\n  \"cleanupPeriodDays\": 3650\n}\n"
        );
        assert!(!keep(&directory.path().join("missing")).unwrap());
        assert!(!directory.path().join("missing").exists());

        let linked = tempfile::tempdir().unwrap();
        let target = directory.path().join("dotfiles.json");
        std::fs::write(&target, "{}").unwrap();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, linked.path().join("settings.json")).is_ok();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&target, linked.path().join("settings.json"))
            .is_ok();
        if made {
            assert!(!keep(linked.path()).unwrap());
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
        }

        let locked = tempfile::tempdir().unwrap();
        let path = locked.path().join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions.clone()).unwrap();
        assert!(!keep(locked.path()).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
    }

    #[test]
    fn processes_get_the_period_as_their_own_settings() {
        let value: serde_json::Value = serde_json::from_str(&settings()).unwrap();
        assert_eq!(value, serde_json::json!({"cleanupPeriodDays": 3650}));
    }
}
