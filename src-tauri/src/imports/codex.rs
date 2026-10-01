//! Codex threads, read through the selected profile's own `codex app-server`: `thread/list`
//! for listings and `thread/turns/list` for an import. Each turn's items replay through the
//! decoder a live reply uses, as the notifications that reported them.
use super::{Conversion, ImageInput, Reply, Turn, UserInput};
use crate::protocol::{Decoder, RunEvent};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// One response of the app-server; a page of turns with their items can be large.
const RESPONSE_LIMIT: usize = 256 * 1024 * 1024;
const PREVIEW: usize = 300;
/// What one import reads at most.
const TURN_LIMIT: usize = 10_000;
const BYTES_LIMIT: usize = 1024 * 1024 * 1024;
/// Steering inputs one reply keeps, as a live reply does.
const STEERING_LIMIT: usize = 8;

/// A thread a listing shows.
#[derive(Clone, Debug)]
pub struct Thread {
    pub id: String,
    pub name: Option<String>,
    pub preview: Option<String>,
    pub cwd: String,
    pub created: Option<i64>,
    pub updated: Option<i64>,
    pub model: Option<String>,
    pub originator: Option<String>,
    pub source: String,
    pub archived: bool,
}

/// The selected profile's app-server, for reading threads only.
struct Client {
    exe: crate::providers::Executable,
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
    next: u64,
}
impl Client {
    async fn start() -> Result<Self, String> {
        let exe = crate::providers::resolve("codex").await?;
        let mut child = exe
            .command()
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start Codex to read its chats")?;
        let input = child.stdin.take().ok_or("Missing Codex input")?;
        let output = BufReader::with_capacity(
            1024 * 1024,
            child.stdout.take().ok_or("Missing Codex output")?,
        );
        let mut client = Self {
            exe,
            child,
            input,
            output,
            next: 1,
        };
        client
            .call(
                "initialize",
                json!({"clientInfo":{"name":"agent_studio","version":"0.1.0"}}),
            )
            .await?;
        client
            .input
            .write_all(b"{\"method\":\"initialized\"}\n")
            .await
            .map_err(|_| "Codex stopped reading")?;
        Ok(client)
    }
    /// One line of output, refusing one past the response limit.
    async fn line(&mut self, line: &mut Vec<u8>) -> Result<bool, String> {
        line.clear();
        loop {
            let available = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "Codex output failed")?;
            if available.is_empty() {
                return Ok(!line.is_empty());
            }
            let (length, done) = match available.iter().position(|b| *b == b'\n') {
                Some(end) => (end + 1, true),
                None => (available.len(), false),
            };
            if line.len() + length > RESPONSE_LIMIT {
                return Err("A Codex chat record is too large to import".into());
            }
            line.extend_from_slice(&available[..length]);
            self.output.consume(length);
            if done {
                return Ok(true);
            }
        }
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        let request = json!({"id":id,"method":method,"params":params});
        self.input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|_| "Codex stopped reading")?;
        let mut line = Vec::new();
        let read = async {
            while self.line(&mut line).await? {
                let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                if v["id"] != id {
                    continue;
                }
                if v["error"].is_object() {
                    let message = v["error"]["message"]
                        .as_str()
                        .unwrap_or("Codex could not read this chat");
                    return Err(message.chars().take(300).collect::<String>());
                }
                return Ok(v["result"].clone());
            }
            Err("Codex exited before answering".into())
        };
        tokio::time::timeout(Duration::from_secs(120), read)
            .await
            .map_err(|_| "Codex took too long to read its chats".to_string())?
    }
    async fn close(mut self) {
        self.exe.kill(&mut self.child).await;
    }
}

fn text(value: &Value, limit: usize) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let line = s.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut chars = line.chars();
            let start: String = chars.by_ref().take(limit).collect();
            if chars.next().is_some() {
                format!("{start}…")
            } else {
                start
            }
        })
}

fn thread(value: &Value, archived: bool) -> Option<Thread> {
    let id = value["id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())?;
    Some(Thread {
        id: id.to_string(),
        name: text(&value["name"], 200),
        preview: text(&value["preview"], PREVIEW),
        cwd: value["cwd"].as_str().unwrap_or_default().to_string(),
        created: value["createdAt"].as_i64(),
        updated: value["updatedAt"].as_i64(),
        model: value["model"]
            .as_str()
            .map(|m| m.chars().take(100).collect()),
        originator: value["originator"]
            .as_str()
            .map(|o| o.chars().take(60).collect()),
        source: match &value["source"] {
            Value::String(source) => source.clone(),
            Value::Object(source) => source.keys().next().cloned().unwrap_or_default(),
            _ => String::new(),
        },
        archived,
    })
}

/// The selected profile's threads, newest first; sub-agent threads stay with their parents.
pub async fn list(limit: usize) -> Result<(Vec<Thread>, bool), String> {
    let mut client = Client::start().await?;
    let listed = async {
        let mut threads = vec![];
        let mut truncated = false;
        for archived in [false, true] {
            let mut cursor = Value::Null;
            loop {
                let page = client
                    .call(
                        "thread/list",
                        json!({"cursor":cursor,"limit":100,"sortKey":"updated_at",
                            "sourceKinds":["cli","vscode","exec","appServer","unknown"],
                            "archived":archived}),
                    )
                    .await?;
                for value in page["data"].as_array().into_iter().flatten() {
                    if let Some(thread) = thread(value, archived) {
                        if !threads.iter().any(|t: &Thread| t.id == thread.id) {
                            threads.push(thread);
                        }
                    }
                }
                if threads.len() >= limit {
                    truncated = true;
                    break;
                }
                match page["nextCursor"].as_str() {
                    Some(next) if !next.is_empty() => cursor = json!(next),
                    _ => break,
                }
            }
        }
        threads.truncate(limit);
        Ok::<_, String>((threads, truncated))
    }
    .await;
    client.close().await;
    listed
}

/// A thread's metadata and every turn with its items.
pub async fn read(id: &str) -> Result<(Value, Vec<Value>), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid Codex thread")?;
    let mut client = Client::start().await?;
    let read = async {
        let thread = client
            .call("thread/read", json!({"threadId":id,"includeTurns":false}))
            .await?["thread"]
            .clone();
        let mut turns = vec![];
        let mut bytes = 0;
        let mut cursor = Value::Null;
        loop {
            let page = client
                .call(
                    "thread/turns/list",
                    json!({"threadId":id,"cursor":cursor,"limit":10,"sortDirection":"asc","itemsView":"full"}),
                )
                .await?;
            bytes += page.to_string().len();
            if bytes > BYTES_LIMIT {
                return Err("This Codex chat is too large to import".to_string());
            }
            turns.extend(page["data"].as_array().cloned().unwrap_or_default());
            if turns.len() > TURN_LIMIT {
                return Err("This Codex chat has too many turns to import".to_string());
            }
            match page["nextCursor"].as_str() {
                Some(next) if !next.is_empty() => cursor = json!(next),
                _ => break,
            }
        }
        Ok((thread, turns))
    }
    .await;
    client.close().await;
    read
}

pub fn iso(seconds: Option<i64>) -> Option<String> {
    chrono::DateTime::from_timestamp(seconds?, 0).map(|t| t.to_rfc3339())
}

/// A user message's words and images, leaving out context Agent Studio sent ahead of them.
fn user_input(item: &Value, created_at: Option<String>) -> UserInput {
    let mut parts = vec![];
    let mut images = vec![];
    for part in item["content"].as_array().into_iter().flatten() {
        match part["type"].as_str() {
            Some("text") => {
                let text = part["text"].as_str().unwrap_or_default();
                if !super::studio_context(text) {
                    parts.push(text.to_string());
                }
            }
            Some("image") => {
                if let Some(data) = part["url"]
                    .as_str()
                    .and_then(|url| url.strip_prefix("data:"))
                    .and_then(|rest| rest.split_once(";base64,"))
                    .map(|(_, data)| data)
                {
                    images.push(ImageInput::Base64(data.to_string()));
                }
            }
            Some("localImage") => {
                if let Some(path) = part["path"].as_str() {
                    images.push(ImageInput::File(path.to_string()));
                }
            }
            _ => {}
        }
    }
    UserInput {
        text: parts.join("\n\n").trim().to_string(),
        images,
        created_at,
    }
}

struct Exchange {
    user: Option<UserInput>,
    decoder: Decoder,
    events: Vec<RunEvent>,
    outputs: Vec<crate::protocol::activity::CapturedOutput>,
    steering: Vec<String>,
    any: bool,
}
impl Exchange {
    fn new(user: Option<UserInput>, model: Option<&str>) -> Self {
        let mut decoder = Decoder::default();
        decoder.reported_model(model);
        Self {
            user,
            decoder,
            events: vec![],
            outputs: vec![],
            steering: vec![],
            any: false,
        }
    }
    fn notify(&mut self, root: &str, value: Value) {
        self.events
            .extend(self.decoder.decode_codex_server(&value, root));
        self.outputs.extend(self.decoder.take_tool_outputs());
    }
}

/// One reply per turn, through the notifications a live reply receives: each item completed,
/// then the turn. Messages sent while a turn ran are its steering, as Agent Studio records it.
pub fn convert(thread: &Value, turns: &[Value]) -> Conversion {
    let root = thread["id"].as_str().unwrap_or_default();
    let model = thread["model"].as_str().map(String::from);
    let reasoning = thread["reasoningEffort"].as_str().map(String::from);
    let mut converted = vec![];
    for turn in turns {
        let turn_id = turn["id"].as_str().unwrap_or_default();
        let started = iso(turn["startedAt"].as_i64());
        let mut exchanges: Vec<Exchange> = vec![Exchange::new(None, model.as_deref())];
        for item in turn["items"].as_array().into_iter().flatten() {
            let current = exchanges.last_mut().expect("an exchange");
            if item["type"] == "userMessage" {
                let input = user_input(item, started.clone());
                if input.text.is_empty() && input.images.is_empty() {
                    continue;
                }
                if current.user.is_none() && !current.any {
                    current.user = Some(input);
                } else if current.steering.len() < STEERING_LIMIT
                    && input.images.is_empty()
                    && !input.text.trim_start().starts_with('/')
                    && input.text.chars().count() <= 30_000
                    && current.steering.iter().map(String::len).sum::<usize>() + input.text.len()
                        <= 60_000
                {
                    current.steering.push(input.text);
                } else {
                    exchanges.push(Exchange::new(Some(input), model.as_deref()));
                }
                continue;
            }
            current.any = true;
            current.notify(
                root,
                json!({"method":"item/completed","params":{"threadId":root,"turnId":turn_id,"item":item}}),
            );
        }
        let count = exchanges.len();
        for (index, mut exchange) in exchanges.into_iter().enumerate() {
            let last = index + 1 == count;
            let status = if last {
                turn["status"].as_str().unwrap_or("completed")
            } else {
                "completed"
            };
            exchange.notify(
                root,
                json!({"method":"turn/completed","params":{"threadId":root,"turn":{"id":turn_id,"status":status,"error":if last {turn["error"].clone()} else {Value::Null}}}}),
            );
            let limited = exchange.decoder.usage_limit.clone();
            let (status, error) = match (status, limited) {
                (_, Some(limit)) => ("error", Some(limit.text)),
                ("interrupted", _) => ("cancelled", None),
                ("failed", _) => (
                    "error",
                    Some(
                        turn["error"]["message"]
                            .as_str()
                            .unwrap_or("Codex reported that this turn failed.")
                            .chars()
                            .take(2000)
                            .collect(),
                    ),
                ),
                _ => ("complete", None),
            };
            let reply = (exchange.any || !exchange.steering.is_empty()).then(|| Reply {
                events: super::coalesce(exchange.events),
                outputs: exchange.outputs,
                status,
                error,
                created_at: started.clone(),
                duration_ms: if last {
                    turn["durationMs"].as_u64().or_else(|| {
                        let begun = turn["startedAt"].as_i64()?;
                        let ended = turn["completedAt"].as_i64()?;
                        u64::try_from(ended - begun).ok().map(|s| s * 1000)
                    })
                } else {
                    None
                },
                model: model.clone(),
                reasoning: reasoning.clone(),
                steering: exchange.steering,
            });
            if exchange.user.is_some() || reply.is_some() {
                converted.push(Turn {
                    user: exchange.user,
                    reply,
                });
            }
        }
    }
    let created = iso(thread["createdAt"].as_i64());
    Conversion {
        title: thread["name"]
            .as_str()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(200).collect()),
        model,
        reasoning,
        cwd: thread["cwd"].as_str().map(String::from),
        created,
        updated: iso(thread["updatedAt"].as_i64()),
        turns: converted,
        notes: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_become_replies_with_their_work_answer_and_steering() {
        let thread = json!({"id":"019a0000-0000-7000-8000-000000000001","name":"Fix the menu","model":"gpt-6-astra","reasoningEffort":"low","cwd":"C:\\game","createdAt":1790000000,"updatedAt":1790000100});
        let turns = vec![
            json!({"id":"turn1","status":"completed","startedAt":1790000000,"completedAt":1790000009,"durationMs":9308,"items":[
                {"type":"userMessage","id":"u1","content":[{"type":"text","text":"Fix the menu","text_elements":[]},{"type":"image","url":"data:image/png;base64,AAAA"}]},
                {"type":"reasoning","id":"r1","summary":["Checking the menu code"],"content":[]},
                {"type":"agentMessage","id":"m1","text":"I'll check the menu.","phase":"commentary"},
                {"type":"commandExecution","id":"c1","command":"npm test","cwd":"C:\\game","status":"completed","exitCode":0,"aggregatedOutput":"ok\n","durationMs":1200},
                {"type":"userMessage","id":"u2","content":[{"type":"text","text":"Keep the old colors","text_elements":[]}]},
                {"type":"agentMessage","id":"m2","text":"Fixed, with the old colors.","phase":"final_answer"}
            ]}),
            json!({"id":"turn2","status":"interrupted","startedAt":1790000050,"items":[
                {"type":"userMessage","id":"u3","content":[{"type":"text","text":"Now the settings page","text_elements":[]}]},
                {"type":"agentMessage","id":"m3","text":"Looking at settings.","phase":"commentary"}
            ]}),
        ];
        let conversion = convert(&thread, &turns);
        assert_eq!(conversion.title.as_deref(), Some("Fix the menu"));
        assert_eq!(conversion.turns.len(), 2);
        let first = &conversion.turns[0];
        let user = first.user.as_ref().unwrap();
        assert_eq!(user.text, "Fix the menu");
        assert_eq!(user.images.len(), 1);
        let reply = first.reply.as_ref().unwrap();
        assert_eq!(reply.status, "complete");
        assert_eq!(reply.duration_ms, Some(9308));
        assert_eq!(reply.steering, ["Keep the old colors"]);
        assert!(reply.events.iter().any(
            |e| matches!(e, RunEvent::Text { text } if text == "Fixed, with the old colors.")
        ));
        assert!(reply.events.iter().any(
            |e| matches!(e, RunEvent::Reasoning { text, .. } if text == "Checking the menu code")
        ));
        let command = reply
            .events
            .iter()
            .find_map(|e| match e {
                RunEvent::Tool { tool } => Some(tool),
                _ => None,
            })
            .unwrap();
        assert_eq!(command.status, "complete");
        assert_eq!(reply.outputs.len(), 1);
        // A stopped turn keeps what it wrote, as a stopped live reply does.
        let second = conversion.turns[1].reply.as_ref().unwrap();
        assert_eq!(second.status, "cancelled");
        assert_eq!(second.duration_ms, None);
    }

    #[test]
    fn agent_studio_context_is_left_out_of_user_messages() {
        let item = json!({"type":"userMessage","content":[{"type":"text","text":"Current user instructions for this conversation (replace earlier conversation instructions): \"\""},{"type":"text","text":"Continue"},{"type":"localImage","path":"C:\\shot.png"}]});
        let input = user_input(&item, None);
        assert_eq!(input.text, "Continue");
        assert!(matches!(&input.images[..], [ImageInput::File(path)] if path == "C:\\shot.png"));
    }

    #[test]
    fn listed_threads_keep_bounded_metadata() {
        let value = json!({"id":"019a0000-0000-7000-8000-000000000002","preview":"x".repeat(1000),"cwd":"/home/me/app","createdAt":1,"updatedAt":2,"model":"gpt-6","originator":"Codex Desktop","source":{"custom":"desktop"}});
        let thread = thread(&value, true).unwrap();
        assert_eq!(thread.preview.unwrap().chars().count(), PREVIEW + 1);
        assert_eq!(thread.source, "custom");
        assert!(thread.archived);
        assert!(super::thread(&json!({"id":"not-a-uuid"}), false).is_none());
    }
}
