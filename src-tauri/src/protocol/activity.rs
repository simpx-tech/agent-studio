//! Bounded, allowlisted presentation data from provider tool events. Never forwards
//! command output, configuration, skill bodies, or arbitrary tool arguments.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
mod hooks;
mod progress;
mod subagents;
use progress::{ToolClock, ToolProgress};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    title: String,
    url: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    name: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    messages: Vec<subagents::AgentMessage>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    messages_truncated: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub id: String,
    pub revision: u64,
    pub category: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<ToolProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    command_run: bool,
    facts: Vec<ActivityFact>,
    sources: Vec<Source>,
    agents: Vec<AgentActivity>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ActivityFact {
    label: String,
    value: String,
}
fn fact(tool: &mut ToolActivity, label: &str, value: impl ToString) {
    let value = clean(&value.to_string(), 4096);
    if value.is_empty() {
        return;
    }
    if let Some(existing) = tool.facts.iter_mut().find(|f| f.label == label) {
        existing.value = value;
    } else if tool.facts.len() < 12 {
        tool.facts.push(ActivityFact {
            label: label.into(),
            value,
        });
    }
}
fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(limit)
        .collect()
}
fn field(v: &Value, key: &str, limit: usize) -> Option<String> {
    v[key]
        .as_str()
        .map(|s| clean(s, limit))
        .filter(|s| !s.is_empty())
}
fn status(value: &str) -> &'static str {
    match value {
        "in_progress" | "inProgress" | "running" | "started" | "pending_init" | "pendingInit" => {
            "running"
        }
        "completed" | "complete" => "complete",
        "failed" | "errored" | "error" | "not_found" | "declined" => "error",
        "interrupted" | "shutdown" | "stopped" | "cancelled" => "cancelled",
        _ => "unknown",
    }
}
fn fresh(id: String, category: &str, name: &str) -> ToolActivity {
    ToolActivity {
        id,
        revision: 0,
        category: category.into(),
        name: clean(name, 200),
        status: "running".into(),
        elapsed_ms: None,
        progress: None,
        parent_id: None,
        detail: None,
        query: None,
        path: None,
        operation: None,
        command_run: false,
        facts: vec![],
        sources: vec![],
        agents: vec![],
    }
}
fn text_content(value: &Value, limit: usize) -> String {
    if let Some(text) = value.as_str() {
        return clean(text, limit);
    }
    clean(
        &value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .take(20)
            .collect::<Vec<_>>()
            .join("\n"),
        limit,
    )
}
fn source(url: &str, title: &str) -> Option<Source> {
    if url.len() > 2048 {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    Some(Source {
        title: clean(title, 300),
        url: parsed.to_string(),
    })
}
fn sources(value: &Value, output: &mut Vec<Source>, depth: usize) {
    if depth > 5 || output.len() >= 12 {
        return;
    }
    if let Some(items) = value.as_array() {
        for item in items.iter().take(30) {
            sources(item, output, depth + 1);
        }
    } else if value.is_object() {
        if let (Some(url), Some(title)) = (value["url"].as_str(), value["title"].as_str()) {
            if let Some(item) = source(url, title) {
                if output.len() < 12 && !output.iter().any(|s| s.url == item.url) {
                    output.push(item);
                }
            }
        }
        for key in ["content", "results", "links", "sources"] {
            sources(&value[key], output, depth + 1);
        }
        if let Some(text) = value["text"].as_str() {
            sources(&Value::String(text.into()), output, depth + 1);
        }
    } else if let Some(text) = value.as_str() {
        // Claude WebSearch can return a text envelope with one JSON Links array.
        for line in text.lines().take(40) {
            if let Some(links) = line.trim().strip_prefix("Links: ") {
                if links.len() <= 32_000 {
                    if let Ok(value) = serde_json::from_str::<Value>(links) {
                        sources(&value, output, depth + 1);
                    }
                }
            }
        }
    }
}

struct PartialTool {
    id: String,
    name: String,
    parent: Option<String>,
    json: String,
}
#[derive(Default)]
pub struct ToolDecoder {
    tools: Vec<ToolActivity>,
    partial: HashMap<String, PartialTool>,
    tasks: HashMap<String, String>,
    overflow: bool,
    clocks: HashMap<String, ToolClock>,
    progress_bindings: HashMap<String, (String, String)>,
    child_turns: HashMap<String, String>,
    agent_lifecycle: std::collections::HashSet<String>,
}
impl ToolDecoder {
    pub fn owns_codex_thread(&self, thread: &str, root: &str) -> bool {
        thread == root
            || self
                .tools
                .iter()
                .any(|t| t.id == "codex:agents" && t.agents.iter().any(|a| a.id == thread))
    }
    pub fn codex_server(&mut self, value: &Value, root: &str) -> Vec<ToolActivity> {
        let mut out = vec![];
        let method = value["method"].as_str().unwrap_or_default();
        let params = &value["params"];
        let thread = params["threadId"].as_str().unwrap_or_default();
        if !self.owns_codex_thread(thread, root) {
            return out;
        }
        if self.codex_subagent(value, root, &mut out) {
            return out;
        }
        if self.codex_progress(value, &mut out) {
            return out;
        }
        let item = &params["item"];
        let kind = item["type"].as_str().unwrap_or_default();
        if !self.bind_progress(value) {
            return out;
        }
        if self.codex_hook(value, root, &mut out) {
            return out;
        }
        if matches!(method, "item/started" | "item/completed") && kind == "dynamicToolCall" {
            if let Some(id) = field(item, "id", 220) {
                let mut tool = fresh(
                    format!("codex:{thread}:{id}"),
                    "tool",
                    &field(item, "tool", 200).unwrap_or_else(|| "Application tool".into()),
                );
                tool.status = if method == "item/started" {
                    "running"
                } else if item["success"] == false {
                    "error"
                } else {
                    status(item["status"].as_str().unwrap_or_default())
                }
                .into();
                tool.detail = Some("Application tool call reported by Codex. Arguments and returned content are not displayed.".into());
                tool.elapsed_ms = progress::duration_ms(&item["durationMs"]);
                if thread != root {
                    tool.parent_id = Some(thread.into());
                }
                self.publish(tool, &mut out);
            }
        } else if matches!(method, "item/started" | "item/completed") {
            let normalized = match kind {
                "commandExecution" => "command_execution",
                "fileChange" => "file_change",
                "mcpToolCall" => "mcp_tool_call",
                "collabAgentToolCall" => "collab_tool_call",
                "webSearch" => "web_search",
                _ => return out,
            };
            let mut item = item.clone();
            item["type"] = Value::String(normalized.into());
            if let Some(id) = item["id"].as_str() {
                item["id"] = Value::String(format!("{thread}:{id}"));
            }
            if thread != root {
                item["parent_id"] = Value::String(thread.into());
            }
            if normalized == "collab_tool_call" {
                for (new, old) in [
                    ("sender_thread_id", "senderThreadId"),
                    ("receiver_thread_ids", "receiverThreadIds"),
                    ("agents_states", "agentsStates"),
                ] {
                    item[new] = item[old].clone();
                }
                item["tool"] = Value::String(
                    match item["tool"].as_str().unwrap_or_default() {
                        "spawnAgent" => "spawn_agent",
                        "sendInput" => "send_input",
                        "closeAgent" => "close_agent",
                        value => value,
                    }
                    .into(),
                );
            }
            let event = serde_json::json!({"type":if method == "item/started" {"item.started"} else {"item.completed"},"item":item});
            self.codex(&event, &mut out);
        }
        out
    }
    fn existing(&self, id: &str) -> Option<ToolActivity> {
        self.tools.iter().find(|t| t.id == id).cloned()
    }
    fn publish(&mut self, mut tool: ToolActivity, out: &mut Vec<ToolActivity>) {
        if let Some(previous) = self.existing(&tool.id) {
            if tool.category != "agent" && previous.status != "running" && tool.status == "running"
            {
                return;
            }
            if tool.progress.is_none() {
                tool.progress = previous.progress;
            }
            if previous.status != "running" && tool.elapsed_ms.is_none() {
                tool.elapsed_ms = previous.elapsed_ms;
            }
        }
        self.time_tool(&mut tool);
        if let Some(index) = self.tools.iter().position(|t| t.id == tool.id) {
            tool.revision = self.tools[index].revision;
            if tool == self.tools[index] {
                return;
            }
            tool.revision += 1;
            self.tools[index] = tool.clone();
        } else if self.tools.len() < 200 {
            tool.revision = 1;
            self.tools.push(tool.clone());
        } else {
            if !self.overflow {
                self.overflow = true;
                let mut limit = fresh("activity-limit".into(), "tool", "Activity limit reached");
                limit.status = "unknown".into();
                limit.detail = Some("Additional operations are not shown after 200 entries. Updates to existing operations are still retained.".into());
                limit.revision = 1;
                out.push(limit);
            }
            return;
        }
        out.push(tool);
    }
    fn group(&self, provider: &str) -> ToolActivity {
        let id = format!("{provider}:agents");
        self.existing(&id)
            .unwrap_or_else(|| fresh(id, "agent", "Sub-agents"))
    }
    fn publish_group(&mut self, mut group: ToolActivity, out: &mut Vec<ToolActivity>) {
        if !group.agents.is_empty() {
            group.status = if group.agents.iter().any(|a| a.status == "running") {
                "running"
            } else if group.agents.iter().any(|a| a.status == "error") {
                "error"
            } else if group.agents.iter().any(|a| a.status == "unknown") {
                "unknown"
            } else if group.agents.iter().any(|a| a.status == "cancelled") {
                "cancelled"
            } else {
                "complete"
            }
            .into();
        }
        self.publish(group, out);
    }
    fn agent<'a>(group: &'a mut ToolActivity, id: &str) -> Option<&'a mut AgentActivity> {
        if let Some(index) = group.agents.iter().position(|a| a.id == id) {
            return Some(&mut group.agents[index]);
        }
        if group.agents.len() >= 64 {
            group.detail = Some("Only the first 64 sub-agents are shown.".into());
            return None;
        }
        group.agents.push(AgentActivity {
            id: clean(id, 240),
            agent_id: None,
            name: format!("Sub-agent {}", group.agents.len() + 1),
            status: "running".into(),
            parent_id: None,
            task: None,
            result: None,
            messages: vec![],
            messages_truncated: false,
        });
        group.agents.last_mut()
    }
    pub fn decode(&mut self, provider: &str, v: &Value) -> Vec<ToolActivity> {
        let mut out = vec![];
        if provider == "codex" {
            self.codex(v, &mut out);
        }
        if provider == "claude" {
            self.claude(v, &mut out);
        }
        out
    }
    fn codex(&mut self, v: &Value, out: &mut Vec<ToolActivity>) {
        let event = v["type"].as_str().unwrap_or_default();
        if !matches!(event, "item.started" | "item.updated" | "item.completed") {
            return;
        }
        let item = &v["item"];
        let Some(id) = field(item, "id", 220) else {
            return;
        };
        let kind = item["type"].as_str().unwrap_or_default();
        if kind == "collab_tool_call" {
            let mut group = self.group("codex");
            let action = item["tool"].as_str().unwrap_or_default();
            if item["status"] == "failed" {
                group.status = "error".into();
                group.detail = Some("A delegation operation failed.".into());
            }
            let mut ids: Vec<String> = item["receiver_thread_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(String::from))
                .take(64)
                .collect();
            if let Some(states) = item["agents_states"].as_object() {
                for id in states.keys().take(64) {
                    if !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
            }
            for id in ids {
                if let Some(agent) = Self::agent(&mut group, &id) {
                    if action == "spawn_agent" {
                        if let Some(task) = field(item, "prompt", 2048) {
                            agent.task = Some(task);
                        }
                        agent.parent_id = field(item, "sender_thread_id", 240);
                    }
                    let state = &item["agents_states"][&id];
                    if let Some(reported) = state["status"].as_str() {
                        agent.status = status(reported).into();
                    }
                    if let Some(result) = field(state, "message", 8000) {
                        agent.result = Some(result);
                    }
                    if action == "close_agent"
                        && event == "item.completed"
                        && item["status"] != "failed"
                        && agent.status == "running"
                    {
                        agent.status = "cancelled".into();
                    }
                }
            }
            self.publish_group(group, out);
            return;
        }
        let (category, name) = match kind {
            "web_search" => ("search", "Web search"),
            "command_execution" => ("tool", "Run command"),
            "file_change" => ("tool", "Edit files"),
            "mcp_tool_call" => ("tool", "Connected tool"),
            _ => return,
        };
        let id = format!("codex:{id}");
        let mut tool = self
            .existing(&id)
            .unwrap_or_else(|| fresh(id, category, name));
        if event == "item.completed" {
            tool.elapsed_ms = progress::duration_ms(&item["durationMs"])
                .or_else(|| progress::duration_ms(&item["duration_ms"]));
        }
        tool.parent_id = field(item, "parent_id", 240);
        tool.status = if let Some(value) = item["status"].as_str() {
            status(value)
        } else if event == "item.completed" {
            "complete"
        } else {
            "running"
        }
        .into();
        if kind == "web_search" {
            tool.query =
                field(item, "query", 2048).or_else(|| field(&item["action"], "query", 2048));
            if let Some(url) = item["action"]["url"].as_str() {
                if let Some(link) = source(url, url) {
                    tool.sources = vec![link];
                    tool.name = "Open web page".into();
                }
            }
            sources(item, &mut tool.sources, 0);
        } else if kind == "command_execution" {
            tool.command_run = true;
            tool.operation = Some("command".into());
            if let Some(path) = item["command"].as_str().and_then(direct_read_path) {
                tool.name = "Read file".into();
                tool.operation = Some("read".into());
                tool.path = Some(path);
            }
            if let Some(cwd) = field(item, "cwd", 4096) {
                fact(&mut tool, "Folder", cwd);
            }
            if let Some(code) = item["exitCode"]
                .as_i64()
                .or_else(|| item["exit_code"].as_i64())
            {
                fact(&mut tool, "Exit code", code);
            }
            for action in item["commandActions"]
                .as_array()
                .into_iter()
                .flatten()
                .take(12)
            {
                match action["type"].as_str().unwrap_or_default() {
                    "read" => {
                        tool.name = "Read file".into();
                        tool.operation = Some("read".into());
                        if let Some(path) = field(action, "path", 4096) {
                            tool.path = Some(path);
                        }
                    }
                    "listFiles" | "list_files" => {
                        tool.name = "List files".into();
                        tool.operation = Some("glob".into());
                        tool.path = field(action, "path", 4096);
                    }
                    "search" => {
                        tool.name = "Search files".into();
                        tool.operation = Some("grep".into());
                        tool.query = field(action, "query", 2048);
                        tool.path = field(action, "path", 4096);
                    }
                    _ => {}
                }
            }
            let reported_read = item["commandActions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|action| action["type"] == "read")
                .find_map(|action| field(action, "path", 4096).filter(|path| is_skill_path(path)));
            if let Some(path) =
                reported_read.or_else(|| item["command"].as_str().and_then(skill_read_path))
            {
                if let Some(other) = &tool.path {
                    if other != &path {
                        let other = other.clone();
                        fact(&mut tool, "Also read", other);
                    }
                }
                tool.category = "skill".into();
                tool.name = "Read skill file".into();
                tool.operation = Some("read".into());
                tool.path = Some(path);
                tool.detail = Some("A skill file read was reported by the CLI. This does not establish that every skill instruction was followed.".into());
            }
        } else if kind == "mcp_tool_call" {
            if let Some(name) = field(item, "tool", 160) {
                tool.name = format!("Connected tool: {name}");
            }
            if let Some(server) = field(item, "server", 200) {
                fact(&mut tool, "Connection", server);
            }
        } else if kind == "file_change" {
            tool.operation = Some("edit".into());
            let paths = item["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .take(12)
                .filter_map(|change| field(change, "path", 4096))
                .collect::<Vec<_>>();
            if !paths.is_empty() {
                fact(&mut tool, "Files", paths.join("\n"));
            }
        }
        self.publish(tool, out);
    }
    fn claude_tool(
        &mut self,
        id: &str,
        name: &str,
        input: &Value,
        parent: Option<String>,
        out: &mut Vec<ToolActivity>,
    ) {
        if matches!(name, "Agent" | "Task") {
            let mut group = self.group("claude");
            if let Some(agent) = Self::agent(&mut group, id) {
                if let Some(resume) = field(input, "resume", 240) {
                    agent.agent_id = Some(resume);
                }
                if let Some(name) =
                    field(input, "description", 200).or_else(|| field(input, "subagent_type", 200))
                {
                    agent.name = name;
                }
                if let Some(task) = field(input, "prompt", 2048) {
                    agent.task = Some(task);
                }
                agent.parent_id = parent;
            }
            self.publish_group(group, out);
            return;
        }
        let tool_id = format!("claude:{id}");
        let category = match name {
            "Skill" => "skill",
            "WebSearch" | "WebFetch" => "search",
            _ => "tool",
        };
        let mut tool = self
            .existing(&tool_id)
            .unwrap_or_else(|| fresh(tool_id, category, name));
        tool.parent_id = parent;
        if self.claude_team_tool(&mut tool, name, input) {
            self.publish(tool, out);
            return;
        }
        match name {
            "Skill" => {
                tool.name = field(input, "skill", 180)
                    .map(|s| format!("Skill: {s}"))
                    .unwrap_or_else(|| "Load skill".into());
                tool.detail = Some("Skill invocation reported by Claude.".into());
            }
            "Read" => {
                tool.operation = Some("read".into());
                if let Some(path) = field(input, "file_path", 4096) {
                    if is_skill_path(&path) {
                        tool.category = "skill".into();
                        tool.name = "Read skill file".into();
                    }
                    tool.path = Some(path);
                }
                for (key, label) in [("offset", "Start line"), ("limit", "Line limit")] {
                    if let Some(value) = input[key].as_u64() {
                        fact(&mut tool, label, value);
                    }
                }
                if let Some(pages) = field(input, "pages", 100) {
                    fact(&mut tool, "Pages", pages);
                }
            }
            "Glob" | "Grep" => {
                tool.name = if name == "Glob" {
                    "Find files"
                } else {
                    "Search file contents"
                }
                .into();
                tool.operation = Some(if name == "Glob" { "glob" } else { "grep" }.into());
                if let Some(pattern) = field(input, "pattern", 2048) {
                    tool.query = Some(pattern);
                }
                if let Some(path) = field(input, "path", 4096) {
                    tool.path = Some(path);
                }
                if let Some(glob) = field(input, "glob", 2048) {
                    fact(&mut tool, "File filter", glob);
                }
            }
            "mcp__agent_studio__await_background_tasks" => {
                tool.name = "Wait for background tasks".into();
                if let Some(ids) = input["task_ids"].as_array() {
                    let ids: Vec<_> = ids.iter().filter_map(Value::as_str).take(8).collect();
                    fact(&mut tool, "Tasks", ids.join(", "));
                }
            }
            "ToolSearch" => {
                tool.name = "Find tools".into();
                tool.operation = Some("toolSearch".into());
                if let Some(query) = field(input, "query", 2048) {
                    tool.query = Some(query);
                }
            }
            "Bash" | "PowerShell" => {
                tool.name = "Run command".into();
                tool.command_run = true;
                tool.operation = Some("command".into());
                if let Some(description) = field(input, "description", 2048) {
                    tool.detail = Some(description);
                }
            }
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => {
                tool.operation = Some("edit".into());
                tool.path =
                    field(input, "file_path", 4096).or_else(|| field(input, "notebook_path", 4096));
            }
            "WebSearch" => {
                tool.name = "Web search".into();
                if let Some(query) = field(input, "query", 2048) {
                    tool.query = Some(query);
                }
            }
            "WebFetch" => {
                tool.name = "Open web page".into();
                if let Some(url) = input["url"].as_str() {
                    if let Some(link) = source(url, url) {
                        tool.sources = vec![link];
                    }
                }
            }
            _ => {}
        }
        self.publish(tool, out);
    }
    fn claude(&mut self, v: &Value, out: &mut Vec<ToolActivity>) {
        if self.claude_progress(v, out) {
            return;
        }
        if self.claude_hook(v, out) {
            return;
        }
        let kind = v["type"].as_str().unwrap_or_default();
        let parent = field(v, "parent_tool_use_id", 240);
        if !v["parent_tool_use_id"].is_null() && parent.is_none() {
            return;
        }
        self.claude_child_text(v, out);
        if kind == "stream_event" {
            let event = &v["event"];
            let key = format!("{}:{}", parent.as_deref().unwrap_or("root"), event["index"]);
            match event["type"].as_str().unwrap_or_default() {
                "content_block_start" => {
                    let block = &event["content_block"];
                    if matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                        if let (Some(id), Some(name)) =
                            (field(block, "id", 220), field(block, "name", 200))
                        {
                            self.claude_tool(&id, &name, &block["input"], parent.clone(), out);
                            if self.partial.len() < 64 {
                                self.partial.insert(
                                    key,
                                    PartialTool {
                                        id,
                                        name,
                                        parent: parent.clone(),
                                        json: String::new(),
                                    },
                                );
                            }
                        }
                    }
                }
                "content_block_delta" if event["delta"]["type"] == "input_json_delta" => {
                    if let Some(tool) = self.partial.get_mut(&key) {
                        if let Some(partial) = event["delta"]["partial_json"].as_str() {
                            if tool.json.len() + partial.len() <= 64_000 {
                                tool.json.push_str(partial);
                            } else {
                                self.partial.remove(&key);
                            }
                        }
                    }
                }
                "content_block_stop" => {
                    if let Some(tool) = self.partial.remove(&key) {
                        if let Ok(input) = serde_json::from_str::<Value>(&tool.json) {
                            self.claude_tool(&tool.id, &tool.name, &input, tool.parent, out);
                        }
                    }
                }
                _ => {}
            }
        }
        if matches!(kind, "assistant" | "user") {
            for block in v["message"]["content"].as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or_default() {
                    "tool_use" | "server_tool_use" => {
                        if let (Some(id), Some(name)) =
                            (field(block, "id", 220), field(block, "name", 200))
                        {
                            self.claude_tool(&id, &name, &block["input"], parent.clone(), out);
                        }
                    }
                    "tool_result" | "web_search_tool_result" => {
                        let Some(id) = field(block, "tool_use_id", 220) else {
                            continue;
                        };
                        let mut group = self.group("claude");
                        if let Some(agent) = group.agents.iter_mut().find(|a| a.id == id) {
                            if agent.parent_id != parent {
                                continue;
                            }
                            if let Some(agent_id) = field(&v["tool_use_result"], "agentId", 240) {
                                agent.agent_id = Some(agent_id);
                            }
                            let background = v["tool_use_result"]["isAsync"] == true;
                            agent.status = if block["is_error"] == true {
                                "error"
                            } else if background {
                                "running"
                            } else {
                                "complete"
                            }
                            .into();
                            if !background {
                                let result = text_content(&v["tool_use_result"]["content"], 8000);
                                agent.result = Some(if result.is_empty() {
                                    text_content(&block["content"], 8000)
                                } else {
                                    result
                                });
                            }
                            self.publish_group(group, out);
                        } else if let Some(mut tool) = self.existing(&format!("claude:{id}")) {
                            if tool.parent_id != parent {
                                continue;
                            }
                            tool.status = if block["is_error"] == true
                                || block["content"]["type"] == "web_search_tool_result_error"
                            {
                                "error"
                            } else if tool.command_run
                                && (v["tool_use_result"]["isAsync"] == true
                                    || v["tool_use_result"]["backgroundTaskId"].is_string())
                            {
                                "running"
                            } else {
                                "complete"
                            }
                            .into();
                            if tool.category == "search" {
                                sources(&block["content"], &mut tool.sources, 0);
                                sources(&v["tool_use_result"], &mut tool.sources, 0);
                            }
                            let result = &v["tool_use_result"];
                            if tool.operation.as_deref() == Some("listAgents") {
                                Self::claude_agent_list(&mut tool, result);
                            }
                            match tool.operation.as_deref() {
                                Some("read") => {
                                    for (key, label) in [
                                        ("numLines", "Lines read"),
                                        ("startLine", "Start line"),
                                        ("totalLines", "Total lines"),
                                    ] {
                                        if let Some(count) = result["file"][key].as_u64() {
                                            fact(&mut tool, label, count);
                                        }
                                    }
                                }
                                Some("glob" | "grep") => {
                                    for (key, label) in [
                                        ("numFiles", "Files found"),
                                        ("numLines", "Matching lines"),
                                    ] {
                                        if let Some(count) = result[key].as_u64() {
                                            fact(&mut tool, label, count);
                                        }
                                    }
                                    let paths = result["filenames"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .take(12)
                                        .filter_map(|p| p.as_str())
                                        .map(|p| clean(p, 4096))
                                        .collect::<Vec<_>>();
                                    if !paths.is_empty() {
                                        fact(&mut tool, "Matching files", paths.join("\n"));
                                    }
                                }
                                Some("toolSearch") => {
                                    let names = block["content"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .take(30)
                                        .filter(|b| b["type"] == "tool_reference")
                                        .filter_map(|b| field(b, "tool_name", 200))
                                        .collect::<Vec<_>>();
                                    if !names.is_empty() {
                                        fact(&mut tool, "Tools found", names.join("\n"));
                                    }
                                }
                                _ => {}
                            }
                            if tool.status == "error" {
                                tool.detail = Some(
                                    "The provider reported that this operation failed.".into(),
                                );
                            }
                            self.publish(tool, out);
                        }
                    }
                    _ => {}
                }
            }
        }
        if kind == "system"
            && matches!(
                v["subtype"].as_str(),
                Some("task_started" | "task_progress" | "task_notification")
            )
        {
            if let Some(progress) = v["workflow_progress"].as_array() {
                let mut group = self.group("claude");
                for entry in progress
                    .iter()
                    .filter(|e| e["type"] == "workflow_agent")
                    .take(128)
                {
                    let Some(id) = field(entry, "agentId", 240) else {
                        continue;
                    };
                    if let Some(agent) = Self::agent(&mut group, &id) {
                        agent.agent_id = Some(id);
                        agent.name =
                            field(entry, "label", 200).unwrap_or_else(|| "Workflow agent".into());
                        agent.status = match entry["state"].as_str() {
                            Some("done" | "cached") => "complete",
                            Some("start") => "running",
                            Some("error" | "failed") => "error",
                            Some("cancelled" | "stopped") => "cancelled",
                            _ => "unknown",
                        }
                        .into();
                        agent.result = field(entry, "resultPreview", 2000);
                    }
                }
                self.publish_group(group, out);
            }
            let task = field(v, "task_id", 240).unwrap_or_default();
            let id = field(v, "tool_use_id", 240).or_else(|| self.tasks.get(&task).cloned());
            if let Some(id) = id {
                // A workflow is an orchestrator, not another child agent.
                if v["task_type"] == "local_workflow"
                    || self
                        .tools
                        .iter()
                        .any(|t| t.id == format!("claude:{id}") && t.name == "Workflow")
                {
                    if self.tasks.len() < 64 {
                        self.tasks.insert(task, id);
                    }
                    return;
                }
                if self.tasks.len() < 64 {
                    self.tasks.insert(task, id.clone());
                }
                // CLI shell tasks use the same task lifecycle as delegated work.
                // They belong to the existing tool, never a sub-agent result: their
                // summary can contain raw stdout/stderr and must not cross the boundary.
                if let Some(mut tool) = self.existing(&format!("claude:{id}")) {
                    if v["subtype"] == "task_notification" {
                        tool.status = status(v["status"].as_str().unwrap_or_default()).into();
                        tool.elapsed_ms = None;
                        self.publish(tool, out);
                    }
                    return;
                }
                // Unknown task types cannot establish a child-agent identity.
                if !self.group("claude").agents.iter().any(|a| a.id == id)
                    && v["task_type"] != "local_agent"
                {
                    return;
                }
                let mut group = self.group("claude");
                if let Some(agent) = Self::agent(&mut group, &id) {
                    if let Some(name) = field(v, "description", 200) {
                        agent.name = name;
                    }
                    if v["subtype"] == "task_notification" {
                        agent.status = status(v["status"].as_str().unwrap_or_default()).into();
                        if let Some(result) = field(v, "summary", 8000) {
                            agent.result = Some(result);
                        }
                    }
                }
                self.publish_group(group, out);
            }
        }
    }
}
fn is_skill_path(path: &str) -> bool {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .is_some_and(|s| s.eq_ignore_ascii_case("SKILL.md"))
}
fn skill_read_path(command: &str) -> Option<String> {
    read_path(command, true)
}
fn direct_read_path(command: &str) -> Option<String> {
    read_path(command, false)
}
fn read_path(command: &str, skill_only: bool) -> Option<String> {
    // CLI hooks can prepend a command before the file read. Inspect real statement
    // boundaries, ignoring quoted mentions and never evaluating shell expressions.
    let command = command.trim();
    let executable = if command.starts_with(['\'', '"']) {
        command[1..].split(command.chars().next()?).next()?
    } else {
        command.split_whitespace().next()?
    };
    let shell = executable.rsplit(['/', '\\']).next()?.to_lowercase();
    let mut script = command.to_string();
    if matches!(
        shell.as_str(),
        "pwsh.exe" | "powershell.exe" | "pwsh" | "powershell" | "bash" | "sh" | "zsh"
    ) {
        for flag in [" -command ", " -lc ", " -c "] {
            if let Some(index) = command.to_lowercase().find(flag) {
                script = command[index + flag.len()..].trim().to_string();
                if (script.starts_with('"') && script.ends_with('"'))
                    || (script.starts_with('\'') && script.ends_with('\''))
                {
                    script = script[1..script.len() - 1].replace("\\\"", "\"");
                }
                break;
            }
        }
    }
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut statements = vec![];
    for (index, c) in script.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '`' || (c == '\\' && quote == Some('"')) {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if c == delimiter {
                quote = None;
            }
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if matches!(c, '\n' | ';' | '|') {
            statements.push(&script[start..index]);
            start = index + c.len_utf8();
        }
    }
    statements.push(&script[start..]);
    for statement in statements.into_iter().take(100) {
        let statement = statement.trim();
        for marker in ["get-content ", "cat "] {
            if !statement.to_lowercase().starts_with(marker) {
                continue;
            }
            let mut value = statement[marker.len()..].trim_start();
            while let Some(flag) = ["-literalpath ", "-path ", "-raw ", "-- "]
                .iter()
                .find(|flag| value.to_lowercase().starts_with(**flag))
            {
                value = value[flag.len()..].trim_start();
            }
            let path = if value.starts_with(['\'', '"']) {
                let quote = value.chars().next()?;
                value[1..].split(quote).next()?
            } else {
                value.split([' ', '\n', '\r', ';', '|', '\'', '"']).next()?
            };
            if !path.is_empty()
                && !path.starts_with('-')
                && !path.contains(['$', '`'])
                && (!skill_only || is_skill_path(path))
            {
                return Some(clean(path, 4096));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn tool_details_keep_targets_patterns_and_results_without_file_bodies() {
        let mut d = ToolDecoder::default();
        for (id, name, input) in [
            (
                "read",
                "Read",
                json!({"file_path":"/fixture/README.md","offset":12,"limit":8}),
            ),
            (
                "glob",
                "Glob",
                json!({"path":"/fixture/src","pattern":"**/*.svelte"}),
            ),
            (
                "grep",
                "Grep",
                json!({"path":"/fixture/src","pattern":"applyRunEvent","glob":"*.ts"}),
            ),
            ("find", "ToolSearch", json!({"query":"select:WebSearch"})),
            (
                "cmd",
                "Bash",
                json!({"description":"Run unit tests","command":"PRIVATE_COMMAND"}),
            ),
        ] {
            d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}));
        }
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read","content":"PRIVATE_BODY"}]},"tool_use_result":{"file":{"numLines":8,"startLine":12,"totalLines":50,"content":"PRIVATE_BODY"}}}));
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"glob"}]},"tool_use_result":{"numFiles":2,"filenames":["/fixture/src/App.svelte","/fixture/src/Menu.svelte"]}}));
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"find","content":[{"type":"tool_reference","tool_name":"WebSearch"},{"type":"text","text":"PRIVATE_SCHEMA"}]}]}}));
        assert_eq!(d.tools[0].path.as_deref(), Some("/fixture/README.md"));
        assert!(d.tools[0]
            .facts
            .iter()
            .any(|f| f.label == "Lines read" && f.value == "8"));
        assert_eq!(d.tools[1].query.as_deref(), Some("**/*.svelte"));
        assert!(d.tools[1]
            .facts
            .iter()
            .any(|f| f.label == "Files found" && f.value == "2"));
        assert_eq!(d.tools[3].query.as_deref(), Some("select:WebSearch"));
        assert!(d.tools[3].facts.iter().any(|f| f.value == "WebSearch"));
        assert!(d.tools[4].command_run);
        assert_eq!(d.tools[4].detail.as_deref(), Some("Run unit tests"));
        assert!(!serde_json::to_string(&d.tools)
            .unwrap()
            .contains("PRIVATE_"));
        let codex = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"read","type":"commandExecution","command":"Get-Content -Raw -LiteralPath '/fixture/README.md'","cwd":"/fixture","exitCode":0,"status":"completed"}}}), "root");
        assert_eq!(codex[0].path.as_deref(), Some("/fixture/README.md"));
        assert!(codex[0].command_run);
        assert!(codex[0]
            .facts
            .iter()
            .any(|f| f.label == "Exit code" && f.value == "0"));
    }
    #[test]
    fn claude_partial_inputs_require_real_results_and_keep_repeated_calls_separate() {
        let mut d = ToolDecoder::default();
        let start = json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"s1","name":"Skill","input":{}}}});
        let first = d.decode("claude", &start);
        assert_eq!(first[0].status, "running");
        d.decode("claude", &json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"skill\":\"fixture\",\"args\":\"DO_NOT_EXPORT\"}"}}}));
        let ready = d.decode(
            "claude",
            &json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
        );
        assert_eq!(ready[0].name, "Skill: fixture");
        assert_eq!(ready[0].status, "running");
        assert!(ready[0].revision > first[0].revision);
        let result = d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"s1","content":"PRIVATE_SKILL_BODY"}]}}));
        assert_eq!(result[0].status, "complete");
        assert!(!serde_json::to_string(&d.tools)
            .unwrap()
            .contains("PRIVATE_SKILL_BODY"));
        assert!(!serde_json::to_string(&d.tools)
            .unwrap()
            .contains("DO_NOT_EXPORT"));
        assert!(d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"s1","name":"Skill","input":{"skill":"fixture"}}]}})).is_empty());
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"s2","name":"Skill","input":{"skill":"fixture"}}]}}));
        assert_eq!(d.tools.len(), 2);
    }
    #[test]
    fn search_keeps_queries_safe_sources_and_errors_without_raw_payloads() {
        let mut d = ToolDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"search","name":"WebSearch","input":{"query":"example domains"}}]}}));
        let events = d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"search","content":"RAW_SEARCH_TEXT"}]},"tool_use_result":{"results":[{"title":"IANA","url":"https://www.iana.org/domains/example"},{"title":"bad","url":"javascript:alert(1)"},{"title":"credential","url":"https://user:secret@example.com"}],"private":"NEVER_RETURN"}}));
        assert_eq!(events[0].query.as_deref(), Some("example domains"));
        assert_eq!(events[0].sources.len(), 1);
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("RAW_SEARCH_TEXT"));
        assert!(!serialized.contains("NEVER_RETURN"));
        let failed = d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"search","is_error":true,"content":"PRIVATE_ERROR"}]}}));
        assert_eq!(failed[0].status, "error");
        assert!(!serde_json::to_string(&failed)
            .unwrap()
            .contains("PRIVATE_ERROR"));
        let codex = d.decode("codex", &json!({"type":"item.completed","item":{"id":"web","type":"web_search","query":"IANA","action":{"type":"search","query":"IANA"}}}));
        assert_eq!(codex[0].status, "complete");
        assert!(codex[0].sources.is_empty());
    }
    #[test]
    fn codex_delegation_tracks_individual_agents_and_terminal_results() {
        let mut d = ToolDecoder::default();
        for (id, task) in [("one", "Inspect A"), ("two", "Inspect B")] {
            d.decode("codex", &json!({"type":"item.completed","item":{"id":id,"type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"main","receiver_thread_ids":[id],"prompt":task,"status":"completed","agents_states":{id:{"status":"running","message":null}}}}));
        }
        let events = d.decode("codex", &json!({"type":"item.completed","item":{"id":"wait","type":"collab_tool_call","tool":"wait","receiver_thread_ids":["one","two"],"status":"completed","agents_states":{"one":{"status":"completed","message":"A checked"},"two":{"status":"errored","message":"B unavailable"}}}}));
        assert_eq!(events.len(), 1);
        let group = &events[0];
        assert_eq!(group.agents.len(), 2);
        assert_eq!(group.agents[0].task.as_deref(), Some("Inspect A"));
        assert_eq!(group.agents[0].result.as_deref(), Some("A checked"));
        assert_eq!(group.agents[1].status, "error");
        assert_eq!(group.status, "error");
    }
    #[test]
    fn claude_child_tools_background_tasks_and_notifications_keep_identity() {
        let mut d = ToolDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent1","name":"Agent","input":{"description":"Fixture reader","prompt":"Read fixture"}}]}}));
        let child = d.decode("claude", &json!({"type":"assistant","parent_tool_use_id":"agent1","message":{"content":[{"type":"tool_use","id":"read1","name":"Read","input":{"file_path":"private.txt"}}]}}));
        assert_eq!(child[0].parent_id.as_deref(), Some("agent1"));
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent1","content":"Started"}]},"tool_use_result":{"isAsync":true}}));
        assert_eq!(d.group("claude").agents[0].status, "running");
        d.decode("claude", &json!({"type":"system","subtype":"task_started","task_id":"task1","tool_use_id":"agent1","description":"Fixture reader"}));
        let done = d.decode("claude", &json!({"type":"system","subtype":"task_notification","task_id":"task1","status":"completed","summary":"Fixture verified","output_file":"DO_NOT_OPEN"}));
        assert_eq!(done[0].agents[0].status, "complete");
        assert_eq!(
            done[0].agents[0].result.as_deref(),
            Some("Fixture verified")
        );
        assert!(!serde_json::to_string(&done)
            .unwrap()
            .contains("DO_NOT_OPEN"));
        let wait = d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"wait1","name":"mcp__agent_studio__await_background_tasks","input":{"task_ids":["task2","task3"]}}]}}));
        assert_eq!(wait[0].name, "Wait for background tasks");
        assert_eq!(wait[0].facts[0].value, "task2, task3");
    }
    #[test]
    fn claude_agent_result_uses_content_without_harness_usage_or_continuation_instructions() {
        let mut d = ToolDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent1","name":"Agent","input":{"description":"Reader"}}]}}));
        let events = d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent1","content":[{"type":"text","text":"Actual answer"},{"type":"text","text":"agentId: internal <usage>internal tool statistics</usage>"}]}]},"tool_use_result":{"status":"completed","content":[{"type":"text","text":"Actual answer"}],"agentId":"internal","totalTokens":1000}}));
        assert_eq!(events[0].agents[0].result.as_deref(), Some("Actual answer"));
        assert!(!events[0].agents[0]
            .result
            .as_ref()
            .unwrap()
            .contains("internal"));
        assert!(!serde_json::to_string(&events).unwrap().contains("<usage>"));
    }
    #[test]
    fn skill_read_detection_does_not_claim_echo_search_or_write_loaded_skills() {
        for command in [
            "Get-Content README.md; Get-Content .agents/skills/demo/SKILL.md",
            "Get-Content -LiteralPath 'C:\\skills\\demo\\SKILL.md'",
            "cat .agents/skills/demo/SKILL.md",
            "Get-Content -Raw -LiteralPath '.agents/skills/demo/SKILL.md'",
            "\"C:\\runtime\\pwsh.exe\" -Command \"node \\\"fixture-hook.cjs\\\" --record-cwd fixture\nGet-Content -Raw -LiteralPath '.agents\\skills\\demo\\SKILL.md'\"",
            "powershell.exe -Command \"Get-Content .agents/skills/demo/SKILL.md\"",
        ] {
            assert!(skill_read_path(command).is_some(), "{command}");
        }
        for command in [
            "echo 'cat .agents/skills/demo/SKILL.md'",
            "rg SKILL.md",
            "Set-Content SKILL.md 'content'",
            "Get-Content README.md",
            "echo cat SKILL.md",
            "echo 'example\nGet-Content SKILL.md'",
        ] {
            assert!(skill_read_path(command).is_none(), "{command}");
        }
    }
    #[test]
    fn app_server_reported_read_actions_identify_skill_files_without_parsing_shells() {
        let mut d = ToolDecoder::default();
        let events = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"read","type":"commandExecution","command":"a shell-specific read expression","status":"completed","commandActions":[{"type":"read","path":"/fixture/.agents/skills/test/SKILL.md","name":"SKILL.md"}],"aggregatedOutput":"PRIVATE_SKILL_BODY"}}}),"root");
        assert_eq!(events[0].category, "skill");
        assert_eq!(events[0].status, "complete");
        assert_eq!(
            events[0].path.as_deref(),
            Some("/fixture/.agents/skills/test/SKILL.md")
        );
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("PRIVATE_SKILL_BODY"));
    }
    #[test]
    fn activity_limit_is_visible_and_does_not_drop_existing_completion() {
        let mut d = ToolDecoder::default();
        for index in 0..200 {
            d.decode("codex", &json!({"type":"item.started","item":{"id":index.to_string(),"type":"command_execution","status":"in_progress"}}));
        }
        let limit = d.decode(
            "codex",
            &json!({"type":"item.started","item":{"id":"over","type":"command_execution"}}),
        );
        assert_eq!(limit[0].id, "activity-limit");
        let done = d.decode("codex", &json!({"type":"item.completed","item":{"id":"0","type":"command_execution","status":"completed","aggregated_output":"PRIVATE"}}));
        assert_eq!(done[0].status, "complete");
        assert!(!serde_json::to_string(&done).unwrap().contains("PRIVATE"));
        assert_eq!(d.tools.len(), 200);
    }
    #[test]
    fn combined_reads_retain_both_targets_and_claude_resumes_share_agent_identity() {
        let mut d = ToolDecoder::default();
        let events = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"read","type":"commandExecution","command":"Get-Content README.md; Get-Content .agents/skills/demo/SKILL.md","status":"completed"}}}),"root");
        assert_eq!(events[0].category, "skill");
        assert!(events[0]
            .facts
            .iter()
            .any(|f| f.label == "Also read" && f.value == "README.md"));
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"first","name":"Agent","input":{}}]}}));
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"first","content":"Answer"}]},"tool_use_result":{"agentId":"same-child"}}));
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"again","name":"Agent","input":{"resume":"same-child"}}]}}));
        let group = d.group("claude");
        assert_eq!(group.agents.len(), 2);
        assert_eq!(group.agents[0].agent_id, group.agents[1].agent_id);
    }
}
#[test]
fn workflow_progress_counts_real_children_without_counting_the_orchestrator() {
    let mut d = ToolDecoder::default();
    d.decode("claude", &serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"wfcall","name":"Workflow","input":{"name":"audit"}}]}}));
    d.decode("claude", &serde_json::json!({"type":"system","subtype":"task_started","task_id":"task","tool_use_id":"wfcall","task_type":"local_workflow"}));
    let event = serde_json::json!({"type":"system","subtype":"task_progress","task_id":"task","tool_use_id":"wfcall","workflow_progress":[{"type":"workflow_agent","index":1,"agentId":"child","label":"Reader","state":"done","resultPreview":"Checked"}]});
    d.decode("claude", &event);
    d.decode("claude", &event);
    d.decode("claude", &serde_json::json!({"type":"system","subtype":"task_notification","task_id":"task","status":"completed"}));
    let group = d.group("claude");
    assert_eq!(group.agents.len(), 1);
    assert_eq!(group.agents[0].agent_id.as_deref(), Some("child"));
    assert_eq!(group.agents[0].status, "complete");
}
