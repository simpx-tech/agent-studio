//! Keeps WebView2's own browser shortcuts from reloading or navigating the app's window (requested
//! 2026-10-19, after a reload of the window stopped every running reply). F5, Ctrl+R and their
//! variants, the keyboard's Refresh, Back and Forward keys and Alt+Left/Right still reach the page
//! as keys, but the browser does nothing with them, and the right-click menu offers no Back,
//! Forward or Reload. Replies run on through a reload anyway (reply_feed.rs); the window would
//! still lose what only it holds, such as queued messages.

const VK_LEFT: u32 = 0x25;
const VK_RIGHT: u32 = 0x27;
const VK_R: u32 = 0x52;
const VK_F5: u32 = 0x74;
const VK_BROWSER_BACK: u32 = 0xA6;
const VK_BROWSER_FORWARD: u32 = 0xA7;
const VK_BROWSER_REFRESH: u32 = 0xA8;

/// Whether the browser would reload or navigate the window for this key going down. WebView2
/// reports a letter only with Ctrl or Alt held, and Alt makes a key a system key.
#[cfg_attr(not(windows), allow(dead_code))]
fn navigates(key: u32, alt: bool) -> bool {
    match key {
        VK_F5 | VK_R | VK_BROWSER_BACK | VK_BROWSER_FORWARD | VK_BROWSER_REFRESH => true,
        VK_LEFT | VK_RIGHT => alt,
        _ => false,
    }
}

/// The right-click menu's items that navigate the window, by WebView2's names for them.
#[cfg_attr(not(windows), allow(dead_code))]
fn navigation_item(name: &str) -> bool {
    matches!(name, "back" | "forward" | "reload")
}

/// Which of a menu's items stay once its navigation items go: separators that would lead, end or
/// follow another separator go too. `items` are each item's name and whether it separates.
#[cfg_attr(not(windows), allow(dead_code))]
fn kept_items(items: &[(String, bool)]) -> Vec<bool> {
    let mut kept: Vec<bool> = items
        .iter()
        .map(|(name, _)| !navigation_item(name))
        .collect();
    let mut previous_separates = true;
    for (index, (_, separator)) in items.iter().enumerate() {
        if !kept[index] {
            continue;
        }
        if *separator && previous_separates {
            kept[index] = false;
            continue;
        }
        previous_separates = *separator;
    }
    if let Some(last) = (0..items.len()).rev().find(|&index| kept[index]) {
        if items[last].1 {
            kept[last] = false;
        }
    }
    kept
}

#[cfg(windows)]
pub fn guard(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|platform| {
        use webview2_com::{
            AcceleratorKeyPressedEventHandler, ContextMenuRequestedEventHandler,
            Microsoft::Web::WebView2::Win32::{
                ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2_11,
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
                COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
                COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
            },
        };
        use windows::core::{Interface, PWSTR};
        let controller = platform.controller();
        let keys = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: WebView2 calls this on the window thread with live event arguments.
            unsafe {
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                let mut key = 0;
                args.KeyEventKind(&mut kind)?;
                args.VirtualKey(&mut key)?;
                let alt = kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
                if (alt || kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN) && navigates(key, alt) {
                    match args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                        // The page still hears the key.
                        Ok(args) => args.SetIsBrowserAcceleratorKeyEnabled(false)?,
                        Err(_) => args.SetHandled(true)?,
                    }
                }
            }
            Ok(())
        }));
        let menu = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            // SAFETY: WebView2 calls this on the window thread with live event arguments, and
            // each name it returns is freed by `take_pwstr`.
            unsafe {
                let menu = args.MenuItems()?;
                let mut count = 0;
                menu.Count(&mut count)?;
                let mut items = Vec::with_capacity(count as usize);
                for index in 0..count {
                    let item = menu.GetValueAtIndex(index)?;
                    let mut name = PWSTR::null();
                    item.Name(&mut name)?;
                    let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
                    item.Kind(&mut kind)?;
                    items.push((
                        webview2_com::take_pwstr(name),
                        kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
                    ));
                }
                let kept = kept_items(&items);
                for index in (0..count).rev() {
                    if !kept[index as usize] {
                        menu.RemoveValueAtIndex(index)?;
                    }
                }
                // A menu left empty does not open.
                if !kept.contains(&true) {
                    args.SetHandled(true)?;
                }
            }
            Ok(())
        }));
        let mut token = 0;
        // SAFETY: the controller is this window's live WebView2, on the window thread.
        unsafe {
            let _ = controller.add_AcceleratorKeyPressed(&keys, &mut token);
            if let Ok(webview) = controller
                .CoreWebView2()
                .and_then(|webview| webview.cast::<ICoreWebView2_11>())
            {
                let _ = webview.add_ContextMenuRequested(&menu, &mut token);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_and_history_keys_never_reach_the_browser() {
        for key in [
            VK_F5,
            VK_R,
            VK_BROWSER_REFRESH,
            VK_BROWSER_BACK,
            VK_BROWSER_FORWARD,
        ] {
            assert!(navigates(key, false));
        }
        assert!(navigates(VK_LEFT, true) && navigates(VK_RIGHT, true));
        // Arrows move through text and the model viewer as before.
        assert!(!navigates(VK_LEFT, false) && !navigates(VK_RIGHT, false));
        // Find, print and the rest stay the browser's.
        assert!(!navigates(0x46, false) && !navigates(0x50, false));
    }

    #[test]
    fn the_menu_keeps_everything_but_navigation_and_its_stray_separators() {
        let menu = |items: &[(&str, bool)]| {
            let items: Vec<_> = items.iter().map(|(n, s)| (n.to_string(), *s)).collect();
            let kept = kept_items(&items);
            items
                .iter()
                .zip(kept)
                .filter(|(_, kept)| *kept)
                .map(|((name, _), _)| name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            menu(&[
                ("back", false),
                ("forward", false),
                ("reload", false),
                ("other", true),
                ("saveAs", false),
                ("print", false),
                ("other", true),
                ("other", true),
                ("inspectElement", false),
            ]),
            ["saveAs", "print", "other", "inspectElement"]
        );
        assert_eq!(
            menu(&[("copy", false), ("other", true), ("reload", false)]),
            ["copy"]
        );
        assert!(menu(&[("back", false), ("other", true), ("reload", false)]).is_empty());
        assert_eq!(
            menu(&[("cut", false), ("copy", false), ("paste", false)]),
            ["cut", "copy", "paste"]
        );
    }
}
