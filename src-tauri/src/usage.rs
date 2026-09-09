use crate::cli_queries;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub id: String,
    pub label: String,
    pub used_percent: Option<f64>,
    pub resets_at: Value,
    pub window_minutes: Option<u64>,
    pub model: Option<String>,
    pub bucket: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCapacity {
    pub model: String,
    pub tokens: u64,
    pub source: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider: String,
    pub checked_at: u64,
    pub windows: Vec<LimitWindow>,
    pub context: Option<ContextCapacity>,
    pub detail: String,
}
pub struct UsageState {
    pub active: Mutex<HashMap<String, CancellationToken>>,
    cache: Mutex<HashMap<String, UsageSnapshot>>,
    slots: tokio::sync::Semaphore,
}
impl Default for UsageState {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            slots: tokio::sync::Semaphore::new(3),
        }
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn percent(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .map(|n| n.min(100.))
}
fn reset(v: &Value) -> Value {
    if v.is_string() || v.is_number() {
        v.clone()
    } else {
        Value::Null
    }
}
fn label(minutes: Option<u64>) -> String {
    match minutes {
        Some(300) => "5-hour".into(),
        Some(10080) => "Weekly".into(),
        Some(n) => format!("{n}-minute"),
        None => "Usage window".into(),
    }
}
pub fn parse_codex(v: &Value) -> Vec<LimitWindow> {
    let fallback = json!({"codex": v["rateLimits"]});
    let buckets = v
        .get("rateLimitsByLimitId")
        .filter(|v| v.as_object().is_some_and(|m| !m.is_empty()))
        .unwrap_or(&fallback);
    let mut windows = vec![];
    for (key, bucket) in buckets.as_object().into_iter().flatten() {
        for slot in ["primary", "secondary"] {
            let w = &bucket[slot];
            if !w.is_object() {
                continue;
            }
            let duration = w["windowDurationMins"].as_u64();
            windows.push(LimitWindow {
                id: format!("{key}-{slot}"),
                label: label(duration),
                used_percent: percent(&w["usedPercent"]),
                resets_at: reset(&w["resetsAt"]),
                window_minutes: duration,
                model: if key == "codex" {
                    None
                } else {
                    Some(
                        bucket["limitName"]
                            .as_str()
                            .unwrap_or(key)
                            .chars()
                            .take(100)
                            .collect(),
                    )
                },
                bucket: key.clone(),
            });
        }
    }
    windows
}
pub fn parse_claude(v: &Value) -> Vec<LimitWindow> {
    let limits = &v["rate_limits"];
    let mut windows = vec![];
    for (key, minutes) in [("five_hour", 300), ("seven_day", 10080)] {
        if !limits[key].is_object() {
            continue;
        }
        windows.push(LimitWindow {
            id: key.into(),
            label: label(Some(minutes)),
            used_percent: percent(&limits[key]["utilization"]),
            resets_at: reset(&limits[key]["resets_at"]),
            window_minutes: Some(minutes),
            model: None,
            bucket: "claude".into(),
        });
    }
    // Use the CLI's server-labelled model buckets, never internal/legacy bucket aliases.
    for w in limits["model_scoped"].as_array().into_iter().flatten() {
        let Some(name) = w["display_name"].as_str() else {
            continue;
        };
        if !name.eq_ignore_ascii_case("fable") {
            continue;
        }
        windows.push(LimitWindow {
            id: "fable-weekly".into(),
            label: "Fable weekly".into(),
            used_percent: percent(&w["utilization"]),
            resets_at: reset(&w["resets_at"]),
            window_minutes: Some(10080),
            model: Some("fable".into()),
            bucket: "claude".into(),
        });
    }
    windows
}
pub fn parse_gemini(v: &Value) -> Vec<LimitWindow> {
    let mut windows = vec![];
    for group in v["groups"].as_array().into_iter().flatten() {
        // Gemini and the third-party models have distinct quotas in Antigravity.
        if !group["name"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Gemini Models"))
        {
            continue;
        }
        for (index, w) in group["buckets"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let name = w["name"].as_str().unwrap_or("");
            let window = w["window"].as_str().unwrap_or("").to_lowercase();
            let minutes = if window.contains("week") || name.to_lowercase().contains("weekly") {
                Some(10080)
            } else if window.contains("five")
                || window.contains("5h")
                || name.to_lowercase().contains("five hour")
            {
                Some(300)
            } else {
                None
            };
            let used = w["remaining_fraction"]
                .as_f64()
                .filter(|n| n.is_finite() && (0. ..=1.).contains(n))
                .map(|remaining| (1. - remaining) * 100.);
            windows.push(LimitWindow {
                id: format!("gemini-{index}"),
                label: if minutes.is_some() {
                    label(minutes)
                } else {
                    name.chars().take(60).collect()
                },
                used_percent: used,
                resets_at: reset(&w["reset_time"]),
                window_minutes: minutes,
                model: None,
                bucket: "gemini".into(),
            });
        }
    }
    windows
}
pub async fn read(
    app: tauri::AppHandle,
    state: &UsageState,
    provider: &str,
    model: &str,
    force: bool,
) -> Result<UsageSnapshot, String> {
    if !crate::providers::valid_provider(provider)
        || model.len() > 100
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._:/[]".contains(c))
    {
        return Err("Invalid usage query".into());
    }
    let location = crate::providers::resolve(provider).await?.location();
    let key = format!(
        "{}:{location}:{provider}:{model}",
        crate::profiles::current().id
    );
    if !force {
        if let Some(cached) = state
            .cache
            .lock()
            .map_err(|_| "Usage cache failed")?
            .get(&key)
            .filter(|s| now().saturating_sub(s.checked_at) < 60)
            .cloned()
        {
            return Ok(cached);
        }
    }
    let _slot = state
        .slots
        .try_acquire()
        .map_err(|_| "Usage refresh is already busy")?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("usage-runtime");
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot prepare usage query")?;
    let query_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    state
        .active
        .lock()
        .map_err(|_| "Usage registry failed")?
        .insert(query_id.clone(), cancel.clone());
    let result = async {
    let (windows,context,detail) = match provider {
        "codex" => (parse_codex(&cli_queries::codex("account/rateLimits/read", Value::Null, cancel.clone()).await?), None, "Reported by Codex. Limits apply across your account."),
        "claude" => {
            let (v,c) = cli_queries::claude_usage(model,&directory,cancel.clone()).await?;
            if v["rate_limits_available"] == true && !v["rate_limits"].is_object() {
                return Err("Claude did not return its usage limits. Try refreshing shortly.".into());
            }
            let capacity = c.and_then(|c| Some(ContextCapacity { model:c["model"].as_str()?.into(), tokens:c["rawMaxTokens"].as_u64().filter(|n| *n>0)?, source:"Claude CLI context summary".into() }));
            let detail = if v["rate_limits_available"] == true { "Reported by Claude. Limits are shared with other Claude sessions." } else { "Subscription limits are not available for this Claude login." };
            (parse_claude(&v),capacity,detail)
        }
        "gemini" => (parse_gemini(&cli_queries::gemini_usage(&directory,cancel.clone()).await?), None, "Reported by Antigravity for Gemini models. Only windows returned by your account are shown."),
        _ => unreachable!(),
    };
    let snapshot = UsageSnapshot {
        provider: provider.into(),
        checked_at: now(),
        windows,
        context,
        detail: detail.into(),
    };
    let mut cache = state.cache.lock().map_err(|_| "Usage cache failed")?;
    if cache.len() >= 30 {
        cache.clear();
    }
    cache.insert(key, snapshot.clone());
    Ok(snapshot)
    }.await;
    if let Ok(mut active) = state.active.lock() {
        active.remove(&query_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_uses_durations_and_keeps_separate_buckets() {
        let result = parse_codex(
            &json!({"rateLimits":{"primary":{"usedPercent":99}},"rateLimitsByLimitId":{"codex":{"primary":{"windowDurationMins":10080,"usedPercent":26,"resetsAt":123}},"other":{"limitName":"Spark","primary":{"windowDurationMins":300,"usedPercent":0}}}}),
        );
        assert_eq!(result[0].label, "Weekly");
        assert_eq!(result[0].used_percent, Some(26.));
        assert!(result[0].model.is_none());
        assert_eq!(result[1].used_percent, Some(0.));
        assert!(result[1].model.is_some());
    }
    #[test]
    fn claude_only_uses_labelled_fable_bucket_and_preserves_unknowns() {
        let result = parse_claude(
            &json!({"rate_limits":{"five_hour":{"utilization":null},"seven_day":{"utilization":31},"nimbus_quill":{"utilization":0},"model_scoped":[{"display_name":"Fable","utilization":62,"resets_at":null}]}}),
        );
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].used_percent, None);
        assert_eq!(result[2].model.as_deref(), Some("fable"));
        assert_eq!(result[2].used_percent, Some(62.));
        assert!(parse_claude(&json!({"rate_limits":null})).is_empty());
    }
    #[test]
    fn gemini_converts_remaining_without_mixing_third_party_quota() {
        let result = parse_gemini(
            &json!({"groups":[{"name":"Gemini Models","buckets":[{"name":"Weekly Limit Remaining","remaining_fraction":0.75},{"name":"Five Hour Limit Remaining","remaining_fraction":null}]},{"name":"Claude and GPT models","buckets":[{"remaining_fraction":0.1}]}]}),
        );
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].used_percent, Some(25.));
        assert_eq!(result[1].used_percent, None);
    }
}
