//! What a parked Claude process asks while no reply runs (`pool::Lent`). Between replies the CLI
//! can start a turn of its own, for a background task's report or a message from another session,
//! which nobody follows: its text is never shown. Whatever such a turn asks the host is answered
//! here as a running reply would refuse it, so that the turn never waits for an answer that cannot
//! come (requested 2026-11-25): hook callbacks with no opinion, so its commands run; calls of Agent
//! Studio's own tools with an error that says why; permission prompts denied; and an MCP server's
//! form cancelled. What only the reply that launched the process can give, the list of its tools
//! and their start, is left unanswered.
use serde_json::{json, Value};

/// What the turn hears when it asks for what only a reply can give.
const NO_REPLY: &str = "No reply is running in Agent Studio now: this turn began by itself between replies, and nobody sees it or can answer it.";

/// The answer to a control request a parked Claude process wrote, as a line for its input; None
/// when the line asks nothing answered here.
pub fn answer(line: &str) -> Option<String> {
    if !line.contains("\"control_request\"") {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    if value["type"] != "control_request" {
        return None;
    }
    let id = &value["request_id"];
    let request = &value["request"];
    let success = |response: Value| json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}});
    let answer = match request["subtype"].as_str()? {
        // No opinion: the call runs as it would without the hook, during a measurement too.
        "hook_callback" => success(json!({})),
        // Claude Code's safety check asks a person even with permissions bypassed, as questions
        // and plan decisions do; a removal it stopped hears what a reply tells it.
        "can_use_tool" => {
            let removal = request["decision_reason"]
                .as_str()
                .is_some_and(|reason| reason.trim_start().starts_with("Dangerous rm"));
            if removal {
                super::questions::refuse_tool(&value, false)
            } else {
                success(json!({"behavior":"deny","message":format!(
                    "{NO_REPLY} The action was NOT performed; do not claim it succeeded. Leave it for the next reply."
                )}))
            }
        }
        // An MCP server's form, which nobody is there to fill in.
        "elicitation" => success(json!({"action":"cancel"})),
        "mcp_message" if request["server_name"] != "agent_studio" => {
            json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"This control request is unavailable in Agent Studio."}})
        }
        "mcp_message" => {
            let message = &request["message"];
            let mut response = json!({"jsonrpc":"2.0","id":message["id"]});
            match message["method"].as_str().unwrap_or_default() {
                "tools/call" => {
                    let tool = message["params"]["name"].as_str().unwrap_or("this tool");
                    response["result"] = json!({"isError":true,"content":[{"type":"text","text":format!(
                        "{NO_REPLY} Agent Studio's tools answer only during a reply, so {tool} did nothing. Leave it for the next reply."
                    )}]});
                }
                "ping" => response["result"] = json!({}),
                method if method.starts_with("notifications/") => response["result"] = json!({}),
                // The list of its tools and their start belong to the reply that launched it.
                _ => return None,
            }
            success(json!({ "mcp_response": response }))
        }
        _ => return None,
    };
    Some(format!("{answer}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(request: Value) -> Value {
        let line = json!({"type":"control_request","request_id":"r-1","request":request});
        let answer = answer(&line.to_string()).expect("answered");
        assert!(answer.ends_with('\n'));
        let answer: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(answer["type"], "control_response");
        assert_eq!(answer["response"]["request_id"], "r-1");
        answer["response"].clone()
    }

    #[test]
    fn a_parked_turn_hears_what_a_reply_would_refuse_and_its_hooks_have_no_opinion() {
        let hook = asked(
            json!({"subtype":"hook_callback","callback_id":"studio-pc-gate","input":{"hook_event_name":"PreToolUse","tool_name":"Bash"}}),
        );
        assert_eq!(hook["subtype"], "success");
        assert_eq!(hook["response"], json!({}));
        // Agent Studio's tools refuse with the reason, as a tool error the model reads.
        let call = asked(
            json!({"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"pc_status","arguments":{}}}}),
        );
        let result = &call["response"]["mcp_response"];
        assert_eq!(result["id"], 7);
        assert_eq!(result["result"]["isError"], true);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("No reply is running in Agent Studio now"),
            "{text}"
        );
        assert!(text.contains("pc_status did nothing"), "{text}");
        let ping = asked(
            json!({"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":8,"method":"ping"}}),
        );
        assert_eq!(ping["response"]["mcp_response"]["result"], json!({}));
        let note = asked(
            json!({"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","method":"notifications/cancelled"}}),
        );
        assert_eq!(note["response"]["mcp_response"]["result"], json!({}));
        // Another server is none of Agent Studio's, as a reply says.
        assert_eq!(
            asked(
                json!({"subtype":"mcp_message","server_name":"other","message":{"id":1,"method":"tools/call"}})
            )["subtype"],
            "error"
        );
        // Permission prompts are denied, a stopped removal as a reply refuses it.
        let prompt =
            asked(json!({"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{}}));
        assert_eq!(prompt["response"]["behavior"], "deny");
        assert!(prompt["response"]["message"]
            .as_str()
            .unwrap()
            .contains("The action was NOT performed"));
        let removal = asked(
            json!({"subtype":"can_use_tool","tool_name":"Bash","decision_reason":"Dangerous rm operation on critical path: /x","decision_reason_type":"safetyCheck"}),
        );
        assert_eq!(removal["response"]["behavior"], "deny");
        assert!(removal["response"]["message"]
            .as_str()
            .unwrap()
            .contains("built-in Claude Code safety check"));
        // A form nobody can fill in is cancelled.
        let form = asked(
            json!({"subtype":"elicitation","mcp_server_name":"linear","message":"Pick a team"}),
        );
        assert_eq!(form["response"], json!({"action":"cancel"}));
    }

    #[test]
    fn what_only_a_reply_can_give_and_lines_that_ask_nothing_are_left() {
        for method in ["initialize", "tools/list"] {
            let line = json!({"type":"control_request","request_id":"r","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":1,"method":method}}});
            assert_eq!(answer(&line.to_string()), None, "{method}");
        }
        assert_eq!(answer("{\"type\":\"assistant\"}"), None);
        assert_eq!(answer("not json \"control_request\""), None);
        assert_eq!(
            answer(&json!({"type":"control_response","response":{"subtype":"success","request_id":"control_request"}}).to_string()),
            None
        );
        assert_eq!(
            answer(&json!({"type":"control_request","request_id":"r","request":{"subtype":"something_new"}}).to_string()),
            None
        );
    }
}
