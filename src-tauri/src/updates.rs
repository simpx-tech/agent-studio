//! Signed application updates published on GitHub Releases. See docs/UPDATES.md.
//!
//! Release installations check in the background and keep a verified package in memory.
//! Installing replaces the running app, so it waits for an explicit restart or an idle
//! close and never interrupts a reply running on this computer.
use serde::Serialize;
use std::{
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{utils::config::BundleType, AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

const EVENT: &str = "studio-app-update";
const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const MAX_NOTES: usize = 4_000;
const NOT_READY: &str = "No update is ready to install.";
const REPLY_RUNNING: &str = "Wait for running replies to finish, then restart to update.";
const INSTALL_FAILED: &str =
    "The update could not be installed. Try again, or download it from GitHub Releases.";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// This build cannot replace itself, such as a development or Linux package build.
    Unavailable,
    Idle,
    Checking,
    Current,
    Downloading,
    Ready,
    Installing,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current_version: String,
    phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'static str>,
    /// Restarting now would interrupt a reply running on this computer.
    replies_running: bool,
}

/// A downloaded package whose signature and signed version were verified.
pub struct Package {
    update: Update,
    bytes: Vec<u8>,
}

struct Inner {
    status: Status,
    package: Option<Box<Package>>,
}

pub struct Updates {
    inner: Mutex<Inner>,
    checking: tokio::sync::Mutex<()>,
}

impl Updates {
    pub fn new(current_version: String) -> Self {
        let bundle = tauri::utils::platform::bundle_type();
        Self::with(
            current_version,
            availability(cfg!(debug_assertions), bundle),
        )
    }
    fn with(current_version: String, availability: Result<(), &'static str>) -> Self {
        let (phase, message) = match availability {
            Ok(()) => (Phase::Idle, None),
            Err(reason) => (Phase::Unavailable, Some(reason)),
        };
        Self {
            inner: Mutex::new(Inner {
                status: Status {
                    current_version,
                    phase,
                    version: None,
                    notes: None,
                    downloaded: None,
                    total: None,
                    checked_at: None,
                    message,
                    replies_running: false,
                },
                package: None,
            }),
            checking: tokio::sync::Mutex::new(()),
        }
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Only installed release packages can replace themselves. Linux distribution packages
/// need a package manager, and unbundled binaries have no installer to run.
fn availability(debug: bool, bundle: Option<BundleType>) -> Result<(), &'static str> {
    if debug {
        return Err("Updates are off in development builds.");
    }
    match bundle {
        Some(BundleType::Nsis | BundleType::Msi | BundleType::AppImage | BundleType::App) => Ok(()),
        Some(BundleType::Deb | BundleType::Rpm) => Err(
            "Linux packages update with a new download. Use the AppImage for automatic updates.",
        ),
        _ => Err("This copy was not installed from a release package, so it cannot update itself."),
    }
}

/// Installing is allowed only for a verified package while no local reply is running.
fn install_gate(phase: Phase, replies_running: bool) -> Result<(), &'static str> {
    if phase != Phase::Ready {
        Err(NOT_READY)
    } else if replies_running {
        Err(REPLY_RUNNING)
    } else {
        Ok(())
    }
}

fn check_error(error: &Error) -> &'static str {
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::Http(_) => {
            "Could not reach GitHub to check for updates. Agent Studio will try again later."
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "The latest release has no update for this computer yet."
        }
        Error::ReleaseNotFound | Error::Serialization(_) | Error::Semver(_) => {
            "The latest release information could not be read."
        }
        _ => "Could not check for updates.",
    }
}

fn download_error(error: &Error) -> &'static str {
    match error {
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "The downloaded update failed signature verification and was discarded."
        }
        Error::Reqwest(_) | Error::Network(_) | Error::Http(_) => {
            "The update download did not finish. Agent Studio will try again later."
        }
        _ => "The update could not be downloaded.",
    }
}

/// Release notes are shown as plain text; keep them bounded and single-spaced.
fn notes(body: &str) -> Option<String> {
    let text: String = body
        .trim()
        .chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_NOTES)
        .collect();
    let text = text.trim_end().to_string();
    (!text.is_empty()).then_some(text)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn replies_running(app: &AppHandle) -> bool {
    app.state::<crate::runner::Runs>()
        .0
        .lock()
        .map(|runs| !runs.is_empty())
        .unwrap_or(true)
}

fn snapshot(app: &AppHandle) -> Status {
    let replies_running = replies_running(app);
    let mut status = app.state::<Updates>().lock().status.clone();
    status.replies_running = replies_running;
    status
}

fn set(app: &AppHandle, change: impl FnOnce(&mut Inner)) {
    change(&mut app.state::<Updates>().lock());
    let _ = app.emit(EVENT, snapshot(app));
}

/// Check once shortly after startup, then periodically, retrying sooner after a failure.
pub fn start(app: &AppHandle) {
    if app.state::<Updates>().lock().status.phase == Phase::Unavailable {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let status = check(&app).await;
            let wait = if status.phase == Phase::Failed {
                RETRY_AFTER
            } else {
                CHECK_EVERY
            };
            tokio::time::sleep(wait).await;
        }
    });
}

async fn check(app: &AppHandle) -> Status {
    let updates = app.state::<Updates>();
    // A manual check during a background check reports the one already running.
    let Ok(_checking) = updates.checking.try_lock() else {
        return snapshot(app);
    };
    {
        let mut inner = updates.lock();
        if matches!(
            inner.status.phase,
            Phase::Unavailable | Phase::Ready | Phase::Installing
        ) {
            drop(inner);
            return snapshot(app);
        }
        inner.status.phase = Phase::Checking;
        inner.status.message = None;
    }
    let _ = app.emit(EVENT, snapshot(app));
    let found = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let checked_at = Some(now());
    match found {
        Ok(Some(update)) => download(app, update, checked_at).await,
        Ok(None) => set(app, |inner| {
            let status = &mut inner.status;
            status.phase = Phase::Current;
            status.version = None;
            status.notes = None;
            status.downloaded = None;
            status.total = None;
            status.checked_at = checked_at;
        }),
        Err(error) => set(app, |inner| {
            inner.status.phase = Phase::Failed;
            inner.status.message = Some(check_error(&error));
        }),
    }
    snapshot(app)
}

async fn download(app: &AppHandle, mut update: Update, checked_at: Option<u64>) {
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let version = update.version.chars().take(64).collect::<String>();
    let notes = update.body.as_deref().and_then(notes);
    set(app, |inner| {
        let status = &mut inner.status;
        status.phase = Phase::Downloading;
        status.version = Some(version);
        status.notes = notes;
        status.downloaded = Some(0);
        status.total = None;
        status.checked_at = checked_at;
    });
    let mut received = 0u64;
    let mut reported = Instant::now();
    // The plugin verifies the signature and signed version before returning the bytes.
    let result = update
        .download(
            |chunk, total| {
                received = received.saturating_add(chunk as u64);
                if reported.elapsed() >= PROGRESS_EVERY {
                    reported = Instant::now();
                    set(app, |inner| {
                        inner.status.downloaded = Some(received);
                        inner.status.total = total;
                    });
                }
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => set(app, |inner| {
            let size = Some(bytes.len() as u64);
            inner.status.phase = Phase::Ready;
            inner.status.downloaded = size;
            inner.status.total = size;
            inner.package = Some(Box::new(Package { update, bytes }));
        }),
        Err(error) => set(app, |inner| {
            inner.status.phase = Phase::Failed;
            inner.status.message = Some(download_error(&error));
            inner.status.downloaded = None;
            inner.status.total = None;
        }),
    }
}

/// Launch the verified installer. Windows ends this process inside `install`; other
/// platforms replace the app in place, then relaunch or leave the caller to exit.
fn apply(app: &AppHandle, package: Box<Package>, relaunch: bool) -> Result<(), Box<Package>> {
    // Let an in-flight atomic workspace save finish before the installer ends this process.
    drop(app.state::<crate::Storage>().0.lock());
    let Package { update, bytes } = *package;
    let update = update.restart_after_install(relaunch);
    match update.install(&bytes) {
        Ok(()) => {
            if relaunch {
                app.restart();
            }
            Ok(())
        }
        Err(_) => Err(Box::new(Package { update, bytes })),
    }
}

/// Whether Restart to update is already stopping work before its installer runs.
pub fn installing(app: &AppHandle) -> bool {
    app.state::<Updates>().lock().status.phase == Phase::Installing
}

/// Take a ready update to install while an idle app closes. Closing during a reply keeps
/// the ordinary close; the next launch downloads the update again.
pub fn take_for_close(app: &AppHandle) -> Option<Box<Package>> {
    let running = replies_running(app);
    let updates = app.state::<Updates>();
    let mut inner = updates.lock();
    install_gate(inner.status.phase, running).ok()?;
    let package = inner.package.take()?;
    inner.status.phase = Phase::Installing;
    Some(package)
}

/// Install during close without relaunching. Returns whether the app should exit; a
/// failure discards the package so the window can close normally.
pub fn install_on_close(app: &AppHandle, package: Box<Package>) -> bool {
    if apply(app, package, false).is_ok() {
        return true;
    }
    set(app, |inner| {
        inner.status.phase = Phase::Failed;
        inner.status.message = Some(INSTALL_FAILED);
        inner.status.downloaded = None;
        inner.status.total = None;
    });
    false
}

#[tauri::command]
pub fn app_update_status(app: AppHandle) -> Status {
    snapshot(&app)
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Status {
    check(&app).await
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let running = replies_running(&app);
    let package = {
        let updates = app.state::<Updates>();
        let mut inner = updates.lock();
        install_gate(inner.status.phase, running)?;
        let package = inner.package.take().ok_or(NOT_READY)?;
        inner.status.phase = Phase::Installing;
        inner.status.message = None;
        package
    };
    let _ = app.emit(EVENT, snapshot(&app));
    crate::release_owned_work(&app).await;
    // A reply may have started while background work stopped; keep the update for later.
    if replies_running(&app) {
        set(&app, |inner| {
            inner.status.phase = Phase::Ready;
            inner.package = Some(package);
        });
        return Err(REPLY_RUNNING.into());
    }
    apply(&app, package, true).map_err(|package| {
        set(&app, |inner| {
            inner.status.phase = Phase::Ready;
            inner.status.message = Some(INSTALL_FAILED);
            inner.package = Some(package);
        });
        INSTALL_FAILED.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_installed_release_packages_update_themselves() {
        for bundle in [
            BundleType::Nsis,
            BundleType::Msi,
            BundleType::AppImage,
            BundleType::App,
        ] {
            assert!(availability(false, Some(bundle.clone())).is_ok());
            assert!(availability(true, Some(bundle)).is_err());
        }
        for bundle in [Some(BundleType::Deb), Some(BundleType::Rpm)] {
            assert!(availability(false, bundle)
                .unwrap_err()
                .contains("AppImage"));
        }
        assert!(availability(false, None).is_err());
        let updates = Updates::with("1.2.3".into(), availability(true, None));
        let status = updates.lock().status.clone();
        assert_eq!(status.phase, Phase::Unavailable);
        assert!(status.message.is_some());
        let updates = Updates::with("1.2.3".into(), Ok(()));
        assert_eq!(updates.lock().status.phase, Phase::Idle);
    }

    #[test]
    fn installing_requires_a_ready_package_and_no_running_reply() {
        assert!(install_gate(Phase::Ready, false).is_ok());
        assert_eq!(install_gate(Phase::Ready, true), Err(REPLY_RUNNING));
        for phase in [
            Phase::Unavailable,
            Phase::Idle,
            Phase::Checking,
            Phase::Current,
            Phase::Downloading,
            Phase::Installing,
            Phase::Failed,
        ] {
            assert_eq!(install_gate(phase, false), Err(NOT_READY));
        }
    }

    #[test]
    fn failures_map_to_bounded_messages_without_raw_details() {
        let network = Error::Network("secret://internal detail".into());
        assert!(check_error(&network).contains("Could not reach GitHub"));
        assert!(download_error(&network).contains("did not finish"));
        assert!(check_error(&Error::TargetNotFound("linux-x86_64".into())).contains("no update"));
        assert!(check_error(&Error::ReleaseNotFound).contains("could not be read"));
        for error in [
            Error::MissingSignedVersion,
            Error::SignedVersionMismatch {
                signed: "0.1.0".into(),
                announced: "9.9.9".into(),
            },
        ] {
            assert!(download_error(&error).contains("signature verification"));
        }
        assert_eq!(
            check_error(&Error::InsecureTransportProtocol),
            "Could not check for updates."
        );
    }

    #[test]
    fn release_notes_are_plain_bounded_text() {
        assert_eq!(notes(" \n\t "), None);
        assert_eq!(
            notes("- Fix\tsync\r\n- Add updates\u{7}\n").as_deref(),
            Some("- Fix sync\n- Add updates")
        );
        let long = notes(&"é".repeat(MAX_NOTES + 10)).unwrap();
        assert_eq!(long.chars().count(), MAX_NOTES);
    }

    #[test]
    fn status_serializes_camel_case_without_empty_fields() {
        let updates = Updates::with("1.2.3".into(), Ok(()));
        let mut status = updates.lock().status.clone();
        status.phase = Phase::Downloading;
        status.version = Some("1.3.0".into());
        status.downloaded = Some(10);
        status.checked_at = Some(5);
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "currentVersion": "1.2.3",
                "phase": "downloading",
                "version": "1.3.0",
                "downloaded": 10,
                "checkedAt": 5,
                "repliesRunning": false,
            })
        );
    }
}
