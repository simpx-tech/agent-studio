//! Application-owned pending count. No arbitrary icon bytes or file paths cross IPC.
use tauri::Manager;

#[tauri::command]
pub fn set_pending_chat_badge(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Application window unavailable")?;
    #[cfg(target_os = "windows")]
    let result = window.set_overlay_icon(badge_icon(count));
    #[cfg(not(target_os = "windows"))]
    let result = window.set_badge_count((count > 0).then_some(i64::from(count)));
    result.map_err(|_| "Could not update the pending chat badge".into())
}

#[cfg(any(target_os = "windows", test))]
fn badge_icon(count: u32) -> Option<tauri::image::Image<'static>> {
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
    Some(tauri::image::Image::new_owned(rgba, 32, 32))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn taskbar_badge_clears_zero_and_bounds_large_counts() {
        assert!(badge_icon(0).is_none());
        let one = badge_icon(1).unwrap();
        assert_eq!(one.rgba().len(), 32 * 32 * 4);
        assert_eq!(&one.rgba()[..4], &[0, 0, 0, 0]);
        assert_ne!(one.rgba(), badge_icon(2).unwrap().rgba());
        assert_ne!(
            badge_icon(99).unwrap().rgba(),
            badge_icon(100).unwrap().rgba()
        );
        assert_eq!(
            badge_icon(100).unwrap().rgba(),
            badge_icon(u32::MAX).unwrap().rgba()
        );
    }
}
