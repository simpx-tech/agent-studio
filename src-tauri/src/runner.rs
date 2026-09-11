use crate::{
    protocol::{Decoder, RunEvent},
    providers::{chat_command, RunRequest},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Runs(pub Mutex<HashMap<String, CancellationToken>>);
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
) -> Result<String, String> {
    let output = EventSink::new(move |event| channel.send(event).map_err(|e| e.to_string()));
    let timeout = if request.agent.provider == "claude" {
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
    request: RunRequest,
    channel: Option<EventSink>,
    cancel: CancellationToken,
    timeout: Duration,
    directory: &str,
) -> Result<(String, String), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the app data directory")?
        .join(directory);
    std::fs::create_dir_all(&root)
        .map_err(|_| "Cannot create the conversation runtime directory")?;
    let exe = crate::providers::resolve(&request.agent.provider).await?;
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
        )
        .await;
        exe.kill(&mut child).await;
        return result;
    }
    let mut stdin = child.stdin.take().ok_or("CLI stdin is unavailable")?;
    let prompt = request.stdin_payload();
    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<String>(16);
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
        .send(first)
        .await
        .map_err(|_| "CLI input is unavailable")?;
    if !claude_visualizer {
        input_tx.take();
    }
    let mut writer = tokio::spawn(async move {
        while let Some(payload) = input_rx.recv().await {
            stdin.write_all(payload.as_bytes()).await?;
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
    let mut writer_done = false;
    let initialization_deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(initialization_deadline);
    let output_limit = request.output_line_limit();
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut diagnostics = String::new();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => { exe.kill(&mut child).await; break Ok(("cancelled".to_string(), String::new())); }
            _ = &mut initialization_deadline, if claude_visualizer && !initialized => { exe.kill(&mut child).await; break Err("Claude did not initialize conversation tools within two minutes. Check its CLI and configured integrations.".into()); }
            result = &mut writer, if !writer_done => {
                writer_done = true;
                if !matches!(result, Ok(Ok(()))) { exe.kill(&mut child).await; break Err("Could not send input to the provider CLI.".into()); }
            }
            _ = &mut deadline => { exe.kill(&mut child).await; break Err(if channel.is_some() { format!("The provider did not finish within {} minutes. The owned run was stopped.", timeout.as_secs() / 60) } else { "Title generation timed out".into() }); }
            line = stdout.next_line(), if !stdout_done => match line {
                Ok(Some(line)) => {
                    if line.len() > output_limit { exe.kill(&mut child).await; break Err("Provider output exceeded the message limit".into()); }
                    if claude_visualizer {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if value["type"] == "control_response" && value["response"]["request_id"] == "studio-init" && !initialized {
                                if value["response"]["subtype"] != "success" { exe.kill(&mut child).await; break Err("Claude could not initialize conversation tools. Check its CLI version.".into()); }
                                initialized = true;
                                if let Some(tx) = &input_tx { let _ = tx.send(prompt.clone()).await; }
                                continue;
                            }
                            for event in visualizer.observe_claude(&value) { if let Some(channel) = &channel { if channel.send(event).is_err() { cancel.cancel(); } } }
                            if value["type"] == "control_request" {
                                let response = visualizer.claude_response(&value);
                                if let Some(tx) = &input_tx { let _ = tx.send(format!("{response}\n")).await; }
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
    if diagnostic.contains("selected folder is unavailable") {
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
