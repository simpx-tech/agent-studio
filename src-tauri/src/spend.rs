//! Bounded account observations, never a claim of per-chat billing attribution.
use crate::usage::{CreditUsage, UsageSnapshot};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    id: String,
    label: String,
    used_percent: Option<f64>,
    resets_at: Value,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    checked_at: u64,
    windows: Vec<Window>,
    balance: Option<f64>,
    extra_used: Option<f64>,
    currency: Option<String>,
}
impl From<UsageSnapshot> for Point {
    fn from(snapshot: UsageSnapshot) -> Self {
        let (balance, extra_used, currency) = match snapshot.credits {
            Some(CreditUsage::Codex {
                balance, unlimited, ..
            }) => (
                if unlimited == Some(true) {
                    None
                } else {
                    balance
                },
                None,
                None,
            ),
            Some(CreditUsage::Claude { used, currency, .. }) => (None, used, currency),
            _ => (None, None, None),
        };
        Self {
            checked_at: snapshot.checked_at,
            windows: snapshot
                .windows
                .into_iter()
                .take(16)
                .map(|w| Window {
                    id: w.id.chars().take(200).collect(),
                    label: format!(
                        "{}{}",
                        w.model.map(|m| format!("{m} · ")).unwrap_or_default(),
                        w.label
                    )
                    .chars()
                    .take(200)
                    .collect(),
                    used_percent: w.used_percent,
                    resets_at: match w.resets_at {
                        Value::String(s) if s.len() <= 80 => Value::String(s),
                        Value::Number(n) => Value::Number(n),
                        _ => Value::Null,
                    },
                })
                .collect(),
            balance,
            extra_used,
            currency,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub version: u8,
    pub revision: u8,
    pub run_id: String,
    pub before: Option<Point>,
    pub after: Option<Point>,
    pub run_duration_ms: Option<u64>,
}

/// Micros are integers. Reject unsafe precision, negatives and non-numeric values.
pub fn micros(value: &Value) -> Option<f64> {
    value
        .as_u64()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .map(|v| v as f64 / 1_000_000.)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn billing_estimates_require_safe_integer_micros() {
        assert_eq!(micros(&json!(1250000)), Some(1.25));
        assert_eq!(micros(&json!(0)), Some(0.));
        for value in [
            json!(-1),
            json!(0.25),
            json!(9007199254740992_u64),
            json!(null),
            json!("1000"),
        ] {
            assert_eq!(micros(&value), None);
        }
    }
}
