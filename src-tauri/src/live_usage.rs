//! Transient, exact-profile account notifications. Never part of a conversation/checkpoint.
use crate::usage::{CreditUsage, LimitWindow, UsageSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitStatus {
    pub status: String,
    pub limit_type: Option<String>,
    pub resets_at: Option<u64>,
    pub using_overage: Option<bool>,
    pub checked_at: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub connection_id: String,
    pub epoch: String,
    pub revision: u64,
    pub account_changed: u64,
    pub auth_mode: Option<String>,
    pub plan_type: Option<String>,
    pub limit_status: Option<LimitStatus>,
    pub credits_checked_at: Option<u64>,
    pub snapshot: UsageSnapshot,
}
pub struct LiveUsage {
    epoch: String,
    updates: Mutex<HashMap<String, Update>>,
    attempts: tokio::sync::Mutex<HashMap<(String, String), Option<String>>>,
    slots: tokio::sync::Semaphore,
}
impl Default for LiveUsage {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            updates: Mutex::new(HashMap::new()),
            attempts: Default::default(),
            slots: tokio::sync::Semaphore::new(3),
        }
    }
}
fn identifier(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    (!s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)))
    .then(|| s.into())
}
fn merge_credits(previous: &mut Option<CreditUsage>, next: Option<CreditUsage>) {
    match (previous.as_mut(), next) {
        (
            Some(CreditUsage::Codex {
                balance,
                has_credits,
                unlimited,
                reset_credits,
            }),
            Some(CreditUsage::Codex {
                balance: b,
                has_credits: h,
                unlimited: u,
                reset_credits: r,
            }),
        ) => {
            if b.is_some() {
                *balance = b;
            }
            if h.is_some() {
                *has_credits = h;
            }
            if u.is_some() {
                *unlimited = u;
            }
            if r.is_some() {
                *reset_credits = r;
            }
        }
        (_, Some(next)) => *previous = Some(next),
        _ => {}
    }
}
fn merge_window(windows: &mut Vec<LimitWindow>, mut next: LimitWindow, at: u64) {
    next.checked_at = Some(at);
    if let Some(old) = windows.iter_mut().find(|w| w.id == next.id) {
        if next.used_percent.is_none() {
            next.used_percent = old.used_percent;
            next.checked_at = old.checked_at;
        }
        if next.resets_at.is_null() {
            next.resets_at = old.resets_at.clone();
        }
        if next.window_minutes.is_none() {
            next.window_minutes = old.window_minutes;
            next.label = old.label.clone();
        }
        if next.model.is_none() {
            next.model = old.model.clone();
        }
        *old = next;
    } else if windows.len() < 32 {
        windows.push(next);
    }
}
impl LiveUsage {
    pub fn revision(&self, connection: &str) -> u64 {
        self.updates
            .lock()
            .ok()
            .and_then(|m| m.get(connection).map(|u| u.revision))
            .unwrap_or(0)
    }
    pub fn snapshots(&self) -> Vec<Update> {
        self.updates
            .lock()
            .map(|m| {
                m.values()
                    .filter(|u| crate::usage::now().saturating_sub(u.snapshot.checked_at) < 180)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
    fn update(&self, connection: &str, provider: &str, value: &Value, at: u64) -> Option<Update> {
        if uuid::Uuid::parse_str(connection).is_err() {
            return None;
        }
        let account = provider == "codex"
            && value["method"] == "account/updated"
            && value.get("id").is_none();
        let codex = provider == "codex"
            && value["method"] == "account/rateLimits/updated"
            && value.get("id").is_none();
        let claude = provider == "claude"
            && value["type"] == "rate_limit_event"
            && value["parent_tool_use_id"].is_null();
        if !account && !codex && !claude {
            return None;
        }
        let mut updates = self.updates.lock().ok()?;
        if !updates.contains_key(connection) && updates.len() >= 100 {
            return None;
        }
        let update = updates.entry(connection.into()).or_insert_with(|| Update {
            connection_id: connection.into(),
            epoch: self.epoch.clone(),
            revision: 0,
            account_changed: 0,
            auth_mode: None,
            plan_type: None,
            limit_status: None,
            credits_checked_at: None,
            snapshot: UsageSnapshot {
                provider: provider.into(),
                checked_at: at,
                windows: vec![],
                context: None,
                credits: None,
                detail:
                    "Reported live by the selected account. Limits are shared with other sessions."
                        .into(),
            },
        });
        if update.snapshot.provider != provider {
            return None;
        }
        if account {
            let params = value.get("params")?.as_object()?;
            let auth = params.get("authMode")?;
            if !auth.is_null() && identifier(auth).is_none() {
                return None;
            }
            update.auth_mode = identifier(auth);
            update.plan_type = identifier(&value["params"]["planType"]);
            update.snapshot.windows.clear();
            update.snapshot.credits = None;
            update.credits_checked_at = None;
            update.limit_status = None;
            update.account_changed = update.revision + 1;
        } else if codex {
            let bucket = &value["params"]["rateLimits"];
            if !bucket.is_object() {
                return None;
            }
            let key = if bucket["limitId"].is_null() {
                "codex".into()
            } else {
                identifier(&bucket["limitId"])?
            };
            let data = json!({"rateLimitsByLimitId":{key:bucket}});
            for window in crate::usage::parse_codex(&data) {
                merge_window(&mut update.snapshot.windows, window, at);
            }
            let credits = crate::usage::codex_credits(&data);
            if credits.is_some() {
                update.credits_checked_at = Some(at);
            }
            merge_credits(&mut update.snapshot.credits, credits);
            if let Some(plan) = identifier(&bucket["planType"]) {
                update.plan_type = Some(plan);
            }
        } else {
            let info = &value["rate_limit_info"];
            let status = info["status"]
                .as_str()
                .filter(|s| ["allowed", "allowed_warning", "rejected"].contains(s))?;
            let kind = identifier(&info["rateLimitType"]);
            update.limit_status = Some(LimitStatus {
                status: status.into(),
                limit_type: kind.clone(),
                resets_at: info["resetsAt"].as_u64(),
                using_overage: info["isUsingOverage"]
                    .as_bool()
                    .or(info["overageInUse"].as_bool()),
                checked_at: at,
            });
            // Claude stream utilization is a fraction, whereas get_usage reports percentages.
            // Only the documented general buckets map to the account's existing quota rows.
            if let Some(kind) = kind.filter(|k| ["five_hour", "seven_day"].contains(&k.as_str())) {
                let utilization = info["utilization"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.);
                if let Some(used) = utilization {
                    let data = json!({"rate_limits":{kind:{"utilization": (used * 100.).min(100.), "resets_at":info["resetsAt"]}}});
                    for window in crate::usage::parse_claude(&data) {
                        merge_window(&mut update.snapshot.windows, window, at);
                    }
                }
            }
        }
        update.revision += 1;
        update.snapshot.checked_at = at;
        Some(update.clone())
    }
}

pub fn observer(app: &tauri::AppHandle, provider: &str) -> Option<crate::pool::OutputObserver> {
    let profile = crate::profiles::current();
    if profile.id.is_empty() || !["claude", "codex"].contains(&provider) {
        return None;
    }
    let app = app.clone();
    let provider = provider.to_owned();
    Some(std::sync::Arc::new(move |line| {
        if line.len() > 64_000
            || !(line.contains("rate_limit_event")
                || line.contains("account/rateLimits/updated")
                || line.contains("account/updated"))
        {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(state) = app.try_state::<LiveUsage>() else {
            return;
        };
        if let Some(update) = state.update(&profile.id, &provider, &value, crate::usage::now()) {
            app.state::<crate::usage::UsageState>()
                .invalidate(&profile.id);
            let _ = app.emit("studio-account-update", update);
        }
    }))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    WorkspaceMessages,
    ConsumeResetCredit {
        #[serde(rename = "idempotencyKey")]
        idempotency_key: String,
        confirmed: bool,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessage {
    message_id: String,
    message_body: String,
}
pub fn workspace_messages(value: &Value) -> Value {
    let enabled = value["featureEnabled"].as_bool().unwrap_or(false);
    let mut seen = std::collections::HashSet::new();
    let messages: Vec<_> = value["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| enabled && m["archivedAt"].is_null())
        .take(12)
        .filter_map(|m| {
            let id = m["messageId"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 200)?;
            let body = m["messageBody"].as_str().filter(|s| !s.is_empty())?;
            if !seen.insert(id) {
                return None;
            }
            Some(WorkspaceMessage {
                message_id: id.into(),
                message_body: body
                    .chars()
                    .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                    .take(2000)
                    .collect(),
            })
        })
        .collect();
    json!({"featureEnabled":enabled,"messages":messages})
}
pub fn reset_eligible(value: &Value) -> bool {
    value["rateLimitResetCredits"]["availableCount"]
        .as_u64()
        .is_some_and(|n| n > 0)
        && crate::usage::parse_codex(value).iter().any(|w| {
            w.bucket == "codex"
                && matches!(w.window_minutes, Some(300 | 10080))
                && w.used_percent.is_some_and(|p| p >= 90.)
        })
}
pub async fn manage(app: &tauri::AppHandle, action: Action) -> Result<Value, String> {
    let connection = crate::profiles::current().id;
    if connection.is_empty() {
        return Err("Select a Codex account first.".into());
    }
    let state = app.state::<LiveUsage>();
    let _slot = state
        .slots
        .acquire()
        .await
        .map_err(|_| "Account queries are unavailable.")?;
    match action {
        Action::WorkspaceMessages => crate::cli_queries::codex(
            "account/workspaceMessages/read",
            Value::Null,
            CancellationToken::new(),
        )
        .await
        .map(|v| workspace_messages(&v)),
        Action::ConsumeResetCredit {
            idempotency_key,
            confirmed,
        } => {
            if !confirmed || uuid::Uuid::parse_str(&idempotency_key).is_err() {
                return Err("Confirm one reset for the selected account.".into());
            }
            // Serialize redemptions and retain uncertain attempts. Retrying uses the same key
            // even if the first response was lost after the backend consumed the credit.
            let mut attempts = state.attempts.lock().await;
            let key = (connection.clone(), idempotency_key.clone());
            if let Some(Some(outcome)) = attempts.get(&key) {
                return Ok(json!({"outcome":outcome}));
            }
            let retry = attempts.contains_key(&key);
            if !retry {
                if attempts.len() >= 64 {
                    return Err("Reset attempt limit reached for this app session.".into());
                }
                attempts.insert(key.clone(), None);
            }
            let sent = std::sync::atomic::AtomicBool::new(retry);
            let result = match crate::cli_queries::codex_reset(&idempotency_key, retry, &sent).await
            {
                Ok(result) => result,
                Err(_) => {
                    if !sent.load(std::sync::atomic::Ordering::Relaxed) {
                        attempts.remove(&key);
                        return Err(
                            "No reset was sent. Account limits could not be verified. Try again."
                                .into(),
                        );
                    }
                    return Err("The reset outcome is unconfirmed. Retry this same attempt to check it safely.".into());
                }
            };
            let outcome = result["outcome"]
                .as_str()
                .filter(|s| ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].contains(s))
                .ok_or("The reset outcome is unconfirmed. Retry this same attempt.")?;
            attempts.insert(key, Some(outcome.into()));
            app.state::<crate::usage::UsageState>()
                .invalidate(&connection);
            Ok(json!({"outcome":outcome}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CONNECTION: &str = "11111111-1111-4111-8111-111111111111";
    #[test]
    fn sparse_codex_updates_keep_buckets_credits_and_timestamps() {
        let state = LiveUsage::default();
        let first = json!({"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":91,"windowDurationMins":10080,"resetsAt":9000},"credits":{"balance":"5.25","hasCredits":true,"unlimited":false},"planType":"pro","secret":"never expose"}}});
        let u = state.update(CONNECTION, "codex", &first, 100).unwrap();
        assert_eq!(u.snapshot.windows[0].used_percent, Some(91.));
        assert!(!serde_json::to_string(&u).unwrap().contains("never expose"));
        let second = json!({"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"spark","primary":{"usedPercent":2,"windowDurationMins":300},"credits":{"balance":"999"}}}});
        let u = state.update(CONNECTION, "codex", &second, 200).unwrap();
        assert_eq!(u.snapshot.windows.len(), 2);
        assert_eq!(u.snapshot.windows[0].checked_at, Some(100));
        assert_eq!(u.credits_checked_at, Some(100));
        assert!(matches!(
            u.snapshot.credits,
            Some(CreditUsage::Codex {
                balance: Some(5.25),
                ..
            })
        ));
        let empty = json!({"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":null,"secondary":null,"credits":null,"planType":null}}});
        let u = state.update(CONNECTION, "codex", &empty, 300).unwrap();
        assert_eq!(u.snapshot.windows.len(), 2);
        assert_eq!(u.plan_type.as_deref(), Some("pro"));
        assert!(state.update("invalid", "codex", &first, 400).is_none());
        assert!(state.update(CONNECTION, "claude", &first, 400).is_none());
    }
    #[test]
    fn account_changes_invalidate_prior_readings_and_claude_status_is_not_a_percentage() {
        let state = LiveUsage::default();
        let account = json!({"method":"account/updated","params":{"authMode":null,"planType":null,"email":"private"}});
        let u = state.update(CONNECTION, "codex", &account, 100).unwrap();
        assert_eq!(u.account_changed, 1);
        assert!(u.snapshot.windows.is_empty());
        assert!(!serde_json::to_string(&u).unwrap().contains("private"));
        let claude = uuid::Uuid::new_v4().to_string();
        let mut event = json!({"type":"rate_limit_event","session_id":"private","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","resetsAt":9999}});
        let u = state.update(&claude, "claude", &event, 100).unwrap();
        assert!(u.snapshot.windows.is_empty());
        assert_eq!(u.limit_status.unwrap().status, "rejected");
        event["rate_limit_info"]["utilization"] = json!(0.92);
        assert_eq!(
            state
                .update(&claude, "claude", &event, 200)
                .unwrap()
                .snapshot
                .windows[0]
                .used_percent,
            Some(92.)
        );
        event["parent_tool_use_id"] = json!("child");
        assert!(state.update(&claude, "claude", &event, 300).is_none());
    }
    #[test]
    fn redemption_requires_confirmation_and_core_eligibility_and_messages_are_bounded() {
        assert!(serde_json::from_value::<Action>(json!({"action":"consumeResetCredit","confirmed":true,"idempotencyKey":"key","command":"no"})).is_err());
        let mut limits = json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":20,"windowDurationMins":10080}},"spark":{"primary":{"usedPercent":100,"windowDurationMins":300}}},"rateLimitResetCredits":{"availableCount":2}});
        assert!(!reset_eligible(&limits));
        limits["rateLimitsByLimitId"]["codex"]["primary"]["usedPercent"] = json!(90);
        assert!(reset_eligible(&limits));
        limits["rateLimitResetCredits"]["availableCount"] = json!(0);
        assert!(!reset_eligible(&limits));
        let output = workspace_messages(
            &json!({"featureEnabled":true,"messages":[{"messageId":"one","messageBody":"<script>inert</script>","secret":"private"},{"messageId":"old","messageBody":"hidden","archivedAt":1},{"messageId":"long","messageBody":"x".repeat(5000)}]}),
        );
        assert_eq!(output["messages"].as_array().unwrap().len(), 2);
        assert_eq!(
            output["messages"][1]["messageBody"].as_str().unwrap().len(),
            2000
        );
        assert!(!output.to_string().contains("private"));
        assert_eq!(
            workspace_messages(
                &json!({"featureEnabled":false,"messages":[{"messageId":"id","messageBody":"disabled"}]})
            )["messages"],
            json!([])
        );
    }
}
