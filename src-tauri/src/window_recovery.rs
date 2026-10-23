//! Brings the window back when WebView2's own processes end under it (requested 2026-10-23,
//! after Windows ran out of memory: WebView2's browser process could not create shared memory
//! and ended, and the window stayed empty for forty minutes while three replies ran on unseen,
//! until the app was quit). A browser process that ends closes the window's webview for good, so
//! the window is built again in this process, where replies, relay jobs and parked CLIs carry
//! on, and its new page follows the replies as after a reload (reply_feed.rs). A page whose
//! renderer ended shows WebView2's error page instead, and is loaded again. Repairs that follow
//! one another closely wait longer each time, and none gives up. See docs/DIAGNOSTICS.md.
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[cfg_attr(not(windows), allow(dead_code))]
const MAIN: &str = "main";
/// The pause before a first repair, which lets the ended process's own processes go first.
const FIRST: Duration = Duration::from_secs(1);
/// The longest pause before a repair, and between attempts to build the window.
const LONGEST: Duration = Duration::from_secs(60);
/// A failure this long after the last one starts again from the first pause.
const SETTLED: Duration = Duration::from_secs(300);
/// How long the old window may take to let its label go.
#[cfg_attr(not(windows), allow(dead_code))]
const CLOSING: Duration = Duration::from_secs(10);

/// What brings the window back from a WebView2 process that ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Repair {
    /// The browser process ended, which closed the webview: the window is built again.
    Window,
    /// The page's renderer ended, and WebView2 shows its error page: the page loads again.
    Page,
}

/// The repair a failed process needs, by WebView2's `COREWEBVIEW2_PROCESS_FAILED_KIND`. WebView2
/// starts GPU, utility and frame processes again by itself, and a renderer that stopped
/// answering may answer again.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn needed(kind: i32) -> Option<Repair> {
    match kind {
        0 => Some(Repair::Window),
        1 => Some(Repair::Page),
        _ => None,
    }
}

#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Recovery {
    /// Counts the windows built after the first: a failure an earlier window reports needs no
    /// repair.
    window: AtomicU64,
    /// The window is being built again, so its old one closing leaves the app running.
    rebuilding: AtomicBool,
    /// Repairs run one at a time, each paced by the ones before.
    pacing: Mutex<Pacing>,
}

impl Recovery {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn pacing(&self) -> MutexGuard<'_, Pacing> {
        self.pacing.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Whether the app stays when its last window closes: the window is being built again, and the
/// app is not ending.
pub fn rebuilding(app: &AppHandle) -> bool {
    #[cfg(windows)]
    {
        app.try_state::<Recovery>()
            .is_some_and(|recovery| recovery.rebuilding.load(Ordering::SeqCst))
            && !ending(app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        false
    }
}

/// How long to wait before each repair.
#[derive(Default)]
struct Pacing {
    last: Option<Instant>,
    pause: Duration,
}

impl Pacing {
    /// The pause before repairing a failure at `now`: twice the last one while failures keep
    /// coming, up to a minute, and the first again once the window has kept going a while.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn next(&mut self, now: Instant) -> Duration {
        self.pause = match self.last {
            Some(last) if now.saturating_duration_since(last) < SETTLED => {
                (self.pause * 2).clamp(FIRST, LONGEST)
            }
            _ => FIRST,
        };
        self.last = Some(now);
        self.pause
    }
}

/// How the old window showed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Shown {
    visible: bool,
    maximized: bool,
    minimized: bool,
    focused: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum Step {
    Maximize,
    Show,
    Minimize,
    Focus,
}

impl Shown {
    /// What shows the new window as the old one showed, through the window's own calls so that
    /// it knows how it shows: maximized before it shows, so it never shows at its normal size
    /// first, and minimized after. A window hidden in the tray stays hidden.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn steps(self) -> Vec<Step> {
        if !self.visible {
            return vec![];
        }
        let mut steps = vec![];
        if self.maximized {
            steps.push(Step::Maximize);
        }
        steps.push(Step::Show);
        if self.minimized {
            steps.push(Step::Minimize);
        } else if self.focused {
            steps.push(Step::Focus);
        }
        steps
    }
}

/// What the main window needs once it exists, at startup and when it is built again: the
/// taskbar count on its handle, the record and repair of its WebView2's failures, and the guard
/// on its browser keys. `number` is the window's (`Recovery::window`).
#[cfg(windows)]
pub fn prepare(app: &AppHandle, window: &tauri::WebviewWindow, number: u64) {
    if let Ok(hwnd) = window.hwnd() {
        app.state::<std::sync::Arc<crate::badges::Overlay>>()
            .attach(hwnd.0 as isize);
    }
    crate::watchdog::watch_webview(window, number);
    crate::page_guard::guard(window);
}

/// Repairs the window after a failure that window `number` reported, returning whether it did;
/// `failed` hears why an attempt failed. Runs off the window thread, since building a window
/// waits for it.
#[cfg(windows)]
pub fn repair(
    app: &AppHandle,
    number: u64,
    repair: Repair,
    failed: &mut dyn FnMut(String),
) -> bool {
    let recovery = app.state::<Recovery>();
    let mut pacing = recovery.pacing();
    // A window built since replaced the one that failed.
    if recovery.window.load(Ordering::SeqCst) != number {
        return false;
    }
    std::thread::sleep(pacing.next(Instant::now()));
    if ending(app) {
        return false;
    }
    // The document that followed the replies is gone; the next one follows them again.
    app.state::<crate::runner::Runs>().reloaded();
    match repair {
        Repair::Page => match app.get_webview_window(MAIN) {
            Some(window) => match window.reload() {
                Ok(()) => true,
                Err(error) => {
                    failed(format!("Cannot load the page again: {error}"));
                    false
                }
            },
            None => false,
        },
        Repair::Window => rebuild(app, &recovery, failed),
    }
}

/// Builds the window again in place of the one whose webview closed.
#[cfg(windows)]
fn rebuild(app: &AppHandle, recovery: &Recovery, failed: &mut dyn FnMut(String)) -> bool {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
    else {
        failed("No window to build".into());
        return false;
    };
    recovery.rebuilding.store(true, Ordering::SeqCst);
    let old = app.get_webview_window(MAIN);
    let place = old.as_ref().map(Place::of).unwrap_or_default();
    if let Some(old) = old {
        let _ = old.destroy();
    }
    // The old window lets its label go once the window thread has closed it.
    let closing = Instant::now();
    while app.get_webview_window(MAIN).is_some() && closing.elapsed() < CLOSING {
        std::thread::sleep(Duration::from_millis(50));
    }
    let number = recovery.window.fetch_add(1, Ordering::SeqCst) + 1;
    let mut pause = FIRST;
    let built = loop {
        if ending(app) {
            break false;
        }
        match tauri::WebviewWindowBuilder::from_config(app, &config)
            .and_then(|builder| builder.visible(false).focused(place.shown.focused).build())
        {
            Ok(window) => {
                place.restore(&window);
                prepare(app, &window, number);
                break true;
            }
            // WebView2 may not start while memory is still short.
            Err(error) => {
                failed(format!("Cannot build the window: {error}"));
                std::thread::sleep(pause);
                pause = (pause * 2).min(LONGEST);
            }
        }
    };
    recovery.rebuilding.store(false, Ordering::SeqCst);
    built
}

/// The app is ending, or Windows is: a window built now would only close again.
#[cfg(windows)]
fn ending(app: &AppHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    crate::watchdog::ending(app)
        || crate::tray::quitting(app)
        || crate::updates::installing(app)
        // SAFETY: reads a system metric.
        || unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) } != 0
}

/// Where the old window was and how it showed.
#[cfg(windows)]
#[derive(Default)]
struct Place {
    placement: Option<windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT>,
    shown: Shown,
}

#[cfg(windows)]
impl Place {
    fn of(window: &tauri::WebviewWindow) -> Self {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};
        let placement = window.hwnd().ok().and_then(|hwnd| {
            // SAFETY: the structure is sized for the call, which fills it in.
            unsafe {
                let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
                placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                (GetWindowPlacement(hwnd.0 as _, &mut placement) != 0).then_some(placement)
            }
        });
        Self {
            placement,
            shown: Shown {
                visible: window.is_visible().unwrap_or(true),
                maximized: window.is_maximized().unwrap_or(false),
                minimized: window.is_minimized().unwrap_or(false),
                focused: window.is_focused().unwrap_or(false),
            },
        }
    }

    /// Puts the new window, still hidden, where the old one was, then shows it as that one
    /// showed.
    fn restore(&self, window: &tauri::WebviewWindow) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPlacement, SW_HIDE, WINDOWPLACEMENT,
        };
        if let (Some(placement), Ok(hwnd)) = (self.placement, window.hwnd()) {
            let placement = WINDOWPLACEMENT {
                flags: 0,
                showCmd: SW_HIDE as u32,
                ..placement
            };
            // SAFETY: a live window of this app and a filled-in placement. The window stays
            // hidden, so its own record of how it shows stays true.
            unsafe { SetWindowPlacement(hwnd.0 as _, &placement) };
        }
        for step in self.shown.steps() {
            let _ = match step {
                Step::Maximize => window.maximize(),
                Step::Show => window.show(),
                Step::Minimize => window.minimize(),
                Step::Focus => window.set_focus(),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_ended_browser_or_page_renderer_needs_a_repair() {
        assert_eq!(needed(0), Some(Repair::Window));
        assert_eq!(needed(1), Some(Repair::Page));
        // A renderer that stopped answering, a frame's renderer, utility and GPU processes.
        for kind in [2, 3, 4, 5, 6, 7, 8, 42] {
            assert_eq!(needed(kind), None);
        }
        assert_eq!(
            serde_json::to_value([Repair::Window, Repair::Page]).unwrap(),
            serde_json::json!(["window", "page"])
        );
    }

    #[test]
    fn repairs_wait_longer_while_failures_keep_coming_and_start_over_once_settled() {
        let mut pacing = Pacing::default();
        let start = Instant::now();
        let second = Duration::from_secs(1);
        assert_eq!(pacing.next(start), FIRST);
        let mut at = start;
        let mut pauses = vec![];
        for _ in 0..8 {
            at += 10 * second;
            pauses.push(pacing.next(at).as_secs());
        }
        assert_eq!(pauses, [2, 4, 8, 16, 32, 60, 60, 60]);
        // A window that kept going for five minutes is repaired at once again.
        assert_eq!(pacing.next(at + SETTLED), FIRST);
        assert_eq!(pacing.next(at + SETTLED + second).as_secs(), 2);
    }

    #[test]
    fn the_new_window_shows_as_the_old_one_did() {
        let shown = |visible, maximized, minimized, focused| Shown {
            visible,
            maximized,
            minimized,
            focused,
        };
        // Hidden in the tray, it stays hidden, whatever else it was.
        assert!(shown(false, true, false, true).steps().is_empty());
        assert_eq!(
            shown(true, false, false, false).steps(),
            [Step::Show],
            "a window another app had focus over leaves it there"
        );
        assert_eq!(
            shown(true, false, false, true).steps(),
            [Step::Show, Step::Focus]
        );
        assert_eq!(
            shown(true, true, false, true).steps(),
            [Step::Maximize, Step::Show, Step::Focus]
        );
        assert_eq!(
            shown(true, true, true, false).steps(),
            [Step::Maximize, Step::Show, Step::Minimize]
        );
        assert_eq!(
            shown(true, false, true, true).steps(),
            [Step::Show, Step::Minimize]
        );
    }
}
