//! Run in console: opens a console window on this computer, in a chat's working folder, and
//! runs the code of one fenced block of a reply there. Only an explicit click reaches this, the
//! window belongs to the user from then on, and nothing it prints returns to the app.
//!
//! The code is data. It is written to a file in app data, or sent through stdin into a WSL
//! distribution, and the shell reads it from there; it is never part of a command line, and
//! the scripts around it are constants.
use crate::folders::ChatLocation;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(windows)]
pub(crate) mod window;

/// A family of console languages, as the window names the block it runs.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Posix,
    Powershell,
    Cmd,
}

/// The shell that opened, by the name the block's control shows.
#[derive(Debug, Serialize)]
pub struct Opened {
    shell: String,
}

const MAX_CODE: usize = 64 * 1024;

// Characters a block cannot show: controls, and format characters that hide or reorder text.
pub(crate) fn hidden(character: char) -> bool {
    (character.is_control() && character != '\n' && character != '\t')
        || matches!(
            character,
            '\u{ad}'
                | '\u{61c}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206f}'
                | '\u{feff}'
                | '\u{fff9}'..='\u{fffb}'
                | '\u{e0000}'..='\u{e007f}'
        )
}

/// The code as a console reads it: bounded, with plain line ends, and with nothing in it that
/// its block could not show, so what runs is what was read.
fn checked(code: &str) -> Result<String, String> {
    let code = code.replace("\r\n", "\n").replace('\r', "\n");
    let code = code.trim_end_matches('\n');
    if code.trim().is_empty() {
        return Err("This block has no code to run.".into());
    }
    if code.len() > MAX_CODE {
        return Err(
            "This code is longer than the 64 KB a console run accepts. Copy it into a file and run that."
                .into(),
        );
    }
    if let Some(character) = code.chars().find(|character| hidden(*character)) {
        return Err(format!(
            "This code contains a hidden character (U+{:04X}), so it was not run. Copy it and check it first.",
            character as u32
        ));
    }
    Ok(code.to_string())
}

// The window is named after the chat's project folder, which tells consoles apart.
fn title(location: Option<&ChatLocation>) -> String {
    let folder = location
        .and_then(|location| {
            location
                .path
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
        })
        .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
        .unwrap_or("Standalone");
    format!(
        "Agent Studio - {}",
        folder.chars().take(80).collect::<String>()
    )
}

fn launcher() -> String {
    crate::wsl::embedded_script(include_str!("console-launch.sh"))
}

// Code that was left behind, such as a batch file whose console outlived the app, goes with a
// run a day later.
fn prune(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .filter(std::fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(24 * 60 * 60));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn keep(root: &Path, name: &str, contents: &[u8]) -> Result<PathBuf, String> {
    let path = root.join(name);
    // The launcher is the same for every run; a console still reading it keeps its file.
    if std::fs::read(&path).is_ok_and(|kept| kept == contents) {
        return Ok(path);
    }
    std::fs::write(&path, contents).map_err(|_| "Cannot keep the code for the console")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot keep the code for the console")?;
    }
    Ok(path)
}

pub async fn open(
    app: tauri::AppHandle,
    provider: String,
    location: Option<ChatLocation>,
    conversation: String,
    shell: Shell,
    code: String,
) -> Result<Opened, String> {
    if !crate::providers::valid_provider(&provider) {
        return Err("Unknown provider".into());
    }
    uuid::Uuid::parse_str(&conversation).map_err(|_| "Invalid conversation id")?;
    let code = checked(&code)?;
    let profile = crate::profiles::current();
    let folder = crate::mcp::working_folder(
        &app,
        &provider,
        profile.distribution.as_deref(),
        location.as_ref(),
        Some(&conversation),
    )
    .await?;
    let title = title(location.as_ref());
    if let Some(distribution) = profile.distribution {
        return distribution_console(distribution, folder, title, shell, code).await;
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("console");
    tauri::async_runtime::spawn_blocking(move || {
        native_console(&root, Path::new(&folder), &title, shell, &code)
    })
    .await
    .map_err(|_| "Could not open a console")?
}

/// Runs in the new PowerShell session, whose prompt follows it. The code is read from the file
/// a variable of this console names, which is cleared before anything runs, and it runs in the
/// session itself, so what it defines stays for the prompt. A profile may have changed folder,
/// so the session returns to the chat's folder first, and code never runs anywhere else.
#[cfg(windows)]
const POWERSHELL: &str = r#". (& {
    $path = $env:AGENT_STUDIO_CONSOLE
    $folder = $env:AGENT_STUDIO_FOLDER
    Remove-Item Env:AGENT_STUDIO_CONSOLE, Env:AGENT_STUDIO_FOLDER -ErrorAction SilentlyContinue
    try {
        $code = [IO.File]::ReadAllText($path)
    } catch {
        Write-Host 'Agent Studio could not read the code to run.' -ForegroundColor Red
        return {}
    } finally {
        if ($path) { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }
    }
    try {
        Set-Location -LiteralPath $folder -ErrorAction Stop
    } catch {
        Write-Host 'Agent Studio did not run the code: the folder of this chat is unavailable.' -ForegroundColor Red
        return {}
    }
    $lines = $code.TrimEnd() -split "`n"
    $shown = if ($lines.Count -gt 12) { @($lines[0..11]) + "... $($lines.Count - 12) more lines" } else { $lines }
    Write-Host ($shown -join "`n") -ForegroundColor DarkGray
    Write-Host ''
    try { [scriptblock]::Create($code) } catch { Write-Host $_.Exception.Message -ForegroundColor Red; {} }
})"#;

/// Command Prompt runs the batch file this console's variable names, then stays open.
#[cfg(windows)]
const COMMAND_PROMPT: &str = r#"/S /K ""%AGENT_STUDIO_CONSOLE%"""#;

/// Git for Windows' bash, which runs a POSIX block on a Windows computer as Claude Code runs
/// its own commands there. `bash.exe` on PATH is never taken: on Windows that name is also the
/// launcher of the default WSL distribution, which is another computer.
#[cfg(windows)]
fn git_bash(path: &[PathBuf], installations: &[PathBuf]) -> Option<PathBuf> {
    path.iter()
        .filter(|directory| directory.join("git.exe").is_file())
        // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
        .flat_map(|directory| directory.ancestors().skip(1).take(2))
        .chain(installations.iter().map(PathBuf::as_path))
        .map(|root| root.join("bin").join("bash.exe"))
        .find(|bash| bash.is_file())
}

/// The folders Git for Windows installs into, for a bash not found beside git on PATH.
#[cfg(windows)]
fn git_installations() -> Vec<PathBuf> {
    [
        ("ProgramFiles", "Git"),
        ("ProgramFiles(x86)", "Git"),
        ("LOCALAPPDATA", "Programs\\Git"),
    ]
    .into_iter()
    .filter_map(|(variable, git)| Some(PathBuf::from(std::env::var_os(variable)?).join(git)))
    .collect()
}

#[cfg(windows)]
fn search_path() -> Vec<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect()
}

/// Git for Windows' bash on this computer, as a console or a screen's command runs it.
#[cfg(windows)]
pub(crate) fn installed_git_bash() -> Option<PathBuf> {
    git_bash(&search_path(), &git_installations())
}

/// PowerShell 7 when it is on PATH, otherwise Windows PowerShell.
#[cfg(windows)]
pub(crate) fn powershell(path: &[PathBuf], system: &Path) -> PathBuf {
    path.iter()
        .map(|directory| directory.join("pwsh.exe"))
        .find(|pwsh| pwsh.symlink_metadata().is_ok())
        .unwrap_or_else(|| {
            system
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
}

/// This computer's PowerShell, as a console or a screen's command runs it.
#[cfg(windows)]
pub(crate) fn installed_powershell() -> Option<PathBuf> {
    Some(powershell(&search_path(), &window::system_directory()?))
}

/// A console that was started, with the name its block's control shows.
#[cfg(windows)]
struct Launched {
    name: String,
    console: window::Console,
    /// The file on this computer that holds the code. PowerShell and bash delete it once they
    /// have read it.
    kept: Option<PathBuf>,
    /// Command Prompt reads its batch file as it goes, so that file goes when the console does.
    kept_while_open: bool,
}

#[cfg(windows)]
fn launch(
    name: &str,
    start: window::Start,
    kept: Option<PathBuf>,
    kept_while_open: bool,
) -> Result<Launched, String> {
    match window::start(start) {
        Ok(console) => Ok(Launched {
            name: name.into(),
            console,
            kept,
            kept_while_open,
        }),
        Err(error) => {
            if let Some(kept) = kept {
                let _ = std::fs::remove_file(kept);
            }
            Err(format!("Could not open a console: {error}"))
        }
    }
}

// A console that closes at once showed nothing the user could read.
#[cfg(windows)]
fn stayed_open(launched: Launched) -> Result<Opened, String> {
    let Launched {
        name,
        console,
        kept,
        kept_while_open,
    } = launched;
    if let Some(code) = console.closed_within(700) {
        if let Some(kept) = kept {
            let _ = std::fs::remove_file(kept);
        }
        return Err(format!(
            "The console closed as soon as it opened (exit code {code}). Copy the code and run it in a console of your own."
        ));
    }
    if let Some(kept) = kept.filter(|_| kept_while_open) {
        // The console is the user's and may stay open for days, so a thread of its own waits.
        std::thread::spawn(move || {
            console.closed_within(u32::MAX);
            let _ = std::fs::remove_file(kept);
        });
    }
    Ok(Opened { shell: name })
}

#[cfg(windows)]
fn native_console(
    root: &Path,
    folder: &Path,
    title: &str,
    shell: Shell,
    code: &str,
) -> Result<Opened, String> {
    stayed_open(launch_native(root, folder, title, shell, code, false)?)
}

#[cfg(windows)]
fn launch_native(
    root: &Path,
    folder: &Path,
    title: &str,
    shell: Shell,
    code: &str,
    hidden: bool,
) -> Result<Launched, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use window::quote;
    std::fs::create_dir_all(root).map_err(|_| "Cannot keep the code for the console")?;
    prune(root);
    let system = window::system_directory().ok_or("Cannot locate the Windows shells")?;
    let path = search_path();
    let bash = (shell == Shell::Posix)
        .then(|| git_bash(&path, &git_installations()))
        .flatten();
    let id = uuid::Uuid::new_v4();
    // What PowerShell and Command Prompt read, named to them by this console's environment.
    let mut named = Vec::new();
    let kept;
    let (name, application, arguments) = if let Some(bash) = bash {
        let launcher = keep(root, "launch.sh", launcher().as_bytes())?;
        kept = keep(root, &format!("{id}.txt"), code.as_bytes())?;
        let arguments = format!(
            "--login {} {} {}",
            quote(&launcher.to_string_lossy()),
            quote(&kept.to_string_lossy()),
            quote(&folder.to_string_lossy().replace('\\', "/"))
        );
        ("Git Bash", bash, arguments)
    } else if shell == Shell::Cmd {
        // Command Prompt falls back to the Windows folder when it is started in a network
        // one, and code never runs anywhere but in its chat's folder.
        if folder.to_string_lossy().starts_with(r"\\") {
            return Err(
                "Command Prompt cannot start in this chat's folder, which is a network path. Copy the code and run it in a console of your own."
                    .into(),
            );
        }
        // A batch file is read in the console's code page; UTF-8 is chosen only when needed.
        let utf8 = if code.is_ascii() {
            ""
        } else {
            "@chcp 65001>nul\r\n"
        };
        let batch = format!(
            "@set \"AGENT_STUDIO_CONSOLE=\"\r\n{utf8}{}\r\n",
            code.replace('\n', "\r\n")
        );
        kept = keep(root, &format!("{id}.cmd"), batch.as_bytes())?;
        named.push(("AGENT_STUDIO_CONSOLE", kept.clone()));
        (
            "Command Prompt",
            system.join("cmd.exe"),
            COMMAND_PROMPT.to_string(),
        )
    } else {
        // PowerShell also runs a POSIX block on a computer without Git Bash: most are plain
        // commands, and those that are not fail where the user can see why.
        kept = keep(root, &format!("{id}.txt"), code.as_bytes())?;
        named.push(("AGENT_STUDIO_CONSOLE", kept.clone()));
        named.push(("AGENT_STUDIO_FOLDER", folder.to_path_buf()));
        let encoded = STANDARD.encode(
            POWERSHELL
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let application = powershell(&path, &system);
        (
            "PowerShell",
            application,
            format!("-NoLogo -NoExit -EncodedCommand {encoded}"),
        )
    };
    // A console is not an agent's session, whatever started this app.
    let mut environment: Vec<_> = std::env::vars_os()
        .filter(|(name, _)| {
            ![
                "CLAUDECODE",
                "CODEX_THREAD_ID",
                "AGENT_STUDIO_CONSOLE",
                "AGENT_STUDIO_FOLDER",
            ]
            .iter()
            .any(|removed| name.eq_ignore_ascii_case(removed))
        })
        .collect();
    environment.extend(
        named
            .into_iter()
            .map(|(name, path)| (name.into(), path.into())),
    );
    launch(
        name,
        window::Start {
            application: &application,
            command_line: &format!("{} {arguments}", quote(&application.to_string_lossy())),
            directory: Some(folder),
            title: Some(title),
            environment: Some(&environment),
            hidden,
        },
        Some(kept),
        shell == Shell::Cmd,
    )
}

/// A console inside a WSL distribution this computer manages, where that chat's agent runs.
#[cfg(windows)]
async fn distribution_console(
    distribution: String,
    folder: String,
    title: String,
    shell: Shell,
    code: String,
) -> Result<Opened, String> {
    if shell != Shell::Posix {
        return Err(format!(
            "PowerShell and Command Prompt code runs on Windows, and this chat runs in {distribution}."
        ));
    }
    stayed_open(launch_distribution(distribution, folder, title, code, false).await?)
}

#[cfg(windows)]
async fn launch_distribution(
    distribution: String,
    folder: String,
    title: String,
    code: String,
    hidden: bool,
) -> Result<Launched, String> {
    use std::{process::Stdio, time::Duration};
    use tokio::io::AsyncWriteExt;
    use window::quote;
    // wsl.exe reads its own options as written, quotes included, so the name goes there bare.
    if distribution.is_empty()
        || !distribution
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(format!(
            "A console cannot be opened in a distribution named {distribution}."
        ));
    }
    // The distribution keeps the launcher and the code in a folder of its own first.
    let store = crate::wsl::embedded_script(include_str!("console-store.sh"));
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
            &store,
            "agent-studio",
            &launcher(),
        ])
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let unavailable = || format!("Cannot keep the code for the console in {distribution}.");
    let mut child = command.spawn().map_err(|_| unavailable())?;
    let mut stdin = child.stdin.take().ok_or_else(unavailable)?;
    stdin
        .write_all(code.as_bytes())
        .await
        .map_err(|_| unavailable())?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| {
            format!("{distribution} did not answer. Check that it starts, then run the code again.")
        })?
        .map_err(|_| unavailable())?;
    let directory = String::from_utf8(output.stdout).map_err(|_| unavailable())?;
    if !output.status.success()
        || !directory.starts_with('/')
        || directory.len() > 4096
        || directory.chars().any(char::is_control)
    {
        return Err(unavailable());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let wsl = window::system_directory()
            .ok_or("Cannot locate the Windows shells")?
            .join("wsl.exe");
        let command_line = [
            quote(&wsl.to_string_lossy()),
            format!("--distribution {distribution} --cd ~ --exec bash"),
            quote(&format!("{directory}/launch")),
            quote(&format!("{directory}/code")),
            quote(&folder),
            quote(&directory),
        ]
        .join(" ");
        launch(
            &distribution,
            window::Start {
                application: &wsl,
                command_line: &command_line,
                directory: None,
                title: Some(&title),
                environment: None,
                hidden,
            },
            None,
            false,
        )
    })
    .await
    .map_err(|_| "Could not open a console")?
}

#[cfg(not(windows))]
async fn distribution_console(
    _distribution: String,
    _folder: String,
    _title: String,
    _shell: Shell,
    _code: String,
) -> Result<Opened, String> {
    Err("A WSL console opens from its Windows computer.".into())
}

/// A terminal of this macOS or Linux computer, which runs the launcher through a file of its own.
#[cfg(unix)]
fn native_console(
    root: &Path,
    folder: &Path,
    _title: &str,
    shell: Shell,
    code: &str,
) -> Result<Opened, String> {
    use std::os::unix::fs::PermissionsExt;
    if shell != Shell::Posix {
        return Err("PowerShell and Command Prompt code runs on Windows.".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot keep the code for the console")?;
    prune(root);
    let id = uuid::Uuid::new_v4();
    let launcher = keep(root, "launch.sh", launcher().as_bytes())?;
    let file = keep(root, &format!("{id}.txt"), code.as_bytes())?;
    let run = root.join(format!("run-{id}.command"));
    std::fs::write(&run, terminal_script(&run, &launcher, &file, folder))
        .map_err(|_| "Cannot keep the code for the console")?;
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Cannot keep the code for the console")?;
    terminal(&run)
}

// What a terminal runs: it names the launcher, the code's file and the folder as literals and
// removes itself. The code is only named here, never written out.
#[cfg(any(unix, test))]
fn terminal_script(run: &Path, launcher: &Path, file: &Path, folder: &Path) -> String {
    let literal = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    format!(
        "#!/bin/sh\nrm -f -- {}\nexec /bin/sh {} {} {}\n",
        literal(run),
        literal(launcher),
        literal(file),
        literal(folder)
    )
}

// The terminals a desktop is likely to have, each with the arguments that run one program.
#[cfg(unix)]
fn terminals() -> Vec<(String, Vec<&'static str>)> {
    if cfg!(target_os = "macos") {
        return vec![("open".into(), vec!["-a", "Terminal"])];
    }
    let chosen = std::env::var("TERMINAL")
        .ok()
        .filter(|terminal| !terminal.trim().is_empty())
        .map(|terminal| (terminal, vec!["-e"]));
    chosen
        .into_iter()
        .chain(
            [
                ("x-terminal-emulator", vec!["-e"]),
                ("gnome-terminal", vec!["--"]),
                ("konsole", vec!["-e"]),
                ("xfce4-terminal", vec!["-x"]),
                ("kitty", vec![]),
                ("alacritty", vec!["-e"]),
                ("wezterm", vec!["start", "--"]),
                ("foot", vec![]),
                ("xterm", vec!["-e"]),
            ]
            .map(|(name, arguments)| (name.to_string(), arguments)),
        )
        .collect()
}

#[cfg(unix)]
fn terminal(run: &Path) -> Result<Opened, String> {
    use std::process::Stdio;
    for (program, arguments) in terminals() {
        let spawned = std::process::Command::new(&program)
            .args(&arguments)
            .arg(run)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = spawned {
            // Some terminals hand their window to a running instance and exit; reap them.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(Opened {
                shell: if cfg!(target_os = "macos") {
                    "Terminal".into()
                } else {
                    "a terminal".into()
                },
            });
        }
    }
    let _ = std::fs::remove_file(run);
    Err("Could not open a terminal. Copy the code and run it in a terminal of your own.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_bounded_and_holds_nothing_its_block_cannot_show() {
        assert_eq!(
            checked("npm test\r\nnpm run build\r\n").unwrap(),
            "npm test\nnpm run build"
        );
        let plain = "echo 'tab\there' \"日本語\" ñ";
        assert_eq!(checked(plain).unwrap(), plain);
        assert!(checked(" \n\t\n").unwrap_err().contains("no code"));
        assert!(checked(&"a".repeat(MAX_CODE + 1))
            .unwrap_err()
            .contains("64 KB"));
        assert!(checked(&"a".repeat(MAX_CODE)).is_ok());
        // A right-to-left override shows `echo safe` while another order runs.
        for (code, point) in [
            ("echo \u{202e}efas", "U+202E"),
            ("rm\u{200b} -rf x", "U+200B"),
            ("echo\u{1b}[8m hidden", "U+001B"),
            ("echo a\u{0}b", "U+0000"),
            ("echo \u{feff}x", "U+FEFF"),
            ("echo \u{2066}x\u{2069}", "U+2066"),
            ("echo \u{e0041}", "U+E0041"),
        ] {
            let refused = checked(code).unwrap_err();
            assert!(
                refused.contains(point) && refused.contains("was not run"),
                "{refused}"
            );
        }
    }

    #[test]
    fn requests_name_one_of_three_shells() {
        let shell = |name: &str| serde_json::from_value::<Shell>(serde_json::json!(name));
        assert_eq!(shell("posix").unwrap(), Shell::Posix);
        assert_eq!(shell("powershell").unwrap(), Shell::Powershell);
        assert_eq!(shell("cmd").unwrap(), Shell::Cmd);
        assert!(shell("python").is_err() && shell("Posix").is_err());
    }

    #[test]
    fn the_window_is_named_after_the_project_folder() {
        let location = |path: &str| -> ChatLocation {
            serde_json::from_value(serde_json::json!({
                "computerId": uuid::Uuid::new_v4(),
                "environmentId": uuid::Uuid::new_v4(),
                "path": path,
            }))
            .unwrap()
        };
        assert_eq!(title(None), "Agent Studio - Standalone");
        assert_eq!(title(Some(&location(""))), "Agent Studio - Standalone");
        assert_eq!(
            title(Some(&location(r"D:\Unreal Projects\bluevox"))),
            "Agent Studio - bluevox"
        );
        assert_eq!(
            title(Some(&location("/home/test/my studio/"))),
            "Agent Studio - my studio"
        );
        assert_eq!(title(Some(&location("/"))), "Agent Studio - Standalone");
    }

    #[test]
    fn kept_code_is_pruned_after_a_day_and_the_launcher_is_not_rewritten() {
        let root = tempfile::tempdir().unwrap();
        let launcher = keep(root.path(), "launch.sh", b"same").unwrap();
        let written = std::fs::metadata(&launcher).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        keep(root.path(), "launch.sh", b"same").unwrap();
        assert_eq!(
            std::fs::metadata(&launcher).unwrap().modified().unwrap(),
            written
        );
        let old = keep(root.path(), "old.cmd", b"echo old").unwrap();
        let recent = keep(root.path(), "recent.cmd", b"echo recent").unwrap();
        let day = std::time::Duration::from_secs(25 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - day)
            .unwrap();
        prune(root.path());
        assert!(!old.exists() && recent.exists() && launcher.exists());
    }

    #[test]
    fn scripts_name_the_code_and_never_contain_it() {
        let launcher = launcher();
        assert!(!launcher.contains('\r'));
        // The code reaches the shell as one argument and is evaluated from a variable.
        assert!(
            launcher.contains("exec \"$shell\" -l -i -c \"$run\" \"$shell\" \"$code\" \"$folder\"")
        );
        assert!(launcher.contains("eval \"$studio_code\""));
        // A terminal's own script quotes its paths as literals.
        let script = terminal_script(
            Path::new("/data/run.command"),
            Path::new("/data/launch.sh"),
            Path::new("/data/code.txt"),
            Path::new("/home/it's $(mine)/project"),
        );
        assert_eq!(
            script,
            "#!/bin/sh\nrm -f -- '/data/run.command'\nexec /bin/sh '/data/launch.sh' '/data/code.txt' '/home/it'\\''s $(mine)/project'\n"
        );
    }

    #[cfg(windows)]
    #[test]
    fn git_bash_is_found_beside_git_and_never_as_the_wsl_launcher() {
        let root = tempfile::tempdir().unwrap();
        let file = |relative: &str| {
            let path = root.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "synthetic").unwrap();
            path
        };
        // A bash.exe on PATH without Git beside it is the WSL launcher's name.
        file("WindowsApps/bash.exe");
        assert_eq!(git_bash(&[root.path().join("WindowsApps")], &[]), None);
        let bash = file("Git/bin/bash.exe");
        for git in ["Git/cmd/git.exe", "Git/mingw64/bin/git.exe"] {
            let directory = file(git).parent().unwrap().to_path_buf();
            assert_eq!(
                git_bash(&[root.path().join("WindowsApps"), directory], &[]).as_deref(),
                Some(bash.as_path())
            );
        }
        assert_eq!(
            git_bash(&[], &[root.path().join("Missing"), root.path().join("Git")]).as_deref(),
            Some(bash.as_path())
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_prompt_is_never_started_in_a_network_folder() {
        let root = tempfile::tempdir().unwrap();
        let refused = launch_native(
            root.path(),
            Path::new(r"\\wsl.localhost\Ubuntu\home\test"),
            "Agent Studio - test",
            Shell::Cmd,
            "dir",
            true,
        )
        .err()
        .unwrap();
        assert!(refused.contains("network path"), "{refused}");
        // Nothing is kept for a console that did not open.
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    // The real consoles below open without a window. Each runs code that proves where it ran
    // and that its shell stayed open afterwards, then is closed by its process id.
    #[cfg(windows)]
    fn close(pid: &str) {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", pid.trim(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    /// Closes a test's console when the test ends, however it ends.
    #[cfg(windows)]
    struct Closing(u32);
    #[cfg(windows)]
    impl Drop for Closing {
        fn drop(&mut self) {
            close(&self.0.to_string());
        }
    }
    #[cfg(windows)]
    fn written(read: impl Fn() -> Option<String>) -> String {
        for _ in 0..300 {
            if let Some(text) = read().filter(|text| text.ends_with("done")) {
                return text;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("The console never reported back");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "Opt-in: runs real PowerShell, Command Prompt and Git Bash consoles, without showing their windows"]
    fn real_windows_consoles_run_the_code_in_the_folder_and_stay_open() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Project 'quoted' & (odd) ñ");
        std::fs::create_dir(&folder).unwrap();
        let kept = root.path().join("console");
        let marker = root.path().join("marker.txt");
        let at = marker.to_string_lossy().replace('\\', "/");
        std::env::set_var("CLAUDECODE", "1");
        let cases = [
            // The prompt of the session that follows the code reports, so what the code defined
            // is still there once it ended.
            (
                Shell::Powershell,
                "PowerShell",
                format!(
                    "$kept = 'state \"kept\" ñ'\nfunction prompt {{\n  [IO.File]::WriteAllText('{at}', \"$((Get-Location).Path)|$kept|$($env:AGENT_STUDIO_CONSOLE)$($env:CLAUDECODE)|$PID|done\")\n  'PS> '\n}}"
                ),
            ),
            (
                Shell::Cmd,
                "Command Prompt",
                format!(
                    "rem ñ\nset KEPT=state\n<nul set /p \"=%CD%|%KEPT%|%AGENT_STUDIO_CONSOLE%%CLAUDECODE%|0|done\" > \"{at}\""
                ),
            ),
            (
                Shell::Posix,
                "Git Bash",
                format!(
                    "export KEPT='state \"kept\" ñ' STUDIO_MARKER='{at}'\nexport PROMPT_COMMAND='printf \"%s|%s|%s|%s|done\" \"$(cygpath -w \"$PWD\")\" \"$KEPT\" \"$AGENT_STUDIO_CONSOLE$CLAUDECODE\" \"$(cat /proc/$$/winpid)\" > \"$STUDIO_MARKER\"'\nset -e\nfalse\necho not reached"
                ),
            ),
        ];
        for (shell, name, code) in cases {
            let _ = std::fs::remove_file(&marker);
            let launched = launch_native(&kept, &folder, "Agent Studio - test", shell, &code, true)
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(launched.name, name);
            let _closing = Closing(launched.console.pid);
            let text = written(|| std::fs::read_to_string(&marker).ok());
            // The shell is still open after the code ended.
            let open = launched.console.closed_within(1000).is_none();
            let parts: Vec<_> = text.split('|').collect();
            if parts[3] != "0" {
                close(parts[3]);
            }
            assert!(open, "{name} closed after its code");
            // Shells spell a short temporary path in their own way.
            assert_eq!(
                std::fs::canonicalize(parts[0]).ok(),
                std::fs::canonicalize(&folder).ok(),
                "{name}: {text}"
            );
            assert!(parts[1].starts_with("state"), "{name}: {text}");
            // The console's own variable is gone before the code runs, and so is an agent's.
            assert_eq!(parts[2], "", "{name}: {text}");
        }
        // A batch file stays while its Command Prompt reads it, and goes when the console closes.
        let launched = launch_native(
            &kept,
            &folder,
            "Agent Studio - test",
            Shell::Cmd,
            "rem waiting",
            true,
        )
        .unwrap();
        let pid = launched.console.pid.to_string();
        let batch = launched.kept.clone().unwrap();
        assert_eq!(stayed_open(launched).unwrap().shell, "Command Prompt");
        assert!(batch.exists());
        close(&pid);
        for _ in 0..100 {
            if !batch.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!batch.exists(), "The batch file outlived its console");
        // PowerShell and Git Bash deleted the code they read.
        let left: Vec<_> = std::fs::read_dir(&kept)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "launch.sh" && !name.ends_with(".cmd"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in: runs a real console in the first WSL distribution, without showing its window"]
    async fn a_real_wsl_console_runs_the_code_in_the_folder_and_stays_open() {
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
        let distribution = String::from_utf16_lossy(&listed)
            .lines()
            .map(str::trim)
            .find(|name| !name.is_empty())
            .expect("Install a WSL distribution first")
            .to_string();
        let inside = |script: &str, argument: &str| {
            let output = std::process::Command::new("wsl.exe")
                .args([
                    "--distribution",
                    &distribution,
                    "--exec",
                    "bash",
                    "-c",
                    script,
                    "x",
                    argument,
                ])
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let id = uuid::Uuid::new_v4();
        let folder = format!("/tmp/studio {id} 'quoted' $(literal) ñ");
        inside("mkdir -p -- \"$1\"", &folder);
        // The shell that follows the code is the one process started with what the code
        // exported, so it reports where it is and how it was started.
        let code = format!("export STUDIO_TEST={id} KEPT='state \"kept\" ñ'\nexit 3");
        let report = "for environ in /proc/[0-9]*/environ; do
  if grep -qa \"STUDIO_TEST=$1\" \"$environ\" 2>/dev/null; then
    pid=${environ#/proc/}
    pid=${pid%/environ}
    printf '%s|%s|done' \"$(readlink \"/proc/$pid/cwd\")\" \"$(tr '\\0' ' ' < \"/proc/$pid/cmdline\")\"
    exit
  fi
done";
        let launched = launch_distribution(
            distribution.clone(),
            folder.clone(),
            "Agent Studio - test".into(),
            code,
            true,
        )
        .await
        .unwrap();
        assert_eq!(launched.name, distribution);
        let _closing = Closing(launched.console.pid);
        let text = written(|| Some(inside(report, &id.to_string())));
        let open = launched.console.closed_within(1000).is_none();
        let left = inside("ls -d /tmp/agent-studio-console.* 2>/dev/null | wc -l", "");
        inside("rm -rf -- \"$1\"", &folder);
        assert!(open, "The WSL console closed after its code");
        assert!(
            text.starts_with(&format!("{folder}|")) && text.contains(" -l -i"),
            "{text}"
        );
        assert_eq!(left.trim(), "0");
    }
}
