//! Only progress presence and elapsed time cross the native boundary. Never copy
//! MCP messages, output deltas, terminal input, or connection-scoped process IDs.
use super::*;
use std::time::Instant;

pub(super) const MAX_ELAPSED_MS: u64 = 31_536_000_000;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    kind: &'static str,
    at_elapsed_ms: u64,
}

pub(super) struct ToolClock {
    at: Instant,
    base: u64,
    reported: Option<u64>,
}

pub(super) fn duration_ms(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= MAX_ELAPSED_MS)
}

fn identifier(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 220 && !s.chars().any(char::is_control))
}

impl ToolDecoder {
    pub(super) fn time_tool(&mut self, tool: &mut ToolActivity) {
        if matches!(tool.category.as_str(), "agent" | "hook") {
            return;
        }
        let previous_elapsed = self.existing(&tool.id).and_then(|t| t.elapsed_ms);
        if let Some(clock) = self.clocks.get_mut(&tool.id) {
            let observed = clock
                .base
                .saturating_add(clock.at.elapsed().as_millis() as u64)
                .min(MAX_ELAPSED_MS);
            if tool.status == "running" {
                // Claude reports its own elapsed time. Re-anchor only when it is
                // ahead of the native observation; delayed heartbeats cannot rewind it.
                if tool.elapsed_ms.is_some_and(|elapsed| elapsed > observed) {
                    clock.base = tool.elapsed_ms.unwrap_or_default();
                    clock.at = Instant::now();
                } else {
                    tool.elapsed_ms = Some(
                        (observed / 1000 * 1000)
                            .max(previous_elapsed.unwrap_or(0))
                            .max(tool.elapsed_ms.unwrap_or(0)),
                    );
                }
            } else {
                tool.elapsed_ms = Some(if tool.elapsed_ms == previous_elapsed {
                    observed
                } else {
                    tool.elapsed_ms.unwrap_or(observed)
                });
                self.clocks.remove(&tool.id);
            }
        } else if tool.status == "running" && self.tools.len() < 200 {
            let elapsed = tool.elapsed_ms.unwrap_or(0);
            self.clocks.insert(
                tool.id.clone(),
                ToolClock {
                    at: Instant::now(),
                    base: elapsed,
                    reported: None,
                },
            );
            tool.elapsed_ms = Some(elapsed);
        }
    }

    pub fn tick(&mut self) -> Vec<ToolActivity> {
        let mut out = vec![];
        for tool in self
            .tools
            .clone()
            .into_iter()
            .filter(|t| t.status == "running")
        {
            self.publish(tool, &mut out);
        }
        out
    }

    pub(super) fn bind_progress(&mut self, value: &Value) -> bool {
        let method = value["method"].as_str().unwrap_or_default();
        if !matches!(method, "item/started" | "item/completed") {
            return true;
        }
        let p = &value["params"];
        let item = &p["item"];
        if !matches!(
            item["type"].as_str(),
            Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall")
        ) {
            return true;
        }
        let (Some(thread), Some(id), Some(turn)) = (
            identifier(&p["threadId"]),
            identifier(&item["id"]),
            identifier(&p["turnId"]),
        ) else {
            return true;
        };
        let key = format!("codex:{thread}:{id}");
        if key.len() > 226 {
            return false;
        }
        if let Some((bound_turn, _)) = self.progress_bindings.get(&key) {
            return bound_turn == turn;
        }
        if method == "item/started" && self.progress_bindings.len() < 200 {
            self.progress_bindings.insert(
                key,
                (
                    turn.into(),
                    item["type"].as_str().unwrap_or_default().into(),
                ),
            );
        }
        true
    }

    pub(super) fn codex_progress(&mut self, value: &Value, out: &mut Vec<ToolActivity>) -> bool {
        let (kind, expected) = match value["method"].as_str().unwrap_or_default() {
            "item/mcpToolCall/progress" => ("heartbeat", "mcpToolCall"),
            "item/commandExecution/outputDelta" => ("output", "commandExecution"),
            "item/fileChange/outputDelta" => ("output", "fileChange"),
            "item/commandExecution/terminalInteraction" => ("terminal", "commandExecution"),
            // command/exec/* is a separate, client-initiated connection-scoped API.
            // There are no owned command/exec sessions in this chat adapter.
            _ => return false,
        };
        let p = &value["params"];
        let payload = match kind {
            "heartbeat" => &p["message"],
            "output" => &p["delta"],
            _ => &p["stdin"],
        };
        if !payload.is_string() || (kind == "output" && payload.as_str() == Some("")) {
            return true;
        }
        let (Some(thread), Some(id), Some(turn)) = (
            identifier(&p["threadId"]),
            identifier(&p["itemId"]),
            identifier(&p["turnId"]),
        ) else {
            return true;
        };
        let key = format!("codex:{thread}:{id}");
        if !self
            .progress_bindings
            .get(&key)
            .is_some_and(|(bound, item_kind)| bound == turn && item_kind == expected)
        {
            return true;
        }
        if let Some(mut tool) = self.existing(&key).filter(|t| t.status == "running") {
            self.time_tool(&mut tool);
            tool.progress = Some(ToolProgress {
                kind,
                at_elapsed_ms: tool.elapsed_ms.unwrap_or(0) / 1000 * 1000,
            });
            self.publish(tool, out);
        }
        true
    }

    pub(super) fn claude_progress(&mut self, value: &Value, out: &mut Vec<ToolActivity>) -> bool {
        if value["type"] != "tool_progress" {
            return false;
        }
        let Some(id) = identifier(&value["tool_use_id"]) else {
            return true;
        };
        let Some(seconds) = value["elapsed_time_seconds"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= MAX_ELAPSED_MS as f64 / 1000.0)
        else {
            return true;
        };
        let parent = identifier(&value["parent_tool_use_id"]);
        if !value["parent_tool_use_id"].is_null() && parent.is_none() {
            return true;
        }
        if let Some(mut tool) = self
            .existing(&format!("claude:{id}"))
            .filter(|t| t.status == "running" && t.parent_id.as_deref() == parent)
        {
            let elapsed = (seconds * 1000.0) as u64;
            if let Some(clock) = self.clocks.get_mut(&tool.id) {
                if clock.reported.is_some_and(|previous| elapsed <= previous) {
                    return true;
                }
                clock.reported = Some(elapsed);
            }
            tool.elapsed_ms = Some(elapsed.max(tool.elapsed_ms.unwrap_or(0)));
            self.time_tool(&mut tool);
            tool.progress = Some(ToolProgress {
                kind: "heartbeat",
                at_elapsed_ms: tool.elapsed_ms.unwrap_or(elapsed) / 1000 * 1000,
            });
            self.publish(tool, out);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn start(d: &mut ToolDecoder, kind: &str) -> ToolActivity {
        d.codex_server(&json!({"method":"item/started","params":{"threadId":"root","turnId":"turn","item":{"type":kind,"id":"tool","status":"inProgress"}}}), "root").remove(0)
    }
    fn update(method: &str) -> Value {
        json!({"method":method,"params":{"threadId":"root","turnId":"turn","itemId":"tool","message":"PRIVATE_MCP_PROGRESS","delta":"PRIVATE_OUTPUT","stdin":"PRIVATE_INPUT","processId":"PRIVATE_PROCESS"}})
    }

    #[test]
    fn codex_progress_is_bound_sanitized_coalesced_and_never_revives_completion() {
        for (kind, method, signal) in [
            ("mcpToolCall", "item/mcpToolCall/progress", "heartbeat"),
            (
                "commandExecution",
                "item/commandExecution/outputDelta",
                "output",
            ),
            ("fileChange", "item/fileChange/outputDelta", "output"),
            (
                "commandExecution",
                "item/commandExecution/terminalInteraction",
                "terminal",
            ),
        ] {
            let mut d = ToolDecoder::default();
            assert!(d.codex_server(&update(method), "root").is_empty());
            assert_eq!(start(&mut d, kind).elapsed_ms, Some(0));
            for (key, value) in [
                ("threadId", "foreign"),
                ("turnId", "stale"),
                ("itemId", "missing"),
            ] {
                let mut event = update(method);
                event["params"][key] = json!(value);
                assert!(d.codex_server(&event, "root").is_empty());
            }
            let events = d.codex_server(&update(method), "root");
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].progress.as_ref().unwrap().kind, signal);
            assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
            for _ in 0..100 {
                assert!(d.codex_server(&update(method), "root").is_empty());
            }
            let complete = json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn","item":{"id":"tool","type":kind,"status":"completed","durationMs":12500}}});
            let events = d.codex_server(&complete, "root");
            assert_eq!(events[0].elapsed_ms, Some(12500));
            assert_eq!(events[0].progress.as_ref().unwrap().kind, signal);
            assert!(d.codex_server(&update(method), "root").is_empty());
            assert!(d.codex_server(&complete, "root").is_empty());
            assert!(d.tick().is_empty());
            assert!(d.codex_server(&json!({"method":"item/started","params":{"threadId":"root","turnId":"turn","item":{"type":kind,"id":"tool","status":"inProgress"}}}), "root").is_empty());
        }
    }

    #[test]
    fn quiet_tools_tick_without_fabricating_progress_and_stop_with_the_tool() {
        let mut d = ToolDecoder::default();
        start(&mut d, "commandExecution");
        d.clocks.get_mut("codex:root:tool").unwrap().at -= Duration::from_secs(7);
        let events = d.tick();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].elapsed_ms, Some(7000));
        assert!(events[0].progress.is_none());
        assert!(d.tick().is_empty());
        let ended = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn","item":{"type":"commandExecution","id":"tool","status":"failed","exitCode":1}}}), "root");
        assert!(ended[0].elapsed_ms.unwrap() >= 7000);
        assert_eq!(ended[0].status, "error");
        assert!(d.tick().is_empty());
    }

    #[test]
    fn unowned_exec_and_wrong_item_kind_cannot_become_chat_activity() {
        let mut d = ToolDecoder::default();
        start(&mut d, "mcpToolCall");
        for method in [
            "command/exec",
            "command/exec/outputDelta",
            "command/exec/write",
            "command/exec/resize",
            "command/exec/terminate",
            "item/commandExecution/outputDelta",
        ] {
            assert!(d.codex_server(&update(method), "root").is_empty());
        }
    }

    #[test]
    fn claude_shell_tasks_update_the_tool_without_creating_raw_agent_results() {
        for name in ["Bash", "PowerShell"] {
            let mut d = ToolDecoder::default();
            let events = d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"shell","name":name,"input":{"command":"npm run dev"}}]}}));
            assert!(events[0].command_run);
            assert_eq!(events[0].name, "Run command");
            assert_eq!(events[0].command.as_deref(), Some("npm run dev"));
            d.decode("claude", &json!({"type":"system","subtype":"task_started","task_id":"task","tool_use_id":"shell","task_type":"local_bash","description":"PRIVATE_DESCRIPTION"}));
            d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"shell","content":"PRIVATE_OUTPUT"}]},"tool_use_result":{"backgroundTaskId":"task"}}));
            let launched = d.existing("claude:shell").unwrap();
            assert_eq!(launched.status, "running");
            assert!(launched.background);
            d.clocks.get_mut("claude:shell").unwrap().at -= Duration::from_secs(7);
            // The host keeps timing the task after its launch returned.
            assert_eq!(d.tick()[0].elapsed_ms, Some(7000));
            let events = d.decode("claude", &json!({"type":"system","subtype":"task_notification","task_id":"task","status":"completed","summary":"PRIVATE_STDOUT","output_file":"PRIVATE_PATH"}));
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].status, "complete");
            assert!(events[0].background);
            assert!(events[0].elapsed_ms.unwrap() >= 7000);
            assert!(d.group("claude").agents.is_empty());
            assert!(!serde_json::to_string(&d.tools).unwrap().contains("PRIVATE"));
            assert!(d.tick().is_empty());
        }
        let mut d = ToolDecoder::default();
        assert!(d.decode("claude", &json!({"type":"system","subtype":"task_started","task_id":"foreign","tool_use_id":"foreign","task_type":"local_bash"})).is_empty());
        assert!(d.decode("claude", &json!({"type":"system","subtype":"task_notification","task_id":"foreign","status":"completed","summary":"PRIVATE_STDOUT"})).is_empty());
    }

    #[test]
    fn claude_heartbeat_can_lag_native_observation_without_rewinding_the_clock() {
        let mut d = ToolDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool","name":"Bash","input":{}}]}}));
        d.clocks.get_mut("claude:tool").unwrap().at -= Duration::from_secs(12);
        assert_eq!(d.tick()[0].elapsed_ms, Some(12000));
        let event = json!({"type":"tool_progress","tool_use_id":"tool","parent_tool_use_id":null,"elapsed_time_seconds":10});
        let events = d.decode("claude", &event);
        assert_eq!(events[0].elapsed_ms, Some(12000));
        assert_eq!(events[0].progress.as_ref().unwrap().kind, "heartbeat");
        assert!(d.decode("claude", &event).is_empty());
    }

    #[test]
    fn child_progress_retains_attribution_and_requires_its_own_turn() {
        let mut d = ToolDecoder::default();
        d.codex_server(&json!({"method":"item/started","params":{"threadId":"root","item":{"type":"subAgentActivity","agentThreadId":"child","kind":"started"}}}), "root");
        d.codex_server(&json!({"method":"item/started","params":{"threadId":"child","turnId":"child-turn","item":{"type":"commandExecution","id":"tool","status":"inProgress"}}}), "root");
        let mut event = update("item/commandExecution/outputDelta");
        event["params"]["threadId"] = json!("child");
        assert!(d.codex_server(&event, "root").is_empty());
        event["params"]["turnId"] = json!("child-turn");
        let events = d.codex_server(&event, "root");
        assert_eq!(events[0].parent_id.as_deref(), Some("child"));
    }

    #[test]
    fn claude_heartbeat_retains_elapsed_and_rejects_foreign_late_or_invalid_progress() {
        let mut d = ToolDecoder::default();
        d.decode("claude", &json!({"type":"assistant","parent_tool_use_id":"parent","message":{"content":[{"type":"tool_use","id":"tool","name":"Bash","input":{}}]}}));
        let mut event = json!({"type":"tool_progress","tool_use_id":"tool","tool_name":"PRIVATE_NAME","parent_tool_use_id":"parent","elapsed_time_seconds":12.5,"message":"PRIVATE_OUTPUT"});
        let events = d.decode("claude", &event);
        assert_eq!(events[0].elapsed_ms, Some(12500));
        assert_eq!(events[0].progress.as_ref().unwrap().kind, "heartbeat");
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
        assert!(d.decode("claude", &event).is_empty());
        for seconds in [json!(-1), json!("14"), json!(1e20), json!(3)] {
            event["elapsed_time_seconds"] = seconds;
            assert!(d.decode("claude", &event).is_empty());
        }
        event["elapsed_time_seconds"] = json!(15);
        event["parent_tool_use_id"] = Value::Null;
        assert!(d.decode("claude", &event).is_empty());
        event["parent_tool_use_id"] = json!("parent");
        d.decode("claude", &json!({"type":"user","parent_tool_use_id":"parent","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"PRIVATE_OUTPUT"}]}}));
        assert!(d.decode("claude", &event).is_empty());
        assert!(d.tick().is_empty());
    }
}
