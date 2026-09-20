//! Child-authored text is bounded activity, never parent answer/reasoning/usage.
use super::*;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(super) struct AgentMessage {
    id: String,
    text: String,
    complete: bool,
}

fn identity(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 220 && !s.chars().any(char::is_control))
}

fn text_units(text: &str, limit: usize) -> String {
    let mut units = 0;
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}

impl AgentActivity {
    fn message(&mut self, id: &str, text: &str, append: bool, complete: bool) {
        let index = match self.messages.iter().position(|m| m.id == id) {
            Some(index) => index,
            None => {
                if self.messages.len() >= 16 {
                    self.messages_truncated = true;
                    return;
                }
                self.messages.push(AgentMessage {
                    id: id.into(),
                    text: String::new(),
                    complete: false,
                });
                self.messages.len() - 1
            }
        };
        if self.messages[index].complete {
            return;
        }
        let used: usize = self
            .messages
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, m)| m.text.encode_utf16().count())
            .sum();
        let available = 16_000usize.saturating_sub(used).min(4000);
        let message = &mut self.messages[index];
        let next = if append {
            format!("{}{text}", message.text)
        } else {
            text.into()
        };
        if next.encode_utf16().count() > available {
            self.messages_truncated = true;
        }
        message.text = text_units(&next, available);
        message.complete = complete;
    }
}

impl ToolDecoder {
    pub(super) fn claude_child_text(&mut self, v: &Value, out: &mut Vec<ToolActivity>) {
        let Some(parent) = identity(&v["parent_tool_use_id"]) else {
            return;
        };
        let mut group = self.group("claude");
        let Some(agent) = group.agents.iter_mut().find(|a| a.id == parent) else {
            return;
        };
        if v["type"] == "assistant" {
            // Claude delivers individual completed blocks under the same API
            // message ID with distinct SDK UUIDs. Prefer the UUID so later blocks
            // survive; ignore partial echoes, tool inputs and thinking.
            let text = v["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .take(20)
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                if let Some(id) = identity(&v["uuid"]).or_else(|| identity(&v["message"]["id"])) {
                    if agent.messages.iter().any(|m| m.id == id) {
                        return;
                    }
                    agent.message(id, &text, false, true);
                }
                // Compatibility with CLI versions that omit message identities.
                agent.result = Some(text_units(&text, 8000));
            }
        } else {
            return;
        }
        self.publish_group(group, out);
    }

    pub(super) fn codex_subagent(
        &mut self,
        v: &Value,
        root: &str,
        out: &mut Vec<ToolActivity>,
    ) -> bool {
        let p = &v["params"];
        let thread = p["threadId"].as_str().unwrap_or_default();
        let method = v["method"].as_str().unwrap_or_default();
        let item = &p["item"];
        if matches!(method, "item/started" | "item/completed") && item["type"] == "subAgentActivity"
        {
            let Some(id) = identity(&item["agentThreadId"]) else {
                return true;
            };
            if id == thread || id == root {
                return true;
            }
            let Some(kind) = item["kind"]
                .as_str()
                .filter(|k| matches!(*k, "started" | "interacted" | "completed" | "interrupted"))
            else {
                return true;
            };
            // A lifecycle item is sent both on start and completion. Observe it
            // once; a late duplicate must not revive a finished child.
            let key = format!("{thread}:{}:{kind}", identity(&item["id"]).unwrap_or(id));
            if self.agent_lifecycle.contains(&key)
                || (self.agent_lifecycle.len() >= 256 && matches!(kind, "started" | "interacted"))
            {
                return true;
            }
            if self.agent_lifecycle.len() < 256 {
                self.agent_lifecycle.insert(key);
            }
            let mut group = self.group("codex");
            if let Some(agent) = Self::agent(&mut group, id) {
                if let Some(name) = field(item, "agentPath", 200) {
                    agent.name = name;
                }
                // Interactions can come from siblings; only creation establishes ancestry.
                if agent.parent_id.is_none() {
                    agent.parent_id = Some(thread.into());
                }
                match kind {
                    "interacted" => agent.status = "running".into(),
                    "started" if agent.status == "running" => {}
                    "completed" if !matches!(agent.status.as_str(), "error" | "cancelled") => {
                        agent.status = "complete".into()
                    }
                    "interrupted" => agent.status = "cancelled".into(),
                    _ => {}
                }
            }
            self.publish_group(group, out);
            return true;
        }
        if thread == root {
            return false;
        }
        if method == "turn/started" {
            if let Some(turn) = identity(&p["turn"]["id"]) {
                let key = format!("turn:{thread}:{turn}");
                if self.agent_lifecycle.contains(&key) || self.agent_lifecycle.len() >= 256 {
                    return true;
                }
                self.agent_lifecycle.insert(key);
                self.child_turns.insert(thread.into(), turn.into());
                let mut group = self.group("codex");
                if let Some(agent) = Self::agent(&mut group, thread) {
                    agent.status = "running".into();
                }
                self.publish_group(group, out);
            }
            return true;
        }
        let reported_turn = if method == "turn/completed" {
            &p["turn"]["id"]
        } else {
            &p["turnId"]
        };
        if let Some(bound) = self.child_turns.get(thread) {
            if identity(reported_turn) != Some(bound.as_str()) {
                return true;
            }
        }
        if method == "item/agentMessage/delta"
            || method == "turn/completed"
            || (method == "item/completed"
                && matches!(item["type"].as_str(), Some("agentMessage" | "userMessage")))
        {
            let mut group = self.group("codex");
            if let Some(agent) = Self::agent(&mut group, thread) {
                match method {
                    "turn/completed" => {
                        agent.status =
                            status(p["turn"]["status"].as_str().unwrap_or_default()).into()
                    }
                    "item/agentMessage/delta" if agent.status == "running" => {
                        if let (Some(id), Some(text)) =
                            (identity(&p["itemId"]), p["delta"].as_str())
                        {
                            agent.message(id, text, true, false);
                        }
                    }
                    "item/completed" if item["type"] == "agentMessage" => {
                        if let Some(text) = field(item, "text", 8000) {
                            if let Some(id) = identity(&item["id"]) {
                                if agent.messages.iter().any(|m| m.id == id && m.complete) {
                                    return true;
                                }
                                agent.message(id, &text, false, true);
                            }
                            agent.result = Some(text_units(&text, 8000));
                        }
                    }
                    "item/completed" => {
                        let task = text_content(&item["content"], 2048);
                        if !task.is_empty() {
                            agent.task = Some(task);
                        }
                    }
                    _ => {}
                }
            }
            self.publish_group(group, out);
            return true;
        }
        false
    }

    pub(super) fn claude_team_tool(
        &self,
        tool: &mut ToolActivity,
        name: &str,
        input: &Value,
    ) -> bool {
        match name {
            "SendMessage" => {
                tool.name = "Message agent".into();
                tool.operation = Some("sendMessage".into());
                if let Some(target) =
                    field(input, "to", 240).or_else(|| field(input, "recipient", 240))
                {
                    fact(tool, "Recipient", target);
                }
                if let Some(summary) = field(input, "summary", 200) {
                    tool.detail = Some(summary);
                }
                if let Some(kind) = input["type"].as_str().filter(|s| {
                    matches!(
                        *s,
                        "message"
                            | "broadcast"
                            | "shutdown_request"
                            | "shutdown_response"
                            | "plan_approval_request"
                            | "plan_approval_response"
                    )
                }) {
                    fact(tool, "Message type", kind);
                }
                // Message bodies are tool input, not child-authored reply text.
            }
            "ListAgents" => {
                tool.name = "List agents".into();
                tool.operation = Some("listAgents".into());
                tool.detail = Some("Agent directory reported by Claude. Listed agents may belong to other sessions.".into());
            }
            _ => return false,
        }
        true
    }

    pub(super) fn claude_agent_list(tool: &mut ToolActivity, result: &Value) {
        // A directory is not evidence of a child relationship. Do not grant listed
        // sessions ownership of text, usage or tools in this reply.
        if let Some(agents) = result["agents"].as_array() {
            fact(tool, "Agents listed", agents.len());
            let names = agents
                .iter()
                .take(12)
                .filter_map(|a| {
                    let name = field(a, "name", 200)?;
                    let state = a["status"].as_str().map(status).unwrap_or("unknown");
                    Some(format!("{name} — {state}"))
                })
                .collect::<Vec<_>>();
            if !names.is_empty() {
                fact(tool, "Agents", names.join("\n"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spawn(d: &mut ToolDecoder) {
        d.decode("claude", &json!({"type":"assistant","message":{"content":[
            {"type":"tool_use","id":"child","name":"Agent","input":{"description":"Reader","prompt":"Read fixture"}}
        ]}}));
    }

    #[test]
    fn claude_forwarded_blocks_keep_identity_text_only_and_parent_ownership() {
        let mut d = ToolDecoder::default();
        spawn(&mut d);
        for (uuid, text) in [
            ("first", "Inspecting"),
            ("second", "Found it"),
            ("first", "Inspecting"),
        ] {
            d.decode("claude", &json!({"type":"assistant","uuid":uuid,"parent_tool_use_id":"child",
                "message":{"id":"same-api-message","content":[{"type":"text","text":text},
                {"type":"thinking","thinking":"PRIVATE_THOUGHT","signature":"PRIVATE_SIGNATURE"},
                {"type":"tool_use","id":"read","name":"Read","input":{"file_path":"fixture.txt","text":"PRIVATE_INPUT"}}]}}));
        }
        let group = d.group("claude");
        assert_eq!(group.agents[0].messages.len(), 2);
        assert_eq!(group.agents[0].messages[1].text, "Found it");
        assert_eq!(group.agents[0].result.as_deref(), Some("Found it"));
        assert_eq!(group.agents[0].status, "running");
        let unrelated = d.decode(
            "claude",
            &json!({"type":"assistant","uuid":"foreign","parent_tool_use_id":"other",
            "message":{"content":[{"type":"text","text":"PRIVATE_FOREIGN"}]}}),
        );
        assert!(unrelated.is_empty());
        d.decode("claude", &json!({"type":"user","parent_tool_use_id":"other",
            "message":{"content":[{"type":"tool_result","tool_use_id":"child","content":"PRIVATE_RESULT"}]}}));
        assert_eq!(d.group("claude").agents[0].status, "running");
        assert!(!serde_json::to_string(&d.tools).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn codex_lifecycle_messages_nested_children_and_stale_events() {
        let mut d = ToolDecoder::default();
        let start = json!({"method":"item/started","params":{"threadId":"root","item":{
            "id":"spawn","type":"subAgentActivity","kind":"started","agentThreadId":"child","agentPath":"/root/reader"}}});
        d.codex_server(&start, "root");
        d.codex_server(
            &json!({"method":"turn/started","params":{"threadId":"child","turn":{"id":"turn"}}}),
            "root",
        );
        let delta = json!({"method":"item/agentMessage/delta","params":{"threadId":"child","turnId":"turn","itemId":"m","delta":"Partial"}});
        d.codex_server(&delta, "root");
        assert!(!d.group("codex").agents[0].messages[0].complete);
        d.codex_server(&json!({"method":"item/completed","params":{"threadId":"child","turnId":"turn","item":{"id":"m","type":"agentMessage","text":"Authoritative"}}}), "root");
        d.codex_server(&delta, "root");
        d.codex_server(&json!({"method":"turn/completed","params":{"threadId":"child","turn":{"id":"turn","status":"failed"}}}), "root");
        let mut duplicate = start.clone();
        duplicate["method"] = json!("item/completed");
        assert!(d.codex_server(&duplicate, "root").is_empty());
        assert_eq!(d.group("codex").agents[0].status, "error");
        assert!(d.codex_server(&json!({"method":"turn/started","params":{"threadId":"child","turn":{"id":"turn"}}}), "root").is_empty());
        assert_eq!(d.group("codex").agents[0].status, "error");
        assert_eq!(d.group("codex").agents[0].messages[0].text, "Authoritative");
        let mut stale = delta.clone();
        stale["params"]["turnId"] = json!("old");
        assert!(d.codex_server(&stale, "root").is_empty());
        stale["params"]["threadId"] = json!("foreign");
        assert!(d.codex_server(&stale, "root").is_empty());
        let mut nested = start;
        nested["params"]["threadId"] = json!("child");
        nested["params"]["item"]["id"] = json!("nested");
        nested["params"]["item"]["agentThreadId"] = json!("grandchild");
        nested["params"]["item"]["agentPath"] = json!("/root/reader/checker");
        d.codex_server(&nested, "root");
        assert_eq!(
            d.group("codex").agents[1].parent_id.as_deref(),
            Some("child")
        );
    }

    #[test]
    fn child_messages_are_bounded_in_utf16_and_updates_survive_limits() {
        let mut group = fresh("agents".into(), "agent", "Sub-agents");
        let agent = ToolDecoder::agent(&mut group, "child").unwrap();
        for i in 0..40 {
            agent.message(&i.to_string(), &"😀".repeat(5000), false, false);
        }
        assert_eq!(agent.messages.len(), 16);
        assert!(agent.messages_truncated);
        assert_eq!(
            agent
                .messages
                .iter()
                .map(|m| m.text.encode_utf16().count())
                .sum::<usize>(),
            16000
        );
        assert!(agent
            .messages
            .iter()
            .all(|m| m.text.encode_utf16().count() <= 4000));
        agent.message("0", "Final", false, true);
        assert_eq!(agent.messages[0].text, "Final");
    }

    #[test]
    fn claude_team_tools_expose_only_safe_metadata_and_never_adopt_directory_agents() {
        let mut d = ToolDecoder::default();
        for (id, name, input) in [
            (
                "send",
                "SendMessage",
                json!({"to":"reader","summary":"Review completed","message":"PRIVATE_BODY"}),
            ),
            ("list", "ListAgents", json!({})),
        ] {
            d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}));
        }
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"list","content":"PRIVATE_RAW"}]},
            "tool_use_result":{"agents":[{"id":"foreign","name":"Reader","status":"running","prompt":"PRIVATE_PROMPT","path":"PRIVATE_PATH"}]}}));
        assert_eq!(d.tools[0].operation.as_deref(), Some("sendMessage"));
        assert_eq!(d.tools[0].detail.as_deref(), Some("Review completed"));
        assert!(d.tools[0]
            .facts
            .iter()
            .any(|f| f.label == "Recipient" && f.value == "reader"));
        assert!(d.tools[1]
            .facts
            .iter()
            .any(|f| f.label == "Agents listed" && f.value == "1"));
        assert!(d.group("claude").agents.is_empty());
        assert!(!serde_json::to_string(&d.tools).unwrap().contains("PRIVATE"));
    }
}
