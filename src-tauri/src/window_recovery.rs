//! Brings the window back when WebView2's own processes end under it (requested 2026-10-23,
//! after Windows ran out of memory: WebView2's browser process could not create shared memory
//! and ended, and the window stayed empty for forty minutes while three replies ran on unseen,
//! until the app was quit). A browser process that ends closes the window's webview for good, so
//! the window is built again in this process, where replies, relay jobs and parked CLIs carry
//! on, and its new page follows the replies as after a reload (reply_feed.rs). A page whose
//! renderer ended shows WebView2's error page instead, and is loaded again. A page that stopped
//! calling while every WebView2 process lived on, as on 2026-10-23 at 13:08, has its browser
//! process ended and the window built again (`repair_silence`). Repairs that follow one another
//! closely wait longer each time, and none gives up. See docs/DIAGNOSTICS.md.
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
pub(crate) const LONGEST: Duration = Duration::from_secs(60);
/// A failure this long after the last one starts again from the first pause.
const SETTLED: Duration = Duration::from_secs(300);
/// How long the old window may take to let its label go.
#[cfg_attr(not(windows), allow(dead_code))]
const CLOSING: Duration = Duration::from_secs(10);
/// How long the app's own async work may take to run a task before a silent page is put down to
/// it rather than to WebView2.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const ANSWER: Duration = Duration::from_secs(10);
/// How long an ended browser process may take to go.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const ENDING: Duration = Duration::from_secs(10);
/// The exit code of a browser process a repair ends: Chromium's own for a process it killed.
#[cfg_attr(not(windows), allow(dead_code))]
const ENDED_CODE: u32 = 1;

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
    /// The current window's WebView2 browser process, which the repair of a silent page ends.
    #[cfg(windows)]
    browser: Mutex<Option<Browser>>,
    /// The window whose browser process that repair ended: the repair builds it again itself, so
    /// what WebView2 then reports of that window needs no repair of its own.
    #[cfg(windows)]
    ended: Mutex<Option<u64>>,
    /// The current window's handle, to tell whether it is in front.
    #[cfg(windows)]
    hwnd: std::sync::atomic::AtomicIsize,
}

impl Recovery {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn pacing(&self) -> MutexGuard<'_, Pacing> {
        self.pacing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(windows)]
    fn browser(&self) -> MutexGuard<'_, Option<Browser>> {
        self.browser.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[cfg(windows)]
    fn ended(&self) -> MutexGuard<'_, Option<u64>> {
        self.ended.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A window's WebView2 browser process, held open so that its id names no other process.
#[cfg(windows)]
struct Browser {
    window: u64,
    process: std::os::windows::io::OwnedHandle,
}

/// Whether the repair of a silent page ended window `number`'s browser process, and builds the
/// window again itself.
#[cfg(windows)]
pub fn ended(app: &AppHandle, number: u64) -> bool {
    app.try_state::<Recovery>()
        .is_some_and(|recovery| *recovery.ended() == Some(number))
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
/// taskbar count on its handle, the record and repair of its WebView2's failures, its browser
/// process for the repair of a silent page, and the guard on its browser keys. `number` is the
/// window's (`Recovery::window`).
#[cfg(windows)]
pub fn prepare(app: &AppHandle, window: &tauri::WebviewWindow, number: u64) {
    if let Ok(hwnd) = window.hwnd() {
        app.state::<std::sync::Arc<crate::badges::Overlay>>()
            .attach(hwnd.0 as isize);
        app.state::<Recovery>()
            .hwnd
            .store(hwnd.0 as isize, Ordering::SeqCst);
    }
    crate::watchdog::watch_webview(window, number);
    crate::page_guard::guard(window);
    keep_browser(app, window, number);
}

/// Keeps window `number`'s WebView2 browser process open for the repair of a silent page.
#[cfg(windows)]
fn keep_browser(app: &AppHandle, window: &tauri::WebviewWindow, number: u64) {
    let app = app.clone();
    let _ = window.with_webview(move |platform| {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };
        let mut id = 0;
        // SAFETY: the controller is this window's live WebView2, on the window thread; the
        // handle OpenProcess returns is checked and then owned, and closed, by `OwnedHandle`.
        let process = unsafe {
            let known = platform
                .controller()
                .CoreWebView2()
                .and_then(|webview| webview.BrowserProcessId(&mut id));
            if known.is_err() || id == 0 {
                return;
            }
            let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, id);
            if handle.is_null() {
                return;
            }
            OwnedHandle::from_raw_handle(handle)
        };
        let recovery = app.state::<Recovery>();
        // A window built since keeps its own.
        if recovery.window.load(Ordering::SeqCst) == number {
            *recovery.browser() = Some(Browser {
                window: number,
                process,
            });
        }
    });
}

/// Whether the window is in front and not minimized. Its page is shown then and calls within a
/// second, even when the last thing it could tell the app was that it was hidden.
#[cfg(windows)]
pub fn in_front(app: &AppHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsIconic};
    let Some(recovery) = app.try_state::<Recovery>() else {
        return false;
    };
    let hwnd = recovery.hwnd.load(Ordering::SeqCst);
    // SAFETY: reads which window is in front, and whether this one is minimized; a handle that
    // closed meanwhile is in front of nothing.
    hwnd != 0 && unsafe { GetForegroundWindow() as isize == hwnd && IsIconic(hwnd as _) == 0 }
}

/// Repairs the window of a page that went silent while the window thread answered, returning
/// whether it did; `failed` hears why an attempt failed. On 2026-10-23, while Windows was out of
/// memory, nothing passed between the page and the app for 35 minutes, with every WebView2
/// process alive and none reported failing: the page drew and counted on, its calls never
/// arrived, and what the app sent never reached it. Such a page cannot even load again, since its
/// own files come through the same requests, so WebView2's browser process is ended, taking the
/// page with it, and the window is built again on a new one. Runs off the window thread.
#[cfg(windows)]
pub fn repair_silence(app: &AppHandle, failed: &mut dyn FnMut(String)) -> bool {
    let recovery = app.state::<Recovery>();
    let number = recovery.window.load(Ordering::SeqCst);
    if ending(app) {
        return false;
    }
    // The page's calls run on this runtime: one that takes no task silences the page itself,
    // and a new window would go unanswered too.
    if !runtime_answers(ANSWER) {
        failed("The app's own work did not answer".into());
        return false;
    }
    if let Err(error) = end_browser(&recovery, number) {
        failed(error);
        return false;
    }
    repair(app, number, Repair::Window, failed)
}

/// Ends window `number`'s WebView2 browser process and waits for it to go.
#[cfg(windows)]
fn end_browser(recovery: &Recovery, number: u64) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::WAIT_OBJECT_0,
        System::Threading::{TerminateProcess, WaitForSingleObject},
    };
    // A copy of the handle, so that the window thread never waits on the record meanwhile.
    let process = recovery
        .browser()
        .as_ref()
        .filter(|browser| browser.window == number)
        .and_then(|browser| browser.process.try_clone().ok())
        .ok_or("No WebView2 browser process to end")?;
    *recovery.ended() = Some(number);
    let wait = u32::try_from(ENDING.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: a process handle held open here, with the rights to end the process and wait for
    // it. Ending one that already ended fails, and the wait then returns at once.
    let gone = unsafe {
        TerminateProcess(process.as_raw_handle(), ENDED_CODE);
        WaitForSingleObject(process.as_raw_handle(), wait)
    };
    if gone != WAIT_OBJECT_0 {
        return Err("WebView2's browser process did not end".into());
    }
    Ok(())
}

/// Whether the async runtime the app's commands run on takes a task within `wait`.
#[cfg_attr(not(windows), allow(dead_code))]
fn runtime_answers(wait: Duration) -> bool {
    let (answer, answered) = std::sync::mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let _ = answer.send(());
    });
    answered.recv_timeout(wait).is_ok()
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

    #[cfg(windows)]
    #[test]
    fn a_silent_pages_repair_ends_its_own_windows_browser_process_only() {
        use std::os::windows::io::AsHandle;
        // A process standing in for WebView2's browser process.
        let mut browser = std::process::Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let recovery = Recovery::default();
        *recovery.browser() = Some(Browser {
            window: 3,
            process: browser.as_handle().try_clone_to_owned().unwrap(),
        });
        // Another window's process is left alone, and nothing reads as ended.
        assert!(end_browser(&recovery, 2).is_err());
        assert_eq!(*recovery.ended(), None);
        assert!(browser.try_wait().unwrap().is_none());
        end_browser(&recovery, 3).unwrap();
        assert_eq!(*recovery.ended(), Some(3));
        assert_eq!(browser.wait().unwrap().code(), Some(ENDED_CODE as i32));
        // One that ended already is no failure.
        end_browser(&recovery, 3).unwrap();
    }

    #[test]
    fn a_free_runtime_answers_the_check() {
        assert!(runtime_answers(Duration::from_secs(10)));
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
