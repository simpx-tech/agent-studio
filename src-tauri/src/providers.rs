use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
pub mod codex_chat;
#[cfg(windows)]
mod login_console;

#[derive(Clone, Debug)]
pub struct Executable {
    pub provider: String,
    pub program: PathBuf,
    pub prefix: Vec<String>,
    pub wsl: Option<crate::wsl::Launch>,
}
impl Executable {
    pub fn command(&self) -> Command {
        let mut c = Command::new(&self.program);
        c.args(&self.prefix);
        if self.wsl.is_none() {
            crate::profiles::configure(&mut c, &self.provider);
        }
        #[cfg(windows)]
        c.creation_flags(0x08000000);
        c.kill_on_drop(true);
        c
    }
    pub async fn kill(&self, child: &mut tokio::process::Child) {
        if child.try_wait().ok().flatten().is_none() {
            if let Some(wsl) = &self.wsl {
                wsl.cancel().await;
            }
        }
        crate::runner::kill_tree(child).await;
    }
    pub fn location(&self) -> String {
        self.wsl
            .as_ref()
            .map(|w| format!("WSL · {}", w.distribution))
            .unwrap_or_else(|| {
                match std::env::consts::OS {
                    "windows" => "Windows",
                    "macos" => "macOS",
                    _ => "Linux",
                }
                .into()
            })
    }
}
pub fn valid_provider(provider: &str) -> bool {
    ["codex", "claude", "gemini"].contains(&provider)
}
fn search_dirs() -> Vec<PathBuf> {
    let mut paths: Vec<_> = env::split_paths(&env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let home = PathBuf::from(home);
        paths.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        paths.extend([
            local.join("Programs/OpenAI/Codex/bin"),
            local.join("agy/bin"),
        ]);
    }
    if let Some(roaming) = env::var_os("APPDATA") {
        paths.push(PathBuf::from(roaming).join("npm"));
    }
    paths.extend([
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]);
    paths
}
pub async fn resolve(provider: &str) -> Result<Executable, String> {
    resolve_using(provider, &search_dirs(), |distribution| async move {
        crate::wsl::resolve(provider, &distribution).await
    })
    .await
}
async fn resolve_using<F, Fut>(
    provider: &str,
    dirs: &[PathBuf],
    selected_wsl: F,
) -> Result<Executable, String>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<Executable, String>>,
{
    if !valid_provider(provider) {
        return Err("Unknown provider".into());
    }
    let profile = crate::profiles::current();
    if profile.provider == provider {
        if let Some(distribution) = &profile.distribution {
            return selected_wsl(distribution.clone()).await;
        }
    }
    // Default/native connections never probe another computer when a CLI is missing.
    resolve_in(provider, dirs)
}
fn resolve_in(provider: &str, dirs: &[PathBuf]) -> Result<Executable, String> {
    // Google's individual subscription access moved to Antigravity on 2026-06-18.
    // Never fall back to the retired Gemini CLI and restart its OAuth loop.
    let binary = if provider == "gemini" {
        "agy"
    } else {
        provider
    };
    for dir in dirs {
        let native = dir.join(if cfg!(windows) {
            format!("{binary}.exe")
        } else {
            binary.to_string()
        });
        if native.is_file() {
            return Ok(Executable {
                provider: provider.into(),
                program: native,
                prefix: vec![],
                wsl: None,
            });
        }
        // Resolve npm's Node entrypoint directly; never execute a shell shim with user arguments.
        if cfg!(windows) && provider != "gemini" && dir.join(format!("{provider}.cmd")).is_file() {
            let package = match provider {
                "codex" => "@openai/codex",
                "claude" => "@anthropic-ai/claude-code",
                _ => unreachable!(),
            };
            let root = dir.join("node_modules").join(package);
            if let Ok(raw) = std::fs::read_to_string(root.join("package.json")) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(bin) = json["bin"][provider]
                        .as_str()
                        .or_else(|| json["bin"].as_str())
                    {
                        let script = root.join(bin);
                        if script.is_file() {
                            if let Some(node) = dirs
                                .iter()
                                .map(|p| p.join("node.exe"))
                                .find(|p| p.is_file())
                            {
                                return Ok(Executable {
                                    provider: provider.into(),
                                    program: node,
                                    prefix: vec![script.to_string_lossy().into_owned()],
                                    wsl: None,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    if provider == "gemini" {
        return Err("Install Antigravity CLI (agy) in Connections. Google retired Gemini CLI access for individual subscriptions; repeating Gemini CLI sign-in will not fix it.".into());
    }
    Err(format!(
        "{provider} CLI was not found. Install it, then refresh Connections."
    ))
}
#[derive(Serialize)]
pub struct CliInstallation {
    pub id: String,
    pub path: Option<String>,
}
pub fn native_installations() -> Vec<CliInstallation> {
    ["codex", "claude", "gemini"]
        .into_iter()
        .map(|id| {
            let path = resolve_in(id, &search_dirs()).ok().map(|exe| {
                exe.prefix
                    .first()
                    .cloned()
                    .unwrap_or_else(|| exe.program.to_string_lossy().into_owned())
            });
            CliInstallation {
                id: id.into(),
                path,
            }
        })
        .collect()
}
#[derive(Serialize)]
pub struct ProviderStatus {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
    pub auth: String,
    pub detail: String,
    pub location: Option<String>,
}
async fn output(exe: &Executable, args: &[&str]) -> Result<std::process::Output, String> {
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        exe.command().args(args).stdin(Stdio::null()).output(),
    )
    .await
    .map_err(|_| "CLI check timed out".to_string());
    if result.is_err() {
        if let Some(wsl) = &exe.wsl {
            wsl.cancel().await;
        }
    }
    result?.map_err(|_| "Could not start the CLI".to_string())
}
#[derive(Debug, PartialEq)]
enum LoginCheck {
    Ready,
    Login,
    Unknown,
}

fn gemini_login_result(success: bool, stdout: &str, diagnostics: &str) -> LoginCheck {
    if success {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) {
            if value["status"] == "SUCCESS" && value["command"]["name"] == "usage" {
                return LoginCheck::Ready;
            }
        }
    }
    let diagnostics = format!("{diagnostics}\n{stdout}").to_lowercase();
    if diagnostics.contains("authentication required") || diagnostics.contains("please sign in") {
        LoginCheck::Login
    } else {
        LoginCheck::Unknown
    }
}

async fn check_gemini_login(
    exe: &Executable,
    cancel: &tokio_util::sync::CancellationToken,
) -> LoginCheck {
    // /usage is a built-in account query, not a model prompt. Keep it headless;
    // never infer authentication from credential files or a surviving terminal.
    let Ok(mut child) = exe
        .command()
        .args(["--print", "/usage", "--output-format", "json"])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return LoginCheck::Unknown;
    };
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut stderr = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut text = String::new();
    let mut diagnostics = String::new();
    let mut out_done = false;
    let mut err_done = false;
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => { exe.kill(&mut child).await; return LoginCheck::Unknown; }
            _ = &mut deadline => { exe.kill(&mut child).await; return LoginCheck::Unknown; }
            line = stdout.next_line(), if !out_done => match line {
                Ok(Some(line)) if text.len() + line.len() < 512_000 => {
                    if gemini_login_result(false, &line, "") == LoginCheck::Login {
                        exe.kill(&mut child).await;
                        return LoginCheck::Login;
                    }
                    text.push_str(&line); text.push('\n');
                }
                Ok(None) => out_done = true,
                _ => { exe.kill(&mut child).await; return LoginCheck::Unknown; }
            },
            line = stderr.next_line(), if !err_done => match line {
                Ok(Some(line)) => {
                    // Stop at the CLI's headless OAuth fallback, without waiting
                    // for a code or treating noisy startup logs as a sign-out.
                    if line.trim().to_lowercase().starts_with("authentication required") {
                        exe.kill(&mut child).await;
                        return LoginCheck::Login;
                    }
                    if diagnostics.len() < 16_000 { diagnostics.push_str(&line); diagnostics.push('\n'); }
                },
                Ok(None) => err_done = true,
                Err(_) => { exe.kill(&mut child).await; return LoginCheck::Unknown; }
            },
            status = child.wait(), if out_done && err_done => {
                return gemini_login_result(status.is_ok_and(|s| s.success()), &text, &diagnostics);
            }
        }
    }
}
pub async fn require_gemini_login(
    exe: &Executable,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    match check_gemini_login(exe, cancel).await {
        LoginCheck::Ready => Ok(()),
        LoginCheck::Login => Err("Your CLI login needs attention. Open Connections and connect to Gemini before sending a message.".into()),
        LoginCheck::Unknown => Err("Your Gemini connection could not be verified. Open Connections and refresh before sending a message.".into()),
    }
}
pub async fn detect_one(id: &str) -> ProviderStatus {
    let mut s = ProviderStatus {
        id: id.into(),
        installed: false,
        version: None,
        auth: "unknown".into(),
        detail: "CLI not found. Install it to get started.".into(),
        location: None,
    };
    let exe = match resolve(id).await {
        Ok(exe) => exe,
        Err(detail) => {
            s.detail = detail;
            return s;
        }
    };
    s.installed = true;
    s.location = Some(exe.location());
    s.version = output(&exe, &["--version"])
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .chars()
                .take(100)
                .collect()
        });
    s.detail = "Installed. Send a message to verify your login.".into();
    if id == "gemini" {
        let (auth, detail) = match check_gemini_login(&exe, &tokio_util::sync::CancellationToken::new()).await {
            LoginCheck::Ready => ("ready", "Signed in to Google through Antigravity CLI. Your account connection is verified."),
            LoginCheck::Login => ("login", "Sign in to Google through Antigravity CLI. This status updates automatically after sign-in."),
            LoginCheck::Unknown => ("unknown", "Antigravity CLI is installed, but account status could not be verified. Check your connection and refresh; no new sign-in is required unless the CLI asks for it."),
        };
        s.auth = auth.into();
        s.detail = detail.into();
    }
    if id == "codex" {
        if let Ok(o) = output(&exe, &["login", "status"]).await {
            s.auth = if o.status.success() { "ready" } else { "login" }.into();
            s.detail = if o.status.success() {
                "Signed in with your existing Codex login."
            } else {
                "Sign in to Codex with your ChatGPT account."
            }
            .into();
        }
    } else if id == "claude" {
        if let Ok(o) = output(&exe, &["auth", "status"]).await {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                let ready = v["loggedIn"].as_bool().unwrap_or(false);
                s.auth = if ready { "ready" } else { "login" }.into();
                s.detail = if ready {
                    "Signed in with your existing Claude login."
                } else {
                    "Sign in to Claude Code with your Claude account."
                }
                .into();
            }
        }
    }
    s
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    // Internal background requests must never inherit interactive chat permissions.
    #[serde(skip)]
    pub conversation_only: bool,
    #[serde(default)]
    pub location: Option<crate::folders::ChatLocation>,
    pub agent: Agent,
    pub messages: Vec<ChatMessage>,
}
#[derive(Clone, Deserialize)]
pub struct Agent {
    pub provider: String,
    pub model: String,
    pub instructions: String,
    #[serde(default)]
    pub reasoning: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<images::ChatImage>,
}
mod images;
impl RunRequest {
    pub fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.run_id).map_err(|_| "Invalid run id")?;
        if !valid_provider(&self.agent.provider) {
            return Err("Unknown provider".into());
        }
        if self.messages.is_empty() || self.messages.len() > 200 {
            return Err(
                "Conversations support up to 200 messages. Start a new conversation to continue."
                    .into(),
            );
        }
        if self.agent.model.len() > 100
            || self.agent.model.starts_with('-')
            || self.agent.model.chars().any(char::is_control)
        {
            return Err("Invalid model name".into());
        }
        if self.agent.instructions.len() > 64000 {
            return Err("Agent instructions are too long".into());
        }
        let allowed: &[&str] = match self.agent.provider.as_str() {
            "codex" => &[
                "", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
            ],
            "claude" => &["", "low", "medium", "high", "xhigh", "max"],
            "gemini" => &["", "low", "medium", "high"],
            _ => &[],
        };
        if !allowed.contains(&self.agent.reasoning.as_str()) {
            return Err("Invalid reasoning level for this provider".into());
        }
        if self
            .messages
            .iter()
            .any(|m| !["user", "assistant"].contains(&m.role.as_str()))
        {
            return Err("Invalid message role".into());
        }
        if self.messages.iter().map(|m| m.text.len()).sum::<usize>() > 400_000 {
            return Err("Conversation is too large. Start a new conversation.".into());
        }
        let mut image_bytes = 0;
        for message in &self.messages {
            if message.images.is_empty() {
                continue;
            }
            if !self.tools_enabled() || message.role != "user" {
                return Err(
                    "Image attachments are available only in Codex and Claude user messages".into(),
                );
            }
            if message.images.len() > 4 {
                return Err("Attach up to 4 images per message".into());
            }
            for image in &message.images {
                image_bytes += image.validate()?;
                if image_bytes > images::MAX_CONVERSATION_IMAGE_BYTES {
                    return Err("This conversation has reached its 8 MB image limit. Start a new conversation to attach more images.".into());
                }
            }
        }
        if self
            .messages
            .last()
            .is_none_or(|m| m.role != "user" || (m.text.trim().is_empty() && m.images.is_empty()))
        {
            return Err("Enter a message first".into());
        }
        Ok(())
    }
    fn tools_enabled(&self) -> bool {
        !self.conversation_only && matches!(self.agent.provider.as_str(), "codex" | "claude")
    }
    pub fn uses_codex_server(&self) -> bool {
        self.agent.provider == "codex" && self.tools_enabled()
    }
    pub fn output_line_limit(&self) -> usize {
        // Providers can echo visual input in user-message lifecycle events.
        // Retain the text limit plus only the already-validated image payload.
        2_000_000
            + self
                .messages
                .iter()
                .flat_map(|m| &m.images)
                .map(|image| image.data.len())
                .sum::<usize>()
    }
    pub fn prompt(&self) -> String {
        // Image bytes are separate visual inputs, never text tokens or shell paths.
        let messages: Vec<_> = self
            .messages
            .iter()
            .map(|message| {
                let mut value = serde_json::json!({"role":message.role,"text":message.text});
                if !message.images.is_empty() {
                    value["images"] = serde_json::json!(message
                        .images
                        .iter()
                        .map(|image| &image.name)
                        .collect::<Vec<_>>());
                }
                value
            })
            .collect();
        let context = serde_json::json!({ "agent_instructions": self.agent.instructions, "conversation": messages });
        let tools = if self.tools_enabled() {
            "Tools are enabled in this conversation. Use available tools to inspect files, edit files, run commands, load applicable skills, search the web, and delegate independent work to sub-agents as needed to complete the user's requested work in the selected working directory. Follow applicable project instructions. Earlier messages may describe tools as disabled; that restriction no longer applies."
        } else {
            "Do not use tools, inspect files, execute commands, or delegate."
        };
        format!("You are having a conversation in Agent Studio. Answer the final user message using the earlier messages as context. {tools} Format your response with Markdown where useful. The following JSON contains your agent instructions and ordered conversation messages:\n{context}")
    }
    pub fn stdin_payload(&self) -> String {
        if self.agent.provider == "claude" && self.messages.iter().any(|m| !m.images.is_empty()) {
            let mut content = vec![serde_json::json!({"type":"text","text":self.prompt()})];
            for (message_index, message) in self.messages.iter().enumerate() {
                for (image_index, image) in message.images.iter().enumerate() {
                    content.push(serde_json::json!({"type":"text","text":image.label(message_index, image_index)}));
                    content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}}));
                }
            }
            format!(
                "{}\n",
                serde_json::json!({"type":"user","message":{"role":"user","content":content}})
            )
        } else if self.agent.provider == "gemini" {
            format!(
                "{}\n",
                serde_json::json!({"event":"user","message":{"content":self.prompt()}})
            )
        } else {
            self.prompt()
        }
    }
}
pub fn prepare_gemini_agent(workspace: &Path) -> Result<(), String> {
    let directory = workspace.join(".agents/agents/agent-studio-chat");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Cannot prepare the Gemini conversation agent")?;
    std::fs::write(
        directory.join("agent.md"),
        include_str!("../agent-studio-chat.md"),
    )
    .map_err(|_| "Cannot write the Gemini conversation agent")?;
    // In agy 1.1.27, primary agents still expose tools when tools: [] is set.
    // Enforce conversation mode at the documented PreToolUse gate instead.
    std::fs::write(
        workspace.join(".agents/hooks.json"),
        gemini_hooks().to_string(),
    )
    .map_err(|_| "Cannot enforce Gemini conversation-only permissions".into())
}
pub fn gemini_hooks() -> serde_json::Value {
    let response = r#"{"decision":"deny","reason":"Agent Studio is conversation-only. Tool execution is disabled. Answer using the supplied conversation."}"#;
    #[cfg(windows)]
    let command = {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let script = format!("[Console]::Out.WriteLine('{}')", response);
        let encoded = STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
    };
    #[cfg(not(windows))]
    let command = format!("printf '%s\\n' '{response}'");
    serde_json::json!({"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":command,"timeout":10}]}]}})
}
pub async fn chat_command(
    request: &RunRequest,
    runtime: &Path,
    exe: &Executable,
) -> Result<Command, String> {
    let selected = request
        .location
        .as_ref()
        .map(|location| location.path.as_str());
    let profile = crate::profiles::current();
    let folder_in_wsl =
        profile.provider == request.agent.provider && profile.folder_distribution.is_some();
    let mut native_folder = None;
    if let Some(path) = selected {
        crate::folders::validate_path(path, folder_in_wsl || exe.wsl.is_some() || !cfg!(windows))?;
        if folder_in_wsl && exe.wsl.is_none() {
            native_folder = Some(
                crate::folders::windows_path(profile.folder_distribution.as_deref().unwrap(), path)
                    .await?,
            );
        }
        let native_path = native_folder.as_deref().unwrap_or_else(|| Path::new(path));
        if path.is_empty() || (exe.wsl.is_none() && !native_path.is_dir()) {
            return Err(
                "The selected folder is unavailable. Choose an existing folder before sending."
                    .into(),
            );
        }
    }
    let mut c = exe.command();
    // Windows cannot use a Linux path as wsl.exe's cwd. The fixed bridge script
    // changes directory inside the selected distribution before launching its CLI.
    if exe.wsl.is_some() {
        c.current_dir(runtime);
        if let Some(path) = selected {
            c.args(["--agent-studio-cwd", path]);
        }
    } else {
        c.current_dir(
            native_folder
                .as_deref()
                .or_else(|| selected.map(Path::new))
                .unwrap_or(runtime),
        );
    }
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c.env_remove("CLAUDECODE")
        .env_remove("CODEX_THREAD_ID")
        .env("NO_COLOR", "1");
    match request.agent.provider.as_str() {
        "codex" => {
            if request.tools_enabled() {
                c.args([
                    "app-server",
                    "--stdio",
                    "-c",
                    "features.shell_tool=true",
                    "-c",
                    "features.apply_patch_freeform=true",
                    "-c",
                    "web_search=\"live\"",
                    "-c",
                    "features.multi_agent=true",
                ]);
            } else {
                c.args([
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--sandbox",
                    "read-only",
                    "-c",
                    "features.shell_tool=false",
                    "-c",
                    "features.apply_patch_freeform=false",
                ]);
            }
        }
        "claude" => {
            c.args([
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--no-session-persistence",
            ]);
            if request.messages.iter().any(|m| !m.images.is_empty()) {
                c.args(["--input-format", "stream-json"]);
            }
            if request.tools_enabled() {
                c.args([
                    "--tools",
                    "default",
                    "--permission-mode",
                    "bypassPermissions",
                ]);
            } else {
                c.args([
                    "--safe-mode",
                    "--strict-mcp-config",
                    "--tools",
                    "",
                    "--permission-mode",
                    "dontAsk",
                    "--disable-slash-commands",
                ]);
            }
        }
        "gemini" => {
            prepare_gemini_agent(runtime)?;
            // Antigravity print mode advertises registered workspace roots, not
            // just process cwd. Register the user's folder first as well.
            if let Some(path) = selected {
                c.arg("--add-dir").arg(path);
            }
            // Keep the enforced agent/hooks in app data, even when cwd is a project.
            // Print mode loads them only when the runtime is an explicit workspace.
            c.arg("--add-dir").arg(runtime);
            c.args([
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--agent",
                "agent-studio-chat",
                "--disable-slash-commands",
                "--mode",
                "plan",
            ]);
        }
        _ => return Err("Unknown provider".into()),
    }
    if !request.uses_codex_server() {
        c.args(selection_args(&request.agent));
    }
    if request.agent.provider == "claude" && !request.agent.reasoning.is_empty() {
        c.env_remove("CLAUDE_CODE_EFFORT_LEVEL");
    }
    if request.agent.provider == "codex" && !request.uses_codex_server() {
        c.arg("-");
    }
    #[cfg(unix)]
    c.process_group(0);
    Ok(c)
}
fn selection_args(agent: &Agent) -> Vec<String> {
    let mut args = vec![];
    let mut model = agent.model.trim().to_string();
    if agent.provider == "gemini" {
        if model.is_empty() {
            model = "gemini-3.8-flash".into();
        }
        if model.starts_with("gemini-")
            && !["-low", "-medium", "-high"]
                .iter()
                .any(|suffix| model.ends_with(suffix))
        {
            let effort = if agent.reasoning.is_empty() {
                if model.contains("-pro") {
                    "high"
                } else {
                    "medium"
                }
            } else {
                &agent.reasoning
            };
            model = format!("{model}-{effort}");
        }
    }
    if !model.is_empty() {
        args.extend(["--model".into(), model]);
    }
    if !agent.reasoning.is_empty() {
        if agent.provider == "codex" {
            args.extend([
                "-c".into(),
                format!("model_reasoning_effort=\"{}\"", agent.reasoning),
            ]);
        } else {
            args.extend(["--effort".into(), agent.reasoning.clone()]);
        }
    }
    args
}
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn login_script(exe: &Executable, provider: &str, directory: &Path) -> String {
    let mut args = exe.prefix.clone();
    let profile = crate::profiles::current();
    let mut environment = String::new();
    if let Some(root) = profile.root.filter(|_| exe.wsl.is_none()) {
        let name = if provider == "codex" {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        };
        environment = format!("$env:{name} = {}\n", ps_literal(&root.to_string_lossy()));
        for name in [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_USE_MANTLE",
        ] {
            environment.push_str(&format!("$env:{name} = $null\n"));
        }
        if provider == "codex" {
            args.extend(["-c".into(), "cli_auth_credentials_store=\"file\"".into()]);
        }
    }
    match provider {
        "codex" => args.push("login".into()),
        "claude" => args.extend(["auth".into(), "login".into()]),
        _ => {}
    }
    format!(
        "$Host.UI.RawUI.WindowTitle = 'Agent Studio - {provider} sign-in'\n{environment}$env:CLAUDECODE = $null\ntry {{\nSet-Location -LiteralPath {} -ErrorAction Stop\nWrite-Host 'Complete sign-in here, then return to Agent Studio.'\n& {} {}\n}} catch {{ Write-Host $_.Exception.Message -ForegroundColor Red }}\nWrite-Host 'Return to Agent Studio. Your account will update automatically. This window can now be closed.'\n",
        ps_literal(&directory.to_string_lossy()), ps_literal(&exe.program.to_string_lossy()),
        args.iter().map(|a| ps_literal(a)).collect::<Vec<_>>().join(" ")
    )
}
pub async fn sign_in(provider: &str, directory: &Path) -> Result<(), String> {
    let exe = resolve(provider).await?;
    #[cfg(windows)]
    {
        std::fs::create_dir_all(directory).map_err(|_| "Cannot prepare the sign-in directory")?;
        let script = login_script(&exe, provider, directory);
        tokio::task::spawn_blocking(move || login_console::open(&script).map(|_| ()))
            .await
            .map_err(|_| "Could not start the sign-in launcher".to_string())?
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
        let profile = crate::profiles::current();
        std::fs::create_dir_all(directory).map_err(|_| "Cannot prepare sign-in directory")?;
        let mut script = format!(
            "#!/bin/sh\ncd {} || exit 1\nunset CLAUDECODE\n",
            quote(&directory.to_string_lossy())
        );
        let mut args = exe.prefix.clone();
        if let Some(root) = profile.root {
            let name = if provider == "codex" {
                "CODEX_HOME"
            } else {
                "CLAUDE_CONFIG_DIR"
            };
            script.push_str(&format!("export {name}={}\nunset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE\n", quote(&root.to_string_lossy())));
            if provider == "codex" {
                args.extend(["-c".into(), "cli_auth_credentials_store=\"file\"".into()]);
            }
        }
        match provider {
            "codex" => args.push("login".into()),
            "claude" => args.extend(["auth".into(), "login".into()]),
            _ => {}
        }
        script.push_str(&format!(
            "{} {}\nprintf '\\nReturn to Agent Studio. Press Enter to close.\\n'\nread answer\n",
            quote(&exe.program.to_string_lossy()),
            args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ")
        ));
        let path = directory.join(format!("login-{}.command", uuid::Uuid::new_v4()));
        std::fs::write(&path, script).map_err(|_| "Cannot write sign-in launcher")?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot prepare sign-in launcher permissions")?;
        let mut command = if cfg!(target_os = "macos") {
            let mut c = std::process::Command::new("open");
            c.args(["-a", "Terminal"]);
            c
        } else {
            let mut c = std::process::Command::new("x-terminal-emulator");
            c.arg("-e");
            c
        };
        command.arg(&path).spawn().map(|_| ()).map_err(|_| format!("Could not open a terminal. Run this local launcher to sign in to the selected profile: {}", path.display()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[tokio::test]
    async fn desktop_connections_never_probe_wsl_even_when_the_cli_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("claude.exe");
        std::fs::write(&binary, "synthetic executable metadata").unwrap();
        for explicit in [false, true] {
            crate::profiles::scope(
                crate::profiles::Profile {
                    id: if explicit {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        String::new()
                    },
                    provider: "claude".into(),
                    // A Linux project folder must not change executable resolution.
                    folder_distribution: Some("Ubuntu".into()),
                    ..Default::default()
                },
                async {
                    let native = resolve_using("claude", &[dir.path().to_owned()], |_| async {
                        panic!("Desktop must never probe WSL")
                    })
                    .await
                    .unwrap();
                    assert_eq!(native.program, binary);
                    assert!(resolve_using("claude", &[], |_| async {
                        panic!("Missing Desktop CLI must not fall back to WSL")
                    })
                    .await
                    .is_err());
                },
            )
            .await;
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn wsl_connections_use_only_the_selected_distribution_for_both_login_modes() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["claude", "codex"] {
            std::fs::write(
                root.path().join(format!("{provider}.exe")),
                "synthetic native CLI",
            )
            .unwrap();
            for isolated in [false, true] {
                crate::profiles::scope(
                    crate::profiles::Profile {
                        id: uuid::Uuid::new_v4().to_string(),
                        provider: provider.into(),
                        distribution: Some("Selected Ubuntu".into()),
                        isolated,
                        ..Default::default()
                    },
                    async {
                        let missing = resolve_using(
                            provider,
                            &[root.path().into()],
                            |distribution| async move {
                                assert_eq!(distribution, "Selected Ubuntu");
                                Err("Selected WSL CLI is missing".into())
                            },
                        )
                        .await;
                        assert!(missing.unwrap_err().contains("Selected WSL CLI is missing"));
                        let linux = resolve_using(
                            provider,
                            &[root.path().into()],
                            |distribution| async move {
                                assert_eq!(distribution, "Selected Ubuntu");
                                Ok(Executable {
                                    provider: provider.into(),
                                    program: "wsl.exe".into(),
                                    prefix: vec![],
                                    wsl: Some(crate::wsl::Launch {
                                        distribution,
                                        namespace: "test".into(),
                                        job: uuid::Uuid::new_v4().to_string(),
                                    }),
                                })
                            },
                        )
                        .await
                        .unwrap();
                        assert_eq!(linux.wsl.unwrap().distribution, "Selected Ubuntu");
                    },
                )
                .await;
            }
        }
    }
    fn request() -> RunRequest {
        RunRequest {
            conversation_only: false,
            location: None,
            run_id: uuid::Uuid::new_v4().to_string(),
            agent: Agent {
                provider: "claude".into(),
                model: String::new(),
                instructions: "Be concise".into(),
                reasoning: String::new(),
            },
            messages: vec![ChatMessage {
                role: "user".into(),
                text: "Quotes \" & $(echo) `hello`\nこんにちは".into(),
                images: vec![],
            }],
        }
    }
    fn at_folder(path: &str) -> RunRequest {
        let mut r = request();
        r.location = Some(
            serde_json::from_value(serde_json::json!({
                "computerId": uuid::Uuid::new_v4().to_string(),
                "environmentId": uuid::Uuid::new_v4().to_string(),
                "path": path,
            }))
            .unwrap(),
        );
        r
    }
    #[tokio::test]
    async fn background_requests_keep_tools_disabled() {
        let runtime = tempfile::tempdir().unwrap();
        for provider in ["codex", "claude"] {
            let mut r = request();
            r.agent.provider = provider.into();
            assert!(r.prompt().contains("Tools are enabled"));
            assert!(!r.prompt().contains("Do not use tools"));
            r.conversation_only = true;
            assert!(r.prompt().contains("Do not use tools"));
            let exe = Executable {
                provider: provider.into(),
                program: "synthetic-cli".into(),
                prefix: vec![],
                wsl: None,
            };
            let command = chat_command(&r, runtime.path(), &exe).await.unwrap();
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy())
                .collect();
            if provider == "codex" {
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--sandbox" && a[1] == "read-only"));
                assert!(args.iter().any(|a| a == "features.shell_tool=false"));
                assert!(args
                    .iter()
                    .any(|a| a == "features.apply_patch_freeform=false"));
                assert!(args.iter().any(|a| a == "--ignore-user-config"));
                assert!(!args
                    .iter()
                    .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
            } else {
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--tools" && a[1].is_empty()));
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--permission-mode" && a[1] == "dontAsk"));
                assert!(args.iter().any(|a| a == "--safe-mode"));
                assert!(args.iter().any(|a| a == "--strict-mcp-config"));
            }
        }
        let mut r = request();
        r.agent.provider = "gemini".into();
        assert!(r.prompt().contains("Do not use tools"));
    }
    #[tokio::test]
    async fn selected_folder_is_cli_cwd_and_runtime_files_stay_in_app_data() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Project 'quoted' $(literal) 日本語");
        let runtime = root.path().join("runtime");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        for provider in ["codex", "claude", "gemini"] {
            let mut r = at_folder(project.to_str().unwrap());
            r.agent.provider = provider.into();
            let exe = Executable {
                provider: provider.into(),
                program: "synthetic-cli".into(),
                prefix: vec![],
                wsl: None,
            };
            let command = chat_command(&r, &runtime, &exe).await.unwrap();
            assert_eq!(command.as_std().get_current_dir(), Some(project.as_path()));
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy())
                .collect();
            let args_contain =
                |flag: &str, value: &str| args.windows(2).any(|a| a[0] == flag && a[1] == value);
            match provider {
                "codex" => {
                    assert!(args.iter().any(|a| a == "app-server"));
                    assert!(args.iter().any(|a| a == "--stdio"));
                    assert!(args_contain("-c", "features.shell_tool=true"));
                    assert!(args_contain("-c", "features.apply_patch_freeform=true"));
                    assert!(args_contain("-c", "features.multi_agent=true"));
                    assert!(args_contain("-c", "web_search=\"live\""));
                    assert!(!args.iter().any(|a| matches!(
                        a.as_ref(),
                        "--ignore-user-config" | "--ignore-rules" | "--sandbox"
                    )));
                }
                "claude" => {
                    assert!(args_contain("--tools", "default"));
                    assert!(args_contain("--permission-mode", "bypassPermissions"));
                    assert!(!args.iter().any(|a| matches!(
                        a.as_ref(),
                        "--safe-mode" | "--strict-mcp-config" | "--disable-slash-commands"
                    )));
                }
                _ => {
                    assert!(args_contain("--add-dir", project.to_str().unwrap()));
                    assert!(args_contain("--add-dir", runtime.to_str().unwrap()));
                    assert!(runtime.join(".agents/hooks.json").is_file());
                }
            }
            assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
            r.location = None;
            assert_eq!(
                chat_command(&r, &runtime, &exe)
                    .await
                    .unwrap()
                    .as_std()
                    .get_current_dir(),
                Some(runtime.as_path())
            );
            for bad_path in [project.join("missing"), runtime.join("plain-file")] {
                if bad_path.file_name().unwrap() == "plain-file" {
                    std::fs::write(&bad_path, "fixture").unwrap();
                }
                r.location = at_folder(bad_path.to_str().unwrap()).location;
                assert!(chat_command(&r, &runtime, &exe)
                    .await
                    .unwrap_err()
                    .contains("selected folder is unavailable"));
                assert!(!project.join("missing").exists());
            }
        }
    }
    #[tokio::test]
    async fn wsl_folder_is_passed_as_data_to_the_linux_launcher() {
        let runtime = tempfile::tempdir().unwrap();
        let path = "/tmp/Project 'quoted' $(literal) 日本語";
        let r = at_folder(path);
        let launch = crate::wsl::Launch {
            distribution: "Ubuntu".into(),
            namespace: "agent-studio-test".into(),
            job: uuid::Uuid::new_v4().to_string(),
        };
        let prefix = launch.prefix("claude", "/bin/claude", "existing");
        let prefix_len = prefix.len();
        let exe = Executable {
            provider: "claude".into(),
            program: "wsl.exe".into(),
            prefix,
            wsl: Some(launch),
        };
        let command = chat_command(&r, runtime.path(), &exe).await.unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy())
            .collect();
        assert_eq!(
            &args[prefix_len..prefix_len + 2],
            ["--agent-studio-cwd", path]
        );
        assert!(!args[7].contains(path));
        assert_eq!(command.as_std().get_current_dir(), Some(runtime.path()));
        assert!(
            chat_command(&at_folder("relative/path"), runtime.path(), &exe)
                .await
                .is_err()
        );
    }
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in Windows/Ubuntu filesystem and native process check; no provider prompts"]
    async fn real_windows_process_keeps_the_selected_wsl_working_directory() {
        let native_tmp = crate::folders::windows_path("Ubuntu", "/tmp")
            .await
            .unwrap();
        let project = tempfile::Builder::new()
            .prefix("agent-studio-desktop-wsl-")
            .tempdir_in(&native_tmp)
            .unwrap();
        assert!(project.path().starts_with(&native_tmp));
        let name = "Project 'quoted' $(literal) 日本語";
        let directory = project.path().join(name);
        std::fs::create_dir(&directory).unwrap();
        let linux = format!(
            "/tmp/{}/{name}",
            project.path().file_name().unwrap().to_string_lossy()
        );
        let runtime = tempfile::tempdir().unwrap();
        let script = runtime.path().join("native-cwd.ps1");
        std::fs::write(&script, "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::Out.Write((Get-Location).ProviderPath)\n").unwrap();
        let exe = Executable {
            provider: "claude".into(),
            program: "powershell.exe".into(),
            prefix: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-File".into(),
                script.to_string_lossy().into_owned(),
            ],
            wsl: None,
        };
        crate::profiles::scope(
            crate::profiles::Profile {
                id: uuid::Uuid::new_v4().to_string(),
                provider: "claude".into(),
                folder_distribution: Some("Ubuntu".into()),
                ..Default::default()
            },
            async {
                let request = at_folder(&linux);
                let mut command = chat_command(&request, runtime.path(), &exe).await.unwrap();
                assert_eq!(
                    command.as_std().get_current_dir(),
                    Some(directory.as_path())
                );
                let output = command.output().await.unwrap();
                assert!(output.status.success(), "Native fixture process failed");
                assert_eq!(
                    PathBuf::from(String::from_utf8(output.stdout).unwrap()),
                    directory
                );
                assert_eq!(request.location.unwrap().path, linux);
                assert!(std::fs::read_dir(&directory).unwrap().next().is_none());
                assert!(chat_command(
                    &at_folder(&format!("{linux}/missing")),
                    runtime.path(),
                    &exe
                )
                .await
                .unwrap_err()
                .contains("selected folder is unavailable"));
                assert!(
                    crate::folders::windows_path("Ubuntu", "/tmp/with\\backslash")
                        .await
                        .is_err()
                );
            },
        )
        .await;
    }
    #[tokio::test]
    #[ignore = "Opt-in real Antigravity reply using the existing login and temporary fixture directories"]
    async fn real_gemini_reports_selected_workspace_with_external_runtime_hooks() {
        use tokio::io::AsyncWriteExt;
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("Selected project 'quoted' $(literal)");
        let runtime = root.path().join("runtime");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        let mut r = at_folder(project.to_str().unwrap());
        r.agent.provider = "gemini".into();
        r.agent.model = "gemini-3.8-flash".into();
        r.agent.reasoning = "low".into();
        r.messages[0].text = "Without calling tools, reply with only the absolute path of the selected project workspace directory listed in your session context. Ignore the app runtime workspace.".into();
        let exe = resolve("gemini").await.unwrap();
        let mut child = chat_command(&r, &runtime, &exe)
            .await
            .unwrap()
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(r.stdin_payload().as_bytes())
            .await
            .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(output.status.success(), "Antigravity process failed");
        let mut decoder = crate::protocol::Decoder::default();
        for line in String::from_utf8(output.stdout).unwrap().lines() {
            decoder.decode("gemini", line);
        }
        assert!(decoder.completed);
        assert!(decoder.failure.is_none());
        assert!(
            decoder
                .text
                .replace("\\\\", "\\")
                .to_lowercase()
                .contains(&project.to_string_lossy().to_lowercase()),
            "Reply did not identify the selected fixture workspace: {}",
            decoder.text
        );
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
    }
    #[test]
    fn chat_selection_reaches_each_cli_with_explicit_effort() {
        let mut r = request();
        r.agent.model = "sonnet".into();
        r.agent.reasoning = "high".into();
        assert_eq!(
            selection_args(&r.agent),
            ["--model", "sonnet", "--effort", "high"]
        );
        r.agent.provider = "codex".into();
        r.agent.model = "gpt-6-astra".into();
        assert_eq!(
            selection_args(&r.agent),
            [
                "--model",
                "gpt-6-astra",
                "-c",
                "model_reasoning_effort=\"high\""
            ]
        );
        r.agent.provider = "gemini".into();
        r.agent.model = "gemini-3.8-flash".into();
        assert_eq!(
            selection_args(&r.agent),
            ["--model", "gemini-3.8-flash-high", "--effort", "high"]
        );
        r.agent.reasoning = "max".into();
        assert!(r.validate().is_err());
        r.agent.reasoning = "high\"; run()".into();
        assert!(r.validate().is_err());
    }
    #[test]
    fn gemini_login_requires_a_successful_account_check() {
        let reply = r#"{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{}}}"#;
        assert_eq!(gemini_login_result(true, reply, ""), LoginCheck::Ready);
        assert_eq!(gemini_login_result(false, reply, ""), LoginCheck::Unknown);
        assert_eq!(
            gemini_login_result(
                false,
                r#"{"status":"ERROR","error":"Authentication required"}"#,
                ""
            ),
            LoginCheck::Login
        );
        assert_eq!(
            gemini_login_result(true, r#"{"status":"SUCCESS","response":"Hello"}"#, ""),
            LoginCheck::Unknown
        );
        assert_eq!(
            gemini_login_result(true, "not JSON", ""),
            LoginCheck::Unknown
        );
        assert_eq!(
            gemini_login_result(
                true,
                r#"{"status":"SUCCESS","command":{"name":"help"}}"#,
                ""
            ),
            LoginCheck::Unknown
        );
        assert_eq!(
            gemini_login_result(
                false,
                "",
                "Authentication required. Please visit the URL to log in:"
            ),
            LoginCheck::Login
        );
        assert_eq!(
            gemini_login_result(false, "", "connection timed out"),
            LoginCheck::Unknown
        );
        assert_eq!(
            gemini_login_result(true, reply, "startup: not signed in yet"),
            LoginCheck::Ready
        );
    }
    #[tokio::test]
    async fn gemini_preflight_uses_only_a_headless_account_query() {
        let directory = tempfile::tempdir().unwrap();
        for (result, expected) in [
            (
                r#"{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{}}}"#,
                LoginCheck::Ready,
            ),
            (
                r#"{"status":"ERROR","error":"Authentication required"}"#,
                LoginCheck::Login,
            ),
            (
                r#"{"status":"ERROR","error":"Network unavailable"}"#,
                LoginCheck::Unknown,
            ),
        ] {
            let script = directory.path().join(if cfg!(windows) {
                "query.ps1"
            } else {
                "query.sh"
            });
            let (program, prefix) = if cfg!(windows) {
                std::fs::write(&script, format!(
                    "if (($args -join '|') -ne '--print|/usage|--output-format|json') {{ exit 9 }}\nif ([Console]::In.ReadToEnd().Length -ne 0) {{ exit 8 }}\n[Console]::Out.WriteLine('{result}')\n"
                )).unwrap();
                (
                    "powershell.exe",
                    vec![
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-File".into(),
                        script.to_string_lossy().into_owned(),
                    ],
                )
            } else {
                std::fs::write(&script, format!("[ \"$*\" = '--print /usage --output-format json' ] || exit 9\n[ -z \"$(cat)\" ] || exit 8\nprintf '%s\\n' '{result}'\n")).unwrap();
                ("/bin/sh", vec![script.to_string_lossy().into_owned()])
            };
            let exe = Executable {
                provider: "gemini".into(),
                program: program.into(),
                prefix,
                wsl: None,
            };
            let cancel = tokio_util::sync::CancellationToken::new();
            assert_eq!(check_gemini_login(&exe, &cancel).await, expected);
            assert_eq!(
                require_gemini_login(&exe, &cancel).await.is_ok(),
                expected == LoginCheck::Ready
            );
        }
    }
    #[test]
    fn prompts_preserve_untrusted_text_as_data() {
        let r = request();
        assert!(r.validate().is_ok());
        let prompt = r.prompt();
        let (_, json) = prompt.split_once('\n').unwrap();
        let data: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(data["conversation"][0]["text"], r.messages[0].text);
    }
    #[test]
    fn gemini_uses_antigravity_and_never_falls_back_to_legacy_cli() {
        let dir = tempfile::tempdir().unwrap();
        let executable = |name: &str| {
            dir.path().join(if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            })
        };
        std::fs::write(executable("gemini"), "legacy").unwrap();
        let dirs = vec![dir.path().to_owned()];
        assert!(resolve_in("gemini", &dirs)
            .unwrap_err()
            .contains("Antigravity"));
        std::fs::write(executable("agy"), "current").unwrap();
        assert_eq!(
            resolve_in("gemini", &dirs).unwrap().program,
            executable("agy")
        );
    }
    #[test]
    fn gemini_sends_one_json_message_on_stdin() {
        let mut r = request();
        r.agent.provider = "gemini".into();
        let payload = r.stdin_payload();
        assert_eq!(payload.lines().count(), 1);
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["event"], "user");
        assert_eq!(value["message"]["content"], r.prompt());
    }
    #[test]
    fn invalid_inputs_never_spawn() {
        let mut r = request();
        r.agent.provider = "powershell".into();
        assert!(r.validate().is_err());
        r.agent.provider = "claude".into();
        r.agent.model = "--help".into();
        assert!(r.validate().is_err());
        r.agent.model.clear();
        r.messages[0].text.clear();
        assert!(r.validate().is_err());
    }
    #[test]
    fn login_launcher_quotes_paths_and_keeps_shell_expressions_literal() {
        let exe = Executable {
            provider: "gemini".into(),
            program: PathBuf::from("C:/Program Files/Node/node.exe"),
            prefix: vec!["C:/O'Brien/$data/cli.js".into()],
            wsl: None,
        };
        let script = login_script(&exe, "gemini", Path::new("C:/App Data/login"));
        assert!(script.contains("& 'C:/Program Files/Node/node.exe' 'C:/O''Brien/$data/cli.js'"));
        assert!(script.contains("Set-Location -LiteralPath 'C:/App Data/login'"));
    }
}
