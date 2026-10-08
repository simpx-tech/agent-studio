//! Keeps a record of freezes between the window and this process on this computer, so one like
//! the hour on 2026-10-08, when the window's buttons and every call from the page went
//! unanswered while replies ran on, can be traced to what held it. A thread checks every second
//! that the window thread runs a task posted to it, and that the page keeps calling
//! `window_heartbeat` while it is shown. When either stops for long enough, counting only time
//! the computer was awake, it writes a report to app data `diagnostics/` and, on Windows, has a
//! helper process (`--write-minidump`) save where every thread of this process was; the report
//! then records when the freeze ended. A page that found this process not answering leaves its
//! own record of the calls it waited on (`record_window_stall`). Nothing here leaves this
//! computer: not the workspace, sync, exports or prompts. See docs/DIAGNOSTICS.md.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

/// How long the window thread may leave a posted task waiting.
const STALL: Duration = Duration::from_secs(10);
/// How long a shown page may go without calling.
const SILENCE: Duration = Duration::from_secs(60);
/// One wait of the watch. One that took far longer means the computer slept, which counts for
/// nothing.
const SLICE: Duration = Duration::from_secs(1);
const ASLEEP: Duration = Duration::from_secs(5);
/// Posting that fails this many times in a row, a second apart, is reported.
const FAILED_POSTS: u32 = 3;
const KEEP_REPORTS: usize = 30;
const KEEP_DUMPS: usize = 3;
const FOLDER: &str = "diagnostics";
/// Starts the helper that saves a minidump of this process.
pub const DUMP: &str = "--write-minidump";

/// What the page last said: how many times it called, and whether it was shown then.
#[derive(Default)]
pub struct Watchdog {
    beats: AtomicU64,
    visible: AtomicBool,
    /// The app is ending, when the window thread stops taking tasks on purpose.
    ending: AtomicBool,
}

/// Ends the watch as the app ends.
pub fn stop(app: &AppHandle) {
    if let Some(watchdog) = app.try_state::<Watchdog>() {
        watchdog.ending.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn window_heartbeat(watchdog: State<'_, Watchdog>, visible: bool) -> Result<(), String> {
    watchdog.visible.store(visible, Ordering::SeqCst);
    watchdog.beats.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

/// A call the page was still waiting for when it found this process not answering.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitingCall {
    command: String,
    waited_ms: u64,
}

/// The page's record of a time this process did not answer it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowStall {
    /// When the page noticed, in milliseconds since 1970.
    noticed_at: u64,
    /// How long its check had gone unanswered then.
    unanswered_ms: u64,
    /// Whether the check was answered later, rather than the page reloading or the app ending.
    answered_after_ms: Option<u64>,
    calls: Vec<WaitingCall>,
}

impl WindowStall {
    fn validate(&self) -> Result<(), String> {
        let command = regex::Regex::new(r"^[a-z0-9_:|-]{1,80}$").expect("constant pattern");
        if self.calls.len() > 100 || self.calls.iter().any(|c| !command.is_match(&c.command)) {
            return Err("Invalid stall record".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn record_window_stall(app: AppHandle, stall: WindowStall) -> Result<(), String> {
    stall.validate()?;
    let folder = folder(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let report = Report {
            kind: "windowCalls",
            detected_at: rfc3339(stall.noticed_at),
            after_ms: stall.unanswered_ms,
            version: version(),
            process_id: std::process::id(),
            visible: true,
            dump: None,
            dump_error: None,
            recovered_after_ms: stall.answered_after_ms,
            calls: stall.calls,
        };
        report.write(&folder, &stamp(stall.noticed_at))
    })
    .await
    .map_err(|_| "Cannot keep the stall record".to_string())?
}

/// Starts the watch. It runs until the window thread stops taking tasks for good, as the app
/// ends.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || watch(&app));
}

fn watch(app: &AppHandle) {
    let watchdog = app.state::<Watchdog>();
    let mut silence = Silence::default();
    let mut last_step = Instant::now();
    let mut failed_posts = 0;
    let mut queue_report = false;
    loop {
        if watchdog.ending.load(Ordering::SeqCst) {
            return;
        }
        let (answer, answered) = mpsc::channel::<()>();
        if app
            .run_on_main_thread(move || {
                let _ = answer.send(());
            })
            .is_err()
        {
            // Its queue is full, or the app is ending and the process with it.
            failed_posts += 1;
            if failed_posts == FAILED_POSTS
                && !queue_report
                && !watchdog.ending.load(Ordering::SeqCst)
            {
                queue_report = true;
                let visible = watchdog.visible.load(Ordering::SeqCst);
                freeze(app, "windowQueue", SLICE * FAILED_POSTS, visible);
            }
            std::thread::sleep(SLICE);
            continue;
        }
        failed_posts = 0;
        queue_report = false;
        let mut waited = Duration::ZERO;
        let mut stalled = None;
        loop {
            let slice = Instant::now();
            match answered.recv_timeout(SLICE) {
                Ok(()) => break,
                // The task was dropped unrun: the window thread has ended.
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            waited += awake(slice.elapsed());
            if stalled.is_none() && waited >= STALL && !watchdog.ending.load(Ordering::SeqCst) {
                let started = Instant::now();
                let visible = watchdog.visible.load(Ordering::SeqCst);
                stalled = freeze(app, "windowThread", waited, visible);
                // Saving the dump took a while of the stall.
                waited += started.elapsed();
            }
        }
        if let Some((folder, stamp, report)) = stalled {
            report.recovered(&folder, &stamp, waited);
            // The stuck window thread silenced the page too, under its own report.
            silence.restart();
            last_step = Instant::now();
        } else {
            let beats = watchdog.beats.load(Ordering::SeqCst);
            let visible = watchdog.visible.load(Ordering::SeqCst);
            let took = std::mem::replace(&mut last_step, Instant::now()).elapsed();
            match silence.step(beats, visible, awake(took)) {
                Step::Quiet => {}
                Step::Silent(after) => silence.report = freeze(app, "windowSilent", after, true),
                Step::Heard(after) => {
                    if let Some((folder, stamp, report)) = silence.report.take() {
                        report.recovered(&folder, &stamp, after);
                    }
                }
            }
        }
        std::thread::sleep(SLICE);
    }
}

/// Time a wait took, unless the computer slept through it.
fn awake(took: Duration) -> Duration {
    if took > ASLEEP {
        Duration::ZERO
    } else {
        took
    }
}

/// How long a shown page has gone without calling.
#[derive(Default)]
struct Silence {
    beats: u64,
    quiet: Duration,
    silent: bool,
    report: Option<(PathBuf, String, Report)>,
}

#[derive(Debug, PartialEq)]
enum Step {
    Quiet,
    /// The page has not called for this long while shown.
    Silent(Duration),
    /// The page called again after being silent for this long.
    Heard(Duration),
}

impl Silence {
    fn step(&mut self, beats: u64, visible: bool, awake: Duration) -> Step {
        if beats != self.beats {
            self.beats = beats;
            let quiet = std::mem::take(&mut self.quiet);
            return if std::mem::take(&mut self.silent) {
                Step::Heard(quiet + awake)
            } else {
                Step::Quiet
            };
        }
        // Before its first call, and while hidden, a page owes no calls.
        if beats == 0 || !visible {
            self.quiet = Duration::ZERO;
            return Step::Quiet;
        }
        self.quiet += awake;
        if !self.silent && self.quiet >= SILENCE {
            self.silent = true;
            return Step::Silent(self.quiet);
        }
        Step::Quiet
    }
    /// The window thread was stuck, which silences the page too and has its own report.
    fn restart(&mut self) {
        self.quiet = Duration::ZERO;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    /// `windowThread`, `windowQueue`, `windowSilent` or `windowCalls`.
    kind: &'static str,
    detected_at: String,
    after_ms: u64,
    version: String,
    process_id: u32,
    /// Whether the page last said it was shown.
    visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    dump: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dump_error: Option<String>,
    recovered_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    calls: Vec<WaitingCall>,
}

impl Report {
    fn write(&self, folder: &Path, stamp: &str) -> Result<(), String> {
        std::fs::create_dir_all(folder).map_err(|_| "Cannot create the diagnostics folder")?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|_| "Cannot encode the report")?;
        std::fs::write(folder.join(format!("{stamp}-{}.json", self.kind)), bytes)
            .map_err(|_| "Cannot write the report")?;
        prune(folder, ".json", KEEP_REPORTS);
        Ok(())
    }
    fn recovered(mut self, folder: &Path, stamp: &str, after: Duration) {
        self.recovered_after_ms = Some(millis(after));
        let _ = self.write(folder, stamp);
    }
}

/// Writes a report of a freeze and a minidump of this process, returning it to complete when
/// the freeze ends.
fn freeze(
    app: &AppHandle,
    kind: &'static str,
    after: Duration,
    visible: bool,
) -> Option<(PathBuf, String, Report)> {
    let folder = folder(app).ok()?;
    let at = now_ms();
    let stamp = stamp(at);
    let mut report = Report {
        kind,
        detected_at: rfc3339(at),
        after_ms: millis(after),
        version: version(),
        process_id: std::process::id(),
        visible,
        dump: None,
        dump_error: None,
        recovered_after_ms: None,
        calls: vec![],
    };
    // The report first, in case saving the dump is what fails to finish.
    let _ = report.write(&folder, &stamp);
    match dump(&folder, &format!("{stamp}-{kind}")) {
        Ok(name) => report.dump = Some(name),
        Err(error) => report.dump_error = Some(error),
    }
    let _ = report.write(&folder, &stamp);
    Some((folder, stamp, report))
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join(FOLDER))
}

fn version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(millis)
        .unwrap_or(0)
}

fn rfc3339(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// A file name prefix that sorts by time.
fn stamp(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|at| at.format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// Keeps the newest `keep` files ending in `suffix`.
fn prune(folder: &Path, suffix: &str, keep: usize) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut names: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(suffix))
        .collect();
    names.sort();
    let extra = names.len().saturating_sub(keep);
    for name in &names[..extra] {
        let _ = std::fs::remove_file(folder.join(name));
    }
}

/// A file name the dump helper accepts: the stamp and kind this module writes.
fn valid_name(name: &str) -> bool {
    (1..=80).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Has the helper save a minidump of this process, returning its file name.
#[cfg(windows)]
fn dump(folder: &Path, name: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|_| "Cannot locate the app")?;
    let mut helper = std::process::Command::new(exe)
        .args([DUMP, &std::process::id().to_string(), name])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|_| "Cannot start the minidump helper")?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match helper.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err("The minidump helper failed".into()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = helper.kill();
                return Err("The minidump helper did not finish".into());
            }
        }
    }
    prune(folder, ".dmp", KEEP_DUMPS);
    Ok(format!("{name}.dmp"))
}

#[cfg(not(windows))]
fn dump(_folder: &Path, _name: &str) -> Result<String, String> {
    Err("Minidumps are saved on Windows only".into())
}

/// The helper: saves a minidump of the app process `args` names into this app's diagnostics
/// folder, under a name the watch chose. It dumps only a process running this same program.
#[cfg(windows)]
pub fn dump_main(data: &Path, args: &[String]) -> i32 {
    match write_dump(data, args) {
        Ok(()) => 0,
        Err(_) => 2,
    }
}

#[cfg(windows)]
fn write_dump(data: &Path, args: &[String]) -> Result<(), &'static str> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Diagnostics::Debug::{
                MiniDumpWithHandleData, MiniDumpWithProcessThreadData, MiniDumpWithThreadInfo,
                MiniDumpWithUnloadedModules, MiniDumpWriteDump,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_DUP_HANDLE,
                PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
            },
        },
    };
    let [pid, name] = args else {
        return Err("Expected a process and a name");
    };
    let pid: u32 = pid.parse().map_err(|_| "Invalid process")?;
    if !valid_name(name) {
        return Err("Invalid name");
    }
    let folder = data.join(FOLDER);
    if !folder.is_dir() {
        return Err("No diagnostics folder");
    }
    let own = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|_| "Cannot locate this program")?;
    // SAFETY: the handle is checked, used for this process only and closed below.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE,
            0,
            pid,
        )
    };
    if process.is_null() {
        return Err("Cannot open the process");
    }
    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: closes the handle OpenProcess returned, once.
            unsafe { CloseHandle(self.0) };
        }
    }
    let process = Owned(process);
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    // SAFETY: the buffer holds `length` UTF-16 units, which the call updates.
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err("Cannot read the process image");
    }
    let image = std::ffi::OsString::from_wide(&buffer[..length as usize]);
    if std::fs::canonicalize(image).ok().as_ref() != Some(&own) {
        return Err("Not this program");
    }
    let path = folder.join(format!("{name}.dmp"));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Cannot create the dump")?;
    // SAFETY: both handles stay open for the call; the optional streams are absent.
    let written = unsafe {
        MiniDumpWriteDump(
            process.0,
            pid,
            file.as_raw_handle() as HANDLE,
            MiniDumpWithHandleData
                | MiniDumpWithUnloadedModules
                | MiniDumpWithProcessThreadData
                | MiniDumpWithThreadInfo,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    drop(file);
    if written == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("Cannot write the dump");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn a_shown_page_is_reported_silent_once_and_heard_again() {
        let mut silence = Silence::default();
        // Before its first call a page owes none.
        for _ in 0..100 {
            assert_eq!(silence.step(0, true, SECOND), Step::Quiet);
        }
        assert_eq!(silence.step(1, true, SECOND), Step::Quiet);
        for _ in 1..60 {
            assert_eq!(silence.step(1, true, SECOND), Step::Quiet);
        }
        assert_eq!(silence.step(1, true, SECOND), Step::Silent(SILENCE));
        // One report per silence.
        assert_eq!(silence.step(1, true, SECOND), Step::Quiet);
        assert_eq!(
            silence.step(2, true, SECOND),
            Step::Heard(SILENCE + 2 * SECOND)
        );
        assert_eq!(silence.step(2, true, SECOND), Step::Quiet);
    }

    #[test]
    fn hidden_pages_and_sleep_owe_no_calls() {
        let mut silence = Silence::default();
        silence.step(1, true, SECOND);
        for _ in 0..1000 {
            assert_eq!(silence.step(1, false, SECOND), Step::Quiet);
        }
        // Time asleep arrives as zero.
        assert_eq!(awake(Duration::from_secs(3600)), Duration::ZERO);
        assert_eq!(awake(SECOND), SECOND);
        for _ in 0..1000 {
            assert_eq!(
                silence.step(1, true, awake(Duration::from_secs(600))),
                Step::Quiet
            );
        }
        // A stuck window thread has its own report and starts the count again.
        for _ in 0..59 {
            silence.step(1, true, SECOND);
        }
        silence.restart();
        assert_eq!(silence.step(1, true, SECOND), Step::Quiet);
    }

    #[test]
    fn reports_keep_the_newest_files_and_names_stay_simple() {
        let folder = tempfile::tempdir().unwrap();
        for second in 0..5 {
            let report = Report {
                kind: "windowThread",
                detected_at: rfc3339(second * 1000),
                after_ms: 10_000,
                version: version(),
                process_id: 1,
                visible: true,
                dump: None,
                dump_error: None,
                recovered_after_ms: None,
                calls: vec![],
            };
            report.write(folder.path(), &stamp(second * 1000)).unwrap();
        }
        std::fs::write(folder.path().join("a.dmp"), b"").unwrap();
        prune(folder.path(), ".json", 2);
        let mut names: Vec<_> = std::fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "1970-01-01T00-00-03-000Z-windowThread.json",
                "1970-01-01T00-00-04-000Z-windowThread.json",
                "a.dmp"
            ]
        );
        assert!(valid_name("1970-01-01T00-00-03-000Z-windowThread"));
        assert!(!valid_name("..\\escape"));
        assert!(!valid_name(""));
        assert!(!valid_name(&"a".repeat(81)));
    }

    #[test]
    fn stall_records_accept_only_bounded_command_names() {
        let stall = |command: &str| WindowStall {
            noticed_at: 0,
            unanswered_ms: 20_000,
            answered_after_ms: None,
            calls: vec![WaitingCall {
                command: command.into(),
                waited_ms: 1,
            }],
        };
        assert!(stall("save_workspace_patch").validate().is_ok());
        assert!(stall("plugin:window|start_dragging").validate().is_ok());
        assert!(stall("C:\\path").validate().is_err());
        assert!(stall("").validate().is_err());
        let mut many = stall("ping");
        many.calls = vec![many.calls[0].clone(); 101];
        assert!(many.validate().is_err());
        assert!(serde_json::from_value::<WindowStall>(serde_json::json!({
            "noticedAt": 0, "unansweredMs": 1, "answeredAfterMs": null, "calls": [], "extra": 1
        }))
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn the_dump_helper_refuses_other_programs_and_names() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir(data.path().join(FOLDER)).unwrap();
        let args = |pid: u32, name: &str| vec![pid.to_string(), name.to_string()];
        // The test runner is this program, but the name is not one the watch writes.
        assert!(write_dump(data.path(), &args(std::process::id(), "../x")).is_err());
        assert!(write_dump(data.path(), &args(std::process::id(), "a")).is_ok());
        assert!(
            data.path()
                .join(FOLDER)
                .join("a.dmp")
                .metadata()
                .unwrap()
                .len()
                > 0
        );
        // Another program, such as this computer's System process.
        assert!(write_dump(data.path(), &args(4, "b")).is_err());
        assert!(write_dump(data.path(), &["1".into()]).is_err());
    }
}
