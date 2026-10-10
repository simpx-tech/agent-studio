//! A Windows account's Codex login, lent to the same account's separate Codex profiles in the
//! WSL distributions this computer manages through Codex's own host-managed login: a WSL
//! app-server signs in with the Windows login's access token (`account/login/start` with
//! `chatgptAuthTokens`) and asks for a fresh one when a request is refused
//! (`account/chatgptAuthTokens/refresh`). The Windows Codex supplies the token and renews it,
//! so it stays the only renewer, and nothing is written in WSL.
//!
//! Claude profiles in WSL sign in through Claude Code's own login instead: no Claude
//! credential is read, copied or renewed by Agent Studio.
use crate::profiles::{self, Profile};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

/// A cached login is renewed when its access token has less than five minutes left.
const RENEW_WINDOW_MS: i64 = 5 * 60 * 1000;
const MAX_TOKEN: usize = 32 * 1024;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// One read or renewal of a lender's login at a time.
fn lock_for(lender: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(lender.into())
        .or_default()
        .clone()
}

/// The ChatGPT login a WSL Codex app-server borrows, as `account/login/start` parameters, and
/// when its access token expires. Only a ChatGPT login is lent; its account comes from the
/// token's own claims.
pub(crate) fn codex_params(status: &Value) -> Option<(Value, i64)> {
    if status["authMethod"] != "chatgpt" {
        return None;
    }
    let token = status["authToken"]
        .as_str()
        .filter(|t| !t.is_empty() && t.len() <= MAX_TOKEN && !t.chars().any(char::is_control))?;
    let payload = token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload.trim_end_matches('='))
            .ok()?,
    )
    .ok()?;
    let auth = &claims["https://api.openai.com/auth"];
    let account = auth["chatgpt_account_id"]
        .as_str()
        .filter(|s| !s.is_empty())?;
    let plan = auth["chatgpt_plan_type"].as_str();
    let expires_at = claims["exp"].as_i64()?.checked_mul(1000)?;
    Some((
        json!({
            "type": "chatgptAuthTokens",
            "accessToken": token,
            "chatgptAccountId": account,
            "chatgptPlanType": plan,
        }),
        expires_at,
    ))
}

fn codex_cache() -> std::sync::MutexGuard<'static, HashMap<String, (Value, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Value, i64)>>> = OnceLock::new();
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The Windows account's ChatGPT login for a WSL Codex app-server to sign in with, read from
/// the Windows Codex. `renew` has it renew the login first, as after a refused request; a
/// login about to expire is renewed anyway.
pub async fn codex_login(lender: &Profile, renew: bool) -> Result<Value, String> {
    let fresh = |cache: &HashMap<String, (Value, i64)>| {
        cache
            .get(&lender.id)
            .filter(|(_, expires_at)| *expires_at > now() + RENEW_WINDOW_MS)
            .map(|(login, _)| login.clone())
    };
    if !renew {
        if let Some(login) = fresh(&codex_cache()) {
            return Ok(login);
        }
    }
    let lock = lock_for(&lender.id);
    let _reading = lock.lock().await;
    if !renew {
        if let Some(login) = fresh(&codex_cache()) {
            return Ok(login);
        }
    }
    let mut renew = renew;
    loop {
        let status = profiles::scope(
            lender.clone(),
            crate::cli_queries::codex(
                "getAuthStatus",
                json!({ "includeToken": true, "refreshToken": renew }),
                tokio_util::sync::CancellationToken::new(),
            ),
        )
        .await
        .map_err(|_| "This account's Windows Codex login could not be read. Sign in on Windows.")?;
        let (login, expires_at) = codex_params(&status).ok_or(
            "This account's Windows Codex login is not a ChatGPT login. Sign in on Windows.",
        )?;
        if !renew && expires_at <= now() + RENEW_WINDOW_MS {
            renew = true;
            continue;
        }
        codex_cache().insert(lender.id.clone(), (login.clone(), expires_at));
        return Ok(login);
    }
}

/// The Windows login a WSL Codex app-server of the current profile borrows, if it borrows one.
pub fn codex_lender() -> Option<Profile> {
    let profile = profiles::current();
    (profile.provider == "codex")
        .then_some(profile.lender)
        .flatten()
        .map(|lender| *lender)
}

/// Answers a WSL Codex app-server's `account/chatgptAuthTokens/refresh` with the Windows
/// login, renewed first.
pub async fn codex_refresh(lender: &Profile, request: &Value) -> Value {
    match codex_login(lender, true).await {
        Ok(login) => json!({ "id": request["id"], "result": {
            "accessToken": login["accessToken"],
            "chatgptAccountId": login["chatgptAccountId"],
            "chatgptPlanType": login["chatgptPlanType"],
        }}),
        Err(error) => json!({ "id": request["id"], "error": { "code": -32000, "message": error } }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_codex_chatgpt_login_is_lent_with_the_account_its_token_names() {
        let claims = json!({
            "exp": 2_000_000_000_i64,
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct", "chatgpt_plan_type": "pro" }
        });
        let token = format!(
            "header.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&claims).unwrap())
        );
        let (login, expires_at) =
            codex_params(&json!({ "authMethod": "chatgpt", "authToken": token })).unwrap();
        assert_eq!(
            login,
            json!({ "type": "chatgptAuthTokens", "accessToken": token,
                    "chatgptAccountId": "acct", "chatgptPlanType": "pro" })
        );
        assert_eq!(expires_at, 2_000_000_000_000);
        // API keys, missing tokens and tokens without an account are never lent.
        assert!(codex_params(&json!({ "authMethod": "apikey", "authToken": token })).is_none());
        assert!(codex_params(&json!({ "authMethod": "chatgpt", "authToken": null })).is_none());
        assert!(
            codex_params(&json!({ "authMethod": "chatgpt", "authToken": "a.e30.b" })).is_none()
        );
    }
}
