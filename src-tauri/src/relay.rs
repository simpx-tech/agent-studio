use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::Path, sync::Mutex, time::Duration};
mod credentials;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBinding {
    url: String,
    instance_id: String,
    #[serde(default)]
    workspace_id: Option<String>,
}

// This binding deliberately survives disconnect. A different person's key must
// never publish this installation's local conversations or CLI connections.
fn bind_workspace(root: &Path, url: &reqwest::Url, remote: &Value) -> Result<(), String> {
    let instance_id = remote["instanceId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("Relay returned an invalid workspace identity")?;
    let workspace_id = remote["workspaceId"].as_str().unwrap_or("owner");
    if workspace_id != "owner" && uuid::Uuid::parse_str(workspace_id).is_err() {
        return Err("Relay returned an invalid workspace identity".into());
    }
    let file = root.join("relay-workspace.json");
    let stored = match std::fs::read(&file) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read(root.join("sync-state.json")) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err("Cannot read the saved workspace binding".into()),
            }
        }
        Err(_) => return Err("Cannot read the saved workspace binding".into()),
    };
    if let Some(bytes) = stored {
        let previous: WorkspaceBinding = serde_json::from_slice(&bytes)
            .map_err(|_| "Saved workspace binding is unreadable; pairing was not changed")?;
        let same_origin = endpoint(&previous.url).is_ok_and(|previous| previous == *url);
        if !same_origin
            || previous.instance_id != instance_id
            || previous
                .workspace_id
                .as_deref()
                .is_some_and(|id| id != workspace_id)
        {
            return Err("This installation belongs to a different private workspace. Use a separate OS user or isolated Agent Studio installation for another person. Pairing was not changed.".into());
        }
    }
    let next = WorkspaceBinding {
        url: url.to_string(),
        instance_id: instance_id.to_string(),
        workspace_id: Some(workspace_id.to_string()),
    };
    let mut temporary = tempfile::NamedTempFile::new_in(root)
        .map_err(|_| "Cannot prepare the workspace binding")?;
    temporary
        .write_all(&serde_json::to_vec(&next).map_err(|_| "Cannot encode workspace binding")?)
        .map_err(|_| "Cannot write the workspace binding")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot flush workspace binding")?;
    temporary
        .persist(file)
        .map_err(|_| "Cannot save workspace binding")?;
    Ok(())
}

#[derive(Default)]
pub struct Relay {
    connection: Mutex<Option<(reqwest::Client, reqwest::Url, String, String)>>,
    change: tokio::sync::Mutex<()>,
}
fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(value).map_err(|_| "Enter a valid relay URL")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Use HTTPS for a remote relay. HTTP is allowed only on loopback.".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Relay URL must be an origin, without credentials, path, query, or fragment".into(),
        );
    }
    url.set_path("/");
    Ok(url)
}
pub async fn connect(
    state: &Relay,
    identifier: &str,
    url: String,
    token: String,
    environment: String,
    directory: &Path,
) -> Result<(), String> {
    let _change = state.change.lock().await;
    let (client, url, remote) = validate(&url, &token, &environment).await?;
    bind_workspace(directory, &url, &remote)?;
    credentials::save(
        &credentials::target(identifier, &environment),
        &credentials::Pairing {
            url: url.to_string(),
            token: token.clone(),
        },
    )?;
    *state.connection.lock().map_err(|_| "Relay state failed")? =
        Some((client, url, token, environment));
    Ok(())
}

pub async fn resume(
    state: &Relay,
    identifier: &str,
    environment: String,
    directory: &Path,
) -> Result<Option<String>, String> {
    let _change = state.change.lock().await;
    if let Some((_, url, _, _)) = state
        .connection
        .lock()
        .map_err(|_| "Relay state failed")?
        .as_ref()
    {
        return Ok(Some(url.to_string()));
    }
    let Some(pairing) = credentials::load(&credentials::target(identifier, &environment))? else {
        return Ok(None);
    };
    let (client, url, remote) = validate(&pairing.url, &pairing.token, &environment).await?;
    bind_workspace(directory, &url, &remote)?;
    let origin = url.to_string();
    *state.connection.lock().map_err(|_| "Relay state failed")? =
        Some((client, url, pairing.token, environment));
    Ok(Some(origin))
}

pub async fn disconnect(state: &Relay, identifier: &str, environment: &str) -> Result<(), String> {
    // Serialize changes so a pending restoration cannot resurrect an explicit disconnect.
    let _change = state.change.lock().await;
    credentials::remove(&credentials::target(identifier, environment))?;
    *state.connection.lock().map_err(|_| "Relay state failed")? = None;
    Ok(())
}

/// A relay that sends nothing for this long while answering has stalled.
const IDLE_LIMIT: Duration = Duration::from_secs(30);
/// Sent with every request: this app keeps chat images as references to the relay's image
/// store (src-tauri/src/chat_images.rs), so the relay answers with references, not bytes.
const IMAGES: (&str, &str) = ("x-studio-images", "1");
/// Told when the relay predates the image store.
pub const OLD_RELAY: &str = "Update the relay to sync conversations with images.";

fn relay_client() -> Result<reqwest::Client, String> {
    // No total timeout: a request takes as long as the link and the relay need, and a relay
    // that stalls while answering is caught by the idle limit below. Keepalive probes notice a
    // connection that died while a request waits for its answer, which a slow relay never fails.
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .tcp_keepalive(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize relay client".into())
}

/// Reads an answer whole, however large, failing when the relay stalls.
async fn read_body(response: &mut reqwest::Response) -> Result<Vec<u8>, String> {
    let mut bytes = vec![];
    loop {
        let chunk = tokio::time::timeout(IDLE_LIMIT, response.chunk())
            .await
            .map_err(|_| "Relay response stalled")?
            .map_err(|_| "Relay response interrupted")?;
        let Some(chunk) = chunk else {
            return Ok(bytes);
        };
        bytes.extend_from_slice(&chunk);
    }
}

/// A GET for pairing, with the answer's status and its JSON body when it has one.
async fn identify(
    client: &reqwest::Client,
    url: &reqwest::Url,
    path: &str,
    token: &str,
    environment: &str,
) -> Result<(reqwest::StatusCode, Option<Value>), String> {
    let request = client
        .get(url.join(path).map_err(|_| "Invalid relay URL")?)
        .bearer_auth(token)
        .header("x-environment-id", environment)
        .header(IMAGES.0, IMAGES.1)
        .send();
    let mut response = request
        .await
        .map_err(|_| "Cannot connect to the relay. Check its URL, TLS, and network connection.")?;
    let status = response.status();
    let bytes = read_body(&mut response).await?;
    Ok((status, serde_json::from_slice(&bytes).ok()))
}

async fn validate(
    url: &str,
    token: &str,
    environment: &str,
) -> Result<(reqwest::Client, reqwest::Url, Value), String> {
    let url = endpoint(url)?;
    if token.len() < 32 || token.chars().any(char::is_control) {
        return Err("Enter the relay pairing key (at least 32 characters)".into());
    }
    let client = relay_client()?;
    let rejected = || "Relay rejected the connection. Check the pairing key and server version.";
    // A relay that names its workspace in the small revision answer is identified without
    // sending its whole state. An older one sends the state, which names it instead; a missing
    // workspace there means the owner's, so the smaller answer is used only when it has one.
    let (status, identity) =
        identify(&client, &url, "v1/state/revision", token, environment).await?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(rejected().into());
    }
    if let Some(identity) = identity.filter(|value| {
        status.is_success() && value["instanceId"].is_string() && value["workspaceId"].is_string()
    }) {
        return Ok((client, url, identity));
    }
    let (status, remote) = identify(&client, &url, "v1/state", token, environment).await?;
    if !status.is_success() {
        return Err(rejected().into());
    }
    let remote = remote.ok_or("Relay returned an invalid response")?;
    Ok((client, url, remote))
}
pub async fn request(
    state: &Relay,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    if !["GET", "POST", "PUT"].contains(&method)
        || !path.starts_with("v1/")
        || path.contains(['?', '#', '\\'])
        || path.split('/').any(|s| s == "..")
    {
        return Err("Invalid relay operation".into());
    }
    let (client, url, token, environment) = connection(state)?;
    let mut request = client
        .request(
            method.parse().map_err(|_| "Invalid method")?,
            url.join(path).map_err(|_| "Invalid relay path")?,
        )
        .bearer_auth(token)
        .header("x-environment-id", environment)
        .header(IMAGES.0, IMAGES.1);
    if let Some(body) = body {
        let bytes = serde_json::to_vec(&body).map_err(|_| "Cannot encode the relay request")?;
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Relay connection lost. Local changes remain on this device.")?;
    let status = response.status().as_u16();
    let bytes = read_body(&mut response).await?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Relay returned an invalid response")?;
    Ok(json!({"status": status, "body": value}))
}
type Connection = (reqwest::Client, reqwest::Url, String, String);
fn connection(state: &Relay) -> Result<Connection, String> {
    state
        .connection
        .lock()
        .map_err(|_| "Relay state failed")?
        .clone()
        .ok_or_else(|| "Connect to the relay first".into())
}
/// A request for the image store, authenticated as every relay request is.
fn image_request(
    (client, url, token, environment): &Connection,
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::RequestBuilder, String> {
    Ok(client
        .request(method, url.join(path).map_err(|_| "Invalid relay path")?)
        .bearer_auth(token)
        .header("x-environment-id", environment)
        .header(IMAGES.0, IMAGES.1))
}
/// The relay's own reason for refusing an image request, or a plain one.
fn refusal(status: reqwest::StatusCode, bytes: &[u8]) -> String {
    if status == reqwest::StatusCode::NOT_FOUND {
        return OLD_RELAY.into();
    }
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("Relay image request failed ({status})."))
}
/// Which of these images the relay lacks.
pub async fn missing_images(state: &Relay, hashes: &[String]) -> Result<Vec<String>, String> {
    let connection = connection(state)?;
    let body = serde_json::to_vec(&json!({ "hashes": hashes }))
        .map_err(|_| "Cannot encode the relay request")?;
    let request = image_request(&connection, reqwest::Method::POST, "v1/images/missing")?
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send();
    let mut response = request.await.map_err(|_| "Relay connection lost.")?;
    let status = response.status();
    let bytes = read_body(&mut response).await?;
    if !status.is_success() {
        return Err(refusal(status, &bytes));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Relay returned an invalid response")?;
    Ok(value["missing"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hash| hash.as_str())
        .filter(|hash| hashes.iter().any(|sent| sent == hash))
        .map(str::to_owned)
        .collect())
}
/// Uploads one image's bytes, which the relay checks against their hash.
pub async fn upload_image(state: &Relay, hash: &str, bytes: Vec<u8>) -> Result<(), String> {
    let connection = connection(state)?;
    let request = image_request(
        &connection,
        reqwest::Method::PUT,
        &format!("v1/images/{hash}"),
    )?
    .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
    .body(bytes)
    .send();
    let mut response = request
        .await
        .map_err(|_| "Relay connection lost while uploading an image.")?;
    let status = response.status();
    let answer = read_body(&mut response).await?;
    if status.is_success() {
        Ok(())
    } else {
        Err(refusal(status, &answer))
    }
}
/// One image's bytes from the relay's image store.
pub async fn download_image(state: &Relay, hash: &str) -> Result<Vec<u8>, String> {
    let connection = connection(state)?;
    let request = image_request(
        &connection,
        reqwest::Method::GET,
        &format!("v1/images/{hash}"),
    )?
    .send();
    let mut response = request.await.map_err(|_| "Relay connection lost.")?;
    let status = response.status();
    let bytes = read_body(&mut response).await?;
    if status.is_success() {
        Ok(bytes)
    } else {
        Err(refusal(status, &bytes))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_workspace_binding_survives_repairing_and_rejects_other_users() {
        let root = tempfile::tempdir().unwrap();
        let origin = endpoint("https://relay.example.com").unwrap();
        let identity = json!({
            "instanceId": uuid::Uuid::new_v4().to_string(),
            "workspaceId": uuid::Uuid::new_v4().to_string(),
        });
        bind_workspace(root.path(), &origin, &identity).unwrap();
        bind_workspace(root.path(), &origin, &identity).unwrap();
        let saved = std::fs::read(root.path().join("relay-workspace.json")).unwrap();
        let other = json!({
            "instanceId": uuid::Uuid::new_v4().to_string(),
            "workspaceId": uuid::Uuid::new_v4().to_string(),
        });
        assert!(bind_workspace(root.path(), &origin, &other).is_err());
        assert!(bind_workspace(
            root.path(),
            &endpoint("https://another.example.com").unwrap(),
            &identity
        )
        .is_err());
        assert_eq!(
            std::fs::read(root.path().join("relay-workspace.json")).unwrap(),
            saved
        );
    }

    #[test]
    fn legacy_sync_binding_requires_the_exact_existing_relay_instance() {
        let root = tempfile::tempdir().unwrap();
        let origin = endpoint("https://relay.example.com").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            root.path().join("sync-state.json"),
            serde_json::to_vec(&json!({
                "url": "https://relay.example.com", "instanceId": id, "base": {}
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(bind_workspace(
            root.path(),
            &origin,
            &json!({"instanceId": uuid::Uuid::new_v4().to_string(), "workspaceId": "owner"})
        )
        .is_err());
        assert!(!root.path().join("relay-workspace.json").exists());
        bind_workspace(
            root.path(),
            &origin,
            &json!({"instanceId": id, "workspaceId": "owner"}),
        )
        .unwrap();
        std::fs::write(root.path().join("relay-workspace.json"), "broken").unwrap();
        assert!(bind_workspace(
            root.path(),
            &origin,
            &json!({"instanceId": id, "workspaceId": "owner"})
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("relay-workspace.json")).unwrap(),
            "broken"
        );
    }

    #[test]
    fn relay_origins_require_remote_tls_and_no_embedded_secrets() {
        assert!(endpoint("http://127.0.0.1:4317").is_ok());
        assert!(endpoint("https://relay.example.com").is_ok());
        for url in [
            "http://192.168.1.2:4317",
            "https://user:secret@example.com",
            "https://example.com/?token=x",
            "file:///tmp",
            "https://example.com/path",
        ] {
            assert!(endpoint(url).is_err());
        }
    }
}
