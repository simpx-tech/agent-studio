//! Keeps Agent Studio running in the system tray (the menu bar on macOS) after its window
//! closes, so replies, relay jobs, parked CLIs and notifications carry on. Quit in the tray's
//! menu ends the app the way closing the window did before. See docs/BACKGROUND.md.
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

const SETTINGS_FILE: &str = "tray.json";
const TRAY: &str = "agent-studio";
const OPEN: &str = "tray-open";
const QUIT: &str = "tray-quit";
/// A left click on the icon opens the window on Windows. macOS menu bar icons open their menu
/// instead, and Linux reports no clicks, so the menu carries Open Agent Studio everywhere.
const CLICK_OPENS: bool = cfg!(windows);
const UNAVAILABLE: &str =
    "The system tray is unavailable on this computer, so closing the window quits Agent Studio.";
#[cfg(all(unix, not(target_os = "macos")))]
const NO_INDICATOR: &str = "This computer has no AppIndicator library for a tray icon, so closing the window quits Agent Studio. Install libayatana-appindicator3 to keep it running.";

/// Whether closing the window keeps the app running, on unless turned off on this device.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    close_to_tray: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    close_to_tray: bool,
    /// Where the icon lives: `tray`, or `menuBar` on macOS.
    area: &'static str,
    click_opens: bool,
    /// Why no icon could be shown, so closing the window quits.
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable: Option<&'static str>,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    /// The icon is in the tray. Closing only hides the window while it is.
    shown: bool,
    unavailable: Option<&'static str>,
}

#[derive(Default)]
pub struct Tray {
    inner: Mutex<Inner>,
    /// Quit was chosen, so closing the window ends the app.
    quitting: AtomicBool,
    /// Serializes switching the setting, which adds or removes the icon.
    changing: tokio::sync::Mutex<()>,
}
impl Tray {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn keeps_running(settings: Settings, shown: bool, quitting: bool) -> bool {
    settings.close_to_tray && shown && !quitting
}

/// Whether closing the window should only hide it, keeping the app running in the tray.
pub fn hides_on_close(app: &AppHandle) -> bool {
    let tray = app.state::<Tray>();
    let inner = tray.lock();
    keeps_running(
        inner.settings,
        inner.shown,
        tray.quitting.load(Ordering::SeqCst),
    )
}

/// Shows the window from the tray, a second launch, a notification or the macOS Dock.
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Ends the app the way closing its window did before the tray: owned work is released and an
/// idle app installs a downloaded update.
fn quit(app: &AppHandle) {
    app.state::<Tray>().quitting.store(true, Ordering::SeqCst);
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.close();
        }
        None => app.exit(0),
    }
}

fn opens_window(event: &TrayIconEvent) -> bool {
    CLICK_OPENS
        && matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        )
}

fn status(app: &AppHandle) -> Status {
    let tray = app.state::<Tray>();
    let inner = tray.lock();
    Status {
        close_to_tray: inner.settings.close_to_tray,
        area: if cfg!(target_os = "macos") {
            "menuBar"
        } else {
            "tray"
        },
        click_opens: CLICK_OPENS,
        unavailable: inner.unavailable,
    }
}

/// Reads this device's choice and adds the icon when closing keeps the app running. Runs
/// before the window opens, so the first close already knows.
pub fn setup(app: &AppHandle) {
    let settings = path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .filter(|bytes| bytes.len() <= 10_000)
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .unwrap_or_default();
    app.state::<Tray>().lock().settings = settings;
    // Menu handlers are app-wide and never removed, so register this one once rather than
    // with each icon: an icon added again would otherwise quit once per earlier icon.
    app.on_menu_event(|app, event| match event.id().as_ref() {
        OPEN => show_window(app),
        QUIT => quit(app),
        _ => {}
    });
    show_icon(app, settings.close_to_tray);
}

/// Adds or removes the icon, on the main thread: tray icons are neither Send nor Sync, and
/// removing one elsewhere would leave its window behind.
fn show_icon(app: &AppHandle, shown: bool) {
    let tray = app.state::<Tray>();
    if !shown {
        let _ = app.remove_tray_by_id(TRAY);
        tray.lock().shown = false;
        return;
    }
    if tray.lock().shown {
        return;
    }
    let result = build(app);
    let mut inner = tray.lock();
    inner.shown = result.is_ok();
    inner.unavailable = result.err();
}

fn build(app: &AppHandle) -> Result<(), &'static str> {
    #[cfg(all(unix, not(target_os = "macos")))]
    if !indicator_available() {
        return Err(NO_INDICATOR);
    }
    let icon = app.default_window_icon().cloned().ok_or(UNAVAILABLE)?;
    let open = MenuItem::with_id(app, OPEN, "Open Agent Studio", true, None::<&str>);
    let quit_item = MenuItem::with_id(app, QUIT, "Quit Agent Studio", true, None::<&str>);
    let separator = PredefinedMenuItem::separator(app);
    let (Ok(open), Ok(quit_item), Ok(separator)) = (open, quit_item, separator) else {
        return Err(UNAVAILABLE);
    };
    let menu = Menu::with_items(app, &[&open, &separator, &quit_item]).map_err(|_| UNAVAILABLE)?;
    let _tray = TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .show_menu_on_left_click(!CLICK_OPENS)
        .on_tray_icon_event(|tray, event| {
            if opens_window(&event) {
                show_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|_| UNAVAILABLE)?;
    #[cfg(windows)]
    small_icon(&_tray);
    Ok(())
}

/// Windows draws tray icons at the small icon size (24 pixels at 150% scaling). Loading that
/// size from the application icon uses its hand-tuned small drawings, where scaling the
/// 32-pixel window icon would blur them.
#[cfg(windows)]
fn small_icon(tray: &tauri::tray::TrayIcon) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON, SM_CYSMICON};
    // SAFETY: reads two system metrics.
    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON)) };
    if width <= 0 || height <= 0 {
        return;
    }
    let size = (width as u32, height as u32);
    let _ = tray.with_inner_tray_icon(move |inner| {
        // tauri-build embeds icons/icon.ico as the executable's application icon, 32512.
        if let Ok(icon) = tray_icon::Icon::from_resource(32512, Some(size)) {
            let _ = inner.set_icon(Some(icon));
        }
    });
}

/// Linux tray icons need an AppIndicator library, and tray-icon aborts the app when it cannot
/// load one, so look for it first. The library stays loaded for the icon.
#[cfg(all(unix, not(target_os = "macos")))]
fn indicator_available() -> bool {
    [c"libayatana-appindicator3.so.1", c"libappindicator3.so.1"]
        .iter()
        // SAFETY: dlopen receives NUL-terminated library names.
        .any(|name| !unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY) }.is_null())
}

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the tray setting")?
        .join(SETTINGS_FILE))
}

async fn save(app: &AppHandle, settings: Settings) -> Result<(), String> {
    let path = path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = path.parent().ok_or("Cannot locate the tray setting")?;
        std::fs::create_dir_all(root).map_err(|_| "Cannot save the tray setting")?;
        let mut file =
            tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot save the tray setting")?;
        file.write_all(
            &serde_json::to_vec(&settings).map_err(|_| "Cannot encode the tray setting")?,
        )
        .map_err(|_| "Cannot save the tray setting")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot save the tray setting")?;
        file.persist(path)
            .map_err(|_| "Cannot finish saving the tray setting")?;
        Ok(())
    })
    .await
    .map_err(|_| "Cannot save the tray setting")?
}

#[tauri::command]
pub async fn window_behavior(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<Status, String> {
    let tray = app.state::<Tray>();
    let _changing = tray.changing.lock().await;
    let settings = Settings {
        close_to_tray: enabled,
    };
    save(&app, settings).await?;
    tray.lock().settings = settings;
    let (done, shown) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        show_icon(&handle, enabled);
        let _ = done.send(());
    })
    .map_err(|_| "Cannot change the tray icon")?;
    shown.await.map_err(|_| "Cannot change the tray icon")?;
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_running_by_default_without_overriding_a_saved_choice() {
        assert!(Settings::default().close_to_tray);
        assert!(
            serde_json::from_str::<Settings>("{}")
                .unwrap()
                .close_to_tray
        );
        for enabled in [false, true] {
            let settings = Settings {
                close_to_tray: enabled,
            };
            let encoded = serde_json::to_string(&settings).unwrap();
            assert_eq!(encoded, format!("{{\"closeToTray\":{enabled}}}"));
            assert_eq!(
                serde_json::from_str::<Settings>(&encoded).unwrap(),
                settings
            );
        }
    }

    #[test]
    fn closing_hides_only_while_the_icon_can_bring_the_window_back() {
        let on = Settings::default();
        let off = Settings {
            close_to_tray: false,
        };
        assert!(keeps_running(on, true, false));
        // Without an icon, or once Quit was chosen, closing ends the app.
        assert!(!keeps_running(on, false, false));
        assert!(!keeps_running(on, true, true));
        assert!(!keeps_running(off, true, false));
    }

    #[test]
    fn status_serializes_camel_case_without_an_empty_reason() {
        let status = Status {
            close_to_tray: true,
            area: "tray",
            click_opens: true,
            unavailable: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"closeToTray": true, "area": "tray", "clickOpens": true})
        );
        let status = Status {
            close_to_tray: true,
            area: "tray",
            click_opens: false,
            unavailable: Some(UNAVAILABLE),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap()["unavailable"],
            UNAVAILABLE
        );
    }
}
