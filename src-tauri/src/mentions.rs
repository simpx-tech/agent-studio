//! Explicit composer discovery. Return names only; never read file bodies or invoke tools.
use crate::{
    folders::ChatLocation,
    pool::{Line, Process},
    providers::Executable,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

const MAX_FILES: usize = 50;
const MAX_APPS: usize = 200;
const MAX_VISITS: usize = 20_000;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mention {
    pub kind: String,
    pub name: String,
    pub path: String,
    pub token: String,
}
#[derive(Serialize)]
pub struct Results {
    pub entries: Vec<Mention>,
    pub truncated: bool,
    pub notice: String,
}
fn clean(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
fn file_token(name: &str) -> String {
    if name
        .chars()
        .any(|c| c.is_whitespace() || "\"()[]`".contains(c))
    {
        format!("@\"{name}\"")
    } else {
        format!("@{name}")
    }
}
pub fn valid(m: &Mention) -> bool {
    clean(&m.name, 4096)
        && clean(&m.path, 4096)
        && clean(&m.token, 4100)
        && match m.kind.as_str() {
            "app" => {
                m.path.strip_prefix("app://").is_some_and(|id| {
                    clean(id, 200)
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                }) && m.token.strip_prefix('$').is_some_and(|s| {
                    !s.is_empty()
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
                })
            }
            "file" => {
                !m.name.contains('"')
                    && m.token == file_token(&m.name)
                    && (m.path.starts_with('/')
                        || m.path.starts_with("\\\\")
                        || (m.path.as_bytes().get(1) == Some(&b':')
                            && m.path
                                .as_bytes()
                                .get(2)
                                .is_some_and(|c| *c == b'/' || *c == b'\\')))
            }
            _ => false,
        }
}
pub fn has_token(text: &str, token: &str) -> bool {
    text.match_indices(token).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + token.len()..].chars().next();
        before.is_none_or(|c| c.is_whitespace() || "([".contains(c))
            && after.is_none_or(|c| {
                c.is_whitespace() || ")],;!?".contains(c) || (token.starts_with('$') && c == '.')
            })
    })
}
fn file(name: &str, folder: &str) -> Option<Mention> {
    // Search roots are chosen by the host, never by the result or renderer.
    let name = name.replace('\\', "/");
    if name.starts_with('/') || name.split('/').any(|p| p == ".." || p.contains(':')) {
        return None;
    }
    let path = format!(
        "{}{name}",
        if folder.ends_with(['/', '\\']) {
            folder.to_string()
        } else {
            format!("{folder}/")
        }
    );
    let m = Mention {
        kind: "file".into(),
        token: file_token(&name),
        name,
        path,
    };
    valid(&m).then_some(m)
}
fn files(value: &Value, folder: &str) -> Result<Results, String> {
    let rows = value["files"]
        .as_array()
        .ok_or("File search is unavailable in this Codex version")?;
    let mut seen = HashSet::new();
    let entries: Vec<_> = rows
        .iter()
        .filter(|r| r["root"] == folder && r["match_type"] == "file")
        .filter_map(|r| file(r["path"].as_str()?, folder))
        .filter(|m| seen.insert(m.path.clone()))
        .take(MAX_FILES)
        .collect();
    Ok(Results {
        entries,
        truncated: rows.len() >= MAX_FILES,
        notice: String::new(),
    })
}
fn apps(value: &Value) -> Result<Vec<Mention>, String> {
    let rows = value["data"]
        .as_array()
        .ok_or("App mentions are unavailable in this Codex version")?;
    Ok(rows
        .iter()
        .take(MAX_APPS)
        .filter(|r| r["isAccessible"] == true && r["isEnabled"] == true)
        .filter_map(|r| {
            let name = r["name"].as_str()?;
            let slug = name
                .to_ascii_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            let m = Mention {
                kind: "app".into(),
                name: name.into(),
                path: format!("app://{}", r["id"].as_str()?),
                token: format!("${slug}"),
            };
            valid(&m).then_some(m)
        })
        .collect())
}
async fn rpc(p: &mut Process, method: &str, params: Value) -> Result<Value, String> {
    let id = p.next_id;
    p.next_id += 1;
    p.stdin
        .write_all(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
        .await
        .map_err(|_| "Could not send mention query")?;
    while let Some(line) = p.lines.recv().await {
        let Line::Out(line) = line else { continue };
        if line.len() > 2_000_000 {
            return Err("Mention results exceeded their limit".into());
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v["id"] == id && v.get("method").is_none() {
            return if v.get("error").is_some() {
                Err(if method == "app/list" && v["error"]["message"].as_str().is_some_and(|s| s.contains("403 Forbidden")) {
                    "Codex denied app catalog access (HTTP 403). Check app access in the selected CLI and try again."
                } else {
                    "Mention search failed. Check the selected CLI version and connection, then reopen the picker."
                }.into())
            } else {
                Ok(v["result"].clone())
            };
        }
        if v.get("id").is_some() && v["method"].is_string() {
            p.stdin.write_all(format!("{}\n", json!({"id":v["id"],"error":{"code":-32601,"message":"Interactive requests are unavailable during mention discovery"}})).as_bytes()).await.map_err(|_| "Could not decline discovery input")?;
        }
    }
    Err("The selected CLI exited during mention search".into())
}
pub(crate) async fn codex(
    exe: &Executable,
    folder: &str,
    kind: &str,
    query: &str,
) -> Result<Results, String> {
    let child = crate::mcp::command(exe, folder)
        .args(["app-server", "--stdio"])
        .spawn()
        .map_err(|_| "Could not start the selected Codex CLI")?;
    let mut p = Process::new(exe.clone(), child, String::new(), String::new())?;
    let result = tokio::time::timeout(Duration::from_secs(if kind == "app" { 60 } else { 20 }), async {
        rpc(&mut p, "initialize", json!({"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true,"optOutNotificationMethods":["app/list/updated"]}})).await?;
        p.stdin.write_all(b"{\"method\":\"initialized\"}\n").await.map_err(|_| "Could not initialize mention discovery")?;
        if kind == "file" {
            let value = rpc(&mut p, "fuzzyFileSearch", json!({"query":query,"roots":[folder],"cancellationToken":null})).await?;
            return files(&value, folder);
        }
        let mut result = Results { entries: vec![], truncated: false, notice: String::new() };
        let mut cursor = Value::Null;
        let mut seen = HashSet::new();
        for _ in 0..20 {
            let value = rpc(&mut p, "app/list", json!({"limit":50,"cursor":cursor,"forceRefetch":false})).await?;
            result.entries.extend(apps(&value)?);
            cursor = value["nextCursor"].clone();
            if cursor.is_null() { break; }
            if result.entries.len() >= MAX_APPS { break; }
            if !cursor.as_str().is_some_and(|s| clean(s, 4096)) || !seen.insert(cursor.to_string()) { return Err("Invalid app pagination".into()); }
        }
        result.truncated = !cursor.is_null();
        let mut seen = HashSet::new();
        result.entries.retain(|m| seen.insert(m.path.clone()));
        result.entries.truncate(MAX_APPS);
        Ok(result)
    }).await.map_err(|_| "Mention search timed out. Reopen the picker to retry.".to_string()).and_then(|r| r);
    p.kill().await;
    result
}
fn matches(path: &str, query: &str) -> bool {
    let path = path.to_lowercase();
    let mut chars = path.chars();
    query.to_lowercase().chars().all(|c| chars.any(|p| p == c))
}

fn claude_files(root: PathBuf, folder: String, query: String) -> Results {
    let mut entries = Vec::new();
    let mut stack = vec![(root.clone(), 0)];
    let mut visits = 0;
    let mut truncated = false;
    let deadline = Instant::now() + Duration::from_secs(3);
    'scan: while let Some((dir, depth)) = stack.pop() {
        let Ok(items) = std::fs::read_dir(dir) else {
            truncated = true;
            continue;
        };
        for item in items {
            visits += 1;
            if visits > MAX_VISITS || Instant::now() > deadline {
                truncated = true;
                break 'scan;
            }
            let Ok(item) = item else {
                truncated = true;
                continue;
            };
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let path = item.path();
            if kind.is_dir() {
                let name = item.file_name().to_string_lossy().into_owned();
                if !name.starts_with('.')
                    && !["node_modules", "target", "build", "dist", "vendor"]
                        .contains(&name.as_str())
                {
                    if depth < 20 {
                        stack.push((path, depth + 1));
                    } else {
                        truncated = true;
                    }
                }
            } else if kind.is_file() {
                let Ok(relative) = path.strip_prefix(&root) else {
                    continue;
                };
                let name = relative.to_string_lossy().replace('\\', "/");
                if matches(&name, &query) {
                    if let Some(m) = file(&name, &folder) {
                        entries.push(m);
                    }
                }
            }
        }
    }
    entries.sort_by_key(|m| {
        (
            !m.name.to_lowercase().contains(&query.to_lowercase()),
            m.name.len(),
            m.name.clone(),
        )
    });
    truncated |= entries.len() > MAX_FILES;
    entries.truncate(MAX_FILES);
    Results {
        entries,
        truncated,
        notice: "File names only. Hidden and generated directories are omitted.".into(),
    }
}
pub async fn read(
    app: tauri::AppHandle,
    provider: String,
    location: Option<ChatLocation>,
    conversation: Option<String>,
    kind: String,
    query: String,
) -> Result<Results, String> {
    if !matches!(provider.as_str(), "codex" | "claude")
        || !matches!(kind.as_str(), "file" | "app")
        || (kind == "app" && provider != "codex")
        || query.len() > 256
        || query.chars().any(char::is_control)
    {
        return Err("Invalid mention query".into());
    }
    if let Some(id) = &conversation {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid conversation id")?;
    }
    if kind == "file" && location.is_none() {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate chat data")?;
        let bound = conversation
            .as_deref()
            .map(|id| crate::standalone::context_directory(&root, id, &provider, false))
            .transpose()?
            .flatten();
        if bound.is_none() {
            return Err("Choose a project folder, or send the first message to create this Standalone chat's working folder.".into());
        }
    }
    let _slot = tokio::time::timeout(Duration::from_secs(1), SLOTS.acquire())
        .await
        .map_err(|_| "Mention search is busy. Reopen the picker to retry.")?
        .map_err(|_| "Mention search is unavailable")?;
    let exe = crate::providers::resolve(&provider).await?;
    let folder = crate::mcp::folder(
        &app,
        &provider,
        &exe,
        location.as_ref(),
        conversation.as_deref(),
    )
    .await?;
    if provider == "codex" {
        return codex(&exe, &folder, &kind, &query).await;
    }
    let physical = if let Some(wsl) = &exe.wsl {
        let (_, _, bridge, _) =
            crate::context::wsl_paths(wsl, &crate::profiles::current(), &provider).await?;
        bridge
            .map(|b| b.join(folder.trim_start_matches('/')))
            .unwrap_or_else(|| PathBuf::from(&folder))
    } else {
        PathBuf::from(&folder)
    };
    tokio::task::spawn_blocking(move || claude_files(physical, folder, query))
        .await
        .map_err(|_| "File search failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn results_keep_only_files_from_the_requested_root_and_never_accept_parent_paths() {
        let result = files(&json!({"files":[
            {"root":"/project","path":"src/my file.ts","match_type":"file","body":"never returned"},
            {"root":"/other","path":"secret.txt","match_type":"file"},
            {"root":"/project","path":"../escape","match_type":"file"},
            {"root":"/project","path":"src","match_type":"directory"}
        ]}), "/project").unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].token, "@\"src/my file.ts\"");
        assert_eq!(result.entries[0].path, "/project/src/my file.ts");
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("never returned"));
    }
    #[test]
    fn app_results_require_explicit_access_and_enablement_and_strip_private_metadata() {
        let rows = apps(&json!({"data":[
            {"id":"demo","name":"Demo App","isEnabled":true,"isAccessible":true,"installUrl":"private"},
            {"id":"disabled","name":"Disabled","isEnabled":false,"isAccessible":true},
            {"id":"missing","name":"Missing","isEnabled":true},
            {"id":"bad?token=secret","name":"Bad","isEnabled":true,"isAccessible":true}
        ]})).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].token, "$demo-app");
        assert!(!serde_json::to_string(&rows).unwrap().contains("private"));
    }
    #[test]
    fn claude_search_is_bounded_name_only_and_omits_generated_directories() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("src/my file.ts"), "secret body").unwrap();
        std::fs::write(dir.path().join("node_modules/my file.ts"), "secret body").unwrap();
        let result = claude_files(dir.path().into(), "/selected".into(), "myf".into());
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].path, "/selected/src/my file.ts");
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("secret body"));
    }
}
