//! Resolve a fresh CLI default before resuming a transcript with a saved model.
//! Queries never submit a prompt, execute tools, or return configuration bodies.
use super::{Executable, RunRequest};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

fn claude_command(
    exe: &Executable,
    request: &RunRequest,
    cwd: &Path,
) -> Result<tokio::process::Command, String> {
    let mut command = exe.command();
    command.current_dir(cwd);
    if exe.wsl.is_some() {
        if let Some(location) = &request.location {
            command.args(["--agent-studio-cwd", &location.path]);
        } else if let Some(conversation) = &request.conversation_id {
            // chat_command has already validated and prepared this binding. The
            // inspection must use the same Linux folder without creating one.
            let root = cwd.parent().ok_or("Cannot locate conversation data")?;
            let directory = crate::standalone::lookup(root, conversation, "claude", None)?
                .ok_or("Cannot find this chat's working-folder binding")?;
            if directory == crate::standalone::Directory::Dedicated {
                let id =
                    uuid::Uuid::parse_str(conversation).map_err(|_| "Invalid conversation id")?;
                command.args(["--agent-studio-standalone", &id.to_string()]);
            }
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
    Ok(command)
}

pub async fn claude_model(
    exe: &Executable,
    request: &RunRequest,
    cwd: &Path,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let mut command = claude_command(exe, request, cwd)?;
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
    fn claude_default_inspection_preserves_wsl_working_folder() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("chat-runtime");
        let mut request: RunRequest = serde_json::from_value(json!({
            "runId":uuid::Uuid::new_v4(), "conversationId":uuid::Uuid::new_v4(),
            "agent":{"provider":"claude","model":"","instructions":""},
            "messages":[{"role":"user","text":"Hello"}]
        }))
        .unwrap();
        let exe = Executable {
            provider: "claude".into(),
            program: "wsl.exe".into(),
            prefix: vec![],
            wsl: Some(crate::wsl::Launch {
                distribution: "Ubuntu".into(),
                namespace: "test".into(),
                job: uuid::Uuid::new_v4().to_string(),
            }),
        };
        // Missing bindings must fail instead of inspecting the shared folder.
        assert!(claude_command(&exe, &request, &cwd).is_err());
        let id = crate::standalone::prepare(root.path(), &request)
            .unwrap()
            .unwrap();
        let command = claude_command(&exe, &request, &cwd).unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..2], &["--agent-studio-standalone", &id.to_string()]);
        assert!(!args.iter().any(|s| s == "--resume" || s == "--model"));
        request.location = Some(
            serde_json::from_value(
                json!({"computerId":"host", "environmentId":"wsl", "path":"/home/user/project"}),
            )
            .unwrap(),
        );
        let command = claude_command(&exe, &request, &cwd).unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&args[..2], &["--agent-studio-cwd", "/home/user/project"]);
        request.location = None;
        request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        request.messages.push(request.messages[0].clone());
        assert!(crate::standalone::prepare(root.path(), &request)
            .unwrap()
            .is_none());
        let command = claude_command(&exe, &request, &cwd).unwrap();
        assert!(!command
            .as_std()
            .get_args()
            .any(|s| s == "--agent-studio-standalone"));
        // Windows already receives the validated native folder as its cwd.
        let mut local = exe;
        local.wsl = None;
        let command = claude_command(&local, &request, root.path()).unwrap();
        assert_eq!(command.as_std().get_current_dir(), Some(root.path()));
    }

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
