//! One ephemeral app-server thread per submitted reply, retaining the selected
//! profile and process cwd. This stream includes sub-agent events exec omits.
use super::RunRequest;
use crate::protocol::{Decoder, RunEvent};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Child,
};
use tokio_util::sync::CancellationToken;

fn start_params(request: &RunRequest) -> Value {
    let mut params =
        json!({"approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true});
    if !request.agent.model.is_empty() {
        params["model"] = json!(request.agent.model);
    }
    params
}
fn turn_params(request: &RunRequest, thread: &str) -> Value {
    let mut params = json!({"threadId":thread,"input":[{"type":"text","text":request.prompt(),"text_elements":[]}]});
    let input = params["input"].as_array_mut().expect("input is an array");
    for (message_index, message) in request.messages.iter().enumerate() {
        for (image_index, image) in message.images.iter().enumerate() {
            input.push(json!({"type":"text","text":image.label(message_index, image_index),"text_elements":[]}));
            input.push(json!({"type":"image","url":image.data_url()}));
        }
    }
    if !request.agent.reasoning.is_empty() {
        params["effort"] = json!(request.agent.reasoning);
    }
    params
}
pub async fn run(
    child: &mut Child,
    request: &RunRequest,
    channel: Option<&Channel<RunEvent>>,
    cancel: CancellationToken,
    timeout: Duration,
) -> Result<(String, String), String> {
    let mut input = child.stdin.take().ok_or("Codex input is unavailable")?;
    let mut output =
        BufReader::new(child.stdout.take().ok_or("Codex output is unavailable")?).lines();
    let mut stderr = BufReader::new(
        child
            .stderr
            .take()
            .ok_or("Codex diagnostics are unavailable")?,
    )
    .lines();
    let mut stderr_done = false;
    let init = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}}});
    input
        .write_all(format!("{init}\n").as_bytes())
        .await
        .map_err(|_| "Could not initialize Codex")?;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut thread = String::new();
    let mut decoder = Decoder::default();
    let output_limit = request.output_line_limit();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(("cancelled".into(), String::new())),
            _ = &mut deadline => return Err("The provider did not finish within 5 minutes. Try again or check its CLI login.".into()),
            line = stderr.next_line(), if !stderr_done => { if !matches!(line, Ok(Some(_))) { stderr_done = true; } },
            line = output.next_line() => {
                let Some(line) = line.map_err(|_| "Could not read the Codex response")? else { return Err("Codex exited before confirming the reply. Check its login and CLI version.".into()); };
                if line.len() > output_limit { return Err("Provider output exceeded the message limit".into()); }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                if value["id"].as_u64().is_some_and(|id| (1..=3).contains(&id)) && value.get("method").is_none() {
                    if value["error"].is_object() { return Err("Codex could not start this reply. Check its login, model access, and CLI version.".into()); }
                    let next = match value["id"].as_u64() {
                        Some(1) => {
                            input.write_all(b"{\"method\":\"initialized\"}\n").await.map_err(|_| "Codex initialization failed")?;
                            Some(json!({"id":2,"method":"thread/start","params":start_params(request)}))
                        }
                        Some(2) => {
                            decoder.reported_model(value["result"]["model"].as_str());
                            thread = value["result"]["thread"]["id"].as_str().ok_or("Codex did not return a thread identity")?.into();
                            Some(json!({"id":3,"method":"turn/start","params":turn_params(request, &thread)}))
                        }
                        _ => None,
                    };
                    if let Some(next) = next { input.write_all(format!("{next}\n").as_bytes()).await.map_err(|_| "Could not send the Codex request")?; }
                    continue;
                }
                if value.get("id").is_some() && value["method"].is_string() {
                    // Full-access runs do not need approvals. Unsupported interactions
                    // fail explicitly instead of hanging or handling account secrets.
                    let response = json!({"id":value["id"],"error":{"code":-32601,"message":"This interaction is unavailable in Agent Studio. Ask the user in your text reply."}});
                    input.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to the Codex tool")?;
                    continue;
                }
                if thread.is_empty() { continue; }
                for event in decoder.decode_codex_server(&value, &thread) {
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
                if value["method"] == "turn/completed" && value["params"]["threadId"] == thread {
                    let status = value["params"]["turn"]["status"].as_str().unwrap_or_default();
                    if status == "interrupted" { return Ok(("cancelled".into(), decoder.text)); }
                    if status != "completed" { return Err("Codex could not complete the reply. Check its login, model access, and connection.".into()); }
                    if decoder.text.trim().is_empty() { return Err("The CLI exited without a text response. Check Connections or try another model.".into()); }
                    return Ok(("complete".into(), decoder.text));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_inputs_preserve_order_and_replay_images_as_visual_data() {
        let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","instructions":""},"messages":[{"role":"user","text":"first","images":[{"id":uuid::Uuid::new_v4(),"name":"first.png","mediaType":"image/png","data":"aGVsbG8="}]},{"role":"assistant","text":"seen"},{"role":"user","text":"second","images":[{"id":uuid::Uuid::new_v4(),"name":"second.jpeg","mediaType":"image/jpeg","data":"d29ybGQ="}]}]})).unwrap();
        let params = turn_params(&request, "thread");
        assert_eq!(
            params["input"][2],
            json!({"type":"image","url":"data:image/png;base64,aGVsbG8="})
        );
        assert_eq!(
            params["input"][4],
            json!({"type":"image","url":"data:image/jpeg;base64,d29ybGQ="})
        );
        assert!(params["input"][3]["text"]
            .as_str()
            .unwrap()
            .contains("message 3"));
        assert!(!params["input"][0]["text"]
            .as_str()
            .unwrap()
            .contains("aGVsbG8="));
    }
    #[test]
    fn server_requests_keep_full_access_ephemeral_state_and_prompt_as_data() {
        let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture-model","reasoning":"high","instructions":"Do not reinterpret quotes"},"messages":[{"role":"user","text":"'\" $(literal)\nhello"}]})).unwrap();
        assert_eq!(
            start_params(&request),
            json!({"approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true,"model":"fixture-model"})
        );
        let turn = turn_params(&request, "fixture-thread");
        assert_eq!(turn["effort"], "high");
        assert_eq!(turn["input"][0]["text"], request.prompt());
        assert!(start_params(&request).get("cwd").is_none()); // Inherit validated process cwd, including WSL.
    }
}
