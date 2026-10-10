//! Runs one action of a screen where the screen runs: PowerShell or Git Bash on Windows, bash
//! inside a WSL distribution this computer manages, bash on macOS and Linux. The script and the
//! values are data: the script reaches its shell from a file or from stdin, each value from an
//! environment variable of its own, and the commands around them are constants.
use super::{Action, Shell, Site};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

/// How long output may keep arriving after an action ended, from what it left running.
const DRAIN: Duration = Duration::from_secs(2);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// None when the action was stopped, at its time limit or by a signal.
    pub exit_code: Option<i32>,
    /// Each stream whole.
    pub stdout: String,
    pub stderr: String,
    /// Always false: the screen receives everything the action printed.
    pub truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Variables of an agent's session or of this app's own launches, which an action never sees.
const OWN_VARIABLES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID",
    "AGENT_STUDIO_CONSOLE",
    "AGENT_STUDIO_FOLDER",
];

/// Whether a screen's site runs this shell, so a chat hears it when it saves the screen.
pub(super) fn available(site: &Site, shell: Shell) -> Result<(), String> {
    if let Some(distribution) = &site.distribution {
        return match shell {
            Shell::Bash => Ok(()),
            Shell::Powershell => Err(format!(
                "This chat runs in the WSL distribution {distribution}, where actions use bash."
            )),
        };
    }
    match shell {
        Shell::Powershell if cfg!(windows) => Ok(()),
        Shell::Powershell => {
            Err("PowerShell actions run on Windows; actions on this computer use bash.".into())
        }
        Shell::Bash => {
            #[cfg(windows)]
            if crate::console::installed_git_bash().is_none() {
                return Err(
                    "Git Bash is not installed on this computer, so its actions use powershell."
                        .into(),
                );
            }
            Ok(())
        }
    }
}

/// Runs one checked action with its checked values and waits for it, within the time limit
/// it declares, if any.
pub(super) async fn execute(
    root: &Path,
    namespace: &str,
    site: &Site,
    action: &Action,
    variables: Vec<(String, String)>,
) -> Result<Outcome, String> {
    available(site, action.shell)?;
    let limit = action.timeout.map(Duration::from_secs);
    let started = Instant::now();
    if let Some(distribution) = &site.distribution {
        #[cfg(windows)]
        return distribution::execute(
            namespace,
            distribution,
            &site.folder,
            action,
            &variables,
            limit,
            started,
        )
        .await;
        #[cfg(not(windows))]
        {
            let _ = (namespace, distribution);
            return Err("A WSL screen runs its actions from its Windows computer.".into());
        }
    }
    native(root, site, action, variables, limit, started).await
}

/// Starts bash in a login shell, as an agent runs its commands, then runs the script from its
/// file in the screen's folder. A profile may change folder, so the shell returns to it first.
const BASH: &str = r#"studio_folder=$1
studio_script=$2
if ! cd -- "$studio_folder" 2>/dev/null; then
  printf 'Agent Studio did not run this action: its folder is unavailable.\n' >&2
  exit 126
fi
unset studio_folder
exec "$BASH" -- "$studio_script""#;

/// Runs in PowerShell as its command: output as UTF-8 without progress or colors, the user's
/// current PATH, then the script, read from the file this process's variable names and deleted
/// before it runs. The script becomes a function named after the action, so its errors name the
/// action and their lines, and it runs as a script block, which no execution policy refuses. It
/// ends with its own `exit`, or with the exit code of the last program it ran. The command line
/// carries this constant without double quotes, which Windows would read as its own.
#[cfg(windows)]
const POWERSHELL: &str = r#"$ProgressPreference = 'SilentlyContinue'
$studioUtf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $studioUtf8 } catch {}
$OutputEncoding = $studioUtf8
if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }
$studioPath = New-Object 'System.Collections.Generic.List[string]'
foreach ($studioEntry in ((@($env:Path, [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine')) -join ';') -split ';')) {
  if ($studioEntry -and -not $studioPath.Contains($studioEntry)) { $studioPath.Add($studioEntry) }
}
$env:Path = $studioPath -join ';'
$studioFile = $env:AGENT_STUDIO_SCREEN_SCRIPT
$studioName = $env:AGENT_STUDIO_SCREEN_ACTION
Remove-Item Env:AGENT_STUDIO_SCREEN_SCRIPT, Env:AGENT_STUDIO_SCREEN_ACTION -ErrorAction SilentlyContinue
try { $studioCode = [IO.File]::ReadAllText($studioFile, $studioUtf8) } catch {
  [Console]::Error.WriteLine('Agent Studio could not read this action.')
  exit 125
}
Remove-Item -LiteralPath $studioFile -ErrorAction SilentlyContinue
$studioTokens = $null
$studioErrors = $null
$studioAst = [System.Management.Automation.Language.Parser]::ParseInput($studioCode, $studioName, [ref]$studioTokens, [ref]$studioErrors)
if ($studioErrors.Count) {
  foreach ($studioError in $studioErrors) { [Console]::Error.WriteLine($studioError.ToString()) }
  exit 1
}
$studioAction = New-Item -Path function: -Name $studioName -Value $studioAst.GetScriptBlock() -Force
Remove-Variable studioFile, studioName, studioEntry, studioPath, studioUtf8, studioCode, studioTokens, studioErrors, studioAst -ErrorAction SilentlyContinue
$global:LASTEXITCODE = 0
& $studioAction
exit $LASTEXITCODE"#;

/// Scripts a run left behind, such as after a crash, go with a run a day later.
fn prune(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Keeps the script in a private file of this run, which its shell reads.
fn keep(root: &Path, action: &Action) -> Result<PathBuf, String> {
    let folder = root.join("runs");
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot prepare this action")?;
    prune(&folder);
    let extension = match action.shell {
        Shell::Powershell => "ps1",
        Shell::Bash => "sh",
    };
    let path = folder.join(format!("{}.{extension}", uuid::Uuid::new_v4()));
    std::fs::write(&path, action.script.as_bytes()).map_err(|_| "Cannot prepare this action")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot prepare this action")?;
    }
    Ok(path)
}

#[cfg(windows)]
fn shell_command(
    action: &Action,
    folder: &Path,
    script: &Path,
) -> Result<tokio::process::Command, String> {
    Ok(match action.shell {
        Shell::Powershell => {
            let powershell =
                crate::console::installed_powershell().ok_or("Cannot locate PowerShell")?;
            let mut command = tokio::process::Command::new(powershell);
            // Not -EncodedCommand: with it, Windows PowerShell writes errors and progress to a
            // redirected stderr as CLIXML.
            command
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    POWERSHELL,
                ])
                .env("AGENT_STUDIO_SCREEN_SCRIPT", script)
                .env("AGENT_STUDIO_SCREEN_ACTION", &action.name);
            command
        }
        Shell::Bash => {
            let bash = crate::console::installed_git_bash()
                .ok_or("Git Bash is not installed on this computer.")?;
            let slashes = |path: &Path| path.to_string_lossy().replace('\\', "/");
            let mut command = tokio::process::Command::new(bash);
            command
                .args(["-l", "-c", BASH, "agent-studio"])
                .arg(slashes(folder))
                .arg(slashes(script))
                // Git Bash's profile keeps the folder it starts in.
                .env("CHERE_INVOKING", "1");
            command
        }
    })
}

#[cfg(not(windows))]
fn shell_command(
    action: &Action,
    folder: &Path,
    script: &Path,
) -> Result<tokio::process::Command, String> {
    if action.shell != Shell::Bash {
        return Err("PowerShell actions run on Windows.".into());
    }
    let mut command = tokio::process::Command::new("bash");
    command
        .args(["-l", "-c", BASH, "agent-studio"])
        .arg(folder)
        .arg(script);
    Ok(command)
}

async fn native(
    root: &Path,
    site: &Site,
    action: &Action,
    variables: Vec<(String, String)>,
    limit: Option<Duration>,
    started: Instant,
) -> Result<Outcome, String> {
    let folder = PathBuf::from(&site.folder);
    let prepared = {
        let (root, folder, action) = (root.to_path_buf(), folder.clone(), action.clone());
        tauri::async_runtime::spawn_blocking(move || {
            if !folder.is_dir() {
                return Err(format!(
                    "This screen's folder is unavailable: {}",
                    folder.to_string_lossy()
                ));
            }
            keep(&root, &action)
        })
        .await
        .map_err(|_| "Cannot prepare this action".to_string())??
    };
    let script = prepared;
    let started_child = shell_command(action, &folder, &script).and_then(|mut command| {
        command
            .current_dir(&folder)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("NO_COLOR", "1");
        for name in OWN_VARIABLES {
            command.env_remove(name);
        }
        command.envs(variables);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        #[cfg(unix)]
        command.process_group(0);
        command
            .spawn()
            .map_err(|_| "Could not start this action's shell.".to_string())
    });
    let outcome = match started_child {
        Ok(mut child) => {
            let collected = collect(&mut child, limit).await;
            if collected.timed_out || !collected.drained {
                // Whatever it left running goes with it.
                crate::runner::kill_tree(&mut child).await;
            }
            Ok(collected.outcome(started))
        }
        Err(error) => Err(error),
    };
    let _ = std::fs::remove_file(&script);
    outcome
}

struct Collected {
    status: Option<std::process::ExitStatus>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    /// Both streams ended: nothing the action started still holds them.
    drained: bool,
}
impl Collected {
    fn outcome(self, started: Instant) -> Outcome {
        Outcome {
            exit_code: self.status.and_then(|status| status.code()),
            stdout: String::from_utf8_lossy(&self.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&self.stderr).into_owned(),
            truncated: false,
            timed_out: self.timed_out,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        }
    }
}

async fn read_all(pipe: Option<impl AsyncRead + Unpin>, kept: &mut Vec<u8>) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => kept.extend_from_slice(&buffer[..read]),
        }
    }
}

/// Reads both streams while the action runs, until it ends and they close or its time, when it
/// declares one, is up.
async fn collect(child: &mut tokio::process::Child, limit: Option<Duration>) -> Collected {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut status = None;
    let mut exited = false;
    let mut timed_out = false;
    let (mut out_done, mut err_done) = (false, false);
    {
        let reading_out = read_all(child.stdout.take(), &mut stdout);
        let reading_err = read_all(child.stderr.take(), &mut stderr);
        tokio::pin!(reading_out, reading_err);
        let deadline = async {
            match limit {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(deadline);
        // Polled only once the action exited, which sets it.
        let drain = tokio::time::sleep(DRAIN);
        tokio::pin!(drain);
        while !(exited && out_done && err_done) {
            tokio::select! {
                _ = &mut reading_out, if !out_done => out_done = true,
                _ = &mut reading_err, if !err_done => err_done = true,
                result = child.wait(), if !exited => {
                    exited = true;
                    status = result.ok();
                    drain.as_mut().reset(tokio::time::Instant::now() + DRAIN);
                }
                _ = &mut deadline, if !exited => {
                    timed_out = true;
                    break;
                }
                _ = &mut drain, if exited => break,
            }
        }
    }
    Collected {
        status,
        stdout,
        stderr,
        timed_out,
        drained: out_done && err_done,
    }
}

#[cfg(windows)]
mod distribution {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tokio::io::AsyncWriteExt;

    /// How much longer than the host's own limit the distribution lets an action run, should
    /// the host be gone before it stops it.
    const BACKSTOP: u64 = 10;

    /// What the fixed script reads on stdin: one line each of base64 or digits. The limit line
    /// is 0 for an action without a time limit, which the distribution then never stops itself.
    fn input(
        folder: &str,
        action: &Action,
        variables: &[(String, String)],
        limit: Option<Duration>,
    ) -> String {
        let mut lines = vec![
            STANDARD.encode(folder),
            STANDARD.encode(&action.script),
            limit
                .map_or(0, |limit| limit.as_secs().saturating_add(BACKSTOP))
                .to_string(),
            variables.len().to_string(),
        ];
        for (name, value) in variables {
            lines.push(name.clone());
            lines.push(STANDARD.encode(value));
        }
        lines.join("\n") + "\n"
    }

    pub(super) async fn execute(
        namespace: &str,
        distribution: &str,
        folder: &str,
        action: &Action,
        variables: &[(String, String)],
        limit: Option<Duration>,
        started: Instant,
    ) -> Result<Outcome, String> {
        // wsl.exe reads its own options as written, so the name goes there bare.
        if distribution.is_empty()
            || !distribution
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err(format!(
                "Cannot run an action in a distribution named {distribution}."
            ));
        }
        let job = format!("screen-{}", uuid::Uuid::new_v4());
        let launcher = crate::wsl::embedded_script(&format!(
            "{}\n{}",
            include_str!("../wsl-env.sh"),
            include_str!("../screen-run.sh")
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
                "-c",
                &launcher,
                "agent-studio",
                namespace,
                &job,
            ])
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in OWN_VARIABLES {
            command.env_remove(name);
        }
        let mut child = command
            .spawn()
            .map_err(|_| format!("Could not start the action in {distribution}."))?;
        let sent = match child.stdin.take() {
            Some(mut stdin) => {
                let written = stdin
                    .write_all(input(folder, action, variables, limit).as_bytes())
                    .await;
                drop(stdin);
                written.is_ok()
            }
            None => false,
        };
        if !sent {
            crate::runner::kill_tree(&mut child).await;
            return Err(format!("Could not send the action to {distribution}."));
        }
        let collected = collect(&mut child, limit).await;
        if collected.timed_out || !collected.drained {
            crate::wsl::Launch {
                distribution: distribution.into(),
                namespace: namespace.into(),
                job,
                shared: false,
            }
            .cancel()
            .await;
            crate::runner::kill_tree(&mut child).await;
        }
        Ok(collected.outcome(started))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn the_distribution_reads_everything_as_lines_of_data() {
            let action = Action {
                name: "list".into(),
                description: String::new(),
                shell: Shell::Bash,
                script: "echo \"$PARAM_QUERY\"\nls".into(),
                params: Default::default(),
                timeout: Some(30),
            };
            let text = input(
                "/home/me/it's here",
                &action,
                &[("PARAM_QUERY".into(), "a\nb $(x)".into())],
                Some(Duration::from_secs(30)),
            );
            let lines: Vec<_> = text.lines().collect();
            assert_eq!(lines.len(), 6);
            assert_eq!(STANDARD.decode(lines[0]).unwrap(), b"/home/me/it's here");
            assert_eq!(STANDARD.decode(lines[1]).unwrap(), action.script.as_bytes());
            assert_eq!(lines[2], "40");
            assert_eq!(lines[3], "1");
            assert_eq!(lines[4], "PARAM_QUERY");
            assert_eq!(STANDARD.decode(lines[5]).unwrap(), b"a\nb $(x)");
            assert!(text.ends_with('\n'));
            // Without a time limit the distribution leaves the action to end by itself.
            let unlimited = input("/tmp", &action, &[], None);
            assert_eq!(unlimited.lines().nth(2), Some("0"));
        }

        fn first_distribution() -> String {
            use std::os::windows::process::CommandExt;
            let listed = std::process::Command::new("wsl.exe")
                .args(["--list", "--quiet"])
                .creation_flags(0x08000000)
                .output()
                .unwrap()
                .stdout;
            let listed: Vec<u16> = listed
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            String::from_utf16_lossy(&listed)
                .lines()
                .map(str::trim)
                .find(|name| !name.is_empty())
                .expect("Install a WSL distribution first")
                .to_string()
        }

        #[tokio::test]
        #[ignore = "Opt-in: runs real actions in the first WSL distribution"]
        async fn a_real_wsl_action_runs_in_its_folder_and_stops_at_its_limit() {
            let distribution = first_distribution();
            let action = |script: &str, timeout: u64| Action {
                name: "probe".into(),
                description: String::new(),
                shell: Shell::Bash,
                script: script.into(),
                params: Default::default(),
                timeout: Some(timeout),
            };
            let outcome = execute(
                "agent-studio-test",
                &distribution,
                "/tmp",
                &action(
                    "printf '%s|%s|%s' \"$PWD\" \"$PARAM_QUERY\" \"$PARAM_EMPTY\"\necho warned >&2\nexit 5",
                    60,
                ),
                &[
                    ("PARAM_QUERY".into(), "a 'b' \"c\" $(whoami); ñ\nline".into()),
                    ("PARAM_EMPTY".into(), String::new()),
                ],
                Some(Duration::from_secs(60)),
                Instant::now(),
            )
            .await
            .unwrap();
            assert_eq!(outcome.stdout, "/tmp|a 'b' \"c\" $(whoami); ñ\nline|");
            assert_eq!(outcome.stderr.trim(), "warned");
            assert_eq!(outcome.exit_code, Some(5));
            // A missing folder runs nothing.
            let missing = execute(
                "agent-studio-test",
                &distribution,
                "/nonexistent/agent-studio",
                &action("echo ran", 60),
                &[],
                Some(Duration::from_secs(60)),
                Instant::now(),
            )
            .await
            .unwrap();
            assert_eq!(missing.exit_code, Some(126));
            assert!(missing.stderr.contains("folder is unavailable"));
            assert!(!missing.stdout.contains("ran"));
            // Past its limit the action and what it started end, with what it printed so far.
            let marker = format!("agent-studio-test-{}", uuid::Uuid::new_v4());
            let slow = execute(
                "agent-studio-test",
                &distribution,
                "/tmp",
                &action(
                    &format!("echo started\nsleep 300 & echo $! > /tmp/{marker}\nwait"),
                    3,
                ),
                &[],
                Some(Duration::from_secs(3)),
                Instant::now(),
            )
            .await
            .unwrap();
            assert!(
                slow.timed_out && slow.stdout.contains("started"),
                "{slow:?}"
            );
            let inside = |script: &str| {
                use std::os::windows::process::CommandExt;
                let output = std::process::Command::new("wsl.exe")
                    .args([
                        "--distribution",
                        &distribution,
                        "--exec",
                        "bash",
                        "-c",
                        script,
                    ])
                    .creation_flags(0x08000000)
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&output.stdout).into_owned()
            };
            std::thread::sleep(std::time::Duration::from_secs(1));
            let alive = inside(&format!(
                "pid=$(cat /tmp/{marker}); rm -f /tmp/{marker}; kill -0 \"$pid\" 2>/dev/null && echo alive || echo gone"
            ));
            assert_eq!(alive.trim(), "gone");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(folder: &Path) -> Site {
        Site {
            environment_id: uuid::Uuid::new_v4().to_string(),
            distribution: None,
            folder: folder.to_string_lossy().into_owned(),
            project: String::new(),
        }
    }
    fn action(shell: Shell, script: &str, timeout: u64) -> Action {
        Action {
            name: "probe".into(),
            description: String::new(),
            shell,
            script: script.into(),
            params: Default::default(),
            timeout: Some(timeout),
        }
    }

    #[test]
    fn scripts_are_named_never_written_into_the_bootstrap() {
        assert!(BASH.contains("exec \"$BASH\" -- \"$studio_script\""));
        #[cfg(windows)]
        assert!(POWERSHELL.contains("ParseInput($studioCode, $studioName"));
        #[cfg(windows)]
        assert!(!POWERSHELL.contains('"'));
        let script = include_str!("../screen-run.sh");
        assert!(!script.contains('\r'));
        // Values are exported from data lines, never evaluated.
        assert!(script.contains("export \"$name=${value%x}\""));
        assert!(!script.contains("eval"));
    }

    #[test]
    fn a_wsl_screen_runs_bash_alone() {
        let mut wsl = site(Path::new("/home/me"));
        wsl.distribution = Some("Ubuntu".into());
        assert!(available(&wsl, Shell::Bash).is_ok());
        assert!(available(&wsl, Shell::Powershell)
            .unwrap_err()
            .contains("use bash"));
    }

    #[tokio::test]
    async fn an_unavailable_folder_runs_nothing() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("missing");
        let shell = if cfg!(windows) {
            Shell::Powershell
        } else {
            Shell::Bash
        };
        let error = execute(
            root.path(),
            "test",
            &site(&missing),
            &action(shell, "echo hi", 10),
            vec![],
        )
        .await
        .unwrap_err();
        assert!(error.contains("folder is unavailable"), "{error}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_runs_in_the_folder_with_values_as_variables() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Project 'quoted' & ñ");
        std::fs::create_dir(&folder).unwrap();
        let script = "$here = (Get-Location).Path\n[pscustomobject]@{ folder = $here; query = $env:PARAM_QUERY; text = 'ñ ✓' } | ConvertTo-Json -Compress\nWrite-Error 'warned' -ErrorAction Continue\ncmd /c exit 3";
        let outcome = execute(
            &root.path().join("screens"),
            "test",
            &site(&folder),
            &action(Shell::Powershell, script, 60),
            vec![("PARAM_QUERY".into(), "a \"b\" $(whoami); c".into())],
        )
        .await
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(outcome.stdout.trim()).unwrap();
        assert_eq!(
            std::fs::canonicalize(value["folder"].as_str().unwrap()).ok(),
            std::fs::canonicalize(&folder).ok()
        );
        assert_eq!(value["query"], "a \"b\" $(whoami); c");
        assert_eq!(value["text"], "ñ ✓");
        // Errors read as text naming the action, never as serialized records or the script.
        assert!(
            outcome.stderr.contains("probe : warned"),
            "{}",
            outcome.stderr
        );
        assert!(
            !outcome.stderr.contains("CLIXML") && !outcome.stderr.contains("ConvertTo-Json"),
            "{}",
            outcome.stderr
        );
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out && !outcome.truncated);
        // The script file is gone once it was read.
        let left = std::fs::read_dir(root.path().join("screens").join("runs"))
            .unwrap()
            .count();
        assert_eq!(left, 0);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn an_action_past_its_time_is_stopped_with_what_it_printed() {
        let root = tempfile::tempdir().unwrap();
        let outcome = execute(
            root.path(),
            "test",
            &site(root.path()),
            &action(
                Shell::Powershell,
                "Write-Output 'started'\nStart-Sleep -Seconds 30\nWrite-Output 'never'",
                2,
            ),
            vec![],
        )
        .await
        .unwrap();
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, None);
        assert!(outcome.stdout.contains("started") && !outcome.stdout.contains("never"));
        assert!(outcome.duration_ms < 15_000, "{}", outcome.duration_ms);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn an_action_without_a_timeout_runs_until_it_ends_and_keeps_all_it_printed() {
        let root = tempfile::tempdir().unwrap();
        let mut whole = action(
            Shell::Powershell,
            "Start-Sleep -Seconds 1\n[Console]::Out.Write('x' * 5242880)\nWrite-Output 'done'",
            1,
        );
        whole.timeout = None;
        let outcome = execute(root.path(), "test", &site(root.path()), &whole, vec![])
            .await
            .unwrap();
        // Past the 4 MB a stream earlier releases kept.
        assert!(!outcome.timed_out && !outcome.truncated);
        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            outcome.stdout.len() > 5 * 1024 * 1024,
            "{}",
            outcome.stdout.len()
        );
        assert!(outcome.stdout.trim_end().ends_with("done"));
    }

    #[tokio::test]
    async fn bash_runs_in_the_folder_when_this_computer_has_it() {
        if available(&site(Path::new("/")), Shell::Bash).is_err() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("project ñ");
        std::fs::create_dir(&folder).unwrap();
        let outcome = execute(
            &root.path().join("screens"),
            "test",
            &site(&folder),
            &action(
                Shell::Bash,
                "printf '%s|%s' \"$(basename \"$PWD\")\" \"$PARAM_QUERY\"\nexit 4",
                60,
            ),
            vec![("PARAM_QUERY".into(), "x; $(echo no)".into())],
        )
        .await
        .unwrap();
        assert_eq!(outcome.stdout, "project ñ|x; $(echo no)");
        assert_eq!(outcome.exit_code, Some(4));
    }
}
