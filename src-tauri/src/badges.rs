//! Application-owned pending count. No arbitrary icon bytes or file paths cross IPC.
//!
//! On Windows the count is a taskbar overlay set through Explorer's taskbar (ITaskbarList3),
//! which waits for Explorer to answer. The window thread never makes that call: while it waits,
//! the window's buttons, its dragging and every call from the page wait with it
//! (docs/DIAGNOSTICS.md). A thread of its own sets the newest count; a count asked for while one
//! is being set waits for that call, and the counts in between are skipped.
#[cfg(any(windows, test))]
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use tauri::Manager;

#[tauri::command]
pub async fn set_pending_chat_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        app.state::<Arc<Overlay>>().inner().show(count)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let window = app
            .get_webview_window("main")
            .ok_or("Application window unavailable")?;
        window
            .set_badge_count((count > 0).then_some(i64::from(count)))
            .map_err(|_| "Could not update the pending chat badge".into())
    }
}

/// The main window's taskbar overlay, set by a thread of its own.
#[cfg(any(windows, test))]
pub struct Overlay {
    /// The main window's handle, known once the window exists.
    window: OnceLock<isize>,
    state: Mutex<OverlayState>,
    /// Shows a count on the window's taskbar button, returning whether it did.
    apply: fn(isize, u32) -> bool,
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct OverlayState {
    /// The count to show once the call under way returns.
    wanted: Option<u32>,
    /// The count the taskbar shows, unless a call failed.
    shown: Option<u32>,
    /// A thread is setting the overlay and takes `wanted` when its call returns.
    busy: bool,
}

#[cfg(any(windows, test))]
impl Overlay {
    #[cfg(windows)]
    pub fn new() -> Arc<Self> {
        Self::with(taskbar::set_overlay)
    }
    fn with(apply: fn(isize, u32) -> bool) -> Arc<Self> {
        Arc::new(Self {
            window: OnceLock::new(),
            state: Mutex::default(),
            apply,
        })
    }
    fn lock(&self) -> MutexGuard<'_, OverlayState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// The window whose taskbar button carries the count, once it exists.
    pub fn attach(&self, window: isize) {
        let _ = self.window.set(window);
    }
    pub fn show(self: &Arc<Self>, count: u32) -> Result<(), String> {
        let window = *self.window.get().ok_or("Application window unavailable")?;
        {
            let mut state = self.lock();
            state.wanted = Some(count);
            if state.busy {
                return Ok(());
            }
            state.busy = true;
        }
        let overlay = Arc::clone(self);
        std::thread::Builder::new()
            .name("taskbar-overlay".into())
            .spawn(move || overlay.work(window))
            .map(drop)
            .map_err(|_| {
                self.lock().busy = false;
                "Could not update the pending chat badge".into()
            })
    }
    fn work(&self, window: isize) {
        #[cfg(windows)]
        let _com = taskbar::Apartment::enter();
        loop {
            let count = {
                let mut state = self.lock();
                match state.wanted.take() {
                    Some(count) if state.shown != Some(count) => count,
                    _ => {
                        state.busy = false;
                        return;
                    }
                }
            };
            let shown = (self.apply)(window, count);
            // A count that failed is set again when it is asked for next.
            self.lock().shown = shown.then_some(count);
        }
    }
}

#[cfg(windows)]
mod taskbar {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HWND,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::{
                Shell::{ITaskbarList3, TaskbarList},
                WindowsAndMessaging::{CreateIcon, DestroyIcon, HICON},
            },
        },
    };

    /// COM for the overlay's own thread, left when the thread ends.
    pub struct Apartment(bool);
    impl Apartment {
        pub fn enter() -> Self {
            // SAFETY: called once on a thread this module started, and balanced in Drop.
            Self(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the successful CoInitializeEx of this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    pub fn set_overlay(window: isize, count: u32) -> bool {
        // SAFETY: COM was entered on this thread. The taskbar keeps its own copy of the icon,
        // which is destroyed after the call.
        unsafe {
            let taskbar: ITaskbarList3 =
                match CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) {
                    Ok(taskbar) => taskbar,
                    Err(_) => return false,
                };
            if taskbar.HrInit().is_err() {
                return false;
            }
            let icon = match super::badge_icon(count) {
                Some(rgba) => match icon(&rgba) {
                    Some(icon) => icon,
                    None => return false,
                },
                None => HICON::default(),
            };
            let shown = taskbar
                .SetOverlayIcon(HWND(window as _), icon, PCWSTR::null())
                .is_ok();
            if !icon.is_invalid() {
                let _ = DestroyIcon(icon);
            }
            shown
        }
    }

    /// A 32x32 icon from straight RGBA: BGRA colour and a mask set where a pixel is clear.
    unsafe fn icon(rgba: &[u8]) -> Option<HICON> {
        let mut bgra = rgba.to_vec();
        let mut mask = [0u8; 32 * 32 / 8];
        for (index, pixel) in bgra.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            pixel.swap(0, 2);
            if pixel[3] == 0 {
                mask[index / 8] |= 0x80 >> (index % 8);
            }
        }
        CreateIcon(None, 32, 32, 1, 32, mask.as_ptr(), bgra.as_ptr()).ok()
    }
}

/// The badge's 32x32 straight RGBA pixels, or none to clear it.
#[cfg(any(target_os = "windows", test))]
fn badge_icon(count: u32) -> Option<Vec<u8>> {
    if count == 0 {
        return None;
    }
    let text = if count > 99 {
        "99+".to_string()
    } else {
        count.to_string()
    };
    // Small, crisp 3x5 numerals remain legible when the taskbar scales to 16 px.
    let glyphs = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
        [0, 2, 7, 2, 0],
    ];
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0..32usize {
        for x in 0..32usize {
            if (x as f32 - 15.5).hypot(y as f32 - 15.5) <= 15.5 {
                rgba[(y * 32 + x) * 4..(y * 32 + x + 1) * 4].copy_from_slice(&[183, 73, 63, 255]);
            }
        }
    }
    let scale = if text.len() > 2 { 2 } else { 3 };
    let left = (32 - (text.len() * 4 - 1) * scale) / 2;
    let top = (32 - 5 * scale) / 2;
    for (i, ch) in text.bytes().enumerate() {
        let index = if ch == b'+' {
            10
        } else {
            usize::from(ch - b'0')
        };
        for (row, bits) in glyphs[index].iter().enumerate() {
            for column in 0..3 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = left + (i * 4 + column) * scale + dx;
                        let y = top + row * scale + dy;
                        rgba[(y * 32 + x) * 4..(y * 32 + x + 1) * 4]
                            .copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    Some(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Condvar, Mutex as StdMutex},
        time::Duration,
    };

    /// Shows a window and sets its overlay through Explorer from another thread, as the app does.
    #[cfg(windows)]
    #[test]
    #[ignore = "shows a window on the taskbar"]
    fn overlay_reaches_the_taskbar_of_a_real_window() {
        use windows::{
            core::w,
            Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, TranslateMessage,
                MSG, PM_REMOVE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
            },
        };
        // SAFETY: a window of a system class, pumped and destroyed by this thread.
        let window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Agent Studio overlay check"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                0,
                0,
                320,
                120,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap();
        let pump = |for_ms: u64| {
            let until = std::time::Instant::now() + Duration::from_millis(for_ms);
            while std::time::Instant::now() < until {
                let mut message = MSG::default();
                // SAFETY: standard message pump for this thread's window.
                while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                    unsafe {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        pump(1500);
        let handle = window.0 as isize;
        for count in [7, 120, 0] {
            let call = std::thread::spawn(move || {
                let _com = taskbar::Apartment::enter();
                taskbar::set_overlay(handle, count)
            });
            while !call.is_finished() {
                pump(50);
            }
            assert!(call.join().unwrap(), "the taskbar refused count {count}");
            pump(500);
        }
        // SAFETY: the window this test created.
        unsafe { DestroyWindow(window) }.unwrap();
    }

    #[test]
    fn taskbar_badge_clears_zero_and_bounds_large_counts() {
        assert!(badge_icon(0).is_none());
        let one = badge_icon(1).unwrap();
        assert_eq!(one.len(), 32 * 32 * 4);
        assert_eq!(&one[..4], &[0, 0, 0, 0]);
        assert_ne!(one, badge_icon(2).unwrap());
        assert_ne!(badge_icon(99).unwrap(), badge_icon(100).unwrap());
        assert_eq!(badge_icon(100).unwrap(), badge_icon(u32::MAX).unwrap());
    }

    // The taskbar calls a test makes: each waits until the test lets it return.
    static CALLS: StdMutex<Vec<(isize, u32)>> = StdMutex::new(Vec::new());
    static GATE: (StdMutex<usize>, Condvar) = (StdMutex::new(0), Condvar::new());
    fn held(window: isize, count: u32) -> bool {
        CALLS.lock().unwrap().push((window, count));
        let (opened, changed) = &GATE;
        let mut opened = opened.lock().unwrap();
        let call = CALLS.lock().unwrap().len();
        while *opened < call {
            opened = changed.wait(opened).unwrap();
        }
        count != 13
    }
    fn open(calls: usize) {
        let (opened, changed) = &GATE;
        *opened.lock().unwrap() = calls;
        changed.notify_all();
    }
    fn idle(overlay: &Overlay) {
        for _ in 0..500 {
            if !overlay.lock().busy {
                return;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("the overlay thread did not finish");
    }
    fn calls() -> Vec<(isize, u32)> {
        CALLS.lock().unwrap().clone()
    }

    #[test]
    fn overlay_waits_for_its_window_then_sets_only_the_newest_count_off_the_caller() {
        let overlay = Overlay::with(held);
        assert!(overlay.show(1).is_err());
        overlay.attach(7);
        // The first call is still waiting for the taskbar, as for a busy Explorer: the
        // callers return at once and only the newest count follows it.
        overlay.show(1).unwrap();
        for _ in 0..500 {
            if !calls().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        overlay.show(2).unwrap();
        overlay.show(3).unwrap();
        assert_eq!(calls(), vec![(7, 1)]);
        open(2);
        idle(&overlay);
        assert_eq!(calls(), vec![(7, 1), (7, 3)]);
        // A count the taskbar already shows is not set again; one that failed is.
        overlay.show(3).unwrap();
        idle(&overlay);
        open(3);
        overlay.show(13).unwrap();
        idle(&overlay);
        open(4);
        overlay.show(13).unwrap();
        idle(&overlay);
        assert_eq!(calls(), vec![(7, 1), (7, 3), (7, 13), (7, 13)]);
    }
}
