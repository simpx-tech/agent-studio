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
//! WSL distributions and other systems run their hooks through another shell and have no named
//! pipe to this app: their Codex chats are not held yet.
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

/// The session flag that adds the gate before every shell command.
pub fn hook_flag(command: &str) -> String {
    format!(
        "hooks.PreToolUse=[{{matcher = \"^Bash$\", hooks = [{{type = \"command\", command = {}, timeout = {TIMEOUT_SECONDS}}}]}}]",
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

/// The gate for a Windows Codex chat with tools, or None where it cannot run: another system or a
/// WSL distribution, no pipe, or a Codex that did not report the gate's trust.
pub async fn launch(
    exe: &crate::providers::Executable,
    conversation: &str,
    data: &Path,
) -> Option<Launch> {
    if !cfg!(windows) || exe.wsl.is_some() {
        return None;
    }
    let pipe = PIPE.get()?.clone();
    let command = hook_command(&std::env::current_exe().ok()?);
    let trust = trust(exe, data, &command).await?;
    Some(Launch {
        flags: vec![hook_flag(&command), trust_flag(&trust)],
        env: vec![(PIPE_ENV, pipe), (CHAT_ENV, conversation.into())],
    })
}

/// The Codex executable and hook command the trust holds for.
fn identity(exe: &crate::providers::Executable, command: &str) -> Option<String> {
    let meta = std::fs::metadata(&exe.program).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!(
        "{}|{}|{modified}|{command}",
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
    let file = data.join("reservations").join("codex-gate.json");
    let mut saved: HashMap<String, Trust> = std::fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let trust = match saved.get(&identity) {
        Some(trust) => trust.clone(),
        None => {
            let trust = probe(exe, data, command).await?;
            saved.insert(identity.clone(), trust.clone());
            if let Some(folder) = file.parent() {
                let _ = std::fs::create_dir_all(folder);
            }
            let _ = std::fs::write(&file, serde_json::to_vec(&saved).ok()?);
            trust
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
/// its key and hash. It starts no thread or turn.
async fn probe(exe: &crate::providers::Executable, data: &Path, command: &str) -> Option<Trust> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut c = exe.command();
    c.args(["app-server", "--stdio", "-c", &hook_flag(command)])
        .current_dir(data)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = c.spawn().ok()?;
    let (mut input, output) = (child.stdin.take()?, child.stdout.take()?);
    let folder = data.to_string_lossy().into_owned();
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
    crate::runner::kill_tree(&mut child).await;
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

/// One question of the gate: may this chat run this command? Messages other chats sent the
/// chat's own agent come with the answer.
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
            let deny = broker.gate(chat, command, request["call"].as_str(), "pc_wait");
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

/// What the app answers the gate.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    /// Why the command must wait.
    pub deny: Option<String>,
    /// Messages for the chat's agent, while its command runs.
    pub context: Option<String>,
}

/// Asks the app on `pipe` whether `chat` may run `command` in `thread`. Nothing when the app
/// does not answer, since a gate that fails holds nothing.
pub fn ask(
    pipe: &str,
    chat: &str,
    command: &str,
    call: Option<&str>,
    thread: Option<&str>,
) -> Reply {
    asked(pipe, chat, command, call, thread).unwrap_or_default()
}

fn asked(
    pipe: &str,
    chat: &str,
    command: &str,
    call: Option<&str>,
    thread: Option<&str>,
) -> Option<Reply> {
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
        json!({"chat": chat, "command": command, "call": call, "thread": thread})
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
    if let Some(output) = refusal(&input, |command, call, thread| {
        ask(&pipe, &chat, command, call, thread)
    }) {
        print!("{output}");
    }
    0
}

/// The hook's output for its input, given how the app answers.
fn refusal(
    input: &str,
    ask: impl FnOnce(&str, Option<&str>, Option<&str>) -> Reply,
) -> Option<String> {
    let hook: Value = serde_json::from_str(input).ok()?;
    if hook["hook_event_name"] != "PreToolUse" {
        return None;
    }
    let command = hook["tool_input"]["command"].as_str().unwrap_or_default();
    let thread = hook["session_id"].as_str();
    // The call's activity identity, as the tool decoder names a Codex call.
    let call = match (thread, hook["tool_use_id"].as_str()) {
        (Some(thread), Some(id)) => Some(format!("codex:{thread}:{id}")),
        _ => None,
    };
    let output = match ask(command, call.as_deref(), thread) {
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
        assert_eq!(group["matcher"].as_str(), Some("^Bash$"));
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
        let output = refusal(&input, |command, call, thread| {
            asked = Some((
                command.to_string(),
                call.map(String::from),
                thread.map(String::from),
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
        let context = refusal(&input, |_, _, _| Reply {
            deny: None,
            context: Some("A message from another chat.".into()),
        })
        .unwrap();
        let context: Value = serde_json::from_str(&context).unwrap();
        assert_eq!(
            context["hookSpecificOutput"],
            json!({"hookEventName":"PreToolUse","additionalContext":"A message from another chat."})
        );
        assert!(refusal(&input, |_, _, _| Reply::default()).is_none());
        assert!(refusal("not json", |_, _, _| panic!("never asked")).is_none());
        let other = json!({"hook_event_name":"PostToolUse"}).to_string();
        assert!(refusal(&other, |_, _, _| panic!("never asked")).is_none());
    }

    /// Run with `cargo test --lib installed_codex -- --ignored` on a computer with Codex.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "starts the installed Codex CLI's app-server, without a thread or turn"]
    async fn the_installed_codex_reports_the_gate_trust() {
        let exe = crate::providers::resolve("codex").await.unwrap();
        let data = tempfile::tempdir().unwrap();
        let command = hook_command(Path::new(r"C:\Program Files\Agent Studio\agent-studio.exe"));
        let trust = probe(&exe, data.path(), &command).await.unwrap();
        assert!(trust.key.contains("session-flags"), "{trust:?}");
        assert!(trust.hash.starts_with("sha256:"), "{trust:?}");
        // The same definition gets the same hash.
        assert_eq!(probe(&exe, data.path(), &command).await.unwrap(), trust);
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
                ask(&name, chat, command, Some("codex:t:c"), Some(thread))
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
        // No app on the pipe: the command runs.
        assert_eq!(
            ask(
                r"\\.\pipe\agent-studio-pc-nobody",
                "ui",
                "cargo build",
                None,
                None
            ),
            Reply::default()
        );
    }
}
