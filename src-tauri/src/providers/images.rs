use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

// Neither a message nor a conversation has an image budget: messages keep references to the
// image store (src-tauri/src/chat_images.rs), and a provider that accepts fewer or smaller images
// reports its own limit.

/// An image of a message: a reference to the image store, or, from an app older than the store,
/// its bytes inline. The fields serialize in this order, so an inline image fingerprints exactly
/// as native sessions recorded it before the store (see `sessions::Session::prepare`).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    pub id: String,
    pub name: String,
    pub media_type: String,
    /// The bytes as base64: inline in a request from an older app, and put in memory for the
    /// images a reply sends to its provider (`chat_images::materialize`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// The SHA-256 of the bytes, which names them in the image store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

impl ChatImage {
    pub fn validate(&self) -> Result<usize, String> {
        uuid::Uuid::parse_str(&self.id).map_err(|_| "Invalid image id")?;
        if self.name.is_empty() {
            return Err("Invalid image name".into());
        }
        let (data, hash) = (self.data.as_deref(), self.hash.as_deref());
        if let (None, Some(hash)) = (data, hash) {
            let bytes = self.bytes.unwrap_or(0) as usize;
            if !crate::chat_images::valid_hash(hash)
                || !matches!(
                    self.media_type.as_str(),
                    "image/png" | "image/jpeg" | "image/webp"
                )
                || bytes == 0
            {
                return Err("Invalid image reference".into());
            }
            return Ok(bytes);
        }
        let Some(data) = data.filter(|_| hash.is_none()) else {
            return Err("Invalid image reference".into());
        };
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| "Invalid image encoding")?;
        let valid = match self.media_type.as_str() {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        if !valid {
            return Err("Attach a valid PNG, JPEG, or WebP image".into());
        }
        Ok(bytes.len())
    }
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.base64())
    }
    /// The bytes as base64, which a reply's request holds for the images it sends.
    pub fn base64(&self) -> &str {
        self.data.as_deref().unwrap_or_default()
    }
    pub fn label(&self, message: usize, image: usize) -> String {
        format!(
            "Image {} attached to conversation message {} (user). Filename: {}",
            image + 1,
            message + 1,
            serde_json::json!(self.name)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{chat_command, Executable, RunRequest};
    use serde_json::{json, Value};

    pub fn request(provider: &str) -> RunRequest {
        serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":provider,"model":"","instructions":""},"messages":[{"role":"user","text":"","images":[{"id":uuid::Uuid::new_v4(),"name":"quote \" $(literal).png","mediaType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="}]}]})).unwrap()
    }
    #[tokio::test]
    async fn claude_delivers_visual_blocks_on_stdin_with_matching_cli_mode() {
        let mut r = request("claude");
        assert!(r.validate().is_ok());
        let image = r.messages[0].images[0].clone();
        r.messages
            .push(serde_json::from_value(json!({"role":"assistant","text":"An image"})).unwrap());
        r.messages.push(
            serde_json::from_value(json!({"role":"user","text":"Describe it again"})).unwrap(),
        );
        let payload: Value =
            serde_json::from_str(r.stdin_payload().lines().next().unwrap()).unwrap();
        assert_eq!(payload["shouldQuery"], false);
        assert!(payload["origin"].is_null());
        assert_eq!(
            payload["message"]["content"][2]["source"]["data"],
            image.base64()
        );
        assert_eq!(
            payload["message"]["content"][2]["source"]["media_type"],
            "image/png"
        );
        assert!(payload["message"]["content"][1]["text"]
            .as_str()
            .unwrap()
            .contains("message 1"));
        assert!(!r.prompt().contains(image.base64()));
        let dir = tempfile::tempdir().unwrap();
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture-cli".into(),
            prefix: vec![],
            wsl: None,
        };
        let command = chat_command(&r, dir.path(), &exe).await.unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy())
            .collect();
        assert!(args
            .windows(2)
            .any(|a| a[0] == "--input-format" && a[1] == "stream-json"));
        assert!(!args.iter().any(|a| a.contains(image.base64())));
    }
    #[test]
    fn rejects_unsupported_roles_providers_background_requests_and_malformed_images() {
        let r = request("codex");
        assert!(r.validate().is_ok());
        let mut bad = request("gemini");
        assert!(bad.validate().unwrap_err().contains("Codex and Claude"));
        bad = r.clone();
        bad.conversation_only = true;
        assert!(bad.validate().is_err());
        bad = r.clone();
        bad.messages[0].role = "assistant".into();
        assert!(bad.validate().is_err());
        for data in ["https://example.com/img.png", "!!!!", ""] {
            bad = r.clone();
            bad.messages[0].images[0].data = Some(data.into());
            assert!(bad.validate().is_err());
        }
        bad = r.clone();
        bad.messages[0].images[0].media_type = "image/svg+xml".into();
        assert!(bad.validate().is_err());
        bad = r.clone();
        bad.messages[0].images[0].data = Some(STANDARD.encode(vec![0; 64]));
        assert!(bad.validate().is_err());
        // Neither a message nor a conversation has an image budget: any number of images of any
        // size, past the 16 images of 16 MB earlier releases allowed.
        let mut many = r.clone();
        many.messages[0].images = vec![r.messages[0].images[0].clone(); 17];
        assert!(many.validate().is_ok());
        let mut bytes = vec![0; 17 * 1024 * 1024];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let mut large = r.clone();
        large.messages[0].images[0].data = Some(STANDARD.encode(bytes));
        assert!(large.validate().is_ok());
        // A reference to the image store names its bytes by hash, whatever their size.
        let mut stored = r.clone();
        let image = &mut stored.messages[0].images[0];
        (image.data, image.hash, image.bytes) = (None, Some("a".repeat(64)), Some(68));
        assert!(stored.validate().is_ok());
        stored.messages[0].images[0].bytes = Some(64 * 1024 * 1024 * 1024);
        assert!(stored.validate().is_ok());
        stored.messages[0].images[0].bytes = Some(68);
        for (hash, bytes) in [
            ("A".repeat(64), 68),
            ("a".repeat(63), 68),
            ("a".repeat(64), 0),
        ] {
            let mut bad = stored.clone();
            let image = &mut bad.messages[0].images[0];
            (image.hash, image.bytes) = (Some(hash), Some(bytes));
            assert!(bad.validate().is_err());
        }
        // An image is either a reference or inline, never both.
        let mut both = stored.clone();
        both.messages[0].images[0].data = r.messages[0].images[0].data.clone();
        assert!(both.validate().is_err());
        // Its request still fingerprints without bytes, as the store names them.
        let saved = serde_json::to_value(&stored.messages[0].images[0]).unwrap();
        assert_eq!(
            saved.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["bytes", "hash", "id", "mediaType", "name"]
        );
    }
}
