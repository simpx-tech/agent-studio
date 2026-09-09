//! Context metadata only. Never return file bodies, settings, account data, or transcripts.
use crate::{folders::ChatLocation, providers::Executable};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const MAX_ENTRIES: usize = 600;
const MAX_VISITS: usize = 6000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    name: String,
    path: String,
    kind: String,
    scope: String,
    status: String,
    detail: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    provider: String,
    model: String,
    checked_at: u64,
    execution: String,
    folder: String,
    profile: String,
    entries: Vec<ContextEntry>,
    notes: Vec<String>,
    truncated: bool,
}

struct Scan {
    snapshot: ContextSnapshot,
    // WSL paths remain Linux paths in the UI, and are inspected through the owning distribution.
    bridge: Option<PathBuf>,
    visited: HashSet<PathBuf>,
    visits: usize,
}
impl Scan {
    fn display(&self, path: &Path) -> String {
        let value = path.to_string_lossy().to_string();
        if self.bridge.is_some() {
            value.replace('\\', "/")
        } else {
            value
        }
    }
    fn physical(&self, path: &Path) -> PathBuf {
        match &self.bridge {
            Some(root) => root.join(path.to_string_lossy().trim_start_matches('/')),
            None => path.to_path_buf(),
        }
    }
    fn note(&mut self, value: &str) {
        if !self.snapshot.notes.iter().any(|n| n == value) {
            self.snapshot.notes.push(value.into());
        }
    }
    fn add(&mut self, path: &Path, kind: &str, scope: &str, status: &str, detail: &str) {
        let path = self.display(path);
        if let Some(entry) = self
            .snapshot
            .entries
            .iter_mut()
            .find(|e| e.path == path && e.kind == kind)
        {
            if status == "reported" || status == "disabled" {
                entry.status = status.into();
                entry.detail = detail.into();
            }
            return;
        }
        if self.snapshot.entries.len() >= MAX_ENTRIES {
            self.snapshot.truncated = true;
            if status == "reported" || status == "disabled" {
                if let Some(index) = self
                    .snapshot
                    .entries
                    .iter()
                    .rposition(|e| e.status != "reported" && e.status != "disabled")
                {
                    self.snapshot.entries.remove(index);
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        self.snapshot.entries.push(ContextEntry {
            name: Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            path,
            kind: kind.into(),
            scope: scope.into(),
            status: status.into(),
            detail: detail.into(),
        });
    }
    fn file(&mut self, path: &Path, kind: &str, scope: &str, detail: &str) -> bool {
        match std::fs::metadata(self.physical(path)) {
            Ok(m) if m.is_file() && m.len() > 0 => {
                self.add(path, kind, scope, "discovered", detail);
                true
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                self.note(
                    "Some source locations could not be inspected. Their availability is unknown.",
                );
                false
            }
            _ => false,
        }
    }
    fn walk(&mut self, dir: &Path, kind: &str, scope: &str, skills: bool, depth: usize) {
        if depth > 12 || self.visits >= MAX_VISITS || self.snapshot.entries.len() >= MAX_ENTRIES {
            self.snapshot.truncated = true;
            return;
        }
        self.visits += 1;
        let physical = self.physical(dir);
        let Ok(canonical) = std::fs::canonicalize(&physical) else {
            return;
        };
        if !self.visited.insert(canonical) {
            return;
        }
        let Ok(files) = std::fs::read_dir(physical) else {
            self.note(
                "Some source locations could not be inspected. Their availability is unknown.",
            );
            return;
        };
        let mut files: Vec<_> = files.take(MAX_VISITS + 1).filter_map(Result::ok).collect();
        files.sort_by_key(|f| f.file_name());
        for item in files {
            self.visits += 1;
            if self.visits >= MAX_VISITS {
                self.snapshot.truncated = true;
                break;
            }
            let logical = dir.join(item.file_name());
            if item.path().is_dir() {
                self.walk(&logical, kind, scope, skills, depth + 1);
            } else if (skills && item.file_name() == "SKILL.md")
                || (!skills && logical.extension().is_some_and(|e| e == "md"))
            {
                self.file(
                    &logical,
                    kind,
                    scope,
                    if skills {
                        "Available file; loaded when a relevant skill is used."
                    } else {
                        "Available file; use depends on the CLI and task."
                    },
                );
                if skills {
                    let display = self.display(&logical);
                    if let Some(entry) =
                        self.snapshot.entries.iter_mut().find(|e| e.path == display)
                    {
                        entry.name = dir.file_name().unwrap_or_default().to_string_lossy().into();
                    }
                }
            }
        }
    }
    fn json(&self, path: &Path) -> Option<Value> {
        let physical = self.physical(path);
        if std::fs::metadata(&physical).ok()?.len() > 2_000_000 {
            return None;
        }
        serde_json::from_slice(&std::fs::read(physical).ok()?).ok()
    }
    fn codex_guidance(&mut self, dir: &Path, scope: &str, fallbacks: &[String]) {
        let mut names = vec!["AGENTS.override.md".into(), "AGENTS.md".into()];
        names.extend(
            fallbacks
                .iter()
                .filter(|n| !n.contains(['/', '\\']) && !n.is_empty())
                .cloned(),
        );
        let mut chosen = false;
        for name in &names {
            let path = dir.join(name);
            let found = self.file(&path, "instructions", scope, if chosen { "A higher-priority instruction file exists in this directory." } else { "Discovered in the Codex instruction chain; loading also depends on configuration and trust." });
            if found && chosen {
                let display = self.display(&path);
                if let Some(entry) = self.snapshot.entries.iter_mut().find(|e| e.path == display) {
                    entry.status = "shadowed".into();
                }
            }
            chosen |= found;
        }
        for name in ["CLAUDE.md", "CLAUDE.local.md"] {
            if !names.iter().any(|n| n == name) && self.file(&dir.join(name), "instructions", scope, "Companion guidance. Codex reads it only if other instructions request it or it is configured as a fallback.") {
                let display = self.display(&dir.join(name));
                if let Some(entry) = self.snapshot.entries.iter_mut().find(|e| e.path == display) { entry.status = "reference".into(); }
            }
        }
    }
}

fn ancestors(folder: &Path, codex: bool, physical: impl Fn(&Path) -> PathBuf) -> Vec<PathBuf> {
    let mut dirs = vec![];
    for dir in folder.ancestors() {
        dirs.push(dir.to_path_buf());
        if codex && physical(dir).join(".git").exists() {
            break;
        }
    }
    if codex
        && !dirs
            .last()
            .is_some_and(|d| physical(d).join(".git").exists())
    {
        dirs.truncate(1);
    }
    dirs.reverse();
    dirs
}

fn inventory(mut scan: Scan, home: PathBuf, config: PathBuf) -> Scan {
    let provider = scan.snapshot.provider.clone();
    let folder = PathBuf::from(&scan.snapshot.folder);
    let dirs = ancestors(&folder, provider == "codex", |p| scan.physical(p));
    if provider == "codex" {
        let config_path = scan.physical(&config.join("config.toml"));
        let config_text = std::fs::metadata(&config_path)
            .ok()
            .filter(|m| m.len() <= 2_000_000)
            .and_then(|_| std::fs::read_to_string(config_path).ok());
        let config_value = config_text
            .as_deref()
            .and_then(|s| toml::from_str::<toml::Value>(s).ok());
        let fallbacks: Vec<String> = config_value
            .as_ref()
            .and_then(|v| v.get("project_doc_fallback_filenames"))
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        scan.codex_guidance(&config, "User", &[]);
        for dir in &dirs {
            scan.codex_guidance(dir, "Project", &fallbacks);
            scan.walk(&dir.join(".agents/skills"), "skills", "Project", true, 0);
        }
        scan.walk(&home.join(".agents/skills"), "skills", "User", true, 0);
        scan.walk(&config.join("skills"), "skills", "Profile", true, 0);
        scan.walk(&config.join("memories"), "memories", "Profile", false, 0);
        scan.note("Instruction files are discovered from disk. Custom config layers, imports, trust, and size limits can change what Codex loads. Skills marked Reported come from the CLI catalog; memory files are available on disk, with use unconfirmed.");
    } else if provider == "claude" {
        scan.file(
            &config.join("CLAUDE.md"),
            "instructions",
            "User",
            "User guidance for the selected CLI profile.",
        );
        scan.walk(&config.join("rules"), "instructions", "User", false, 0);
        scan.walk(&config.join("skills"), "skills", "User", true, 0);
        scan.walk(
            &config.join("commands"),
            "skills",
            "User commands",
            false,
            0,
        );
        let mut enabled = serde_json::Map::new();
        let user_settings = scan
            .json(&config.join("settings.json"))
            .unwrap_or(Value::Null);
        if let Some(values) = user_settings["enabledPlugins"].as_object() {
            enabled.extend(values.clone());
        }
        for dir in &dirs {
            for name in ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"] {
                scan.file(
                    &dir.join(name),
                    "instructions",
                    "Project",
                    "Project guidance; path-scoped instructions can load later.",
                );
            }
            scan.walk(
                &dir.join(".claude/rules"),
                "instructions",
                "Project rules",
                false,
                0,
            );
            scan.walk(&dir.join(".claude/skills"), "skills", "Project", true, 0);
            scan.walk(
                &dir.join(".claude/commands"),
                "skills",
                "Project commands",
                false,
                0,
            );
            for name in ["settings.json", "settings.local.json"] {
                if let Some(v) = scan.json(&dir.join(".claude").join(name)) {
                    if let Some(values) = v["enabledPlugins"].as_object() {
                        enabled.extend(values.clone());
                    }
                }
            }
        }
        if let Some(registry) = scan.json(&config.join("plugins/installed_plugins.json")) {
            for (name, installs) in registry["plugins"].as_object().into_iter().flatten() {
                if enabled.get(name).and_then(Value::as_bool) != Some(true) {
                    continue;
                }
                for install in installs.as_array().into_iter().flatten() {
                    if let Some(project) = install["projectPath"].as_str() {
                        if !dirs.iter().any(|d| d == Path::new(project)) {
                            continue;
                        }
                    }
                    if let Some(path) = install["installPath"].as_str() {
                        scan.walk(&Path::new(path).join("skills"), "skills", "Plugin", true, 0);
                        scan.walk(
                            &Path::new(path).join("commands"),
                            "skills",
                            "Plugin commands",
                            false,
                            0,
                        );
                    }
                }
            }
        }
        if let Some(dir) = user_settings["autoMemoryDirectory"].as_str() {
            let path = dir
                .strip_prefix("~/")
                .map(|p| home.join(p))
                .unwrap_or_else(|| PathBuf::from(dir));
            if path.is_absolute()
                || (scan.bridge.is_some() && path.to_string_lossy().starts_with('/'))
            {
                scan.walk(&path, "memories", "Project memory", false, 0);
            }
        }
        // Only this project's candidate memory folder, never other projects or transcripts.
        let root = dirs
            .iter()
            .rev()
            .find(|d| scan.physical(d).join(".git").exists())
            .unwrap_or(&folder);
        let key: String = root
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        scan.walk(
            &config.join("projects").join(key).join("memory"),
            "memories",
            "Project memory",
            false,
            0,
        );
        let managed = if scan.bridge.is_some() || cfg!(target_os = "linux") {
            PathBuf::from("/etc/claude-code/CLAUDE.md")
        } else if cfg!(windows) {
            PathBuf::from("C:/Program Files/ClaudeCode/CLAUDE.md")
        } else {
            PathBuf::from("/Library/Application Support/ClaudeCode/CLAUDE.md")
        };
        scan.file(
            &managed,
            "instructions",
            "Managed",
            "Organization guidance.",
        );
        scan.note("Reported files come from a fresh Claude context query for this folder and model. Discovered files may be conditional or disabled. This is a startup inspection, not a read history of an earlier reply.");
    } else {
        for dir in &dirs {
            for name in ["AGENTS.md", "GEMINI.md", ".agents/AGENTS.md"] {
                scan.file(
                    &dir.join(name),
                    "instructions",
                    "Project",
                    "Available guidance; loading is not reported by this CLI.",
                );
            }
            scan.walk(
                &dir.join(".agents/rules"),
                "instructions",
                "Project rules",
                false,
                0,
            );
            scan.walk(&dir.join(".agents/skills"), "skills", "Project", false, 0);
        }
        scan.file(
            &home.join(".gemini/GEMINI.md"),
            "instructions",
            "User",
            "Global Antigravity guidance; loading is unconfirmed.",
        );
        scan.walk(
            &home.join(".gemini/antigravity-cli/skills"),
            "skills",
            "User",
            false,
            0,
        );
        scan.note("Antigravity does not expose a verified context inventory here. Listed files are candidates only; memory availability is unknown. Agent Studio runs Gemini in conversation-only mode with skill commands disabled.");
    }
    scan
}

async fn claude_report(exe: &Executable, folder: &str, model: &str) -> Result<Value, String> {
    use std::process::Stdio;
    let mut command = exe.command();
    if exe.wsl.is_some() {
        command.args(["--agent-studio-cwd", folder]);
    } else {
        command.current_dir(folder);
    }
    command
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--settings",
            "{\"disableAllHooks\":true}",
        ])
        .env_remove("CLAUDECODE")
        .env_remove("CODEX_THREAD_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if !model.is_empty() {
        command.args(["--model", model]);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Claude context query")?;
    let mut input = child.stdin.take().ok_or("Missing query input")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("Missing query output")?).lines();
    let query = async {
        input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"init\",\"request\":{\"subtype\":\"initialize\"}}\n").await.map_err(|_| "Context query input failed")?;
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|_| "Context query output failed")?
        {
            if line.len() > 2_000_000 {
                return Err("Context query exceeded its output limit");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["type"] != "control_response" {
                continue;
            }
            let response = &v["response"];
            if response["subtype"] == "error" {
                return Err("Claude could not report context for this model");
            }
            if response["request_id"] == "init" {
                input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"context\",\"request\":{\"subtype\":\"get_context_usage\",\"detail\":\"full\"}}\n").await.map_err(|_| "Context query input failed")?;
            } else if response["request_id"] == "context" {
                return Ok(response["response"].clone());
            }
        }
        Err("Claude exited without a context report")
    };
    let result = tokio::time::timeout(Duration::from_secs(20), query)
        .await
        .map_err(|_| "Claude context query timed out")
        .and_then(|r| r)
        .map_err(String::from);
    exe.kill(&mut child).await;
    result
}

fn merge_report(scan: &mut Scan, report: &Value) {
    if scan.snapshot.provider == "codex" {
        if !report["data"].is_array() {
            scan.note("Codex did not return a skill catalog. Skill availability is unconfirmed.");
            return;
        }
        // Replace skill candidates with the provider's enabled/disabled catalog, retaining other categories.
        scan.snapshot.entries.retain(|e| e.kind != "skills");
        for group in report["data"].as_array().into_iter().flatten() {
            if group["errors"].as_array().is_some_and(|e| !e.is_empty()) {
                scan.note("Codex reported skill discovery errors. The catalog may be incomplete.");
            }
            for skill in group["skills"].as_array().into_iter().flatten() {
                let (Some(path), Some(name)) = (skill["path"].as_str(), skill["name"].as_str())
                else {
                    continue;
                };
                scan.add(
                    Path::new(path),
                    "skills",
                    skill["scope"].as_str().unwrap_or("CLI"),
                    if skill["enabled"] == false {
                        "disabled"
                    } else {
                        "reported"
                    },
                    "Reported by the selected CLI profile. Skill contents load when used.",
                );
                if let Some(entry) = scan
                    .snapshot
                    .entries
                    .iter_mut()
                    .find(|e| e.path == path && e.kind == "skills")
                {
                    entry.name = name.chars().take(200).collect();
                }
            }
        }
    } else {
        if !report["memoryFiles"].is_array() {
            scan.note("Claude did not return instruction-file metadata. Loading is unconfirmed.");
            return;
        }
        for file in report["memoryFiles"].as_array().into_iter().flatten() {
            let Some(path) = file["path"].as_str() else {
                continue;
            };
            let kind = if path.replace('\\', "/").contains("/memory/")
                || file["type"]
                    .as_str()
                    .is_some_and(|t| t.to_lowercase().contains("auto"))
            {
                "memories"
            } else {
                "instructions"
            };
            scan.add(
                Path::new(path),
                kind,
                "CLI",
                "reported",
                "Loaded in a fresh CLI context query for the selected folder and model.",
            );
            if kind == "memories" {
                if let Some(parent) = Path::new(path).parent() {
                    scan.walk(parent, "memories", "Project memory", false, 0);
                }
            }
        }
    }
}

pub async fn read(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    location: Option<ChatLocation>,
) -> Result<ContextSnapshot, String> {
    if !crate::providers::valid_provider(&provider) || model.len() > 200 {
        return Err("Invalid context selection".into());
    }
    let exe = crate::providers::resolve(&provider).await?;
    let profile = crate::profiles::current();
    let runtime = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("chat-runtime");
    std::fs::create_dir_all(&runtime).map_err(|_| "Cannot prepare context query")?;
    let (home, config, bridge, fallback) = if let Some(wsl) = &exe.wsl {
        wsl_paths(wsl, &profile, &provider).await?
    } else {
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("Cannot locate the CLI home directory")?,
        );
        let config = if provider == "gemini" {
            home.join(".gemini/antigravity-cli")
        } else {
            profile
                .root
                .clone()
                .or_else(|| {
                    std::env::var_os(if provider == "codex" {
                        "CODEX_HOME"
                    } else {
                        "CLAUDE_CONFIG_DIR"
                    })
                    .map(PathBuf::from)
                })
                .unwrap_or_else(|| {
                    home.join(if provider == "codex" {
                        ".codex"
                    } else {
                        ".claude"
                    })
                })
        };
        (home, config, None, runtime.to_string_lossy().to_string())
    };
    let has_location = location.is_some();
    let mut folder = location.map(|l| l.path).unwrap_or(fallback);
    if exe.wsl.is_none() {
        if let Some(distro) = profile.distribution.as_deref().filter(|_| has_location) {
            folder = crate::folders::windows_path(distro, &folder)
                .await?
                .to_string_lossy()
                .into();
        }
        if !Path::new(&folder).is_dir() {
            return Err("The selected folder is unavailable. Context was not inspected.".into());
        }
    }
    let profile_path = if bridge.is_some() {
        config.to_string_lossy().replace('\\', "/")
    } else {
        config.to_string_lossy().into()
    };
    let scan = Scan {
        snapshot: ContextSnapshot {
            provider: provider.clone(),
            model: model.clone(),
            checked_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            execution: exe.location(),
            folder: folder.clone(),
            profile: profile_path,
            entries: vec![],
            notes: vec![],
            truncated: false,
        },
        bridge,
        visited: HashSet::new(),
        visits: 0,
    };
    if has_location && !scan.physical(Path::new(&folder)).is_dir() {
        return Err("The selected folder is unavailable. Context was not inspected.".into());
    }
    let mut scan = tokio::task::spawn_blocking(move || inventory(scan, home, config))
        .await
        .map_err(|_| "Context inspection failed")?;
    let report = match provider.as_str() {
        "codex" => Some(
            crate::cli_queries::codex(
                "skills/list",
                json!({"cwds":[folder], "forceReload":true}),
                tokio_util::sync::CancellationToken::new(),
            )
            .await,
        ),
        "claude" => Some(claude_report(&exe, &folder, &model).await),
        _ => None,
    };
    if let Some(report) = report {
        match report { Ok(report) => { scan = tokio::task::spawn_blocking(move || { merge_report(&mut scan, &report); scan }).await.map_err(|_| "Context report processing failed")?; }, Err(_) => scan.note("The CLI context query failed. Showing discovered files; actual loading and enabled state are unconfirmed. Refresh to retry.") }
    }
    Ok(scan.snapshot)
}

type ContextPaths = (PathBuf, PathBuf, Option<PathBuf>, String);
async fn wsl_paths(
    wsl: &crate::wsl::Launch,
    profile: &crate::profiles::Profile,
    provider: &str,
) -> Result<ContextPaths, String> {
    #[cfg(windows)]
    {
        let mut command = tokio::process::Command::new("wsl.exe");
        let script = format!("{}\nprintf '%s\\0%s\\0%s\\0' \"$HOME\" \"${{CODEX_HOME:-$HOME/.codex}}\" \"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}\"", include_str!("wsl-env.sh"));
        command
            .args([
                "--distribution",
                &wsl.distribution,
                "--cd",
                "~",
                "--exec",
                "bash",
                "-lc",
                &script,
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "WSL context inspection timed out")?
            .map_err(|_| "Cannot inspect the WSL profile")?;
        let text =
            std::str::from_utf8(&output.stdout).map_err(|_| "Cannot read WSL context locations")?;
        let paths: Vec<_> = text.split('\0').collect();
        if !output.status.success()
            || paths.len() != 4
            || paths[..3]
                .iter()
                .any(|p| !p.starts_with('/') || p.chars().any(char::is_control))
        {
            return Err("WSL did not report valid context locations".into());
        }
        let home = PathBuf::from(paths[0]);
        let root = home.join(".local/share").join(&profile.namespace);
        let config = if profile.isolated {
            root.join("profiles").join(provider).join(&profile.id)
        } else {
            PathBuf::from(paths[if provider == "codex" { 1 } else { 2 }])
        };
        Ok((
            home,
            config,
            Some(PathBuf::from(format!(
                "\\\\wsl.localhost\\{}",
                wsl.distribution
            ))),
            root.join("runtime").to_string_lossy().replace('\\', "/"),
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = (wsl, profile, provider);
        Err("WSL context must be inspected on its Windows host".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scanner(provider: &str, folder: &Path) -> Scan {
        Scan {
            snapshot: ContextSnapshot {
                provider: provider.into(),
                model: "test".into(),
                checked_at: 0,
                execution: "Fixture".into(),
                folder: folder.to_string_lossy().into(),
                profile: "Fixture".into(),
                entries: vec![],
                notes: vec![],
                truncated: false,
            },
            bridge: None,
            visited: HashSet::new(),
            visits: 0,
        }
    }
    fn file(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    #[test]
    fn codex_honors_scope_override_fallback_and_excludes_other_profiles() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("isolated");
        let project = root.path().join("repo");
        let folder = project.join("sub");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir(project.join(".git")).unwrap();
        file(&config.join("AGENTS.md"), "sensitive fixture body");
        file(
            &config.join("config.toml"),
            "project_doc_fallback_filenames = [\"TEAM.md\"]",
        );
        file(&project.join("AGENTS.override.md"), "override");
        file(&project.join("AGENTS.md"), "base");
        file(&folder.join("TEAM.md"), "fallback");
        file(&folder.join("CLAUDE.md"), "companion");
        file(&root.path().join("AGENTS.md"), "outside git root");
        file(
            &home.join(".codex/memories/private.md"),
            "another login memory",
        );
        file(&config.join("memories/MEMORY.md"), "selected memory");
        file(&config.join("auth.json"), "credential fixture");
        let scan = inventory(scanner("codex", &folder), home, config);
        let entries = &scan.snapshot.entries;
        assert!(entries
            .iter()
            .any(|e| e.name == "AGENTS.md" && e.status == "shadowed"));
        assert!(entries
            .iter()
            .any(|e| e.name == "TEAM.md" && e.status == "discovered"));
        assert!(entries
            .iter()
            .any(|e| e.name == "CLAUDE.md" && e.status == "reference"));
        assert_eq!(entries.iter().filter(|e| e.kind == "memories").count(), 1);
        let serialized = serde_json::to_string(&scan.snapshot).unwrap();
        for excluded in [
            "sensitive fixture body",
            "credential fixture",
            "auth.json",
            "private.md",
            "outside git root",
        ] {
            assert!(!serialized.contains(excluded));
        }
        assert!(!entries
            .iter()
            .any(|e| e.path == root.path().join("AGENTS.md").to_string_lossy()));
    }
    #[test]
    fn skill_report_replaces_candidates_and_preserves_disabled_status() {
        let mut scan = scanner("codex", Path::new("/project"));
        scan.add(
            Path::new("/candidate/SKILL.md"),
            "skills",
            "User",
            "discovered",
            "Candidate",
        );
        merge_report(
            &mut scan,
            &json!({"data":[{"skills":[{"path":"/active/SKILL.md", "name":"active", "enabled":true, "scope":"user"}, {"path":"/off/SKILL.md", "name":"off", "enabled":false}], "errors":[]}]}),
        );
        assert_eq!(scan.snapshot.entries.len(), 2);
        assert_eq!(scan.snapshot.entries[0].status, "reported");
        assert_eq!(scan.snapshot.entries[1].status, "disabled");
    }
    #[test]
    fn malformed_report_keeps_discovery_and_reports_unknown() {
        let mut scan = scanner("codex", Path::new("/project"));
        scan.add(
            Path::new("/candidate/SKILL.md"),
            "skills",
            "User",
            "discovered",
            "Candidate",
        );
        merge_report(&mut scan, &Value::Null);
        assert_eq!(scan.snapshot.entries.len(), 1);
        assert!(scan.snapshot.notes[0].contains("unconfirmed"));
    }
    #[test]
    fn claude_reports_imports_and_only_selected_project_memory() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("project");
        let home = root.path().join("home");
        let config = home.join(".claude");
        file(&folder.join("CLAUDE.md"), "@import.md");
        file(
            &config.join("projects/unrelated/memory/private.md"),
            "unrelated",
        );
        let memory = config.join("projects/selected/memory");
        file(&memory.join("MEMORY.md"), "sensitive memory contents");
        file(&memory.join("workflow.md"), "sensitive memory contents");
        let mut scan = inventory(scanner("claude", &folder), home, config);
        merge_report(
            &mut scan,
            &json!({"memoryFiles":[{"path":folder.join("CLAUDE.md"), "type":"Project"}, {"path":folder.join("import.md"), "type":"Project"}, {"path":memory.join("MEMORY.md"), "type":"AutoMem"}]}),
        );
        assert_eq!(
            scan.snapshot
                .entries
                .iter()
                .filter(|e| e.name == "CLAUDE.md")
                .count(),
            1
        );
        assert!(scan
            .snapshot
            .entries
            .iter()
            .any(|e| e.name == "import.md" && e.status == "reported"));
        assert!(scan
            .snapshot
            .entries
            .iter()
            .any(|e| e.name == "workflow.md" && e.status == "discovered"));
        let serialized = serde_json::to_string(&scan.snapshot).unwrap();
        assert!(!serialized.contains("private.md"));
        assert!(!serialized.contains("sensitive memory contents"));
    }
    #[test]
    fn traversal_is_bounded_and_deduplicates_repeated_roots() {
        let root = tempfile::tempdir().unwrap();
        file(&root.path().join("one/SKILL.md"), "skill");
        let mut scan = scanner("claude", root.path());
        scan.walk(root.path(), "skills", "User", true, 0);
        scan.walk(root.path(), "skills", "User", true, 0);
        assert_eq!(scan.snapshot.entries.len(), 1);
        scan.visits = MAX_VISITS;
        scan.walk(root.path(), "skills", "User", true, 0);
        assert!(scan.snapshot.truncated);
    }
    #[test]
    fn wsl_paths_keep_linux_display_and_map_to_own_distribution() {
        let mut scan = scanner("codex", Path::new("/home/test/project"));
        scan.bridge = Some(PathBuf::from("bridge"));
        let logical = Path::new("/home/test").join(".codex/AGENTS.md");
        scan.add(&logical, "instructions", "User", "discovered", "Fixture");
        assert_eq!(scan.snapshot.entries[0].path, "/home/test/.codex/AGENTS.md");
        assert_eq!(
            scan.physical(&logical),
            Path::new("bridge")
                .join("home/test")
                .join(".codex/AGENTS.md")
        );
    }
}
