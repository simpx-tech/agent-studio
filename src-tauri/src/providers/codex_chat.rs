//! CLI-owned persistent threads, resumed by host-local conversation bindings.
//! Legacy callers without a conversation identity retain ephemeral execution.
use super::RunRequest;
use crate::protocol::Decoder;
use crate::runner::EventSink;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Child,
};
use tokio_util::sync::CancellationToken;

fn plan_tool() -> Value {
    json!({"type":"function","name":"studio_update_plan","deferLoading":false,
        "description":"Update the plan and progress panel for this conversation. For multi-step work, report the complete ordered plan before starting and update statuses as work progresses. Mark only finished steps completed. This tool only displays progress; it does not execute work.",
        "inputSchema":{"type":"object","properties":{
            "explanation":{"type":"string","maxLength":2000},
            "plan":{"type":"array","maxItems":64,"items":{"type":"object","properties":{
                "step":{"type":"string","minLength":1,"maxLength":1000},
                "status":{"type":"string","enum":["pending","inProgress","completed"]}
            },"required":["step","status"],"additionalProperties":false}}
        },"required":["plan"],"additionalProperties":false}})
}
fn plan_response(
    value: &Value,
    root: &str,
    decoder: &mut Decoder,
) -> Option<(Value, Vec<crate::protocol::RunEvent>)> {
    let params = &value["params"];
    if value["method"] != "item/tool/call" || params["tool"] != "studio_update_plan" {
        return None;
    }
    let args = &params["arguments"];
    let valid = !root.is_empty()
        && params["threadId"] == root
        && params["namespace"].is_null()
        && args.to_string().len() <= 128_000
        && args["plan"].as_array().is_some_and(|steps| {
            steps.len() <= 64
                && steps.iter().all(|s| {
                    s["step"].as_str().is_some_and(|title| {
                        !title.trim().is_empty() && title.chars().count() <= 1000
                    }) && matches!(
                        s["status"].as_str(),
                        Some("pending" | "inProgress" | "completed")
                    )
                })
        })
        && (args.get("explanation").is_none()
            || args["explanation"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= 2000));
    let events = if valid {
        // Normalize the actual model tool call through the same revisioned plan decoder.
        let mut update = args.clone();
        update["threadId"] = json!(root);
        decoder.decode_codex_server(&json!({"method":"turn/plan/updated","params":update}), root)
    } else {
        vec![]
    };
    Some((
        json!({"id":value["id"],"result":{"success":valid,"contentItems":[{"type":"inputText","text":if valid {"Plan updated."} else {"Plan rejected. Report at most 64 named steps with pending, inProgress, or completed status in the parent conversation."}}]}}),
        events,
    ))
}

fn start_params(request: &RunRequest) -> Value {
    let mut params = json!({"approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true,"dynamicTools":[plan_tool(), super::visualize::codex_tool(), super::questions::codex_tool()]});
    if !request.agent.model.is_empty() {
        params["model"] = json!(request.agent.model);
    }
    if let Some(session) = &request.native_session {
        params["ephemeral"] = json!(false);
        if session.resumed {
            params.as_object_mut().unwrap().remove("ephemeral");
            params.as_object_mut().unwrap().remove("dynamicTools");
            params["threadId"] = json!(session.id());
            params["excludeTurns"] = json!(true);
        }
    }
    params
}
fn turn_params(request: &RunRequest, thread: &str) -> Value {
    // Keep the visible slash spelling in history; only the current invocation
    // becomes a native skill input. Earlier skills must not execute again.
    let mut current = request.clone();
    let skills = request
        .messages
        .last()
        .map(|m| m.skills.as_slice())
        .unwrap_or_default();
    if let (Some(skill), Some(message)) = (skills.first(), current.messages.last_mut()) {
        let trimmed = message.text.trim_start();
        if let Some(rest) = trimmed.strip_prefix(&format!("/{}", skill.name)) {
            message.text = format!("${}{}", skill.name, rest);
        }
    }
    let mut params = json!({"threadId":thread,"input":[]});
    let input = params["input"].as_array_mut().expect("input is an array");
    if current.native_session.is_some() {
        if let Some(context) = current.native_context() {
            input.push(json!({"type":"text","text":context,"text_elements":[]}));
        }
        input.push(json!({"type":"text","text":current.native_user_text(),"text_elements":[]}));
    } else {
        input.push(json!({"type":"text","text":current.prompt(),"text_elements":[]}));
    }
    for skill in skills {
        if current.native_session.as_ref().is_some_and(|s| s.retry) {
            break;
        }
        input.push(json!({"type":"skill","name":skill.name,"path":skill.path}));
    }
    for (message_index, message) in request.messages.iter().enumerate() {
        if !request.native_image_message(message_index) {
            continue;
        }
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
    channel: Option<&EventSink>,
    cancel: CancellationToken,
    timeout: Duration,
    questions: &mut super::questions::Session,
    config_cwd: Option<&str>,
) -> Result<(String, String), String> {
    let mut effective = request.clone();
    let resolve_defaults = effective.native_session.as_ref().is_some_and(|s| s.resumed)
        && (effective.agent.model.is_empty() || effective.agent.reasoning.is_empty());
    let request = &mut effective;
    let mut model_pages = 0;
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
    let interaction_deadline = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(interaction_deadline);
    let mut thread = String::new();
    let mut turn = String::new();
    let mut cancelling = false;
    let mut decoder = Decoder::default();
    let mut visualizer = super::visualize::Visualizer::default();
    let output_limit = request.output_line_limit();
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled(), if !cancelling => {
                if thread.is_empty() || turn.is_empty() { return Ok(("cancelled".into(), decoder.text)); }
                cancelling = true;
                input.write_all(format!("{}\n", json!({"id":4,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}})).as_bytes()).await.map_err(|_| "Could not interrupt Codex")?;
                deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(5));
            },
            _ = &mut interaction_deadline => return Err("The conversation reached its one-hour limit. Pending questions were closed.".into()),
            _ = &mut deadline, if cancelling || !questions.pending() => {
                if cancelling { return Ok(("cancelled".into(), decoder.text)); }
                return Err("The provider reached its response deadline. Continue the conversation to resume its saved work.".into());
            },
            Some(delivery) = questions.rx.recv(), if !cancelling => {
                let result = input.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send answers to Codex.".to_string());
                let failed = result.is_err();
                questions.delivered(delivery, result);
                deadline.as_mut().reset(tokio::time::Instant::now() + timeout);
                if failed { return Err("Could not send answers to Codex.".into()); }
            },
            line = stderr.next_line(), if !stderr_done => { if !matches!(line, Ok(Some(_))) { stderr_done = true; } },
            line = output.next_line() => {
                let Some(line) = line.map_err(|_| "Could not read the Codex response")? else { return Err("Codex exited before confirming the reply. Check its login and CLI version.".into()); };
                if line.len() > output_limit { return Err("Provider output exceeded the message limit".into()); }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                if value["id"].as_u64().is_some_and(|id| matches!(id, 1..=3 | 5 | 6)) && value.get("method").is_none() {
                    if value["error"].is_object() {
                        return Err(if value["id"] == 2 && request.native_session.as_ref().is_some_and(|s| s.resumed) {
                            "Codex could not resume this conversation's native session. Its saved history was preserved. Check the selected CLI profile, or start a new conversation; no message was replayed."
                        } else { "Codex could not start this reply. Check its login, model access, and CLI version." }.into());
                    }
                    let next = match value["id"].as_u64() {
                        Some(1) => {
                            input.write_all(b"{\"method\":\"initialized\"}\n").await.map_err(|_| "Codex initialization failed")?;
                            if resolve_defaults {
                                Some(json!({"id":5,"method":"config/read","params":{"includeLayers":false,"cwd":config_cwd}}))
                            } else {
                                Some(json!({"id":2,"method":if request.native_session.as_ref().is_some_and(|s| s.resumed) { "thread/resume" } else { "thread/start" },"params":start_params(request)}))
                            }
                        }
                        Some(5) => {
                            super::defaults::codex_config(request, &value["result"]["config"]);
                            if request.agent.model.is_empty() || request.agent.reasoning.is_empty() {
                                Some(json!({"id":6,"method":"model/list","params":{"limit":100,"includeHidden":true}}))
                            } else {
                                Some(json!({"id":2,"method":"thread/resume","params":start_params(request)}))
                            }
                        }
                        Some(6) => {
                            model_pages += 1;
                            if super::defaults::codex_models(request, value["result"]["data"].as_array().ok_or("Codex did not report model defaults")?) {
                                Some(json!({"id":2,"method":"thread/resume","params":start_params(request)}))
                            } else if let Some(cursor) = value["result"]["nextCursor"].as_str().filter(|_| model_pages < 10) {
                                Some(json!({"id":6,"method":"model/list","params":{"limit":100,"includeHidden":true,"cursor":cursor}}))
                            } else { return Err("Codex could not resolve current model defaults. Select an explicit model and reasoning level to continue.".into()); }
                        }
                        Some(2) => {
                            decoder.reported_model(value["result"]["model"].as_str());
                            thread = value["result"]["thread"]["id"].as_str().ok_or("Codex did not return a thread identity")?.into();
                            if let Some(session) = &request.native_session { session.bind(&thread, false)?; }
                            Some(json!({"id":3,"method":"turn/start","params":turn_params(request, &thread)}))
                        }
                        Some(3) => {
                            if let Some(id) = value["result"]["turn"]["id"].as_str() { turn = id.into(); }
                            if let Some(session) = &request.native_session { session.bind(&thread, true)?; }
                            None
                        }
                        _ => None,
                    };
                    if let Some(next) = next { input.write_all(format!("{next}\n").as_bytes()).await.map_err(|_| "Could not send the Codex request")?; }
                    continue;
                }
                if value.get("id").is_some() && value["method"].is_string() {
                    if let Some(response) = questions.codex(&value, &thread) {
                        if let Some(response) = response { input.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to the Codex question")?; }
                        continue;
                    }
                    if let Some((response, event)) = visualizer.codex_response(&value, &thread) {
                        if let (Some(channel), Some(event)) = (channel, event) { if channel.send(event).is_err() { cancel.cancel(); } }
                        input.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not confirm the Codex visualization")?;
                        continue;
                    }
                    if let Some((response, events)) = plan_response(&value, &thread, &mut decoder) {
                        for event in events { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                        input.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not confirm the Codex plan")?;
                        continue;
                    }
                    // Full-access runs do not need approvals. Unsupported interactions
                    // fail explicitly instead of hanging or handling account secrets.
                    let response = json!({"id":value["id"],"error":{"code":-32601,"message":"This interaction is unavailable in Agent Studio. Ask the user in your text reply."}});
                    input.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to the Codex tool")?;
                    continue;
                }
                if thread.is_empty() { continue; }
                if value["method"] == "turn/started" && value["params"]["threadId"] == thread {
                    turn = value["params"]["turn"]["id"].as_str().unwrap_or_default().into();
                }
                questions.resolved_codex(&value, &thread);
                for event in decoder.decode_codex_server(&value, &thread) {
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
                if value["method"] == "turn/completed" && value["params"]["threadId"] == thread {
                    let status = value["params"]["turn"]["status"].as_str().unwrap_or_default();
                    if status == "interrupted" { return Ok(("cancelled".into(), decoder.text)); }
                    if status != "completed" { return Err("Codex could not complete the reply. Check its login, model access, and connection.".into()); }
                    if decoder.text.trim().is_empty() && !visualizer.has_visuals() { return Err("The CLI exited without a text response. Check Connections or try another model.".into()); }
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
    fn persistent_turns_resume_exact_thread_and_only_send_new_input() {
        let root = tempfile::tempdir().unwrap();
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Earlier request"}]})).unwrap();
        request.native_session =
            super::super::sessions::Session::prepare(root.path(), &request).unwrap();
        assert_eq!(start_params(&request)["ephemeral"], false);
        assert!(start_params(&request)["dynamicTools"].is_array());
        let session = request.native_session.take().unwrap();
        let id = session.id().to_string();
        session.bind(&id, true).unwrap();
        drop(session);
        request
            .messages
            .push(serde_json::from_value(json!({"role":"assistant","text":"Final only"})).unwrap());
        request
            .messages
            .push(serde_json::from_value(json!({"role":"user","text":"Continue"})).unwrap());
        request.agent.model = "new-model".into();
        request.agent.reasoning = "high".into();
        request.native_session =
            super::super::sessions::Session::prepare(root.path(), &request).unwrap();
        let params = start_params(&request);
        assert_eq!(params["threadId"], id);
        assert_eq!(params["excludeTurns"], true);
        assert_eq!(params["model"], "new-model");
        assert!(params.get("dynamicTools").is_none());
        assert!(params.get("ephemeral").is_none());
        let turn = turn_params(&request, &id);
        assert_eq!(turn["input"].as_array().unwrap().len(), 1);
        assert_eq!(turn["input"][0]["text"], "Continue");
        assert_eq!(turn["effort"], "high");
    }
    #[test]
    fn only_current_skills_are_native_inputs_and_arguments_remain_literal() {
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","instructions":""},"messages":[
            {"role":"user","text":"/old","skills":[{"name":"old","path":"/old/SKILL.md"}]},
            {"role":"assistant","text":"Done"},
            {"role":"user","text":"/review quote $(literal)","skills":[{"name":"review","path":"/selected/profile/review/SKILL.md"}]}
        ]})).unwrap();
        assert!(request.validate().is_ok());
        let params = turn_params(&request, "thread");
        assert_eq!(params["input"].as_array().unwrap().len(), 2);
        assert_eq!(
            params["input"][1],
            json!({"type":"skill","name":"review","path":"/selected/profile/review/SKILL.md"})
        );
        let text = params["input"][0]["text"].as_str().unwrap();
        assert!(text.contains("$review quote $(literal)"));
        assert!(text.contains("/old"));
        assert_eq!(request.messages[2].text, "/review quote $(literal)");
        request.messages[2].skills.clear();
        assert_eq!(
            turn_params(&request, "thread")["input"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        request.agent.provider = "claude".into();
        assert!(request.validate().is_err());
    }
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
            json!({"approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true,"model":"fixture-model","dynamicTools":[plan_tool(), super::super::visualize::codex_tool(), super::super::questions::codex_tool()]})
        );
        let turn = turn_params(&request, "fixture-thread");
        assert_eq!(turn["effort"], "high");
        assert_eq!(turn["input"][0]["text"], request.prompt());
        assert!(start_params(&request).get("cwd").is_none()); // Inherit validated process cwd, including WSL.
    }
    #[test]
    fn plan_tool_validates_parent_and_bounds_without_changing_work() {
        let mut decoder = Decoder::default();
        let mut value = json!({"id":"call","method":"item/tool/call","params":{"threadId":"root","tool":"studio_update_plan","arguments":{"plan":[{"step":"Check","status":"inProgress"}]}}});
        let (response, events) = plan_response(&value, "root", &mut decoder).unwrap();
        assert_eq!(response["result"]["success"], true);
        assert!(
            matches!(&events[0], crate::protocol::RunEvent::Plan{plan} if plan.revision == 1 && plan.steps[0].status == "running")
        );
        assert!(plan_response(&value, "root", &mut decoder)
            .unwrap()
            .1
            .is_empty());
        value["params"]["threadId"] = json!("child");
        assert_eq!(
            plan_response(&value, "root", &mut decoder).unwrap().0["result"]["success"],
            false
        );
        value["params"]["threadId"] = json!("root");
        value["params"]["arguments"]["plan"][0]["status"] = json!("invented");
        assert_eq!(
            plan_response(&value, "root", &mut decoder).unwrap().0["result"]["success"],
            false
        );
        value["params"]["arguments"]["plan"] = json!([{"step":"Check","status":"completed"}]);
        assert!(
            matches!(&plan_response(&value, "root", &mut decoder).unwrap().1[0], crate::protocol::RunEvent::Plan{plan} if plan.revision == 2)
        );
        value["params"]["arguments"]["plan"] =
            json!(vec![json!({"step":"Check","status":"pending"}); 65]);
        assert_eq!(
            plan_response(&value, "root", &mut decoder).unwrap().0["result"]["success"],
            false
        );
    }
}
