//! Conversation-owned visual output. Source is accepted only by our registered
//! tool, never read from paths in model prose or arbitrary integration results.
use crate::protocol::RunEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_SOURCE: usize = 512_000;
const MAX_TOTAL: usize = 2_000_000;
pub const GUIDANCE: &str = "For interactive charts, diagrams, simulations, or visual explanations in this conversation, call the visualize tool (Claude: mcp__agent_studio__visualize). Supply a stable id, concise title, and complete self-contained HTML fragment in html. After a successful call, put <!-- visualize:ID --> on its own line between blank lines at the relevant point in your final explanation, replacing ID with the submitted id. Write explanatory prose before and after the visual so it flows with the answer. Each visual appears once. Design a transparent, unframed fragment that blends with the reply: no outer card, page background, repeated title, or dashboard shell. The host supplies the chat font (DM Sans, 13px), text color, transparent background, and content-based height. Use CSS variables --foreground, --muted-foreground, --border, --primary and --viz-series-1 through --viz-series-6. Use responsive content with natural height; avoid viewport/min-height sizing and hard-coded page colors or fonts. Use inline CSS/JavaScript, SVG, and data images only; network resources and host APIs are unavailable. Viewing controls are supplied by the host. Do not duplicate its source in your final answer. If an installed visualize skill directs a local-file content reference, submit the fragment through this tool instead: Agent Studio does not load paths from replies. Use ordinary Markdown for simple tables or prose. This tool displays content; it does not execute project work.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Visualization {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub source: String,
}

pub fn valid_history(items: &[Visualization]) -> bool {
    items.len() <= 12
        && items.iter().map(|v| v.source.len()).sum::<usize>() <= MAX_TOTAL
        && items.iter().map(|v| &v.id).collect::<HashSet<_>>().len() == items.len()
        && items.iter().all(|v| {
            v.revision > 0
                && v.revision <= 9_007_199_254_740_991
                && valid(&json!({"id":v.id,"title":v.title,"html":v.source}))
        })
}

pub fn tool() -> Value {
    json!({"name":"visualize","description":GUIDANCE,"inputSchema":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1,"maxLength":80,"pattern":"^[a-zA-Z0-9_-]+$","description":"Stable identifier; reuse to replace this visual within the current reply."},
            "title":{"type":"string","minLength":1,"maxLength":100},
            "html":{"type":"string","minLength":1,"maxLength":512000,"description":"Complete self-contained HTML/SVG fragment with inline styles and scripts."}
        },"required":["id","title","html"],"additionalProperties":false}})
}
pub fn codex_tool() -> Value {
    let mut tool = tool();
    tool["type"] = json!("function");
    tool["deferLoading"] = json!(false);
    tool
}
fn valid(args: &Value) -> bool {
    args.as_object().is_some_and(|o| o.len() == 3)
        && args["id"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 80
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        && args["title"].as_str().is_some_and(|s| {
            !s.trim().is_empty() && s.chars().count() <= 100 && !s.chars().any(char::is_control)
        })
        && args["html"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= MAX_SOURCE && !s.contains('\0'))
}

#[derive(Default)]
pub struct Visualizer {
    visuals: Vec<Visualization>,
    published: bool,
    // Only the parent assistant's actual tool calls can publish a Claude visual.
    pending: HashMap<String, Value>,
    accepted: HashMap<String, Visualization>,
}
impl Visualizer {
    pub fn has_visuals(&self) -> bool {
        self.published
    }
    fn submit(&mut self, args: &Value) -> Result<Visualization, &'static str> {
        if !valid(args) {
            return Err("Provide id (letters, digits, _ or -, at most 80), title (at most 100), and html (at most 512000 UTF-8 bytes). No other fields or file paths are accepted.");
        }
        let index = self.visuals.iter().position(|v| v.id == args["id"]);
        if index.is_none() && self.visuals.len() >= 12 {
            return Err("This reply already contains 12 visuals. Update an existing id.");
        }
        let source = args["html"].as_str().unwrap();
        if self
            .visuals
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != index)
            .map(|(_, v)| v.source.len())
            .sum::<usize>()
            + source.len()
            > MAX_TOTAL
        {
            return Err("Visuals in one reply must total at most 2000000 UTF-8 bytes.");
        }
        let visual = Visualization {
            id: args["id"].as_str().unwrap().into(),
            revision: index.map_or(1, |i| self.visuals[i].revision + 1),
            title: args["title"].as_str().unwrap().into(),
            source: source.into(),
        };
        if let Some(i) = index {
            self.visuals[i] = visual.clone();
        } else {
            self.visuals.push(visual.clone());
        }
        Ok(visual)
    }
    pub fn codex_response(
        &mut self,
        value: &Value,
        root: &str,
    ) -> Option<(Value, Option<RunEvent>)> {
        let p = &value["params"];
        if value["method"] != "item/tool/call" || p["tool"] != "visualize" {
            return None;
        }
        let result = if !root.is_empty() && p["threadId"] == root && p["namespace"].is_null() {
            self.submit(&p["arguments"])
        } else {
            Err("Visualizations must be submitted by the parent conversation.")
        };
        self.published |= result.is_ok();
        let text = result
            .as_ref()
            .map(|v| placement(&v.id))
            .unwrap_or_else(|e| (*e).into());
        let response = json!({"id":value["id"],"result":{"success":result.is_ok(),"contentItems":[{"type":"inputText","text":text}]}});
        Some((
            response,
            result
                .ok()
                .map(|visualization| RunEvent::Visualization { visualization }),
        ))
    }
    pub fn observe_claude(&mut self, value: &Value) -> Vec<RunEvent> {
        let mut events = vec![];
        if !value["parent_tool_use_id"].is_null() {
            return events;
        }
        if let Some(blocks) = value["message"]["content"].as_array() {
            for block in blocks {
                if value["type"] == "assistant"
                    && block["type"] == "tool_use"
                    && block["name"] == "mcp__agent_studio__visualize"
                {
                    if let Some(id) = block["id"].as_str().filter(|id| id.len() <= 240) {
                        if self.pending.len() < 12 && valid(&block["input"]) {
                            self.pending.insert(id.into(), block["input"].clone());
                        }
                    }
                }
                if value["type"] == "user" && block["type"] == "tool_result" {
                    if let Some(id) = block["tool_use_id"].as_str() {
                        self.pending.remove(id);
                        if let Some(visualization) = self.accepted.remove(id) {
                            if block["is_error"] != true {
                                self.published = true;
                                events.push(RunEvent::Visualization { visualization });
                            }
                        }
                    }
                }
            }
        }
        events
    }
    pub fn claude_response(&mut self, value: &Value) -> Value {
        let r = &value["request"];
        if r["subtype"] != "mcp_message" || r["server_name"] != "agent_studio" {
            return json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"This control request is unavailable in Agent Studio."}});
        }
        let m = &r["message"];
        let mut response = json!({"jsonrpc":"2.0","id":m["id"]});
        match m["method"].as_str().unwrap_or_default() {
            "initialize" => {
                response["result"] = json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"agent_studio","version":"1.0.0"}})
            }
            "notifications/initialized" | "ping" => response["result"] = json!({}),
            "tools/list" => {
                response["result"] = json!({"tools":[tool(), super::questions::tool()]})
            }
            "tools/call" if m["params"]["name"] == "visualize" => {
                let args = &m["params"]["arguments"];
                let parent = self
                    .pending
                    .iter()
                    .find(|(id, input)| *input == args && !self.accepted.contains_key(*id))
                    .map(|(id, _)| id.clone());
                let result = if let Some(id) = parent {
                    self.submit(args).map(|v| {
                        self.accepted.insert(id, v);
                    })
                } else {
                    Err("Only a registered parent-conversation visualize call can display a visual.")
                };
                let text = result
                    .as_ref()
                    .map(|_| placement(args["id"].as_str().unwrap()))
                    .unwrap_or_else(|e| (*e).into());
                response["result"] =
                    json!({"isError":result.is_err(),"content":[{"type":"text","text":text}]});
            }
            _ => {
                response["error"] = json!({"code":-32601,"message":"Unknown visualization method"})
            }
        }
        json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"mcp_response":response}}})
    }
}

fn placement(id: &str) -> String {
    format!("Visualization accepted. Place <!-- visualize:{id} --> on its own line between blank lines in your final answer, between the paragraphs it helps explain. Do not repeat the HTML or add a separate attachment heading.")
}

// Mirror the SDK's stdin lifetime: a result with background tasks still running
// is an intermediate result. Wait for their follow-up result before closing.
pub struct ClaudeInputLifetime {
    tasks: HashSet<String>,
    context_pending: bool,
}
impl Default for ClaudeInputLifetime {
    fn default() -> Self {
        Self {
            tasks: HashSet::new(),
            context_pending: true,
        }
    }
}
impl ClaudeInputLifetime {
    pub fn ended(&mut self, value: &Value) -> bool {
        // The non-human shouldQuery=false history message emits a zero-turn
        // result before the queued human message. It does not end this run.
        if self.context_pending
            && value["type"] == "result"
            && value["subtype"] == "success"
            && value["is_error"] != true
            && value["num_turns"] == 0
            && value["result"] == ""
        {
            self.context_pending = false;
            return false;
        }
        if value["type"] == "assistant" && value["parent_tool_use_id"].is_null() {
            self.context_pending = false;
        }
        if value["type"] == "system" {
            if let Some(id) = value["task_id"].as_str() {
                match value["subtype"].as_str().unwrap_or_default() {
                    "task_started"
                        if matches!(
                            value["task_type"].as_str(),
                            Some("local_agent" | "local_workflow")
                        ) =>
                    {
                        self.tasks.insert(id.into());
                    }
                    "task_notification" => {
                        self.tasks.remove(id);
                    }
                    "task_updated"
                        if matches!(
                            value["patch"]["status"].as_str(),
                            Some("completed" | "failed" | "killed" | "cancelled")
                        ) =>
                    {
                        self.tasks.remove(id);
                    }
                    _ => {}
                }
            }
        }
        value["type"] == "result" && self.tasks.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args() -> Value {
        json!({"id":"counter","title":"Counter","html":"<button onclick=\"this.textContent='1'\">0</button>"})
    }
    fn control(input: Value) -> Value {
        json!({"type":"control_request","request_id":"request-1","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"visualize","arguments":input}}}})
    }
    fn assistant(input: Value) -> Value {
        json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"tool-1","name":"mcp__agent_studio__visualize","input":input}]}})
    }
    #[test]
    fn codex_scopes_sources_bounds_and_revisions_to_parent() {
        let mut state = Visualizer::default();
        let mut value = json!({"id":1,"method":"item/tool/call","params":{"threadId":"child","tool":"visualize","arguments":args()}});
        assert_eq!(
            state.codex_response(&value, "root").unwrap().0["result"]["success"],
            false
        );
        value["params"]["threadId"] = json!("root");
        for revision in 1..=2 {
            let (result, event) = state.codex_response(&value, "root").unwrap();
            assert_eq!(result["result"]["success"], true);
            assert!(
                matches!(event, Some(RunEvent::Visualization{visualization}) if visualization.revision == revision && visualization.source == args()["html"])
            );
        }
        value["params"]["arguments"]["html"] = json!("é".repeat(256_001));
        assert_eq!(
            state.codex_response(&value, "root").unwrap().0["result"]["success"],
            false
        );
        value["params"]["arguments"] = json!({"id":"x","title":"x","path":"C:/private.html"});
        assert_eq!(
            state.codex_response(&value, "root").unwrap().0["result"]["success"],
            false
        );
        for i in 1..12 {
            let mut input = args();
            input["id"] = json!(format!("v{i}"));
            assert!(state.submit(&input).is_ok());
        }
        let mut input = args();
        input["id"] = json!("thirteenth");
        assert!(state.submit(&input).is_err());
        assert!(state.submit(&args()).is_ok());
    }
    #[test]
    fn claude_requires_parent_call_accepted_by_our_server_and_successful_result() {
        let mut state = Visualizer::default();
        let control = control(args());
        assert_eq!(
            state.claude_response(&control)["response"]["response"]["mcp_response"]["result"]
                ["isError"],
            true
        );
        let mut child = assistant(args());
        child["parent_tool_use_id"] = json!("parent");
        assert!(state.observe_claude(&child).is_empty());
        assert!(state.pending.is_empty());
        state.observe_claude(&assistant(args()));
        assert_eq!(
            state.claude_response(&control)["response"]["response"]["mcp_response"]["result"]
                ["isError"],
            false
        );
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"Visualization displayed in the conversation."}]}});
        assert!(
            matches!(&state.observe_claude(&result)[0], RunEvent::Visualization{visualization} if visualization.id == "counter")
        );
        assert!(state.observe_claude(&result).is_empty());
        state.observe_claude(&assistant(args()));
        state.claude_response(&control);
        let mut failed = result.clone();
        failed["message"]["content"][0]["is_error"] = json!(true);
        assert!(state.observe_claude(&failed).is_empty());
        assert!(state.pending.is_empty());
        assert!(state.accepted.is_empty());
    }
    #[test]
    fn claude_waits_for_workflows_but_not_persistent_shell_servers() {
        let mut life = ClaudeInputLifetime::default();
        assert!(!life.ended(
            &json!({"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""})
        ));
        life.ended(&json!({"type":"system","subtype":"task_started","task_type":"local_workflow","task_id":"workflow"}));
        assert!(!life.ended(&json!({"type":"result"})));
        life.ended(&json!({"type":"system","subtype":"task_updated","task_id":"workflow","patch":{"status":"completed"}}));
        life.ended(&json!({"type":"system","subtype":"task_started","task_type":"local_bash","task_id":"dev-server"}));
        assert!(life.ended(&json!({"type":"result"})));
    }
}
