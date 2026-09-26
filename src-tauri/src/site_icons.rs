//! The icon a linked site serves for itself, read on the computer showing the reply so links
//! can carry their site mark the way a browser shows one. Only bounded image bytes cross IPC,
//! as a data URL, and readings stay in memory: no link, page or icon reaches the workspace,
//! exports or the relay, and nothing but the icon addresses of the origin itself is requested.
use base64::Engine;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// A site mark is one line high, so larger downloads are never worth a reply's icon.
const MAX_ICON: usize = 256 * 1024;
/// Only the beginning of a page is read, and only to find the icons it declares.
const MAX_PAGE: usize = 256 * 1024;
/// Site icons rarely change; a site without one is asked again later in the session.
const KEEP_FOUND: Duration = Duration::from_secs(12 * 60 * 60);
const KEEP_MISSING: Duration = Duration::from_secs(30 * 60);
/// Readings remembered at once, by count and by size; the oldest make room for a new one.
const KEEP_ORIGINS: usize = 500;
const KEEP_BYTES: usize = 8 * 1024 * 1024;
/// Declared icons tried when the usual address serves none.
const MAX_DECLARED: usize = 3;

type Readings = HashMap<String, (Option<String>, Instant)>;

fn readings() -> &'static Mutex<Readings> {
    static READINGS: OnceLock<Mutex<Readings>> = OnceLock::new();
    READINGS.get_or_init(Default::default)
}

/// The icon `origin` serves for itself as a data URL, or `None` when it serves none.
#[tauri::command]
pub async fn site_icon(origin: String) -> Result<Option<String>, String> {
    let origin = site_origin(&origin).ok_or("A site icon needs an http or https address")?;
    if let Some(reading) = readings()
        .lock()
        .ok()
        .and_then(|readings| remembered(&readings, &origin, Instant::now()))
    {
        return Ok(reading);
    }
    let icon = fetch(&origin).await;
    if let Ok(mut readings) = readings().lock() {
        remember(&mut readings, &origin, icon.clone(), Instant::now());
    }
    Ok(icon)
}

/// The scheme, host and port of a link, without its path, query or credentials.
fn site_origin(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

fn remembered(readings: &Readings, origin: &str, now: Instant) -> Option<Option<String>> {
    let (icon, read) = readings.get(origin)?;
    let keep = if icon.is_some() {
        KEEP_FOUND
    } else {
        KEEP_MISSING
    };
    (now.saturating_duration_since(*read) < keep).then(|| icon.clone())
}

fn remember(readings: &mut Readings, origin: &str, icon: Option<String>, now: Instant) {
    readings.insert(origin.to_string(), (icon, now));
    let mut bytes: usize = readings
        .values()
        .map(|(icon, _)| icon.as_ref().map_or(0, String::len))
        .sum();
    while readings.len() > KEEP_ORIGINS || bytes > KEEP_BYTES {
        let oldest = readings
            .iter()
            .filter(|(kept, _)| kept.as_str() != origin)
            .min_by_key(|(_, (_, read))| *read)
            .map(|(kept, _)| kept.clone());
        let Some(oldest) = oldest else { break };
        bytes -= readings
            .remove(&oldest)
            .and_then(|(icon, _)| icon)
            .map_or(0, |icon| icon.len());
    }
}

async fn fetch(origin: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("AgentStudio/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let site = reqwest::Url::parse(origin).ok()?;
    if let Some(icon) = image(&client, site.join("/favicon.ico").ok()?).await {
        return Some(icon);
    }
    let page = body(&client, site.clone(), MAX_PAGE, false).await?;
    for href in icon_links(&String::from_utf8_lossy(&page)) {
        let Ok(url) = site.join(&href) else { continue };
        if matches!(url.scheme(), "http" | "https") {
            if let Some(icon) = image(&client, url).await {
                return Some(icon);
            }
        }
    }
    None
}

async fn image(client: &reqwest::Client, url: reqwest::Url) -> Option<String> {
    let bytes = body(client, url, MAX_ICON, true).await?;
    let kind = icon_type(&bytes)?;
    Some(format!(
        "data:{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// At most `limit` bytes of a response. A `complete` read fails rather than return part of an
/// oversized file; a page keeps the beginning it read, where its icons are declared.
async fn body(
    client: &reqwest::Client,
    url: reqwest::Url,
    limit: usize,
    complete: bool,
) -> Option<Vec<u8>> {
    let mut response = client
        .get(url)
        .header("accept", "image/*,text/html;q=0.5")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > limit {
            if complete {
                return None;
            }
            bytes.extend_from_slice(&chunk[..limit - bytes.len()]);
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    (!bytes.is_empty()).then_some(bytes)
}

/// The image type named by an icon's first bytes, so a page served in place of a missing icon
/// is never shown as one.
fn icon_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if let Some((kind, _)) = crate::tool_output::sniff(bytes) {
        return Some(kind);
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = head.trim_start();
    (head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")))
        .then_some("image/svg+xml")
}

/// The icon addresses a page declares, in document order.
fn icon_links(page: &str) -> Vec<String> {
    let head = page.split_once("</head>").map_or(page, |(head, _)| head);
    let mut found = vec![];
    let mut at = 0;
    while let Some(start) = find_ignore_case(head, "<link", at) {
        let end = head[start..].find('>').map_or(head.len(), |i| start + i);
        let tag = &head[start..end];
        at = end.max(start + 5);
        let Some(rel) = attribute(tag, "rel") else {
            continue;
        };
        if !rel.split_whitespace().any(|word| {
            word.eq_ignore_ascii_case("icon") || word.eq_ignore_ascii_case("apple-touch-icon")
        }) {
            continue;
        }
        let Some(href) = attribute(tag, "href") else {
            continue;
        };
        let href = href.trim().replace("&amp;", "&");
        if !href.is_empty() && !href.starts_with("data:") {
            found.push(href);
        }
        if found.len() == MAX_DECLARED {
            break;
        }
    }
    found
}

/// One attribute of a tag, quoted or bare, whatever case its name was written in.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let mut at = 0;
    while let Some(start) = find_ignore_case(tag, name, at) {
        at = start + name.len();
        if start == 0 || !tag.as_bytes()[start - 1].is_ascii_whitespace() {
            continue;
        }
        let Some(value) = tag[at..].trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        return Some(match value.chars().next()? {
            quote @ ('"' | '\'') => value[1..].split(quote).next()?.to_string(),
            _ => value.split_ascii_whitespace().next()?.to_string(),
        });
    }
    None
}

fn find_ignore_case(text: &str, needle: &str, from: usize) -> Option<usize> {
    let (text, needle) = (text.as_bytes(), needle.as_bytes());
    (from..=text.len().checked_sub(needle.len())?)
        .find(|&start| text[start..start + needle.len()].eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
        0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0,
    ];

    #[test]
    fn keeps_only_the_origin_of_an_http_link() {
        assert_eq!(
            site_origin("https://en.wikipedia.org/wiki/Special:Random?a=1#top"),
            Some("https://en.wikipedia.org".into())
        );
        assert_eq!(
            site_origin("http://localhost:5173/app"),
            Some("http://localhost:5173".into())
        );
        // Case, default ports and credentials never split or leak an origin.
        assert_eq!(
            site_origin("HTTPS://Example.COM:443/x"),
            Some("https://example.com".into())
        );
        assert_eq!(
            site_origin("https://user:secret@example.com/x"),
            Some("https://example.com".into())
        );
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:someone@example.com",
            "data:text/html,<b>x</b>",
            "not a url",
            "",
        ] {
            assert_eq!(site_origin(value), None, "{value}");
        }
    }

    #[test]
    fn recognizes_icon_bytes_and_rejects_a_page_served_instead() {
        assert_eq!(icon_type(&[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(icon_type(PNG), Some("image/png"));
        assert_eq!(icon_type(b"GIF89a\0\0\0\0"), Some("image/gif"));
        assert_eq!(icon_type(b"  <svg xmlns='x'/>"), Some("image/svg+xml"));
        assert_eq!(
            icon_type(b"<?xml version=\"1.0\"?><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(icon_type(b"<!DOCTYPE html><html>Not found</html>"), None);
        assert_eq!(icon_type(b""), None);
    }

    #[test]
    fn reads_the_icons_a_page_declares_in_order() {
        let page = "<html><head>\
            <link rel=\"stylesheet\" href=\"/app.css\">\
            <link rel=\"mask-icon\" href=\"/pinned.svg\" color=\"#000\">\
            <link REL='Shortcut Icon' HREF='/Icons/Site.ico?v=2'>\
            <link rel=\"icon\" type=\"image/png\" href=/small.png sizes=\"16x16\">\
            <link rel=\"apple-touch-icon\" href=\"https://cdn.example.com/touch.png\">\
            <link rel=\"icon\" href=\"/fourth.png\">\
            </head><body><link rel=\"icon\" href=\"/body.png\"></body></html>";
        assert_eq!(
            icon_links(page),
            [
                "/Icons/Site.ico?v=2",
                "/small.png",
                "https://cdn.example.com/touch.png"
            ]
        );
        // Entities are decoded; data URLs and icons without an address are skipped.
        assert_eq!(
            icon_links(
                "<link rel=icon href=\"/i.png?a=1&amp;b=2\"><link rel=icon href=\"data:,\">"
            ),
            ["/i.png?a=1&b=2"]
        );
        assert_eq!(icon_links("<link rel=\"icon\">"), Vec::<String>::new());
        assert_eq!(icon_links("<p>no head</p>"), Vec::<String>::new());
    }

    #[test]
    fn reads_an_attribute_without_confusing_its_name() {
        let tag = "<link data-href='/decoy.png' rel=\"icon\" href = \"/real.png\" crossorigin>";
        assert_eq!(attribute(tag, "href"), Some("/real.png".into()));
        assert_eq!(attribute(tag, "rel"), Some("icon".into()));
        assert_eq!(attribute(tag, "sizes"), None);
        assert_eq!(attribute("<link crossorigin>", "crossorigin"), None);
    }

    #[tokio::test]
    #[ignore = "Opt-in network test; reads the icons real sites serve."]
    async fn reads_the_icons_real_sites_serve() {
        for origin in [
            "https://en.wikipedia.org",
            "https://github.com",
            "https://developer.mozilla.org",
            "https://docs.rs",
        ] {
            let icon = site_icon(origin.to_string()).await.unwrap();
            let read = icon
                .as_deref()
                .and_then(|icon| icon.split_once(";base64,"))
                .map(|(kind, data)| (kind.to_string(), data.len()));
            println!("{origin} -> {read:?}");
            assert!(read.is_some(), "{origin} served no icon");
        }
        // The reading is kept, so a link to a site read before answers without a request.
        let again = site_icon("https://en.wikipedia.org/".into()).await.unwrap();
        assert!(again.is_some());
        assert_eq!(site_icon("https://example.invalid".into()).await, Ok(None));
    }

    #[test]
    fn keeps_readings_until_they_expire_and_makes_room_for_new_origins() {
        let mut readings = Readings::new();
        let start = Instant::now();
        remember(
            &mut readings,
            "https://a.example",
            Some("data:x".into()),
            start,
        );
        remember(&mut readings, "https://b.example", None, start);
        assert_eq!(
            remembered(&readings, "https://a.example", start),
            Some(Some("data:x".into()))
        );
        assert_eq!(
            remembered(&readings, "https://b.example", start),
            Some(None)
        );
        assert_eq!(remembered(&readings, "https://c.example", start), None);
        // A site without an icon is asked again long before a found icon is read again.
        let later = start + KEEP_MISSING + Duration::from_secs(1);
        assert_eq!(remembered(&readings, "https://b.example", later), None);
        assert_eq!(
            remembered(&readings, "https://a.example", later),
            Some(Some("data:x".into()))
        );
        assert_eq!(
            remembered(&readings, "https://a.example", start + KEEP_FOUND),
            None
        );
        for index in 0..KEEP_ORIGINS {
            remember(
                &mut readings,
                &format!("https://{index}.example"),
                None,
                later,
            );
        }
        assert_eq!(readings.len(), KEEP_ORIGINS);
        // The oldest readings went first; the newest origin is still there.
        assert_eq!(remembered(&readings, "https://a.example", later), None);
        assert!(readings.contains_key(&format!("https://{}.example", KEEP_ORIGINS - 1)));
        // Large icons make room the same way, long before their count would.
        let mut large = Readings::new();
        for index in 0..12u64 {
            remember(
                &mut large,
                &format!("https://large{index}.example"),
                Some("x".repeat(KEEP_BYTES / 8)),
                later + Duration::from_secs(index),
            );
        }
        assert_eq!(large.len(), 8);
        assert!(large.contains_key("https://large11.example"));
    }
}
