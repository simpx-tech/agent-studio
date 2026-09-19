use super::*;
use crate::protocol::hooks::{event_name, handler_type, identifier, source_label};

impl ToolDecoder {
    pub(super) fn claude_hook(&mut self, v: &Value, out: &mut Vec<ToolActivity>) -> bool {
        let subtype = v["subtype"].as_str().unwrap_or_default();
        if v["type"] != "system"
            || !matches!(subtype, "hook_started" | "hook_progress" | "hook_response")
        {
            return false;
        }
        let Some(id) = identifier(&v["hook_id"], 160) else {
            return true;
        };
        let parent = identifier(&v["parent_tool_use_id"], 160);
        if !v["parent_tool_use_id"].is_null() && parent.is_none() {
            return true;
        }
        // Parent tool identity prevents a child's hook from revising the parent's hook.
        let id = format!("claude:hook:{}:{id}", parent.unwrap_or("root"));
        if id.len() > 240 {
            return true;
        }
        let previous = self.existing(&id);
        if previous.as_ref().is_some_and(|t| t.status != "running") && subtype != "hook_response" {
            return true;
        }
        let event = event_name(&v["hook_event"]);
        let mut tool = previous.unwrap_or_else(|| fresh(id, "hook", &format!("{event} hook")));
        tool.parent_id = parent.map(String::from);
        fact(&mut tool, "Event", event);
        if let Some(name) = identifier(&v["hook_name"], 200) {
            fact(&mut tool, "Hook", name);
        }
        fact(
            &mut tool,
            "Phase",
            match subtype {
                "hook_progress" => "Progress reported",
                "hook_response" => "Response received",
                _ => "Started",
            },
        );
        if subtype == "hook_response" {
            tool.status = match v["outcome"].as_str() {
                Some("success") => "complete",
                Some("error") => "error",
                Some("cancelled") => "cancelled",
                _ => "unknown",
            }
            .into();
            if let Some(code) = v["exit_code"]
                .as_i64()
                .filter(|c| i32::try_from(*c).is_ok())
            {
                fact(&mut tool, "Exit code", code);
            }
        }
        self.publish(tool, out);
        true
    }

    pub(super) fn codex_hook(
        &mut self,
        v: &Value,
        root: &str,
        out: &mut Vec<ToolActivity>,
    ) -> bool {
        let method = v["method"].as_str().unwrap_or_default();
        let p = &v["params"];
        let thread = p["threadId"].as_str().unwrap_or_default();
        let prompt = matches!(method, "item/started" | "item/completed")
            && p["item"]["type"] == "hookPrompt";
        if !prompt && !matches!(method, "hook/started" | "hook/completed") {
            return false;
        }
        let value = if prompt { &p["item"] } else { &p["run"] };
        let Some(id) = identifier(&value["id"], 160) else {
            return true;
        };
        let id = format!(
            "codex:{}:{thread}:{id}",
            if prompt { "hook-prompt" } else { "hook" }
        );
        if id.len() > 240 {
            return true;
        }
        let previous = self.existing(&id);
        if previous.as_ref().is_some_and(|t| t.status != "running") && method.ends_with("/started")
        {
            return true;
        }
        let event = event_name(&value["eventName"]);
        let mut tool = previous
            .unwrap_or_else(|| fresh(id, "hook", if prompt { "Hook context" } else { event }));
        tool.parent_id = (thread != root).then(|| thread.into());
        if prompt {
            tool.operation = Some("hookContext".into());
            tool.status = if method == "item/completed" {
                "complete"
            } else {
                "running"
            }
            .into();
            if let Some(fragments) = value["fragments"].as_array() {
                fact(&mut tool, "Context fragments", fragments.len());
                let ids: Vec<_> = fragments
                    .iter()
                    .take(12)
                    .filter_map(|f| identifier(&f["hookRunId"], 160))
                    .collect();
                if !ids.is_empty() {
                    fact(&mut tool, "Hook runs", ids.join("\n"));
                }
            }
        } else {
            tool.name = format!("{event} hook");
            tool.status = if method == "hook/started" {
                "running"
            } else {
                match value["status"].as_str() {
                    Some("completed") => "complete",
                    Some("failed") => "error",
                    Some("blocked") => "blocked",
                    Some("stopped") => "cancelled",
                    _ => "unknown",
                }
            }
            .into();
            tool.path = identifier(&value["sourcePath"], 4096).map(String::from);
            fact(&mut tool, "Event", event);
            fact(&mut tool, "Handler", handler_type(&value["handlerType"]));
            fact(&mut tool, "Source", source_label(&value["source"]));
            if let Some(mode @ ("sync" | "async")) = value["executionMode"].as_str() {
                fact(
                    &mut tool,
                    "Execution",
                    if mode == "sync" {
                        "Synchronous"
                    } else {
                        "Asynchronous"
                    },
                );
            }
            if let Some(scope @ ("thread" | "turn")) = value["scope"].as_str() {
                fact(&mut tool, "Scope", scope);
            }
            if let Some(duration) = value["durationMs"]
                .as_u64()
                .filter(|v| *v <= 9_007_199_254_740_991)
            {
                fact(&mut tool, "Duration", format!("{duration} ms"));
            }
        }
        self.publish(tool, out);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_hooks_revise_one_entry_accept_response_only_and_keep_output_private() {
        let mut d = ToolDecoder::default();
        let mut v = json!({"type":"system","subtype":"hook_started","hook_id":"one","hook_event":"PreToolUse","hook_name":"PreToolUse:Bash:0","session_id":"session"});
        let started = d.decode("claude", &v);
        assert_eq!(started[0].category, "hook");
        assert_eq!(started[0].status, "running");
        assert!(d.decode("claude", &v).is_empty());
        v["subtype"] = json!("hook_progress");
        for key in ["stdout", "stderr", "output", "command", "prompt"] {
            v[key] = json!("PRIVATE_HOOK_PAYLOAD");
        }
        let progress = d.decode("claude", &v);
        assert_eq!(progress[0].id, started[0].id);
        assert!(progress[0].revision > started[0].revision);
        v["subtype"] = json!("hook_response");
        v["outcome"] = json!("error");
        v["exit_code"] = json!(2);
        let done = d.decode("claude", &v);
        assert_eq!(done[0].status, "error");
        assert!(done[0]
            .facts
            .iter()
            .any(|f| f.label == "Exit code" && f.value == "2"));
        assert!(!serde_json::to_string(&done)
            .unwrap()
            .contains("PRIVATE_HOOK_PAYLOAD"));
        assert!(d.decode("claude", &v).is_empty());
        v["subtype"] = json!("hook_started");
        assert!(d.decode("claude", &v).is_empty());
        for (outcome, expected) in [
            ("success", "complete"),
            ("cancelled", "cancelled"),
            ("new-outcome", "unknown"),
        ] {
            v["hook_id"] = json!(outcome);
            v["subtype"] = json!("hook_response");
            v["outcome"] = json!(outcome);
            assert_eq!(d.decode("claude", &v)[0].status, expected);
        }
        v["hook_id"] = json!("one");
        v["parent_tool_use_id"] = json!("child");
        let child = d.decode("claude", &v);
        assert_ne!(child[0].id, done[0].id);
        assert_eq!(child[0].parent_id.as_deref(), Some("child"));
        for bad in [
            json!(""),
            json!("x".repeat(161)),
            json!("bad\nidentity"),
            json!(22),
        ] {
            v["hook_id"] = bad;
            assert!(d.decode("claude", &v).is_empty());
        }
    }

    #[test]
    fn codex_hooks_keep_source_outcomes_and_context_metadata_without_prompt_text() {
        let mut d = ToolDecoder::default();
        let mut v = json!({"method":"hook/started","params":{"threadId":"root","turnId":null,"run":{"id":"one","eventName":"sessionStart","handlerType":"command","executionMode":"sync","scope":"thread","source":"project","sourcePath":"/fixture/.codex/hooks.json","status":"running","statusMessage":"PRIVATE_STATUS","entries":[{"kind":"context","text":"PRIVATE_OUTPUT"}]}}});
        let started = d.codex_server(&v, "root");
        assert_eq!(started[0].name, "SessionStart hook");
        assert!(d.codex_server(&v, "foreign").is_empty());
        v["method"] = json!("hook/completed");
        v["params"]["run"]["status"] = json!("blocked");
        v["params"]["run"]["durationMs"] = json!(28);
        let done = d.codex_server(&v, "root");
        assert_eq!(done[0].id, started[0].id);
        assert_eq!(done[0].status, "blocked");
        assert_eq!(done[0].path.as_deref(), Some("/fixture/.codex/hooks.json"));
        assert!(!serde_json::to_string(&done).unwrap().contains("PRIVATE"));
        assert!(d.codex_server(&v, "root").is_empty());
        v["method"] = json!("hook/started");
        assert!(d.codex_server(&v, "root").is_empty());
        let prompt = json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"one","type":"hookPrompt","fragments":[{"hookRunId":"one","text":"PRIVATE_INJECTED_CONTEXT"}]}}});
        let events = d.codex_server(&prompt, "root");
        assert_ne!(events[0].id, done[0].id);
        assert_eq!(events[0].name, "Hook context");
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
        let mut decoder = crate::protocol::Decoder::default();
        assert_eq!(decoder.decode_codex_server(&prompt, "root").len(), 1);
        assert!(decoder.text.is_empty());
        let buffered = crate::protocol::hooks::startup_hook(&v).unwrap();
        assert!(!buffered.to_string().contains("PRIVATE"));
    }

    #[test]
    fn hooks_share_activity_bounds_and_child_attribution() {
        let mut d = ToolDecoder::default();
        let event = |id: usize, method: &str| json!({"method":method,"params":{"threadId":"root","run":{"id":id.to_string(),"eventName":"stop","status":"completed"}}});
        for id in 0..200 {
            d.codex_server(&event(id, "hook/started"), "root");
        }
        let overflow = d.codex_server(&event(201, "hook/started"), "root");
        assert_eq!(overflow[0].id, "activity-limit");
        assert_eq!(
            d.codex_server(&event(0, "hook/completed"), "root")[0].status,
            "complete"
        );
        let mut d = ToolDecoder::default();
        d.codex_server(&json!({"method":"item/started","params":{"threadId":"root","item":{"type":"subAgentActivity","agentThreadId":"child","kind":"started"}}}), "root");
        let mut child = event(0, "hook/completed");
        child["params"]["threadId"] = json!("child");
        assert_eq!(
            d.codex_server(&child, "root")[0].parent_id.as_deref(),
            Some("child")
        );
    }
}
