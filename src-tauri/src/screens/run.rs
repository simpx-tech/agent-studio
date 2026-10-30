//! Runs one command of a screen where it runs: PowerShell or Git Bash on Windows, bash inside a
//! WSL distribution this computer manages, bash on macOS and Linux. The script and the values
//! are data: the script reaches its shell from a file or from stdin, each value from an
//! environment variable of its own, and the commands around them are constants. Output goes to
//! the job that runs it as it arrives (`jobs.rs`), and a job's stop ends the command with
//! everything it started.
use super::{Shell, Site};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

/// How long output may keep arriving after a command ended, from what it left running.
const DRAIN: Duration = Duration::from_secs(2);

/// Which of its streams a command printed to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

/// Where a command's output goes as it arrives.
pub type Chunks = tokio::sync::mpsc::UnboundedSender<(Stream, Vec<u8>)>;

/// What runs: an action's script, or a command a page passes.
pub struct Script<'a> {
    /// The action's name, which PowerShell errors name the script by.
    pub name: &'a str,
    pub shell: Shell,
    pub text: &'a str,
    /// Seconds it may run; none lets it run until it ends.
    pub timeout: Option<u64>,
}

/// How a command ended.
#[derive(Debug, Default)]
pub struct Ended {
    /// None when it was stopped, at its time limit, by a stop or by a signal.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stopped: bool,
    pub duration_ms: u64,
}

/// Variables of an agent's session or of this app's own launches, which a command never sees.
const OWN_VARIABLES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID",
    "AGENT_STUDIO_CONSOLE",
    "AGENT_STUDIO_FOLDER",
];

/// Whether a place runs this shell, so a chat hears it when it saves the screen.
pub(super) fn available(site: &Site, shell: Shell) -> Result<(), String> {
    if let Some(distribution) = &site.distribution {
        return match shell {
            Shell::Bash => Ok(()),
            Shell::Powershell => Err(format!(
                "The WSL distribution {distribution} runs bash; set where to windows to run PowerShell on Windows."
            )),
        };
    }
    match shell {
        Shell::Powershell if cfg!(windows) => Ok(()),
        Shell::Powershell => {
            Err("PowerShell runs on Windows; commands on this computer use bash.".into())
        }
        Shell::Bash => {
            #[cfg(windows)]
            if crate::console::installed_git_bash().is_none() {
                return Err(
                    "Git Bash is not installed on this computer: use powershell, or set where to wsl."
                        .into(),
                );
            }
            Ok(())
        }
    }
}

/// Runs one command with its checked values, sending its output to `chunks` as it arrives,
/// until it ends, its time limit, when it has one, is up, or `stop` is cancelled.
pub(super) async fn execute(
    root: &Path,
    namespace: &str,
    site: &Site,
    script: &Script<'_>,
    variables: Vec<(String, String)>,
    chunks: Chunks,
    stop: &CancellationToken,
) -> Result<Ended, String> {
    available(site, script.shell)?;
    let limit = script.timeout.map(Duration::from_secs);
    let started = Instant::now();
    if let Some(distribution) = &site.distribution {
        #[cfg(windows)]
        return distribution::execute(
            namespace,
            distribution,
            &site.folder,
            script,
            &variables,
            limit,
            started,
            chunks,
            stop,
        )
        .await;
        #[cfg(not(windows))]
        {
            let _ = (namespace, distribution, chunks, stop, started, limit);
            return Err("A WSL screen runs its commands from its Windows computer.".into());
        }
    }
    native(root, site, script, variables, limit, started, chunks, stop).await
}

/// Starts bash in a login shell, as an agent runs its commands, then runs the script from its
/// file in the screen's folder. A profile may change folder, so the shell returns to it first.
const BASH: &str = r#"studio_folder=$1
studio_script=$2
if ! cd -- "$studio_folder" 2>/dev/null; then
  printf 'Agent Studio did not run this command: its folder is unavailable.\n' >&2
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
  [Console]::Error.WriteLine('Agent Studio could not read this command.')
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
fn keep(root: &Path, shell: Shell, text: &str) -> Result<PathBuf, String> {
    let folder = root.join("runs");
    std::fs::create_dir_all(&folder).map_err(|_| "Cannot prepare this command")?;
    prune(&folder);
    let extension = match shell {
        Shell::Powershell => "ps1",
        Shell::Bash => "sh",
    };
    let path = folder.join(format!("{}.{extension}", uuid::Uuid::new_v4()));
    std::fs::write(&path, text.as_bytes()).map_err(|_| "Cannot prepare this command")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot prepare this command")?;
    }
    Ok(path)
}

#[cfg(windows)]
fn shell_command(
    script: &Script<'_>,
    folder: &Path,
    file: &Path,
) -> Result<tokio::process::Command, String> {
    Ok(match script.shell {
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
                .env("AGENT_STUDIO_SCREEN_SCRIPT", file)
                .env("AGENT_STUDIO_SCREEN_ACTION", script.name);
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
                .arg(slashes(file))
                // Git Bash's profile keeps the folder it starts in.
                .env("CHERE_INVOKING", "1");
            command
        }
    })
}

#[cfg(not(windows))]
fn shell_command(
    script: &Script<'_>,
    folder: &Path,
    file: &Path,
) -> Result<tokio::process::Command, String> {
    if script.shell != Shell::Bash {
        return Err("PowerShell runs on Windows.".into());
    }
    let mut command = tokio::process::Command::new("bash");
    command
        .args(["-l", "-c", BASH, "agent-studio"])
        .arg(folder)
        .arg(file);
    Ok(command)
}

#[allow(clippy::too_many_arguments)]
async fn native(
    root: &Path,
    site: &Site,
    script: &Script<'_>,
    variables: Vec<(String, String)>,
    limit: Option<Duration>,
    started: Instant,
    chunks: Chunks,
    stop: &CancellationToken,
) -> Result<Ended, String> {
    let folder = PathBuf::from(&site.folder);
    let file = {
        let (root, folder) = (root.to_path_buf(), folder.clone());
        let (shell, text) = (script.shell, script.text.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            if !folder.is_dir() {
                return Err(format!(
                    "This screen's folder is unavailable: {}",
                    folder.to_string_lossy()
                ));
            }
            keep(&root, shell, &text)
        })
        .await
        .map_err(|_| "Cannot prepare this command".to_string())??
    };
    let started_child = shell_command(script, &folder, &file).and_then(|mut command| {
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
            .map_err(|_| "Could not start this command's shell.".to_string())
    });
    let ended = match started_child {
        Ok(mut child) => {
            let mut collected = collect(&mut child, limit, chunks, stop).await;
            if collected.timed_out || collected.stopped || !collected.drained {
                // Whatever it left running goes with it.
                crate::runner::kill_tree(&mut child).await;
            }
            collected.finish().await;
            Ok(collected.ended(started))
        }
        Err(error) => Err(error),
    };
    let _ = std::fs::remove_file(&file);
    ended
}

struct Collected {
    status: Option<std::process::ExitStatus>,
    timed_out: bool,
    stopped: bool,
    /// Both streams ended: nothing the command started still holds them.
    drained: bool,
    /// The readers of streams that had not closed yet.
    pumps: Vec<tokio::task::JoinHandle<()>>,
}
impl Collected {
    /// Takes what the streams still hold once the command and what it started were ended, and
    /// stops reading a stream something it left behind keeps open.
    async fn finish(&mut self) {
        for pump in &mut self.pumps {
            if tokio::time::timeout(Duration::from_secs(1), &mut *pump)
                .await
                .is_err()
            {
                pump.abort();
            }
        }
        self.pumps.clear();
    }
    fn ended(&self, started: Instant) -> Ended {
        Ended {
            exit_code: if self.timed_out || self.stopped {
                None
            } else {
                self.status.and_then(|status| status.code())
            },
            timed_out: self.timed_out,
            stopped: self.stopped,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        }
    }
}

/// Sends what a stream prints as it arrives, until the stream closes.
async fn pump(pipe: impl AsyncRead + Unpin, stream: Stream, chunks: Chunks) {
    let mut pipe = pipe;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if chunks.send((stream, buffer[..read].to_vec())).is_err() {
                    return;
                }
            }
        }
    }
}

/// Follows both streams while the command runs, until it ends and they close, its time, when it
/// has one, is up, or it is stopped.
async fn collect(
    child: &mut tokio::process::Child,
    limit: Option<Duration>,
    chunks: Chunks,
    stop: &CancellationToken,
) -> Collected {
    let mut out = child
        .stdout
        .take()
        .map(|pipe| tokio::spawn(pump(pipe, Stream::Out, chunks.clone())));
    let mut err = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(pump(pipe, Stream::Err, chunks.clone())));
    drop(chunks);
    let (mut out_done, mut err_done) = (out.is_none(), err.is_none());
    let mut status = None;
    let mut exited = false;
    let mut timed_out = false;
    let mut stopped = false;
    {
        let deadline = async {
            match limit {
                Some(limit) => tokio::time::sleep(limit).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(deadline);
        // Polled only once the command exited, which sets it.
        let drain = tokio::time::sleep(DRAIN);
        tokio::pin!(drain);
        while !(exited && out_done && err_done) {
            tokio::select! {
                _ = async { if let Some(pump) = out.as_mut() { let _ = pump.await; } }, if !out_done => out_done = true,
                _ = async { if let Some(pump) = err.as_mut() { let _ = pump.await; } }, if !err_done => err_done = true,
                result = child.wait(), if !exited => {
                    exited = true;
                    status = result.ok();
                    drain.as_mut().reset(tokio::time::Instant::now() + DRAIN);
                }
                _ = &mut deadline, if !exited => {
                    timed_out = true;
                    break;
                }
                _ = stop.cancelled(), if !exited => {
                    stopped = true;
                    break;
                }
                _ = &mut drain, if exited => break,
            }
        }
    }
    // A stream that closed has nothing more to give; its reader is done.
    let pumps = [(out, out_done), (err, err_done)]
        .into_iter()
        .filter_map(|(pump, done)| pump.filter(|_| !done))
        .collect();
    Collected {
        status,
        timed_out,
        stopped,
        drained: out_done && err_done,
        pumps,
    }
}

#[cfg(windows)]
mod distribution {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tokio::io::AsyncWriteExt;

    /// How much longer than the host's own limit the distribution lets a command run, should
    /// the host be gone before it stops it.
    const BACKSTOP: u64 = 10;

    /// What the fixed script reads on stdin: one line each of base64 or digits. The limit line
    /// is 0 for a command without a time limit, which the distribution then never stops itself.
    /// An empty folder is the distribution's home folder.
    pub(super) fn input(
        folder: &str,
        script: &str,
        variables: &[(String, String)],
        limit: Option<Duration>,
    ) -> String {
        let mut lines = vec![
            STANDARD.encode(folder),
            STANDARD.encode(script),
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

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn execute(
        namespace: &str,
        distribution: &str,
        folder: &str,
        script: &Script<'_>,
        variables: &[(String, String)],
        limit: Option<Duration>,
        started: Instant,
        chunks: Chunks,
        stop: &CancellationToken,
    ) -> Result<Ended, String> {
        // wsl.exe reads its own options as written, so the name goes there bare.
        if distribution.is_empty()
            || !distribution
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        {
            return Err(format!(
                "Cannot run a command in a distribution named {distribution}."
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
            .map_err(|_| format!("Could not start the command in {distribution}."))?;
        let sent = match child.stdin.take() {
            Some(mut stdin) => {
                let written = stdin
                    .write_all(input(folder, script.text, variables, limit).as_bytes())
                    .await;
                drop(stdin);
                written.is_ok()
            }
            None => false,
        };
        if !sent {
            crate::runner::kill_tree(&mut child).await;
            return Err(format!("Could not send the command to {distribution}."));
        }
        let mut collected = collect(&mut child, limit, chunks, stop).await;
        if collected.timed_out || collected.stopped || !collected.drained {
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
        collected.finish().await;
        Ok(collected.ended(started))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn the_distribution_reads_everything_as_lines_of_data() {
            let script = "echo \"$PARAM_QUERY\"\nls";
            let text = input(
                "/home/me/it's here",
                script,
                &[("PARAM_QUERY".into(), "a\nb $(x)".into())],
                Some(Duration::from_secs(30)),
            );
            let lines: Vec<_> = text.lines().collect();
            assert_eq!(lines.len(), 6);
            assert_eq!(STANDARD.decode(lines[0]).unwrap(), b"/home/me/it's here");
            assert_eq!(STANDARD.decode(lines[1]).unwrap(), script.as_bytes());
            assert_eq!(lines[2], "40");
            assert_eq!(lines[3], "1");
            assert_eq!(lines[4], "PARAM_QUERY");
            assert_eq!(STANDARD.decode(lines[5]).unwrap(), b"a\nb $(x)");
            assert!(text.ends_with('\n'));
            // Without a time limit the distribution leaves the command to end by itself, and
            // without a folder it runs in the home folder.
            let unlimited = input("", script, &[], None);
            assert_eq!(unlimited.lines().nth(2), Some("0"));
            assert_eq!(unlimited.lines().next(), Some(""));
        }

        pub(crate) fn first_distribution() -> String {
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

        async fn run(
            distribution: &str,
            folder: &str,
            text: &str,
            variables: &[(String, String)],
            timeout: u64,
        ) -> (Ended, String, String) {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
            let stop = CancellationToken::new();
            let script = Script {
                name: "probe",
                shell: Shell::Bash,
                text,
                timeout: Some(timeout),
            };
            let ended = execute(
                "agent-studio-test",
                distribution,
                folder,
                &script,
                variables,
                Some(Duration::from_secs(timeout)),
                Instant::now(),
                sender,
                &stop,
            )
            .await
            .unwrap();
            let (mut out, mut err) = (vec![], vec![]);
            while let Ok((stream, bytes)) = receiver.try_recv() {
                match stream {
                    Stream::Out => out.extend(bytes),
                    Stream::Err => err.extend(bytes),
                }
            }
            (
                ended,
                String::from_utf8(out).unwrap(),
                String::from_utf8(err).unwrap(),
            )
        }

        #[tokio::test]
        #[ignore = "Opt-in: runs real commands in the first WSL distribution"]
        async fn a_real_wsl_action_runs_in_its_folder_and_stops_at_its_limit() {
            let distribution = first_distribution();
            let (ended, stdout, stderr) = run(
                &distribution,
                "/tmp",
                "printf '%s|%s|%s' \"$PWD\" \"$PARAM_QUERY\" \"$PARAM_EMPTY\"\necho warned >&2\nexit 5",
                &[
                    ("PARAM_QUERY".into(), "a 'b' \"c\" $(whoami); ñ\nline".into()),
                    ("PARAM_EMPTY".into(), String::new()),
                ],
                60,
            )
            .await;
            assert_eq!(stdout, "/tmp|a 'b' \"c\" $(whoami); ñ\nline|");
            assert_eq!(stderr.trim(), "warned");
            assert_eq!(ended.exit_code, Some(5));
            // Without a folder it runs at home.
            let (_, home, _) = run(&distribution, "", "printf '%s' \"$PWD\"", &[], 60).await;
            assert!(home.starts_with('/') && home != "/tmp", "{home}");
            // A missing folder runs nothing.
            let (missing, stdout, stderr) = run(
                &distribution,
                "/nonexistent/agent-studio",
                "echo ran",
                &[],
                60,
            )
            .await;
            assert_eq!(missing.exit_code, Some(126));
            assert!(stderr.contains("folder is unavailable"));
            assert!(!stdout.contains("ran"));
            // Past its limit the command and what it started end, with what it printed so far.
            let marker = format!("agent-studio-test-{}", uuid::Uuid::new_v4());
            let (slow, stdout, _) = run(
                &distribution,
                "/tmp",
                &format!("echo started\nsleep 300 & echo $! > /tmp/{marker}\nwait"),
                &[],
                3,
            )
            .await;
            assert!(slow.timed_out && stdout.contains("started"), "{slow:?}");
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
pub(super) mod tests {
    use super::*;

    pub(crate) fn site(folder: &Path) -> Site {
        Site {
            environment_id: uuid::Uuid::new_v4().to_string(),
            distribution: None,
            folder: folder.to_string_lossy().into_owned(),
            project: String::new(),
        }
    }

    /// Runs a command whole, as a test reads it: how it ended and each stream.
    pub(crate) async fn run_whole(
        root: &Path,
        site: &Site,
        shell: Shell,
        text: &str,
        timeout: Option<u64>,
        variables: Vec<(String, String)>,
    ) -> Result<(Ended, String, String), String> {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let script = Script {
            name: "probe",
            shell,
            text,
            timeout,
        };
        let ended = execute(root, "test", site, &script, variables, sender, &stop).await?;
        let (mut out, mut err) = (vec![], vec![]);
        while let Some((stream, bytes)) = receiver.recv().await {
            match stream {
                Stream::Out => out.extend(bytes),
                Stream::Err => err.extend(bytes),
            }
        }
        Ok((
            ended,
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
        ))
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
    fn a_wsl_place_runs_bash_alone() {
        let mut wsl = site(Path::new("/home/me"));
        wsl.distribution = Some("Ubuntu".into());
        assert!(available(&wsl, Shell::Bash).is_ok());
        assert!(available(&wsl, Shell::Powershell)
            .unwrap_err()
            .contains("set where to windows"));
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
        let error = run_whole(
            root.path(),
            &site(&missing),
            shell,
            "echo hi",
            Some(10),
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
        let (ended, stdout, stderr) = run_whole(
            &root.path().join("screens"),
            &site(&folder),
            Shell::Powershell,
            script,
            Some(60),
            vec![("PARAM_QUERY".into(), "a \"b\" $(whoami); c".into())],
        )
        .await
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
        assert_eq!(
            std::fs::canonicalize(value["folder"].as_str().unwrap()).ok(),
            std::fs::canonicalize(&folder).ok()
        );
        assert_eq!(value["query"], "a \"b\" $(whoami); c");
        assert_eq!(value["text"], "ñ ✓");
        // Errors read as text naming the command, never as serialized records or the script.
        assert!(stderr.contains("probe : warned"), "{stderr}");
        assert!(
            !stderr.contains("CLIXML") && !stderr.contains("ConvertTo-Json"),
            "{stderr}"
        );
        assert_eq!(ended.exit_code, Some(3));
        assert!(!ended.timed_out && !ended.stopped);
        // The script file is gone once it was read.
        let left = std::fs::read_dir(root.path().join("screens").join("runs"))
            .unwrap()
            .count();
        assert_eq!(left, 0);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_command_past_its_time_is_stopped_with_what_it_printed() {
        let root = tempfile::tempdir().unwrap();
        let (ended, stdout, _) = run_whole(
            root.path(),
            &site(root.path()),
            Shell::Powershell,
            "Write-Output 'started'\nStart-Sleep -Seconds 30\nWrite-Output 'never'",
            Some(2),
            vec![],
        )
        .await
        .unwrap();
        assert!(ended.timed_out);
        assert_eq!(ended.exit_code, None);
        assert!(stdout.contains("started") && !stdout.contains("never"));
        assert!(ended.duration_ms < 15_000, "{}", ended.duration_ms);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_stopped_command_ends_at_once_with_what_it_printed() {
        let root = tempfile::tempdir().unwrap();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let script = Script {
            name: "probe",
            shell: Shell::Powershell,
            text: "Write-Output 'started'\nStart-Sleep -Seconds 60\nWrite-Output 'never'",
            timeout: None,
        };
        let stopping = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            stopping.cancel();
        });
        let site = site(root.path());
        let ended = execute(root.path(), "test", &site, &script, vec![], sender, &stop)
            .await
            .unwrap();
        let mut out = vec![];
        while let Some((_, bytes)) = receiver.recv().await {
            out.extend(bytes);
        }
        assert!(ended.stopped && ended.exit_code.is_none(), "{ended:?}");
        assert!(ended.duration_ms < 20_000, "{}", ended.duration_ms);
        let out = String::from_utf8_lossy(&out);
        assert!(out.contains("started") && !out.contains("never"), "{out}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_command_without_a_timeout_runs_until_it_ends_and_keeps_all_it_printed() {
        let root = tempfile::tempdir().unwrap();
        let (ended, stdout, _) = run_whole(
            root.path(),
            &site(root.path()),
            Shell::Powershell,
            "Start-Sleep -Seconds 1\n[Console]::Out.Write('x' * 5242880)\nWrite-Output 'done'",
            None,
            vec![],
        )
        .await
        .unwrap();
        // Past the 4 MB a stream earlier releases kept.
        assert!(!ended.timed_out);
        assert_eq!(ended.exit_code, Some(0));
        assert!(stdout.len() > 5 * 1024 * 1024, "{}", stdout.len());
        assert!(stdout.trim_end().ends_with("done"));
    }

    #[tokio::test]
    async fn bash_runs_in_the_folder_when_this_computer_has_it() {
        if available(&site(Path::new("/")), Shell::Bash).is_err() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("project ñ");
        std::fs::create_dir(&folder).unwrap();
        let (ended, stdout, _) = run_whole(
            &root.path().join("screens"),
            &site(&folder),
            Shell::Bash,
            "printf '%s|%s' \"$(basename \"$PWD\")\" \"$PARAM_QUERY\"\nexit 4",
            Some(60),
            vec![("PARAM_QUERY".into(), "x; $(echo no)".into())],
        )
        .await
        .unwrap();
        assert_eq!(stdout, "project ñ|x; $(echo no)");
        assert_eq!(ended.exit_code, Some(4));
    }
}
