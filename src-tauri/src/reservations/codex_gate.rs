//! Holding a Codex chat's commands while another chat holds this computer (docs/RESERVATIONS.md),
//! as Claude chats' own gate does (`tools::Session::gate`). Codex runs `preToolUse` hooks before a
//! shell command and blocks the command when one denies it with a reason. Each Windows Codex chat
//! starts its app-server with one such hook given as a session flag (`-c hooks.PreToolUse=...`):
//! this app's own program in its gate mode (`GATE_ARG`), which asks the running app over a named
//! pipe whether the command may run and prints Codex's refusal when it may not. Codex runs hook
//! commands through PowerShell on Windows, so the program is called with `&` (a quoted program
//! alone failed, and Codex lets a command through when its hook fails).
//!
//! Codex runs a session-flag hook only once it is trusted by the hash Codex gives its
//! definition, which Codex does not document. The app asks Codex for it instead: once per Codex
//! executable and hook command, an app-server started with the hook and no thread lists its hooks
//! (`hooks/list`), and the key and hash it reports go with every launch after
//! (`-c hooks.state={...}`, which Codex merges with the user's own trust entries). Both are kept
//! in memory and in app data `reservations/codex-gate.json`. Found 2026-11-24 on Codex 0.172.
//!
//! A Codex chat in a WSL distribution this computer manages gets the same hook, run by the
//! distribution's shell: this Windows program at the path the distribution reaches it by
//! (`/mnt/<drive>/…`), started through WSL's interop, with the pipe and the chat passed into the
//! distribution and back out through `WSLENV` (requested 2026-11-24). A distribution without
//! interop cannot run it, and its commands go ahead as when any hook fails. Other systems have no
//! named pipe to this app: their Codex chats are not held yet.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// The argument that runs this program as Codex's gate hook.
pub const GATE_ARG: &str = "--pc-gate";
/// Where the gate finds the running app, and the chat it asks for: set on each Codex chat's
/// app-server, whose hooks inherit them.
const PIPE_ENV: &str = "AGENT_STUDIO_PC_PIPE";
const CHAT_ENV: &str = "AGENT_STUDIO_PC_CHAT";
/// How long Codex waits for the gate, which answers at once.
const TIMEOUT_SECONDS: u64 = 30;

/// The named pipe this app answers the gate on.
static PIPE: OnceLock<String> = OnceLock::new();
/// Trust Codex gave the gate, by Codex executable and hook command.
static TRUSTED: Mutex<Option<HashMap<String, Trust>>> = Mutex::new(None);

/// The key and hash Codex trusts a session-flag hook by.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Trust {
    pub key: String,
    pub hash: String,
}

/// A TOML basic string, as Codex reads `-c` values.
fn toml_string(text: &str) -> String {
    let mut out = String::from('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The hook command: this program in its gate mode, called as PowerShell calls a quoted path.
fn hook_command(program: &Path) -> String {
    format!(
        "& '{}' {GATE_ARG}",
        program.to_string_lossy().replace('\'', "''")
    )
}

/// The hook command inside a WSL distribution: this Windows program, at the path the
/// distribution reaches it by, run through WSL's interop by the distribution's shell.
fn wsl_hook_command(program: &str) -> String {
    format!("'{}' {GATE_ARG}", program.replace('\'', r"'\''"))
}

/// Where a WSL distribution reaches a program of this computer's drives: `/mnt/<drive>/…`.
fn linux_program(program: &Path) -> Option<String> {
    let text = program.to_string_lossy();
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    let mut chars = text.chars();
    let drive = chars.next().filter(char::is_ascii_alphabetic)?;
    if chars.next() != Some(':') {
        return None;
    }
    Some(format!(
        "/mnt/{}{}",
        drive.to_ascii_lowercase(),
        text[2..].replace('\\', "/")
    ))
}

/// The tools the gate is asked about: shell commands, which Codex names `Bash` to hooks, and every
/// MCP server's tools, which it names `mcp__<server>__<tool>` (Codex's hooks documentation).
const GATED: &str = "^(Bash|mcp__.+)$";

/// The session flag that adds the gate before every shell command and MCP tool call.
pub fn hook_flag(command: &str) -> String {
    format!(
        "hooks.PreToolUse=[{{matcher = {}, hooks = [{{type = \"command\", command = {}, timeout = {TIMEOUT_SECONDS}}}]}}]",
        toml_string(GATED),
        toml_string(command)
    )
}

/// The session flag that trusts the gate.
pub fn trust_flag(trust: &Trust) -> String {
    format!(
        "hooks.state={{{} = {{trusted_hash = {}}}}}",
        toml_string(&trust.key),
        toml_string(&trust.hash)
    )
}

/// What a Codex chat's app-server takes to run the gate: its `-c` values and environment.
pub struct Launch {
    pub flags: Vec<String>,
    pub env: Vec<(&'static str, String)>,
}

/// The gate for a Codex chat with tools, on Windows or in one of its WSL distributions, or None
/// where it cannot run: another system, no pipe, or a Codex that did not report the gate's trust.
pub async fn launch(
    exe: &crate::providers::Executable,
    conversation: &str,
    data: &Path,
) -> Option<Launch> {
    if !cfg!(windows) {
        return None;
    }
    let pipe = PIPE.get()?.clone();
    let program = std::env::current_exe().ok()?;
    let mut env = vec![(PIPE_ENV, pipe), (CHAT_ENV, conversation.to_string())];
    let command = match &exe.wsl {
        None => hook_command(&program),
        Some(_) => {
            // The pipe and the chat cross into the distribution with the launch and back out to
            // this program with the hook: WSLENV names them without a direction.
            env.push((
                "WSLENV",
                crate::wsl::passing(&format!("{PIPE_ENV}:{CHAT_ENV}")),
            ));
            wsl_hook_command(&linux_program(&program)?)
        }
    };
    let trust = trust(exe, data, &command).await?;
    Some(Launch {
        flags: vec![hook_flag(&command), trust_flag(&trust)],
        env,
    })
}

/// The Codex executable and hook the trust holds for: the whole session flag, since Codex trusts
/// a hash of the hook's definition, matcher included, and skips a hook whose definition changed.
/// A WSL Codex is named by its launch, which this computer cannot read the file of, so its trust
/// is kept for the run alone.
fn identity(exe: &crate::providers::Executable, command: &str) -> Option<String> {
    let hook = hook_flag(command);
    if exe.wsl.is_some() {
        return Some(format!(
            "wsl|{}|{hook}",
            crate::wsl::reusable_prefix(exe).join("\u{1f}")
        ));
    }
    let meta = std::fs::metadata(&exe.program).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!(
        "{}|{}|{modified}|{hook}",
        exe.program.display(),
        meta.len()
    ))
}

async fn trust(exe: &crate::providers::Executable, data: &Path, command: &str) -> Option<Trust> {
    let identity = identity(exe, command)?;
    if let Some(trust) = TRUSTED
        .lock()
        .ok()?
        .as_ref()
        .and_then(|known| known.get(&identity))
        .cloned()
    {
        return Some(trust);
    }
    let trust = if exe.wsl.is_some() {
        probe(exe, data, "/", command).await?
    } else {
        let file = data.join("reservations").join("codex-gate.json");
        let mut saved: HashMap<String, Trust> = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        match saved.get(&identity) {
            Some(trust) => trust.clone(),
            None => {
                let trust = probe(exe, data, &data.to_string_lossy(), command).await?;
                saved.insert(identity.clone(), trust.clone());
                if let Some(folder) = file.parent() {
                    let _ = std::fs::create_dir_all(folder);
                }
                let _ = std::fs::write(&file, serde_json::to_vec(&saved).ok()?);
                trust
            }
        }
    };
    if let Ok(mut known) = TRUSTED.lock() {
        known
            .get_or_insert_with(HashMap::new)
            .insert(identity, trust.clone());
    }
    Some(trust)
}

/// Asks Codex for the gate's trust: an app-server started with the hook lists it, untrusted, with
/// its key and hash, for `folder` as Codex reaches it. It starts no thread or turn, and ends as
/// any CLI of this app ends, with its input, so a WSL one leaves nothing behind.
async fn probe(
    exe: &crate::providers::Executable,
    data: &Path,
    folder: &str,
    command: &str,
) -> Option<Trust> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut c = exe.command();
    c.args(["app-server", "--stdio", "-c", &hook_flag(command)])
        .current_dir(data)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = c.spawn().ok()?;
    let (mut input, output) = (child.stdin.take()?, child.stdout.take()?);
    let asked = async {
        let mut lines = BufReader::new(output).lines();
        let send = |value: Value| format!("{value}\n");
        input
            .write_all(send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_studio","version":"0.1.0"},"capabilities":{"experimentalApi":true}}})).as_bytes())
            .await
            .ok()?;
        loop {
            let value: Value =
                serde_json::from_str(&lines.next_line().await.ok()??).unwrap_or_default();
            if value["id"] == 1 {
                break;
            }
        }
        input
            .write_all(
                format!(
                    "{}{}",
                    send(json!({"method":"initialized"})),
                    send(json!({"id":2,"method":"hooks/list","params":{"cwds":[folder]}}))
                )
                .as_bytes(),
            )
            .await
            .ok()?;
        loop {
            let value: Value =
                serde_json::from_str(&lines.next_line().await.ok()??).unwrap_or_default();
            if value["id"] == 2 {
                return gate_trust(&value, command);
            }
        }
    };
    // A liveness bound: an app-server that never answers is not waited for.
    let trust = tokio::time::timeout(std::time::Duration::from_secs(60), asked)
        .await
        .ok()
        .flatten();
    exe.end(child, Some(input), None, None).await;
    trust
}

/// The gate's trust in a `hooks/list` answer: the session-flag hook running `command`.
fn gate_trust(answer: &Value, command: &str) -> Option<Trust> {
    answer["result"]["data"]
        .as_array()?
        .iter()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .find(|hook| hook["source"] == "sessionFlags" && hook["command"] == command)
        .and_then(|hook| {
            Some(Trust {
                key: hook["key"].as_str()?.into(),
                hash: hook["currentHash"].as_str()?.into(),
            })
        })
}

/// Answers the gate on a named pipe of its own for as long as the app runs.
#[cfg(windows)]
pub fn serve(broker: std::sync::Arc<super::Broker>) {
    let name = format!(
        r"\\.\pipe\agent-studio-pc-{}",
        uuid::Uuid::new_v4().simple()
    );
    let _ = PIPE.set(name.clone());
    // A pipe belongs to the runtime that made it, so it is made and served in one task of the
    // app's runtime. A gate that asks before it is made lets its command run.
    tauri::async_runtime::spawn(async move {
        let _ = listen(&name, broker, None).await;
    });
}

/// Serves the gate on `name` until the pipe fails, telling `ready` once it accepts questions.
#[cfg(windows)]
async fn listen(
    name: &str,
    broker: std::sync::Arc<super::Broker>,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let next = || {
        ServerOptions::new()
            .reject_remote_clients(true)
            .create(name)
    };
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(name)?;
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    loop {
        if server.connect().await.is_err() {
            server = next()?;
            continue;
        }
        let connected = std::mem::replace(&mut server, next()?);
        let broker = broker.clone();
        tokio::spawn(async move {
            let _ = answer(connected, &broker).await;
        });
    }
}

/// One question of the gate: may this chat run this command, or call this MCP tool? Messages
/// other chats sent the chat's own agent come with the answer.
#[cfg(windows)]
async fn answer(
    pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    broker: &super::Broker,
) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (read, mut write) = tokio::io::split(pipe);
    let mut line = String::new();
    BufReader::new(read).read_line(&mut line).await?;
    let request: Value = serde_json::from_str(&line).unwrap_or_default();
    let reply = match (request["chat"].as_str(), request["command"].as_str()) {
        (Some(chat), Some(command)) => {
            let deny = decide(
                broker,
                chat,
                request["tool"].as_str().unwrap_or_default(),
                command,
                request["call"].as_str(),
            );
            // A sub-agent works in a thread of its own: messages wait for the chat's own agent.
            let messages = request["thread"]
                .as_str()
                .filter(|thread| broker.main_thread(chat, thread))
                .and_then(|_| broker.deliver(chat));
            match (deny, messages) {
                (Some(deny), Some(messages)) => json!({"deny": format!("{deny}\n\n{messages}")}),
                (Some(deny), None) => json!({"deny": deny}),
                (None, Some(messages)) => json!({"context": messages}),
                (None, None) => json!({}),
            }
        }
        _ => json!({}),
    };
    write.write_all(format!("{reply}\n").as_bytes()).await?;
    write.flush().await
}

/// Whether `chat` must wait to call the hook's `tool`: an MCP server's tool, or else the shell
/// with `command`. Agent Studio's own tools, pc_wait among them, answer for themselves.
#[cfg(any(windows, test))]
fn decide(
    broker: &super::Broker,
    chat: &str,
    tool: &str,
    command: &str,
    call: Option<&str>,
) -> Option<String> {
    match crate::protocol::activity::mcp_tool(tool) {
        Some((server, called)) => broker.gate_call(chat, server, called, call, "pc_wait"),
        None if tool.starts_with("mcp__") => None,
        None => broker.gate(chat, command, call, "pc_wait"),
    }
}

/// What the app answers the gate.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    /// Why the command must wait.
    pub deny: Option<String>,
    /// Messages for the chat's agent, while its command runs.
    pub context: Option<String>,
}

/// What the gate asks the app: the hook's tool, the command a shell call runs, the call's
/// activity identity and the thread it was made in.
pub struct Question<'a> {
    pub tool: &'a str,
    pub command: &'a str,
    pub call: Option<&'a str>,
    pub thread: Option<&'a str>,
}

/// Asks the app on `pipe` whether `chat` may make the call `question` names. Nothing when the
/// app does not answer, since a gate that fails holds nothing.
pub fn ask(pipe: &str, chat: &str, question: &Question) -> Reply {
    asked(pipe, chat, question).unwrap_or_default()
}

fn asked(pipe: &str, chat: &str, question: &Question) -> Option<Reply> {
    use std::io::{BufRead, BufReader, Write};
    // Between two questions the pipe has no instance waiting for a moment.
    let mut file = None;
    for _ in 0..40 {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe)
        {
            Ok(opened) => {
                file = Some(opened);
                break;
            }
            Err(error) if error.raw_os_error() == Some(231) => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            Err(_) => return None,
        }
    }
    let mut file = file?;
    writeln!(
        file,
        "{}",
        json!({"chat": chat, "tool": question.tool, "command": question.command, "call": question.call, "thread": question.thread})
    )
    .ok()?;
    let mut line = String::new();
    BufReader::new(file).read_line(&mut line).ok()?;
    let reply: Value = serde_json::from_str(&line).ok()?;
    Some(Reply {
        deny: reply["deny"].as_str().map(String::from),
        context: reply["context"].as_str().map(String::from),
    })
}

/// This program as Codex's gate hook: reads the hook's input, asks the app, and prints Codex's
/// refusal when the command must wait, or the messages the chat's agent reads as it runs.
/// Always exits 0: a gate that fails lets the command run.
pub fn gate_main() -> i32 {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let (Ok(pipe), Ok(chat)) = (std::env::var(PIPE_ENV), std::env::var(CHAT_ENV)) else {
        return 0;
    };
    if let Some(output) = refusal(&input, |question| ask(&pipe, &chat, question)) {
        print!("{output}");
    }
    0
}

/// The hook's output for its input, given how the app answers.
fn refusal(input: &str, ask: impl FnOnce(&Question) -> Reply) -> Option<String> {
    let hook: Value = serde_json::from_str(input).ok()?;
    if hook["hook_event_name"] != "PreToolUse" {
        return None;
    }
    let thread = hook["session_id"].as_str();
    // The call's activity identity, as the tool decoder names a Codex call.
    let call = match (thread, hook["tool_use_id"].as_str()) {
        (Some(thread), Some(id)) => Some(format!("codex:{thread}:{id}")),
        _ => None,
    };
    let question = Question {
        tool: hook["tool_name"].as_str().unwrap_or_default(),
        command: hook["tool_input"]["command"].as_str().unwrap_or_default(),
        call: call.as_deref(),
        thread,
    };
    let output = match ask(&question) {
        Reply {
            deny: Some(reason), ..
        } => json!({"hookSpecificOutput":{
            "hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason
        }}),
        Reply {
            context: Some(context),
            ..
        } => json!({"hookSpecificOutput":{
            "hookEventName":"PreToolUse","additionalContext":context
        }}),
        Reply { .. } => return None,
    };
    Some(output.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flags_are_toml_codex_reads() {
        let command = hook_command(Path::new(
            r"C:\Users\O'Neil\AppData\Local\Agent Studio\agent-studio.exe",
        ));
        assert_eq!(
            command,
            r"& 'C:\Users\O''Neil\AppData\Local\Agent Studio\agent-studio.exe' --pc-gate"
        );
        let hook: toml::Value = toml::from_str(&hook_flag(&command)).unwrap();
        let group = &hook["hooks"]["PreToolUse"][0];
        assert_eq!(group["matcher"].as_str(), Some(GATED));
        // Codex tests the matcher as a regular expression against the hook's tool name.
        let gated = regex::Regex::new(GATED).unwrap();
        assert!(gated.is_match("Bash") && gated.is_match("mcp__unreal-mcp__execute_python"));
        assert!(!gated.is_match("apply_patch") && !gated.is_match("update_plan"));
        assert_eq!(group["hooks"][0]["type"].as_str(), Some("command"));
        assert_eq!(
            group["hooks"][0]["command"].as_str(),
            Some(command.as_str())
        );
        assert_eq!(group["hooks"][0]["timeout"].as_integer(), Some(30));
        let trust = Trust {
            key: r"C:\<session-flags>\config.toml:pre_tool_use:0:0".into(),
            hash: "sha256:745fe2".into(),
        };
        let state: toml::Value = toml::from_str(&trust_flag(&trust)).unwrap();
        assert_eq!(
            state["hooks"]["state"][trust.key.as_str()]["trusted_hash"].as_str(),
            Some("sha256:745fe2")
        );
        assert_eq!(toml_string("a\tb"), "\"a\\u0009b\"");
    }

    #[test]
    fn the_trust_is_read_from_the_session_flag_hook_running_the_gate() {
        let command = "& 'C:\\app.exe' --pc-gate";
        let answer = json!({"id":2,"result":{"data":[{"cwd":"C:\\x","hooks":[
            {"key":"C:\\Users\\u\\.codex\\config.toml:pre_tool_use:0:0","source":"user","command":command,"currentHash":"sha256:user"},
            {"key":"C:\\<session-flags>\\config.toml:pre_tool_use:0:0","source":"sessionFlags","command":"node other.mjs","currentHash":"sha256:other"},
            {"key":"C:\\<session-flags>\\config.toml:pre_tool_use:1:0","source":"sessionFlags","command":command,"currentHash":"sha256:gate","trustStatus":"untrusted"}
        ]}]}});
        assert_eq!(
            gate_trust(&answer, command),
            Some(Trust {
                key: "C:\\<session-flags>\\config.toml:pre_tool_use:1:0".into(),
                hash: "sha256:gate".into()
            })
        );
        assert_eq!(gate_trust(&json!({"error":{"code":1}}), command), None);
    }

    #[test]
    fn the_hook_refuses_only_what_the_app_refuses_and_names_the_call() {
        let input = json!({"session_id":"t1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cargo build"},"tool_use_id":"exec-1"}).to_string();
        let mut asked = None;
        let output = refusal(&input, |question| {
            asked = Some((
                question.tool.to_string(),
                question.command.to_string(),
                question.call.map(String::from),
                question.thread.map(String::from),
            ));
            Reply {
                deny: Some("Wait for the benchmark.".into()),
                context: None,
            }
        })
        .unwrap();
        assert_eq!(
            asked,
            Some((
                "Bash".into(),
                "cargo build".into(),
                Some("codex:t1:exec-1".into()),
                Some("t1".into())
            ))
        );
        let output: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            output["hookSpecificOutput"]["permissionDecisionReason"],
            "Wait for the benchmark."
        );
        // Messages reach the agent beside a command that runs.
        let context = refusal(&input, |_| Reply {
            deny: None,
            context: Some("A message from another chat.".into()),
        })
        .unwrap();
        let context: Value = serde_json::from_str(&context).unwrap();
        assert_eq!(
            context["hookSpecificOutput"],
            json!({"hookEventName":"PreToolUse","additionalContext":"A message from another chat."})
        );
        assert!(refusal(&input, |_| Reply::default()).is_none());
        assert!(refusal("not json", |_| panic!("never asked")).is_none());
        let other = json!({"hook_event_name":"PostToolUse"}).to_string();
        assert!(refusal(&other, |_| panic!("never asked")).is_none());
        // An MCP call goes by its tool's name, its arguments carrying no command.
        let mcp = json!({"session_id":"t1","hook_event_name":"PreToolUse","tool_name":"mcp__unreal-mcp__execute_python","tool_input":{"code":"print(1)"},"tool_use_id":"call-2"}).to_string();
        refusal(&mcp, |question| {
            assert_eq!(
                (question.tool, question.command),
                ("mcp__unreal-mcp__execute_python", "")
            );
            Reply::default()
        });
    }

    #[test]
    fn the_app_holds_mcp_calls_but_not_its_own_tools() {
        let broker = super::super::Broker::new(
            Box::new(|_| {}),
            Box::new(|_| Some("Chunk benchmark".into())),
            Box::new(Vec::new),
            None,
        );
        broker.reserve("run-bench", "bench", "Benchmark", None);
        let deny = |tool: &str, command: &str| decide(&broker, "ui", tool, command, None);
        let reason = deny("mcp__unreal-mcp__execute_python", "").unwrap();
        assert!(reason.starts_with("This tool call did not run"), "{reason}");
        assert!(reason.contains("Call pc_wait"), "{reason}");
        assert!(deny("mcp__agent_studio__pc_wait", "").is_none());
        assert!(deny("mcp__codex_apps__github_search", "").is_none());
        assert!(deny("Bash", "cargo build")
            .unwrap()
            .starts_with("This command did not run"));
        assert!(deny("Bash", "git status").is_none());
    }

    #[test]
    fn a_wsl_codex_runs_this_program_at_the_path_its_distribution_reaches() {
        assert_eq!(
            linux_program(Path::new(
                r"C:\Users\O'Neil\AppData\Local\Agent Studio\agent-studio.exe"
            ))
            .as_deref(),
            Some("/mnt/c/Users/O'Neil/AppData/Local/Agent Studio/agent-studio.exe")
        );
        assert_eq!(
            linux_program(Path::new(r"\\?\D:\Apps\agent-studio.exe")).as_deref(),
            Some("/mnt/d/Apps/agent-studio.exe")
        );
        assert_eq!(linux_program(Path::new(r"\\server\share\a.exe")), None);
        let command = wsl_hook_command("/mnt/c/Users/O'Neil/Agent Studio/agent-studio.exe");
        assert_eq!(
            command,
            r"'/mnt/c/Users/O'\''Neil/Agent Studio/agent-studio.exe' --pc-gate"
        );
        let hook: toml::Value = toml::from_str(&hook_flag(&command)).unwrap();
        assert_eq!(
            hook["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str(),
            Some(command.as_str())
        );
    }

    /// Run with `cargo build` first, then `cargo test --lib
    /// the_gate_answers_a_wsl_hook_through_interop -- --ignored` on a computer with a WSL
    /// distribution (AGENT_STUDIO_TEST_WSL, Ubuntu by default) whose interop is on.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "runs the built app's gate inside a WSL distribution"]
    async fn the_gate_answers_a_wsl_hook_through_interop() {
        use std::process::Stdio;
        use tokio::io::AsyncWriteExt;
        let app = std::env::current_exe()
            .unwrap()
            .parent()
            .and_then(Path::parent)
            .map(|debug| debug.join("agent-studio.exe"))
            .unwrap();
        assert!(app.exists(), "build the app first: {}", app.display());
        let broker = super::super::Broker::new(
            Box::new(|_| {}),
            Box::new(|_| Some("Chunk benchmark".into())),
            Box::new(Vec::new),
            None,
        );
        let name = format!(
            r"\\.\pipe\agent-studio-pc-test-{}",
            uuid::Uuid::new_v4().simple()
        );
        let (ready, accepting) = tokio::sync::oneshot::channel();
        tokio::spawn({
            let (name, broker) = (name.clone(), broker.clone());
            async move { listen(&name, broker, Some(ready)).await }
        });
        accepting.await.unwrap();
        broker.reserve("run-bench", "bench", "Benchmark", None);
        let distribution =
            std::env::var("AGENT_STUDIO_TEST_WSL").unwrap_or_else(|_| "Ubuntu".into());
        let command = wsl_hook_command(&linux_program(&app).unwrap());
        let ask = |input: Value| {
            let (name, distribution, command) =
                (name.clone(), distribution.clone(), command.clone());
            async move {
                let mut child = tokio::process::Command::new("wsl.exe")
                    .args([
                        "--distribution",
                        &distribution,
                        "--exec",
                        "sh",
                        "-c",
                        &command,
                    ])
                    .env(PIPE_ENV, &name)
                    .env(CHAT_ENV, "ui")
                    .env(
                        "WSLENV",
                        crate::wsl::passing(&format!("{PIPE_ENV}:{CHAT_ENV}")),
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .creation_flags(0x08000000)
                    .spawn()
                    .unwrap();
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(input.to_string().as_bytes()).await.unwrap();
                drop(stdin);
                let output = child.wait_with_output().await.unwrap();
                String::from_utf8_lossy(&output.stdout).into_owned()
            }
        };
        let hook = |command: &str| json!({"session_id":"t1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":command},"tool_use_id":"exec-1"});
        let refused: Value = serde_json::from_str(ask(hook("cargo build")).await.trim()).unwrap();
        assert_eq!(refused["hookSpecificOutput"]["permissionDecision"], "deny");
        let reason = refused["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap();
        assert!(reason.contains("the chat \"Chunk benchmark\""), "{reason}");
        // A light command runs, and so does every command once the computer is free.
        assert_eq!(ask(hook("git status")).await.trim(), "");
        // One hook asks once: one command waited.
        let report = broker.release("bench").unwrap();
        assert_eq!(report.record["held"]["refused"], 1);
        assert_eq!(ask(hook("cargo build")).await.trim(), "");
    }

    /// Run with `cargo test --lib installed_codex -- --ignored` on a computer with Codex.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "starts the installed Codex CLI's app-server, without a thread or turn"]
    async fn the_installed_codex_reports_the_gate_trust() {
        let exe = crate::providers::resolve("codex").await.unwrap();
        let data = tempfile::tempdir().unwrap();
        let command = hook_command(Path::new(r"C:\Program Files\Agent Studio\agent-studio.exe"));
        let folder = data.path().to_string_lossy().into_owned();
        let trust = probe(&exe, data.path(), &folder, &command).await.unwrap();
        assert!(trust.key.contains("session-flags"), "{trust:?}");
        assert!(trust.hash.starts_with("sha256:"), "{trust:?}");
        // The same definition gets the same hash.
        assert_eq!(
            probe(&exe, data.path(), &folder, &command).await.unwrap(),
            trust
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_pipe_answers_whether_a_chat_may_run_a_command() {
        let broker = super::super::Broker::new(
            Box::new(|_| {}),
            Box::new(|_| Some("Chunk benchmark".into())),
            Box::new(Vec::new),
            None,
        );
        let name = format!(
            r"\\.\pipe\agent-studio-pc-test-{}",
            uuid::Uuid::new_v4().simple()
        );
        let (ready, accepting) = tokio::sync::oneshot::channel();
        tokio::spawn({
            let (name, broker) = (name.clone(), broker.clone());
            async move { listen(&name, broker, Some(ready)).await }
        });
        accepting.await.unwrap();
        let ask_in = |chat: &'static str, command: &'static str, thread: &'static str| {
            let name = name.clone();
            tokio::task::spawn_blocking(move || {
                let question = Question {
                    tool: "Bash",
                    command,
                    call: Some("codex:t:c"),
                    thread: Some(thread),
                };
                ask(&name, chat, &question)
            })
        };
        let ask_now = |chat: &'static str, command: &'static str| ask_in(chat, command, "t");
        assert_eq!(
            ask_now("ui", "cargo build").await.unwrap(),
            Reply::default()
        );
        broker.reserve("run-bench", "bench", "Benchmark", None);
        let reason = ask_now("ui", "cargo build").await.unwrap().deny.unwrap();
        assert!(reason.contains("Call pc_wait"), "{reason}");
        assert!(reason.contains("the chat \"Chunk benchmark\""), "{reason}");
        assert_eq!(ask_now("ui", "git status").await.unwrap(), Reply::default());
        assert_eq!(
            ask_now("bench", "cargo build").await.unwrap(),
            Reply::default()
        );
        // Questions side by side all get their answer.
        let answers =
            futures_util::future::join_all((0..8).map(|_| ask_now("ui", "npm test"))).await;
        assert!(answers
            .into_iter()
            .all(|answer| answer.unwrap().deny.is_some()));
        // A message goes to the chat's own agent, never to a sub-agent's thread.
        broker.run_started("run-ui", "ui");
        broker.attach("run-ui", "ui", None);
        broker.thread("run-ui", "t");
        broker
            .message("bench", "ui", "Close your editor when you can.", false)
            .unwrap();
        assert_eq!(
            ask_in("ui", "git status", "sub-agent").await.unwrap(),
            Reply::default()
        );
        let context = ask_now("ui", "git status").await.unwrap().context.unwrap();
        assert!(
            context.contains("Close your editor when you can."),
            "{context}"
        );
        // An MCP call that drives a program here waits like a command.
        let mcp = {
            let name = name.clone();
            tokio::task::spawn_blocking(move || {
                let question = Question {
                    tool: "mcp__unreal-mcp__execute_python",
                    command: "",
                    call: None,
                    thread: Some("t"),
                };
                ask(&name, "other", &question)
            })
        };
        let reason = mcp.await.unwrap().deny.unwrap();
        assert!(reason.starts_with("This tool call did not run"), "{reason}");
        // No app on the pipe: the command runs.
        let question = Question {
            tool: "Bash",
            command: "cargo build",
            call: None,
            thread: None,
        };
        assert_eq!(
            ask(r"\\.\pipe\agent-studio-pc-nobody", "ui", &question),
            Reply::default()
        );
    }
}
