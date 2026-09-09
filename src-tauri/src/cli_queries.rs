//! Read-only CLI queries. No prompts, credential reads, or raw diagnostics leave this module.
use crate::providers::resolve;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

pub async fn codex(
    method: &str,
    params: Value,
    cancel: CancellationToken,
) -> Result<Value, String> {
    let exe = resolve("codex").await?;
    let mut child = exe
        .command()
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start the Codex account query")?;
    let mut input = child.stdin.take().ok_or("Missing CLI input")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("Missing CLI output")?).lines();
    let query = async {
        let init = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_studio","version":"0.1.0"}}});
        input
            .write_all(format!("{init}\n").as_bytes())
            .await
            .map_err(|_| "CLI input failed")?;
        while let Some(line) = lines.next_line().await.map_err(|_| "CLI output failed")? {
            if line.len() > 2_000_000 {
                return Err("CLI query exceeded the output limit");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["id"] == 1 {
                if v["error"].is_object() {
                    return Err("Codex does not support this account query");
                }
                let request = json!({"id":2,"method":method,"params":params});
                input
                    .write_all(format!("{{\"method\":\"initialized\"}}\n{request}\n").as_bytes())
                    .await
                    .map_err(|_| "CLI input failed")?;
            } else if v["id"] == 2 {
                return if v["error"].is_object() {
                    Err("Codex usage could not be read. Check its login and connection.")
                } else {
                    Ok(v["result"].clone())
                };
            }
        }
        Err("Codex exited without a query result")
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("Usage query cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(25), query) => result.map_err(|_| "Codex account query timed out").and_then(|r|r).map_err(String::from),
    };
    exe.kill(&mut child).await;
    result
}

pub async fn claude_usage(
    model: &str,
    directory: &Path,
    cancel: CancellationToken,
) -> Result<(Value, Option<Value>), String> {
    let exe = resolve("claude").await?;
    let mut command = exe.command();
    command
        .current_dir(directory)
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--safe-mode",
            "--strict-mcp-config",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
        ])
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if !model.is_empty() {
        command.args(["--model", model]);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the Claude usage query")?;
    let mut input = child.stdin.take().ok_or("Missing CLI input")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("Missing CLI output")?).lines();
    let mut usage = None;
    let query = async {
        input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"init\",\"request\":{\"subtype\":\"initialize\"}}\n").await.map_err(|_| "CLI input failed")?;
        while let Some(line) = lines.next_line().await.map_err(|_| "CLI output failed")? {
            if line.len() > 2_000_000 {
                return Err("CLI query exceeded the output limit");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["type"] != "control_response" {
                continue;
            }
            let response = &v["response"];
            let id = response["request_id"].as_str().unwrap_or("");
            if response["subtype"] == "error" {
                return if id == "context" {
                    Ok(None)
                } else {
                    Err("This Claude CLI could not report usage. Update it or check its connection.")
                };
            }
            let request = match id {
                "init" => {
                    json!({"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}})
                }
                "usage" => {
                    usage = Some(response["response"].clone());
                    json!({"type":"control_request","request_id":"context","request":{"subtype":"get_context_usage","detail":"summary"}})
                }
                "context" => return Ok(Some(response["response"].clone())),
                _ => continue,
            };
            input
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|_| "CLI input failed")?;
        }
        Err("Claude exited without a usage result")
    };
    let context = tokio::select! {
        _ = cancel.cancelled() => None,
        result = tokio::time::timeout(Duration::from_secs(25), query) => result.ok().and_then(Result::ok),
    };
    exe.kill(&mut child).await;
    if cancel.is_cancelled() {
        return Err("Usage query cancelled".into());
    }
    match usage {
        Some(usage) => Ok((usage, context.flatten())),
        None => Err("Claude usage is unavailable. Update the CLI or check its login.".into()),
    }
}

pub async fn gemini_usage(directory: &Path, cancel: CancellationToken) -> Result<Value, String> {
    let exe = resolve("gemini").await?;
    let mut child = exe
        .command()
        .current_dir(directory)
        .args(["--print", "/usage", "--output-format", "json"])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start the Gemini usage query")?;
    let mut lines = BufReader::new(child.stdout.take().ok_or("Missing CLI output")?).lines();
    let query = async {
        while let Some(line) = lines.next_line().await.map_err(|_| "CLI output failed")? {
            if line.len() > 512_000 {
                return Err("CLI query exceeded the output limit");
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v["status"] == "SUCCESS" && v["command"]["name"] == "usage" {
                return Ok(v["command"]["data"].clone());
            }
        }
        Err("Gemini usage is unavailable. Check Antigravity's login and connection.")
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("Usage query cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(25), query) => result.map_err(|_| "Gemini usage query timed out").and_then(|r|r).map_err(String::from),
    };
    exe.kill(&mut child).await;
    result
}
