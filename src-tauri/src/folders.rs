//! Folder and execution environments are pinned independently; only Windows may open its own WSL folders.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Clone, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLocation {
    computer_id: String,
    pub environment_id: String,
    #[serde(default)]
    execution_environment_id: Option<String>,
    pub path: String,
}
pub fn validate_chat(
    app: &tauri::AppHandle,
    location: Option<&ChatLocation>,
    connection_id: Option<&str>,
) -> Result<(), String> {
    let Some(location) = location else {
        return Ok(());
    };
    let file = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("workspace.json");
    let workspace: serde_json::Value = serde_json::from_slice(
        &std::fs::read(file).map_err(|_| "Save the folder selection before chatting")?,
    )
    .map_err(|_| "Cannot read the folder selection")?;
    validate_connection(&workspace, location, connection_id)
}
fn validate_connection(
    workspace: &serde_json::Value,
    location: &ChatLocation,
    connection_id: Option<&str>,
) -> Result<(), String> {
    let connection = workspace["fleet"]["connections"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|c| c["id"].as_str() == connection_id && connection_id.is_some())
        })
        .ok_or("Choose a CLI connection for this folder")?;
    let environment = workspace["fleet"]["environments"]
        .as_array()
        .and_then(|list| {
            list.iter().find(|e| {
                e["id"] == location.environment_id && e["computerId"] == location.computer_id
            })
        })
        .ok_or("Folder environment no longer exists on this computer")?;
    let execution_id = location
        .execution_environment_id
        .as_deref()
        .unwrap_or(&location.environment_id);
    let execution = workspace["fleet"]["environments"]
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|e| e["id"] == execution_id && e["computerId"] == location.computer_id)
        })
        .ok_or("The selected execution computer is unavailable")?;
    if connection["environmentId"] != execution_id {
        return Err("The selected CLI does not belong to the selected execution computer".into());
    }
    if environment["id"] != execution["id"]
        && !(execution["platform"] == "windows"
            && environment["platform"] == "wsl"
            && environment["discoveredOn"] == execution["id"])
    {
        return Err("The selected computer cannot access this folder environment".into());
    }
    if location.path.is_empty() {
        return Err("Choose a folder before chatting".into());
    }
    validate_path(&location.path, environment["platform"] != "windows")
}

#[derive(Debug, Serialize)]
pub struct FolderEntry {
    name: String,
    path: String,
}
#[derive(Debug, Serialize)]
pub struct FolderListing {
    path: String,
    parent: Option<String>,
    entries: Vec<FolderEntry>,
    truncated: bool,
}
pub fn environment_distribution(
    app: &tauri::AppHandle,
    environment_id: &str,
) -> Result<Option<String>, String> {
    uuid::Uuid::parse_str(environment_id).map_err(|_| "Invalid environment id")?;
    let local = crate::profiles::installation(app)?;
    if environment_id == local.id {
        return Ok(None);
    }
    let file = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("workspace.json");
    let workspace: serde_json::Value = serde_json::from_slice(
        &std::fs::read(file).map_err(|_| "Save the workspace before browsing folders")?,
    )
    .map_err(|_| "Cannot read environments")?;
    let environment = workspace["fleet"]["environments"]
        .as_array()
        .and_then(|list| list.iter().find(|e| e["id"] == environment_id))
        .ok_or("Folder environment no longer exists")?;
    if !cfg!(windows) || environment["platform"] != "wsl" || environment["discoveredOn"] != local.id
    {
        return Err("This folder belongs to another computer; use its relay host".into());
    }
    Ok(Some(
        environment["distribution"]
            .as_str()
            .ok_or("WSL distribution is missing")?
            .to_string(),
    ))
}
pub fn validate_path(path: &str, linux: bool) -> Result<(), String> {
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || (!path.is_empty()
            && if linux {
                !path.starts_with('/')
            } else {
                !Path::new(path).is_absolute()
            })
    {
        return Err("Enter an absolute folder path for this environment".into());
    }
    #[cfg(windows)]
    if !linux
        && (path.to_lowercase().starts_with(r"\\wsl$")
            || path.to_lowercase().starts_with(r"\\wsl.localhost"))
    {
        return Err("Choose the WSL environment and its Linux folder path".into());
    }
    Ok(())
}

pub async fn windows_path(distribution: &str, path: &str) -> Result<PathBuf, String> {
    validate_path(path, true)?;
    // These Linux names cannot identify the same directory through Windows file APIs.
    if path.is_empty()
        || path.chars().any(|c| "\\:*?\"<>|".contains(c))
        || path
            .split('/')
            .any(|part| part != "." && part != ".." && part.ends_with(['.', ' ']))
    {
        return Err("The selected WSL folder cannot be represented as a Windows path.".into());
    }
    #[cfg(windows)]
    {
        use std::{process::Stdio, time::Duration};
        let mut command = tokio::process::Command::new("wsl.exe");
        command
            .args([
                "--distribution",
                distribution,
                "--exec",
                "bash",
                "-c",
                include_str!("folders-windows-path.sh"),
                "agent-studio",
                path,
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(Stdio::null());
        let output = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .map_err(|_| "Opening the selected WSL folder from Windows timed out")?
            .map_err(|_| "Cannot access the selected WSL folder from Windows")?;
        if !output.status.success() {
            return Err(
                "The selected folder is unavailable. Check its path and permissions in WSL.".into(),
            );
        }
        let translated = std::str::from_utf8(&output.stdout)
            .map_err(|_| "WSL returned an unreadable Windows folder path")?
            .trim_end_matches(['\r', '\n']);
        if !Path::new(translated).is_absolute() || translated.chars().any(char::is_control) {
            return Err("WSL did not return an absolute Windows folder path".into());
        }
        Ok(PathBuf::from(translated))
    }
    #[cfg(not(windows))]
    {
        let _ = distribution;
        Err("Windows CLI access to WSL folders requires their Windows host".into())
    }
}
fn native_listing(path: PathBuf) -> Result<FolderListing, String> {
    // Preserve the selected spelling (including drive roots) rather than emitting Windows device paths.
    let read = std::fs::read_dir(&path)
        .map_err(|_| "Cannot open this folder. Check its path and permissions.")?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in read {
        let entry = entry.map_err(|_| "Could not finish reading this folder")?;
        if !entry.path().is_dir() {
            continue;
        }
        if entries.len() == 1000 {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.chars().any(char::is_control) {
            continue;
        }
        entries.push(FolderEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
        });
    }
    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(FolderListing {
        parent: path.parent().map(|p| p.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        entries,
        truncated,
    })
}
pub async fn list(
    app: tauri::AppHandle,
    environment_id: String,
    path: String,
) -> Result<FolderListing, String> {
    let distribution = environment_distribution(&app, &environment_id)?;
    validate_path(&path, distribution.is_some())?;
    if let Some(distribution) = distribution {
        #[cfg(windows)]
        {
            let mut command = tokio::process::Command::new("wsl.exe");
            command
                .args([
                    "--distribution",
                    &distribution,
                    "--cd",
                    "~",
                    "--exec",
                    "bash",
                    "-c",
                    include_str!("folders-wsl.sh"),
                    "agent-studio",
                    &path,
                ])
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null());
            let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
                .await
                .map_err(|_| "WSL folder browsing timed out")?
                .map_err(|_| "Cannot start WSL folder browsing")?;
            if !output.status.success() {
                return Err("Cannot open this WSL folder. Check its path and permissions.".into());
            }
            return parse_wsl(&output.stdout);
        }
        #[cfg(not(windows))]
        {
            let _ = distribution;
            return Err("WSL browsing requires its Windows host".into());
        }
    }
    let path = if path.is_empty() {
        PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("Home folder is unavailable")?,
        )
    } else {
        PathBuf::from(path)
    };
    tokio::task::spawn_blocking(move || native_listing(path))
        .await
        .map_err(|_| "Folder browsing failed")?
}
#[cfg(any(windows, test))]
fn parse_wsl(bytes: &[u8]) -> Result<FolderListing, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "WSL returned unreadable folder names")?;
    let mut values = text.split('\0');
    let path = values
        .next()
        .filter(|s| s.starts_with('/'))
        .ok_or("WSL did not return a folder")?
        .to_string();
    let mut entries: Vec<_> = values
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .take(1001)
        .map(|name| FolderEntry {
            name: name.to_string(),
            path: format!("{}/{name}", path.trim_end_matches('/')),
        })
        .collect();
    let truncated = entries.len() > 1000;
    entries.truncate(1000);
    entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(FolderListing {
        parent: Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string()),
        path,
        entries,
        truncated,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_directories_without_reading_files_and_handles_special_names() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("project with spaces")).unwrap();
        std::fs::write(root.path().join("file.txt"), "not a folder").unwrap();
        let result = native_listing(root.path().into()).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].name, "project with spaces");
        assert!(native_listing(root.path().join("missing")).is_err());
        let wsl = parse_wsl(b"/home/test\0a 'quoted' $(literal)\0project\0").unwrap();
        assert_eq!(wsl.entries[0].path, "/home/test/a 'quoted' $(literal)");
        assert_eq!(wsl.parent.as_deref(), Some("/home"));
    }
    #[test]
    fn rejects_relative_and_control_paths() {
        assert!(validate_path("../project", true).is_err());
        assert!(validate_path("/project\nother", true).is_err());
        assert!(validate_path("/home/project with spaces", true).is_ok());
        assert!(validate_path("", false).is_ok());
    }
    #[test]
    fn folder_routing_rejects_other_environments_and_missing_connections() {
        let workspace = serde_json::json!({"fleet":{"environments":[{"id":"linux", "computerId":"desktop", "platform":"wsl"}],"connections":[{"id":"correct", "environmentId":"linux"},{"id":"wrong", "environmentId":"windows"}]}});
        let location = ChatLocation {
            computer_id: "desktop".into(),
            environment_id: "linux".into(),
            execution_environment_id: None,
            path: "/home/project".into(),
        };
        assert!(validate_connection(&workspace, &location, Some("correct")).is_ok());
        assert!(validate_connection(&workspace, &location, Some("wrong")).is_err());
        assert!(validate_connection(&workspace, &location, None).is_err());
    }
    #[test]
    fn desktop_can_open_its_wsl_folder_without_switching_the_connection() {
        let workspace = serde_json::json!({"fleet":{
            "environments":[
                {"id":"windows","computerId":"desktop","platform":"windows"},
                {"id":"ubuntu","computerId":"desktop","platform":"wsl","discoveredOn":"windows"},
                {"id":"debian","computerId":"desktop","platform":"wsl","discoveredOn":"windows"},
                {"id":"remote","computerId":"laptop","platform":"windows"}
            ],
            "connections":[{"id":"native","environmentId":"windows"},{"id":"linux","environmentId":"ubuntu"},{"id":"sibling","environmentId":"debian"},{"id":"other","environmentId":"remote"}]
        }});
        let mut location = ChatLocation {
            computer_id: "desktop".into(),
            environment_id: "ubuntu".into(),
            execution_environment_id: Some("windows".into()),
            path: "/home/project".into(),
        };
        assert!(validate_connection(&workspace, &location, Some("native")).is_ok());
        assert!(validate_connection(&workspace, &location, Some("linux")).is_err());
        assert!(validate_connection(&workspace, &location, Some("other")).is_err());
        location.execution_environment_id = None;
        assert!(validate_connection(&workspace, &location, Some("linux")).is_ok());
        assert!(validate_connection(&workspace, &location, Some("native")).is_err());
        location.execution_environment_id = Some("debian".into());
        assert!(validate_connection(&workspace, &location, Some("sibling")).is_err());
        location.execution_environment_id = Some("remote".into());
        assert!(validate_connection(&workspace, &location, Some("other")).is_err());
    }
}
