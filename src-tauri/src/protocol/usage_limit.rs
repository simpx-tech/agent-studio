//! A usage limit that stopped a reply, in the provider's own words. Claude Code answers a
//! request refused at the account's limit with a synthetic assistant message of its own, and
//! Codex fails the turn with a `usageLimitExceeded` error. Neither is the model's text, so the
//! reply shows it as the limit that stopped it, never as progress or its answer.
use serde::Serialize;
use serde_json::Value;

/// Claude Code's model name for the messages it writes itself rather than the model: they carry
/// no model and no request's token counts.
pub const SYNTHETIC_MODEL: &str = "<synthetic>";

/// The first words of Claude Code's lines about a limit it reached, such as "You've hit your
/// session limit · resets 1:50pm (America/Sao_Paulo)". Its warnings ("You've used 90% …") and
/// notices ("Now using extra usage") are not here. `src/lib/usage-limits.ts` recognizes the
/// same lines in replies saved before they were decoded apart.
const CLAUDE_LINES: [&str; 10] = [
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
    "You're out of extra usage",
    "Your org is out of usage",
    "Your seat type doesn't include usage",
    "Your seat type doesn't include extra usage",
    "Your usage allocation has been disabled",
    "Your group's usage limit is set to",
    "Fable 5 requires usage credits",
];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageLimit {
    pub revision: u64,
    pub text: String,
}

/// The line as a reply shows it: one line, whole.
pub fn line(text: &str) -> Option<String> {
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

fn claude_line(text: &str) -> bool {
    let text = text.replace('\u{2019}', "'");
    CLAUDE_LINES.iter().any(|start| text.starts_with(start))
        || (text.starts_with("Fable ")
            && text
                .chars()
                .take(64)
                .collect::<String>()
                .contains(" requires usage credits."))
}

/// Claude Code's line when a request of the reply stopped at a usage limit: a synthetic parent
/// message of the rate-limit kind. Versions that did not name the kind are recognized by its
/// wording alone.
pub fn claude(v: &Value) -> Option<String> {
    let message = &v["message"];
    if v["type"] != "assistant"
        || !v["parent_tool_use_id"].is_null()
        || message["model"] != SYNTHETIC_MODEL
        || !(v["error"].is_null() || v["error"] == "rate_limit")
    {
        return None;
    }
    let text = message["content"]
        .as_array()?
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    claude_line(text.trim()).then(|| line(&text)).flatten()
}

/// Codex's message when a turn failed at the account's usage limit.
pub fn codex(error: &Value) -> Option<String> {
    (error["codexErrorInfo"] == "usageLimitExceeded").then(|| {
        error["message"]
            .as_str()
            .and_then(line)
            .unwrap_or_else(|| "Codex reported that this account reached its usage limit.".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn synthetic(text: &str) -> Value {
        json!({"type":"assistant","parent_tool_use_id":null,"error":"rate_limit","is_api_error_message":true,"message":{"id":"b5b9d6d0-8fe4-4efb-a83a-4c65d0b3ef48","model":"<synthetic>","role":"assistant","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":text}]}})
    }

    #[test]
    fn claude_limit_lines_come_only_from_its_synthetic_parent_messages() {
        let session = "You've hit your session limit \u{b7} resets 1:50pm (America/Sao_Paulo)";
        assert_eq!(claude(&synthetic(session)).as_deref(), Some(session));
        for text in [
            "You've hit your weekly limit \u{b7} resets Oct 7, 1pm",
            "You've reached your Fable limit. Switch to another model to continue.",
            "You're out of usage credits. Run /usage-credits to keep using Opus 5.5 or /model to switch models.",
            "Fable 5.1 requires usage credits. Switch to another model to continue.",
        ] {
            assert!(claude(&synthetic(text)).is_some(), "{text}");
        }
        // Older versions named no error kind.
        let mut older = synthetic(session);
        older.as_object_mut().unwrap().remove("error");
        assert!(claude(&older).is_some());
        // The model's own words, other synthetic failures, warnings and sub-agents are not limits.
        let mut model = synthetic(session);
        model["message"]["model"] = json!("claude-opus-5-5");
        let mut child = synthetic(session);
        child["parent_tool_use_id"] = json!("agent-call");
        let mut other = synthetic(session);
        other["error"] = json!("server_error");
        for value in [
            model,
            child,
            other,
            synthetic("API Error: Request rejected (429) \u{b7} this may be a temporary capacity issue."),
            synthetic("You've used 90% of your session limit"),
            synthetic("Now using extra usage"),
            synthetic("Fable is a model that requires usage credits for some plans and this line is long."),
        ] {
            assert_eq!(claude(&value), None, "{value}");
        }
    }

    #[test]
    fn limit_lines_are_one_whole_line_and_codex_needs_its_error_kind() {
        let long = format!("You've hit your limit\n\u{7}\t{}", "x".repeat(900));
        let text = claude(&synthetic(&long)).unwrap();
        assert_eq!(text.chars().count(), 922);
        assert!(text.starts_with("You've hit your limit x"));
        let limit = json!({"message":"You\u{2019}ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.","codexErrorInfo":"usageLimitExceeded"});
        assert!(codex(&limit)
            .unwrap()
            .starts_with("You\u{2019}ve hit your usage limit."));
        assert!(codex(&json!({"codexErrorInfo":"usageLimitExceeded"}))
            .unwrap()
            .contains("usage limit"));
        for error in [
            json!({"message":"Too many requests","codexErrorInfo":"rateLimitExceeded"}),
            json!({"message":"You've hit your usage limit.","codexErrorInfo":null}),
            Value::Null,
        ] {
            assert_eq!(codex(&error), None);
        }
    }
}
