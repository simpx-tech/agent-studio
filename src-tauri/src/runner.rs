use crate::{
    protocol::{Decoder, RunEvent},
    providers::{chat_command, RunRequest},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Runs(pub Mutex<HashMap<String, CancellationToken>>, AtomicU64);
impl Runs {
    // A reloaded document cannot receive the old run's IPC or answer its questions.
    // Leave entries registered until the owned process tree has actually stopped.
    pub fn interrupt_for_reload(&self) {
        if let Ok(active) = self.0.lock() {
            self.1.fetch_add(1, Ordering::SeqCst);
            for cancel in active.values() {
                cancel.cancel();
            }
        }
    }

    pub async fn begin(&self, id: &str, cancel: CancellationToken) -> Result<(), String> {
        let generation = self.1.load(Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            {
                let mut active = self.0.lock().map_err(|_| "Run registry lock failed")?;
                if generation != self.1.load(Ordering::SeqCst) {
                    return Err("This response was interrupted when the app reloaded. Retry from the current window.".into());
                }
                if active.is_empty() {
                    active.insert(id.into(), cancel);
                    return Ok(());
                }
                if active.values().any(|token| !token.is_cancelled()) {
                    return Err(
                        "Another response is still running. Stop it or wait for it to finish."
                            .into(),
                    );
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "The previous response is still stopping. Try again in a moment.".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
#[derive(Clone)]
pub struct EventSink(Arc<dyn Fn(RunEvent) -> Result<(), String> + Send + Sync>);
impl EventSink {
    pub fn new(f: impl Fn(RunEvent) -> Result<(), String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }
    pub fn send(&self, event: RunEvent) -> Result<(), String> {
        (self.0)(event)
    }
}
pub async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let mut kill = tokio::process::Command::new("taskkill.exe");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000);
            let _ = kill.output().await;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.kill().await;
    }
    let _ = child.wait().await;
}
fn chat_timeout(provider: &str) -> Option<Duration> {
    match provider {
        "claude" | "codex" => None,
        _ => Some(Duration::from_secs(300)),
    }
}

async fn response_deadline(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => std::future::pending().await,
    }
}

pub async fn run(
    app: tauri::AppHandle,
    request: RunRequest,
    channel: Channel<RunEvent>,
    cancel: CancellationToken,
    connection_id: Option<String>,
) -> Result<String, String> {
    let usage_revision = AtomicU64::new(0);
    let output = EventSink::new(move |mut event| {
        if let RunEvent::Compaction { compaction } = &mut event {
            compaction.usage_revision = usage_revision.load(Ordering::Relaxed);
        }
        if let RunEvent::Usage { usage } = &mut event {
            usage.revision = Some(usage_revision.fetch_add(1, Ordering::Relaxed) + 1);
        }
        channel.send(event).map_err(|e| e.to_string())
    });
    let questions = app.state::<crate::providers::questions::Questions>().open(
        &request.run_id,
        connection_id,
        output.clone(),
    )?;
    let timeout = chat_timeout(&request.agent.provider);
    let tracking = matches!(request.agent.provider.as_str(), "claude" | "codex")
        && request.conversation_id.is_some();
    let mut observation = crate::spend::Observation {
        version: 1,
        revision: 1,
        run_id: request.run_id.clone(),
        before: None,
        after: None,
        run_duration_ms: None,
    };
    let provider = request.agent.provider.clone();
    let model = request.agent.model.clone();
    if tracking {
        observation.before = crate::usage::read_cancellable(
            app.clone(),
            &app.state::<crate::usage::UsageState>(),
            &provider,
            &model,
            true,
            cancel.clone(),
        )
        .await
        .ok()
        .map(Into::into);
        let _ = output.send(RunEvent::AccountUsage {
            account_usage: observation.clone(),
        });
    }
    let run_started = std::time::Instant::now();
    let result = execute(
        app.clone(),
        request,
        Some(output.clone()),
        cancel.clone(),
        timeout,
        "chat-runtime",
        Some(questions),
    )
    .await
    .map(|(status, _)| status);
    if tracking {
        observation.run_duration_ms =
            Some(run_started.elapsed().as_millis().min(9_007_199_254_740_991) as u64);
        if !cancel.is_cancelled() {
            observation.after = crate::usage::read_cancellable(
                app.clone(),
                &app.state::<crate::usage::UsageState>(),
                &provider,
                &model,
                true,
                cancel,
            )
            .await
            .ok()
            .map(Into::into);
        }
        observation.revision = 2;
        let _ = output.send(RunEvent::AccountUsage {
            account_usage: observation,
        });
    }
    result
}
pub async fn title_text(
    app: tauri::AppHandle,
    request: RunRequest,
    cancel: CancellationToken,
) -> Result<String, String> {
    let (status, text) = execute(
        app,
        request,
        None,
        cancel,
        Some(Duration::from_secs(30)),
        "title-runtime",
        None,
    )
    .await?;
    if status == "complete" {
        Ok(text)
    } else {
        Err("Title generation cancelled".into())
    }
}
pub(crate) async fn execute(
    app: tauri::AppHandle,
    mut request: RunRequest,
    channel: Option<EventSink>,
    cancel: CancellationToken,
    timeout: Option<Duration>,
    directory: &str,
    mut questions: Option<crate::providers::questions::Session>,
) -> Result<(String, String), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the app data directory")?
        .join(directory);
    std::fs::create_dir_all(&root)
        .map_err(|_| "Cannot create the conversation runtime directory")?;
    let exe = crate::providers::resolve(&request.agent.provider).await?;
    request.native_session =
        crate::providers::sessions::Session::prepare(root.parent().unwrap(), &request)?;
    if request.agent.provider == "gemini" {
        let login = crate::providers::require_gemini_login(&exe, &cancel).await;
        if !cancel.is_cancelled() {
            login?;
        }
    }
    if cancel.is_cancelled() {
        return Ok(("cancelled".into(), String::new()));
    }
    let pool = app.state::<crate::pool::Pool>();
    // Only conversation-bound Claude/Codex chats keep their process between replies.
    let parkable = request.native_session.is_some();
    let fingerprint = if parkable {
        crate::pool::fingerprint(&request, &exe)?
    } else {
        String::new()
    };
    let mut reused = None;
    if let Some(conversation) = request.conversation_id.as_deref().filter(|_| parkable) {
        if let Some(mut parked) = pool.take(conversation) {
            let session = request.native_session.as_ref().expect("parkable session");
            if parked.serves(&fingerprint, session) {
                parked.claim();
                reused = Some(parked);
            } else {
                // Changed launch identity or session: start over. Claude model and
                // thinking budgets are acknowledged in-band before the next prompt.
                parked.kill().await;
            }
        }
    }
    let mut config_cwd = None;
    let mut process = match reused {
        Some(process) => process,
        None => {
            let mut command = tokio::select! {
                command = chat_command(&request, &root, &exe) => command?,
                _ = cancel.cancelled() => return Ok(("cancelled".into(), String::new())),
            };
            if request.agent.provider == "claude"
                && request.agent.model.is_empty()
                && request.native_session.as_ref().is_some_and(|s| s.resumed)
            {
                let model = crate::providers::defaults::claude_model(
                    &exe,
                    &request,
                    command.as_std().get_current_dir().unwrap_or(&root),
                    &cancel,
                )
                .await;
                if cancel.is_cancelled() {
                    return Ok(("cancelled".into(), String::new()));
                }
                command.args(["--model", &model?]);
            }
            if let Some(session) = request.native_session.as_ref().filter(|s| !s.resumed) {
                if let Some(channel) = &channel {
                    if session.switched_account {
                        let _ = channel.send(RunEvent::Progress { id: "studio-account-switch".into(), revision: 1, text: "Switched to another account. This reply starts a new native session for the selected account from this chat's saved messages; the previous account's native tool history is not transferred.".into() });
                    } else if request.messages.len() > 1 {
                        let _ = channel.send(RunEvent::Progress { id: "studio-session-bootstrap".into(), revision: 1, text: "Continuing this older chat from its saved messages. Native session history is retained from this reply onward; earlier unrecorded tool details are unavailable.".into() });
                    }
                }
            }
            config_cwd = if exe.wsl.is_some() {
                request
                    .location
                    .as_ref()
                    .map(|location| location.path.clone())
            } else {
                command
                    .as_std()
                    .get_current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
            };
            let child = command
                .spawn()
                .map_err(|_| "Could not launch the provider CLI. Check Connections.")?;
            let session_id = request
                .native_session
                .as_ref()
                .map(|s| s.id().to_string())
                .unwrap_or_default();
            crate::pool::Process::new_observed(
                exe.clone(),
                child,
                fingerprint,
                session_id,
                channel
                    .as_ref()
                    .and_then(|_| crate::live_usage::observer(&app, &request.agent.provider)),
            )?
        }
    };
    let reused = process.turns > 0;
    if reused
        && request.agent.provider == "claude"
        && request.agent.model.trim().is_empty()
        && process
            .claude_settings
            .as_ref()
            .is_none_or(|s| !s.uses_default_model())
    {
        // Query the selected profile/folder without a model turn, then update the
        // existing chat process. Never infer that an acknowledged null reset worked.
        let default = async {
            let command = chat_command(&request, &root, &exe).await?;
            crate::providers::defaults::claude_model(
                &exe,
                &request,
                command.as_std().get_current_dir().unwrap_or(&root),
                &cancel,
            )
            .await
        };
        // The reader handles cancellation and releases its owned process tree.
        let result = default.await;
        match result {
            Ok(model) => request.claude_default_model = Some(model),
            Err(error) => {
                process.kill().await;
                return if cancel.is_cancelled() {
                    Ok(("cancelled".into(), String::new()))
                } else {
                    Err(error)
                };
            }
        }
    }
    if matches!(request.agent.provider.as_str(), "codex" | "claude") {
        if let Some(channel) = &channel {
            let _ = channel.send(RunEvent::FileChanges {
                file_changes: crate::protocol::file_changes::Snapshot::empty(),
            });
        }
    }
    let result = if request.uses_codex_server() {
        crate::providers::codex_chat::run(
            &mut process,
            &request,
            channel.as_ref(),
            cancel,
            questions
                .as_mut()
                .ok_or("Question channel is unavailable")?,
            config_cwd.as_deref(),
            reused,
        )
        .await
    } else {
        stream_turn(
            &mut process,
            &request,
            channel.as_ref(),
            cancel,
            timeout,
            questions.as_mut(),
            reused,
        )
        .await
    };
    process.turns += 1;
    // A finished or cleanly interrupted turn leaves the CLI waiting for the next reply.
    let park = parkable
        && process.healthy
        && matches!(&result, Ok((status, _)) if status == "complete" || status == "cancelled")
        && process.alive();
    if park {
        pool.park(request.conversation_id.as_deref().unwrap(), process)
            .await;
    } else {
        process.kill().await;
    }
    result
}
/// One reply over a stream-json process: Claude chats (persistent), Claude background
/// queries, and Antigravity (one prompt, then input closes).
async fn stream_turn(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    channel: Option<&EventSink>,
    cancel: CancellationToken,
    timeout: Option<Duration>,
    mut questions: Option<&mut crate::providers::questions::Session>,
    reused: bool,
) -> Result<(String, String), String> {
    use crate::pool::Line;
    if cancel.is_cancelled() {
        process.healthy = false;
        return Ok(("cancelled".into(), String::new()));
    }
    let claude_visualizer = request.uses_claude_visualizer();
    let persistent = claude_visualizer && request.native_session.is_some();
    let prompt = request.stdin_payload();
    let mut stdin_open = true;
    let mut initialized = reused;
    let mut prompt_sent = false;
    let mut settings = crate::providers::claude_settings::Update::new(
        &request.agent,
        process.claude_settings.as_ref(),
        reused,
        request.claude_default_model.as_deref(),
    )?;
    let settings_deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(settings_deadline);
    let send_failed = "Could not send input to the provider CLI.";
    if !claude_visualizer {
        // Background and text-only runs send one prompt and close their input.
        process
            .stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|_| send_failed)?;
        prompt_sent = true;
        stdin_open = false;
        process.stdin.shutdown().await.map_err(|_| send_failed)?;
    } else if reused {
        if let Some(session) = &request.native_session {
            session.bind(session.id(), false)?;
        }
        prompt_sent = settings.advance(process, &prompt).await?;
    } else {
        process.stdin.write_all(b"{\"type\":\"control_request\",\"request_id\":\"studio-init\",\"request\":{\"subtype\":\"initialize\",\"hooks\":null}}\n").await.map_err(|_| send_failed)?;
    }
    let mut decoder = Decoder::default();
    decoder.expect_structured_output = request.agent.output_schema.is_some() && !request.compact;
    let mut tool_tick = tokio::time::interval(Duration::from_secs(1));
    tool_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    decoder.compactions.manual = request.compact;
    let mut visualizer = crate::providers::visualize::Visualizer::default();
    let mut input_lifetime = crate::providers::visualize::ClaudeInputLifetime::with_context(
        request.native_session.is_none() || request.native_context().is_some(),
    );
    let mut session_received = false;
    let initialization_deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(initialization_deadline);
    let interrupt_deadline = tokio::time::sleep(crate::pool::INTERRUPT_GRACE);
    tokio::pin!(interrupt_deadline);
    let mut interrupting = false;
    let mut steering: HashMap<String, crate::providers::steering::Delivery> = HashMap::new();
    let output_limit = request.output_line_limit();
    let mut diagnostics = String::new();
    let deadline = response_deadline(timeout);
    tokio::pin!(deadline);
    loop {
        let (answer_rx, steering_rx, elicitation_rx) = match questions.as_mut() {
            Some(q) => (
                Some(&mut q.rx),
                Some(&mut q.steering.rx),
                Some(&mut q.elicitation.rx),
            ),
            None => (None, None, None),
        };
        tokio::select! {
            biased;
            _ = tool_tick.tick() => {
                for event in decoder.tool_tick() {
                    if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } }
                }
            }
            _ = cancel.cancelled(), if !interrupting => {
                if let Some(q) = &questions { q.close(); }
                if let Some(q) = &questions { q.elicitation.close(); }
                if let Some(q) = &questions { q.steering.ready(false); }
                if persistent && prompt_sent && stdin_open {
                    // Ask the CLI to end this turn in-band so it stays usable for the next reply.
                    let interrupt = format!("{{\"type\":\"control_request\",\"request_id\":\"studio-interrupt-{}\",\"request\":{{\"subtype\":\"interrupt\"}}}}\n", process.turns + 1);
                    if process.stdin.write_all(interrupt.as_bytes()).await.is_ok() {
                        interrupting = true;
                        interrupt_deadline.as_mut().reset(tokio::time::Instant::now() + crate::pool::INTERRUPT_GRACE);
                        continue;
                    }
                }
                process.healthy = false;
                process.kill().await;
                break Ok(("cancelled".to_string(), decoder.text));
            }
            _ = &mut interrupt_deadline, if interrupting => {
                process.healthy = false;
                process.kill().await;
                break Ok(("cancelled".to_string(), decoder.text));
            }
            _ = &mut initialization_deadline, if claude_visualizer && !initialized => { process.healthy = false; break Err("Claude did not initialize conversation tools within two minutes. Check its CLI and configured integrations.".into()); }
            _ = &mut settings_deadline, if claude_visualizer && initialized && !prompt_sent => { process.healthy = false; break Err("Claude did not acknowledge the next-reply settings within 30 seconds. No message was sent. Retry to resume with a fresh process.".into()); }
            _ = &mut deadline => { process.healthy = false; break Err(if channel.is_some() { format!("The provider did not finish within {} minutes. The owned run was stopped.", timeout.expect("bounded deadline").as_secs() / 60) } else { "Title generation timed out".into() }); }
            Some(delivery) = async { match answer_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let result = if stdin_open && questions.as_ref().unwrap().can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send answers to Claude.".to_string())
                } else {
                    Err("Claude is no longer waiting for answers.".into())
                };
                // Until a native mode status confirms the transition, this
                // process cannot be reused under its old permission identity.
                if result.is_ok() && delivery.payload["response"]["response"]["updatedPermissions"].is_array() {
                    process.fingerprint.clear();
                }
                questions.as_ref().unwrap().delivered(delivery, result);
            },
            Some(delivery) = async { match steering_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let payload = serde_json::json!({"type":"user","uuid":delivery.input.id,"origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":delivery.input.text}]}});
                if process.stdin.write_all(format!("{payload}\n").as_bytes()).await.is_err() {
                    questions.as_ref().unwrap().steering.delivered(delivery, Err("Could not send steering to Claude.".into()));
                    process.healthy = false; break Err(send_failed.into());
                }
                steering.insert(delivery.input.id.clone(), delivery);
            },
            Some(delivery) = async { match elicitation_rx { Some(rx) => rx.recv().await, None => std::future::pending().await } }, if !interrupting => {
                let q = &questions.as_ref().unwrap().elicitation;
                let result = if stdin_open && q.can_deliver(&delivery) {
                    process.stdin.write_all(format!("{}\n", delivery.payload).as_bytes()).await.map_err(|_| "Could not send MCP input to Claude.".to_string())
                } else { Err("This MCP request is no longer waiting.".into()) };
                q.delivered(delivery, result);
            },
            line = process.lines.recv() => match line {
                Some(Line::Err(line)) => {
                    if request.agent.provider == "gemini" && line.trim().to_lowercase().starts_with("authentication required") {
                        process.healthy = false;
                        break Err(provider_error(&line).into());
                    }
                    if diagnostics.len() < 16000 { diagnostics.push_str(&line.chars().take(1000).collect::<String>()); diagnostics.push('\n'); }
                }
                Some(Line::Out(line)) => {
                    if line.len() > output_limit { process.healthy = false; break Err("Provider output exceeded the message limit".into()); }
                    let mut turn_ended = false;
                    if claude_visualizer {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if initialized && !prompt_sent {
                                match settings.acknowledge(&value, &process.session_id) {
                                    Ok(true) => {
                                        prompt_sent = settings.advance(process, &prompt).await?;
                                        continue;
                                    }
                                    Err(error) => { process.healthy = false; break Err(error); }
                                    Ok(false) => {}
                                }
                                // Late prior-turn text/results must not complete this reply
                                // or bind its history before the settings are acknowledged.
                                if value["type"] != "control_request" { continue; }
                                // Only SDK tool discovery is needed between turns. Never
                                // accept an old question or visualization as this reply's work.
                                let discovery = value["request"]["subtype"] == "mcp_message"
                                    && value["request"]["server_name"] == "agent_studio"
                                    && matches!(value["request"]["message"]["method"].as_str(), Some("initialize" | "notifications/initialized" | "ping" | "tools/list"));
                                let response = if discovery { visualizer.claude_response(&value) } else {
                                    serde_json::json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"Unavailable while applying next-reply settings"}})
                                };
                                process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                continue;
                            }
                            if value["type"] == "user" && value["parent_tool_use_id"].is_null() {
                                if let Some(delivery) = value["uuid"].as_str().and_then(|id| steering.remove(id)) {
                                    questions.as_ref().unwrap().steering.delivered(delivery, Ok(()));
                                }
                            }
                            if value["type"] == "system" && value["subtype"] == "init" && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    let result = value["session_id"].as_str().ok_or("Claude did not report a native session identity".to_string()).and_then(|id| session.bind(id, false).map(|()| id.to_string()));
                                    match result { Ok(id) => process.session_id = id, Err(error) => { process.healthy = false; break Err(error); } }
                                }
                            }
                            if !session_received && (value["type"] == "assistant" || (request.compact && value["type"] == "system" && value["subtype"] == "compact_boundary")) && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    if let Err(error) = session.bind(session.id(), true) { process.healthy = false; break Err(error); }
                                    session_received = true;
                                }
                                if let Some(q) = &questions { q.steering.ready(!request.compact && !interrupting); }
                            }
                            if value["type"] == "control_response" && value["response"]["request_id"] == "studio-init" && !initialized {
                                if value["response"]["subtype"] != "success" { process.healthy = false; break Err("Claude could not initialize conversation tools. Check its CLI version.".into()); }
                                initialized = true;
                                settings_deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(30));
                                prompt_sent = settings.advance(process, &prompt).await?;
                                continue;
                            }
                            if let Some(questions) = &mut questions { questions.observe_claude(&value); questions.elicitation.observe(&value, None); }
                            // Track the CLI's actual permission mode in the parked-process
                            // identity. The next reply still applies its explicit mode choice.
                            if value["type"] == "system" && value["parent_tool_use_id"].is_null()
                                && matches!(value["subtype"].as_str(), Some("init" | "status"))
                                && (value["session_id"].is_null() || value["session_id"].as_str() == Some(process.session_id.as_str())) {
                                if let Some(mode) = value["permissionMode"].as_str().filter(|m| matches!(*m,"plan" | "bypassPermissions")) {
                                    let mut effective = request.clone();
                                    effective.agent.plan_mode = mode == "plan";
                                    if effective.native_session.is_some() { process.fingerprint = crate::pool::fingerprint(&effective, &process.exe)?; }
                                }
                            }
                            for event in visualizer.observe_claude(&value) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            if value["type"] == "control_request" {
                                let own_session = value["session_id"].is_null() || value["session_id"].as_str() == Some(process.session_id.as_str());
                                if let Some(response) = questions.as_mut().and_then(|q| q.claude_plan(&value, initialized && prompt_sent && !interrupting && !request.compact && own_session)) {
                                    if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?; }
                                    continue;
                                }
                                if let Some(response) = questions.as_mut().and_then(|q| q.elicitation.claude(&value, initialized && prompt_sent && !interrupting && !request.compact && own_session)) {
                                    if let Some(response) = response { process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?; }
                                    continue;
                                }
                                if let Some(response) = questions.as_mut().and_then(|q| q.claude(&value)) {
                                    if let Some(response) = response { let _ = process.stdin.write_all(format!("{response}\n").as_bytes()).await; }
                                    continue;
                                }
                                if value["request"]["subtype"] == "can_use_tool" {
                                    let response = serde_json::json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"deny","message":"This action requires permission that is unavailable in the current mode. While planning, propose the change and request ExitPlanMode approval before implementation."}}});
                                    process.stdin.write_all(format!("{response}\n").as_bytes()).await.map_err(|_| send_failed)?;
                                    continue;
                                }
                                let response = visualizer.claude_response(&value);
                                let _ = process.stdin.write_all(format!("{response}\n").as_bytes()).await;
                                continue;
                            }
                            let context_result = input_lifetime.is_context_result(&value);
                            turn_ended = input_lifetime.ended(&value);
                            // A zero-turn acknowledgement of injected history is not a reply.
                            if context_result { continue; }
                        }
                    }
                    for event in decoder.decode(&request.agent.provider, &line) { if let Some(channel) = channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                    if channel.is_none() && decoder.text.len() > 4000 { process.healthy = false; break Err("Title response exceeded the limit".into()); }
                    if turn_ended {
                        if let Some(q) = &questions { q.close(); }
                        if let Some(q) = &questions { q.elicitation.close(); }
                        if let Some(q) = &questions { q.steering.ready(false); }
                        if !steering.is_empty() {
                            // A late input can become Claude's next turn. Stop the owned process
                            // before parking to avoid an unobserved follow-up and uncertain billing.
                            process.healthy = false;
                            process.kill().await;
                        }
                        if persistent {
                            if interrupting {
                                // An interrupted turn reports an execution error; the CLI stays usable.
                                break Ok((if decoder.failure.is_some() { "cancelled" } else { "complete" }.to_string(), decoder.text));
                            }
                            if let Some(failure) = decoder.failure.take() {
                                process.healthy = false;
                                break Err(provider_error(&format!("{diagnostics} {failure}")).into());
                            }
                            if request.compact {
                                if !decoder.compactions.completed() { process.healthy = false; break Err("Claude ended without confirming compaction. The conversation was preserved.".into()); }
                                if let Some(channel) = channel { let _ = channel.send(RunEvent::Text { text: "Context compacted.".into() }); }
                                break Ok(("complete".into(), "Context compacted.".into()));
                            }
                            if decoder.text.trim().is_empty() && !visualizer.has_visuals() { process.healthy = false; break Err("The CLI finished without a text response. Check Connections or try another model.".into()); }
                            break Ok(("complete".to_string(), decoder.text));
                        }
                        // Chats without a conversation identity still end with their process.
                        stdin_open = false;
                        let _ = process.stdin.shutdown().await;
                    }
                }
                None => {
                    process.healthy = false;
                    let success = process.child.wait().await.map_err(|_| "Could not collect the provider process result")?.success();
                    if !success || decoder.failure.is_some() {
                        let diagnostic = format!("{} {}", diagnostics, decoder.failure.unwrap_or_default()).to_lowercase();
                        break Err(provider_error(&diagnostic).into());
                    }
                    if request.agent.provider == "gemini" && !decoder.completed { break Err("Antigravity ended before confirming the response. Try again.".into()); }
                    if claude_visualizer && stdin_open { break Err("Claude exited before confirming the final reply. Partial output has been kept.".into()); }
                    if decoder.text.trim().is_empty() && !visualizer.has_visuals() { break Err("The CLI exited without a text response. Check Connections or try another model.".into()); }
                    break Ok(("complete".to_string(), decoder.text));
                }
            }
        }
    }
}
fn provider_error(diagnostic: &str) -> &'static str {
    let diagnostic = diagnostic.to_lowercase();
    if diagnostic.contains("structured")
        || diagnostic.contains("json-schema")
        || diagnostic.contains("json schema")
    {
        return "The provider could not return the requested structured JSON output. Check the schema, retry, or disable structured output.";
    }
    if diagnostic.contains("no conversation found") || diagnostic.contains("session not found") {
        "Claude could not resume this conversation's native session. Its saved history was preserved. Check the selected CLI profile, or start a new conversation; no message was replayed."
    } else if diagnostic.contains("selected folder is unavailable") {
        "The selected folder is unavailable. Choose an existing folder before sending."
    } else if diagnostic.contains("unsupported_client")
        || diagnostic.contains("client is no longer supported")
    {
        "Google retired Gemini CLI access for individual subscriptions. Install Antigravity CLI (agy) in Connections; repeating Gemini CLI sign-in will not fix this."
    } else if diagnostic.contains("quota")
        || diagnostic.contains("rate limit")
        || diagnostic.contains("usage limit")
        || diagnostic.contains("resource_exhausted")
    {
        "The provider's usage limit was reached. Try another agent or wait for your limit to reset."
    } else if diagnostic.contains("model")
        && (diagnostic.contains("not found")
            || diagnostic.contains("not supported")
            || diagnostic.contains("invalid")
            || diagnostic.contains("unknown"))
    {
        "That model is not available to this CLI account. Choose another model from the chat header."
    } else if diagnostic.contains("ineligible")
        || diagnostic.contains("not eligible")
        || diagnostic.contains("access denied")
    {
        "The provider rejected this account's access. Check your account's eligibility with the provider; repeating sign-in may not resolve it."
    } else if diagnostic.contains("auth")
        || diagnostic.contains("login")
        || diagnostic.contains("sign in")
        || diagnostic.contains("credentials")
    {
        "Your CLI login needs attention. Open Connections, sign in, and try again."
    } else {
        "The provider CLI could not complete the request. Check its login, model access, and connection, then try again."
    }
}
#[cfg(test)]
#[path = "runner_claude_tests.rs"]
mod claude_tests;

#[cfg(test)]
#[path = "elicitation_native_tests.rs"]
mod elicitation_native_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn chat_deadlines_allow_long_work_and_background_deadlines_still_expire() {
        for provider in ["claude", "codex"] {
            assert!(
                tokio::time::timeout(
                    Duration::from_secs(24 * 60 * 60),
                    response_deadline(chat_timeout(provider)),
                )
                .await
                .is_err(),
                "{provider} chat must not expire, including while awaiting input"
            );
        }
        assert!(tokio::time::timeout(
            Duration::from_secs(301),
            response_deadline(chat_timeout("gemini")),
        )
        .await
        .is_ok());
        assert!(tokio::time::timeout(
            Duration::from_secs(31),
            response_deadline(Some(Duration::from_secs(30))),
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn live_runs_are_never_replaced_and_reload_is_scoped_to_this_app() {
        let runs = Runs::default();
        let other_app = Runs::default();
        let current = CancellationToken::new();
        let unrelated = CancellationToken::new();
        runs.begin("current", current.clone()).await.unwrap();
        other_app.begin("other", unrelated.clone()).await.unwrap();
        assert!(runs
            .begin("next", CancellationToken::new())
            .await
            .unwrap_err()
            .contains("Another response"));
        assert!(!current.is_cancelled());
        runs.interrupt_for_reload();
        assert!(current.is_cancelled());
        assert!(!unrelated.is_cancelled());
        assert!(runs.0.lock().unwrap().contains_key("current"));
    }

    #[tokio::test]
    async fn replacement_waits_for_owned_process_cleanup_after_reload() {
        let runs = Runs::default();
        runs.begin("old", CancellationToken::new()).await.unwrap();
        runs.interrupt_for_reload();
        let replacement = CancellationToken::new();
        let next = runs.begin("new", replacement.clone());
        tokio::pin!(next);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut next)
            .await
            .is_err());
        assert!(!runs.0.lock().unwrap().contains_key("new"));
        runs.0.lock().unwrap().remove("old");
        next.await.unwrap();
        assert!(runs.0.lock().unwrap().contains_key("new"));
        assert!(!replacement.is_cancelled());
    }

    #[tokio::test]
    async fn another_reload_invalidates_a_request_waiting_in_the_previous_document() {
        let runs = Runs::default();
        runs.begin("old", CancellationToken::new()).await.unwrap();
        runs.interrupt_for_reload();
        let next = runs.begin("stale", CancellationToken::new());
        tokio::pin!(next);
        assert!(tokio::time::timeout(Duration::from_millis(75), &mut next)
            .await
            .is_err());
        runs.interrupt_for_reload();
        runs.0.lock().unwrap().remove("old");
        assert!(next.await.unwrap_err().contains("app reloaded"));
        assert!(runs.0.lock().unwrap().is_empty());
        runs.begin("current", CancellationToken::new())
            .await
            .unwrap();
    }

    #[test]
    fn retired_clients_and_quota_do_not_restart_authentication() {
        let error = provider_error("Authentication succeeded. Failed to sign in: This client is no longer supported for Gemini Code Assist for individuals.");
        assert!(error.contains("Antigravity"));
        assert!(!error.contains("login needs attention"));
        assert!(provider_error("auth error: RESOURCE_EXHAUSTED").contains("usage limit"));
        assert!(provider_error("Authentication required").contains("login needs attention"));
        assert!(
            provider_error("bash: cd: permission denied\nSelected folder is unavailable")
                .contains("Choose an existing folder")
        );
    }
}
