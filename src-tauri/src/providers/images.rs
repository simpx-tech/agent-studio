use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

/// One message becomes one provider request and one preview each. A conversation has no image
/// budget: saving and syncing move one conversation at a time, so its images no longer set the
/// cost of a reply. A provider that accepts less than this reports its own limit.
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGES_PER_MESSAGE: usize = 16;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub data: String,
}

impl ChatImage {
    pub fn validate(&self) -> Result<usize, String> {
        uuid::Uuid::parse_str(&self.id).map_err(|_| "Invalid image id")?;
        if self.name.is_empty() || self.name.chars().count() > 200 {
            return Err("Invalid image name".into());
        }
        if self.data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("Images must be 16 MB or smaller".into());
        }
        let bytes = STANDARD
            .decode(&self.data)
            .map_err(|_| "Invalid image encoding")?;
        let valid = match self.media_type.as_str() {
            "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
            _ => false,
        };
        if !valid || bytes.len() > MAX_IMAGE_BYTES {
            return Err("Attach a valid PNG, JPEG, or WebP image up to 16 MB".into());
        }
        Ok(bytes.len())
    }
    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.media_type, self.data)
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
            image.data
        );
        assert_eq!(
            payload["message"]["content"][2]["source"]["media_type"],
            "image/png"
        );
        assert!(payload["message"]["content"][1]["text"]
            .as_str()
            .unwrap()
            .contains("message 1"));
        assert!(!r.prompt().contains(&image.data));
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
        assert!(!args.iter().any(|a| a.contains(&image.data)));
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
            bad.messages[0].images[0].data = data.into();
            assert!(bad.validate().is_err());
        }
        bad = r.clone();
        bad.messages[0].images[0].media_type = "image/svg+xml".into();
        assert!(bad.validate().is_err());
        bad = r.clone();
        bad.messages[0].images = vec![r.messages[0].images[0].clone(); MAX_IMAGES_PER_MESSAGE + 1];
        assert!(bad.validate().unwrap_err().contains("16 images"));
        bad = r.clone();
        bad.messages[0].images[0].data = STANDARD.encode(vec![0; MAX_IMAGE_BYTES + 1]);
        assert!(bad.validate().is_err());
        // A conversation has no image budget of its own: every message may carry a full one.
        let mut bytes = vec![0; MAX_IMAGE_BYTES];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let mut full = r.clone();
        full.messages[0].images[0].data = STANDARD.encode(bytes);
        full.messages = vec![full.messages[0].clone(); 5];
        assert!(full.validate().is_ok());
    }
}
