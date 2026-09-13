//! Resolve a fresh CLI default before resuming a transcript with a saved model.
//! Queries never submit a prompt, execute tools, or return configuration bodies.
use super::{Executable, RunRequest};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

pub async fn claude_model(
    exe: &Executable,
    request: &RunRequest,
    cwd: &Path,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let mut command = exe.command();
    command.current_dir(cwd);
    if exe.wsl.is_some() {
        if let Some(location) = &request.location {
            command.args(["--agent-studio-cwd", &location.path]);
        }
    }
    command
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--settings",
            "{\"disableAllHooks\":true}",
        ])
        .env_remove("CLAUDECODE")
        .env_remove("CODEX_THREAD_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Could not query Claude's default model")?;
    let mut input = child
        .stdin
        .take()
        .ok_or("Missing default-model query input")?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .ok_or("Missing default-model query output")?,
    )
    .lines();
    let query = async {
        input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"init\",\"request\":{\"subtype\":\"initialize\"}}\n").await.map_err(|_| "Default-model query input failed")?;
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|_| "Default-model query output failed")?
        {
            if line.len() > 2_000_000 {
                return Err("Default-model query exceeded its output limit");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["type"] != "control_response" {
                continue;
            }
            let response = &v["response"];
            if response["subtype"] == "error" {
                return Err("Claude could not resolve its default model. Select an explicit model to continue.");
            }
            if response["request_id"] == "init" {
                input.write_all(format!("{}\n", json!({"type":"control_request","request_id":"context","request":{"subtype":"get_context_usage","detail":"full"}})).as_bytes()).await.map_err(|_| "Default-model query input failed")?;
            } else if response["request_id"] == "context" {
                return response["response"]["model"].as_str().filter(|m| !m.is_empty() && m.len() <= 256).map(String::from).ok_or("Claude did not report its default model. Select an explicit model to continue.");
            }
        }
        Err("Claude exited before reporting its default model")
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("Default-model query cancelled"),
        result = tokio::time::timeout(Duration::from_secs(25), query) => result.unwrap_or(Err("Default-model query timed out. Select an explicit model to continue.")),
    };
    exe.kill(&mut child).await;
    result.map_err(String::from)
}

pub fn codex_config(request: &mut RunRequest, config: &Value) {
    if request.agent.model.is_empty() {
        if let Some(model) = config["model"].as_str().filter(|s| s.len() <= 256) {
            request.agent.model = model.into();
        }
    }
    if request.agent.reasoning.is_empty() {
        if let Some(effort) = config["model_reasoning_effort"].as_str() {
            request.agent.reasoning = effort.into();
        }
    }
}
pub fn codex_models(request: &mut RunRequest, models: &[Value]) -> bool {
    let selected = models.iter().find(|m| {
        if request.agent.model.is_empty() {
            m["isDefault"] == true
        } else {
            m["model"] == request.agent.model
        }
    });
    if let Some(model) = selected {
        if request.agent.model.is_empty() {
            request.agent.model = model["model"].as_str().unwrap_or_default().into();
        }
        if request.agent.reasoning.is_empty() {
            request.agent.reasoning = model["defaultReasoningEffort"]
                .as_str()
                .unwrap_or_default()
                .into();
        }
    }
    !request.agent.model.is_empty() && !request.agent.reasoning.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_honor_profile_configuration_and_explicit_picks() {
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","instructions":""},"messages":[{"role":"user","text":"Hello"}]})).unwrap();
        codex_config(
            &mut request,
            &json!({"model":"configured","model_reasoning_effort":"high","private_config":"discard"}),
        );
        assert_eq!(request.agent.model, "configured");
        assert_eq!(request.agent.reasoning, "high");
        request.agent.reasoning.clear();
        assert!(codex_models(
            &mut request,
            &[json!({"model":"configured","defaultReasoningEffort":"medium"})]
        ));
        assert_eq!(request.agent.reasoning, "medium");
        codex_config(
            &mut request,
            &json!({"model":"other","model_reasoning_effort":"low"}),
        );
        assert_eq!(request.agent.model, "configured");
        assert_eq!(request.agent.reasoning, "medium");
        request.agent.model.clear();
        request.agent.reasoning.clear();
        assert!(!codex_models(&mut request, &[]));
        assert!(codex_models(
            &mut request,
            &[json!({"model":"runtime-default","isDefault":true,"defaultReasoningEffort":"low"})]
        ));
        assert_eq!(request.agent.model, "runtime-default");
    }
}
