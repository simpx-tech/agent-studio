//! The files of this computer's own workflow store (docs/WORKFLOWS.md), under app data
//! `workflows/`: a desktop without a relay that keeps workflows reads and writes its definitions
//! and runs here, through the same store code the relay runs (`src/lib/workflow-store.ts`).
//! Only names of the store's own shape are accepted, never a path.
use std::{io::Write, path::PathBuf, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct WorkflowFiles(Mutex<()>);

/// `index.json`, `doc-<uuid>.json` and `events-<uuid>-<n>.json`.
fn valid(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    if stem == "index" {
        return true;
    }
    if let Some(id) = stem.strip_prefix("doc-") {
        return uuid::Uuid::parse_str(id).is_ok() && id.len() == 36;
    }
    if let Some(rest) = stem.strip_prefix("events-") {
        if rest.len() < 38 {
            return false;
        }
        let (id, part) = rest.split_at(36);
        return uuid::Uuid::parse_str(id).is_ok()
            && part.len() > 1
            && part.starts_with('-')
            && part[1..].bytes().all(|b| b.is_ascii_digit());
    }
    false
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("workflows"))
        .map_err(|_| "Cannot locate app data".into())
}

fn path(root: &std::path::Path, name: &str) -> Result<PathBuf, String> {
    if valid(name) {
        Ok(root.join(name))
    } else {
        Err("Invalid workflow file".into())
    }
}

fn read(root: &std::path::Path, name: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path(root, name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read this computer's workflows.".into()),
    }
}

fn write(root: &std::path::Path, name: &str, text: &str) -> Result<(), String> {
    let target = path(root, name)?;
    std::fs::create_dir_all(root).map_err(|_| "Cannot create the workflows folder")?;
    let mut file =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare a workflow file")?;
    file.write_all(text.as_bytes())
        .map_err(|_| "Cannot write a workflow file")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush a workflow file")?;
    file.persist(target)
        .map_err(|_| "Cannot finish saving a workflow file. The previous one was kept.")?;
    Ok(())
}

fn remove(root: &std::path::Path, name: &str) -> Result<(), String> {
    match std::fs::remove_file(path(root, name)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot remove a workflow file.".into()),
    }
}

fn names(root: &std::path::Path) -> Result<Vec<String>, String> {
    match std::fs::read_dir(root) {
        Ok(entries) => Ok(entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| valid(name))
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(_) => Err("Cannot list this computer's workflows.".into()),
    }
}

async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&std::path::Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkflowFiles>();
        let _lock = state.0.lock().map_err(|_| "Workflow storage lock failed")?;
        work(&root(&app)?)
    })
    .await
    .map_err(|_| "Workflow storage is unavailable.".to_string())?
}

#[tauri::command]
pub async fn workflow_file_read(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    blocking(app, move |root| read(root, &name)).await
}
#[tauri::command]
pub async fn workflow_file_write(
    app: tauri::AppHandle,
    call: crate::calls::Call,
    name: String,
    text: String,
) -> Result<(), String> {
    call.once(blocking(app, move |root| write(root, &name, &text)))
        .await
}
#[tauri::command]
pub async fn workflow_file_remove(
    app: tauri::AppHandle,
    call: crate::calls::Call,
    name: String,
) -> Result<(), String> {
    call.once(blocking(app, move |root| remove(root, &name)))
        .await
}
#[tauri::command]
pub async fn workflow_file_names(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    blocking(app, names).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_store_names() {
        let id = "8f0c2a4e-1b2c-4d5e-8f90-1234567890ab";
        for name in [
            "index.json".to_string(),
            format!("doc-{id}.json"),
            format!("events-{id}-0.json"),
            format!("events-{id}-12.json"),
        ] {
            assert!(valid(&name), "{name}");
        }
        for name in [
            "../index.json".to_string(),
            "index.txt".into(),
            format!("doc-{id}.json.tmp"),
            format!("events-{id}-.json"),
            format!("events-{id}-1a.json"),
            format!("doc-{id}/../x.json"),
            "doc-x.json".into(),
        ] {
            assert!(!valid(&name), "{name}");
        }
    }

    #[test]
    fn writes_reads_lists_and_removes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workflows");
        assert_eq!(read(&root, "index.json").unwrap(), None);
        assert!(names(&root).unwrap().is_empty());
        write(&root, "index.json", "{\"version\":1}").unwrap();
        write(&root, "index.json", "{\"version\":1,\"revision\":2}").unwrap();
        assert_eq!(
            read(&root, "index.json").unwrap().as_deref(),
            Some("{\"version\":1,\"revision\":2}")
        );
        assert_eq!(names(&root).unwrap(), vec!["index.json".to_string()]);
        remove(&root, "index.json").unwrap();
        remove(&root, "index.json").unwrap();
        assert!(names(&root).unwrap().is_empty());
        assert!(write(&root, "../escape.json", "x").is_err());
    }
}
