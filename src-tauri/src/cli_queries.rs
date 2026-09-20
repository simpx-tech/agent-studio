//! Restricted CLI account queries and explicit reset redemption. No prompts or credential reads.
use crate::providers::resolve;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

pub async fn codex(
    method: &str,
    params: Value,
    cancel: CancellationToken,
) -> Result<Value, String> {
    codex_operation(method, params, cancel, None).await
}

pub async fn codex_reset(key: &str, retry: bool, sent: &AtomicBool) -> Result<Value, String> {
    codex_operation(
        "account/rateLimits/read",
        Value::Null,
        CancellationToken::new(),
        Some((key, retry, sent)),
    )
    .await
}

async fn codex_operation(
    method: &str,
    params: Value,
    cancel: CancellationToken,
    reset: Option<(&str, bool, &AtomicBool)>,
) -> Result<Value, String> {
    let exe = resolve("codex").await?;
    codex_exchange(exe, method, params, cancel, reset).await
}
async fn codex_exchange(
    exe: crate::providers::Executable,
    method: &str,
    params: Value,
    cancel: CancellationToken,
    reset: Option<(&str, bool, &AtomicBool)>,
) -> Result<Value, String> {
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
        let mut awaiting_reset = false;
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
                if let Some((key, retry, sent)) = reset {
                    if v["error"].is_object() {
                        return Err("Codex could not verify account limits before the reset.");
                    }
                    if !retry && !crate::live_usage::reset_eligible(&v["result"]) {
                        return match v["result"]["rateLimitResetCredits"]["availableCount"].as_u64()
                        {
                            Some(0) => Ok(json!({"outcome":"noCredit"})),
                            Some(_) => Ok(json!({"outcome":"nothingToReset"})),
                            None => Err("Codex did not report reset-credit availability."),
                        };
                    }
                    let request = json!({"id":3,"method":"account/rateLimitResetCredit/consume","params":{"idempotencyKey":key}});
                    // A partial write is uncertain. Failures before this point are
                    // known not to have sent a redemption and must recheck eligibility.
                    sent.store(true, Ordering::Relaxed);
                    input
                        .write_all(format!("{request}\n").as_bytes())
                        .await
                        .map_err(|_| "Reset delivery is unconfirmed. Retry the same attempt.")?;
                    awaiting_reset = true;
                    continue;
                }
                return if v["error"].is_object() {
                    Err("Codex usage could not be read. Check its login and connection.")
                } else {
                    Ok(v["result"].clone())
                };
            } else if awaiting_reset && v["id"] == 3 {
                return if v["error"].is_object() {
                    Err("Reset outcome is unconfirmed. Retry the same attempt.")
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reset_preflight_and_redemption_share_one_process_and_retry_key() {
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("account-fixture.cjs");
        std::fs::write(&script, r#"
const fs=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
const [scenario,trace]=process.argv.slice(2);
rl.on('line',line=>{
 const q=JSON.parse(line); if(!q.id)return;
 fs.appendFileSync(trace,JSON.stringify(q)+'\n');
 let result={};
 if(q.method==='account/rateLimits/read' && scenario==='unavailable') {console.log(JSON.stringify({id:q.id,error:{code:-1}}));return;}
 if(q.method==='account/rateLimits/read') result={rateLimits:{primary:{usedPercent:['eligible','lost'].includes(scenario)?95:20,windowDurationMins:10080}},rateLimitResetCredits:{availableCount:scenario==='empty'?0:2}};
 if(q.method==='account/rateLimitResetCredit/consume' && scenario==='lost') process.exit(0);
 if(q.method==='account/rateLimitResetCredit/consume') result={outcome:scenario==='eligible'?'reset':'alreadyRedeemed'};
 console.log(JSON.stringify({id:q.id,result}));
});
"#).unwrap();
        let key = uuid::Uuid::new_v4().to_string();
        for (scenario, retry, expected, consumes) in [
            ("eligible", false, "reset", true),
            ("low", false, "nothingToReset", false),
            ("empty", false, "noCredit", false),
            ("empty", true, "alreadyRedeemed", true),
            ("unavailable", false, "", false),
            ("lost", false, "", true),
        ] {
            let trace = root.path().join(format!("{scenario}-{retry}.jsonl"));
            let exe = crate::providers::Executable {
                provider: "codex".into(),
                program: "node".into(),
                prefix: vec![
                    script.to_string_lossy().into(),
                    scenario.into(),
                    trace.to_string_lossy().into(),
                ],
                wsl: None,
            };
            let sent = AtomicBool::new(false);
            let result = codex_exchange(
                exe,
                "account/rateLimits/read",
                Value::Null,
                CancellationToken::new(),
                Some((&key, retry, &sent)),
            )
            .await;
            if expected.is_empty() {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap()["outcome"], expected);
            }
            assert_eq!(sent.load(Ordering::Relaxed), consumes);
            let calls: Vec<Value> = std::fs::read_to_string(&trace)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(calls.len(), if consumes { 3 } else { 2 });
            assert_eq!(calls[0]["method"], "initialize");
            assert_eq!(calls[1]["method"], "account/rateLimits/read");
            if consumes {
                assert_eq!(calls[2]["params"]["idempotencyKey"], key);
            }
            assert!(calls.iter().all(|q| q["method"] != "turn/start"));
        }
    }
}
