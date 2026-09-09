//! Local installation identity and per-connection CLI configuration. Never read credentials.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, path::PathBuf};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub computer_id: String,
    pub name: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
}
pub fn installation(app: &tauri::AppHandle) -> Result<Installation, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create installation directory")?;
    let path = root.join("installation.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Installation>(&bytes)
            .map(|mut value| {
                // Older WSL installs predate distribution metadata; retain their stable identity.
                if let Some(distribution) = wsl_distribution() {
                    value.platform = "wsl".into();
                    value.distribution = Some(distribution);
                }
                value
            })
            .map_err(|_| {
                "Installation identity is unreadable; preserved without replacement".into()
            }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = Installation {
                id: uuid::Uuid::new_v4().to_string(),
                computer_id: uuid::Uuid::new_v4().to_string(),
                name: std::env::var("COMPUTERNAME")
                    .or_else(|_| std::env::var("HOSTNAME"))
                    .unwrap_or_else(|_| "My computer".into()),
                platform: if wsl_distribution().is_some() {
                    "wsl"
                } else {
                    std::env::consts::OS
                }
                .into(),
                distribution: wsl_distribution(),
            };
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|_| "Cannot save installation identity")?;
            use std::io::Write;
            file.write_all(
                &serde_json::to_vec(&value).map_err(|_| "Cannot encode installation identity")?,
            )
            .map_err(|_| "Cannot write installation identity")?;
            file.sync_all()
                .map_err(|_| "Cannot flush installation identity")?;
            Ok(value)
        }
        Err(_) => Err("Cannot read installation identity".into()),
    }
}
fn wsl_distribution() -> Option<String> {
    if cfg!(target_os = "linux") {
        std::env::var("WSL_DISTRO_NAME").ok()
    } else {
        None
    }
}
#[derive(Clone, Default)]
pub struct Profile {
    pub id: String,
    pub provider: String,
    pub root: Option<PathBuf>,
    pub distribution: Option<String>,
    pub namespace: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    pub isolated: bool,
}
tokio::task_local! { static CURRENT: Profile; }
pub fn current() -> Profile {
    CURRENT.try_with(Clone::clone).unwrap_or_default()
}
pub fn resolve(
    app: &tauri::AppHandle,
    provider: &str,
    connection_id: Option<&str>,
) -> Result<Profile, String> {
    let Some(id) = connection_id else {
        return Ok(Profile {
            namespace: app.config().identifier.clone(),
            ..Profile::default()
        });
    };
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid connection id")?;
    let local = installation(app)?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let workspace: Value = serde_json::from_slice(
        &std::fs::read(data.join("workspace.json"))
            .map_err(|_| "Save Connections before using an account")?,
    )
    .map_err(|_| "Cannot read connection registry")?;
    let connection = workspace["fleet"]["connections"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["id"] == id))
        .ok_or("Connection no longer exists")?;
    let distribution = if connection["environmentId"] == local.id {
        None
    } else {
        let environment = workspace["fleet"]["environments"]
            .as_array()
            .and_then(|list| list.iter().find(|e| e["id"] == connection["environmentId"]))
            .ok_or("Connection environment no longer exists")?;
        let distro = environment["distribution"]
            .as_str()
            .ok_or("Remote environment must use its relay host")?;
        if !cfg!(windows)
            || environment["platform"] != "wsl"
            || environment["discoveredOn"] != local.id
        {
            return Err(
                "This connection belongs to another computer; it must run through its relay host"
                    .into(),
            );
        }
        if !["codex", "claude"].contains(&provider) {
            return Err("WSL connections support Codex and Claude.".into());
        }
        Some(distro.to_string())
    };
    let account = workspace["fleet"]["accounts"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["id"] == connection["accountId"]))
        .ok_or("Account no longer exists")?;
    if account["provider"] != provider {
        return Err("Connection and provider do not match".into());
    }
    let root = match connection["profile"].as_str() {
        Some("existing") => None,
        Some("isolated") if ["claude", "codex"].contains(&provider) => {
            if distribution.is_some() {
                None
            } else {
                let path = data.join("profiles").join(provider).join(id);
                std::fs::create_dir_all(&path).map_err(|_| "Cannot prepare account profile")?;
                Some(path)
            }
        }
        _ => return Err("This provider does not support a separate account profile".into()),
    };
    Ok(Profile {
        id: id.into(),
        provider: provider.into(),
        root,
        distribution,
        namespace: app.config().identifier.clone(),
        isolated: connection["profile"] == "isolated",
    })
}
pub async fn scope<T>(profile: Profile, future: impl Future<Output = T>) -> T {
    CURRENT.scope(profile, future).await
}
pub fn configure(command: &mut tokio::process::Command, provider: &str) {
    let profile = current();
    if profile.provider != provider {
        return;
    }
    let Some(root) = profile.root else {
        return;
    };
    command.env(
        if profile.provider == "codex" {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        },
        root,
    );
    for name in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CODE_USE_MANTLE",
    ] {
        command.env_remove(name);
    }
    if profile.provider == "codex" {
        command.args(["-c", "cli_auth_credentials_store=\"file\""]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn concurrent_profile_scopes_do_not_cross_accounts_or_providers() {
        async fn check(id: &str, provider: &str, root: &str) {
            scope(
                Profile {
                    id: id.into(),
                    provider: provider.into(),
                    root: Some(PathBuf::from(root)),
                    ..Profile::default()
                },
                async {
                    tokio::task::yield_now().await;
                    let mut command = tokio::process::Command::new("synthetic-cli");
                    configure(&mut command, provider);
                    let env: std::collections::HashMap<_, _> = command
                        .as_std()
                        .get_envs()
                        .map(|(k, v)| {
                            (
                                k.to_string_lossy().to_string(),
                                v.map(|s| s.to_string_lossy().to_string()),
                            )
                        })
                        .collect();
                    let variable = if provider == "claude" {
                        "CLAUDE_CONFIG_DIR"
                    } else {
                        "CODEX_HOME"
                    };
                    assert_eq!(env.get(variable), Some(&Some(root.to_string())));
                    assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&None));
                    assert_eq!(env.get("CLAUDE_CODE_OAUTH_TOKEN"), Some(&None));
                    let mut other = tokio::process::Command::new("other-cli");
                    configure(&mut other, "gemini");
                    assert_eq!(other.as_std().get_envs().count(), 0);
                    assert_eq!(current().id, id);
                },
            )
            .await;
        }
        tokio::join!(
            check("personal", "claude", "profile-personal"),
            check("work", "claude", "profile-work"),
            check("codex", "codex", "profile-codex")
        );
        assert!(current().root.is_none());
    }
}
