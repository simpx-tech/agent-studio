use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
pub mod background;
pub mod claude_settings;
pub mod codex_chat;
pub mod defaults;
pub mod elicitation;
mod elicitation_schema;
#[cfg(windows)]
mod login_console;
pub mod questions;
pub mod sessions;
pub mod steering;
pub mod visualize;

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
    // The signed-in identity the CLI itself reports (Claude's account email). It is
    // bounded session metadata for recognising an already connected login, never a credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
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
        account: None,
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
                let (ready, account) = claude_login(&v);
                s.auth = if ready { "ready" } else { "login" }.into();
                s.account = account;
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
// `claude auth status` reports whether the selected configuration directory is signed in and,
// when it is, the account email. Only that bounded identity is kept; tokens are never read.
fn claude_login(status: &serde_json::Value) -> (bool, Option<String>) {
    let ready = status["loggedIn"].as_bool().unwrap_or(false);
    let account = status["email"]
        .as_str()
        .map(str::trim)
        .filter(|email| ready && !email.is_empty())
        .map(|email| email.chars().take(200).collect());
    (ready, account)
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub history_revision: u64,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(skip)]
    pub native_session: Option<sessions::Session>,
    #[serde(skip)]
    pub shared_context: crate::shared_context::SharedContext,
    // Host-resolved selected-profile default for an in-band model reset.
    #[serde(skip)]
    pub claude_default_model: Option<String>,
    #[serde(default)]
    pub workflow: Option<serde_json::Value>,
    pub run_id: String,
    // The renderer switched this conversation to another account of the same agent.
    // Version 2 native bindings detect that themselves; legacy bindings need this
    // explicit request before a mismatched account may start a fresh session.
    #[serde(default)]
    pub account_switch: bool,
    // Portable forks with prior messages still receive a new Standalone folder.
    #[serde(default)]
    pub forked: bool,
    // Internal background requests must never inherit interactive chat permissions.
    #[serde(skip)]
    pub conversation_only: bool,
    #[serde(default)]
    pub location: Option<crate::folders::ChatLocation>,
    pub agent: Agent,
    // Workspace-wide instructions appended to the system prompt of Claude chats.
    #[serde(default)]
    pub claude_instructions: Option<String>,
    pub messages: Vec<ChatMessage>,
}
#[derive(Clone, Deserialize)]
pub struct Agent {
    #[serde(default, rename = "fastMode")]
    pub fast_mode: Option<bool>,
    #[serde(default, rename = "fallbackModel")]
    pub fallback_model: Option<String>,
    #[serde(default, rename = "maxThinkingTokens")]
    pub max_thinking_tokens: Option<u32>,
    #[serde(default, rename = "outputSchema")]
    pub output_schema: Option<String>,
    #[serde(default, rename = "planMode")]
    pub plan_mode: bool,
    #[serde(default, rename = "autoCompactTokens")]
    pub auto_compact_tokens: Option<u64>,
    pub provider: String,
    pub model: String,
    pub instructions: String,
    #[serde(default)]
    pub reasoning: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct SkillReference {
    pub name: String,
    pub path: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<images::ChatImage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<crate::mentions::Mention>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visualizations: Vec<visualize::Visualization>,
}
mod images;
impl RunRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.agent.fast_mode.is_some() || self.agent.fallback_model.is_some() {
            if self.conversation_only || self.agent.provider != "claude" {
                return Err(
                    "Fast mode and fallback models are available only for Claude chats.".into(),
                );
            }
            if let Some(value) = &self.agent.fallback_model {
                let models: Vec<_> = value.split(',').collect();
                let pattern =
                    regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*(?:\[1m\])?$").unwrap();
                let unique: std::collections::HashSet<_> = models.iter().collect();
                if value.len() > 302
                    || models.len() > 3
                    || unique.len() != models.len()
                    || models.iter().any(|m| m.len() > 100 || !pattern.is_match(m))
                {
                    return Err("Enter up to three distinct fallback model aliases or IDs, separated by commas.".into());
                }
            }
        }
        if let Some(tokens) = self.agent.max_thinking_tokens {
            if self.conversation_only || self.agent.provider != "claude" {
                return Err("A thinking-token budget is available only for Claude chats.".into());
            }
            if tokens != 0 && !(1024..=128_000).contains(&tokens) {
                return Err(
                    "Claude thinking budget must be 0 (off) or between 1,024 and 128,000 tokens."
                        .into(),
                );
            }
        }
        if let Some(schema) = &self.agent.output_schema {
            if self.conversation_only || !matches!(self.agent.provider.as_str(), "claude" | "codex")
            {
                return Err(
                    "Structured output is available only for Claude and Codex chats.".into(),
                );
            }
            crate::structured_output::schema(schema)?;
        }
        if self.agent.plan_mode
            && (self.conversation_only
                || !matches!(self.agent.provider.as_str(), "claude" | "codex"))
        {
            return Err("Plan mode is available only for Claude and Codex chats.".into());
        }
        if self
            .agent
            .auto_compact_tokens
            .is_some_and(|n| !(100_000..=1_000_000).contains(&n))
        {
            return Err(
                "Claude auto-compaction size must be between 100,000 and 1,000,000 tokens.".into(),
            );
        }
        if self.compact
            && (self.conversation_only
                || self.conversation_id.is_none()
                || !matches!(self.agent.provider.as_str(), "claude" | "codex")
                || !self.messages.last().is_some_and(|m| {
                    m.role == "user"
                        && m.text.chars().count() <= 30_000
                        && m.images.is_empty()
                        && m.skills.is_empty()
                        && m.mentions.is_empty()
                        && (m.text.trim() == "/compact"
                            || (self.agent.provider == "claude"
                                && m.text
                                    .strip_prefix("/compact")
                                    .is_some_and(|rest| rest.starts_with(char::is_whitespace))))
                }))
        {
            return Err("Compaction requires an existing Claude or Codex conversation and a plain /compact request.".into());
        }
        if self.history_revision > 9_007_199_254_740_991 {
            return Err("Invalid history revision".into());
        }
        if let Some(id) = &self.conversation_id {
            uuid::Uuid::parse_str(id).map_err(|_| "Invalid conversation id")?;
        }
        if self.workflow.is_some() {
            return Err("The app-owned step sequencer was removed. Ask Claude to run a native Workflow or a saved /workflow-name command.".into());
        }
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
        if let Some(text) = &self.claude_instructions {
            if self.conversation_only || self.agent.provider != "claude" {
                return Err("Claude chat instructions apply only to Claude chats.".into());
            }
            if text.chars().count() > 4000 || text.contains('\0') {
                return Err("Claude chat instructions must be at most 4,000 characters.".into());
            }
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
        if self
            .messages
            .iter()
            .flat_map(|m| &m.visualizations)
            .map(|v| v.source.len())
            .sum::<usize>()
            > 8_000_000
        {
            return Err("Visualization history is too large. Start a new conversation.".into());
        }
        for message in &self.messages {
            if !message.mentions.is_empty()
                && (!self.uses_codex_server()
                    || message.role != "user"
                    || message.mentions.len() > 16
                    || message.mentions.iter().any(|m| {
                        !crate::mentions::valid(m)
                            || !crate::mentions::has_token(&message.text, &m.token)
                    }))
            {
                return Err("Invalid Codex mention input".into());
            }
            if !visualize::valid_history(&message.visualizations)
                || (!message.visualizations.is_empty()
                    && (message.role != "assistant"
                        || !(self.uses_codex_server() || self.uses_claude_visualizer())))
            {
                return Err("Invalid visualization history".into());
            }
            if !message.skills.is_empty()
                && (!self.uses_codex_server()
                    || message.role != "user"
                    || message.skills.len() > 4
                    || message.skills.iter().any(|skill| {
                        skill.name.is_empty()
                            || skill.name.len() > 200
                            || !skill
                                .name
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "-_:.".contains(c))
                            || skill.path.is_empty()
                            || skill.path.len() > 4096
                            || skill.path.chars().any(char::is_control)
                    }))
            {
                return Err("Invalid Codex skill reference".into());
            }
            if message.images.is_empty() {
                continue;
            }
            if !self.tools_enabled()
                || !matches!(self.agent.provider.as_str(), "codex" | "claude")
                || message.role != "user"
            {
                return Err(
                    "Image attachments are available only in Codex and Claude user messages".into(),
                );
            }
            if message.images.len() > images::MAX_IMAGES_PER_MESSAGE {
                return Err("Attach up to 16 images per message".into());
            }
            for image in &message.images {
                image.validate()?;
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
    pub(crate) fn tools_enabled(&self) -> bool {
        !self.conversation_only && valid_provider(&self.agent.provider)
    }
    pub fn uses_codex_server(&self) -> bool {
        self.agent.provider == "codex" && self.tools_enabled()
    }
    pub fn uses_claude_visualizer(&self) -> bool {
        self.agent.provider == "claude" && self.tools_enabled()
    }
    pub fn output_line_limit(&self) -> usize {
        // Providers can echo visual input in user-message lifecycle events.
        // Retain the text limit plus only already-validated visual payloads.
        2_000_000
            + self
                .messages
                .iter()
                .flat_map(|m| &m.images)
                .map(|image| image.data.len())
                .sum::<usize>()
            + self
                .messages
                .iter()
                .flat_map(|m| &m.visualizations)
                .map(|v| serde_json::to_string(v).map_or(0, |s| s.len()))
                .sum::<usize>()
                * 2
    }
    pub fn prompt(&self) -> String {
        // Image bytes are separate visual inputs, never text tokens or shell paths.
        let messages: Vec<_> = self
            .messages
            .iter()
            .map(|message| {
                let mut value = serde_json::json!({"role":message.role,"text":message.text});
                if !message.visualizations.is_empty() && self.tools_enabled() {
                    value["visualizations"] = serde_json::json!(message.visualizations);
                }
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
        format!("{}\n{context}", self.guidance())
    }
    pub fn guidance(&self) -> String {
        let tools = if self.tools_enabled() {
            "Tools are enabled in this conversation. Use available tools to inspect files, edit files, run commands, load applicable skills, search the web, and delegate independent work to sub-agents as needed to complete the user's requested work in the selected working directory. Use available task/plan tools to report progress on multi-step work. When delivering an HTML or SVG artifact, include its complete self-contained source in a fenced html or svg code block, optionally followed by a short title on the opening fence. Artifact previews support inline CSS and JavaScript, SVG and data images; they cannot load external scripts, styles, or network resources. Do not generate an artifact unless it serves the user's request. Follow applicable project instructions. Earlier messages may describe tools as disabled; that restriction no longer applies."
        } else {
            "Do not use tools, inspect files, execute commands, or delegate."
        };
        let visuals = if self.uses_codex_server() || self.uses_claude_visualizer() {
            visualize::GUIDANCE
        } else {
            ""
        };
        let questions = if self.uses_codex_server() || self.uses_claude_visualizer() {
            questions::GUIDANCE
        } else {
            ""
        };
        format!("You are having a conversation in Agent Studio. Answer the final user message using the earlier messages as context. {tools} {visuals} {questions} Format your response with Markdown where useful. The following JSON contains your agent instructions and ordered conversation messages:")
    }
    pub fn native_context(&self) -> Option<String> {
        let native = self.base_native_context();
        let shared = self.shared_context.guidance();
        if shared.is_empty() {
            if self
                .native_session
                .as_ref()
                .is_some_and(|s| s.shared_context_changed)
            {
                Some(format!("{}\nAccount context sharing is now disabled. Earlier shared source instructions are historical and no longer apply. Use the selected account's own context and current project and conversation instructions.", native.unwrap_or_default()))
            } else {
                native
            }
        } else {
            Some(format!("{}\n{}", native.unwrap_or_default(), shared))
        }
    }
    fn base_native_context(&self) -> Option<String> {
        let session = self.native_session.as_ref()?;
        if !session.resumed {
            let mut history = self.clone();
            history.messages.pop();
            Some(format!("{}\nThis is earlier context only. Answer the NEXT user message, not the history above.", history.prompt()))
        } else {
            let mut context = Vec::new();
            if session.instructions_changed {
                context.push(format!("Current user instructions for this conversation (replace earlier conversation instructions): {}", serde_json::to_string(&self.agent.instructions).unwrap()));
            }
            if let Some(index) = session.unconfirmed_message.filter(|_| !session.retry) {
                context.push(format!("Delivery of this earlier user message was interrupted before acknowledgment. Treat it as earlier context only; do not repeat side effects without inspecting existing results. Answer the NEXT user message: {}", serde_json::to_string(&self.messages[index].text).unwrap()));
            }
            if context.is_empty() {
                None
            } else {
                Some(context.join("\n"))
            }
        }
    }
    pub fn native_image_message(&self, index: usize) -> bool {
        self.native_session.as_ref().is_none_or(|s| {
            !s.resumed
                || s.unconfirmed_message == Some(index)
                || (!s.retry && index + 1 == self.messages.len())
        })
    }
    pub fn native_user_text(&self) -> String {
        if self.compact {
            return self
                .messages
                .last()
                .map(|m| m.text.clone())
                .unwrap_or_default();
        }
        if self.native_session.as_ref().is_some_and(|s| s.retry) {
            format!("Continue the previous request after an interrupted or failed attempt. Inspect existing changes and results before taking further actions; do not blindly repeat completed side effects. The user's request was: {}", self.messages.last().map(|m| m.text.as_str()).unwrap_or_default())
        } else {
            self.messages
                .last()
                .map(|m| m.text.clone())
                .unwrap_or_default()
        }
    }
    pub fn stdin_payload(&self) -> String {
        if self.agent.provider == "claude" {
            if !self.tools_enabled() {
                return format!(
                    "{}\n",
                    serde_json::json!({"type":"user","message":{"role":"user","content":self.prompt()}})
                );
            }
            if self.native_session.is_some() {
                let mut payload = String::new();
                if let Some(context) = self.native_context() {
                    let mut content = vec![serde_json::json!({"type":"text","text":context})];
                    {
                        for (index, message) in self
                            .messages
                            .iter()
                            .enumerate()
                            .take(self.messages.len() - 1)
                            .filter(|(i, _)| self.native_image_message(*i))
                        {
                            for (image_index, image) in message.images.iter().enumerate() {
                                content.push(serde_json::json!({"type":"text","text":image.label(index, image_index)}));
                                content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}}));
                            }
                        }
                    }
                    payload.push_str(&format!("{}\n", serde_json::json!({"type":"user","shouldQuery":false,"message":{"role":"user","content":content}})));
                }
                let mut content =
                    vec![serde_json::json!({"type":"text","text":self.native_user_text()})];
                if self.native_image_message(self.messages.len() - 1) {
                    for image in &self.messages.last().expect("validated conversation").images {
                        content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}}));
                    }
                }
                payload.push_str(&format!("{}\n", serde_json::json!({"type":"user","uuid":self.run_id,"origin":{"kind":"human"},"message":{"role":"user","content":content}})));
                return payload;
            }
            // Only the current user submission is human input. History and app
            // instructions must not opt a new turn into ultracode accidentally.
            let mut history = self.clone();
            let current = history.messages.pop().expect("validated conversation");
            let mut content = vec![
                serde_json::json!({"type":"text","text":format!("{}\nThis is earlier context only. Answer the NEXT user message, not the history above.", history.prompt())}),
            ];
            for (message_index, message) in history.messages.iter().enumerate() {
                for (image_index, image) in message.images.iter().enumerate() {
                    content.push(serde_json::json!({"type":"text","text":image.label(message_index, image_index)}));
                    content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}}));
                }
            }
            let context = serde_json::json!({"type":"user","shouldQuery":false,"message":{"role":"user","content":content}});
            let mut content = vec![serde_json::json!({"type":"text","text":current.text})];
            for image in current.images {
                content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":image.media_type,"data":image.data}}));
            }
            let input = serde_json::json!({"type":"user","uuid":self.run_id,"origin":{"kind":"human"},"message":{"role":"user","content":content}});
            format!("{context}\n{input}\n")
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
fn clear_legacy_gemini_chat_hook(runtime: &Path) -> Result<(), String> {
    // Older releases generated a deny-all hook here for Gemini chats. Remove
    // only that exact app-owned hook; project/profile hooks belong to the CLI.
    let path = runtime.join(".agents/hooks.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Cannot update the Gemini chat runtime".into()),
    };
    if serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .as_ref()
        == Some(&gemini_hooks())
    {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot remove the old Gemini chat restriction".into()),
        }
    }
    Ok(())
}
pub async fn chat_command(
    request: &RunRequest,
    runtime: &Path,
    exe: &Executable,
) -> Result<Command, String> {
    let standalone = crate::standalone::prepare(
        runtime.parent().ok_or("Cannot locate conversation data")?,
        request,
    )?;
    let dedicated = standalone.map(|id| {
        runtime
            .parent()
            .unwrap()
            .join("standalone")
            .join(id.to_string())
    });
    let runtime = dedicated
        .as_deref()
        .filter(|_| exe.wsl.is_none())
        .unwrap_or(runtime);
    if dedicated.is_some() && exe.wsl.is_none() {
        std::fs::create_dir_all(runtime).map_err(|_| "Cannot create this chat's working folder")?;
    }
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
        } else if let Some(id) = standalone {
            c.args(["--agent-studio-standalone", &id.to_string()]);
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
                    "features.mentions_v2=true",
                    "-c",
                    "features.apply_patch_freeform=true",
                    "-c",
                    "web_search=\"live\"",
                    "-c",
                    "features.multi_agent=true",
                ]);
                for entry in &request.shared_context.codex_overrides {
                    c.args(["-c", entry]);
                }
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
            ]);
            if let Some(session) = &request.native_session {
                if let Some(path) = &session.transfer_path {
                    c.args([
                        "--resume",
                        path,
                        "--fork-session",
                        "--session-id",
                        session.id(),
                    ]);
                } else {
                    c.args([
                        if session.resumed {
                            "--resume"
                        } else {
                            "--session-id"
                        },
                        session.id(),
                    ]);
                }
            } else {
                c.arg("--no-session-persistence");
            }
            c.args(["--input-format", "stream-json"]);
            if !request.compact {
                if let Some(schema) = &request.agent.output_schema {
                    c.arg("--json-schema").arg(schema);
                }
            }
            if request.tools_enabled() {
                c.args([
                    "--replay-user-messages",
                    "--include-hook-events",
                    "--forward-subagent-text",
                ]);
                crate::plugins::claude_args(&mut c, &crate::plugins::for_run(request));
                if let Some(tokens) = request.agent.auto_compact_tokens {
                    c.arg("--autocompact").arg(tokens.to_string());
                }
            }
            if request.tools_enabled() {
                if request.agent.plan_mode {
                    c.args([
                        "--permission-mode",
                        "plan",
                        "--allow-dangerously-skip-permissions",
                    ]);
                } else {
                    c.arg("--dangerously-skip-permissions");
                }
                let mut settings = serde_json::json!({
                    "env": {"CLAUDE_CODE_ENABLE_TODO_TOOLS": "1"},
                    "permissions": {"ask": ["EnterPlanMode", "ExitPlanMode"]}
                });
                if let Some(fast) = request.agent.fast_mode {
                    settings["fastMode"] = fast.into();
                }
                if let Some(directory) = &request.shared_context.memory_dir {
                    settings["autoMemoryDirectory"] = directory.clone().into();
                }
                if let Some(fallback) = &request.agent.fallback_model {
                    c.arg("--fallback-model").arg(fallback);
                }
                // A literal argument: system text, never replayed as conversation history.
                if let Some(text) = request
                    .claude_instructions
                    .as_deref()
                    .filter(|text| !text.trim().is_empty())
                {
                    c.arg("--append-system-prompt").arg(text);
                }
                // Shared MCP definitions ride along; the app's own SDK server keeps its name.
                let mut mcp = request.shared_context.mcp_servers.clone();
                mcp.insert(
                    "agent_studio".into(),
                    serde_json::json!({"type":"sdk","name":"agent_studio"}),
                );
                c.args([
                    "--tools",
                    "default",
                    "--permission-prompt-tool",
                    "stdio",
                    "--settings",
                    &settings.to_string(),
                    "--mcp-config",
                    &serde_json::json!({"mcpServers": mcp}).to_string(),
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
            // Antigravity print mode advertises registered workspace roots, not
            // just process cwd. Register the user's folder first as well.
            if let Some(path) = selected {
                c.arg("--add-dir").arg(path);
            }
            c.args([
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
            ]);
            if request.tools_enabled() {
                clear_legacy_gemini_chat_hook(runtime)?;
                c.args(["--dangerously-skip-permissions", "--mode", "accept-edits"]);
            } else {
                prepare_gemini_agent(runtime)?;
                // Background titles have their own runtime and retain deny-all
                // hooks. Never install these in a selected project directory.
                c.arg("--add-dir").arg(runtime);
                c.args([
                    "--agent",
                    "agent-studio-chat",
                    "--disable-slash-commands",
                    "--mode",
                    "plan",
                ]);
            }
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
            compact: false,
            history_revision: 0,
            conversation_id: None,
            native_session: None,
            shared_context: Default::default(),
            claude_default_model: None,
            workflow: None,
            conversation_only: false,
            account_switch: false,
            forked: false,
            location: None,
            run_id: uuid::Uuid::new_v4().to_string(),
            claude_instructions: None,
            agent: Agent {
                fast_mode: None,
                fallback_model: None,
                plan_mode: false,
                auto_compact_tokens: None,
                max_thinking_tokens: None,
                output_schema: None,
                provider: "claude".into(),
                model: String::new(),
                instructions: "Be concise".into(),
                reasoning: String::new(),
            },
            messages: vec![ChatMessage {
                role: "user".into(),
                text: "Quotes \" & $(echo) `hello`\nこんにちは".into(),
                images: vec![],
                skills: vec![],
                mentions: vec![],
                visualizations: vec![],
            }],
        }
    }
    #[tokio::test]
    async fn claude_fast_and_fallback_are_validated_literal_chat_launch_settings() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture".into(),
            prefix: vec![],
            wsl: None,
        };
        let baseline = crate::pool::fingerprint(&r, &exe).unwrap();
        for fast in [None, Some(false), Some(true)] {
            r.agent.fast_mode = fast;
            r.validate().unwrap();
            let c = chat_command(&r, root.path(), &exe).await.unwrap();
            let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy()).collect();
            let settings: serde_json::Value =
                serde_json::from_str(&args.windows(2).find(|a| a[0] == "--settings").unwrap()[1])
                    .unwrap();
            assert_eq!(settings.get("fastMode").and_then(|v| v.as_bool()), fast);
            assert_eq!(settings["env"]["CLAUDE_CODE_ENABLE_TODO_TOOLS"], "1");
            assert_eq!(
                settings["permissions"]["ask"],
                serde_json::json!(["EnterPlanMode", "ExitPlanMode"])
            );
            assert_eq!(
                baseline == crate::pool::fingerprint(&r, &exe).unwrap(),
                fast.is_none()
            );
            assert!(!args.iter().any(|a| a == "--fallback-model"));
        }
        r.agent.fast_mode = None;
        for fallback in [
            "sonnet",
            "sonnet,haiku",
            "default",
            "claude-opus-4-8[1m]",
            "us.anthropic.claude-sonnet-4-6-v1:0",
            "claude-sonnet-4-5@20250929",
        ] {
            r.agent.fallback_model = Some(fallback.into());
            r.validate().unwrap();
            assert_ne!(baseline, crate::pool::fingerprint(&r, &exe).unwrap());
            let c = chat_command(&r, root.path(), &exe).await.unwrap();
            let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy()).collect();
            assert!(args.windows(2).any(|a| a == ["--fallback-model", fallback]));
        }
        for fallback in [
            "",
            "sonnet,",
            "sonnet,sonnet",
            "a,b,c,d",
            "--flag",
            "$(echo)",
            "sonnet\nhaiku",
            "sonnet, haiku",
            &"a".repeat(101),
        ] {
            r.agent.fallback_model = Some(fallback.into());
            assert!(r.validate().is_err(), "accepted {fallback}");
        }
        r.agent.fallback_model = Some("sonnet".into());
        r.agent.fast_mode = Some(true);
        r.conversation_only = true;
        assert!(r.validate().is_err());
        let c = chat_command(&r, root.path(), &exe).await.unwrap();
        assert!(!c
            .as_std()
            .get_args()
            .any(|a| a == "--fallback-model" || a == "--settings"));
        r.conversation_only = false;
        r.agent.provider = "codex".into();
        assert!(r.validate().is_err());
        r.agent.provider = "gemini".into();
        assert!(r.validate().is_err());
    }
    #[tokio::test]
    async fn claude_chat_instructions_are_a_validated_literal_system_prompt_append() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture".into(),
            prefix: vec![],
            wsl: None,
        };
        let baseline = crate::pool::fingerprint(&r, &exe).unwrap();
        let text = "Run tests in the foreground.\nQuotes \" & $(echo) `x` stay literal.";
        r.claude_instructions = Some(text.into());
        r.validate().unwrap();
        assert_ne!(baseline, crate::pool::fingerprint(&r, &exe).unwrap());
        let c = chat_command(&r, root.path(), &exe).await.unwrap();
        let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy()).collect();
        assert!(args
            .windows(2)
            .any(|a| a == ["--append-system-prompt", text]));
        assert!(!r.stdin_payload().contains("Run tests in the foreground"));
        for blank in ["", " \n "] {
            r.claude_instructions = Some(blank.into());
            r.validate().unwrap();
            let c = chat_command(&r, root.path(), &exe).await.unwrap();
            assert!(!c.as_std().get_args().any(|a| a == "--append-system-prompt"));
        }
        r.claude_instructions = Some("é".repeat(4000));
        r.validate().unwrap();
        for invalid in ["é".repeat(4001), "null\0".into()] {
            r.claude_instructions = Some(invalid);
            assert!(r.validate().is_err());
        }
        r.claude_instructions = Some(text.into());
        r.conversation_only = true;
        assert!(r.validate().is_err());
        let c = chat_command(&r, root.path(), &exe).await.unwrap();
        assert!(!c.as_std().get_args().any(|a| a == "--append-system-prompt"));
        r.conversation_only = false;
        for provider in ["codex", "gemini"] {
            r.agent.provider = provider.into();
            assert!(r.validate().is_err());
        }
    }
    #[tokio::test]
    async fn plan_mode_launches_with_native_permissions_and_keeps_background_restricted() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture".into(),
            prefix: vec![],
            wsl: None,
        };
        for plan in [true, false] {
            r.agent.plan_mode = plan;
            r.validate().unwrap();
            let c = chat_command(&r, root.path(), &exe).await.unwrap();
            let args: Vec<_> = c
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            assert_eq!(
                args.iter().any(|a| a == "--dangerously-skip-permissions"),
                !plan
            );
            assert_eq!(
                args.iter()
                    .any(|a| a == "--allow-dangerously-skip-permissions"),
                plan
            );
            assert_eq!(
                args.windows(2).any(|a| a == ["--permission-mode", "plan"]),
                plan
            );
            let settings = args.windows(2).find(|a| a[0] == "--settings").unwrap();
            let settings: serde_json::Value = serde_json::from_str(&settings[1]).unwrap();
            assert_eq!(
                settings["permissions"]["ask"],
                serde_json::json!(["EnterPlanMode", "ExitPlanMode"])
            );
        }
        r.agent.plan_mode = true;
        r.conversation_only = true;
        assert!(r.validate().is_err());
        r.conversation_only = false;
        r.agent.provider = "gemini".into();
        assert!(r.validate().is_err());
    }
    #[tokio::test]
    async fn structured_output_arguments_validation_and_process_identity() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture".into(),
            prefix: vec![],
            wsl: None,
        };
        let baseline = crate::pool::fingerprint(&r, &exe).unwrap();
        let schema = r#"{"type":"object","description":"literal $(echo) `value`","properties":{},"additionalProperties":false}"#;
        r.agent.output_schema = Some(schema.into());
        r.validate().unwrap();
        assert_ne!(baseline, crate::pool::fingerprint(&r, &exe).unwrap());
        let command = chat_command(&r, root.path(), &exe).await.unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy())
            .collect();
        assert!(args.windows(2).any(|a| a == ["--json-schema", schema]));
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
        r.compact = true;
        let command = chat_command(&r, root.path(), &exe).await.unwrap();
        assert!(!command.as_std().get_args().any(|a| a == "--json-schema"));
        assert_eq!(baseline, crate::pool::fingerprint(&r, &exe).unwrap());
        r.compact = false;
        r.agent.provider = "gemini".into();
        assert!(r.validate().is_err());
        r.agent.provider = "claude".into();
        r.conversation_only = true;
        assert!(r.validate().is_err());
        r.conversation_only = false;
        r.agent.output_schema = Some("{".into());
        assert!(r.validate().is_err());
    }
    #[tokio::test]
    async fn compaction_sizes_are_validated_and_only_change_claude_chat_launches() {
        let root = tempfile::tempdir().unwrap();
        let mut r = request();
        r.agent.auto_compact_tokens = Some(150_000);
        let exe = Executable {
            provider: "claude".into(),
            program: "fixture".into(),
            prefix: vec![],
            wsl: None,
        };
        let command = chat_command(&r, root.path(), &exe).await.unwrap();
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy())
            .collect();
        assert!(args
            .windows(2)
            .any(|a| a[0] == "--autocompact" && a[1] == "150000"));
        r.conversation_only = true;
        assert!(!chat_command(&r, root.path(), &exe)
            .await
            .unwrap()
            .as_std()
            .get_args()
            .any(|a| a == "--autocompact"));
        r.agent.auto_compact_tokens = Some(99_999);
        assert!(r.validate().is_err());
        r.agent.auto_compact_tokens = Some(1_000_001);
        assert!(r.validate().is_err());
        r.conversation_only = false;
        r.agent.auto_compact_tokens = None;
        r.compact = true;
        assert!(r.validate().is_err());
        r.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        r.messages[0].text = "/compact".into();
        assert!(r.validate().is_ok());
        r.agent.provider = "gemini".into();
        assert!(r.validate().is_err());
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
    async fn standalone_chats_keep_separate_persistent_working_directories() {
        let data = tempfile::tempdir().unwrap();
        let runtime = data.path().join("chat-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let exe = Executable {
            provider: "codex".into(),
            program: "codex".into(),
            prefix: vec![],
            wsl: None,
        };
        let mut a = request();
        a.agent.provider = "codex".into();
        a.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        let mut b = a.clone();
        b.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        let first = chat_command(&a, &runtime, &exe).await.unwrap();
        let second = chat_command(&b, &runtime, &exe).await.unwrap();
        let cwd = first.as_std().get_current_dir().unwrap();
        let other = second.as_std().get_current_dir().unwrap();
        assert_ne!(
            cwd, other,
            "Separate Standalone chats must not share their working folder"
        );
        std::fs::write(cwd.join("only-a.txt"), "retained").unwrap();
        assert!(!other.join("only-a.txt").exists());
        a.messages.push(a.messages[0].clone());
        let resumed = chat_command(&a, &runtime, &exe).await.unwrap();
        assert_eq!(resumed.as_std().get_current_dir(), Some(cwd));
        assert_eq!(
            std::fs::read_to_string(cwd.join("only-a.txt")).unwrap(),
            "retained"
        );
    }
    #[tokio::test]
    async fn background_requests_keep_tools_disabled() {
        let runtime = tempfile::tempdir().unwrap();
        for provider in ["codex", "claude", "gemini"] {
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
            } else if provider == "claude" {
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--tools" && a[1].is_empty()));
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--permission-mode" && a[1] == "dontAsk"));
                assert!(args.iter().any(|a| a == "--safe-mode"));
                assert!(!args.iter().any(|a| a == "--include-hook-events"));
                assert!(!args.iter().any(|a| a == "--forward-subagent-text"));
                assert!(args.iter().any(|a| a == "--strict-mcp-config"));
            } else {
                assert!(args.windows(2).any(|a| a[0] == "--mode" && a[1] == "plan"));
                assert!(args
                    .windows(2)
                    .any(|a| a[0] == "--agent" && a[1] == "agent-studio-chat"));
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(
                        &std::fs::read_to_string(runtime.path().join(".agents/hooks.json"))
                            .unwrap()
                    )
                    .unwrap(),
                    gemini_hooks()
                );
            }
            assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"));
        }
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
                    assert!(args.iter().any(|a| a == "--include-hook-events"));
                    assert!(args.iter().any(|a| a == "--forward-subagent-text"));
                    assert!(args_contain("--tools", "default"));
                    assert!(args_contain(
                        "--settings",
                        r#"{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"},"permissions":{"ask":["EnterPlanMode","ExitPlanMode"]}}"#
                    ));
                    assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
                    assert!(!args.iter().any(|a| matches!(
                        a.as_ref(),
                        "--safe-mode" | "--strict-mcp-config" | "--disable-slash-commands"
                    )));
                }
                _ => {
                    assert!(args_contain("--add-dir", project.to_str().unwrap()));
                    assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"));
                    assert!(args_contain("--mode", "accept-edits"));
                    assert!(!args.iter().any(|a| matches!(
                        a.as_ref(),
                        "--agent" | "--disable-slash-commands" | "--sandbox"
                    )));
                    assert!(!runtime.join(".agents/hooks.json").exists());
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
    async fn gemini_chat_removes_only_its_legacy_hook_and_preserves_background_restrictions() {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("chat-runtime");
        let title_runtime = root.path().join("title-runtime");
        prepare_gemini_agent(&runtime).unwrap();
        prepare_gemini_agent(&title_runtime).unwrap();
        let mut r = request();
        r.agent.provider = "gemini".into();
        let exe = Executable {
            provider: "gemini".into(),
            program: "synthetic-cli".into(),
            prefix: vec![],
            wsl: None,
        };
        let command = chat_command(&r, &runtime, &exe).await.unwrap();
        assert_eq!(command.as_std().get_current_dir(), Some(runtime.as_path()));
        assert!(!runtime.join(".agents/hooks.json").exists());
        assert!(title_runtime.join(".agents/hooks.json").is_file());
        assert!(r.prompt().contains("Tools are enabled"));
        assert!(!r.prompt().contains(visualize::GUIDANCE));
        let custom = r#"{"hooks":{"PreToolUse":[]},"custom":true}"#;
        std::fs::write(runtime.join(".agents/hooks.json"), custom).unwrap();
        chat_command(&r, &runtime, &exe).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(runtime.join(".agents/hooks.json")).unwrap(),
            custom
        );
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
    fn claude_login_reports_only_a_signed_in_account_email() {
        let signed_in =
            serde_json::json!({"loggedIn": true, "email": " person@example.com ", "orgId": "org"});
        assert_eq!(
            claude_login(&signed_in),
            (true, Some("person@example.com".to_string()))
        );
        let signed_out = serde_json::json!({"loggedIn": false, "email": "person@example.com"});
        assert_eq!(claude_login(&signed_out), (false, None));
        assert_eq!(
            claude_login(&serde_json::json!({"loggedIn": true})),
            (true, None)
        );
        assert_eq!(
            claude_login(&serde_json::json!({"loggedIn": true, "email": "   "})),
            (true, None)
        );
        let long = serde_json::json!({"loggedIn": true, "email": "a".repeat(300)});
        assert_eq!(claude_login(&long).1.map(|s| s.len()), Some(200));
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
    fn claude_stamps_only_current_human_input_and_rejects_legacy_sequencing() {
        let mut r = request();
        r.agent.provider = "claude".into();
        r.messages[0].text = "Earlier ultracode request".into();
        r.messages.push(ChatMessage {
            role: "user".into(),
            text: "/saved-audit today".into(),
            images: vec![],
            skills: vec![],
            mentions: vec![],
            visualizations: vec![],
        });
        let lines: Vec<serde_json::Value> = r
            .stdin_payload()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["shouldQuery"], false);
        assert!(lines[0]["origin"].is_null());
        assert_eq!(lines[1]["origin"]["kind"], "human");
        assert_eq!(
            lines[1]["message"]["content"][0]["text"],
            "/saved-audit today"
        );
        r.conversation_only = true;
        let background: serde_json::Value = serde_json::from_str(&r.stdin_payload()).unwrap();
        assert!(background["origin"].is_null());
        r.workflow = Some(serde_json::json!({"steps":[{"prompt":"legacy"}]}));
        assert!(r.validate().unwrap_err().contains("sequencer was removed"));
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
