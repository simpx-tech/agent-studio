//! Keep Claude Code current on this computer. See docs/UPDATES.md.
//!
//! Claude Code updates itself only from its interactive terminal, and Agent Studio always runs
//! it headless, so a CLI used through Agent Studio alone kept the version it was installed with,
//! and with it the models its aliases mean: 2.1.278 runs Opus 5 for `opus` where 2.1.281 runs
//! Opus 5.5. This runs the CLI's own `claude update`, which follows its release channel and any
//! version policy and verifies the signed build before swapping it in, a minute after the app
//! starts and every six hours: for this computer's CLI, and for a WSL distribution only while it
//! already runs, so an automatic check never starts one.
use crate::providers::Executable;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    process::Stdio,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt};

const EVENT: &str = "studio-cli-update";
const FIRST_CHECK: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(30 * 60);
const CHECK_EVERY_MS: u64 = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS: u64 = 60 * 60 * 1000;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const VERSION_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: u64 = 64 * 1024;
const MESSAGE_LIMIT: usize = 240;
const SETTINGS_FILE: &str = "cli-updates.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Checking,
    /// Up to date, or held at its version by a release channel or version policy.
    Current,
    Updated,
    /// Another Claude Code update held the install lock; the next check retries.
    Busy,
    /// A package manager owns this installation (Homebrew, winget, apk).
    Managed,
    /// An administrator turned Claude Code updates off.
    Blocked,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    environment_id: String,
    phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// The version an update replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    automatic: bool,
    /// Why automatic checks are off although the setting is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<&'static str>,
    statuses: Vec<Status>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    automatic: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self { automatic: true }
    }
}

#[derive(Default)]
struct Inner {
    /// Read from app data on first use.
    settings: Option<Settings>,
    statuses: BTreeMap<String, Status>,
}

#[derive(Default)]
pub struct CliUpdates {
    inner: Mutex<Inner>,
    checking: tokio::sync::Mutex<()>,
}
impl CliUpdates {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Claude Code's own switch for automatic updates also stops Agent Studio's.
fn environment_notice(value: Option<std::ffi::OsString>) -> Option<&'static str> {
    let value = value?.to_string_lossy().trim().to_ascii_lowercase();
    (!["", "0", "false", "no", "off"].contains(&value.as_str())).then_some(
        "DISABLE_AUTOUPDATER is set for Agent Studio, so it leaves Claude Code as it is. Check for updates still runs it.",
    )
}

fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<CliUpdates>();
    let inner = state.lock();
    Snapshot {
        automatic: inner.settings.clone().unwrap_or_default().automatic,
        notice: environment_notice(std::env::var_os("DISABLE_AUTOUPDATER")),
        statuses: inner.statuses.values().cloned().collect(),
    }
}

fn record(app: &AppHandle, status: Status) {
    app.state::<CliUpdates>()
        .lock()
        .statuses
        .insert(status.environment_id.clone(), status);
    let _ = app.emit(EVENT, snapshot(app));
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate Claude Code update settings")?
        .join(SETTINGS_FILE))
}

async fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    if let Some(settings) = app.state::<CliUpdates>().lock().settings.clone() {
        return Ok(settings);
    }
    let path = settings_path(app)?;
    let settings = tauri::async_runtime::spawn_blocking(move || match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= 10_000 => serde_json::from_slice::<Settings>(&bytes)
            .map_err(|_| "Cannot read Claude Code update settings".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        _ => Err("Cannot read Claude Code update settings".into()),
    })
    .await
    .map_err(|_| "Cannot read Claude Code update settings")??;
    app.state::<CliUpdates>().lock().settings = Some(settings.clone());
    Ok(settings)
}

async fn save_settings(app: &AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let saved = settings.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = path
            .parent()
            .ok_or("Cannot locate Claude Code update settings")?;
        std::fs::create_dir_all(root).map_err(|_| "Cannot save Claude Code update settings")?;
        let mut file = tempfile::NamedTempFile::new_in(root)
            .map_err(|_| "Cannot save Claude Code update settings")?;
        file.write_all(&serde_json::to_vec(&saved).map_err(|_| "Cannot encode settings")?)
            .map_err(|_| "Cannot save Claude Code update settings")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot save Claude Code update settings")?;
        file.persist(path)
            .map_err(|_| "Cannot finish saving Claude Code update settings")?;
        Ok(())
    })
    .await
    .map_err(|_| "Cannot save Claude Code update settings")??;
    app.state::<CliUpdates>().lock().settings = Some(settings);
    Ok(())
}

/// Check a minute after startup, then look every half hour for installations whose last check
/// is six hours old, or an hour after a failed one.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let automatic = load_settings(&app).await.is_ok_and(|s| s.automatic);
            if automatic && environment_notice(std::env::var_os("DISABLE_AUTOUPDATER")).is_none() {
                check(&app, false).await;
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

fn due(status: Option<&Status>, now: u64) -> bool {
    let Some(checked_at) = status.and_then(|status| status.checked_at) else {
        return true;
    };
    let wait = match status.map(|status| status.phase) {
        Some(Phase::Failed | Phase::Busy) => RETRY_AFTER_MS,
        _ => CHECK_EVERY_MS,
    };
    now.saturating_sub(checked_at) >= wait
}

/// This computer's Claude Code and, on Windows, that of each WSL distribution already running.
async fn installations(app: &AppHandle) -> Vec<(String, Executable)> {
    let Ok(installation) = crate::profiles::installation(app) else {
        return vec![];
    };
    let mut found = vec![];
    // Outside any connection's scope this is the CLI on PATH, which every profile shares.
    if let Ok(exe) = crate::providers::resolve("claude").await {
        found.push((installation.id.clone(), exe));
    }
    #[cfg(windows)]
    if let Ok(discovery) = crate::wsl::discover(&installation.id).await {
        for distribution in discovery.distributions {
            if distribution.running != Some(true) {
                continue;
            }
            let Ok(profile) = crate::profiles::resolve(app, "claude", None) else {
                continue;
            };
            let resolved =
                crate::profiles::scope(profile, crate::wsl::resolve("claude", &distribution.name));
            if let Ok(exe) = resolved.await {
                found.push((distribution.id, exe));
            }
        }
    }
    found
}

/// Update every installation that is due, or all of them when asked to.
async fn check(app: &AppHandle, forced: bool) -> Snapshot {
    // A check requested during a background one reports the one already running.
    let state = app.state::<CliUpdates>();
    let Ok(_checking) = state.checking.try_lock() else {
        return snapshot(app);
    };
    for (environment_id, exe) in installations(app).await {
        let previous = app
            .state::<CliUpdates>()
            .lock()
            .statuses
            .get(&environment_id)
            .cloned();
        if !forced && !due(previous.as_ref(), now()) {
            continue;
        }
        record(
            app,
            Status {
                environment_id: environment_id.clone(),
                phase: Phase::Checking,
                version: previous.and_then(|status| status.version),
                previous: None,
                checked_at: None,
                message: None,
            },
        );
        let before = version(&exe).await;
        let run = run(&exe, &["update"], UPDATE_TIMEOUT).await;
        let after = version(&exe).await;
        record(app, outcome(environment_id, before, after, run, now()));
    }
    snapshot(app)
}

struct Output {
    success: bool,
    text: String,
}

async fn read(stream: Option<impl AsyncRead + Unpin>) -> String {
    let mut bytes = Vec::new();
    if let Some(stream) = stream {
        let _ = stream.take(OUTPUT_LIMIT).read_to_end(&mut bytes).await;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Run the CLI without input, keeping the beginning of what it printed.
async fn run(exe: &Executable, args: &[&str], limit: Duration) -> Result<Output, String> {
    let mut command = exe.command();
    command
        .args(args)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Claude Code".to_string())?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let finished = tokio::time::timeout(limit, async {
        let (stdout, stderr) = tokio::join!(read(stdout), read(stderr));
        (child.wait().await, stdout, stderr)
    })
    .await;
    match finished {
        Ok((Ok(status), stdout, stderr)) => Ok(Output {
            success: status.success(),
            text: plain(&format!("{stdout}\n{stderr}")),
        }),
        Ok((Err(_), ..)) => Err("Claude Code stopped unexpectedly.".into()),
        Err(_) => {
            exe.kill(&mut child).await;
            Err("Claude Code did not finish updating in time.".into())
        }
    }
}

async fn version(exe: &Executable) -> Option<String> {
    let output = run(exe, &["--version"], VERSION_TIMEOUT).await.ok()?;
    output
        .success
        .then(|| parse_version(&output.text))
        .flatten()
}

/// `2.1.278 (Claude Code)` → `2.1.278`.
fn parse_version(text: &str) -> Option<String> {
    let token = text.split_whitespace().next()?;
    let valid = token.len() <= 40
        && token.starts_with(|c: char| c.is_ascii_digit())
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
    valid.then(|| token.to_string())
}

/// Printable text without terminal color sequences or carriage-return redraws.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if c == '\n' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

fn bounded(line: &str) -> String {
    let line = line.trim();
    if line.chars().count() <= MESSAGE_LIMIT {
        return line.to_string();
    }
    let mut short: String = line.chars().take(MESSAGE_LIMIT - 1).collect();
    short.push('…');
    short
}

fn line_with<'a>(text: &'a str, needle: &str) -> Option<&'a str> {
    text.lines().find(|line| line.contains(needle))
}

/// Read one `claude update` from the versions before and after it and from its own messages
/// (Claude Code 2.1.278).
fn outcome(
    environment_id: String,
    before: Option<String>,
    after: Option<String>,
    run: Result<Output, String>,
    checked_at: u64,
) -> Status {
    let mut status = Status {
        environment_id,
        phase: Phase::Current,
        version: after.clone().or(before.clone()),
        previous: None,
        checked_at: Some(checked_at),
        message: None,
    };
    let output = match run {
        Ok(output) => output,
        Err(message) => {
            status.phase = Phase::Failed;
            status.message = Some(message);
            return status;
        }
    };
    let text = output.text.as_str();
    let changed = matches!((&before, &after), (Some(before), Some(after)) if before != after);
    // The message counts only when the version before the run is unknown.
    if changed || (before.is_none() && after.is_some() && text.contains("Successfully updated")) {
        status.phase = Phase::Updated;
        status.previous = before.filter(|before| Some(before) != after.as_ref());
    } else if let Some(line) =
        line_with(text, "is managed by").or_else(|| line_with(text, "managed by a package manager"))
    {
        status.phase = Phase::Managed;
        let command = text.lines().map(str::trim).find(|line| {
            ["brew upgrade", "winget upgrade", "apk upgrade"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        });
        status.message = Some(bounded(&match command {
            Some(command) => format!("{} Update it with {command}.", line.trim()),
            None => line.to_string(),
        }));
    } else if text.contains("disabled by your administrator") {
        status.phase = Phase::Blocked;
        status.message = Some("Your administrator turned Claude Code updates off.".into());
    } else if text.contains("is currently running. Please try again") {
        status.phase = Phase::Busy;
        status.message = Some(
            "Another Claude Code update was running. Agent Studio tries again in an hour.".into(),
        );
    } else if !output.success {
        status.phase = Phase::Failed;
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with("Current version")
                    && !line.starts_with("Checking for updates")
                    && !line.starts_with("Try running")
            })
            .collect();
        // The error and its reason, not the warnings printed before them.
        let start = lines
            .iter()
            .position(|line| line.contains("rror") || line.contains("ailed"))
            .unwrap_or(lines.len().saturating_sub(2));
        let reason = lines[start..].iter().take(2).copied().collect::<Vec<_>>();
        status.message = Some(if reason.is_empty() {
            "Claude Code could not update.".into()
        } else {
            bounded(&reason.join(" "))
        });
    } else {
        // Up to date, or held back by a release channel, a version policy or a release that
        // predates signed builds: those print why the version stays.
        status.message = ["Staying on", "newer than the", "predates release-signature"]
            .iter()
            .find_map(|needle| line_with(text, needle))
            .map(bounded);
    }
    status
}

#[tauri::command]
pub async fn cli_update_status(app: AppHandle) -> Result<Snapshot, String> {
    load_settings(&app).await?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn set_cli_auto_update(app: AppHandle, automatic: bool) -> Result<Snapshot, String> {
    save_settings(&app, Settings { automatic }).await?;
    let _ = app.emit(EVENT, snapshot(&app));
    if automatic && environment_notice(std::env::var_os("DISABLE_AUTOUPDATER")).is_none() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            check(&app, false).await;
        });
    }
    Ok(snapshot(&app))
}

/// Check every installation now, including a WSL distribution the automatic check skipped
/// because it was not running.
#[tauri::command]
pub async fn check_cli_updates(app: AppHandle) -> Result<Snapshot, String> {
    load_settings(&app).await?;
    Ok(check(&app, true).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(success: bool, text: &str) -> Result<Output, String> {
        Ok(Output {
            success,
            text: plain(text),
        })
    }
    fn read_out(before: Option<&str>, after: Option<&str>, run: Result<Output, String>) -> Status {
        outcome(
            "env".into(),
            before.map(String::from),
            after.map(String::from),
            run,
            7,
        )
    }

    #[test]
    fn versions_come_from_the_version_flag() {
        assert_eq!(
            parse_version("2.1.278 (Claude Code)\n").as_deref(),
            Some("2.1.278")
        );
        assert_eq!(parse_version("2.2.0-rc.1").as_deref(), Some("2.2.0-rc.1"));
        for text in [
            "",
            "Claude Code 2.1.278",
            "error: unknown option",
            "2.1.278;rm",
        ] {
            assert_eq!(parse_version(text), None, "{text}");
        }
    }

    #[test]
    fn an_update_is_read_from_the_versions_around_it() {
        let status = read_out(
            Some("2.1.278"),
            Some("2.1.283"),
            ok(true, "Current version: 2.1.278\nChecking for updates to latest version...\nSuccessfully updated from 2.1.278 to version 2.1.283\n"),
        );
        assert_eq!(status.phase, Phase::Updated);
        assert_eq!(status.version.as_deref(), Some("2.1.283"));
        assert_eq!(status.previous.as_deref(), Some("2.1.278"));
        assert_eq!(status.checked_at, Some(7));
        // A changed version counts even when the message wording changes.
        let status = read_out(Some("2.1.278"), Some("2.1.283"), ok(true, "Done."));
        assert_eq!(status.phase, Phase::Updated);
        let current = read_out(
            Some("2.1.283"),
            Some("2.1.283"),
            ok(true, "Current version: 2.1.283\n\u{1b}[32mClaude Code is up to date (2.1.283)\u{1b}[39m\n"),
        );
        assert_eq!(current.phase, Phase::Current);
        assert_eq!(current.version.as_deref(), Some("2.1.283"));
        assert_eq!((current.previous, current.message), (None, None));
    }

    #[test]
    fn held_busy_managed_blocked_and_failed_updates_say_why() {
        let held = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(
                true,
                "The stable channel is at 2.1.270, which is older. Staying on 2.1.278.\n",
            ),
        );
        assert_eq!(held.phase, Phase::Current);
        assert!(held.message.unwrap().contains("Staying on 2.1.278"));
        let busy = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Another Claude process (PID 42) is currently running. Please try again in a moment.\n"),
        );
        assert_eq!(busy.phase, Phase::Busy);
        let managed = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Current version: 2.1.278\n\nClaude is managed by winget.\nUpdate available: 2.1.278 → 2.1.283\n\nTo update, run:\n  winget upgrade Anthropic.ClaudeCode\n"),
        );
        assert_eq!(managed.phase, Phase::Managed);
        assert_eq!(
            managed.message.as_deref(),
            Some(
                "Claude is managed by winget. Update it with winget upgrade Anthropic.ClaudeCode."
            )
        );
        let blocked = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(true, "Updates are disabled by your administrator. Contact your IT team to get the latest version.\n"),
        );
        assert_eq!(blocked.phase, Phase::Blocked);
        let failed = read_out(
            Some("2.1.278"),
            Some("2.1.278"),
            ok(false, "Current version: 2.1.278\nChecking for updates to latest version...\nError: Failed to install native update\nEPERM: operation not permitted\nTry running \"claude doctor\" for diagnostics\n"),
        );
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(
            failed.message.as_deref(),
            Some("Error: Failed to install native update EPERM: operation not permitted")
        );
        assert_eq!(failed.version.as_deref(), Some("2.1.278"));
        let silent = read_out(None, None, ok(false, ""));
        assert_eq!(
            silent.message.as_deref(),
            Some("Claude Code could not update.")
        );
        let timeout = read_out(Some("2.1.278"), None, Err("timed out".into()));
        assert_eq!(timeout.phase, Phase::Failed);
        assert_eq!(timeout.version.as_deref(), Some("2.1.278"));
        let long = read_out(None, None, ok(false, &"x".repeat(1000)));
        assert_eq!(long.message.unwrap().chars().count(), MESSAGE_LIMIT);
    }

    #[test]
    fn checks_repeat_every_six_hours_and_retry_failures_after_one() {
        let status = |phase, checked_at| Status {
            environment_id: "env".into(),
            phase,
            version: None,
            previous: None,
            checked_at,
            message: None,
        };
        let hour = 60 * 60 * 1000;
        assert!(due(None, 0));
        assert!(due(Some(&status(Phase::Checking, None)), 0));
        assert!(!due(Some(&status(Phase::Current, Some(0))), 5 * hour));
        assert!(due(Some(&status(Phase::Current, Some(0))), 6 * hour));
        assert!(!due(Some(&status(Phase::Updated, Some(0))), hour));
        for phase in [Phase::Failed, Phase::Busy] {
            assert!(!due(Some(&status(phase, Some(0))), hour - 1));
            assert!(due(Some(&status(phase, Some(0))), hour));
        }
    }

    #[test]
    fn claude_codes_own_switch_turns_automatic_checks_off() {
        assert_eq!(environment_notice(None), None);
        for value in ["", "0", "false", "OFF", " no "] {
            assert_eq!(environment_notice(Some(value.into())), None, "{value}");
        }
        for value in ["1", "true", "yes"] {
            assert!(environment_notice(Some(value.into())).is_some(), "{value}");
        }
    }

    #[test]
    fn settings_default_to_automatic_and_serialize_plainly() {
        assert_eq!(
            serde_json::from_str::<Settings>("{}").unwrap(),
            Settings { automatic: true }
        );
        assert_eq!(
            serde_json::to_value(Settings { automatic: false }).unwrap(),
            serde_json::json!({"automatic": false})
        );
        let status = read_out(Some("1.0.0"), Some("1.1.0"), ok(true, ""));
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({"environmentId":"env","phase":"updated","version":"1.1.0","previous":"1.0.0","checkedAt":7})
        );
    }

    /// A stand-in CLI whose version file `update` rewrites, run through the same process path.
    #[tokio::test]
    async fn a_run_reads_the_update_and_the_new_version_from_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("version.txt"), "2.1.278").unwrap();
        #[cfg(windows)]
        let exe = {
            let script = dir.path().join("claude.ps1");
            std::fs::write(
                &script,
                "$command = $args[0]\n$file = Join-Path $PSScriptRoot 'version.txt'\nif ($command -eq '--version') { Write-Output \"$(Get-Content $file) (Claude Code)\"; exit 0 }\nif ($command -eq 'update') { Write-Output \"Current version: $(Get-Content $file)\"; Set-Content -Path $file -Value '2.1.283' -NoNewline; Write-Output 'Successfully updated from 2.1.278 to version 2.1.283'; exit 0 }\nexit 2\n",
            )
            .unwrap();
            Executable {
                provider: "claude".into(),
                program: "powershell.exe".into(),
                prefix: vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    script.to_string_lossy().into_owned(),
                ],
                wsl: None,
            }
        };
        #[cfg(not(windows))]
        let exe = {
            let script = dir.path().join("claude.sh");
            std::fs::write(
                &script,
                "file=\"$(dirname \"$0\")/version.txt\"\ncase \"$1\" in\n--version) echo \"$(cat \"$file\") (Claude Code)\";;\nupdate) echo \"Current version: $(cat \"$file\")\"; printf 2.1.283 > \"$file\"; echo 'Successfully updated from 2.1.278 to version 2.1.283';;\n*) exit 2;;\nesac\n",
            )
            .unwrap();
            Executable {
                provider: "claude".into(),
                program: "sh".into(),
                prefix: vec![script.to_string_lossy().into_owned()],
                wsl: None,
            }
        };
        let before = version(&exe).await;
        assert_eq!(before.as_deref(), Some("2.1.278"));
        let result = run(&exe, &["update"], Duration::from_secs(60)).await;
        let after = version(&exe).await;
        let status = outcome("env".into(), before, after, result, 1);
        assert_eq!(status.phase, Phase::Updated);
        assert_eq!(status.version.as_deref(), Some("2.1.283"));
        assert_eq!(status.previous.as_deref(), Some("2.1.278"));
        // An unknown command fails without output and is reported as such.
        let failed = run(&exe, &["unknown"], Duration::from_secs(60))
            .await
            .unwrap();
        assert!(!failed.success);
    }
}
