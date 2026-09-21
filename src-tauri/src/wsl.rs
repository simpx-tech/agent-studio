//! Read-only WSL inventory. Listing distributions never starts a Linux environment.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub id: String,
    pub name: String,
    pub running: Option<bool>,
}

#[derive(Debug, Default, Serialize)]
pub struct Discovery {
    pub distributions: Vec<Distribution>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Launch {
    pub distribution: String,
    pub namespace: String,
    pub job: String,
}
impl Launch {
    #[cfg(any(windows, test))]
    pub fn prefix(&self, provider: &str, binary: &str, profile: &str) -> Vec<String> {
        vec![
            "--distribution".into(),
            self.distribution.clone(),
            "--cd".into(),
            "~".into(),
            "--exec".into(),
            "bash".into(),
            "-lc".into(),
            embedded_script(&format!(
                "{}\n{}",
                include_str!("wsl-env.sh"),
                include_str!("wsl-launch.sh")
            )),
            "agent-studio".into(),
            self.namespace.clone(),
            profile.into(),
            self.job.clone(),
            provider.into(),
            binary.into(),
        ]
    }
    pub async fn cancel(&self) {
        #[cfg(windows)]
        {
            // Only our generated job marker is read. Never stop an entire WSL distribution.
            let script = embedded_script(include_str!("wsl-cancel.sh"));
            let mut command = tokio::process::Command::new("wsl.exe");
            command
                .args([
                    "--distribution",
                    &self.distribution,
                    "--exec",
                    "bash",
                    "-c",
                    &script,
                    "agent-studio",
                    &self.namespace,
                    &self.job,
                ])
                .creation_flags(0x08000000)
                .kill_on_drop(true);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await;
        }
    }
}

#[cfg(any(windows, test))]
pub fn distribution_id(host: uuid::Uuid, name: &str) -> String {
    uuid::Uuid::new_v5(&host, format!("wsl:{}", name.to_lowercase()).as_bytes()).to_string()
}

pub async fn resolve(
    provider: &str,
    distribution: &str,
) -> Result<crate::providers::Executable, String> {
    #[cfg(windows)]
    {
        if !["codex", "claude"].contains(&provider) {
            return Err("WSL connections support Codex and Claude.".into());
        }
        let installed = list(&["--list", "--quiet"]).await?.unwrap_or_default();
        let candidates: Vec<_> = installed
            .into_iter()
            .filter(|d| distribution == d)
            .collect();
        let profile = crate::profiles::current();
        for distro in candidates {
            let script = format!(
                "{}\ncommand -v -- \"$1\"",
                embedded_script(include_str!("wsl-env.sh"))
            );
            let mut command = tokio::process::Command::new("wsl.exe");
            command
                .args([
                    "--distribution",
                    &distro,
                    "--cd",
                    "~",
                    "--exec",
                    "bash",
                    "-lc",
                    &script,
                    "agent-studio",
                    provider,
                ])
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null());
            let output =
                tokio::time::timeout(std::time::Duration::from_secs(8), command.output()).await;
            let Ok(Ok(output)) = output else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !valid_linux_binary(&path) {
                continue;
            }
            let launch = Launch {
                distribution: distro,
                namespace: if profile.namespace.is_empty() {
                    "agent-studio".into()
                } else {
                    profile.namespace.clone()
                },
                job: uuid::Uuid::new_v4().to_string(),
            };
            let login = if profile.provider == provider && profile.isolated {
                profile.id.as_str()
            } else {
                "existing"
            };
            return Ok(crate::providers::Executable {
                provider: provider.into(),
                program: "wsl.exe".into(),
                prefix: launch.prefix(provider, &path, login),
                wsl: Some(launch),
            });
        }
        Err(format!(
            "{provider} CLI was not found in {}. Install its Linux CLI, then refresh Connections.",
            distribution
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = (provider, distribution);
        Err("WSL bridging is available from Windows.".into())
    }
}

#[cfg(any(windows, test))]
fn valid_linux_binary(path: &str) -> bool {
    path.starts_with('/')
        && !path.chars().any(char::is_control)
        && ![".exe", ".cmd", ".bat"]
            .iter()
            .any(|suffix| path.to_lowercase().ends_with(suffix))
        && !(path.starts_with("/mnt/") && path.as_bytes().get(6) == Some(&b'/'))
}

#[cfg(any(windows, test))]
fn names(bytes: &[u8]) -> Result<Vec<String>, String> {
    // wsl.exe emits UTF-16LE through redirected Windows pipes, often without a BOM.
    let utf16 =
        bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().skip(1).step_by(2).any(|b| *b == 0);
    let text = if utf16 {
        if !bytes.len().is_multiple_of(2) {
            return Err("WSL returned an incomplete distribution list. Refresh to retry.".into());
        }
        String::from_utf16(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|v| u16::from_le_bytes([v[0], v[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "WSL returned an unreadable distribution list.")?
    } else {
        String::from_utf8(bytes.to_vec())
            .map_err(|_| "WSL returned an unreadable distribution list.")?
    };
    let mut result = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let name = line.trim();
        if name.is_empty() {
            continue;
        }
        if name.chars().any(char::is_control) || name.chars().count() > 255 {
            return Err("WSL returned an invalid distribution name.".into());
        }
        if !result.iter().any(|n: &String| n.eq_ignore_ascii_case(name)) {
            result.push(name.to_string());
        }
    }
    Ok(result)
}

#[cfg(any(windows, test))]
fn inventory(
    host: uuid::Uuid,
    installed: Vec<String>,
    running: Option<Vec<String>>,
) -> Vec<Distribution> {
    installed
        .into_iter()
        .map(|name| Distribution {
            id: distribution_id(host, &name),
            running: running
                .as_ref()
                .map(|list| list.iter().any(|n| n.eq_ignore_ascii_case(&name))),
            name,
        })
        .collect()
}

#[cfg(windows)]
async fn list(args: &[&str]) -> Result<Option<Vec<String>>, String> {
    use std::{process::Stdio, time::Duration};
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "WSL discovery timed out. Refresh to retry.")?;
    let output = match output {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err("Cannot run WSL discovery. Check your Windows WSL installation.".into())
        }
        Ok(output) => output,
    };
    if !output.status.success() {
        return Err(
            "Windows could not list WSL distributions. Check WSL setup, then refresh.".into(),
        );
    }
    names(&output.stdout).map(Some)
}

pub async fn discover(environment_id: &str) -> Result<Discovery, String> {
    #[cfg(windows)]
    {
        let host = uuid::Uuid::parse_str(environment_id)
            .map_err(|_| "Invalid Windows environment identity")?;
        let Some(installed) = list(&["--list", "--quiet"]).await? else {
            return Ok(Discovery::default());
        };
        if installed.is_empty() {
            return Ok(Discovery::default());
        }
        let (running, warning) = match list(&["--list", "--running", "--quiet"]).await {
            Ok(Some(names)) => (Some(names), None),
            Ok(None) => (
                None,
                Some("WSL availability could not be checked. Refresh to retry.".into()),
            ),
            Err(error) => (None, Some(error)),
        };
        Ok(Discovery {
            distributions: inventory(host, installed, running),
            warning,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = environment_id;
        Ok(Discovery::default())
    }
}

/// Embedded shell scripts run inside Linux, so they must keep LF endings even when a Windows
/// checkout rewrote the source files to CRLF before compilation; bash rejects `\r` with exit 2.
pub(crate) fn embedded_script(source: &str) -> String {
    source.replace("\r\n", "\n")
}
/// Inventory checks PATH inside one distribution, without authentication or Windows fallback.
pub async fn installations(
    distribution: &str,
) -> Result<Vec<crate::providers::CliInstallation>, String> {
    #[cfg(windows)]
    {
        let script = embedded_script(&format!(
            "{}\n{}",
            include_str!("wsl-env.sh"),
            include_str!("wsl-inventory.sh")
        ));
        let mut command = tokio::process::Command::new("wsl.exe");
        command
            .args([
                "--distribution",
                distribution,
                "--cd",
                "~",
                "--exec",
                "bash",
                "-lc",
                &script,
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null());
        let output = tokio::time::timeout(std::time::Duration::from_secs(12), command.output())
            .await
            .map_err(|_| "WSL CLI inspection timed out. Refresh to retry.")?
            .map_err(|_| "Could not inspect CLIs in this WSL distribution.")?;
        if !output.status.success() {
            return Err("WSL CLI inspection failed. Check that the distribution is available, then refresh.".into());
        }
        parse_installations(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(not(windows))]
    {
        let _ = distribution;
        Err("WSL inspection is available from Windows.".into())
    }
}
#[cfg(any(windows, test))]
fn parse_installations(text: &str) -> Result<Vec<crate::providers::CliInstallation>, String> {
    ["codex", "claude", "gemini"]
        .into_iter()
        .map(|id| {
            let prefix = format!("agent-studio-cli\t{id}\t");
            let matches: Vec<_> = text
                .lines()
                .filter_map(|line| line.strip_prefix(&prefix))
                .collect();
            if matches.len() != 1 {
                return Err("WSL returned an incomplete CLI inventory. Refresh to retry.".into());
            }
            let path = matches[0];
            Ok(crate::providers::CliInstallation {
                id: id.into(),
                path: valid_linux_binary(path).then(|| path.to_string()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_shell_scripts_reach_linux_with_lf_endings() {
        assert_eq!(embedded_script("a\r\nb\r\n"), "a\nb\n");
        let names = [
            "wsl-env.sh",
            "wsl-inventory.sh",
            "wsl-launch.sh",
            "wsl-cancel.sh",
            "folders-wsl.sh",
            "folders-windows-path.sh",
        ];
        for (name, source) in names.iter().zip([
            include_str!("wsl-env.sh"),
            include_str!("wsl-inventory.sh"),
            include_str!("wsl-launch.sh"),
            include_str!("wsl-cancel.sh"),
            include_str!("folders-wsl.sh"),
            include_str!("folders-windows-path.sh"),
        ]) {
            assert!(!embedded_script(source).contains('\r'), "{name}");
            // The repository pins these files to LF so every checkout embeds them unchanged.
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(name);
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                !bytes.contains(&b'\r'),
                "{name} must use LF line endings; renormalize the checkout (see .gitattributes)"
            );
        }
    }
    #[test]
    fn installation_inventory_excludes_windows_shims_and_requires_all_results() {
        let values = parse_installations("profile noise\nagent-studio-cli\tcodex\t/home/test/.local/bin/codex\nagent-studio-cli\tclaude\t/mnt/c/Users/test/claude\nagent-studio-cli\tgemini\t\n").unwrap();
        assert_eq!(
            values[0].path.as_deref(),
            Some("/home/test/.local/bin/codex")
        );
        assert!(values[1].path.is_none());
        assert!(values[2].path.is_none());
        assert!(parse_installations("agent-studio-cli\tcodex\t/bin/codex\n").is_err());
        assert!(parse_installations("unavailable distribution").is_err());
    }
    #[test]
    fn bridge_arguments_are_data_and_windows_shims_are_rejected() {
        assert!(valid_linux_binary("/home/test/.local/bin/claude"));
        assert!(!valid_linux_binary("/mnt/c/Program Files/nodejs/codex"));
        assert!(!valid_linux_binary("/home/test/claude.exe"));
        assert!(!valid_linux_binary("/bin/claude\nextra"));
        let launch = Launch {
            distribution: "Ubuntu ' $(literal)".into(),
            namespace: "agent-studio-test".into(),
            job: uuid::Uuid::new_v4().to_string(),
        };
        let prefix = launch.prefix("claude", "/home/test/CLI with spaces/claude", "existing");
        assert_eq!(prefix[1], "Ubuntu ' $(literal)");
        assert!(!prefix[7].contains("Ubuntu ' $(literal)"));
        assert_eq!(prefix.last().unwrap(), "/home/test/CLI with spaces/claude");
    }
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in integration test against an installed WSL distribution; no provider prompts"]
    async fn real_wsl_bridge_preserves_stdin_isolates_profiles_and_kills_descendants() {
        use crate::providers::Executable;
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let distro = list(&["--list", "--quiet"])
            .await
            .unwrap()
            .unwrap()
            .into_iter()
            .next()
            .expect("Install a WSL distribution first");
        let namespace = format!("agent-studio-bridge-test-{}", uuid::Uuid::new_v4());
        let make = |profile: &str| {
            let launch = Launch {
                distribution: distro.clone(),
                namespace: namespace.clone(),
                job: uuid::Uuid::new_v4().to_string(),
            };
            Executable {
                provider: "claude".into(),
                program: "wsl.exe".into(),
                prefix: launch.prefix("claude", "/bin/bash", profile),
                wsl: Some(launch),
            }
        };
        let profile = uuid::Uuid::new_v4().to_string();
        let exe = make(&profile);
        let mut child = exe.command().args(["-c", r#"IFS= read -r value; printf '%s\n' "$value"; printf '%s\n' "$CLAUDE_CONFIG_DIR"; test -z "${ANTHROPIC_API_KEY-}""#])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let payload = "Literal $(do-not-run) `text` & quotes ' \" 日本語\n";
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .await
            .unwrap();
        let output = child.wait_with_output().await.unwrap();
        assert!(
            output.status.success(),
            "WSL fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.starts_with(payload));
        assert!(text.contains(&format!("/{namespace}/profiles/claude/{profile}")));
        // Per-chat Linux cwd is selected by a validated ID, independently of the login profile.
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let mut first_cwd = String::new();
        for (id, script) in [
            (
                &a,
                "printf '%s' retained > only-a.txt; printf '%s' \"$PWD\"",
            ),
            (&b, "test ! -e only-a.txt; printf '%s' \"$PWD\""),
            (
                &a,
                "test \"$(cat only-a.txt)\" = retained; printf '%s' \"$PWD\"",
            ),
        ] {
            let output = make("existing")
                .command()
                .args(["--agent-studio-standalone", id, "-c", script])
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let cwd = String::from_utf8(output.stdout).unwrap();
            assert!(cwd.ends_with(&format!("/{namespace}/standalone/{id}")));
            if id == &a {
                if first_cwd.is_empty() {
                    first_cwd = cwd;
                } else {
                    assert_eq!(cwd, first_cwd);
                }
            } else {
                assert_ne!(cwd, first_cwd);
            }
        }
        let rejected = make("existing")
            .command()
            .args([
                "--agent-studio-standalone",
                "../escape",
                "-c",
                "echo should-not-run",
            ])
            .output()
            .await
            .unwrap();
        assert!(!rejected.status.success());
        assert!(rejected.stdout.is_empty());
        // Exercise the real directory change with literal shell characters and
        // prove an unavailable folder fails before the provider is started.
        let project = format!("/tmp/{namespace}/Project 'quoted' $(literal) 日本語");
        let output = make("existing")
            .command()
            .args(["-c", "mkdir -p -- \"$1\"", "fixture", &project])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let mut command = make("existing").command();
        let output = command
            .args(["--agent-studio-cwd", &project, "-c", "printf '%s' \"$PWD\""])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), project);
        for folder in [format!("{project}/missing"), "relative/path".into()] {
            let output = make("existing")
                .command()
                .args(["--agent-studio-cwd", &folder, "-c", "echo should-not-run"])
                .output()
                .await
                .unwrap();
            assert!(!output.status.success());
            assert!(!String::from_utf8_lossy(&output.stdout).contains("should-not-run"));
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("Selected folder is unavailable")
            );
        }
        let output = make("existing")
            .command()
            .args(["-c", "rmdir -- \"$1\" \"${1%/*}\"", "cleanup", &project])
            .output()
            .await
            .unwrap();
        assert!(output.status.success());
        let exe = make("existing");
        let mut child = exe
            .command()
            .args([
                "-c",
                "sleep 120 & descendant=$!; printf '%s %s\\n' \"$BASHPID\" \"$descendant\"; wait",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let pids = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        exe.kill(&mut child).await;
        for pid in pids.split_whitespace() {
            assert!(pid.chars().all(|c| c.is_ascii_digit()));
            let mut verify = tokio::process::Command::new("wsl.exe");
            let output = verify
                .args([
                    "-d",
                    &distro,
                    "--exec",
                    "bash",
                    "-c",
                    "! kill -0 -- \"$1\" 2>/dev/null || grep -q '^State:.*Z' \"/proc/$1/status\"",
                    "check",
                    pid,
                ])
                .creation_flags(0x08000000)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "WSL descendant survived cancellation"
            );
        }
        // Early Stop must be respected even before the Linux wrapper creates its PID marker.
        let exe = make("existing");
        exe.wsl.as_ref().unwrap().cancel().await;
        let output = exe
            .command()
            .args(["-c", "echo should-not-run"])
            .output()
            .await
            .unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("should-not-run"));
        let mut cleanup = tokio::process::Command::new("wsl.exe");
        cleanup.args(["-d", &distro, "--exec", "bash", "-c", "case \"$1\" in agent-studio-bridge-test-*) rm -rf -- \"$HOME/.local/share/$1\";; *) exit 1;; esac", "cleanup", &namespace]).creation_flags(0x08000000);
        assert!(cleanup.status().await.unwrap().success());
    }
    #[test]
    fn decodes_windows_pipes_and_utf8_without_parsing_localized_status_columns() {
        let text = "\u{feff}Ubuntu\r\nDebian\r\nUbuntu\r\n\r\n";
        let bytes: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(names(&bytes).unwrap(), ["Ubuntu", "Debian"]);
        assert_eq!(names(b"Ubuntu\nDebian\n").unwrap(), ["Ubuntu", "Debian"]);
        assert!(names(&[b'U', 0, b'b']).is_err());
        assert!(names(b"Ubuntu\x01").is_err());
        assert!(names(b"\r\n").unwrap().is_empty());
    }
    #[test]
    fn identities_are_stable_per_host_and_unknown_is_not_stopped() {
        let host = uuid::Uuid::new_v4();
        let first = inventory(
            host,
            vec!["Ubuntu".into(), "Debian".into()],
            Some(vec!["Ubuntu".into()]),
        );
        let second = inventory(host, vec!["ubuntu".into()], None);
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(first[0].running, Some(true));
        assert_eq!(first[1].running, Some(false));
        assert_eq!(second[0].running, None);
        assert_ne!(
            first[0].id,
            inventory(uuid::Uuid::new_v4(), vec!["Ubuntu".into()], None)[0].id
        );
    }
}
