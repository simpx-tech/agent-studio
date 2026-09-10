use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
mod credentials;

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
) -> Result<(), String> {
    let _change = state.change.lock().await;
    let (client, url) = validate(&url, &token, &environment).await?;
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
    let (client, url) = validate(&pairing.url, &pairing.token, &environment).await?;
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

async fn validate(
    url: &str,
    token: &str,
    environment: &str,
) -> Result<(reqwest::Client, reqwest::Url), String> {
    let url = endpoint(url)?;
    if token.len() < 32 || token.chars().any(char::is_control) {
        return Err("Enter the relay pairing key (at least 32 characters)".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot initialize relay client")?;
    let response = client
        .get(url.join("v1/state").map_err(|_| "Invalid relay URL")?)
        .bearer_auth(token)
        .header("x-environment-id", environment)
        .send()
        .await
        .map_err(|_| "Cannot connect to the relay. Check its URL, TLS, and network connection.")?;
    if !response.status().is_success() {
        return Err(
            "Relay rejected the connection. Check the pairing key and server version.".into(),
        );
    }
    Ok((client, url))
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
    let (client, url, token, environment) = state
        .connection
        .lock()
        .map_err(|_| "Relay state failed")?
        .clone()
        .ok_or("Connect to the relay first")?;
    let mut request = client
        .request(
            method.parse().map_err(|_| "Invalid method")?,
            url.join(path).map_err(|_| "Invalid relay path")?,
        )
        .bearer_auth(token)
        .header("x-environment-id", environment);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "Relay connection lost. Local changes remain on this device.")?;
    let status = response.status().as_u16();
    let mut bytes = vec![];
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Relay response interrupted")?
    {
        if bytes.len() + chunk.len() > 21_000_000 {
            return Err("Relay response exceeds the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Relay returned an invalid response")?;
    Ok(json!({"status": status, "body": value}))
}
#[cfg(test)]
mod tests {
    use super::*;
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
