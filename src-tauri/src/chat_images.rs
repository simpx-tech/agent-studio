//! Chat images, kept apart from the conversations that show them. A message keeps a reference,
//! `{id, name, mediaType, hash, bytes}` with the SHA-256 of the bytes as `hash`, and the bytes
//! live once under `images/<hash>` in app data. Replies read what they send to a provider,
//! windows read what they show through the `studio-image` protocol, and exports read what they
//! write. An image this computer does not hold is read from the relay, which keeps each image
//! once for the workspace; before a conversation or a remote reply names an image the relay
//! lacks, the computer holding it uploads it (`upload`).
//!
//! Workspaces and requests from before this store carry images inline as base64. They are moved
//! into the store where they arrive (`store_inline`, `store_request`), so the rest of the app
//! sees references only.
use crate::providers::RunRequest;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

/// Told when a window or a reply needs an image neither this computer nor the relay can give.
pub const UNAVAILABLE: &str =
    "This image is not on this computer, and the relay cannot provide it. Open the chat on the computer that attached it while it is connected to the relay.";
/// Images the saved workspace no longer names are removed once they are this old, so an image
/// stored for a message not saved yet stays.
const UNSAVED_GRACE: Duration = Duration::from_secs(60 * 60);

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("images"))
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
/// The type an image's own first bytes report, of those a message may carry.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// What the store kept of an image, which the window turns into the message's reference.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub hash: String,
    pub bytes: u64,
    pub media_type: &'static str,
}

/// Keeps an image's bytes under their hash, written whole before they are named.
pub fn store(root: &Path, bytes: &[u8]) -> Result<Stored, String> {
    let media_type = image_type(bytes).ok_or("Attach a PNG, JPEG, or WebP image")?;
    let hash = hash(bytes);
    let path = root.join(&hash);
    if !path.is_file() {
        std::fs::create_dir_all(root).map_err(|_| "Cannot create the image folder")?;
        let mut file =
            tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare an image")?;
        file.write_all(bytes).map_err(|_| "Cannot write an image")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Cannot write an image")?;
        // Another writer may have kept the same bytes meanwhile; either copy will do.
        if file.persist_noclobber(&path).is_err() && !path.is_file() {
            return Err("Cannot save an image".into());
        }
    }
    Ok(Stored {
        hash,
        bytes: bytes.len() as u64,
        media_type,
    })
}
/// An image's bytes as this computer holds them.
pub fn read(root: &Path, hash: &str) -> Result<Vec<u8>, String> {
    if !valid_hash(hash) {
        return Err("Invalid image".into());
    }
    std::fs::read(root.join(hash)).map_err(|_| UNAVAILABLE.into())
}

/// An image's bytes on this computer, read from the relay when it does not hold them yet.
pub async fn ensure(app: &tauri::AppHandle, hash: &str) -> Result<Vec<u8>, String> {
    if !valid_hash(hash) {
        return Err("Invalid image".into());
    }
    let root = root(app)?;
    let local = root.clone();
    let wanted = hash.to_string();
    if let Ok(Ok(bytes)) = tauri::async_runtime::spawn_blocking(move || read(&local, &wanted)).await
    {
        return Ok(bytes);
    }
    let bytes = crate::relay::download_image(&app.state::<crate::relay::Relay>(), hash)
        .await
        .map_err(|_| UNAVAILABLE.to_string())?;
    if self::hash(&bytes) != hash {
        return Err("The relay sent a different image. It was not kept.".into());
    }
    let kept = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || store(&root, &kept))
        .await
        .map_err(|_| "Cannot save an image")??;
    Ok(bytes)
}

/// Uploads the images of `hashes` the relay lacks, from this computer. The hashes the relay
/// still lacks, because this computer does not hold them either, are returned.
pub async fn upload(app: &tauri::AppHandle, hashes: Vec<String>) -> Result<Vec<String>, String> {
    let relay = app.state::<crate::relay::Relay>();
    let root = root(app)?;
    let mut seen = HashSet::new();
    let hashes: Vec<String> = hashes
        .into_iter()
        .filter(|hash| valid_hash(hash) && seen.insert(hash.clone()))
        .collect();
    let mut unavailable = vec![];
    for chunk in hashes.chunks(1000) {
        for hash in crate::relay::missing_images(&relay, chunk).await? {
            let local = root.clone();
            let wanted = hash.clone();
            match tauri::async_runtime::spawn_blocking(move || read(&local, &wanted)).await {
                Ok(Ok(bytes)) => crate::relay::upload_image(&relay, &hash, bytes).await?,
                _ => unavailable.push(hash),
            }
        }
    }
    Ok(unavailable)
}

/// Calls `visit` with every image a saved workspace's conversations hold: in their messages and
/// in the messages a rewind keeps to restore.
fn each_image(conversations: &mut Value, visit: &mut impl FnMut(&mut Value)) {
    let mut messages = |messages: Option<&mut Value>| {
        for message in messages.and_then(Value::as_array_mut).into_iter().flatten() {
            for image in message
                .get_mut("images")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                visit(image);
            }
        }
    };
    for conversation in conversations.as_array_mut().into_iter().flatten() {
        messages(conversation.get_mut("messages"));
        messages(
            conversation
                .get_mut("rewind")
                .and_then(|rewind| rewind.get_mut("removed")),
        );
    }
}
/// The reference a message keeps for an image of these bytes.
fn reference(image: &Value, stored: &Stored) -> Value {
    serde_json::json!({
        "id": image["id"],
        "name": image["name"],
        "mediaType": image["mediaType"],
        "hash": stored.hash,
        "bytes": stored.bytes,
    })
}
/// Moves the images a saved workspace carries inline into the store, leaving references; true
/// when any moved. An image that cannot be stored stays inline, for the window to judge as it
/// always has.
pub fn store_inline(root: &Path, conversations: &mut Value) -> bool {
    let mut changed = false;
    each_image(conversations, &mut |image| {
        let Some(data) = image.get("data").and_then(Value::as_str) else {
            return;
        };
        let Ok(bytes) = STANDARD.decode(data) else {
            return;
        };
        let Ok(stored) = store(root, &bytes) else {
            return;
        };
        if image["mediaType"] != stored.media_type {
            return;
        }
        *image = reference(image, &stored);
        changed = true;
    });
    changed
}
/// Moves the images a request from an app older than the store carries inline into the store.
pub fn store_request(root: &Path, request: &mut RunRequest) -> Result<(), String> {
    for message in &mut request.messages {
        for image in &mut message.images {
            let Some(data) = image.data.take() else {
                continue;
            };
            let bytes = STANDARD
                .decode(&data)
                .map_err(|_| "Invalid image encoding")?;
            let stored = store(root, &bytes)?;
            if stored.media_type != image.media_type {
                return Err("Attach a valid PNG, JPEG, or WebP image".into());
            }
            image.hash = Some(stored.hash);
            image.bytes = Some(stored.bytes);
        }
    }
    Ok(())
}
/// Puts the bytes of the images a reply sends to its provider into its request: those of the
/// messages the provider receives, read here or from the relay. The request keeps them in memory
/// only; what it saves and fingerprints are references.
pub async fn materialize(app: &tauri::AppHandle, request: &mut RunRequest) -> Result<(), String> {
    for index in 0..request.messages.len() {
        if !request.native_image_message(index) {
            continue;
        }
        for image in 0..request.messages[index].images.len() {
            let current = &request.messages[index].images[image];
            if current.data.is_some() {
                continue;
            }
            let name = current.name.clone();
            let hash = current.hash.clone().ok_or("Invalid image")?;
            let bytes = ensure(app, &hash)
                .await
                .map_err(|error| format!("{name}: {error}"))?;
            request.messages[index].images[image].data = Some(STANDARD.encode(bytes));
        }
    }
    Ok(())
}
/// A saved workspace with its images' bytes inline again, as an export keeps them so it stands
/// on its own. Returns how many images this computer could not read.
pub fn inline_all(root: &Path, conversations: &mut Value) -> usize {
    let mut missing = 0;
    each_image(conversations, &mut |image| {
        let Some(hash) = image.get("hash").and_then(Value::as_str) else {
            return;
        };
        match read(root, hash) {
            Ok(bytes) => {
                *image = serde_json::json!({
                    "id": image["id"],
                    "name": image["name"],
                    "mediaType": image["mediaType"],
                    "data": STANDARD.encode(bytes),
                });
            }
            Err(_) => missing += 1,
        }
    });
    missing
}
/// The images a saved workspace names, which an export needs on this computer.
pub fn hashes(conversations: &mut Value) -> Vec<String> {
    let mut hashes = vec![];
    each_image(conversations, &mut |image| {
        if let Some(hash) = image.get("hash").and_then(Value::as_str) {
            hashes.push(hash.to_string());
        }
    });
    hashes
}

/// The images the saved workspace names, or `None` when it cannot be read.
fn referenced(workspace: &Path) -> Option<HashSet<String>> {
    #[derive(Deserialize)]
    struct Image {
        #[serde(default)]
        hash: Option<String>,
    }
    #[derive(Deserialize)]
    struct Message {
        #[serde(default)]
        images: Vec<Image>,
    }
    #[derive(Deserialize)]
    struct Rewind {
        #[serde(default)]
        removed: Vec<Message>,
    }
    #[derive(Deserialize)]
    struct Conversation {
        #[serde(default)]
        messages: Vec<Message>,
        #[serde(default)]
        rewind: Option<Rewind>,
    }
    #[derive(Deserialize)]
    struct Saved {
        conversations: Vec<Conversation>,
    }
    let bytes = std::fs::read(workspace).ok()?;
    let saved: Saved = serde_json::from_slice(&bytes).ok()?;
    Some(
        saved
            .conversations
            .into_iter()
            .flat_map(|c| {
                c.messages
                    .into_iter()
                    .chain(c.rewind.into_iter().flat_map(|r| r.removed))
            })
            .flat_map(|m| m.images)
            .filter_map(|image| image.hash)
            .collect(),
    )
}
/// Removes images the saved workspace no longer names, such as those of deleted chats, once
/// they are an hour old.
pub fn prune(root: &Path) {
    let Some(referenced) = root
        .parent()
        .and_then(|data| referenced(&data.join("workspace.json")))
    else {
        return;
    };
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if referenced.contains(&name) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > UNSAVED_GRACE);
        if old && entry.path().is_file() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// An image for a window, over the `studio-image` protocol: its bytes from this computer or the
/// relay, with the type they report. Only hashes name images; no path reaches the file system.
pub async fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let hash = path.trim_start_matches('/');
    let answer = |status: u16, kind: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", kind)
            .header("Cache-Control", "private, max-age=31536000, immutable")
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
            .expect("static response")
    };
    match ensure(app, hash).await {
        Ok(bytes) => answer(
            200,
            image_type(&bytes).unwrap_or("application/octet-stream"),
            bytes,
        ),
        Err(error) => tauri::http::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("Cache-Control", "no-store")
            .body(error.into_bytes())
            .expect("static response"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
        0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0,
    ];

    #[test]
    fn stores_each_image_once_under_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("images");
        let first = store(&root, PNG).unwrap();
        assert_eq!(first.hash, hash(PNG));
        assert_eq!(
            (first.bytes, first.media_type),
            (PNG.len() as u64, "image/png")
        );
        assert_eq!(store(&root, PNG).unwrap(), first);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(read(&root, &first.hash).unwrap(), PNG);
        assert!(store(&root, b"not an image").is_err());
        assert!(read(&root, "../workspace.json").is_err());
        assert!(read(&root, &hash(b"elsewhere")).is_err());
    }

    #[test]
    fn a_saved_workspace_moves_inline_images_into_the_store_and_back_for_exports() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("images");
        let id = uuid::Uuid::new_v4().to_string();
        let inline = json!({"id": id, "name": "shot.png", "mediaType": "image/png", "data": STANDARD.encode(PNG)});
        let mut conversations = json!([{
            "messages": [{"role": "user", "images": [inline.clone()]}],
            "rewind": {"removed": [{"role": "user", "images": [inline.clone()]}], "createdAt": "now"}
        }]);
        assert!(store_inline(&root, &mut conversations));
        let reference = json!({"id": id, "name": "shot.png", "mediaType": "image/png", "hash": hash(PNG), "bytes": PNG.len()});
        assert_eq!(conversations[0]["messages"][0]["images"][0], reference);
        assert_eq!(
            conversations[0]["rewind"]["removed"][0]["images"][0],
            reference
        );
        assert_eq!(conversations[0]["rewind"]["createdAt"], "now");
        // Nothing moves twice.
        assert!(!store_inline(&root, &mut conversations));
        assert_eq!(hashes(&mut conversations), vec![hash(PNG), hash(PNG)]);
        // An export puts the bytes back, as the image was saved before the store.
        assert_eq!(inline_all(&root, &mut conversations), 0);
        assert_eq!(conversations[0]["messages"][0]["images"][0], inline);
        // An image that is not what it claims stays inline for the window to judge.
        let mut odd = json!([{"messages": [{"images": [{"id": id, "name": "x.png", "mediaType": "image/jpeg", "data": STANDARD.encode(PNG)}]}]}]);
        assert!(!store_inline(&root, &mut odd));
        assert!(odd[0]["messages"][0]["images"][0]["data"].is_string());
    }

    #[test]
    fn pruning_keeps_images_the_saved_workspace_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("images");
        let kept = store(&root, PNG).unwrap();
        let mut other = PNG.to_vec();
        other.push(0);
        let dropped = store(&root, &other).unwrap();
        std::fs::write(
            dir.path().join("workspace.json"),
            json!({"conversations": [{"messages": [{"images": [{"hash": kept.hash}]}]}]})
                .to_string(),
        )
        .unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for name in [&kept.hash, &dropped.hash] {
            std::fs::File::options()
                .write(true)
                .open(root.join(name))
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        prune(&root);
        assert!(root.join(&kept.hash).is_file());
        assert!(!root.join(&dropped.hash).exists());
        // Without a readable workspace nothing is removed.
        let fresh = store(&root, &other).unwrap();
        std::fs::write(dir.path().join("workspace.json"), "not json").unwrap();
        prune(&root);
        assert!(root.join(&fresh.hash).is_file());
    }
}
