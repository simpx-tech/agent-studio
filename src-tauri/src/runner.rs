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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
pub async fn run(
    app: tauri::AppHandle,
    request: RunRequest,
    channel: Channel<RunEvent>,
    cancel: CancellationToken,
    connection_id: Option<String>,
) -> Result<String, String> {
    let output = EventSink::new(move |event| channel.send(event).map_err(|e| e.to_string()));
    let questions = app.state::<crate::providers::questions::Questions>().open(
        &request.run_id,
        connection_id,
        output.clone(),
    )?;
    let timeout = if matches!(request.agent.provider.as_str(), "claude" | "codex") {
        3600
    } else {
        300
    };
    execute(
        app,
        request,
        Some(output),
        cancel,
        Duration::from_secs(timeout),
        "chat-runtime",
        Some(questions),
    )
    .await
    .map(|(status, _)| status)
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
        Duration::from_secs(30),
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
    timeout: Duration,
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
    if request.native_session.as_ref().is_some_and(|s| !s.resumed) && request.messages.len() > 1 {
        if let Some(channel) = &channel {
            let _ = channel.send(RunEvent::Progress { id: "studio-session-bootstrap".into(), revision: 1, text: "Continuing this older chat from its saved messages. Native session history is retained from this reply onward; earlier unrecorded tool details are unavailable.".into() });
        }
    }
    let config_cwd = if exe.wsl.is_some() {
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
    let mut child = command
        .spawn()
        .map_err(|_| "Could not launch the provider CLI. Check Connections.")?;
    if request.uses_codex_server() {
        let result = crate::providers::codex_chat::run(
            &mut child,
            &request,
            channel.as_ref(),
            cancel,
            timeout,
            questions
                .as_mut()
                .ok_or("Question channel is unavailable")?,
            config_cwd.as_deref(),
        )
        .await;
        exe.kill(&mut child).await;
        return result;
    }
    let mut stdin = child.stdin.take().ok_or("CLI stdin is unavailable")?;
    let prompt = request.stdin_payload();
    type Input = (
        String,
        Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    );
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Input>(16);
    let mut input_tx = Some(input_tx);
    let claude_visualizer = request.uses_claude_visualizer();
    let first = if claude_visualizer {
        "{\"type\":\"control_request\",\"request_id\":\"studio-init\",\"request\":{\"subtype\":\"initialize\",\"hooks\":null}}\n".into()
    } else {
        prompt.clone()
    };
    input_tx
        .as_ref()
        .unwrap()
        .send((first, None))
        .await
        .map_err(|_| "CLI input is unavailable")?;
    if !claude_visualizer {
        input_tx.take();
    }
    let mut writer = tokio::spawn(async move {
        while let Some((payload, ack)) = input_rx.recv().await {
            let result = stdin.write_all(payload.as_bytes()).await;
            if let Some(ack) = ack {
                let _ = ack.send(
                    result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|_| "Could not send answers to Claude.".into()),
                );
            }
            result?;
        }
        stdin.shutdown().await
    });
    let mut stdout =
        BufReader::new(child.stdout.take().ok_or("CLI stdout is unavailable")?).lines();
    let mut stderr =
        BufReader::new(child.stderr.take().ok_or("CLI stderr is unavailable")?).lines();
    let mut decoder = Decoder::default();
    let mut visualizer = crate::providers::visualize::Visualizer::default();
    let mut input_lifetime = crate::providers::visualize::ClaudeInputLifetime::default();
    let mut initialized = false;
    let mut session_received = false;
    let mut writer_done = false;
    let initialization_deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(initialization_deadline);
    let output_limit = request.output_line_limit();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut diagnostics = String::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let interaction_deadline = tokio::time::sleep(Duration::from_secs(3600));
    tokio::pin!(interaction_deadline);
    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => { exe.kill(&mut child).await; break Ok(("cancelled".to_string(), String::new())); }
            _ = &mut interaction_deadline => { exe.kill(&mut child).await; break Err("The conversation reached its one-hour limit. Pending questions were closed.".into()); }
            _ = &mut initialization_deadline, if claude_visualizer && !initialized => { exe.kill(&mut child).await; break Err("Claude did not initialize conversation tools within two minutes. Check its CLI and configured integrations.".into()); }
            result = &mut writer, if !writer_done => {
                writer_done = true;
                if !matches!(result, Ok(Ok(()))) { exe.kill(&mut child).await; break Err("Could not send input to the provider CLI.".into()); }
            }
            _ = &mut deadline, if !questions.as_ref().is_some_and(|q| q.pending()) => { exe.kill(&mut child).await; break Err(if channel.is_some() { format!("The provider did not finish within {} minutes. The owned run was stopped.", timeout.as_secs() / 60) } else { "Title generation timed out".into() }); }
            Some(delivery) = async { match questions.as_mut() { Some(q) => q.rx.recv().await, None => std::future::pending().await } } => {
                let result = match &input_tx {
                    Some(tx) => {
                        let (ack, received) = tokio::sync::oneshot::channel();
                        match tx.send((format!("{}\n", delivery.payload), Some(ack))).await {
                            Ok(()) => received.await.unwrap_or_else(|_| Err("Could not send answers to Claude.".into())),
                            Err(_) => Err("Could not send answers to Claude.".into()),
                        }
                    },
                    None => Err("Claude is no longer waiting for answers.".into()),
                };
                questions.as_ref().unwrap().delivered(delivery, result);
                deadline.as_mut().reset(tokio::time::Instant::now() + timeout);
            },
            line = stdout.next_line(), if !stdout_done => match line {
                Ok(Some(line)) => {
                    if line.len() > output_limit { exe.kill(&mut child).await; break Err("Provider output exceeded the message limit".into()); }
                    if claude_visualizer {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if value["type"] == "system" && value["subtype"] == "init" && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    let result = value["session_id"].as_str().ok_or("Claude did not report a native session identity".to_string()).and_then(|id| session.bind(id, false));
                                    if let Err(error) = result { exe.kill(&mut child).await; break Err(error); }
                                }
                            }
                            if !session_received && value["type"] == "assistant" && value["parent_tool_use_id"].is_null() {
                                if let Some(session) = &request.native_session {
                                    if let Err(error) = session.bind(session.id(), true) { exe.kill(&mut child).await; break Err(error); }
                                    session_received = true;
                                }
                            }
                            if value["type"] == "control_response" && value["response"]["request_id"] == "studio-init" && !initialized {
                                if value["response"]["subtype"] != "success" { exe.kill(&mut child).await; break Err("Claude could not initialize conversation tools. Check its CLI version.".into()); }
                                initialized = true;
                                if let Some(tx) = &input_tx { let _ = tx.send((prompt.clone(), None)).await; }
                                continue;
                            }
                            if let Some(questions) = &mut questions { questions.observe_claude(&value); }
                            for event in visualizer.observe_claude(&value) { if let Some(channel) = &channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            if value["type"] == "control_request" {
                                if let Some(response) = questions.as_mut().and_then(|q| q.claude(&value)) {
                                    if let (Some(response), Some(tx)) = (response, &input_tx) { let _ = tx.send((format!("{response}\n"), None)).await; }
                                    continue;
                                }
                                let response = visualizer.claude_response(&value);
                                if let Some(tx) = &input_tx { let _ = tx.send((format!("{response}\n"), None)).await; }
                                continue;
                            }
                            if input_lifetime.ended(&value) { input_tx.take(); }
                        }
                    }
                    for event in decoder.decode(&request.agent.provider, &line) { if let Some(channel) = &channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                    if channel.is_none() && decoder.text.len() > 4000 { exe.kill(&mut child).await; break Err("Title response exceeded the limit".into()); }
                }
                Ok(None) => stdout_done = true,
                Err(_) => { exe.kill(&mut child).await; break Err("Could not read the provider response".into()); }
            },
            line = stderr.next_line(), if !stderr_done => match line {
                Ok(Some(line)) => {
                    if request.agent.provider == "gemini" && line.trim().to_lowercase().starts_with("authentication required") {
                        exe.kill(&mut child).await;
                        break Err(provider_error(&line).into());
                    }
                    if diagnostics.len() < 16000 { diagnostics.push_str(&line.chars().take(1000).collect::<String>()); diagnostics.push('\n'); }
                },
                _ => stderr_done = true,
            },
            status = child.wait(), if stdout_done && stderr_done => {
                let success = status.map_err(|_| "Could not collect the provider process result")?.success();
                if !success || decoder.failure.is_some() {
                    let diagnostic = format!("{} {}", diagnostics, decoder.failure.unwrap_or_default()).to_lowercase();
                    break Err(provider_error(&diagnostic).into());
                }
                if request.agent.provider == "gemini" && !decoder.completed { break Err("Antigravity ended before confirming the response. Try again.".into()); }
                if claude_visualizer && input_tx.is_some() { break Err("Claude exited before confirming the final reply. Partial output has been kept.".into()); }
                if decoder.text.trim().is_empty() && !visualizer.has_visuals() { break Err("The CLI exited without a text response. Check Connections or try another model.".into()); }
                break Ok(("complete".to_string(), decoder.text));
            }
        }
    };
    writer.abort();
    outcome
}
fn provider_error(diagnostic: &str) -> &'static str {
    let diagnostic = diagnostic.to_lowercase();
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
mod tests {
    use super::*;
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
