//! Host-owned undo checkpoints. The caller supplies identities only, never paths or patches.
use crate::{
    protocol::file_changes::{FilePatch, Snapshot},
    providers::RunRequest,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::Manager;

const MAX_FILE: usize = 512_000;
const MAX_RECORD: usize = 8_000_000;

#[derive(Serialize, Deserialize)]
struct Entry {
    path: PathBuf,
    before: Option<String>,
    after: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Record {
    conversation: String,
    run: String,
    scope: String,
    root: PathBuf,
    files: Vec<Entry>,
    state: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    files: Vec<String>,
    pub undone: bool,
}

fn read(path: &Path, limit: usize) -> Result<Option<String>, String> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read a file for Undo".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect a file")?
        .is_file()
    {
        return Err("Undo supports regular files only".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read a file for Undo")?;
    if bytes.len() > limit || bytes.contains(&0) {
        return Err("A file exceeds Undo's text-file limit".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Undo supports UTF-8 text files only".into())
}

/// Reject traversal, links/reparse points and files outside the verified working directory.
fn checked(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if root
        .canonicalize()
        .map_err(|_| "The working folder is unavailable")?
        != root
    {
        return Err("The working folder changed since this response".into());
    }
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "An edited file is outside this chat's working folder")?;
    if relative.as_os_str().is_empty() {
        return Err("Invalid Undo file path".into());
    }
    let mut result = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Invalid Undo file path".into());
        };
        if name.to_string_lossy().contains(':')
            || name.to_string_lossy().eq_ignore_ascii_case(".git")
        {
            return Err("Protected file path".into());
        }
        result.push(name);
        match std::fs::symlink_metadata(&result) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Undo cannot follow file links".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("Undo cannot follow file links".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect an Undo path".into()),
        }
    }
    if !result.parent().is_some_and(Path::is_dir) {
        return Err("An edited file's directory is unavailable".into());
    }
    Ok(result)
}

fn reverse(current: Option<&str>, patch: &FilePatch) -> Result<Option<String>, String> {
    let hunks = patch
        .hunks
        .as_ref()
        .ok_or("A complete diff was not recorded for every file")?;
    if (patch.kind == "deleted") != current.is_none() {
        return Err("A file no longer matches the recorded edit".into());
    }
    let mut lines: Vec<String> = current
        .unwrap_or_default()
        .split_inclusive('\n')
        .map(String::from)
        .collect();
    for h in hunks.iter().rev() {
        let mut old = Vec::<String>::new();
        let mut new = Vec::<String>::new();
        let mut previous = ' ';
        for line in &h.lines {
            if line == "\\ No newline at end of file" {
                if previous != '+' {
                    old.last_mut().ok_or("Invalid diff")?.pop();
                }
                if previous != '-' {
                    new.last_mut().ok_or("Invalid diff")?.pop();
                }
                continue;
            }
            previous = line.chars().next().ok_or("Invalid diff")?;
            let value = format!("{}\n", &line[1..]);
            match previous {
                ' ' => {
                    old.push(value.clone());
                    new.push(value);
                }
                '-' => old.push(value),
                '+' => new.push(value),
                _ => return Err("Invalid diff".into()),
            }
        }
        if old.len() as u64 != h.old_lines || new.len() as u64 != h.new_lines {
            return Err("Invalid diff counts".into());
        }
        let index = if h.new_lines == 0 {
            h.new_start
        } else {
            h.new_start.checked_sub(1).ok_or("Invalid diff position")?
        } as usize;
        let end = index
            .checked_add(new.len())
            .ok_or("Invalid diff position")?;
        if lines.get(index..end) != Some(new.as_slice()) {
            return Err("A file no longer matches the recorded edit".into());
        }
        lines.splice(index..end, old);
    }
    let value = lines.concat();
    if value.len() > MAX_FILE {
        return Err("An original file exceeds Undo's text-file limit".into());
    }
    if patch.kind == "added" {
        if !value.is_empty() {
            return Err("The newly added file has other content".into());
        }
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn path_for(root: &Path, reported_root: Option<&str>, value: &str) -> Result<PathBuf, String> {
    if crate::protocol::file_changes::private_path(value) {
        return Err("Undo does not record private files".into());
    }
    let path = Path::new(value);
    let path = if let Some(relative) =
        reported_root.and_then(|r| value.strip_prefix(&format!("{}/", r.trim_end_matches('/'))))
    {
        root.join(relative)
    } else if path.is_absolute() {
        // Inspect the original spelling before canonicalizing: otherwise an ancestor
        // symlink could disappear from the checked path even inside the working folder.
        for ancestor in path.ancestors() {
            if let Ok(meta) = std::fs::symlink_metadata(ancestor) {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Undo cannot follow file links".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("Undo cannot follow file links".into());
                }
            }
        }
        // Windows canonical paths have a device prefix; normalize a recorded absolute path
        // through its parent without following a potentially missing/deleted leaf.
        let parent = path
            .parent()
            .ok_or("Invalid file path")?
            .canonicalize()
            .map_err(|_| "An edited directory is unavailable")?;
        parent.join(path.file_name().ok_or("Invalid file path")?)
    } else {
        root.join(path)
    };
    checked(root, &path)
}

fn checkpoint(
    root: PathBuf,
    reported_root: Option<&str>,
    snapshot: &Snapshot,
) -> Result<Vec<Entry>, String> {
    if snapshot.limited {
        return Err("The recorded changes are incomplete".into());
    }
    let mut states: BTreeMap<PathBuf, (Option<String>, Option<String>)> = BTreeMap::new();
    for edit in snapshot.edits.iter().rev() {
        for patch in edit.files.iter().rev() {
            let path = path_for(&root, reported_root, &patch.path)?;
            if !states.contains_key(&path) {
                let content = read(&path, MAX_FILE)?;
                states.insert(path.clone(), (content.clone(), content));
            }
            let current = states.get(&path).unwrap().0.as_deref();
            let original = reverse(current, patch)?;
            if let Some(previous) = &patch.previous_path {
                let previous = path_for(&root, reported_root, previous)?;
                if previous != path {
                    if !states.contains_key(&previous) {
                        let content = read(&previous, MAX_FILE)?;
                        states.insert(previous.clone(), (content.clone(), content));
                    }
                    if states[&previous].0.is_some() {
                        return Err("A rename's original path is occupied".into());
                    }
                    states.get_mut(&previous).unwrap().0 = original;
                    states.get_mut(&path).unwrap().0 = None;
                    if states.len() > 32 {
                        return Err("Too many files for Undo".into());
                    }
                    continue;
                }
            }
            states.get_mut(&path).unwrap().0 = original;
            if states.len() > 32 {
                return Err("Too many files for Undo".into());
            }
        }
    }
    Ok(states
        .into_iter()
        .filter(|(_, (a, b))| a != b)
        .map(|(path, (before, after))| Entry {
            path,
            before,
            after,
        })
        .collect())
}

fn save(path: &Path, record: &Record) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|_| "Cannot encode Undo checkpoint")?;
    if bytes.len() > MAX_RECORD {
        return Err("Undo checkpoint exceeds its limit".into());
    }
    let parent = path.parent().ok_or("Invalid checkpoint path")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create Undo storage")?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Cannot prepare Undo checkpoint")?;
    file.write_all(&bytes)
        .map_err(|_| "Cannot save Undo checkpoint")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush Undo checkpoint")?;
    file.persist(path)
        .map_err(|_| "Cannot finish Undo checkpoint")?;
    Ok(())
}

pub async fn capture(
    app: &tauri::AppHandle,
    request: &RunRequest,
    snapshot: &Snapshot,
) -> Result<(), String> {
    let Some(conversation) = &request.conversation_id else {
        return Ok(());
    };
    if snapshot.edits.is_empty() {
        return Ok(());
    }
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate Undo storage")?;
    let profile = crate::profiles::current();
    let dedicated = crate::standalone::lookup(
        &data,
        conversation,
        &request.agent.provider,
        request.location.as_ref(),
    )? == Some(crate::standalone::Directory::Dedicated);
    let mut reported = request.location.as_ref().map(|l| l.path.clone());
    let folder = if let Some(distribution) = &profile.distribution {
        #[cfg(windows)]
        {
            if reported.is_none() {
                let suffix = if dedicated {
                    format!("standalone/{conversation}")
                } else {
                    "runtime".into()
                };
                let mut command = tokio::process::Command::new("wsl.exe");
                command
                    .args([
                        "--distribution",
                        distribution,
                        "--exec",
                        "bash",
                        "-c",
                        "printf '%s/.local/share/%s/%s' \"$HOME\" \"$1\" \"$2\"",
                        "studio-undo",
                        &profile.namespace,
                        &suffix,
                    ])
                    .creation_flags(0x08000000)
                    .kill_on_drop(true);
                let output =
                    tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
                        .await
                        .map_err(|_| "Undo folder lookup timed out")?
                        .map_err(|_| "Cannot locate Undo folder")?;
                if !output.status.success() {
                    return Err("Cannot locate Undo folder".into());
                }
                reported =
                    Some(String::from_utf8(output.stdout).map_err(|_| "Invalid Undo folder")?);
            }
            crate::folders::windows_path(distribution, reported.as_deref().unwrap()).await?
        }
        #[cfg(not(windows))]
        {
            let _ = distribution;
            return Err("Managed WSL Undo requires Windows".into());
        }
    } else if let Some(location) = &request.location {
        if let Some(distribution) = &profile.folder_distribution {
            crate::folders::windows_path(distribution, &location.path).await?
        } else {
            PathBuf::from(&location.path)
        }
    } else if dedicated {
        data.join("standalone").join(conversation)
    } else {
        data.join("chat-runtime")
    };
    let root = folder
        .canonicalize()
        .map_err(|_| "The working folder is unavailable")?;
    let files = checkpoint(root.clone(), reported.as_deref(), snapshot)?;
    let record = Record {
        conversation: conversation.clone(),
        run: request.run_id.clone(),
        scope: crate::providers::sessions::location_scope(
            &request.agent.provider,
            request.location.as_ref(),
        )?,
        root,
        files,
        state: "ready".into(),
    };
    save(
        &data.join("undo").join(format!("{}.json", request.run_id)),
        &record,
    )
}

fn write_content(path: &Path, content: Option<&str>) -> Result<(), String> {
    if let Some(content) = content {
        let permissions = std::fs::metadata(path).ok().map(|m| m.permissions());
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid file path")?)
            .map_err(|_| "Cannot prepare restored file")?;
        file.write_all(content.as_bytes())
            .map_err(|_| "Cannot restore file")?;
        if let Some(permissions) = permissions {
            file.as_file()
                .set_permissions(permissions)
                .map_err(|_| "Cannot preserve file permissions")?;
        }
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot flush restored file")?;
        file.persist(path)
            .map_err(|_| "Cannot replace restored file")?;
    } else if path.exists() {
        std::fs::remove_file(path).map_err(|_| "Cannot remove the added file")?;
    }
    Ok(())
}

pub fn apply(
    data: &Path,
    conversation: &str,
    run: &str,
    scope: &str,
    commit: bool,
) -> Result<Preview, String> {
    uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
    uuid::Uuid::parse_str(run).map_err(|_| "Invalid run id")?;
    let path = data.join("undo").join(format!("{run}.json"));
    let bytes = read(&path, MAX_RECORD)?.ok_or("No complete Undo checkpoint is available on this computer for that response. Older responses, private files, shell edits, and incomplete diffs cannot be undone here.")?;
    let mut record: Record = serde_json::from_str(&bytes).map_err(|_| "Invalid Undo checkpoint")?;
    if record.conversation != conversation || record.run != run || record.scope != scope {
        return Err("Undo checkpoint belongs to a different conversation or computer".into());
    }
    if record.files.is_empty() {
        return Err("This response has no reversible file changes".into());
    }
    let preview = Preview {
        files: record
            .files
            .iter()
            .map(|e| {
                e.path
                    .strip_prefix(&record.root)
                    .unwrap_or(&e.path)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect(),
        undone: record.state == "undone",
    };
    if preview.undone {
        return Ok(preview);
    }
    // Validate every file before changing any of them. An interrupted transaction can
    // finish only if each file still matches one of its two recorded states.
    for entry in &record.files {
        checked(&record.root, &entry.path)?;
        let current = read(&entry.path, MAX_FILE)?;
        if current != entry.after && !(record.state == "applying" && current == entry.before) {
            return Err(format!(
                "{} has changed since this response. Undo was not applied.",
                entry.path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    if !commit {
        return Ok(preview);
    }
    record.state = "applying".into();
    save(&path, &record)?;
    for entry in &record.files {
        checked(&record.root, &entry.path)?;
        let current = read(&entry.path, MAX_FILE)?;
        if current == entry.before {
            continue;
        }
        if current != entry.after {
            return Err("A file changed during Undo. Some files may already be restored; retry after reviewing the files.".into());
        }
        write_content(&entry.path, entry.before.as_deref()).map_err(|e| {
            format!("{e}. Some files may already be restored; retry to finish Undo.")
        })?;
    }
    record.state = "undone".into();
    save(&path, &record)?;
    Ok(Preview {
        undone: true,
        ..preview
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::file_changes::{Edit, Hunk};
    fn patch(path: &str, before: &str, after: &str) -> FilePatch {
        FilePatch {
            path: path.into(),
            previous_path: None,
            kind: "modified".into(),
            hunks: Some(vec![Hunk {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![format!("-{before}"), format!("+{after}")],
            }]),
        }
    }
    fn fixture() -> (tempfile::TempDir, String, String) {
        (
            tempfile::tempdir().unwrap(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        )
    }
    fn record(root: &Path, conversation: &str, run: &str, patches: Vec<FilePatch>) {
        let project = root.join("project").canonicalize().unwrap();
        let snapshot = Snapshot {
            revision: 1,
            limited: false,
            edits: vec![Edit {
                id: "edit".into(),
                files: patches,
            }],
        };
        let files = checkpoint(project.clone(), None, &snapshot).unwrap();
        save(
            &root.join("undo").join(format!("{run}.json")),
            &Record {
                conversation: conversation.into(),
                run: run.into(),
                scope: "scope".into(),
                root: project,
                files,
                state: "ready".into(),
            },
        )
        .unwrap();
    }
    #[test]
    fn refuses_later_edits_before_writing_any_files_then_undoes_idempotently() {
        let (dir, conversation, run) = fixture();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("a.txt"), "after\n").unwrap();
        std::fs::write(project.join("b.txt"), "after\n").unwrap();
        record(
            dir.path(),
            &conversation,
            &run,
            vec![
                patch("a.txt", "before", "after"),
                patch("b.txt", "before", "after"),
            ],
        );
        let preview = apply(dir.path(), &conversation, &run, "scope", false).unwrap();
        assert_eq!(preview.files.len(), 2);
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "after\n"
        );
        std::fs::write(project.join("b.txt"), "user edit\n").unwrap();
        assert!(apply(dir.path(), &conversation, &run, "scope", true)
            .unwrap_err()
            .contains("changed"));
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "after\n"
        );
        std::fs::write(project.join("b.txt"), "after\n").unwrap();
        assert!(apply(dir.path(), &conversation, &run, "other", true).is_err());
        assert!(apply(
            dir.path(),
            &uuid::Uuid::new_v4().to_string(),
            &run,
            "scope",
            true
        )
        .is_err());
        assert!(
            apply(dir.path(), &conversation, &run, "scope", true)
                .unwrap()
                .undone
        );
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "before\n"
        );
        std::fs::write(project.join("a.txt"), "later user work").unwrap();
        assert!(
            apply(dir.path(), &conversation, &run, "scope", true)
                .unwrap()
                .undone
        );
        assert_eq!(
            std::fs::read_to_string(project.join("a.txt")).unwrap(),
            "later user work"
        );
    }
    #[test]
    fn reverses_add_delete_rename_and_repeated_edits_without_final_newline() {
        let mut added = patch("new.txt", "", "new");
        added.kind = "added".into();
        added.hunks = Some(vec![Hunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: 1,
            lines: vec!["+new".into(), "\\ No newline at end of file".into()],
        }]);
        assert_eq!(reverse(Some("new"), &added).unwrap(), None);
        assert!(reverse(Some("new\nextra\n"), &added).is_err());
        let deleted = FilePatch {
            path: "deleted.txt".into(),
            kind: "deleted".into(),
            previous_path: None,
            hunks: Some(vec![Hunk {
                old_start: 1,
                old_lines: 1,
                new_start: 0,
                new_lines: 0,
                lines: vec!["-deleted".into()],
            }]),
        };
        assert_eq!(reverse(None, &deleted).unwrap(), Some("deleted\n".into()));
        let (dir, conversation, run) = fixture();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("new.txt"), "new").unwrap();
        std::fs::write(project.join("renamed.txt"), "final\n").unwrap();
        let mut renamed = patch("renamed.txt", "original", "middle");
        renamed.kind = "renamed".into();
        renamed.previous_path = Some("old.txt".into());
        record(
            dir.path(),
            &conversation,
            &run,
            vec![
                added,
                deleted,
                renamed,
                patch("renamed.txt", "middle", "final"),
            ],
        );
        apply(dir.path(), &conversation, &run, "scope", true).unwrap();
        assert!(!project.join("new.txt").exists());
        assert!(!project.join("renamed.txt").exists());
        assert_eq!(
            std::fs::read_to_string(project.join("old.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            std::fs::read_to_string(project.join("deleted.txt")).unwrap(),
            "deleted\n"
        );
    }
    #[test]
    fn rejects_incomplete_private_traversal_and_outside_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for path in ["../outside", ".git/config", ".env", "auth.json"] {
            assert!(path_for(&root, None, path).is_err(), "{path}");
        }
        assert!(checked(&root, &root.parent().unwrap().join("other.txt")).is_err());
        let mut p = patch("a", "before", "after");
        p.hunks = None;
        assert!(reverse(Some("after\n"), &p).is_err());
    }
    #[test]
    fn an_interrupted_transaction_finishes_only_from_known_states() {
        let (dir, conversation, run) = fixture();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("a.txt"), "after\n").unwrap();
        record(
            dir.path(),
            &conversation,
            &run,
            vec![patch("a.txt", "before", "after")],
        );
        let path = dir.path().join("undo").join(format!("{run}.json"));
        let mut r: Record = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        r.state = "applying".into();
        save(&path, &r).unwrap();
        std::fs::write(project.join("a.txt"), "before\n").unwrap();
        assert!(
            apply(dir.path(), &conversation, &run, "scope", true)
                .unwrap()
                .undone
        );
    }
}
