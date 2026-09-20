//! CLI-owned persistent threads, resumed by host-local conversation bindings.
//! Legacy callers without a conversation identity retain ephemeral execution.
//! One app-server process serves a conversation's replies in turn until it is released.
use super::RunRequest;
use crate::pool::{Line, Process, INTERRUPT_GRACE};
use crate::protocol::Decoder;
use crate::runner::EventSink;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio::io::AsyncWriteExt;
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
    // `never` also silently declines MCP user input inside Codex. Allow only
    // that interaction category, keeping ordinary execution approvals disabled.
    let mut params = json!({"approvalPolicy":{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":false,"request_permissions":false,"mcp_elicitations":true}},"sandbox":"danger-full-access","ephemeral":true,"dynamicTools":[plan_tool(), super::visualize::codex_tool(), super::questions::codex_tool()]});
    if !request.agent.model.is_empty() {
        params["model"] = json!(request.agent.model);
    }
    if let Some(session) = &request.native_session {
        params["ephemeral"] = json!(false);
        if session.resumed {
            params.as_object_mut().unwrap().remove("ephemeral");
            params.as_object_mut().unwrap().remove("dynamicTools");
            params["threadId"] = json!(session.transfer_id().unwrap_or(session.id()));
            params["excludeTurns"] = json!(true);
        }
    }
    params
}
fn thread_method(request: &RunRequest) -> &'static str {
    match request.native_session.as_ref() {
        Some(s) if s.transfer_path.is_some() => "thread/fork",
        Some(s) if s.resumed => "thread/resume",
        _ => "thread/start",
    }
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
    let mut params = json!({"threadId":thread,"input":[],"summary":"auto"});
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
    // Historical references remain portable metadata, never repeated invocations.
    if !current.native_session.as_ref().is_some_and(|s| s.retry) {
        if let Some(message) = request.messages.last() {
            for mention in &message.mentions {
                input.push(json!({"type":"mention","name":mention.name,"path":mention.path}));
            }
        }
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
    if !request.compact {
        if let Some(schema) = &request.agent.output_schema {
            // RunRequest::validate checked syntax and bounds before process launch.
            params["outputSchema"] = serde_json::from_str(schema).expect("validated output schema");
        }
    }
    if !request.agent.model.is_empty() {
        params["collaborationMode"] = json!({"mode":if request.agent.plan_mode {"plan"} else {"default"},
            "settings":{"model":request.agent.model,"reasoning_effort":if request.agent.reasoning.is_empty() {Value::Null} else {json!(request.agent.reasoning)},"developer_instructions":null}});
    }
    params
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Init,
    Config,
    Models,
    Thread,
    Turn,
    Interrupt,
    Steer,
}

async fn send(
    process: &mut Process,
    pending: &mut HashMap<u64, Kind>,
    kind: Kind,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let id = process.next_id;
    process.next_id += 1;
    pending.insert(id, kind);
    process
        .stdin
        .write_all(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
        .await
        .map_err(|_| "Could not send the Codex request".into())
}

async fn start_turn(
    process: &mut Process,
    pending: &mut HashMap<u64, Kind>,
    request: &RunRequest,
    thread: &str,
) -> Result<(), String> {
    if request.compact {
        send(
            process,
            pending,
            Kind::Turn,
            "thread/compact/start",
            json!({"threadId":thread}),
        )
        .await
    } else {
        let mut effective = request.clone();
        if effective.agent.model.is_empty() {
            effective.agent.model = process.reported_model.clone().unwrap_or_default();
        }
        if effective.agent.plan_mode && effective.agent.model.is_empty() {
            return Err("Codex did not report the model needed to enter plan mode. Select a model and try again.".into());
        }
        send(
            process,
            pending,
            Kind::Turn,
            "turn/start",
            turn_params(&effective, thread),
        )
        .await
    }
}

pub async fn run(
    process: &mut Process,
    request: &RunRequest,
    channel: Option<&EventSink>,
    cancel: CancellationToken,
    questions: &mut super::questions::Session,
    config_cwd: Option<&str>,
    reused: bool,
) -> Result<(String, String), String> {
    let mut effective = request.clone();
    let resolve_defaults = !reused
        && effective.native_session.as_ref().is_some_and(|s| s.resumed)
        && (effective.agent.model.is_empty() || effective.agent.reasoning.is_empty());
    let request = &mut effective;
    let mut model_pages = 0;
    let mut pending: HashMap<u64, Kind> = HashMap::new();
    let mut steering = HashMap::new();
    let mut decoder = Decoder::default();
    let mut startup_hooks = Vec::new();
    decoder.compactions.manual = request.compact;
    let mut thread = String::new();
    let mut turn = String::new();
    if reused {
        // The thread is already loaded; only this reply's turn is new.
        thread = process.thread.clone();
        decoder.reported_model(process.reported_model.as_deref());
        if let Some(session) = &request.native_session {
            session.bind(&thread, false)?;
        }
        start_turn(process, &mut pending, request, &thread).await?;
    } else {
        send(process, &mut pending, Kind::Init, "initialize", json!({"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await.map_err(|_| "Could not initialize Codex")?;
    }
    // Bound startup and cancellation only; an active turn may run or wait for
    // the user for as long as needed.
    let initialization_deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(initialization_deadline);
    let cancellation_deadline = tokio::time::sleep(INTERRUPT_GRACE);
    tokio::pin!(cancellation_deadline);
    let mut cancelling = false;
    let mut last_usage = crate::protocol::TokenUsage {
        scope: Some("reply".into()),
        ..Default::default()
    };
    let mut visualizer = super::visualize::Visualizer::default();
    let output_limit = request.output_line_limit();
    let mut tool_tick = tokio::time::interval(Duration::from_secs(1));
    tool_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = tool_tick.tick() => {
                for event in decoder.tool_tick() {
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
            }
            _ = cancel.cancelled(), if !cancelling => {
                questions.close();
                questions.elicitation.close();
                questions.steering.ready(false);
                if thread.is_empty() || turn.is_empty() {
                    process.healthy = false;
                    return Ok(("cancelled".into(), decoder.text));
                }
                cancelling = true;
                if send(process, &mut pending, Kind::Interrupt, "turn/interrupt", json!({"threadId":thread,"turnId":turn})).await.is_err() {
                    process.healthy = false;
                    return Ok(("cancelled".into(), decoder.text));
                }
                cancellation_deadline.as_mut().reset(tokio::time::Instant::now() + INTERRUPT_GRACE);
            },
            _ = &mut initialization_deadline, if !cancelling && turn.is_empty() => {
                process.healthy = false;
                return Err("Codex did not initialize the conversation within two minutes. Check its CLI and configured integrations.".into());
            }
            _ = &mut cancellation_deadline, if cancelling => {
                // The interrupt was never confirmed; the process state is unknown.
                process.healthy = false;
                return Ok(("cancelled".into(), decoder.text));
            }
            Some(delivery) = questions.rx.recv(), if !cancelling => {
                let live = questions.can_deliver(&delivery);
                let result = if live { process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send answers to Codex.".to_string()) } else { Err("This request is no longer waiting.".into()) };
                let failed = live && result.is_err();
                questions.delivered(delivery, result);
                if failed { process.healthy = false; return Err("Could not send answers to Codex.".into()); }
            },
            Some(delivery) = questions.elicitation.rx.recv(), if !cancelling => {
                let result = if questions.elicitation.can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send MCP input to Codex.".to_string())
                } else { Err("This MCP request is no longer waiting.".into()) };
                questions.elicitation.delivered(delivery, result);
            },
            Some(delivery) = questions.steering.rx.recv(), if !cancelling => {
                let id = process.next_id;
                let result = send(process, &mut pending, Kind::Steer, "turn/steer", json!({
                    "threadId":thread, "expectedTurnId":turn,
                    "input":[{"type":"text","text":delivery.input.text,"text_elements":[]}]
                })).await;
                if result.is_ok() { steering.insert(id, delivery); }
                else { questions.steering.delivered(delivery, result); process.healthy = false; return Err("Could not send steering to Codex.".into()); }
            },
            line = process.lines.recv() => {
                let Some(line) = line else { process.healthy = false; return Err("Codex exited before confirming the reply. Check its login and CLI version.".into()); };
                let Line::Out(line) = line else { continue; };
                if line.len() > output_limit { process.healthy = false; return Err("Provider output exceeded the message limit".into()); }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                if value["method"] == "skills/changed" && value.get("id").is_none() {
                    if let Some(channel) = channel { let _ = channel.send(crate::protocol::RunEvent::SkillsChanged); }
                    continue;
                }
                if let Some(id) = value["id"].as_u64().filter(|_| value.get("method").is_none()) {
                    let Some(kind) = pending.remove(&id) else { continue; };
                    if kind == Kind::Steer {
                        if let Some(delivery) = steering.remove(&id) {
                            let result = if value["result"]["turnId"] == turn && value.get("error").is_none() { Ok(()) }
                            else { Err("Codex did not accept steering for this reply. It may have ended, or this CLI version may not support steering.".into()) };
                            questions.steering.delivered(delivery, result);
                        }
                        continue;
                    }
                    if kind == Kind::Interrupt { continue; }
                    if value["error"].is_object() {
                        process.healthy = false;
                        return Err(if kind == Kind::Thread && request.native_session.as_ref().is_some_and(|s| s.resumed) {
                            "Codex could not resume this conversation's native session. Its saved history was preserved. Check the selected CLI profile, or start a new conversation; no message was replayed."
                        } else if kind == Kind::Turn && request.agent.output_schema.is_some() && !request.compact {
                            "Codex could not start this structured reply. Check the output schema, model access, and CLI version, or disable structured output."
                        } else { "Codex could not start this reply. Check its login, model access, and CLI version." }.into());
                    }
                    match kind {
                        Kind::Init => {
                            process.stdin.write_all(b"{\"method\":\"initialized\"}\n").await.map_err(|_| "Codex initialization failed")?;
                            let runtime = crate::plugins::for_run(request);
                            if !runtime.skill_roots.is_empty() {
                                crate::plugins::rpc(process, "skills/extraRoots/set", json!({"extraRoots":runtime.skill_roots})).await?;
                            }
                            if resolve_defaults {
                                send(process, &mut pending, Kind::Config, "config/read", json!({"includeLayers":false,"cwd":config_cwd})).await?;
                            } else {
                                let method = thread_method(request);
                                send(process, &mut pending, Kind::Thread, method, start_params(request)).await?;
                            }
                        }
                        Kind::Config => {
                            super::defaults::codex_config(request, &value["result"]["config"]);
                            if request.agent.model.is_empty() || request.agent.reasoning.is_empty() {
                                send(process, &mut pending, Kind::Models, "model/list", json!({"limit":100,"includeHidden":true})).await?;
                            } else {
                                send(process, &mut pending, Kind::Thread, thread_method(request), start_params(request)).await?;
                            }
                        }
                        Kind::Models => {
                            model_pages += 1;
                            if super::defaults::codex_models(request, value["result"]["data"].as_array().ok_or("Codex did not report model defaults")?) {
                                send(process, &mut pending, Kind::Thread, thread_method(request), start_params(request)).await?;
                            } else if let Some(cursor) = value["result"]["nextCursor"].as_str().filter(|_| model_pages < 10) {
                                send(process, &mut pending, Kind::Models, "model/list", json!({"limit":100,"includeHidden":true,"cursor":cursor})).await?;
                            } else {
                                process.healthy = false;
                                return Err("Codex could not resolve current model defaults. Select an explicit model and reasoning level to continue.".into());
                            }
                        }
                        Kind::Thread => {
                            decoder.reported_model(value["result"]["model"].as_str());
                            process.reported_model = value["result"]["model"].as_str().map(String::from);
                            thread = value["result"]["thread"]["id"].as_str().ok_or("Codex did not return a thread identity")?.into();
                            process.thread = thread.clone();
                            // The binding records the CLI-named thread; reuse must match it.
                            process.session_id = thread.clone();
                            if let Some(session) = &request.native_session { session.bind(&thread, false)?; }
                            for hook in startup_hooks.drain(..) {
                                for event in decoder.decode_codex_server(&hook, &thread) {
                                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                                }
                            }
                            start_turn(process, &mut pending, request, &thread).await?;
                        }
                        Kind::Turn => {
                            if let Some(id) = value["result"]["turn"]["id"].as_str() { turn = id.into(); }
                            if let Some(session) = &request.native_session { session.bind(&thread, true)?; }
                            questions.steering.ready(!request.compact && !turn.is_empty() && !cancelling);
                        }
                        Kind::Interrupt | Kind::Steer => {}
                    }
                    continue;
                }
                if value.get("id").is_some() && value["method"].is_string() {
                    if let Some(response) = questions.elicitation.codex(&value, &thread, &turn, !cancelling && !request.compact) {
                        if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to MCP input")?; }
                        continue;
                    }
                    if let Some(response) = questions.codex(&value, &thread) {
                        if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to the Codex question")?; }
                        continue;
                    }
                    if let Some((response, event)) = visualizer.codex_response(&value, &thread) {
                        if let (Some(channel), Some(event)) = (channel, event) { if channel.send(event).is_err() { cancel.cancel(); } }
                        process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not confirm the Codex visualization")?;
                        continue;
                    }
                    if let Some((response, events)) = plan_response(&value, &thread, &mut decoder) {
                        for event in events { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                        process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not confirm the Codex plan")?;
                        continue;
                    }
                    // Full-access runs do not need approvals. Unsupported interactions
                    // fail explicitly instead of hanging or handling account secrets.
                    let response = json!({"id":value["id"],"error":{"code":-32601,"message":"This interaction is unavailable in Agent Studio. Ask the user in your text reply."}});
                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| "Could not respond to the Codex tool")?;
                    continue;
                }
                if thread.is_empty() {
                    if startup_hooks.len() < 400 {
                        if let Some(hook) = crate::protocol::hooks::startup_hook(&value) { startup_hooks.push(hook); }
                    }
                    continue;
                }
                if value["method"] == "turn/started" && value["params"]["threadId"] == thread {
                    turn = value["params"]["turn"]["id"].as_str().unwrap_or_default().into();
                }
                questions.resolved_codex(&value, &thread);
                questions.elicitation.observe(&value, Some(&thread));
                if value["params"]["threadId"] == thread
                    && value["method"].as_str().is_some_and(|m| m.starts_with("item/"))
                    && value["params"]["turnId"].as_str().is_some_and(|id| turn.is_empty() || id != turn) { continue; }
                if crate::protocol::hooks::is_codex_hook(&value) && value["params"]["threadId"] == thread
                    && !turn.is_empty() && value["params"]["turnId"].as_str().is_some_and(|id| id != turn) { continue; }
                let compaction = value["method"] == "thread/compacted" || value["params"]["item"]["type"] == "contextCompaction";
                if compaction && value["params"]["turnId"].as_str().is_some_and(|id| id != turn) { continue; }
                if value["method"] == "thread/tokenUsage/updated" && value["params"]["turnId"].as_str().is_some_and(|id| id != turn) { continue; }
                let reasoning = value["method"].as_str().is_some_and(|method| method.starts_with("item/reasoning/")) || value["params"]["item"]["type"] == "reasoning";
                if reasoning && value["params"]["turnId"].as_str().is_some_and(|id| id != turn) { continue; }
                let proposed_plan = value["method"] == "item/plan/delta" || value["params"]["item"]["type"] == "plan";
                if proposed_plan && (turn.is_empty() || value["params"]["turnId"] != turn) { continue; }
                for mut event in decoder.decode_codex_server(&value, &thread) {
                    if let crate::protocol::RunEvent::Compaction { compaction } = &event {
                        if compaction.status == "complete" { last_usage.context_input = None; }
                    }
                    if request.compact {
                        if let crate::protocol::RunEvent::Usage { usage } = &mut event { usage.context_input = None; }
                    }
                    if let crate::protocol::RunEvent::Usage { usage } = &event { last_usage = usage.clone(); }
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
                if value["method"] == "turn/completed" && value["params"]["threadId"] == thread {
                    if value["params"]["turn"]["id"] != turn { continue; }
                    questions.close();
                    questions.elicitation.close();
                    questions.steering.ready(false);
                    // Never leave unacknowledged input running invisibly in a parked process.
                    if !steering.is_empty() { process.healthy = false; }
                    let status = value["params"]["turn"]["status"].as_str().unwrap_or_default();
                    // An interrupted turn leaves the thread loaded for the next reply.
                    if status == "interrupted" { return Ok(("cancelled".into(), decoder.text)); }
                    if status != "completed" { process.healthy = false; return Err("Codex could not complete the reply. Check its login, model access, and connection.".into()); }
                    if request.compact {
                        if !decoder.compactions.completed() { process.healthy = false; return Err("Codex ended without confirming compaction. The conversation was preserved.".into()); }
                        if let Some(channel) = channel { let _ = channel.send(crate::protocol::RunEvent::Text { text: "Context compacted.".into() }); }
                        return Ok(("complete".into(), "Context compacted.".into()));
                    }
                    if decoder.text.trim().is_empty() && !visualizer.has_visuals() && !decoder.proposed_plans.completed() { process.healthy = false; return Err("The CLI finished without a text response. Check Connections or try another model.".into()); }
                    if request.agent.output_schema.is_some() {
                        let value = serde_json::from_str(&decoder.text).unwrap_or(Value::Null);
                        decoder.text = crate::structured_output::result(&value)?;
                        if let Some(channel) = channel { let _ = channel.send(crate::protocol::RunEvent::Text { text: decoder.text.clone() }); }
                    }
                    // The billing route may only be available while this exact thread is loaded.
                    // Optional read failure must never turn a successful reply into an error.
                    let usage_id = process.next_id;
                    process.next_id += 1;
                    let estimate = async {
                        process.stdin.write_all(format!("{}\n", json!({"id":usage_id,"method":"account/usage/read","params":{"threadId":thread}})).as_bytes()).await.ok()?;
                        while let Some(line) = process.lines.recv().await {
                            let Line::Out(line) = line else { continue; };
                            if line.len() > 2_000_000 { return None; }
                            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue; };
                            if v["id"] == usage_id {
                                let usage = &v["result"]["threadUsage"];
                                return (usage["threadId"] == thread).then(|| usage.clone());
                            }
                        }
                        None
                    };
                    let reading = tokio::select! {
                        _ = cancel.cancelled() => None,
                        result = tokio::time::timeout(Duration::from_secs(5), estimate) => result.ok().flatten(),
                    };
                    if let Some(reading) = reading {
                        last_usage.session_credits = crate::spend::micros(&reading["estimatedUsageCreditsMicros"]);
                        last_usage.session_cost_usd = crate::spend::micros(&reading["estimatedUsageUsdMicros"]);
                        if let Some(channel) = channel { let _ = channel.send(crate::protocol::RunEvent::Usage { usage: last_usage }); }
                    }
                    return Ok(("complete".into(), decoder.text));
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "codex_deadline_tests.rs"]
mod deadline_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structured_output_is_a_turn_parameter_and_clears_when_disabled() {
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":"","outputSchema":"{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"string\"}},\"required\":[\"answer\"],\"additionalProperties\":false}"},"messages":[{"role":"user","text":"Answer"}]})).unwrap();
        request.validate().unwrap();
        let schema: Value =
            serde_json::from_str(request.agent.output_schema.as_ref().unwrap()).unwrap();
        assert_eq!(turn_params(&request, "root")["outputSchema"], schema);
        assert!(start_params(&request).get("outputSchema").is_none());
        request.compact = true;
        assert!(turn_params(&request, "root").get("outputSchema").is_none());
        request.compact = false;
        request.agent.output_schema = None;
        assert!(turn_params(&request, "root").get("outputSchema").is_none());
    }
    #[test]
    fn proposed_plan_mode_uses_native_collaboration_and_build_resets_it() {
        let mut request:RunRequest=serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","reasoning":"low","instructions":"","planMode":true},"messages":[{"role":"user","text":"Plan"}]})).unwrap();
        let params = turn_params(&request, "thread");
        assert_eq!(
            params["collaborationMode"],
            json!({"mode":"plan","settings":{"model":"fixture","reasoning_effort":"low","developer_instructions":null}})
        );
        assert_eq!(start_params(&request)["sandbox"], "danger-full-access");
        request.agent.plan_mode = false;
        assert_eq!(
            turn_params(&request, "thread")["collaborationMode"]["mode"],
            "default"
        );
        let mut d = Decoder::default();
        assert!(d.decode_codex_server(&json!({"method":"item/plan/delta","params":{"threadId":"child","itemId":"p","delta":"Foreign"}}),"thread").is_empty());
        assert!(!d.proposed_plans.completed());
    }
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
        assert_eq!(turn["summary"], "auto");
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
    fn mentions_are_current_turn_inputs_and_never_replayed_from_history() {
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","instructions":""},"messages":[
            {"role":"user","text":"$old","mentions":[{"kind":"app","name":"Old","path":"app://old","token":"$old"}]},
            {"role":"assistant","text":"Done"},
            {"role":"user","text":"Read @src/file.ts with $demo","mentions":[{"kind":"file","name":"src/file.ts","path":"/project/src/file.ts","token":"@src/file.ts"},{"kind":"app","name":"Demo","path":"app://demo","token":"$demo"}]}
        ]})).unwrap();
        assert!(request.validate().is_ok());
        let params = turn_params(&request, "thread");
        assert_eq!(params["input"].as_array().unwrap().len(), 3);
        assert_eq!(
            params["input"][1],
            json!({"type":"mention","name":"src/file.ts","path":"/project/src/file.ts"})
        );
        assert_eq!(
            params["input"][2],
            json!({"type":"mention","name":"Demo","path":"app://demo"})
        );
        request.messages.last_mut().unwrap().mentions.clear();
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
            json!({"approvalPolicy":{"granular":{"sandbox_approval":false,"rules":false,"skill_approval":false,"request_permissions":false,"mcp_elicitations":true}},"sandbox":"danger-full-access","ephemeral":true,"model":"fixture-model","dynamicTools":[plan_tool(), super::super::visualize::codex_tool(), super::super::questions::codex_tool()]})
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
