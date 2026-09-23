//! Unsent composer drafts saved on this device only. They are never part of the workspace,
//! workspace exports, or relay sync.
use std::{io::Write, path::Path, sync::Mutex};
use tauri::Manager;

const FILE: &str = "drafts.json";
/// The renderer keeps drafts within 2 MB; the slack covers encoding differences.
const MAX_BYTES: usize = 2_500_000;

#[derive(Default)]
pub struct DraftStorage(Mutex<()>);

fn read(root: &Path) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read(root.join(FILE)) {
        Ok(bytes) if bytes.len() <= MAX_BYTES => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Saved drafts are unreadable.".into()),
        Ok(_) => Err("Saved drafts exceed their size limit.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read saved drafts. Check your app data permissions.".into()),
    }
}

fn write(root: &Path, drafts: &serde_json::Value) -> Result<(), String> {
    if drafts["version"] != 1 || !drafts["drafts"].is_array() {
        return Err("Invalid drafts".into());
    }
    let bytes = serde_json::to_vec(drafts).map_err(|_| "Cannot encode drafts")?;
    if bytes.len() > MAX_BYTES {
        return Err("Drafts exceed their size limit.".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot create app data directory")?;
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare drafts")?;
    file.write_all(&bytes).map_err(|_| "Cannot write drafts")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush drafts")?;
    file.persist(root.join(FILE))
        .map_err(|_| "Cannot finish saving drafts. The previous file was preserved.")?;
    Ok(())
}

fn root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data".into())
}

// Drafts save several times a second while typing; keep file work off the UI thread.
#[tauri::command]
pub async fn load_drafts(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read(&root(&app)?))
        .await
        .map_err(|_| "Cannot read saved drafts.")?
}

#[tauri::command]
pub async fn save_drafts(app: tauri::AppHandle, drafts: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<DraftStorage>();
        let _lock = storage.0.lock().map_err(|_| "Draft storage lock failed")?;
        write(&root(&app)?, &drafts)
    })
    .await
    .map_err(|_| "Cannot save drafts.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saves_and_reads_drafts_atomically() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read(root.path()).unwrap(), None);
        let drafts =
            json!({"version": 1, "drafts": [{"key": "chat:a", "text": "Unsent", "updatedAt": 1}]});
        write(root.path(), &drafts).unwrap();
        assert_eq!(read(root.path()).unwrap(), Some(drafts));
        let empty = json!({"version": 1, "drafts": []});
        write(root.path(), &empty).unwrap();
        assert_eq!(read(root.path()).unwrap(), Some(empty));
        // Only the saved file remains; temporary files are renamed into place.
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn rejects_invalid_or_oversized_drafts_without_replacing_the_saved_file() {
        let root = tempfile::tempdir().unwrap();
        let drafts =
            json!({"version": 1, "drafts": [{"key": "chat:a", "text": "Keep", "updatedAt": 1}]});
        write(root.path(), &drafts).unwrap();
        for invalid in [
            json!({"version": 2, "drafts": []}),
            json!({"version": 1, "drafts": {}}),
            json!({"drafts": []}),
            json!({"version": 1, "drafts": [{"text": "x".repeat(MAX_BYTES)}]}),
        ] {
            assert!(write(root.path(), &invalid).is_err());
        }
        assert_eq!(read(root.path()).unwrap(), Some(drafts));
    }

    #[test]
    fn reports_unreadable_and_oversized_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(FILE), "{damaged").unwrap();
        assert_eq!(
            read(root.path()).unwrap_err(),
            "Saved drafts are unreadable."
        );
        std::fs::write(root.path().join(FILE), vec![b' '; MAX_BYTES + 1]).unwrap();
        assert_eq!(
            read(root.path()).unwrap_err(),
            "Saved drafts exceed their size limit."
        );
    }
}
