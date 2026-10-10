//! Server mode (requested 2026-10-10): an always-on computer, such as the VPS that hosts the
//! relay, runs this app as a service with no one at its window, so the other devices of its
//! workspace can start chats there. The service turns it on with `AGENT_STUDIO_SERVER=1`, names
//! the relay in `AGENT_STUDIO_RELAY_URL` and hands over the pairing key as a file, systemd's
//! `LoadCredential=relay-key:…` (or `AGENT_STUDIO_RELAY_KEY_FILE`), so the app pairs by itself at
//! every start. `AGENT_STUDIO_COMPUTER_NAME` names the computer the first time it starts. The
//! settings are read once, before any thread or process starts, and removed from this process's
//! environment, so no CLI or command an agent runs inherits them. See docs/DEPLOYMENT.md.
use std::{path::PathBuf, sync::OnceLock};

const ENABLE: &str = "AGENT_STUDIO_SERVER";
const RELAY: &str = "AGENT_STUDIO_RELAY_URL";
const KEY_FILE: &str = "AGENT_STUDIO_RELAY_KEY_FILE";
const CREDENTIALS: &str = "CREDENTIALS_DIRECTORY";
const NAME: &str = "AGENT_STUDIO_COMPUTER_NAME";
/// The credential the service passes the pairing key as.
const CREDENTIAL: &str = "relay-key";
/// Asks a release whether it runs in server mode: the VPS updater runs it before deploying one.
pub const CHECK: &str = "--server-check";
/// What a release that runs in server mode answers to `--server-check`.
pub const CHECKED: &str = "agent-studio-server 1";

#[derive(Debug, Clone, PartialEq, Eq)]
struct Server {
    relay: Option<String>,
    key_file: Option<PathBuf>,
    name: Option<String>,
}

static SERVER: OnceLock<Option<Server>> = OnceLock::new();

/// Reads the service's settings, once, and takes them out of the environment. Call it first, while
/// this process has no other thread.
pub fn init() {
    SERVER.get_or_init(|| {
        let server = settings(|name| std::env::var(name).ok());
        if server.is_some() {
            for name in [ENABLE, RELAY, KEY_FILE, CREDENTIALS, NAME] {
                std::env::remove_var(name);
            }
        }
        server
    });
}

fn settings(get: impl Fn(&str) -> Option<String>) -> Option<Server> {
    if get(ENABLE).as_deref().map(str::trim) != Some("1") {
        return None;
    }
    let value = |name: &str| {
        get(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    Some(Server {
        relay: value(RELAY),
        key_file: value(KEY_FILE)
            .map(PathBuf::from)
            .or_else(|| value(CREDENTIALS).map(|folder| PathBuf::from(folder).join(CREDENTIAL))),
        name: value(NAME),
    })
}

fn server() -> Option<&'static Server> {
    SERVER.get().and_then(Option::as_ref)
}

/// Whether this app runs as a server.
pub fn active() -> bool {
    server().is_some()
}

/// The name the service gives this computer, used when it starts for the first time.
pub fn computer_name() -> Option<String> {
    server().and_then(|server| server.name.clone())
}

/// The relay and pairing key the service configured, or None outside server mode. The key is read
/// from its file at each connection, so a key replaced there is used from the next one on.
pub fn pairing() -> Option<Result<(String, String), String>> {
    server().map(read_pairing)
}

fn read_pairing(server: &Server) -> Result<(String, String), String> {
    let relay = server
        .relay
        .clone()
        .ok_or("This server's service names no relay (AGENT_STUDIO_RELAY_URL).")?;
    let file = server
        .key_file
        .as_ref()
        .ok_or("This server's service gives no relay pairing key (LoadCredential=relay-key).")?;
    let key = std::fs::read_to_string(file)
        .map_err(|_| "Cannot read this server's relay pairing key.")?;
    Ok((relay, key.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(values: &[(&str, &str)]) -> Option<Server> {
        let values: HashMap<String, String> = values
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        settings(|name| values.get(name).cloned())
    }

    #[test]
    fn server_mode_needs_its_switch() {
        assert_eq!(from(&[(RELAY, "http://127.0.0.1:4317")]), None);
        assert_eq!(
            from(&[(ENABLE, "0"), (RELAY, "http://127.0.0.1:4317")]),
            None
        );
        let server = from(&[
            (ENABLE, "1"),
            (RELAY, " http://127.0.0.1:4317 "),
            (CREDENTIALS, "/run/credentials/agent-studio-host.service"),
            (NAME, "VPS"),
        ])
        .unwrap();
        assert_eq!(server.relay.as_deref(), Some("http://127.0.0.1:4317"));
        assert_eq!(
            server.key_file,
            Some(PathBuf::from("/run/credentials/agent-studio-host.service").join(CREDENTIAL))
        );
        assert_eq!(server.name.as_deref(), Some("VPS"));
    }

    #[test]
    fn a_named_key_file_wins_over_the_service_credential() {
        let server = from(&[
            (ENABLE, "1"),
            (KEY_FILE, "/etc/agent-studio/host.key"),
            (CREDENTIALS, "/run/credentials/x"),
        ])
        .unwrap();
        assert_eq!(
            server.key_file,
            Some(PathBuf::from("/etc/agent-studio/host.key"))
        );
    }

    #[test]
    fn reads_the_key_at_each_connection_and_says_what_is_missing() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join(CREDENTIAL);
        let mut server = Server {
            relay: Some("http://127.0.0.1:4317".into()),
            key_file: Some(file.clone()),
            name: None,
        };
        assert!(read_pairing(&server).is_err());
        std::fs::write(&file, "first-key-0123456789abcdef0123456789\n").unwrap();
        assert_eq!(
            read_pairing(&server).unwrap(),
            (
                "http://127.0.0.1:4317".to_string(),
                "first-key-0123456789abcdef0123456789".to_string()
            )
        );
        std::fs::write(&file, "second-key-0123456789abcdef012345678").unwrap();
        assert_eq!(
            read_pairing(&server).unwrap().1,
            "second-key-0123456789abcdef012345678"
        );
        server.relay = None;
        assert!(read_pairing(&server)
            .unwrap_err()
            .contains("names no relay"));
    }
}
