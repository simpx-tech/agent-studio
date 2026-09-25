//! Device-local notifications: the chat's title and a plain line about its reply, prepared by
//! the page. No CLI data or user-supplied sound paths.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::Write,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

const CHIME: &[u8] = include_bytes!("../sounds/agent-chime.wav");
static AUDIO: Mutex<Option<Instant>> = Mutex::new(None);
#[cfg(not(target_os = "windows"))]
static LISTENERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    enabled: bool,
    sound: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_sent: Option<u64>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            last_error: None,
            last_sent: None,
        }
    }
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Saved {
    settings: Settings,
    receipts: VecDeque<String>,
}
#[derive(Default)]
pub struct Notifications(Mutex<Option<Saved>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notice {
    kind: Kind,
    conversation_id: Option<String>,
    tag: String,
    // The chat's title and a line about its reply (`chatNotification` in the page). Without
    // them the notice shows the generic text of its kind.
    title: Option<String>,
    body: Option<String>,
}
// In characters, as in the page, which already cut the text at a word.
const TITLE_LIMIT: usize = 80;
const BODY_LIMIT: usize = 180;
#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Complete,
    Attention,
    Error,
    Cancelled,
    Test,
}
impl Notice {
    fn validate(&self) -> Result<(), String> {
        let (id, event) = self.tag.split_once(':').ok_or("Invalid notification")?;
        let bounded = self.title.as_ref().is_none_or(|t| t.len() <= 1_000)
            && self.body.as_ref().is_none_or(|b| b.len() <= 2_000);
        let valid = bounded
            && if self.kind == Kind::Test {
                id == "test"
                    && uuid::Uuid::parse_str(event).is_ok()
                    && self.conversation_id.is_none()
                    && self.title.is_none()
                    && self.body.is_none()
            } else {
                uuid::Uuid::parse_str(id).is_ok()
                    && if self.kind == Kind::Attention {
                        // `attentionKeys` in the page: the first question call, then later
                        // calls and MCP input requests by their UUID.
                        event == "attention"
                            || event
                                .strip_prefix("attention:")
                                .or_else(|| event.strip_prefix("elicitation:"))
                                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
                    } else {
                        event == "terminal"
                    }
                    && self
                        .conversation_id
                        .as_deref()
                        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            };
        if valid {
            Ok(())
        } else {
            Err("Invalid notification".into())
        }
    }
    fn content(&self) -> (String, String) {
        let (title, body) = match self.kind {
            Kind::Complete => ("Reply ready", "Your agent finished its reply."),
            Kind::Attention => (
                "Your attention is needed",
                "Your agent asked for your input.",
            ),
            Kind::Error => ("Your agent needs attention", "The reply could not finish."),
            Kind::Cancelled => ("Your agent stopped", "The reply was stopped."),
            Kind::Test => (
                "Notifications are ready",
                "Agent Studio can notify you when work finishes or needs your attention.",
            ),
        };
        let text = |value: &Option<String>, limit, fallback: &str| {
            value
                .as_deref()
                .map(|value| line(value, limit))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| fallback.to_owned())
        };
        (
            text(&self.title, TITLE_LIMIT, title),
            text(&self.body, BODY_LIMIT, body),
        )
    }
}
// One plain line within `limit` characters. Toast XML cannot hold control characters or
// U+FFFE/U+FFFF, even escaped.
fn line(text: &str, limit: usize) -> String {
    let words = text
        .split(|c: char| {
            c.is_whitespace() || c.is_control() || matches!(c, '\u{fffe}' | '\u{ffff}')
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if words.chars().count() <= limit {
        return words;
    }
    let mut cut: String = words.chars().take(limit - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}
// Linux servers that render body markup would read <, > and & in chat text as markup.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate notification settings")?
        .join("desktop-notifications.json"))
}
fn read(app: &tauri::AppHandle, value: &mut Option<Saved>) -> Result<Saved, String> {
    if let Some(saved) = value {
        return Ok(saved.clone());
    }
    let saved = match std::fs::read(path(app)?) {
        Ok(bytes) if bytes.len() <= 100_000 => serde_json::from_slice::<Saved>(&bytes)
            .map_err(|_| "Cannot read notification settings")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
        _ => return Err("Cannot read notification settings".into()),
    };
    *value = Some(saved.clone());
    Ok(saved)
}
fn write(app: &tauri::AppHandle, saved: &Saved) -> Result<(), String> {
    let path = path(app)?;
    let root = path.parent().ok_or("Cannot locate notification settings")?;
    std::fs::create_dir_all(root).map_err(|_| "Cannot create notification settings")?;
    let mut file = tempfile::NamedTempFile::new_in(root)
        .map_err(|_| "Cannot prepare notification settings")?;
    file.write_all(&serde_json::to_vec(saved).map_err(|_| "Cannot encode notification settings")?)
        .map_err(|_| "Cannot save notification settings")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush notification settings")?;
    file.persist(path)
        .map_err(|_| "Cannot finish saving notification settings")?;
    Ok(())
}
#[tauri::command]
pub async fn desktop_notification_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    // A delivery may be waiting for macOS authorization; never block the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Notifications>();
        let mut lock = state
            .0
            .lock()
            .map_err(|_| "Notification settings unavailable")?;
        Ok(read(&app, &mut lock)?.settings)
    })
    .await
    .map_err(|_| "Notification settings unavailable")?
}
#[tauri::command]
pub async fn set_desktop_notifications(
    app: tauri::AppHandle,
    enabled: bool,
    sound: bool,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            prepare(&app)?;
        }
        let state = app.state::<Notifications>();
        let mut lock = state
            .0
            .lock()
            .map_err(|_| "Notification settings unavailable")?;
        let mut saved = read(&app, &mut lock)?;
        saved.settings.enabled = enabled;
        saved.settings.sound = sound;
        saved.settings.last_error = None;
        write(&app, &saved)?;
        *lock = Some(saved.clone());
        Ok(saved.settings)
    })
    .await
    .map_err(|_| "Notification settings unavailable")?
}

// Windows requires an application identity even in an unpackaged/dev build.
// Register only this app's identifier, without modifying system sound settings.
fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    // Default-on delivery must also request authorization, without requiring a trip
    // through Connections. macOS remembers the answer and will not prompt again.
    #[cfg(target_os = "macos")]
    if !notify_rust::request_auth_blocking().map_err(|_| {
        "Cannot request notification permission. Open the installed Agent Studio app."
    })? {
        return Err("Allow Agent Studio notifications in System Settings to enable alerts.".into());
    }
    #[cfg(target_os = "windows")]
    {
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(format!(
                "Software\\Classes\\AppUserModelId\\{}",
                app.config().identifier
            ))
            .map_err(|_| "Cannot register Agent Studio notifications")?;
        key.set_value(
            "DisplayName",
            &app.config()
                .product_name
                .as_deref()
                .unwrap_or("Agent Studio"),
        )
        .map_err(|_| "Cannot register Agent Studio notifications")?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = app;
    Ok(())
}

fn chime() -> Result<(), String> {
    // Do not overlap or queue a chorus when several computers finish together.
    let Ok(mut last) = AUDIO.try_lock() else {
        return Ok(());
    };
    if last.is_some_and(|time| time.elapsed() < Duration::from_secs(2)) {
        return Ok(());
    }
    let mut stream = rodio::DeviceSinkBuilder::open_default_sink().map_err(|_| {
        "Notification sent, but no audio output is available. Check your sound device."
    })?;
    stream.log_on_drop(false);
    let player = rodio::play(stream.mixer(), std::io::Cursor::new(CHIME))
        .map_err(|_| "Notification sent, but the Agent Studio chime could not play.")?;
    *last = Some(Instant::now());
    player.sleep_until_end();
    Ok(())
}
fn show(app: &tauri::AppHandle, notice: &Notice) -> Result<(), String> {
    prepare(app)?;
    let (title, body) = notice.content();
    #[cfg(target_os = "windows")]
    {
        // Retain the native callback after banner dismissal for Notification Center clicks.
        let target = app.clone();
        let id = notice.conversation_id.clone();
        tauri_winrt_notification::Toast::new(&app.config().identifier)
            .title(&title).text1(&body).sound(None)
            .on_activated(move |_| { open(&target, id.as_deref()); Ok(()) })
            .show().map_err(|_| "Could not send a desktop notification. Check your system notification settings and try the test again.".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::sync::atomic::Ordering;
        #[cfg(all(unix, not(target_os = "macos")))]
        let body = if notify_rust::get_capabilities()
            .is_ok_and(|capabilities| capabilities.iter().any(|c| c == "body-markup"))
        {
            escape_markup(&body)
        } else {
            body
        };
        let mut notification = notify_rust::Notification::new();
        notification
            .appname("Agent Studio")
            .summary(&title)
            .body(&body)
            .timeout(10_000);
        // No sound_name: macOS UNNotificationContent.sound is nil.
        // Linux needs an explicit hint.
        #[cfg(all(unix, not(target_os = "macos")))]
        notification
            .hint(notify_rust::Hint::SuppressSound(true))
            .hint(notify_rust::Hint::DesktopEntry(
                app.config().identifier.clone(),
            ));
        if notice.conversation_id.is_some() {
            notification.action("default", "Open chat");
        }
        let handle = notification.show().map_err(|_| "Could not send a desktop notification. Check your system notification settings and try the test again.")?;
        // Some Linux notification servers never emit dismissal. Bound listener threads
        // while continuing to deliver banners and sound if such a server is used.
        if LISTENERS
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 32).then_some(n + 1)
            })
            .is_ok()
        {
            let app = app.clone();
            let id = notice.conversation_id.clone();
            std::thread::spawn(move || {
                let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if matches!(response, notify_rust::NotificationResponse::Default)
                    || matches!(response, notify_rust::NotificationResponse::Action(action) if action == "default") {
                    open(&app, id.as_deref());
                }
            });
                LISTENERS.fetch_sub(1, Ordering::SeqCst);
            });
        }
        Ok(())
    }
}

fn open(app: &tauri::AppHandle, id: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(id) = id {
            let _ = window.emit("studio-notification-open", id);
        }
    }
}

#[tauri::command]
pub async fn desktop_notification(app: tauri::AppHandle, notice: Notice) -> Result<(), String> {
    notice.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Notifications>();
        // Serialize delivery/settings changes: disabling wins over queued work.
        let mut lock = state
            .0
            .lock()
            .map_err(|_| "Notification settings unavailable")?;
        let mut saved = read(&app, &mut lock)?;
        if !saved.settings.enabled || saved.receipts.contains(&notice.tag) {
            return Ok(());
        }
        saved.receipts.push_back(notice.tag.clone());
        while saved.receipts.len() > 512 {
            saved.receipts.pop_front();
        }
        write(&app, &saved)?;
        let result = show(&app, &notice).and_then(|()| {
            saved.settings.last_sent = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            );
            if saved.settings.sound {
                chime()?;
            }
            Ok(())
        });
        saved.settings.last_error = result.as_ref().err().cloned();
        *lock = Some(saved.clone());
        write(&app, &saved)?;
        result
    })
    .await
    .map_err(|_| "Desktop notification could not finish")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_lifecycle_notices() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut n = Notice {
            kind: Kind::Complete,
            conversation_id: Some(id.clone()),
            tag: format!("{id}:terminal"),
            title: Some("Fix the login flow".into()),
            body: Some("Done. The login flow now keeps the session.".into()),
        };
        assert!(n.validate().is_ok());
        n.body = Some("x".repeat(2_001));
        assert!(n.validate().is_err());
        n.body = None;
        n.tag = format!("{id}:attention");
        assert!(n.validate().is_err());
        n.kind = Kind::Attention;
        assert!(n.validate().is_ok());
        // Later question calls and MCP input requests are named by their UUID.
        for key in ["attention", "elicitation"] {
            n.tag = format!("{id}:{key}:{}", uuid::Uuid::new_v4());
            assert!(n.validate().is_ok());
        }
        n.tag = format!("{id}:elicitation:file:///private");
        assert!(n.validate().is_err());
        n.tag = format!("{id}:attention");
        n.conversation_id = Some("file:///private".into());
        assert!(n.validate().is_err());
        n.kind = Kind::Test;
        n.tag = format!("test:{id}");
        n.conversation_id = None;
        assert!(n.validate().is_err());
        n.title = None;
        assert!(n.validate().is_ok());
    }
    #[test]
    fn shows_the_chat_title_and_reply_line_as_plain_bounded_text() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut n = Notice {
            kind: Kind::Cancelled,
            conversation_id: Some(id.clone()),
            tag: format!("{id}:terminal"),
            title: Some("Fix\u{0}the <toast> & \u{ffff}titles\n".into()),
            body: Some(format!("Stopped: {}", "word ".repeat(60))),
        };
        let (title, body) = n.content();
        assert_eq!(title, "Fix the <toast> & titles");
        assert!(body.chars().count() <= BODY_LIMIT);
        assert!(body.starts_with("Stopped: word word") && body.ends_with("word…"));
        n.title = Some(" \t".into());
        n.body = None;
        assert_eq!(
            n.content(),
            (
                "Your agent stopped".to_owned(),
                "The reply was stopped.".to_owned()
            )
        );
        assert_eq!(
            escape_markup("a < b && c > d"),
            "a &lt; b &amp;&amp; c &gt; d"
        );
    }
    #[test]
    fn bundled_chime_is_short_audible_pcm_without_clipping() {
        use rodio::Source;
        let source = rodio::Decoder::try_from(std::io::Cursor::new(CHIME)).unwrap();
        let duration = source.total_duration().unwrap().as_secs_f32();
        assert!((0.5..1.5).contains(&duration));
        let peak = source.map(f32::abs).fold(0.0, f32::max);
        assert!((0.1..0.8).contains(&peak));
    }
    #[test]
    fn notifications_default_on_without_overriding_saved_disable_or_mute() {
        let saved = Saved::default();
        assert!(saved.settings.enabled);
        assert!(saved.settings.sound);
        for json in ["{}", r#"{"settings":{}}"#] {
            let restored: Saved = serde_json::from_str(json).unwrap();
            assert!(restored.settings.enabled && restored.settings.sound);
        }
        for enabled in [false, true] {
            for sound in [false, true] {
                let json = serde_json::json!({"settings": {"enabled": enabled, "sound": sound}});
                let saved: Saved = serde_json::from_value(json).unwrap();
                let encoded = serde_json::to_vec(&saved).unwrap();
                let restored: Saved = serde_json::from_slice(&encoded).unwrap();
                assert_eq!(restored.settings.enabled, enabled);
                assert_eq!(restored.settings.sound, sound);
            }
        }
    }
}
