//! Apply reply settings on the owned Claude stream before submitting human input.
//! Effort is a launch setting; a thinking-token budget is a separate native control.
use super::Agent;
use crate::pool::Process;
use serde_json::{json, Value};
use std::collections::VecDeque;
use tokio::io::AsyncWriteExt;

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    model: String,
    max_thinking_tokens: Option<u32>,
}

impl Settings {
    pub fn uses_default_model(&self) -> bool {
        self.model.is_empty()
    }
}

pub struct Update {
    desired: Settings,
    requests: VecDeque<Value>,
    pending: Option<String>,
}

impl Update {
    pub fn new(
        agent: &Agent,
        current: Option<&Settings>,
        reused: bool,
        default_model: Option<&str>,
    ) -> Result<Self, String> {
        let desired = Settings {
            model: agent.model.trim().into(),
            max_thinking_tokens: agent.max_thinking_tokens,
        };
        let mut requests = VecDeque::new();
        if reused && current.is_none_or(|s| s.model != desired.model) {
            // Claude 2.1.277 acknowledges null/omitted/default without restoring
            // the profile's configured model. Resolve it with the existing bounded,
            // non-query default reader and send the explicit model instead.
            let model = if desired.model.is_empty() {
                default_model
                    .ok_or("Claude's default model was not resolved. No message was sent.")?
            } else {
                &desired.model
            };
            let request = json!({"subtype":"set_model", "model":model});
            requests.push_back(request);
        }
        if current.and_then(|s| s.max_thinking_tokens) != desired.max_thinking_tokens {
            // No app budget is passed at spawn, so null restores the CLI default,
            // even after a previous reply explicitly disabled thinking with zero.
            requests.push_back(json!({"subtype":"set_max_thinking_tokens", "max_thinking_tokens":desired.max_thinking_tokens}));
        }
        Ok(Self {
            desired,
            requests,
            pending: None,
        })
    }

    /// Send exactly one control at a time. Only send the prompt after all acks.
    pub async fn advance(&mut self, process: &mut Process, prompt: &str) -> Result<bool, String> {
        let payload = if let Some(request) = self.requests.pop_front() {
            let id = format!("studio-settings-{}", uuid::Uuid::new_v4());
            self.pending = Some(id.clone());
            format!(
                "{}\n",
                json!({"type":"control_request", "request_id":id, "request":request})
            )
        } else {
            self.pending = None;
            prompt.to_string()
        };
        process
            .stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|_| {
                process.healthy = false;
                "Could not send Claude's next-reply settings or input.".to_string()
            })?;
        if self.pending.is_none() {
            process.claude_settings = Some(self.desired.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn acknowledge(&self, value: &Value, session_id: &str) -> Result<bool, String> {
        if value["type"] != "control_response"
            || !value["parent_tool_use_id"].is_null()
            || (!value["session_id"].is_null() && value["session_id"].as_str() != Some(session_id))
            || self.pending.as_deref().is_none()
            || value["response"]["request_id"].as_str() != self.pending.as_deref()
        {
            return Ok(false);
        }
        if value["response"]["subtype"] != "success" {
            // Provider diagnostics can contain configuration or other private data.
            return Err("Claude could not apply the next-reply settings. No message was sent. Check the selected model and thinking budget, then retry.".into());
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledgments_are_exact_parent_requests_and_never_expose_errors() {
        let agent =
            serde_json::from_value(json!({"provider":"claude","model":"sonnet","instructions":""}))
                .unwrap();
        let mut update = Update::new(&agent, None, true, None).unwrap();
        update.pending = Some("owned".into());
        let success = json!({"type":"control_response","response":{"request_id":"owned","subtype":"success"}});
        assert!(update.acknowledge(&success, "session").unwrap());
        for (field, value) in [("parent_tool_use_id", "child"), ("session_id", "foreign")] {
            let mut other = success.clone();
            other[field] = json!(value);
            assert!(!update.acknowledge(&other, "session").unwrap());
        }
        let mut other = success.clone();
        other["response"]["request_id"] = json!("stale");
        assert!(!update.acknowledge(&other, "session").unwrap());
        other["response"]["request_id"] = json!("owned");
        other["response"]["subtype"] = json!("error");
        other["response"]["error"] = json!("PRIVATE");
        let error = update.acknowledge(&other, "session").unwrap_err();
        assert!(error.contains("No message was sent"));
        assert!(!error.contains("PRIVATE"));
    }

    #[test]
    fn budgets_are_bounded_and_restricted_to_claude_chat() {
        let mut request: super::super::RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":"Hi"}]})).unwrap();
        for n in [0, 1024, 4096, 128000] {
            request.agent.max_thinking_tokens = Some(n);
            assert!(request.validate().is_ok());
        }
        for n in [1, 1023, 128001, u32::MAX] {
            request.agent.max_thinking_tokens = Some(n);
            assert!(request.validate().is_err());
        }
        request.agent.max_thinking_tokens = Some(4096);
        request.conversation_only = true;
        assert!(request.validate().is_err());
        request.conversation_only = false;
        request.agent.provider = "codex".into();
        assert!(request.validate().is_err());
    }
}
