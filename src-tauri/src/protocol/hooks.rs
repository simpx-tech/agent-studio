//! Shared, allowlisted hook metadata. Never include hook commands, output or prompts.
use serde_json::Value;

pub fn identifier(value: &Value, limit: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= limit && !s.chars().any(char::is_control))
}

pub fn event_name(value: &Value) -> &'static str {
    match value.as_str().unwrap_or_default() {
        "PreToolUse" | "preToolUse" => "PreToolUse",
        "PostToolUse" | "postToolUse" => "PostToolUse",
        "PostToolUseFailure" => "PostToolUseFailure",
        "PermissionRequest" | "permissionRequest" => "PermissionRequest",
        "PreCompact" | "preCompact" => "PreCompact",
        "PostCompact" | "postCompact" => "PostCompact",
        "SessionStart" | "sessionStart" => "SessionStart",
        "SessionEnd" | "sessionEnd" => "SessionEnd",
        "UserPromptSubmit" | "userPromptSubmit" => "UserPromptSubmit",
        "SubagentStart" | "subagentStart" => "SubagentStart",
        "SubagentStop" | "subagentStop" => "SubagentStop",
        "Stop" | "stop" => "Stop",
        "Interrupt" | "interrupt" => "Interrupt",
        "Notification" => "Notification",
        "Setup" => "Setup",
        "TeammateIdle" => "TeammateIdle",
        "TaskCompleted" => "TaskCompleted",
        "ConfigChange" => "ConfigChange",
        "InstructionsLoaded" => "InstructionsLoaded",
        "WorktreeCreate" => "WorktreeCreate",
        "WorktreeRemove" => "WorktreeRemove",
        "Elicitation" => "Elicitation",
        "ElicitationResult" => "ElicitationResult",
        "StopFailure" => "StopFailure",
        _ => "Unknown event",
    }
}

pub fn handler_type(value: &Value) -> &'static str {
    match value.as_str().unwrap_or_default() {
        "command" => "Command",
        "mcpTool" | "mcp_tool" => "MCP tool",
        "prompt" => "Prompt",
        "agent" => "Agent",
        "http" => "HTTP",
        _ => "Unknown handler",
    }
}

pub fn source_label(value: &Value) -> &'static str {
    match value.as_str().unwrap_or_default() {
        "user" => "User",
        "project" => "Project",
        "plugin" => "Plugin",
        "sessionFlags" => "Session",
        "system"
        | "mdm"
        | "cloudRequirements"
        | "cloudManagedConfig"
        | "legacyManagedConfigFile"
        | "legacyManagedConfigMdm" => "Managed",
        _ => "Unknown",
    }
}

pub fn is_codex_hook(value: &Value) -> bool {
    matches!(
        value["method"].as_str(),
        Some("hook/started" | "hook/completed")
    ) || (matches!(
        value["method"].as_str(),
        Some("item/started" | "item/completed")
    ) && value["params"]["item"]["type"] == "hookPrompt")
}

/// SessionStart hooks can arrive before thread/start returns its validated identity.
/// Buffer only bounded lifecycle metadata, then decode after the binding succeeds.
pub fn startup_hook(value: &Value) -> Option<Value> {
    if !matches!(
        value["method"].as_str(),
        Some("hook/started" | "hook/completed")
    ) || !value["params"]["turnId"].is_null()
        || identifier(&value["params"]["threadId"], 160).is_none()
    {
        return None;
    }
    let mut run = serde_json::Map::new();
    for key in [
        "id",
        "eventName",
        "handlerType",
        "source",
        "sourcePath",
        "status",
        "executionMode",
        "scope",
        "durationMs",
    ] {
        let v = &value["params"]["run"][key];
        if v.is_null()
            || v.is_number()
            || identifier(v, if key == "sourcePath" { 4096 } else { 160 }).is_some()
        {
            run.insert(key.into(), v.clone());
        }
    }
    Some(
        serde_json::json!({"method":value["method"],"params":{"threadId":value["params"]["threadId"],"run":run}}),
    )
}
