//! Shared source metadata. Credentials and settings bodies never enter another profile.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize)]
pub struct SharedContext {
    pub source: String,
    pub files: Vec<Source>,
    pub skill_root: Option<String>,
    pub plugin_dir: Option<String>,
    pub memory_dir: Option<String>,
    // MCP server definitions from the source (Claude .claude.json scopes) and the equivalent
    // Codex -c overrides. Definitions may carry environment values, so they are handed to the
    // launched process only and never serialized into identities, history or the relay.
    #[serde(skip)]
    pub mcp_servers: serde_json::Map<String, serde_json::Value>,
    #[serde(skip)]
    pub codex_overrides: Vec<String>,
    pub mcp_names: Vec<String>,
    pub mcp_digest: u64,
}
/// Launch arguments have bounded length on Windows; shared MCP definitions stay well under it.
const MCP_LAUNCH_LIMIT: usize = 24_000;
#[derive(Clone, Serialize)]
pub struct Source {
    pub path: String,
    pub kind: String,
}

impl SharedContext {
    pub fn guidance(&self) -> String {
        if self.source.is_empty() {
            return String::new();
        }
        format!("The user selected shared context for this conversation (this computer's CLI context or another account's); its MCP server definitions are loaded for this conversation too. Before working, read the shared instruction files below and follow their applicable instructions and imports, resolving relative references from each source file. These supplement project and conversation instructions. For relevant prior knowledge, consult the shared memory entrypoints and their task-relevant references. Keep learned memories in the selected shared memory location when the user authorizes saving them. Do not inspect other profile files, configuration or credentials. Recheck these sources on later replies when they may have changed. Shared sources (JSON): {}", serde_json::to_string(&self.files).unwrap())
    }
    pub fn extend_runtime(&self, runtime: &mut crate::plugins::Runtime) {
        if let Some(root) = &self.skill_root {
            if !runtime.skill_roots.contains(root) {
                runtime.skill_roots.push(root.clone());
            }
        }
        if let Some(root) = &self.plugin_dir {
            if !runtime.plugin_dirs.contains(root) {
                runtime.plugin_dirs.push(root.clone());
            }
        }
    }
}

pub fn native_path(path: &Path, distribution: Option<&str>) -> Result<String, String> {
    let path = path.to_string_lossy();
    let Some(distribution) = distribution else {
        return Ok(path.into_owned());
    };
    let normal = path
        .strip_prefix("\\\\?\\UNC\\")
        .map(|p| format!("\\\\{p}"))
        .unwrap_or_else(|| path.into_owned());
    let prefix = format!("\\\\wsl.localhost\\{distribution}\\");
    Ok(format!(
        "/{}",
        normal
            .strip_prefix(&prefix)
            .ok_or("The shared source is outside its execution computer")?
            .replace('\\', "/")
    ))
}

pub async fn load(provider: &str, folder: &str) -> Result<SharedContext, String> {
    let selected = crate::profiles::current();
    if let Some(error) = selected.shared_error {
        return Err(error);
    }
    let Some(source) = selected.shared_source else {
        return Ok(SharedContext::default());
    };
    let distribution = source.distribution.clone();
    let config = crate::profiles::scope(*source.clone(), async {
        crate::context::native_profile_root(provider).await
    })
    .await?;
    if !config.is_dir() {
        return Err("The shared account context directory is unavailable".into());
    }
    let mut result = collect(
        provider,
        folder,
        &config,
        distribution.as_deref(),
        &source.id,
    )?;
    let global = crate::profiles::scope(*source.clone(), async {
        crate::context::native_global_config(provider).await
    })
    .await?;
    if provider == "claude" {
        result.mcp_servers = claude_mcp_servers(&global, folder, distribution.as_deref())?;
    } else if provider == "codex" {
        result.codex_overrides = codex_mcp_overrides(&global)?;
    }
    result.describe_mcp();
    Ok(result)
}

impl SharedContext {
    // Names and a digest identify the shared definitions for process reuse and the inventory
    // without exposing commands, URLs or environment values.
    fn describe_mcp(&mut self) {
        use std::hash::{Hash, Hasher};
        let mut names: Vec<String> = self.mcp_servers.keys().cloned().collect();
        names.extend(self.codex_overrides.iter().filter_map(|line| {
            line.strip_prefix("mcp_servers.")
                .and_then(|rest| rest.split('.').next())
                .map(str::to_string)
        }));
        names.sort();
        names.dedup();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let canonical: std::collections::BTreeMap<_, _> = self.mcp_servers.iter().collect();
        serde_json::to_string(&canonical)
            .unwrap_or_default()
            .hash(&mut hasher);
        self.codex_overrides.hash(&mut hasher);
        self.mcp_names = names;
        self.mcp_digest = hasher.finish();
    }
}

// Claude keys its projects map by the working directory as the CLI saw it: forward slashes on
// Windows and wsl:<distribution>:<path> for folders reached through WSL.
fn claude_project_key(folder: &str, distribution: Option<&str>) -> String {
    let normal = folder.replace('\\', "/");
    let normal = normal.trim_end_matches('/');
    let key = if distribution.is_none() {
        normal
            .strip_prefix("//wsl.localhost/")
            .or_else(|| normal.strip_prefix("//wsl$/"))
            .and_then(|rest| rest.split_once('/'))
            .map(|(distro, path)| format!("wsl:{}:/{}", distro.to_lowercase(), path))
            .unwrap_or_else(|| normal.to_string())
    } else {
        normal.to_string()
    };
    key.to_lowercase()
}
fn valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "agent_studio"
        && !name.chars().any(char::is_control)
}
/// User-scope servers plus the selected folder's local-scope servers, definitions only. Every
/// other key of the file, including MCP sign-in state, is never read into the result.
fn claude_mcp_servers(
    file: &Path,
    folder: &str,
    distribution: Option<&str>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut result = serde_json::Map::new();
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(result);
    };
    if meta.len() > 8_000_000 {
        return Err("Shared MCP configuration exceeds the size limit".into());
    }
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(file).map_err(|_| "Cannot read shared MCP configuration")?,
    )
    .map_err(|_| "Shared MCP configuration is malformed")?;
    let key = claude_project_key(folder, distribution);
    let local = config["projects"]
        .as_object()
        .into_iter()
        .flat_map(|projects| projects.iter())
        .find(|(path, _)| claude_project_key(path, distribution) == key)
        .map(|(_, project)| &project["mcpServers"]);
    for scope in [Some(&config["mcpServers"]), local].into_iter().flatten() {
        for (name, definition) in scope.as_object().into_iter().flat_map(|m| m.iter()) {
            if valid_server_name(name) && definition.is_object() {
                result.insert(name.clone(), definition.clone());
            }
        }
    }
    if result.len() > 64 || serde_json::to_string(&result).map_or(0, |s| s.len()) > MCP_LAUNCH_LIMIT
    {
        return Err("Shared MCP configuration exceeds the launch limit. Remove servers from the source account or choose This account only.".into());
    }
    Ok(result)
}
fn bare_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
fn toml_literal(value: &toml::Value) -> String {
    match value {
        toml::Value::String(s) => {
            let mut out = String::from("\"");
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
            out
        }
        toml::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(toml_literal)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        toml::Value::Table(table) => format!(
            "{{ {} }}",
            table
                .iter()
                .map(|(k, v)| format!(
                    "{} = {}",
                    if bare_key(k) {
                        k.clone()
                    } else {
                        toml_literal(&toml::Value::String(k.clone()))
                    },
                    toml_literal(v)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => other.to_string(),
    }
}
fn flatten_overrides(prefix: &str, value: &toml::Value, out: &mut Vec<String>) {
    match value {
        toml::Value::Table(table) => {
            for (key, inner) in table {
                if bare_key(key) {
                    flatten_overrides(&format!("{prefix}.{key}"), inner, out);
                }
            }
        }
        leaf => out.push(format!("{prefix}={}", toml_literal(leaf))),
    }
}
/// Codex mcp_servers tables flattened into -c launch overrides, definitions only.
fn codex_mcp_overrides(file: &Path) -> Result<Vec<String>, String> {
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(Vec::new());
    };
    if meta.len() > 1_000_000 {
        return Err("Shared MCP configuration exceeds the size limit".into());
    }
    let text = std::fs::read_to_string(file).map_err(|_| "Cannot read shared MCP configuration")?;
    let config: toml::Value =
        toml::from_str(&text).map_err(|_| "Shared MCP configuration is malformed")?;
    let mut out = Vec::new();
    if let Some(servers) = config.get("mcp_servers").and_then(toml::Value::as_table) {
        for (name, table) in servers {
            if bare_key(name) && valid_server_name(name) && table.is_table() {
                flatten_overrides(&format!("mcp_servers.{name}"), table, &mut out);
            }
        }
    }
    if out.len() > 512 || out.iter().map(String::len).sum::<usize>() > MCP_LAUNCH_LIMIT {
        return Err("Shared MCP configuration exceeds the launch limit. Remove servers from the source account or choose This account only.".into());
    }
    Ok(out)
}

fn collect(
    provider: &str,
    folder: &str,
    config: &Path,
    distribution: Option<&str>,
    source: &str,
) -> Result<SharedContext, String> {
    let mut result = SharedContext {
        source: source.into(),
        ..Default::default()
    };
    let mut add = |path: PathBuf, kind: &str| -> Result<(), String> {
        if path.is_file() {
            if result.files.len() >= 128 {
                return Err("Shared context contains too many instruction sources".into());
            }
            result.files.push(Source {
                path: native_path(&path, distribution)?,
                kind: kind.into(),
            });
        }
        Ok(())
    };
    if provider == "codex" {
        let override_path = config.join("AGENTS.override.md");
        add(
            if override_path.is_file() {
                override_path
            } else {
                config.join("AGENTS.md")
            },
            "instructions",
        )?;
        for name in ["memory_summary.md", "MEMORY.md"] {
            add(config.join("memories").join(name), "memories")?;
        }
        if config.join("skills").is_dir() {
            result.skill_root = Some(native_path(&config.join("skills"), distribution)?);
        }
    } else if provider == "claude" {
        add(config.join("CLAUDE.md"), "instructions")?;
        let mut pending = vec![(config.join("rules"), 0)];
        let mut visits = 0;
        while let Some((dir, depth)) = pending.pop() {
            if !dir.is_dir() {
                continue;
            }
            for entry in
                std::fs::read_dir(dir).map_err(|_| "Cannot inspect shared instruction rules")?
            {
                visits += 1;
                if visits > 1000 {
                    return Err("Shared instruction rules exceed the discovery limit".into());
                }
                let entry = entry.map_err(|_| "Cannot inspect shared instruction rules")?;
                let kind = entry
                    .file_type()
                    .map_err(|_| "Cannot inspect shared instruction rules")?;
                if kind.is_dir() && depth < 4 {
                    pending.push((entry.path(), depth + 1));
                } else if kind.is_file() && entry.path().extension().is_some_and(|e| e == "md") {
                    add(entry.path(), "instructions")?;
                }
            }
        }
        // Native plugin directory discovery loads this profile's skills/ and commands/.
        if config.join("skills").is_dir() || config.join("commands").is_dir() {
            result.plugin_dir = Some(native_path(config, distribution)?);
        }
        let settings_path = config.join("settings.json");
        let settings: serde_json::Value = if settings_path.is_file() {
            if std::fs::metadata(&settings_path)
                .map_err(|_| "Cannot inspect shared memory settings")?
                .len()
                > 1_000_000
            {
                return Err("Shared memory settings exceed the size limit".into());
            }
            serde_json::from_slice(
                &std::fs::read(settings_path)
                    .map_err(|_| "Cannot inspect shared memory settings")?,
            )
            .map_err(|_| "Shared memory settings are malformed")?
        } else {
            serde_json::Value::Null
        };
        if settings["autoMemoryEnabled"] != false {
            let memory = if let Some(custom) = settings["autoMemoryDirectory"].as_str() {
                if custom.starts_with("~/") {
                    return Err("Use an absolute autoMemoryDirectory in the shared source account to share its custom memories".into());
                }
                if let Some(distribution) = distribution {
                    if !custom.starts_with('/') {
                        return Err("Shared memory directory must be absolute".into());
                    }
                    PathBuf::from(format!("\\\\wsl.localhost\\{distribution}"))
                        .join(custom.trim_start_matches('/'))
                } else {
                    let p = PathBuf::from(custom);
                    if !p.is_absolute() {
                        return Err("Shared memory directory must be absolute".into());
                    }
                    p
                }
            } else {
                let physical = if let Some(d) = distribution {
                    PathBuf::from(format!("\\\\wsl.localhost\\{d}"))
                        .join(folder.trim_start_matches('/'))
                } else {
                    PathBuf::from(folder)
                };
                let project = physical
                    .ancestors()
                    .find(|p| p.join(".git").exists())
                    .unwrap_or(&physical);
                let project = native_path(project, distribution)?;
                let key: String = project
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                    .collect();
                config.join("projects").join(key).join("memory")
            };
            add(memory.join("MEMORY.md"), "memories")?;
            result.memory_dir = Some(native_path(&memory, distribution)?);
        }
    }
    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_shared_mcp_takes_definitions_for_user_and_selected_project_scope_only() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join(".claude.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcpServers": {"linear": {"type": "http", "url": "https://example.test"}, "agent_studio": {"command": "never"}},
                "mcpOAuth": {"linear": {"accessToken": "must-never-appear"}},
                "projects": {
                    "D:/Unreal Projects/EmpireGame": {"mcpServers": {"unreal": {"command": "unreal-mcp"}}, "allowedTools": ["x"]},
                    "wsl:ubuntu:/home/v/olympus": {"mcpServers": {"olympus": {"command": "npx"}}}
                }
            })
            .to_string(),
        )
        .unwrap();
        let windows =
            claude_mcp_servers(&config, "D:\\Unreal Projects\\EmpireGame\\", None).unwrap();
        assert_eq!(windows.keys().collect::<Vec<_>>(), ["linear", "unreal"]);
        let wsl = claude_mcp_servers(&config, "\\\\wsl.localhost\\Ubuntu\\home\\v\\olympus", None)
            .unwrap();
        assert_eq!(wsl.keys().collect::<Vec<_>>(), ["linear", "olympus"]);
        let linux = claude_mcp_servers(&config, "/home/v/olympus", Some("Ubuntu")).unwrap();
        assert_eq!(linux.keys().collect::<Vec<_>>(), ["linear"]);
        assert!(!serde_json::to_string(&windows)
            .unwrap()
            .contains("must-never-appear"));
        assert!(
            claude_mcp_servers(&root.path().join("missing.json"), "C:/p", None)
                .unwrap()
                .is_empty()
        );
        let mut shared = SharedContext {
            mcp_servers: windows,
            ..Default::default()
        };
        shared.describe_mcp();
        let json = serde_json::to_string(&shared).unwrap();
        assert!(json.contains("\"linear\"") && !json.contains("example.test"));
        let digest = shared.mcp_digest;
        shared.mcp_servers.remove("unreal");
        shared.describe_mcp();
        assert_ne!(digest, shared.mcp_digest);
    }
    #[test]
    fn codex_shared_mcp_flattens_server_tables_into_launch_overrides() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config.toml");
        std::fs::write(
            &config,
            "model = \"gpt\"\n[mcp_servers.node_repl]\ncommand = \"node\"\nargs = [\"-e\", \"x\\\"y\"]\nstartup_timeout_sec = 30\n[mcp_servers.node_repl.env]\nKEY = \"v\\n2\"\n[mcp_servers.\"odd.name\"]\ncommand = \"skipped\"\n",
        )
        .unwrap();
        let overrides = codex_mcp_overrides(&config).unwrap();
        assert_eq!(
            overrides,
            [
                "mcp_servers.node_repl.args=[\"-e\", \"x\\\"y\"]",
                "mcp_servers.node_repl.command=\"node\"",
                "mcp_servers.node_repl.env.KEY=\"v\\n2\"",
                "mcp_servers.node_repl.startup_timeout_sec=30",
            ]
        );
        assert!(overrides
            .iter()
            .all(|o| !o.contains("model") && !o.contains("skipped")));
        let mut shared = SharedContext {
            codex_overrides: overrides,
            ..Default::default()
        };
        shared.describe_mcp();
        assert_eq!(shared.mcp_names, ["node_repl"]);
        assert!(!serde_json::to_string(&shared)
            .unwrap()
            .contains("node_repl.command"));
        assert!(codex_mcp_overrides(&root.path().join("missing.toml"))
            .unwrap()
            .is_empty());
    }
    fn file(root: &Path, path: &str, contents: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    #[test]
    fn shares_metadata_and_native_skill_roots_without_configuration_or_credentials() {
        let root = tempfile::tempdir().unwrap();
        file(root.path(), "AGENTS.md", "shadowed");
        file(
            root.path(),
            "AGENTS.override.md",
            "private instruction body",
        );
        file(root.path(), "memories/MEMORY.md", "private memory body");
        file(root.path(), "skills/example/SKILL.md", "skill body");
        file(root.path(), "auth.json", "must-never-appear");
        file(root.path(), "config.toml", "must-never-appear");
        let result = collect(
            "codex",
            root.path().to_str().unwrap(),
            root.path(),
            None,
            "source",
        )
        .unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result
            .files
            .iter()
            .any(|f| f.path.ends_with("AGENTS.override.md")));
        let json = serde_json::to_string(&result).unwrap();
        assert!(
            !json.contains("private")
                && !json.contains("must-never")
                && !json.contains("auth.json")
                && !json.contains("config.toml")
        );
        let mut runtime = crate::plugins::Runtime::default();
        result.extend_runtime(&mut runtime);
        result.extend_runtime(&mut runtime);
        assert_eq!(runtime.skill_roots.len(), 1);
        assert!(runtime.plugin_dirs.is_empty());
    }
    #[test]
    fn claude_memory_uses_shared_project_or_custom_directory_and_respects_disable() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        file(root.path(), "CLAUDE.md", "instructions");
        file(
            root.path(),
            "rules/conditional.md",
            "---\npaths: [src/**]\n---\nrule",
        );
        file(root.path(), "skills/example/SKILL.md", "skill");
        let result = collect(
            "claude",
            project.to_str().unwrap(),
            root.path(),
            None,
            "source",
        )
        .unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.memory_dir.unwrap().contains("projects"));
        assert!(result.plugin_dir.is_some());
        let custom = root.path().join("shared-memory");
        file(
            root.path(),
            "settings.json",
            &serde_json::json!({"autoMemoryDirectory":custom}).to_string(),
        );
        let result = collect(
            "claude",
            project.to_str().unwrap(),
            root.path(),
            None,
            "source",
        )
        .unwrap();
        assert_eq!(result.memory_dir.as_deref(), custom.to_str());
        file(
            root.path(),
            "settings.json",
            "{\"autoMemoryEnabled\":false}",
        );
        assert!(collect(
            "claude",
            project.to_str().unwrap(),
            root.path(),
            None,
            "source"
        )
        .unwrap()
        .memory_dir
        .is_none());
    }
    #[test]
    fn wsl_paths_stay_on_the_selected_distribution() {
        assert_eq!(
            native_path(
                Path::new(r"\\wsl.localhost\Ubuntu\home\user\context"),
                Some("Ubuntu")
            )
            .unwrap(),
            "/home/user/context"
        );
        assert!(native_path(
            Path::new(r"\\wsl.localhost\Other\home\user"),
            Some("Ubuntu")
        )
        .is_err());
    }
}
