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
}
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
        format!("The user selected shared account context for this conversation. Before working, read the shared instruction files below and follow their applicable instructions and imports, resolving relative references from each source file. These supplement project and conversation instructions. For relevant prior knowledge, consult the shared memory entrypoints and their task-relevant references. Keep learned memories in the selected shared memory location when the user authorizes saving them. Do not inspect other profile files, configuration or credentials. Recheck these sources on later replies when they may have changed. Shared sources (JSON): {}", serde_json::to_string(&self.files).unwrap())
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
    collect(
        provider,
        folder,
        &config,
        distribution.as_deref(),
        &source.id,
    )
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
