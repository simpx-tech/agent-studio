//! A Windows account's Claude login, lent to the same account's separate profiles in the WSL
//! distributions this computer manages, as the Claude app lends its login to the CLI it runs
//! there. Only the access token crosses: each borrowing profile's `.credentials.json` holds the
//! Windows login's current access token, expiry, scopes and plan, never its refresh token or
//! MCP sign-ins, so the Windows CLI stays the one that renews the login. Shortly before the
//! token expires, Agent Studio has that CLI renew it and copies the new token to every profile
//! it lent the login to. Claude Code rereads its credentials when the file changes, so a CLI
//! running in WSL picks the new token up without restarting.
use crate::profiles::{self, Profile};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::Manager;

/// Claude Code renews a login only in the last five minutes before it expires.
const RENEW_WINDOW_MS: i64 = 5 * 60 * 1000;
/// When the watch has the Windows CLI renew: inside that window, before the token runs out.
const RENEW_LEAD_MS: i64 = 4 * 60 * 1000;
/// How long a renewal that left the login expiring waits before it tries again.
const RETRY: Duration = Duration::from_secs(5 * 60);
/// The longest a watch sleeps, so a login the Windows CLI renewed by itself still reaches WSL.
const RECHECK: Duration = Duration::from_secs(30 * 60);
const MAX_CREDENTIALS: u64 = 64 * 1024;
const MAX_TOKEN: usize = 8192;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// The part of a login that is lent. Never printed: it holds an access token.
#[derive(Clone, PartialEq)]
pub(crate) struct Lent {
    file: Vec<u8>,
    expires_at: i64,
}
impl std::fmt::Debug for Lent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Lent {{ expires_at: {} }}", self.expires_at)
    }
}
impl Lent {
    fn digest(&self) -> [u8; 32] {
        Sha256::digest(&self.file).into()
    }
    fn renewable(&self, now: i64) -> bool {
        now + RENEW_WINDOW_MS >= self.expires_at
    }
}

/// The access token, expiry, scopes and plan of a Claude login, as a credentials file of its
/// own. The refresh token and MCP sign-ins stay behind.
pub(crate) fn lent(bytes: &[u8]) -> Option<Lent> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let oauth = &value["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN && !t.chars().any(char::is_control))?;
    let expires_at = oauth["expiresAt"].as_i64()?;
    let scopes: Vec<&str> = oauth["scopes"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| s.len() <= 100)
        .take(32)
        .collect();
    let mut login = json!({ "accessToken": token, "expiresAt": expires_at, "scopes": scopes });
    for key in ["subscriptionType", "rateLimitTier"] {
        if let Some(text) = oauth[key].as_str().filter(|s| s.len() <= 100) {
            login[key] = text.into();
        }
    }
    Some(Lent {
        file: serde_json::to_vec(&json!({ "claudeAiOauth": login })).ok()?,
        expires_at,
    })
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// The directory where the lender's CLI keeps its login: its separate profile, or the
/// computer's own CLI directory for a terminal login.
fn claude_dir(lender: &Profile) -> Option<PathBuf> {
    lender
        .root
        .clone()
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".claude"))
        })
}

async fn read(lender: &Profile) -> Option<Lent> {
    let path = claude_dir(lender)?.join(".credentials.json");
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_CREDENTIALS {
            return None;
        }
        lent(&std::fs::read(&path).ok()?)
    })
    .await
    .ok()
    .flatten()
}

/// A borrowing profile in one distribution.
#[derive(Clone, Hash, PartialEq, Eq)]
struct Target {
    distribution: String,
    namespace: String,
    profile: String,
}

#[derive(Default)]
struct State {
    /// What each borrowing profile last received, by a digest of its file.
    written: HashMap<Target, [u8; 32]>,
    /// The profiles each lender's login was lent to, which receive its renewals together.
    targets: HashMap<String, HashSet<Target>>,
    watched: HashSet<String>,
    /// One renewal or delivery at a time per lender.
    locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}
fn state() -> std::sync::MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
fn lock_for(lender: &str) -> Arc<tokio::sync::Mutex<()>> {
    state().locks.entry(lender.into()).or_default().clone()
}

/// Has the lender's CLI renew its login. Claude Code does so only in the login's last minutes,
/// when a query needs the account; reading its usage is the lightest such query.
async fn renew(lender: &Profile) -> Result<(), String> {
    let app = APP.get().ok_or("Agent Studio is still starting")?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("usage-runtime");
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare login renewal")?;
    profiles::scope(
        lender.clone(),
        crate::cli_queries::claude_usage(
            "",
            &directory,
            tokio_util::sync::CancellationToken::new(),
        ),
    )
    .await
    .map(|_| ())
}

/// The login to lend, renewed first when it is about to expire.
async fn current(lender: &Profile) -> Option<Lent> {
    let lent = read(lender).await?;
    if !lent.renewable(now()) {
        return Some(lent);
    }
    let lock = lock_for(&lender.id);
    let _renewing = lock.lock().await;
    // A renewal that finished while this one waited already left the new login there.
    let lent = read(lender).await?;
    if !lent.renewable(now()) {
        return Some(lent);
    }
    let _ = renew(lender).await;
    read(lender).await
}

async fn deliver(target: &Target, lent: &Lent) -> Result<(), String> {
    let digest = lent.digest();
    if state().written.get(target) == Some(&digest) {
        return Ok(());
    }
    write(target, &lent.file).await?;
    state().written.insert(target.clone(), digest);
    Ok(())
}

#[cfg(windows)]
async fn write(target: &Target, file: &[u8]) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let script = crate::wsl::embedded_script(include_str!("wsl-lend.sh"));
    let mut command = tokio::process::Command::new("wsl.exe");
    command
        .args([
            "--distribution",
            &target.distribution,
            "--cd",
            "~",
            "--exec",
            "bash",
            "-c",
            &script,
            "agent-studio",
            &target.namespace,
            &target.profile,
        ])
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Could not lend this account's Windows login to WSL")?;
    let mut input = child.stdin.take().ok_or("Missing WSL input")?;
    let written = input.write_all(file).await;
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .map_err(|_| "Lending the Windows login to WSL timed out")?
        .map_err(|_| "Could not lend this account's Windows login to WSL")?;
    if written.is_err() || !status.success() {
        return Err("Could not lend this account's Windows login to WSL".into());
    }
    Ok(())
}
#[cfg(not(windows))]
async fn write(_target: &Target, _file: &[u8]) -> Result<(), String> {
    Err("Lending a login to WSL is available from Windows.".into())
}

/// Before a CLI starts in a WSL profile that borrows a Windows login, gives the profile that
/// login's current access token, renewed first when it is about to expire, and keeps it fresh
/// from then on. A login that cannot be read or written leaves the profile as it was; the CLI
/// then reports the account signed out.
pub async fn sync(profile: &Profile, distribution: &str, namespace: &str) {
    let Some(lender) = profile.lender.as_deref() else {
        return;
    };
    let target = Target {
        distribution: distribution.into(),
        namespace: namespace.into(),
        profile: profile.id.clone(),
    };
    if uuid::Uuid::parse_str(&target.profile).is_err() {
        return;
    }
    state()
        .targets
        .entry(lender.id.clone())
        .or_default()
        .insert(target.clone());
    if let Some(lent) = current(lender).await {
        let _ = deliver(&target, &lent).await;
    }
    watch(lender.clone());
}

/// Keeps a lent login fresh while the app runs: shortly before it expires, has the Windows CLI
/// renew it and copies the new token to every profile it was lent to.
fn watch(lender: Profile) {
    if !state().watched.insert(lender.id.clone()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut wait = next_wait(read(&lender).await.as_ref(), now());
        loop {
            tokio::time::sleep(wait).await;
            let lent = current(&lender).await;
            if let Some(lent) = &lent {
                let targets: Vec<Target> = state()
                    .targets
                    .get(&lender.id)
                    .map(|set| set.iter().cloned().collect())
                    .unwrap_or_default();
                for target in targets {
                    let _ = deliver(&target, lent).await;
                }
            }
            wait = next_wait(lent.as_ref(), now());
        }
    });
}

/// How long a watch sleeps: until shortly before the login expires, at most `RECHECK`, and
/// `RETRY` while it cannot be read or renewed.
fn next_wait(lent: Option<&Lent>, now: i64) -> Duration {
    match lent {
        Some(lent) if !lent.renewable(now) => Duration::from_millis(
            (lent.expires_at - RENEW_LEAD_MS - now).clamp(30_000, RECHECK.as_millis() as i64)
                as u64,
        ),
        _ => RETRY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_access_token_expiry_scopes_and_plan_are_lent() {
        let source = json!({
            "claudeAiOauth": {
                "accessToken": "access", "refreshToken": "refresh", "expiresAt": 1_000_000,
                "refreshTokenExpiresAt": 9_000_000, "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"
            },
            "mcpOAuth": { "server": { "accessToken": "mcp" } }
        });
        let lent = lent(&serde_json::to_vec(&source).unwrap()).unwrap();
        let file: Value = serde_json::from_slice(&lent.file).unwrap();
        assert_eq!(
            file,
            json!({ "claudeAiOauth": {
                "accessToken": "access", "expiresAt": 1_000_000,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"
            }})
        );
        let text = String::from_utf8(lent.file.clone()).unwrap();
        assert!(!text.contains("refresh") && !text.contains("mcp"));
        assert!(!format!("{lent:?}").contains("access"));
        // A missing, empty or malformed login lends nothing.
        for broken in [
            json!({}),
            json!({ "claudeAiOauth": { "accessToken": "", "expiresAt": 1, "scopes": [] } }),
            json!({ "claudeAiOauth": { "accessToken": "a", "scopes": [] } }),
            json!({ "claudeAiOauth": { "accessToken": "a\nb", "expiresAt": 1, "scopes": [] } }),
        ] {
            assert!(super::lent(&serde_json::to_vec(&broken).unwrap()).is_none());
        }
        assert!(super::lent(b"not json").is_none());
    }
    /// Writes a lent login into a throwaway profile of the first WSL distribution with Claude
    /// Code, then has that CLI report its login. Set `AGENT_STUDIO_LEND_PROBE_PROFILE` to a
    /// Windows Claude profile directory that is signed in; no prompt is sent.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in: lends a real Windows login to a throwaway WSL profile"]
    async fn a_wsl_profile_reports_the_lent_login_as_signed_in() {
        let source = std::env::var("AGENT_STUDIO_LEND_PROBE_PROFILE").expect("profile directory");
        let lent = lent(&std::fs::read(PathBuf::from(source).join(".credentials.json")).unwrap())
            .expect("a signed-in Windows login");
        let distribution = String::from_utf8(
            std::process::Command::new("wsl.exe")
                .args(["--list", "--quiet"])
                .output()
                .unwrap()
                .stdout
                .chunks(2)
                .map(|c| c[0])
                .collect(),
        )
        .unwrap()
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .find(|l| !l.is_empty())
        .expect("a WSL distribution");
        let namespace = format!(
            "agent-studio-lend-test-{}",
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let target = Target {
            distribution: distribution.clone(),
            namespace: namespace.clone(),
            profile: uuid::Uuid::new_v4().to_string(),
        };
        write(&target, &lent.file).await.unwrap();
        let dir = format!(
            "$HOME/.local/share/{namespace}/profiles/claude/{}",
            target.profile
        );
        let probe = format!(
            "export PATH=\"$HOME/.local/bin:$PATH\"; stat -c %a \"{dir}/.credentials.json\"; \
             CLAUDE_CONFIG_DIR=\"{dir}\" claude auth status; rm -rf -- \"$HOME/.local/share/{namespace}\""
        );
        let output = std::process::Command::new("wsl.exe")
            .args(["-d", &distribution, "--exec", "bash", "-lc", &probe])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        let (mode, status) = text.split_once('\n').unwrap();
        assert_eq!(mode.trim(), "600");
        let status: Value = serde_json::from_str(status.trim()).unwrap();
        assert_eq!(status["loggedIn"], true);
        assert_eq!(status["authMethod"], "claude.ai");
    }
    #[test]
    fn renewal_waits_for_the_window_in_which_the_cli_renews() {
        let lent = |expires_at| Lent {
            file: vec![],
            expires_at,
        };
        let now = 10_000_000;
        // Hours left: recheck within half an hour, in case Windows renewed it by itself.
        assert_eq!(next_wait(Some(&lent(now + 8 * 3_600_000)), now), RECHECK);
        // Twenty minutes left: wake four minutes before it expires, inside the CLI's window.
        assert_eq!(
            next_wait(Some(&lent(now + 20 * 60_000)), now),
            Duration::from_millis((20 * 60_000 - RENEW_LEAD_MS) as u64)
        );
        assert!(!lent(now + 6 * 60_000).renewable(now));
        assert!(lent(now + 5 * 60_000).renewable(now));
        // Expiring or unreadable: try again in a few minutes, never in a tight loop.
        assert_eq!(next_wait(Some(&lent(now + 60_000)), now), RETRY);
        assert_eq!(next_wait(None, now), RETRY);
    }
}
