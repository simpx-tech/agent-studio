//! Screens (docs/SCREENS.md): lasting pages a chat saves in Agent Studio, each with its own HTML
//! interface, the actions it runs and the MCP tools it calls on the computer that keeps it.
//!
//! A screen lives on that computer alone, under app data `screens/`, never in the workspace,
//! exports or relay sync. Windows and other devices read it, run its actions and commands and
//! call its tools through transport (`manage_screen`, the `screens` relay job), naming the screen
//! by its id alone. Nothing waits for an approval (requested 2026-10-30: "forget permissions, it
//! can do anything"): a page runs what it asks for, each run a job that goes on and keeps its
//! output when the page closes (`jobs.rs`), in the folder recorded when a chat saved the screen or
//! in another place of the same computer it names (`places.rs`), with each value in an
//! environment variable of its own, never in command text.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub mod jobs;
pub mod mcp;
pub mod places;
mod run;
pub mod tools;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    Powershell,
    Bash,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    String,
    Number,
    Integer,
    Boolean,
}

/// One value a screen passes to an action, and what the host accepts for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

/// A command a screen runs by name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub shell: Shell,
    pub script: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Param>,
    /// Seconds the script may run before it is stopped; none lets it run until it ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// Where it runs, when not where the screen does: `windows`, `wsl` or a distribution.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
}

/// An MCP tool a screen's page calls: a tool of one of the servers an account's CLI has where it
/// is called, named as that CLI names them (`mcp__<server>__<tool>`). A page may call tools it
/// does not declare too; a declaration names what it does, and where and as whom it is called.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Where it is called, when not where the screen runs: `windows`, `wsl` or a distribution.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// The account to call it as first, by the name Connections gives it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// What a page asks a model (`studio.ask`).
#[derive(Clone, Debug, Default)]
pub struct Question {
    pub prompt: String,
    pub model: Option<String>,
    pub system: Option<String>,
}

/// The account whose CLI calls a screen's MCP tools first, and asks its model questions: the
/// one the chat that created the screen replied with, on the computer that keeps it. No
/// connection is this computer's own CLI login.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub provider: String,
    pub connection_id: Option<String>,
}

/// Where a screen's actions run, recorded from the reply that created it. Only this computer
/// reads it; no caller ever supplies it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    /// The execution environment: this computer, or one of its WSL distributions.
    pub environment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    /// The working folder as the action's shell reaches it.
    pub folder: String,
    /// The chat's project folder as it names it; empty for a Standalone chat.
    #[serde(default)]
    pub project: String,
}

/// The card a reply shows for a screen it saved: metadata only, never the screen.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub environment_id: String,
}

/// A screen as its computer keeps it. Files written before approvals went keep an `approval`,
/// which nothing reads now and the next save drops.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub id: String,
    pub revision: u64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub html: String,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_tools: Vec<McpTool>,
    pub site: Site,
    /// Recorded when a chat creates the screen, or saves one that has none or whose account is
    /// no longer connected here; screens saved before MCP tools have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// The conversation that created the screen, and the reply that saved it last.
    pub conversation_id: String,
    pub run_id: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Screen {
    /// A fingerprint of what the screen runs and where. Windows of releases that asked for an
    /// approval send it back to allow the screen, which they believe it needs.
    pub fn digest(&self) -> String {
        let canonical = json!({
            "actions": self.actions,
            "site": self.site,
            "mcpTools": self.mcp_tools,
            "account": self.account,
        });
        hex(&Sha256::digest(canonical.to_string().as_bytes()))
    }
    /// The declaration of a tool a page calls, if the screen declares it.
    pub fn tool(&self, server: &str, tool: &str) -> Option<&McpTool> {
        self.mcp_tools
            .iter()
            .find(|known| known.server == server && known.tool == tool)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn now() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// A screen as lists show it, without its HTML.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub description: String,
    pub environment_id: String,
    pub project: String,
    pub folder: String,
    pub conversation_id: String,
    pub created_at: String,
    pub updated_at: String,
    /// How many actions it declares.
    pub commands: usize,
    /// How many MCP tools it declares.
    pub tools: usize,
    /// Always true: windows of releases that asked for an approval read it.
    pub allowed: bool,
    /// How many of its jobs run now.
    pub running: usize,
}

impl Summary {
    fn of(screen: &Screen, running: usize) -> Self {
        Self {
            id: screen.id.clone(),
            revision: screen.revision,
            title: screen.title.clone(),
            description: screen.description.clone(),
            environment_id: screen.site.environment_id.clone(),
            project: screen.site.project.clone(),
            folder: screen.site.folder.clone(),
            conversation_id: screen.conversation_id.clone(),
            created_at: screen.created_at.clone(),
            updated_at: screen.updated_at.clone(),
            commands: screen.actions.len(),
            tools: screen.mcp_tools.len(),
            allowed: true,
            running,
        }
    }
}

/// A screen as its window renders it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub summary: Summary,
    pub html: String,
    pub actions: Vec<Action>,
    pub mcp_tools: Vec<McpTool>,
    /// The account that calls its MCP tools first, which the window names by its connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// For windows of releases that asked for an approval.
    pub digest: String,
}

impl Detail {
    fn of(screen: &Screen, running: usize) -> Self {
        Self {
            summary: Summary::of(screen, running),
            html: screen.html.clone(),
            actions: screen.actions.clone(),
            mcp_tools: screen.mcp_tools.clone(),
            account: screen.account.clone(),
            digest: screen.digest(),
        }
    }
}

/// What a chat submits: everything but where the screen runs, which its reply decides.
#[derive(Debug)]
pub struct Definition {
    pub id: Option<String>,
    pub title: String,
    pub description: String,
    pub html: String,
    pub actions: Vec<Action>,
    pub mcp_tools: Vec<McpTool>,
}

/// Text lists and pages show on one line: line breaks become spaces, and characters that hide
/// or reorder what it says are left out.
fn line(value: Option<&Value>, field: &str, required: bool) -> Result<String, String> {
    let text = match value {
        None | Some(Value::Null) if !required => return Ok(String::new()),
        Some(Value::String(text)) => text,
        _ => return Err(format!("{field} must be text.")),
    };
    let text: String = text
        .chars()
        .filter(|c| !crate::console::hidden(*c) || matches!(c, '\n' | '\r' | '\t'))
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let text = text.trim();
    if required && text.is_empty() {
        return Err(format!("{field} must not be empty."));
    }
    Ok(text.into())
}

/// A name a screen's script calls an action or reads a parameter by.
fn identifier(name: &str) -> bool {
    !name.is_empty()
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn unexpected(object: &Map<String, Value>, accepted: &[&str]) -> Result<(), String> {
    let extra: Vec<_> = object
        .keys()
        .filter(|key| !accepted.contains(&key.as_str()))
        .cloned()
        .collect();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "unknown field {}; the fields are {}.",
            extra.join(", "),
            accepted.join(", ")
        ))
    }
}

/// A script as its shell will read it: plain line ends.
fn script(value: Option<&Value>) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or("script must be the text of the command to run.")?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim_end_matches('\n');
    if text.trim().is_empty() {
        return Err("script must not be empty.".into());
    }
    if text.contains('\0') {
        return Err("script must not contain a NUL character.".into());
    }
    Ok(text.into())
}

/// A place a declaration or a page names, checked.
fn named_place(value: Option<&Value>) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) => places::checked(name).map(Some),
        Some(_) => Err("where must be windows, wsl or the name of a WSL distribution.".into()),
    }
}

fn whole(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

fn param(spec: &Value) -> Result<Param, String> {
    let object = spec
        .as_object()
        .ok_or("each parameter must be an object such as {\"type\":\"string\"}.")?;
    unexpected(
        object,
        &[
            "type",
            "description",
            "enum",
            "pattern",
            "maxLength",
            "minimum",
            "maximum",
            "optional",
        ],
    )?;
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("string") => Kind::String,
        Some("number") => Kind::Number,
        Some("integer") => Kind::Integer,
        Some("boolean") => Kind::Boolean,
        _ => return Err("type must be string, number, integer or boolean.".into()),
    };
    let description = line(object.get("description"), "description", false)?;
    let choices = match object.get("enum") {
        None | Some(Value::Null) => None,
        Some(Value::Array(values)) if !values.is_empty() => {
            for value in values {
                let fits = match kind {
                    Kind::String => value.is_string(),
                    Kind::Number => value.as_f64().is_some_and(f64::is_finite),
                    Kind::Integer => value.as_f64().is_some_and(whole),
                    Kind::Boolean => value.is_boolean(),
                };
                if !fits {
                    return Err("enum values must each be a value of this parameter's type.".into());
                }
            }
            Some(values.clone())
        }
        Some(_) => return Err("enum must list at least one value.".into()),
    };
    let pattern = match object.get("pattern") {
        None | Some(Value::Null) => None,
        Some(Value::String(pattern)) if kind == Kind::String => {
            compile(pattern)?;
            Some(pattern.clone())
        }
        Some(_) => return Err("pattern applies only to a string, as a regular expression.".into()),
    };
    let max_length = match object.get("maxLength") {
        None | Some(Value::Null) => None,
        Some(value) if kind == Kind::String => Some(
            value
                .as_u64()
                .ok_or("maxLength must be a whole number of characters.")?,
        ),
        Some(_) => return Err("maxLength applies only to a string.".into()),
    };
    let bound = |name: &str| -> Result<Option<f64>, String> {
        match object.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(value) if matches!(kind, Kind::Number | Kind::Integer) => value
                .as_f64()
                .filter(|n| n.is_finite())
                .map(Some)
                .ok_or(format!("{name} must be a number.")),
            Some(_) => Err(format!("{name} applies only to a number or an integer.")),
        }
    };
    let (minimum, maximum) = (bound("minimum")?, bound("maximum")?);
    if let (Some(low), Some(high)) = (minimum, maximum) {
        if low > high {
            return Err("minimum must not be above maximum.".into());
        }
    }
    let optional = match object.get("optional") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(optional)) => *optional,
        Some(_) => return Err("optional must be true or false.".into()),
    };
    Ok(Param {
        kind,
        description,
        choices,
        pattern,
        max_length,
        minimum,
        maximum,
        optional,
    })
}

fn compile(pattern: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .map_err(|_| format!("pattern {pattern} is not a valid regular expression."))
}

fn action(item: &Value) -> Result<Action, String> {
    let object = item.as_object().ok_or("each action must be an object.")?;
    unexpected(
        object,
        &[
            "name",
            "description",
            "shell",
            "script",
            "params",
            "timeout",
            "where",
        ],
    )?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| identifier(name))
        .ok_or("name must be lowercase letters, digits or _, starting with a letter.")?
        .to_string();
    let named = |error: String| format!("Action {name}: {error}");
    let description = line(object.get("description"), "description", false).map_err(named)?;
    let shell = match object.get("shell").and_then(Value::as_str) {
        Some("powershell") => Shell::Powershell,
        Some("bash") => Shell::Bash,
        _ => return Err(named("shell must be powershell or bash.".into())),
    };
    let script = script(object.get("script")).map_err(named)?;
    let params = match object.get("params") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(params)) => {
            let mut declared = BTreeMap::new();
            for (key, spec) in params {
                if !identifier(key) {
                    return Err(named(format!(
                        "parameter {key} must be named with lowercase letters, digits or _, starting with a letter."
                    )));
                }
                declared.insert(
                    key.clone(),
                    param(spec).map_err(|error| named(format!("parameter {key}: {error}")))?,
                );
            }
            declared
        }
        Some(_) => {
            return Err(named(
                "params must map each parameter name to its type, such as {\"since\":{\"type\":\"string\"}}."
                    .into(),
            ))
        }
    };
    // Without a timeout the script runs until it ends or the user stops it.
    let timeout =
        match object.get("timeout") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().filter(|seconds| *seconds >= 1).ok_or_else(
                || named("timeout must be a whole number of seconds, at least 1.".into()),
            )?),
        };
    let place = named_place(object.get("where")).map_err(named)?;
    Ok(Action {
        name,
        description,
        shell,
        script,
        params,
        timeout,
        place,
    })
}

/// A server's or a tool's name as the CLI finds it: one line as written, without control
/// characters.
pub(crate) fn tool_name(value: Option<&Value>, field: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or(format!("{field} must be text."))?;
    if text.trim().is_empty() {
        return Err(format!("{field} must not be empty."));
    }
    if text.trim() != text {
        return Err(format!("{field} must not start or end with spaces."));
    }
    if let Some(c) = text.chars().find(|c| c.is_control()) {
        return Err(format!(
            "{field} contains a control character (U+{:04X}).",
            c as u32
        ));
    }
    Ok(text.into())
}

fn mcp_tool(item: &Value) -> Result<McpTool, String> {
    let object = item.as_object().ok_or(
        "each MCP tool must be an object such as {\"server\":\"linear\",\"tool\":\"list_issues\"}.",
    )?;
    unexpected(
        object,
        &["server", "tool", "description", "where", "account"],
    )
    .map_err(|error| format!("MCP tool: {error}"))?;
    let server = tool_name(object.get("server"), "server")?;
    let tool = tool_name(object.get("tool"), "tool")?;
    let named = |error: String| format!("MCP tool {tool} of {server}: {error}");
    // Agent Studio answers its own tools inside the chat that calls them.
    if server == "agent_studio" {
        return Err(named(
            "agent_studio is Agent Studio's own server, whose tools work only in a chat.".into(),
        ));
    }
    let description = line(object.get("description"), "description", false).map_err(named)?;
    let place = named_place(object.get("where")).map_err(named)?;
    let account = Some(line(object.get("account"), "account", false).map_err(named)?)
        .filter(|account| !account.is_empty());
    Ok(McpTool {
        server,
        tool,
        description,
        place,
        account,
    })
}

pub const FIELDS: &[&str] = &["id", "title", "description", "html", "actions", "mcpTools"];

/// Checks a chat's submission completely, before anything is saved.
pub fn definition(args: &Value) -> Result<Definition, String> {
    let object = args
        .as_object()
        .ok_or("Send title, html and optionally id, description, actions and mcpTools.")?;
    unexpected(object, FIELDS).map_err(|error| {
        format!("This call has an {error} Send the complete screen in those fields.")
    })?;
    let id = match object.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if valid_id(id) => Some(id.clone()),
        Some(_) => {
            return Err(
                "id must be the id of a saved screen (from save_screen or list_screens); omit it to create a screen."
                    .into(),
            )
        }
    };
    let title = line(object.get("title"), "title", true)?;
    let description = line(object.get("description"), "description", false)?;
    let html = object
        .get("html")
        .and_then(Value::as_str)
        .filter(|html| !html.trim().is_empty())
        .ok_or("html must be the screen's complete HTML.")?;
    if html.contains('\0') {
        return Err("html must not contain a NUL character.".into());
    }
    let actions = match object.get("actions") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(list)) => {
            let mut actions: Vec<Action> = Vec::new();
            for item in list {
                let action = action(item)?;
                if actions.iter().any(|known| known.name == action.name) {
                    return Err(format!("Two actions are named {}.", action.name));
                }
                actions.push(action);
            }
            actions
        }
        Some(_) => return Err("actions must be a list of the commands the screen runs.".into()),
    };
    let mcp_tools = match object.get("mcpTools") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(list)) => {
            let mut tools: Vec<McpTool> = Vec::new();
            for item in list {
                let tool = mcp_tool(item)?;
                if tools
                    .iter()
                    .any(|known| known.server == tool.server && known.tool == tool.tool)
                {
                    return Err(format!(
                        "The MCP tool {} of {} is listed twice.",
                        tool.tool, tool.server
                    ));
                }
                tools.push(tool);
            }
            tools
        }
        Some(_) => {
            return Err(
                "mcpTools must be a list of the MCP tools the page calls, each {server, tool}."
                    .into(),
            )
        }
    };
    Ok(Definition {
        id,
        title,
        description,
        html: html.into(),
        actions,
        mcp_tools,
    })
}

/// The environment variable a parameter reaches its script in: `since` is `PARAM_SINCE`.
pub fn variable(name: &str) -> String {
    format!("PARAM_{}", name.to_ascii_uppercase())
}

/// A value a script reads as it is passed: text as it is, anything else as its JSON.
fn plain(name: &str, value: &Value) -> Result<(String, String), String> {
    if !identifier(name) {
        return Err(format!(
            "The parameter {name} must be named with lowercase letters, digits or _, starting with a letter."
        ));
    }
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    if text.contains('\0') {
        return Err(format!("{name} must not contain a NUL character."));
    }
    Ok((variable(name), text))
}

/// The values a page passes a command of its own, as the environment variables it reads.
pub fn passed(values: &Map<String, Value>) -> Result<Vec<(String, String)>, String> {
    values
        .iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(name, value)| plain(name, value))
        .collect()
}

/// The values a page passes an action, checked against what the action declares, as the
/// environment variables its script reads. A value it does not declare passes as it is.
pub fn arguments(
    action: &Action,
    values: &Map<String, Value>,
) -> Result<Vec<(String, String)>, String> {
    let mut variables = Vec::new();
    for (name, value) in values {
        if !action.params.contains_key(name) && !value.is_null() {
            variables.push(plain(name, value)?);
        }
    }
    for (name, param) in &action.params {
        let value = match values.get(name) {
            None | Some(Value::Null) if param.optional => continue,
            None | Some(Value::Null) => {
                return Err(format!("{} needs a value for {name}.", action.name))
            }
            Some(value) => value,
        };
        let wrong = || {
            format!(
                "{name} must be {}.",
                match param.kind {
                    Kind::String => "text",
                    Kind::Number => "a number",
                    Kind::Integer => "a whole number",
                    Kind::Boolean => "true or false",
                }
            )
        };
        let text = match param.kind {
            Kind::String => {
                let text = value.as_str().ok_or_else(wrong)?;
                // Only the length the action itself declares.
                if let Some(limit) = param.max_length {
                    if text.chars().count() as u64 > limit {
                        return Err(format!("{name} must be at most {limit} characters."));
                    }
                }
                if text.contains('\0') {
                    return Err(format!("{name} must not contain a NUL character."));
                }
                if let Some(pattern) = &param.pattern {
                    if !compile(pattern)?.is_match(text) {
                        return Err(format!("{name} does not match the pattern {pattern}."));
                    }
                }
                text.to_string()
            }
            Kind::Number | Kind::Integer => {
                let number = value.as_f64().filter(|n| n.is_finite()).ok_or_else(wrong)?;
                if param.kind == Kind::Integer && !whole(number) {
                    return Err(wrong());
                }
                if param.minimum.is_some_and(|low| number < low)
                    || param.maximum.is_some_and(|high| number > high)
                {
                    return Err(format!("{name} is outside the range its action accepts."));
                }
                if param.kind == Kind::Integer {
                    format!("{}", number as i64)
                } else {
                    value.to_string()
                }
            }
            Kind::Boolean => value.as_bool().ok_or_else(wrong)?.to_string(),
        };
        if let Some(choices) = &param.choices {
            let chosen = choices.iter().any(|choice| match param.kind {
                Kind::String => choice.as_str() == value.as_str(),
                Kind::Boolean => choice.as_bool() == value.as_bool(),
                _ => choice.as_f64() == value.as_f64(),
            });
            if !chosen {
                return Err(format!(
                    "{name} must be one of the values its action lists."
                ));
            }
        }
        variables.push((variable(name), text));
    }
    Ok(variables)
}

pub(crate) fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
}

fn checked_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("Invalid screen id".into())
    }
}

/// The folder this computer keeps its screens in.
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("screens"))
}

fn file(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}
fn data_file(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.data.json"))
}

const MISSING: &str = "This screen is no longer on this computer.";

fn read(root: &Path, id: &str) -> Result<Screen, String> {
    checked_id(id)?;
    let bytes = match std::fs::read(file(root, id)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(MISSING.into()),
        Err(_) => return Err("Cannot read this screen.".into()),
    };
    serde_json::from_slice::<Screen>(&bytes)
        .ok()
        .filter(|screen| screen.id == id)
        .ok_or_else(|| "This screen's saved file is unreadable.".into())
}

/// Replaces one of the store's files with a written and flushed one from the same folder.
fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let folder = path.parent().ok_or("Invalid screen file")?;
    std::fs::create_dir_all(folder).map_err(|_| "Cannot keep screens on this computer")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(folder).map_err(|_| "Cannot save this screen")?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Cannot save this screen")?;
    let kept = temporary
        .into_temp_path()
        .keep()
        .map_err(|_| "Cannot save this screen")?;
    std::fs::rename(&kept, path).map_err(|_| {
        let _ = std::fs::remove_file(&kept);
        "Cannot save this screen".to_string()
    })
}

fn write(root: &Path, screen: &Screen) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(screen).map_err(|_| "Cannot save this screen")?;
    replace(&file(root, &screen.id), &bytes)
}

/// Every readable screen this computer keeps, most recently changed first.
fn all(root: &Path) -> Vec<Screen> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut screens: Vec<Screen> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(".json").filter(|id| valid_id(id))?;
            read(root, id).ok()
        })
        .collect();
    screens.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    screens
}

fn read_data(root: &Path, id: &str) -> Result<Map<String, Value>, String> {
    match std::fs::read(data_file(root, id)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "This screen's data is unreadable.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(_) => Err("Cannot read this screen's data.".into()),
    }
}

/// Saves what a chat submitted, as a new screen or a new revision of one this computer keeps.
/// An update keeps where the screen runs and the account that calls its MCP tools first, unless
/// `usable` finds that account gone. `account` is the saving chat's.
pub(crate) fn store(
    root: &Path,
    definition: Definition,
    site: Site,
    account: Option<Account>,
    usable: &dyn Fn(&Account) -> bool,
    conversation_id: &str,
    run_id: &str,
) -> Result<(Screen, bool), String> {
    let time = now();
    let (screen, created) = match &definition.id {
        Some(id) => {
            let previous = read(root, id).map_err(|error| {
                if error == MISSING {
                    format!("No screen with id {id} is kept on this computer. Call list_screens for the screens here, or omit id to create a new one.")
                } else {
                    error
                }
            })?;
            if previous.site.environment_id != site.environment_id {
                return Err(format!(
                    "Screen {id} was made in another environment of this computer ({}). Update it from a chat there.",
                    previous.site.folder
                ));
            }
            (
                Screen {
                    id: previous.id.clone(),
                    revision: previous.revision + 1,
                    title: definition.title,
                    description: definition.description,
                    html: definition.html,
                    actions: definition.actions,
                    mcp_tools: definition.mcp_tools,
                    site: previous.site.clone(),
                    account: previous
                        .account
                        .clone()
                        .filter(|kept| usable(kept))
                        .or(account),
                    conversation_id: previous.conversation_id.clone(),
                    run_id: run_id.into(),
                    created_at: previous.created_at.clone(),
                    updated_at: time,
                },
                false,
            )
        }
        None => (
            Screen {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 1,
                title: definition.title,
                description: definition.description,
                html: definition.html,
                actions: definition.actions,
                mcp_tools: definition.mcp_tools,
                site,
                account,
                conversation_id: conversation_id.into(),
                run_id: run_id.into(),
                created_at: time.clone(),
                updated_at: time,
            },
            true,
        ),
    };
    write(root, &screen)?;
    Ok((screen, created))
}

/// This computer's screens, the jobs they run and the CLIs that answer their MCP calls. Changes
/// to a screen's files go one at a time; jobs and calls run side by side, as many at once as
/// they are asked for.
#[derive(Default)]
pub struct Screens {
    changes: tokio::sync::Mutex<()>,
    /// The CLIs that answer the screens' MCP calls, and the chats' `call_mcp_tool`.
    pub calls: mcp::Calls,
    pub jobs: jobs::Jobs,
    /// This computer and the distributions it manages, as places resolve against them: read
    /// once, and again when a place does not resolve.
    computer: std::sync::Mutex<Option<places::Computer>>,
}

/// A command a page passes to run as it is (`studio.exec`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub shell: Shell,
    pub script: String,
    #[serde(default, rename = "where")]
    pub place: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
}

/// What a window or another device asks of this computer's screens.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    List,
    Read {
        id: String,
    },
    /// Runs an action and answers once it ended, as workflows and windows of earlier releases
    /// ask.
    Run {
        id: String,
        action: String,
        #[serde(default)]
        params: Map<String, Value>,
    },
    /// Starts one of the screen's actions, or a command the page passes, as a job, and answers
    /// with it at once. A kept job stays until a page forgets it.
    Start {
        id: String,
        #[serde(default)]
        action: Option<String>,
        #[serde(default)]
        command: Option<Command>,
        #[serde(default)]
        params: Map<String, Value>,
        #[serde(default)]
        keep: bool,
    },
    Jobs {
        id: String,
    },
    /// A job's output from a byte of its log, waiting for some when asked to.
    Output {
        id: String,
        job: String,
        #[serde(default)]
        after: u64,
        #[serde(default)]
        wait: bool,
        #[serde(default)]
        peek: bool,
    },
    Stop {
        id: String,
        job: String,
    },
    Forget {
        id: String,
        job: String,
    },
    /// Calls an MCP tool where the screen runs or the place named, with the arguments its page
    /// passes.
    Mcp {
        id: String,
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Map<String, Value>,
        #[serde(default, rename = "where")]
        place: Option<String>,
        #[serde(default)]
        account: Option<String>,
    },
    /// The MCP servers an account has where the screen runs or the place named.
    Tools {
        id: String,
        #[serde(default, rename = "where")]
        place: Option<String>,
        #[serde(default)]
        account: Option<String>,
    },
    /// A model's answer for the page, from the screen's account.
    Ask {
        id: String,
        prompt: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        system: Option<String>,
    },
    /// Windows of earlier releases allow and revoke screens, naming a digest; both answer with
    /// the screen.
    Approve {
        id: String,
    },
    Revoke {
        id: String,
    },
    Delete {
        id: String,
    },
    Load {
        id: String,
    },
    Save {
        id: String,
        key: String,
        value: Value,
    },
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Could not finish this screen request".to_string())?
}

fn encode<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "Cannot answer this screen request".to_string())
}

/// What lists name a command by: its first line.
fn label(script: &str) -> String {
    let first = script
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("command");
    if first.chars().count() > 120 {
        format!("{}…", first.chars().take(120).collect::<String>())
    } else {
        first.into()
    }
}

/// The accounts that may call MCP tools in `site`, in the order they are tried. Without a saved
/// workspace to read accounts from, the screen's own account answers where it runs.
pub(crate) async fn candidates(
    data: PathBuf,
    own: Option<Account>,
    site: Site,
    own_place: bool,
    named: Option<String>,
) -> Result<Vec<places::Candidate>, String> {
    blocking(move || {
        let fleet = crate::saved::fleet(&data, "", "").ok();
        let local = crate::profiles::installation_in(&data).map(|local| local.id);
        match (fleet, local) {
            (Some(fleet), Ok(local)) => Ok(places::candidates(
                &fleet,
                &local,
                &site,
                own.as_ref(),
                own_place,
                named.as_deref(),
            )),
            _ => Ok(own
                .filter(|_| own_place)
                .map(|account| places::Candidate {
                    account,
                    name: "the screen's account".into(),
                })
                .into_iter()
                .collect()),
        }
    })
    .await
}

impl Screens {
    async fn screen(&self, root: &Path, id: &str) -> Result<Screen, String> {
        let (root, id) = (root.to_path_buf(), id.to_string());
        blocking(move || read(&root, &id)).await
    }
    /// This computer and its distributions, read from `data` once, or again when `again`.
    async fn computer(&self, data: &Path, again: bool) -> places::Computer {
        if !again {
            if let Some(computer) = lock(&self.computer).clone() {
                return computer;
            }
        }
        let data = data.to_path_buf();
        let computer = blocking(move || {
            let local = crate::profiles::installation_in(&data)?.id;
            let fleet = crate::saved::fleet(&data, "", "").unwrap_or(Value::Null);
            Ok(places::Computer::from_fleet(&local, &fleet))
        })
        .await
        .unwrap_or_default();
        *lock(&self.computer) = Some(computer.clone());
        computer
    }
    /// Where a screen's command runs or tool is called: the screen's own place, or the one named.
    pub(crate) async fn place(
        &self,
        data: &Path,
        site: &Site,
        place: Option<&str>,
    ) -> Result<Site, String> {
        if place.is_none() {
            return Ok(site.clone());
        }
        let computer = self.computer(data, false).await;
        match places::resolve(site, place, &computer) {
            Ok(site) => Ok(site),
            // A distribution added since this computer was read.
            Err(_) => places::resolve(site, place, &self.computer(data, true).await),
        }
    }
    /// One of the screen's actions as a job runs it, with the values the page passes.
    async fn action(
        &self,
        data: &Path,
        screen: &Screen,
        name: &str,
        params: Map<String, Value>,
        keep: bool,
    ) -> Result<jobs::Spec, String> {
        let declared = screen
            .actions
            .iter()
            .find(|known| known.name == name)
            .ok_or_else(|| format!("This screen has no action named {name}."))?;
        let variables = arguments(declared, &params)?;
        let site = self
            .place(data, &screen.site, declared.place.as_deref())
            .await?;
        Ok(jobs::Spec {
            action: Some(name.into()),
            label: name.into(),
            params,
            place: declared.place.clone(),
            site,
            name: name.into(),
            shell: declared.shell,
            script: declared.script.clone(),
            timeout: declared.timeout,
            variables,
            keep,
        })
    }
    /// A command a page passes as a job runs it.
    async fn command(
        &self,
        data: &Path,
        screen: &Screen,
        command: Command,
        params: Map<String, Value>,
        keep: bool,
    ) -> Result<jobs::Spec, String> {
        let text = script(Some(&Value::String(command.script)))?;
        if command.timeout == Some(0) {
            return Err("timeout must be a whole number of seconds, at least 1.".into());
        }
        let place = command.place.as_deref().map(places::checked).transpose()?;
        let site = self.place(data, &screen.site, place.as_deref()).await?;
        Ok(jobs::Spec {
            action: None,
            label: label(&text),
            variables: passed(&params)?,
            params,
            place,
            site,
            name: "command".into(),
            shell: command.shell,
            script: text,
            timeout: command.timeout,
            keep,
        })
    }

    /// Answers one request. `launch` starts the CLIs that answer a screen's MCP calls and asks
    /// models for its page.
    pub async fn handle(
        &self,
        root: PathBuf,
        namespace: String,
        launch: &dyn mcp::Launch,
        request: Request,
    ) -> Result<Value, String> {
        let data = root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| root.clone());
        match request {
            Request::List => {
                let screens = blocking(move || Ok(all(&root))).await?;
                let summaries: Vec<Summary> = screens
                    .iter()
                    .map(|screen| Summary::of(screen, self.jobs.running_for(&screen.id)))
                    .collect();
                Ok(json!({ "screens": summaries }))
            }
            Request::Read { id } | Request::Approve { id } | Request::Revoke { id } => {
                let screen = self.screen(&root, &id).await?;
                encode(&Detail::of(&screen, self.jobs.running_for(&screen.id)))
            }
            Request::Run { id, action, params } => {
                let screen = self.screen(&root, &id).await?;
                let spec = self.action(&data, &screen, &action, params, false).await?;
                let job = self.jobs.start(&root, &namespace, &screen.id, spec).await?;
                self.jobs.outcome(&root, &screen.id, &job.id).await
            }
            Request::Start {
                id,
                action,
                command,
                params,
                keep,
            } => {
                let screen = self.screen(&root, &id).await?;
                let spec = match (action, command) {
                    (Some(action), None) => {
                        self.action(&data, &screen, &action, params, keep).await?
                    }
                    (None, Some(command)) => {
                        self.command(&data, &screen, command, params, keep).await?
                    }
                    _ => {
                        return Err(
                            "Name one of the screen's actions, or pass a command to run.".into(),
                        )
                    }
                };
                encode(&self.jobs.start(&root, &namespace, &screen.id, spec).await?)
            }
            Request::Jobs { id } => Ok(json!({ "jobs": self.jobs.list(&root, &id).await? })),
            Request::Output {
                id,
                job,
                after,
                wait,
                peek,
            } => self.jobs.output(&root, &id, &job, after, wait, peek).await,
            Request::Stop { id, job } => encode(&self.jobs.stop(&root, &id, &job).await?),
            Request::Forget { id, job } => {
                self.jobs.forget(&root, &id, &job).await?;
                Ok(json!({}))
            }
            Request::Mcp {
                id,
                server,
                tool,
                arguments,
                place,
                account,
            } => {
                let screen = self.screen(&root, &id).await?;
                let declared = screen.tool(&server, &tool).cloned();
                let place = place.or_else(|| declared.as_ref().and_then(|d| d.place.clone()));
                let account = account.or_else(|| declared.and_then(|d| d.account));
                let site = self.place(&data, &screen.site, place.as_deref()).await?;
                let own = site == screen.site;
                let candidates = candidates(
                    data,
                    screen.account.clone(),
                    site.clone(),
                    own,
                    account.clone(),
                );
                let (mut result, answered) = self
                    .calls
                    .call(
                        &screen.id,
                        &site,
                        account.is_some(),
                        candidates,
                        launch,
                        &server,
                        &tool,
                        arguments,
                    )
                    .await?;
                result["account"] = json!(answered);
                Ok(result)
            }
            Request::Tools { id, place, account } => {
                let screen = self.screen(&root, &id).await?;
                let site = self.place(&data, &screen.site, place.as_deref()).await?;
                let own = site == screen.site;
                let list =
                    candidates(data, screen.account.clone(), site.clone(), own, account).await?;
                let names: Vec<String> = list.iter().map(|c| c.name.clone()).collect();
                let (asked, servers) = self.calls.servers(&screen.id, &site, list, launch).await?;
                Ok(json!({ "account": asked.name, "accounts": names, "servers": servers }))
            }
            Request::Ask {
                id,
                prompt,
                model,
                system,
            } => {
                if prompt.trim().is_empty() {
                    return Err("Ask the model something.".into());
                }
                let model = model.filter(|model| !model.trim().is_empty());
                if model
                    .as_deref()
                    .is_some_and(|model| model.chars().any(|c| c.is_control() || c == ' '))
                {
                    return Err("model must be one model's name, such as haiku or sonnet.".into());
                }
                let screen = self.screen(&root, &id).await?;
                let question = Question {
                    prompt,
                    model,
                    system: system.filter(|system| !system.trim().is_empty()),
                };
                let answer = launch
                    .ask(
                        screen.account.as_ref(),
                        question,
                        self.calls.closing.child_token(),
                    )
                    .await?;
                Ok(json!({ "text": answer }))
            }
            Request::Delete { id } => {
                let _change = self.changes.lock().await;
                checked_id(&id)?;
                self.calls.release(&id).await;
                self.jobs.forget_screen(&root, &id).await;
                blocking(move || {
                    for path in [file(&root, &id), data_file(&root, &id)] {
                        match std::fs::remove_file(path) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(_) => return Err("Cannot delete this screen.".to_string()),
                        }
                    }
                    Ok(())
                })
                .await?;
                Ok(json!({}))
            }
            Request::Load { id } => {
                let values = blocking(move || {
                    read(&root, &id)?;
                    read_data(&root, &id)
                })
                .await?;
                Ok(json!({ "values": values }))
            }
            Request::Save { id, key, value } => {
                if key.is_empty() || key.chars().any(|c| c.is_control()) {
                    return Err("A saved value needs a key without control characters.".into());
                }
                let _change = self.changes.lock().await;
                let bytes = blocking(move || {
                    read(&root, &id)?;
                    let mut values = read_data(&root, &id)?;
                    if value.is_null() {
                        values.remove(&key);
                    } else {
                        values.insert(key, value);
                    }
                    let bytes = serde_json::to_vec(&values)
                        .map_err(|_| "Cannot save this value".to_string())?;
                    replace(&data_file(&root, &id), &bytes)?;
                    Ok(bytes.len())
                })
                .await?;
                Ok(json!({ "bytes": bytes }))
            }
        }
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A window or another device reads this computer's screens, runs their actions and commands
/// or calls MCP tools for them. `environmentId` only routes the request here.
#[tauri::command]
pub async fn manage_screen(
    app: tauri::AppHandle,
    screens: tauri::State<'_, std::sync::Arc<Screens>>,
    call: crate::calls::Call,
    request: Request,
) -> Result<Value, String> {
    let root = root(&app)?;
    let namespace = app.config().identifier.clone();
    let launch = mcp::Host(app.clone());
    // What runs a command, calls a tool or asks a model runs once, however many copies of its
    // call the window sends (calls.rs).
    if matches!(
        request,
        Request::Run { .. } | Request::Start { .. } | Request::Mcp { .. } | Request::Ask { .. }
    ) {
        return call
            .once(screens.handle(root, namespace, &launch, request))
            .await;
    }
    screens.handle(root, namespace, &launch, request).await
}

/// The screens a chat's tools read: summaries, or one screen whole with its saved values.
pub(crate) async fn listed(root: PathBuf) -> Result<Vec<Screen>, String> {
    blocking(move || Ok(all(&root))).await
}
pub(crate) async fn opened(
    root: PathBuf,
    id: String,
) -> Result<(Screen, Map<String, Value>), String> {
    blocking(move || {
        let screen = read(&root, &id)?;
        let values = read_data(&root, &id)?;
        Ok((screen, values))
    })
    .await
}
/// Saves a chat's screen. `usable` names the accounts still connected where it runs.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn saved(
    screens: &Screens,
    root: PathBuf,
    definition: Definition,
    site: Site,
    account: Option<Account>,
    usable: impl Fn(&Account) -> bool + Send + 'static,
    conversation_id: String,
    run_id: String,
) -> Result<(Screen, bool), String> {
    let _change = screens.changes.lock().await;
    let screen = blocking(move || {
        store(
            &root,
            definition,
            site,
            account,
            &usable,
            &conversation_id,
            &run_id,
        )
    })
    .await?;
    // Its next call starts CLIs that read the accounts' servers and sign-ins as they are now.
    screens.calls.release(&screen.0.id).await;
    Ok(screen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submission() -> Value {
        json!({
            "title": "My pull requests",
            "description": "PRs I opened this week",
            "html": "<main id=\"list\"></main>",
            "actions": [{
                "name": "list_prs",
                "description": "Lists my pull requests",
                "shell": "powershell",
                "script": "gh search prs --author '@me' --created \">=$env:PARAM_SINCE\" --json number,title,url",
                "params": {"since": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}},
                "timeout": 30
            }]
        })
    }
    fn site() -> Site {
        Site {
            environment_id: "11111111-1111-4111-8111-111111111111".into(),
            distribution: None,
            folder: "C:\\Projects\\studio".into(),
            project: "C:\\Projects\\studio".into(),
        }
    }
    fn account(connection: &str) -> Account {
        Account {
            provider: "claude".into(),
            connection_id: Some(connection.into()),
        }
    }
    /// A computer without CLIs: a call that passes every check fails to start one.
    struct NoCli;
    impl mcp::Launch for NoCli {
        fn launch(&self, _site: &Site, account: &Account) -> mcp::Launched {
            let named = account.connection_id.clone().unwrap_or_default();
            Box::pin(async move { Err(format!("No CLI for {named} here.")) })
        }
    }
    fn shell() -> &'static str {
        if cfg!(windows) {
            "powershell"
        } else {
            "bash"
        }
    }

    #[test]
    fn a_screen_declares_the_mcp_tools_its_page_calls() {
        let mut args = submission();
        args["mcpTools"] = json!([
            {"server": "claude.ai Linear", "tool": "list_issues", "description": "Lists my\nissues"},
            {"server": "linear", "tool": "list_issues", "where": "WSL", "account": " Claude CLI login "},
            {"server": "github", "tool": "search_pull_requests"}
        ]);
        let parsed = definition(&args).unwrap();
        assert_eq!(
            parsed.mcp_tools,
            [
                McpTool {
                    server: "claude.ai Linear".into(),
                    tool: "list_issues".into(),
                    description: "Lists my issues".into(),
                    place: None,
                    account: None,
                },
                McpTool {
                    server: "linear".into(),
                    tool: "list_issues".into(),
                    description: String::new(),
                    place: Some("wsl".into()),
                    account: Some("Claude CLI login".into()),
                },
                McpTool {
                    server: "github".into(),
                    tool: "search_pull_requests".into(),
                    description: String::new(),
                    place: None,
                    account: None,
                },
            ]
        );
        let refuse = |tools: Value, expected: &str| {
            let mut args = submission();
            args["mcpTools"] = tools;
            let error = definition(&args).unwrap_err();
            assert!(error.contains(expected), "{error}");
        };
        refuse(json!({"server": "x"}), "mcpTools must be a list");
        refuse(
            json!(["mcp__linear__list_issues"]),
            "each MCP tool must be an object",
        );
        refuse(json!([{"tool": "list_issues"}]), "server must be text");
        refuse(
            json!([{"server": "linear", "tool": " list"}]),
            "start or end with spaces",
        );
        refuse(
            json!([{"server": "linear", "tool": "a\nb"}]),
            "control character",
        );
        refuse(
            json!([{"server": "linear", "tool": "x", "args": {}}]),
            "unknown field args",
        );
        refuse(
            json!([{"server": "linear", "tool": "x", "where": "Ubuntu 24"}]),
            "where must be windows, wsl or the name of a WSL distribution",
        );
        refuse(
            json!([{"server": "agent_studio", "tool": "visualize"}]),
            "Agent Studio's own server",
        );
        refuse(
            json!([{"server": "linear", "tool": "x"}, {"server": "linear", "tool": "x"}]),
            "listed twice",
        );
    }

    #[test]
    fn screens_saved_with_approvals_read_as_they_are_and_earlier_windows_see_them_allowed() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            file(&root, &id),
            json!({
                "id": id, "revision": 3, "title": "Old", "description": "", "html": "<p></p>",
                "actions": [{"name": "list", "shell": "bash", "script": "ls"}],
                "site": {"environmentId": "e", "folder": "/w", "project": ""},
                "conversationId": "c", "runId": "r", "createdAt": "", "updatedAt": "",
                "approval": {"digest": "0".repeat(64), "at": "2026-10-02T12:00:00.000Z"}
            })
            .to_string(),
        )
        .unwrap();
        let screen = read(&root, &id).unwrap();
        assert_eq!(screen.actions[0].name, "list");
        let detail = serde_json::to_value(Detail::of(&screen, 0)).unwrap();
        assert_eq!(detail["allowed"], true);
        assert_eq!(detail["running"], 0);
        assert!(detail["digest"]
            .as_str()
            .is_some_and(|digest| digest.len() == 64));
        // The next save drops the approval nothing reads.
        write(&root, &screen).unwrap();
        assert!(!std::fs::read_to_string(file(&root, &id))
            .unwrap()
            .contains("approval"));
    }

    #[test]
    fn the_store_keeps_the_account_that_calls_a_screens_tools() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut args = submission();
        args["mcpTools"] = json!([{"server": "linear", "tool": "list_issues"}]);
        let save = |args: &Value, chat: &str, usable: &dyn Fn(&Account) -> bool| {
            store(
                &root,
                definition(args).unwrap(),
                site(),
                Some(account(chat)),
                usable,
                &conversation,
                &conversation,
            )
            .unwrap()
            .0
        };
        let created = save(&args, "creator", &|_| true);
        assert_eq!(created.account, Some(account("creator")));
        // Another chat's update keeps it.
        args["id"] = json!(created.id);
        args["html"] = json!("<p>new</p>");
        let updated = save(&args, "other", &|_| true);
        assert_eq!(updated.account, Some(account("creator")));
        // An account no longer connected there gives way to the saving chat's.
        let moved = save(&args, "other", &|kept| {
            kept.connection_id.as_deref() != Some("creator")
        });
        assert_eq!(moved.account, Some(account("other")));
        // A screen saved before MCP tools takes the account of the chat that saves it next.
        let mut older = read(&root, &created.id).unwrap();
        older.account = None;
        write(&root, &older).unwrap();
        assert_eq!(
            save(&args, "third", &|_| true).account,
            Some(account("third"))
        );
    }

    #[test]
    fn a_submission_is_checked_whole_before_anything_is_saved() {
        let parsed = definition(&submission()).unwrap();
        assert_eq!(parsed.title, "My pull requests");
        assert_eq!(parsed.actions[0].timeout, Some(30));
        assert_eq!(parsed.actions[0].params["since"].kind, Kind::String);
        let refuse = |change: &dyn Fn(&mut Value), expected: &str| {
            let mut args = submission();
            change(&mut args);
            let error = definition(&args).unwrap_err();
            assert!(error.contains(expected), "{error}");
        };
        refuse(
            &|a| a["path"] = json!("C:/screen.html"),
            "unknown field path",
        );
        refuse(&|a| a["title"] = json!("  "), "title must not be empty");
        refuse(&|a| a["html"] = json!(""), "html must be");
        refuse(&|a| a["html"] = json!("a\u{0}b"), "NUL");
        refuse(&|a| a["id"] = json!("my-screen"), "id must be the id");
        refuse(
            &|a| a["actions"][0]["name"] = json!("ListPRs"),
            "lowercase letters",
        );
        refuse(
            &|a| a["actions"][0]["shell"] = json!("cmd"),
            "powershell or bash",
        );
        refuse(&|a| a["actions"][0]["timeout"] = json!(0), "at least 1");
        refuse(
            &|a| a["actions"][0]["where"] = json!("C:\\"),
            "where must be windows, wsl",
        );
        refuse(
            &|a| a["actions"][0]["command"] = json!("x"),
            "unknown field command",
        );
        refuse(
            &|a| a["actions"][0]["params"]["since"]["type"] = json!("date"),
            "type must be",
        );
        refuse(
            &|a| a["actions"][0]["params"]["since"]["pattern"] = json!("("),
            "not a valid regular",
        );
        refuse(
            &|a| a["actions"][0]["params"]["Since"] = json!({"type":"string"}),
            "parameter Since",
        );
        refuse(
            &|a| a["actions"][0]["params"]["since"]["minimum"] = json!(1),
            "only to a number",
        );
        refuse(
            &|a| {
                let first = a["actions"][0].clone();
                a["actions"] = json!([first.clone(), first]);
            },
            "Two actions are named list_prs",
        );
        // Text nobody reviews passes as written: emoji joined with zero-width joiners in a
        // script, a bidirectional mark in a pattern. A title loses what it cannot show.
        let mut written = submission();
        written["title"] = json!("safe\u{202e}txt");
        written["actions"][0]["script"] = json!("echo 👨\u{200d}👩\u{200d}👧");
        written["actions"][0]["params"]["since"]["pattern"] = json!("^a\u{200f}?$");
        written["actions"][0]["where"] = json!("windows");
        let parsed = definition(&written).unwrap();
        assert_eq!(parsed.title, "safetxt");
        assert!(parsed.actions[0].script.contains('\u{200d}'));
        assert_eq!(parsed.actions[0].place.as_deref(), Some("windows"));
        // A screen without actions is a page of its own.
        let mut plain = submission();
        plain.as_object_mut().unwrap().remove("actions");
        assert!(definition(&plain).unwrap().actions.is_empty());
        // Screens of any size, past what earlier releases accepted: an 80-character title, a
        // 512,000-byte page, 24 actions of 32,000-byte scripts with 12 parameters and a timeout
        // of at most 600 seconds. An action without a timeout runs until it ends.
        let mut large = submission();
        large["title"] = json!("t".repeat(200));
        large["description"] = json!("d".repeat(400));
        large["html"] = json!("x".repeat(600_000));
        let mut params = serde_json::Map::new();
        for index in 0..13 {
            params.insert(
                format!("p{index}_{}", "n".repeat(50)),
                json!({"type":"string","maxLength":20_000,"enum":(0..70).map(|i| format!("{i}{}", "v".repeat(210))).collect::<Vec<_>>()}),
            );
        }
        large["actions"] = json!((0..25)
            .map(|index| json!({"name":format!("action_{index}"),"shell":"bash","script":"s".repeat(33_000),"params":params,"timeout":86_400}))
            .collect::<Vec<_>>());
        large["actions"][0]
            .as_object_mut()
            .unwrap()
            .remove("timeout");
        let parsed = definition(&large).unwrap();
        assert_eq!(parsed.actions.len(), 25);
        assert_eq!(parsed.actions[0].timeout, None);
        assert_eq!(parsed.actions[1].timeout, Some(86_400));
        assert_eq!(parsed.html.len(), 600_000);
    }

    #[test]
    fn values_reach_scripts_as_environment_variables() {
        let parsed = definition(&json!({
            "title": "Tools",
            "html": "<p>x</p>",
            "actions": [{
                "name": "search",
                "shell": "bash",
                "script": "gh search prs \"$PARAM_QUERY\" --limit \"$PARAM_LIMIT\"",
                "params": {
                    "query": {"type": "string", "maxLength": 20},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    "state": {"type": "string", "enum": ["open", "closed"], "optional": true},
                    "draft": {"type": "boolean", "optional": true}
                }
            }]
        }))
        .unwrap();
        let action = &parsed.actions[0];
        let values = |value: Value| value.as_object().unwrap().clone();
        let mut variables = arguments(
            action,
            &values(json!({"query": "fix; rm -rf / $(x)", "limit": 5})),
        )
        .unwrap();
        variables.sort();
        assert_eq!(
            variables,
            [
                ("PARAM_LIMIT".to_string(), "5".to_string()),
                ("PARAM_QUERY".to_string(), "fix; rm -rf / $(x)".to_string())
            ]
        );
        let with = arguments(
            action,
            &values(json!({"query": "a", "limit": 2, "state": "open", "draft": true})),
        )
        .unwrap();
        assert!(with.contains(&("PARAM_DRAFT".into(), "true".into())));
        // A value the action does not declare passes as it is, JSON when it is not text.
        let extra = arguments(
            action,
            &values(
                json!({"query": "a", "limit": 2, "since": "2026-10-01", "filter": {"team": "x"}}),
            ),
        )
        .unwrap();
        assert!(extra.contains(&("PARAM_SINCE".into(), "2026-10-01".into())));
        assert!(extra.contains(&("PARAM_FILTER".into(), "{\"team\":\"x\"}".into())));
        for (input, expected) in [
            (json!({"limit": 5}), "needs a value for query"),
            (
                json!({"query": "a", "limit": 5.5}),
                "limit must be a whole number",
            ),
            (json!({"query": "a", "limit": 51}), "outside the range"),
            (json!({"query": "x".repeat(21), "limit": 5}), "at most 20"),
            (
                json!({"query": "a", "limit": 5, "state": "merged"}),
                "one of the values",
            ),
            (
                json!({"query": "a", "limit": 5, "Other": 1}),
                "The parameter Other must be named",
            ),
            (json!({"query": "a\u{0}b", "limit": 5}), "NUL"),
            (json!({"query": 4, "limit": 5}), "query must be text"),
        ] {
            let error = arguments(action, &values(input)).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
        // A command a page passes reads every value the same way.
        assert_eq!(
            passed(&values(json!({"count": 3, "skip": null, "name": "x"}))).unwrap(),
            [
                ("PARAM_COUNT".to_string(), "3".to_string()),
                ("PARAM_NAME".to_string(), "x".to_string())
            ]
        );
    }

    #[test]
    fn patterns_and_numbers_bound_what_a_screen_may_pass() {
        let parsed = definition(&submission()).unwrap();
        let action = &parsed.actions[0];
        let since = |value: &str| arguments(action, json!({ "since": value }).as_object().unwrap());
        assert!(since("2026-09-28").is_ok());
        assert!(since("2026-09-28; whoami").unwrap_err().contains("pattern"));
        // A string without a declared maxLength passes whole, past the 1,000 characters and
        // 16,000 bytes a run earlier releases allowed.
        let open = definition(&json!({"title":"x","html":"x","actions":[{"name":"echo","shell":"bash","script":"echo","params":{"text":{"type":"string"}}}]})).unwrap();
        let text = "y".repeat(50_000);
        let variables = arguments(
            &open.actions[0],
            json!({ "text": text }).as_object().unwrap(),
        )
        .unwrap();
        assert_eq!(variables[0].1.len(), 50_000);
    }

    #[test]
    fn the_store_keeps_revisions_and_the_place_a_screen_was_made() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let conversation = uuid::Uuid::new_v4().to_string();
        let run = uuid::Uuid::new_v4().to_string();
        let (screen, created) = store(
            &root,
            definition(&submission()).unwrap(),
            site(),
            None,
            &|_| true,
            &conversation,
            &run,
        )
        .unwrap();
        assert!(created && screen.revision == 1);
        assert_eq!(all(&root).len(), 1);
        // The same id names the screen and its folder stays.
        let mut update = submission();
        update["id"] = json!(screen.id);
        update["html"] = json!("<main>new</main>");
        let mut elsewhere = site();
        elsewhere.folder = "D:\\other".into();
        let (updated, created) = store(
            &root,
            definition(&update).unwrap(),
            elsewhere,
            None,
            &|_| true,
            &conversation,
            &run,
        )
        .unwrap();
        assert!(!created && updated.revision == 2);
        assert_eq!(updated.site.folder, "C:\\Projects\\studio");
        // Another environment of this computer cannot take it over.
        let mut wsl = site();
        wsl.environment_id = "33333333-3333-4333-8333-333333333333".into();
        let error = store(
            &root,
            definition(&update).unwrap(),
            wsl,
            None,
            &|_| true,
            &conversation,
            &run,
        )
        .unwrap_err();
        assert!(error.contains("another environment"), "{error}");
        // An unknown id names the way to find screens.
        update["id"] = json!(uuid::Uuid::new_v4().to_string());
        let error = store(
            &root,
            definition(&update).unwrap(),
            site(),
            None,
            &|_| true,
            &conversation,
            &run,
        )
        .unwrap_err();
        assert!(error.contains("list_screens"), "{error}");
        // Unreadable or foreign files never list.
        std::fs::write(root.join("notes.json"), b"{}").unwrap();
        std::fs::write(root.join(format!("{}.json", uuid::Uuid::new_v4())), b"{}").unwrap();
        assert_eq!(all(&root).len(), 1);
    }

    #[tokio::test]
    async fn requests_run_jobs_save_and_delete_by_id_alone() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let folder = directory.path().join("work");
        std::fs::create_dir_all(&folder).unwrap();
        let screens = Screens::default();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut here = site();
        here.folder = folder.to_string_lossy().into_owned();
        let script = if cfg!(windows) {
            "Write-Output \"since $env:PARAM_SINCE\""
        } else {
            "echo \"since $PARAM_SINCE\""
        };
        let (screen, _) = store(
            &root,
            definition(&json!({"title": "Runs", "html": "<p></p>", "actions": [{
                "name": "list", "shell": shell(), "script": script,
                "params": {"since": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"}}
            }]}))
            .unwrap(),
            here,
            None,
            &|_| true,
            &conversation,
            &conversation,
        )
        .unwrap();
        let ask = |request: Value| {
            let root = root.clone();
            let screens = &screens;
            async move {
                screens
                    .handle(
                        root,
                        "agent-studio-test".into(),
                        &NoCli,
                        serde_json::from_value(request).unwrap(),
                    )
                    .await
            }
        };
        let listed = ask(json!({"op": "list"})).await.unwrap();
        assert_eq!(listed["screens"][0]["id"], screen.id);
        assert_eq!(listed["screens"][0]["commands"], 1);
        assert_eq!(listed["screens"][0]["allowed"], true);
        assert!(listed["screens"][0].get("html").is_none());
        // It runs at once: nothing waits for an approval, and the requests of windows that
        // asked for one answer with the screen.
        let detail = ask(json!({"op": "read", "id": screen.id})).await.unwrap();
        let approved = ask(json!({"op": "approve", "id": screen.id, "digest": detail["digest"]}))
            .await
            .unwrap();
        assert_eq!(approved["id"], screen.id);
        assert_eq!(
            ask(json!({"op": "revoke", "id": screen.id})).await.unwrap()["allowed"],
            true
        );
        let outcome = ask(json!({"op": "run", "id": screen.id, "action": "list", "params": {"since": "2026-09-28"}}))
            .await
            .unwrap();
        assert_eq!(outcome["exitCode"], 0, "{outcome}");
        assert_eq!(
            outcome["stdout"].as_str().unwrap().trim(),
            "since 2026-09-28"
        );
        // A run whose page waited for it leaves nothing behind.
        assert!(
            ask(json!({"op": "jobs", "id": screen.id})).await.unwrap()["jobs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let unknown = ask(json!({"op": "run", "id": screen.id, "action": "other"}))
            .await
            .unwrap_err();
        assert!(unknown.contains("no action named other"));
        let invalid = ask(json!({"op": "run", "id": screen.id, "action": "list", "params": {"since": "yesterday"}}))
            .await
            .unwrap_err();
        assert!(invalid.contains("pattern"), "{invalid}");
        // A kept job, and a command the page passes, stay with their output until forgotten.
        let kept = ask(json!({"op": "start", "id": screen.id, "action": "list", "params": {"since": "2026-10-01"}, "keep": true}))
            .await
            .unwrap();
        assert_eq!(kept["state"], "running");
        assert_eq!(kept["label"], "list");
        let command = if cfg!(windows) {
            "Write-Output \"$env:PARAM_WHO here\""
        } else {
            "echo \"$PARAM_WHO here\""
        };
        let passed = ask(json!({"op": "start", "id": screen.id, "command": {"shell": shell(), "script": command}, "params": {"who": "me"}, "keep": true}))
            .await
            .unwrap();
        assert_eq!(passed["label"], command);
        assert!(passed.get("action").is_none());
        for (job, expected) in [(&kept, "since 2026-10-01"), (&passed, "me here")] {
            let mut after = 0;
            let mut text = String::new();
            loop {
                let answer = ask(json!({"op": "output", "id": screen.id, "job": job["id"], "after": after, "wait": true}))
                    .await
                    .unwrap();
                for chunk in answer["chunks"].as_array().unwrap() {
                    text.push_str(chunk["text"].as_str().unwrap());
                }
                after = answer["next"].as_u64().unwrap();
                if answer["job"]["state"] != "running" {
                    assert_eq!(answer["job"]["exitCode"], 0);
                    break;
                }
            }
            assert_eq!(text.trim(), expected);
        }
        let jobs = ask(json!({"op": "jobs", "id": screen.id})).await.unwrap();
        assert_eq!(jobs["jobs"].as_array().unwrap().len(), 2);
        ask(json!({"op": "forget", "id": screen.id, "job": kept["id"]}))
            .await
            .unwrap();
        let refused = ask(json!({"op": "start", "id": screen.id}))
            .await
            .unwrap_err();
        assert!(
            refused.contains("Name one of the screen's actions"),
            "{refused}"
        );
        // Saved values stay with the screen, whatever their size.
        ask(json!({"op": "save", "id": screen.id, "key": "filters", "value": {"state": "open"}}))
            .await
            .unwrap();
        let loaded = ask(json!({"op": "load", "id": screen.id})).await.unwrap();
        assert_eq!(loaded["values"]["filters"]["state"], "open");
        ask(json!({"op": "save", "id": screen.id, "key": "filters", "value": null}))
            .await
            .unwrap();
        let loaded = ask(json!({"op": "load", "id": screen.id})).await.unwrap();
        assert!(loaded["values"].as_object().unwrap().is_empty());
        let large = ask(
            json!({"op": "save", "id": screen.id, "key": "k".repeat(500), "value": "x".repeat(2_000_000)}),
        )
        .await
        .unwrap();
        assert!(large["bytes"].as_u64().unwrap() > 2_000_000);
        let key = ask(json!({"op": "save", "id": screen.id, "key": "", "value": 1}))
            .await
            .unwrap_err();
        assert!(key.contains("key"), "{key}");
        // Ids are checked, never used as paths.
        let path = ask(json!({"op": "read", "id": "../workspace"}))
            .await
            .unwrap_err();
        assert_eq!(path, "Invalid screen id");
        // Deleting the screen takes its values and jobs with it.
        ask(json!({"op": "delete", "id": screen.id})).await.unwrap();
        assert_eq!(
            ask(json!({"op": "read", "id": screen.id}))
                .await
                .unwrap_err(),
            MISSING
        );
        assert!(!data_file(&root, &screen.id).exists());
        assert!(!root.join("jobs").join(&screen.id).exists());
    }

    #[tokio::test]
    async fn a_page_calls_any_mcp_tool_and_asks_models_as_the_screens_account() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screens = Screens::default();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut args = submission();
        args["mcpTools"] = json!([{"server": "linear", "tool": "list_issues"}]);
        let (screen, _) = store(
            &root,
            definition(&args).unwrap(),
            site(),
            Some(account("creator")),
            &|_| true,
            &conversation,
            &conversation,
        )
        .unwrap();
        let ask = |request: Value| {
            let root = root.clone();
            let screens = &screens;
            async move {
                screens
                    .handle(
                        root,
                        "agent-studio-test".into(),
                        &NoCli,
                        serde_json::from_value(request).unwrap(),
                    )
                    .await
            }
        };
        let call = |tool: &str| json!({"op": "mcp", "id": screen.id, "server": "linear", "tool": tool, "arguments": {"team": "x"}});
        let listed = ask(json!({"op": "list"})).await.unwrap();
        assert_eq!(listed["screens"][0]["tools"], 1);
        let detail = ask(json!({"op": "read", "id": screen.id})).await.unwrap();
        assert_eq!(
            detail["mcpTools"],
            json!([{"server": "linear", "tool": "list_issues"}])
        );
        assert_eq!(
            detail["account"],
            json!({"provider": "claude", "connectionId": "creator"})
        );
        // A declared tool and one it does not declare go to the CLI of the screen's account.
        for tool in ["list_issues", "delete_issue"] {
            assert_eq!(
                ask(call(tool)).await.unwrap_err(),
                "No CLI for creator here."
            );
        }
        assert_eq!(
            ask(json!({"op": "tools", "id": screen.id}))
                .await
                .unwrap_err(),
            "the screen's account: No CLI for creator here."
        );
        // Another place of this computer is named as such; this one has no WSL listed.
        let elsewhere = ask(
            json!({"op": "mcp", "id": screen.id, "server": "linear", "tool": "x", "where": "wsl"}),
        )
        .await
        .unwrap_err();
        assert!(elsewhere.contains("WSL"), "{elsewhere}");
        // A screen without an account and no saved accounts has nothing to call with.
        let mut older = read(&root, &screen.id).unwrap();
        older.account = None;
        write(&root, &older).unwrap();
        assert!(ask(call("list_issues"))
            .await
            .unwrap_err()
            .contains("No Claude or Codex account"));
        // A page's question needs one, and a computer that asks models.
        assert!(ask(json!({"op": "ask", "id": screen.id, "prompt": "  "}))
            .await
            .unwrap_err()
            .contains("Ask the model something"));
        assert!(
            ask(json!({"op": "ask", "id": screen.id, "prompt": "Hi", "model": "two words"}))
                .await
                .unwrap_err()
                .contains("one model's name")
        );
        assert_eq!(
            ask(json!({"op": "ask", "id": screen.id, "prompt": "Hi"}))
                .await
                .unwrap_err(),
            "This computer cannot ask a model for screens."
        );
    }
}
