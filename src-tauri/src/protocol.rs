use serde::Serialize;
use serde_json::Value;
mod activity;
pub mod file_changes;
pub mod plan;
mod reasoning;
#[cfg(test)]
mod reasoning_tests;
mod workflow;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cached_input: Option<u64>,
    pub reasoning_output: Option<u64>,
    pub context_input: Option<u64>,
    pub context_window: Option<u64>,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_credits: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}
fn input_with_cache(v: &Value) -> Option<u64> {
    Some(
        v["input_tokens"].as_u64()?
            + v["cache_read_input_tokens"].as_u64().unwrap_or(0)
            + v["cache_creation_input_tokens"].as_u64().unwrap_or(0),
    )
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RunEvent {
    AccountUsage {
        #[serde(rename = "accountUsage")]
        account_usage: crate::spend::Observation,
    },
    FileChanges {
        #[serde(rename = "fileChanges")]
        file_changes: file_changes::Snapshot,
    },
    Question {
        question: crate::providers::questions::Request,
    },
    Visualization {
        visualization: crate::providers::visualize::Visualization,
    },
    Plan {
        plan: plan::Plan,
    },
    NativeWorkflow {
        #[serde(rename = "nativeWorkflows")]
        native_workflows: workflow::Snapshot,
    },
    Text {
        text: String,
    },
    Progress {
        id: String,
        revision: u64,
        text: String,
    },
    Reasoning {
        id: String,
        revision: u64,
        text: String,
        truncated: bool,
    },
    Activity {
        text: String,
    },
    Tool {
        tool: activity::ToolActivity,
    },
    Usage {
        #[serde(flatten)]
        usage: TokenUsage,
    },
}
#[derive(Default)]
pub struct Decoder {
    pub text: String,
    pub failure: Option<String>,
    pub completed: bool,
    items: Vec<(String, String)>,
    context_input: Option<u64>,
    model: Option<String>,
    tools: activity::ToolDecoder,
    file_changes: file_changes::FileChangeDecoder,
    plan: plan::PlanDecoder,
    workflows: workflow::WorkflowDecoder,
    progress: Vec<(String, String, u64)>,
    reasoning: reasoning::ReasoningDecoder,
    current_message: String,
    message_number: u64,
}
fn string(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
impl Decoder {
    fn progress_event(&mut self, id: String, text: String, append: bool) -> Option<RunEvent> {
        let index = if let Some(index) = self.progress.iter().position(|p| p.0 == id) {
            index
        } else {
            if self.progress.len() >= 64 {
                return None;
            }
            self.progress.push((id, String::new(), 0));
            self.progress.len() - 1
        };
        let item = &mut self.progress[index];
        let next = if append {
            format!("{}{text}", item.1)
        } else {
            text
        };
        let next: String = next.chars().take(16000).collect();
        if item.1 == next || next.is_empty() {
            return None;
        }
        item.1 = next;
        item.2 += 1;
        Some(RunEvent::Progress {
            id: item.0.clone(),
            revision: item.2,
            text: item.1.clone(),
        })
    }
    pub fn reported_model(&mut self, model: Option<&str>) {
        self.model = model.map(|value| value.chars().take(200).collect());
    }
    pub fn decode_codex_server(&mut self, value: &Value, root: &str) -> Vec<RunEvent> {
        let mut events: Vec<_> = self
            .tools
            .codex_server(value, root)
            .into_iter()
            .map(|tool| RunEvent::Tool { tool })
            .collect();
        let params = &value["params"];
        if self
            .tools
            .owns_codex_thread(params["threadId"].as_str().unwrap_or_default(), root)
        {
            if let Some(file_changes) = self.file_changes.codex_server(value) {
                events.push(RunEvent::FileChanges { file_changes });
            }
        }
        if params["threadId"] != root {
            return events;
        }
        events.extend(self.reasoning.codex_server(value));
        match value["method"].as_str().unwrap_or_default() {
            "turn/plan/updated" => {
                if let Some(plan) = self.plan.codex(params) {
                    events.push(RunEvent::Plan { plan });
                }
            }
            "item/agentMessage/delta" => {
                let id = string(params, "/itemId");
                let delta = string(params, "/delta");
                if let Some(event) = self.progress_event(id.clone(), delta, true) {
                    events.push(event);
                }
                if let Some(item) = self.progress.iter().find(|p| p.0 == id) {
                    self.text = item.1.clone();
                }
            }
            "item/completed" if params["item"]["type"] == "agentMessage" => {
                let item = &params["item"];
                let text = string(item, "/text");
                if let Some(event) = self.progress_event(string(item, "/id"), text.clone(), false) {
                    events.push(event);
                }
                self.text = text;
                if item["phase"] == "final_answer" {
                    events.push(RunEvent::Text {
                        text: self.text.clone(),
                    });
                }
            }
            "turn/completed" if !self.text.is_empty() => events.push(RunEvent::Text {
                text: self.text.clone(),
            }),
            "thread/tokenUsage/updated" => {
                let usage = &params["tokenUsage"];
                events.push(RunEvent::Usage {
                    usage: TokenUsage {
                        input: usage["total"]["inputTokens"].as_u64(),
                        output: usage["total"]["outputTokens"].as_u64(),
                        cached_input: usage["total"]["cachedInputTokens"].as_u64(),
                        reasoning_output: usage["total"]["reasoningOutputTokens"].as_u64(),
                        context_input: usage["last"]["inputTokens"].as_u64(),
                        context_window: usage["modelContextWindow"].as_u64(),
                        cost_usd: None,
                        model: self.model.clone(),
                        // Agent Studio starts one app-server process per reply.
                        // Installed Codex resets these counters when resuming in
                        // that new process, unlike its native billing estimate.
                        scope: Some("reply".into()),
                        ..Default::default()
                    },
                });
            }
            "turn/started" => events.push(RunEvent::Activity {
                text: "Thinking through your request".into(),
            }),
            _ => {}
        }
        events
    }
    pub fn decode(&mut self, provider: &str, line: &str) -> Vec<RunEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        let kind = string(&v, "/type");
        let mut events: Vec<RunEvent> = self
            .tools
            .decode(provider, &v)
            .into_iter()
            .map(|tool| RunEvent::Tool { tool })
            .collect();
        if let Some(file_changes) = self.file_changes.decode(provider, &v) {
            events.push(RunEvent::FileChanges { file_changes });
        }
        // Child-agent text and usage belong to its activity, never the main reply.
        if provider == "claude" && v["parent_tool_use_id"].as_str().is_some() {
            return events;
        }
        if provider == "claude" {
            events.extend(self.reasoning.claude(&v, &self.current_message));
            if let Some(native_workflows) = self.workflows.decode(&v) {
                events.push(RunEvent::NativeWorkflow { native_workflows });
            }
            if let Some(plan) = self.plan.claude(&v) {
                events.push(RunEvent::Plan { plan });
            }
        }
        if provider == "claude" && kind == "assistant" {
            self.context_input = input_with_cache(&v["message"]["usage"]);
            self.model = v["message"]["model"].as_str().map(String::from);
        }
        if provider == "claude" && string(&v, "/event/content_block/type") == "tool_use" {
            let name: String = string(&v, "/event/content_block/name")
                .chars()
                .filter(|c| !c.is_control())
                .take(80)
                .collect();
            events.push(RunEvent::Activity {
                text: format!("Using {name}"),
            });
        }
        match provider {
            "codex" => match kind.as_str() {
                "item.started" | "item.updated" | "item.completed"
                    if v["item"]["type"] == "reasoning" =>
                {
                    if let (Some(id), Some(text)) =
                        (v["item"]["id"].as_str(), v["item"]["text"].as_str())
                    {
                        events.extend(self.reasoning.text(id, text, false));
                    }
                }
                "item.started" => {
                    let activity = match string(&v, "/item/type").as_str() {
                        "command_execution" => Some("Running command"),
                        "file_change" => Some("Editing files"),
                        "mcp_tool_call" => Some("Using connected tool"),
                        "web_search" => Some("Searching the web"),
                        _ => None,
                    };
                    if let Some(text) = activity {
                        events.push(RunEvent::Activity { text: text.into() });
                    }
                }
                "item.completed" | "item.updated" => {
                    if string(&v, "/item/type") == "agent_message" {
                        let id = string(&v, "/item/id");
                        let text = string(&v, "/item/text");
                        if let Some(item) = self.items.iter_mut().find(|i| i.0 == id) {
                            item.1 = text;
                        } else {
                            self.items.push((id, text));
                        }
                        self.text = self
                            .items
                            .iter()
                            .map(|i| i.1.as_str())
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        events.push(RunEvent::Text {
                            text: self.text.clone(),
                        });
                    }
                }
                "turn.started" => events.push(RunEvent::Activity {
                    text: "Thinking through your request".into(),
                }),
                "turn.completed" => events.push(RunEvent::Usage {
                    usage: TokenUsage {
                        input: v["usage"]["input_tokens"].as_u64(),
                        output: v["usage"]["output_tokens"].as_u64(),
                        cached_input: v["usage"]["cached_input_tokens"].as_u64(),
                        reasoning_output: v["usage"]["reasoning_output_tokens"].as_u64(),
                        context_input: None,
                        context_window: None,
                        cost_usd: None,
                        model: None,
                        ..Default::default()
                    },
                }),
                "turn.failed" => self.failure = Some(string(&v, "/error/message")),
                "error" => events.push(RunEvent::Activity {
                    text: "Provider reported an issue; waiting for the final outcome".into(),
                }),
                _ => {}
            },
            "claude" => match kind.as_str() {
                "stream_event" if string(&v, "/event/type") == "message_start" => {
                    self.message_number += 1;
                    self.current_message = v["event"]["message"]["id"]
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| format!("claude-message-{}", self.message_number));
                    self.text.clear();
                }
                "stream_event" if string(&v, "/event/delta/type") == "text_delta" => {
                    self.text.push_str(&string(&v, "/event/delta/text"));
                    if let Some(event) =
                        self.progress_event(self.current_message.clone(), self.text.clone(), false)
                    {
                        events.push(event);
                    }
                }
                "assistant" => {
                    if let Some(blocks) = v["message"]["content"].as_array() {
                        let text = blocks
                            .iter()
                            .filter(|b| b["type"] == "text")
                            .filter_map(|b| b["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n\n");
                        if !text.is_empty() {
                            self.text = text;
                            let id = v["message"]["id"]
                                .as_str()
                                .map(String::from)
                                .unwrap_or_else(|| self.current_message.clone());
                            if let Some(event) = self.progress_event(id, self.text.clone(), false) {
                                events.push(event);
                            }
                        }
                    }
                }
                "result" => {
                    if v["is_error"].as_bool().unwrap_or(false) {
                        self.failure = Some(
                            v["errors"]
                                .as_array()
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .unwrap_or_else(|| string(&v, "/result")),
                        );
                    } else {
                        let result = string(&v, "/result");
                        if !result.is_empty() {
                            self.text = result;
                            events.push(RunEvent::Text {
                                text: self.text.clone(),
                            });
                        }
                    }
                    let model_usage = self.model.as_ref().and_then(|m| v["modelUsage"].get(m));
                    events.push(RunEvent::Usage {
                        usage: TokenUsage {
                            input: input_with_cache(&v["usage"]),
                            output: v["usage"]["output_tokens"].as_u64(),
                            cached_input: v["usage"]["cache_read_input_tokens"].as_u64(),
                            reasoning_output: model_usage
                                .and_then(|m| m["thinkingTokens"].as_u64()),
                            context_input: self.context_input,
                            context_window: model_usage.and_then(|m| m["contextWindow"].as_u64()),
                            cost_usd: v["total_cost_usd"]
                                .as_f64()
                                .filter(|cost| cost.is_finite() && *cost >= 0.0),
                            model: self.model.clone(),
                            ..Default::default()
                        },
                    });
                }
                "system" if string(&v, "/subtype") == "init" => events.push(RunEvent::Activity {
                    text: "Connected to Claude".into(),
                }),
                "system" if string(&v, "/subtype") == "api_retry" => {
                    events.push(RunEvent::Activity {
                        text: "Claude is retrying the request".into(),
                    })
                }
                _ => {}
            },
            "gemini" => match string(&v, "/event").as_str() {
                "step_update" if string(&v, "/step_update/step_type") == "agent_response" => {
                    self.text.push_str(&string(&v, "/step_update/text_delta"));
                    events.push(RunEvent::Text {
                        text: self.text.clone(),
                    });
                }
                "init" => events.push(RunEvent::Activity {
                    text: "Connected to Gemini through Antigravity".into(),
                }),
                "result" => {
                    self.completed = true;
                    if v["result"]["status"] != "SUCCESS" {
                        self.failure = Some(format!(
                            "{} {}",
                            string(&v, "/result/status"),
                            string(&v, "/result/error")
                        ));
                    } else {
                        self.text = string(&v, "/result/response");
                        events.push(RunEvent::Text {
                            text: self.text.clone(),
                        });
                    }
                    events.push(RunEvent::Usage {
                        usage: TokenUsage {
                            input: v["result"]["usage"]["input_tokens"].as_u64(),
                            output: v["result"]["usage"]["output_tokens"].as_u64(),
                            cached_input: v["result"]["usage"]["cache_read_tokens"].as_u64(),
                            reasoning_output: v["result"]["usage"]["thinking_tokens"].as_u64(),
                            context_input: None,
                            context_window: None,
                            cost_usd: None,
                            model: None,
                            ..Default::default()
                        },
                    });
                }
                _ => {}
            },
            _ => {}
        }
        events
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_progress_stays_separate_from_the_final_answer() {
        let mut d = Decoder::default();
        let decode = |d: &mut Decoder, value: Value| d.decode("claude", &value.to_string());
        let mut events = vec![];
        for (id, text) in [("before", "Inspecting files."), ("after", "The answer.")] {
            events.extend(decode(&mut d, serde_json::json!({"type":"stream_event","event":{"type":"message_start","message":{"id":id}}})));
            events.extend(decode(&mut d, serde_json::json!({"type":"stream_event","event":{"delta":{"type":"text_delta","text":text}}})));
            events.extend(decode(&mut d, serde_json::json!({"type":"assistant","message":{"id":id,"content":[{"type":"text","text":text}]}})));
        }
        events.extend(decode(
            &mut d,
            serde_json::json!({"type":"result","result":"The answer."}),
        ));
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, RunEvent::Progress { .. }))
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, RunEvent::Text { .. }))
                .count(),
            1
        );
        assert_eq!(d.text, "The answer.");
        let mut d = Decoder::default();
        let commentary = d.decode_codex_server(&serde_json::json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"before","type":"agentMessage","phase":"commentary","text":"Inspecting files."}}}), "root");
        assert!(commentary
            .iter()
            .all(|e| !matches!(e, RunEvent::Text { .. })));
        let final_events = d.decode_codex_server(&serde_json::json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"final","type":"agentMessage","phase":"final_answer","text":"The answer."}}}), "root");
        assert!(final_events
            .iter()
            .any(|e| matches!(e, RunEvent::Text { text } if text == "The answer.")));
        assert_eq!(d.text, "The answer.");
    }
    #[test]
    fn app_server_subagent_stream_preserves_child_results_and_main_usage() {
        let mut d = Decoder::default();
        let decode = |d: &mut Decoder, value: Value| d.decode_codex_server(&value, "root");
        d.reported_model(Some("fixture-model"));
        let started = decode(
            &mut d,
            serde_json::json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"spawn","type":"subAgentActivity","kind":"started","agentThreadId":"child","agentPath":"/root/reader"}}}),
        );
        let first = serde_json::to_value(started).unwrap();
        assert_eq!(first[0]["tool"]["agents"][0]["status"], "running");
        decode(
            &mut d,
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"root","itemId":"reply","delta":"Main"}}),
        );
        let child = decode(
            &mut d,
            serde_json::json!({"method":"item/completed","params":{"threadId":"child","item":{"id":"child-reply","type":"agentMessage","text":"Fixture result"}}}),
        );
        assert_eq!(
            serde_json::to_value(child).unwrap()[0]["tool"]["agents"][0]["result"],
            "Fixture result"
        );
        assert_eq!(d.text, "Main");
        assert!(decode(&mut d, serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"child","tokenUsage":{"total":{"inputTokens":9999}}}})).is_empty());
        assert!(decode(&mut d, serde_json::json!({"method":"item/completed","params":{"threadId":"unrelated","item":{"id":"x","type":"agentMessage","text":"unrelated"}}})).is_empty());
        let usage = decode(
            &mut d,
            serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"root","tokenUsage":{"total":{"inputTokens":1000,"outputTokens":20,"cachedInputTokens":500},"last":{"inputTokens":600},"modelContextWindow":10000}}}),
        );
        let usage = serde_json::to_value(usage).unwrap();
        assert_eq!(usage[0]["contextInput"], 600);
        assert_eq!(usage[0]["input"], 1000);
        assert_eq!(usage[0]["scope"], "reply");
        assert_eq!(usage[0]["model"], "fixture-model");
        let finished = decode(
            &mut d,
            serde_json::json!({"method":"turn/completed","params":{"threadId":"child","turn":{"status":"failed"}}}),
        );
        assert_eq!(
            serde_json::to_value(finished).unwrap()[0]["tool"]["agents"][0]["status"],
            "error"
        );
    }
    #[test]
    fn child_agent_text_and_usage_never_replace_the_main_reply() {
        let mut d = Decoder::default();
        d.decode("claude", r#"{"type":"assistant","message":{"model":"main","usage":{"input_tokens":100},"content":[{"type":"text","text":"Main reply"}]}}"#);
        let child = d.decode("claude", r#"{"type":"assistant","parent_tool_use_id":"child","message":{"model":"child","usage":{"input_tokens":9000},"content":[{"type":"text","text":"Private child reply"}]}}"#);
        assert!(child.is_empty());
        assert_eq!(d.text, "Main reply");
        assert_eq!(d.model.as_deref(), Some("main"));
        assert_eq!(d.context_input, Some(100));
    }
    #[test]
    fn tool_activity_does_not_render_arguments_or_command_output() {
        let mut d = Decoder::default();
        for (provider, line, expected) in [
            (
                "codex",
                r#"{"type":"item.started","item":{"type":"command_execution","command":"private command"}}"#,
                "Running command",
            ),
            (
                "codex",
                r#"{"type":"item.started","item":{"type":"mcp_tool_call","arguments":"private input"}}"#,
                "Using connected tool",
            ),
            (
                "claude",
                r#"{"type":"stream_event","event":{"content_block":{"type":"tool_use","name":"Read","input":{"file_path":"private file"}}}}"#,
                "Using Read",
            ),
        ] {
            let events = d.decode(provider, line);
            assert!(matches!(events.as_slice(), [RunEvent::Activity { text }] if text == expected));
            assert!(d.text.is_empty());
        }
    }
    #[test]
    fn claude_reports_reply_cost_once_and_keeps_missing_or_invalid_cost_unknown() {
        for (reported, expected) in [
            (serde_json::json!(0.012345), Some(0.012345)),
            (serde_json::json!(0), Some(0.0)),
            (serde_json::json!(-1), None),
            (serde_json::json!("0.12"), None),
            (Value::Null, None),
        ] {
            let mut d = Decoder::default();
            let child = d.decode(
                "claude",
                r#"{"type":"result","parent_tool_use_id":"child","total_cost_usd":9}"#,
            );
            assert!(!child.iter().any(|e| matches!(e, RunEvent::Usage { .. })));
            for is_error in [false, true] {
                let events = d.decode(
                    "claude",
                    &serde_json::json!({
                        "type": "result", "is_error": is_error, "total_cost_usd": reported,
                        "modelUsage": {"main": {"costUSD": 99}, "child": {"costUSD": 99}}
                    })
                    .to_string(),
                );
                let RunEvent::Usage { usage } = events.last().unwrap() else {
                    panic!("Missing usage")
                };
                assert_eq!(usage.cost_usd, expected);
                assert_eq!(
                    serde_json::to_value(usage).unwrap()["costUsd"],
                    serde_json::json!(expected)
                );
            }
        }
        let mut d = Decoder::default();
        for (provider, line) in [
            ("claude", r#"{"type":"result"}"#),
            ("codex", r#"{"type":"turn.completed"}"#),
            (
                "gemini",
                r#"{"event":"result","result":{"status":"SUCCESS"}}"#,
            ),
        ] {
            let events = d.decode(provider, line);
            let RunEvent::Usage { usage } = events.last().unwrap() else {
                panic!("Missing usage")
            };
            assert_eq!(usage.cost_usd, None);
        }
    }
    #[test]
    fn claude_context_uses_the_last_request_and_cache_is_not_lost() {
        let mut d = Decoder::default();
        d.decode("claude",r#"{"type":"assistant","message":{"model":"claude-fable-5-1","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":200}}}"#);
        let events=d.decode("claude",r#"{"type":"result","usage":{"input_tokens":300,"cache_read_input_tokens":1900,"cache_creation_input_tokens":200,"output_tokens":50},"modelUsage":{"claude-fable-5-1":{"contextWindow":1000000,"thinkingTokens":10}}}"#);
        let RunEvent::Usage { usage } = events.last().unwrap() else {
            panic!("Missing usage")
        };
        assert_eq!(usage.input, Some(2400));
        assert_eq!(usage.context_input, Some(1200));
        assert_eq!(usage.cached_input, Some(1900));
        assert_eq!(usage.context_window, Some(1000000));
    }
    #[test]
    fn missing_last_claude_request_never_reuses_earlier_context_or_cumulative_totals() {
        let mut d = Decoder::default();
        d.decode("claude",r#"{"type":"assistant","message":{"model":"claude-haiku","usage":{"input_tokens":100}}}"#);
        d.decode(
            "claude",
            r#"{"type":"assistant","message":{"model":"claude-haiku"}}"#,
        );
        let events = d.decode(
            "claude",
            r#"{"type":"result","usage":{"input_tokens":5000,"output_tokens":20}}"#,
        );
        let RunEvent::Usage { usage } = events.last().unwrap() else {
            panic!("Missing usage")
        };
        assert_eq!(usage.input, Some(5000));
        assert_eq!(usage.context_input, None);
    }
    #[test]
    fn missing_usage_is_unknown_and_cached_tokens_are_a_subset() {
        let mut d = Decoder::default();
        let events=d.decode("codex",r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20}}"#);
        let RunEvent::Usage { usage } = events.last().unwrap() else {
            panic!("Missing usage")
        };
        assert_eq!(usage.input, Some(100));
        assert_eq!(usage.cached_input, Some(80));
        let events = d.decode("codex", r#"{"type":"turn.completed"}"#);
        let RunEvent::Usage { usage } = events.last().unwrap() else {
            panic!("Missing usage")
        };
        assert_eq!(usage.input, None);
        assert_eq!(usage.output, None);
    }
    #[test]
    fn codex_updates_do_not_duplicate_text() {
        let mut d = Decoder::default();
        d.decode(
            "codex",
            r#"{"type":"item.updated","item":{"id":"a","type":"agent_message","text":"Hel"}}"#,
        );
        d.decode(
            "codex",
            r#"{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"Hello"}}"#,
        );
        d.decode(
            "codex",
            r#"{"type":"item.completed","item":{"id":"b","type":"agent_message","text":"World"}}"#,
        );
        assert_eq!(d.text, "Hello\n\nWorld");
    }
    #[test]
    fn claude_deltas_and_final_are_reconciled() {
        let mut d = Decoder::default();
        d.decode(
            "claude",
            r#"{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Olá ✨"}}}"#,
        );
        d.decode(
            "claude",
            r#"{"type":"result","is_error":false,"result":"Olá ✨"}"#,
        );
        assert_eq!(d.text, "Olá ✨");
        assert!(d.failure.is_none());
    }
    #[test]
    fn gemini_only_renders_assistant_content() {
        let mut d = Decoder::default();
        d.decode(
            "gemini",
            r#"{"event":"step_update","step_update":{"step_type":"user_input","text_delta":"secret prompt"}}"#,
        );
        d.decode(
            "gemini",
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"One "}}"#,
        );
        d.decode(
            "gemini",
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"two"}}"#,
        );
        assert_eq!(d.text, "One two");
        assert!(!d.completed);
        d.decode("gemini", r#"{"event":"result","result":{"status":"SUCCESS","response":"One two","usage":{"input_tokens":12,"output_tokens":3}}}"#);
        assert_eq!(d.text, "One two");
        assert!(d.completed);
        assert!(d.decode("gemini", "not JSON").is_empty());
    }
    #[test]
    fn provider_errors_are_not_successes() {
        for (p, line) in [
            (
                "codex",
                r#"{"type":"turn.failed","error":{"message":"quota"}}"#,
            ),
            (
                "claude",
                r#"{"type":"result","is_error":true,"errors":["quota"]}"#,
            ),
            (
                "gemini",
                r#"{"event":"result","result":{"status":"ERROR","error":"quota"}}"#,
            ),
        ] {
            let mut d = Decoder::default();
            d.decode(p, line);
            assert!(d.failure.as_deref().unwrap().contains("quota"));
        }
    }
    #[test]
    fn gemini_non_success_results_are_failures_even_with_partial_text() {
        for status in ["ERROR", "CANCELLED", "TIMEOUT", "UNKNOWN"] {
            let mut d = Decoder::default();
            d.decode("gemini", &serde_json::json!({"event":"result","result":{"status":status,"response":"partial"}}).to_string());
            assert!(d.failure.is_some());
            assert!(d.text.is_empty());
        }
    }
}
