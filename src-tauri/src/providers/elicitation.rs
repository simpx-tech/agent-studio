//! Private request bodies live only for their originating run. Portable events
//! contain receipts, never schemas, form values, messages or URL query tokens.
use super::elicitation_schema::{self as schema, Field};
use crate::{protocol::RunEvent, runner::EventSink};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub run_id: String,
    pub revision: u64,
    pub status: String,
    pub mode: String,
    pub server_name: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Request {
    #[serde(flatten)]
    pub receipt: Receipt,
    pub message: String,
    pub fields: Vec<Field>,
    pub url: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub request_id: String,
    pub action: Option<String>,
    pub content: Option<Value>,
}
#[derive(Clone)]
enum Wire {
    Claude(Value),
    Codex(Value),
}
impl Wire {
    fn id(&self) -> &Value {
        match self {
            Self::Claude(id) | Self::Codex(id) => id,
        }
    }
    fn respond(&self, action: &str, content: Option<&Value>) -> Value {
        match self {
            Self::Claude(id) => {
                let mut result = json!({"action":action});
                if let Some(content) = content {
                    result["content"] = content.clone();
                }
                json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":result}})
            }
            Self::Codex(id) => {
                json!({"id":id,"result":{"action":action,"content":content,"_meta":null}})
            }
        }
    }
    fn error(&self, message: &str) -> Value {
        match self {
            Self::Claude(id) => {
                json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":message}})
            }
            Self::Codex(id) => json!({"id":id,"error":{"code":-32602,"message":message}}),
        }
    }
}
struct Entry {
    request: Request,
    wire: Wire,
    sending: bool,
}
struct Run {
    connection: Option<String>,
    entries: HashMap<String, Entry>,
    seen: HashSet<String>,
    tx: mpsc::UnboundedSender<Delivery>,
    active: bool,
}
#[derive(Clone, Default)]
pub struct Hub(Arc<Mutex<HashMap<String, Run>>>);
pub struct Delivery {
    pub payload: Value,
    id: String,
    action: String,
    ack: oneshot::Sender<Result<(), String>>,
}
pub struct Session {
    hub: Hub,
    run_id: String,
    channel: EventSink,
    pub rx: mpsc::UnboundedReceiver<Delivery>,
}
impl Hub {
    pub fn open(&self, run_id: &str, connection: Option<String>, channel: EventSink) -> Session {
        let (tx, rx) = mpsc::unbounded_channel();
        self.0.lock().unwrap().insert(
            run_id.into(),
            Run {
                connection,
                entries: HashMap::new(),
                seen: HashSet::new(),
                tx,
                active: true,
            },
        );
        Session {
            hub: self.clone(),
            run_id: run_id.into(),
            channel,
            rx,
        }
    }
    pub async fn manage(
        &self,
        run_id: &str,
        connection: Option<&str>,
        input: Input,
    ) -> Result<Option<Request>, String> {
        let rx = {
            let mut runs = self.0.lock().map_err(|_| "MCP input is unavailable.")?;
            let run = runs
                .get_mut(run_id)
                .filter(|r| r.active)
                .ok_or("This MCP request is no longer waiting.")?;
            if run.connection.as_deref() != connection {
                return Err("This MCP request belongs to another connection.".into());
            }
            let entry = run
                .entries
                .get_mut(&input.request_id)
                .filter(|e| e.request.receipt.status == "pending")
                .ok_or("This MCP request is no longer waiting.")?;
            let Some(action) = input.action else {
                if input.content.is_some() {
                    return Err("Invalid MCP input.".into());
                }
                return Ok(Some(entry.request.clone()));
            };
            if !matches!(action.as_str(), "accept" | "decline" | "cancel") || entry.sending {
                return Err(
                    "This MCP request was already submitted or the response is invalid.".into(),
                );
            }
            let content = input.content.filter(|v| !v.is_null());
            if action == "accept" && entry.request.receipt.mode == "form" {
                if content.as_ref().is_none_or(|v| {
                    v.to_string().len() > 24000 || !schema::valid_content(&entry.request.fields, v)
                }) {
                    return Err("Check the required fields and their input limits.".into());
                }
            } else if content.is_some() {
                return Err("This action does not accept form values.".into());
            }
            let (ack, rx) = oneshot::channel();
            let delivery = Delivery {
                payload: entry.wire.respond(&action, content.as_ref()),
                id: input.request_id,
                action,
                ack,
            };
            run.tx
                .send(delivery)
                .map_err(|_| "The provider is no longer waiting.")?;
            entry.sending = true;
            rx
        };
        rx.await
            .map_err(|_| "The run ended before input delivery was confirmed.".to_string())??;
        Ok(None)
    }
}
impl Session {
    fn emit(&self, receipt: Receipt) {
        let _ = self.channel.send(RunEvent::Elicitation {
            elicitation: receipt,
        });
    }
    fn submit(&mut self, wire: Wire, params: &Value, claude: bool, parent: bool) -> Option<Value> {
        if !(wire.id().as_i64().is_some()
            || wire.id().as_u64().is_some()
            || wire
                .id()
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 240))
        {
            return Some(wire.error("Invalid MCP request identity."));
        }
        if !parent {
            return Some(wire.respond("cancel", None));
        }
        let parse = || -> Result<Request, &'static str> {
            if params.to_string().len() > 32000 {
                return Err(schema::INVALID);
            }
            let mode = params["mode"].as_str().unwrap_or("form");
            let server_name = schema::text(
                &params[if claude {
                    "mcp_server_name"
                } else {
                    "serverName"
                }],
                200,
            )?;
            let message = schema::text(&params["message"], 4000)?;
            let (fields, url) = match mode {
                "form" => (
                    schema::parse(
                        &params[if claude {
                            "requested_schema"
                        } else {
                            "requestedSchema"
                        }],
                    )?,
                    None,
                ),
                "url" => {
                    schema::text(
                        &params[if claude {
                            "elicitation_id"
                        } else {
                            "elicitationId"
                        }],
                        240,
                    )?;
                    (vec![], Some(schema::safe_url(&params["url"])?))
                }
                _ => return Err(schema::INVALID),
            };
            Ok(Request {
                receipt: Receipt {
                    id: uuid::Uuid::new_v4().to_string(),
                    run_id: self.run_id.clone(),
                    revision: 1,
                    status: "pending".into(),
                    mode: mode.into(),
                    server_name,
                },
                message,
                fields,
                url,
            })
        };
        let request = match parse() {
            Ok(r) => r,
            Err(e) => return Some(wire.error(e)),
        };
        let mut runs = self.hub.0.lock().unwrap();
        let Some(run) = runs.get_mut(&self.run_id).filter(|r| r.active) else {
            return Some(wire.respond("cancel", None));
        };
        let key = wire.id().to_string();
        if run.seen.contains(&key) {
            return None;
        }
        if run.seen.len() >= 16
            || run
                .entries
                .values()
                .map(|e| serde_json::to_vec(&e.request).unwrap().len())
                .sum::<usize>()
                + serde_json::to_vec(&request).unwrap().len()
                > 128000
        {
            return Some(wire.error("This reply reached its MCP input limit."));
        }
        run.seen.insert(key);
        self.emit(request.receipt.clone());
        run.entries.insert(
            request.receipt.id.clone(),
            Entry {
                request,
                wire,
                sending: false,
            },
        );
        None
    }
    pub fn codex(
        &mut self,
        value: &Value,
        root: &str,
        turn: &str,
        active: bool,
    ) -> Option<Option<Value>> {
        if value["method"] != "mcpServer/elicitation/request" {
            return None;
        }
        let p = &value["params"];
        let parent = active
            && !root.is_empty()
            && !turn.is_empty()
            && p["threadId"] == root
            && (p["turnId"].is_null() || p["turnId"] == turn);
        // Granular policy permits user input but also forwards Codex's ordinary
        // MCP tool permission checks. Preserve the app's full-access execution
        // for that exact empty approval shape; never fill a server's input form.
        let meta = &p["_meta"];
        if parent
            && p["mode"] == "form"
            && meta["codex_approval_kind"] == "mcp_tool_call"
            && meta["codex_requires_user_input"] != true
            && meta["codex_strict_auto_review"] != true
            && meta["codex_sensitive_action"] != true
            && p.to_string().len() <= 32000
            && schema::parse(&p["requestedSchema"]).is_ok_and(|fields| fields.is_empty())
        {
            return Some(Some(
                Wire::Codex(value["id"].clone()).respond("accept", Some(&json!({}))),
            ));
        }
        Some(self.submit(Wire::Codex(value["id"].clone()), p, false, parent))
    }
    pub fn claude(&mut self, value: &Value, active: bool) -> Option<Option<Value>> {
        if value["type"] != "control_request" || value["request"]["subtype"] != "elicitation" {
            return None;
        }
        let p = &value["request"];
        let parent =
            active && value["parent_tool_use_id"].is_null() && p["parent_tool_use_id"].is_null();
        Some(self.submit(Wire::Claude(value["request_id"].clone()), p, true, parent))
    }
    pub fn observe(&self, value: &Value, root: Option<&str>) {
        let id = if value["type"] == "control_cancel_request" && root.is_none() {
            &value["request_id"]
        } else if value["method"] == "serverRequest/resolved"
            && root.is_some_and(|r| value["params"]["threadId"] == r)
        {
            &value["params"]["requestId"]
        } else {
            return;
        };
        let mut runs = self.hub.0.lock().unwrap();
        if let Some(run) = runs.get_mut(&self.run_id) {
            for entry in run
                .entries
                .values_mut()
                .filter(|e| e.wire.id() == id && e.request.receipt.status == "pending")
            {
                entry.request.receipt.status = "cancelled".into();
                entry.request.receipt.revision += 1;
                entry.request.fields.clear();
                entry.request.url = None;
                entry.request.message.clear();
                self.emit(entry.request.receipt.clone());
            }
        }
    }
    pub fn can_deliver(&self, delivery: &Delivery) -> bool {
        self.hub
            .0
            .lock()
            .unwrap()
            .get(&self.run_id)
            .is_some_and(|r| {
                r.active
                    && r.entries
                        .get(&delivery.id)
                        .is_some_and(|e| e.request.receipt.status == "pending" && e.sending)
            })
    }
    pub fn delivered(&self, delivery: Delivery, result: Result<(), String>) {
        if let Some(entry) = self
            .hub
            .0
            .lock()
            .unwrap()
            .get_mut(&self.run_id)
            .and_then(|r| r.entries.get_mut(&delivery.id))
        {
            if result.is_ok() && entry.request.receipt.status == "pending" {
                entry.request.receipt.status = match delivery.action.as_str() {
                    "accept" => "accepted",
                    "decline" => "declined",
                    _ => "cancelled",
                }
                .into();
                entry.request.receipt.revision += 1;
                entry.request.fields.clear();
                entry.request.url = None;
                entry.request.message.clear();
                self.emit(entry.request.receipt.clone());
            } else {
                entry.sending = false;
            }
        }
        let _ = delivery.ack.send(result);
    }
    pub fn close(&self) {
        if let Some(run) = self.hub.0.lock().unwrap().get_mut(&self.run_id) {
            run.active = false;
            for entry in run
                .entries
                .values_mut()
                .filter(|e| e.request.receipt.status == "pending")
            {
                entry.request.receipt.status = "cancelled".into();
                entry.request.receipt.revision += 1;
                entry.request.fields.clear();
                entry.request.url = None;
                entry.request.message.clear();
                self.emit(entry.request.receipt.clone());
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
        self.hub.0.lock().unwrap().remove(&self.run_id);
    }
}

#[cfg(test)]
#[path = "elicitation_tests.rs"]
mod tests;
