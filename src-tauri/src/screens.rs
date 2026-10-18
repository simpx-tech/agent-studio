//! Screens (docs/SCREENS.md): lasting pages a chat saves in Agent Studio, each with its own HTML
//! interface and the actions it may run on the computer that keeps it.
//!
//! A screen lives on that computer alone, under app data `screens/`, never in the workspace,
//! exports or relay sync. Windows and other devices read it and run its actions through
//! transport (`manage_screen`, the `screens` relay job), naming the screen by its id alone. The
//! host runs only an action the screen declares, once the user allowed exactly the actions it
//! declares now, in the folder recorded when a chat saved it, with each parameter's value in an
//! environment variable of its own, never in command text.
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub mod mcp;
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

/// A command a screen may run, as the user allows it.
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
}

/// An MCP tool a screen's page may call, as the user allows it: a tool of one of the servers
/// its account's CLI has, named as that CLI names them (`mcp__<server>__<tool>`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

/// The account whose CLI calls a screen's MCP tools: the one the chat that created the screen
/// replied with, on the computer that keeps it. No connection is this computer's own CLI login.
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub digest: String,
    pub at: String,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
}

impl Screen {
    /// What the user allows: the actions and where they run, and the MCP tools with the account
    /// that calls them. The HTML can only call them. A screen without MCP tools keeps the
    /// digest it had before them, and with it the approval the user gave.
    pub fn digest(&self) -> String {
        let canonical = if self.mcp_tools.is_empty() {
            json!({ "actions": self.actions, "site": self.site })
        } else {
            json!({
                "actions": self.actions,
                "site": self.site,
                "mcpTools": self.mcp_tools,
                "account": self.account,
            })
        };
        hex(&Sha256::digest(canonical.to_string().as_bytes()))
    }
    /// Whether its actions and tools may run: none to allow, or the user allowed exactly these.
    pub fn allowed(&self) -> bool {
        (self.actions.is_empty() && self.mcp_tools.is_empty())
            || self
                .approval
                .as_ref()
                .is_some_and(|approval| approval.digest == self.digest())
    }
    /// The declared tool a page calls, once the user allowed the screen's actions and tools.
    pub fn tool(&self, server: &str, tool: &str) -> Result<&McpTool, String> {
        let declared = self
            .mcp_tools
            .iter()
            .find(|known| known.server == server && known.tool == tool)
            .ok_or_else(|| format!("This screen declares no MCP tool {tool} of {server}."))?;
        if !self.allowed() {
            return Err(NOT_ALLOWED.into());
        }
        Ok(declared)
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
    pub allowed: bool,
}

impl From<&Screen> for Summary {
    fn from(screen: &Screen) -> Self {
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
            allowed: screen.allowed(),
        }
    }
}

/// A screen as its window renders it and the user reviews its actions.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub summary: Summary,
    pub html: String,
    pub actions: Vec<Action>,
    pub mcp_tools: Vec<McpTool>,
    /// The account that calls its MCP tools, which the window names by its connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// What allowing these actions names, so a changed screen is never allowed unseen.
    pub digest: String,
}

impl From<&Screen> for Detail {
    fn from(screen: &Screen) -> Self {
        Self {
            summary: screen.into(),
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

/// Text the user reads when allowing a screen: on one line, and without characters that hide
/// or reorder what it says.
fn line(value: Option<&Value>, field: &str, required: bool) -> Result<String, String> {
    let text = match value {
        None | Some(Value::Null) if !required => return Ok(String::new()),
        Some(Value::String(text)) => text,
        _ => return Err(format!("{field} must be text.")),
    };
    let text: String = text
        .chars()
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let text = text.trim();
    if let Some(c) = text.chars().find(|c| crate::console::hidden(*c)) {
        return Err(format!(
            "{field} contains a hidden character (U+{:04X}).",
            c as u32
        ));
    }
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

/// A script as its shell will read it: plain line ends, and nothing in it the user could not
/// see when allowing it.
fn script(value: Option<&Value>) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or("script must be the text of the command to run.")?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim_end_matches('\n');
    if text.trim().is_empty() {
        return Err("script must not be empty.".into());
    }
    if let Some(c) = text.chars().find(|c| crate::console::hidden(*c)) {
        return Err(format!(
            "script contains a hidden character (U+{:04X}), which the user could not see when allowing it.",
            c as u32
        ));
    }
    Ok(text.into())
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
                    Kind::String => value.as_str().is_some_and(|s| {
                        !s.chars()
                            .any(|c| c.is_control() || crate::console::hidden(c))
                    }),
                    Kind::Number => value.as_f64().is_some_and(f64::is_finite),
                    Kind::Integer => value.as_f64().is_some_and(whole),
                    Kind::Boolean => value.is_boolean(),
                };
                if !fits {
                    return Err(format!(
                        "enum values must each be a {} of this parameter's type.",
                        if kind == Kind::String {
                            "line"
                        } else {
                            "value"
                        }
                    ));
                }
            }
            Some(values.clone())
        }
        Some(_) => return Err("enum must list at least one value.".into()),
    };
    let pattern = match object.get("pattern") {
        None | Some(Value::Null) => None,
        Some(Value::String(pattern)) if kind == Kind::String => {
            // The user reads it when allowing the action; escape such characters instead.
            if let Some(c) = pattern
                .chars()
                .find(|c| c.is_control() || crate::console::hidden(*c))
            {
                return Err(format!(
                    "pattern contains a hidden character (U+{:04X}); write it as an escape such as \\u{{{:04X}}}.",
                    c as u32, c as u32
                ));
            }
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
    Ok(Action {
        name,
        description,
        shell,
        script,
        params,
        timeout,
    })
}

/// A server's or a tool's name, as the user reads it when allowing the tool and the CLI finds
/// it: one line as written, without control or hidden characters.
fn tool_name(value: Option<&Value>, field: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or(format!("{field} must be text."))?;
    if text.trim().is_empty() {
        return Err(format!("{field} must not be empty."));
    }
    if text.trim() != text {
        return Err(format!("{field} must not start or end with spaces."));
    }
    if let Some(c) = text
        .chars()
        .find(|c| c.is_control() || crate::console::hidden(*c))
    {
        return Err(format!(
            "{field} contains a hidden character (U+{:04X}).",
            c as u32
        ));
    }
    Ok(text.into())
}

fn mcp_tool(item: &Value) -> Result<McpTool, String> {
    let object = item.as_object().ok_or(
        "each MCP tool must be an object such as {\"server\":\"linear\",\"tool\":\"list_issues\"}.",
    )?;
    unexpected(object, &["server", "tool", "description"])
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
    Ok(McpTool {
        server,
        tool,
        description,
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

/// The values a screen passes, checked against what its action declares, as the environment
/// variables its script reads.
pub fn arguments(
    action: &Action,
    values: &Map<String, Value>,
) -> Result<Vec<(String, String)>, String> {
    if let Some(name) = values
        .keys()
        .find(|name| !action.params.contains_key(*name))
    {
        return Err(format!("{} takes no parameter named {name}.", action.name));
    }
    let mut variables = Vec::new();
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
/// An update keeps where the screen runs and the account that calls its MCP tools, unless
/// `usable` finds that account gone, and keeps the user's approval while the actions, the tools
/// and that account stay the same. `account` is the saving chat's.
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
                    "Screen {id} runs its actions in another environment of this computer ({}). Update it from a chat there.",
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
                    approval: previous.approval.clone(),
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
                approval: None,
            },
            true,
        ),
    };
    let mut screen = screen;
    // An approval of other actions never carries over: it stays only while it names these.
    if !screen
        .approval
        .as_ref()
        .is_some_and(|approval| approval.digest == screen.digest())
    {
        screen.approval = None;
    }
    write(root, &screen)?;
    Ok((screen, created))
}

/// This computer's screens and the actions they run, one request at a time for each change.
/// Actions and MCP calls run side by side, as many at once as they are asked for.
#[derive(Default)]
pub struct Screens {
    changes: tokio::sync::Mutex<()>,
    /// The CLIs that answer the screens' MCP calls.
    pub calls: mcp::Calls,
}

/// What a window or another device asks of this computer's screens.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    List,
    Read {
        id: String,
    },
    Run {
        id: String,
        action: String,
        #[serde(default)]
        params: Map<String, Value>,
    },
    /// Calls one of the MCP tools the screen declares, with the arguments its page passes.
    Mcp {
        id: String,
        server: String,
        tool: String,
        #[serde(default)]
        arguments: Map<String, Value>,
    },
    Approve {
        id: String,
        digest: String,
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

impl Screens {
    /// Answers one request. `launch` starts the CLI that answers a screen's MCP calls.
    pub async fn handle(
        &self,
        root: PathBuf,
        namespace: String,
        launch: &dyn mcp::Launch,
        request: Request,
    ) -> Result<Value, String> {
        match request {
            Request::List => {
                let screens = blocking(move || Ok(all(&root))).await?;
                let summaries: Vec<Summary> = screens.iter().map(Summary::from).collect();
                Ok(json!({ "screens": summaries }))
            }
            Request::Read { id } => {
                let screen = blocking(move || read(&root, &id)).await?;
                encode(&Detail::from(&screen))
            }
            Request::Run { id, action, params } => {
                let read_root = root.clone();
                let screen = blocking(move || read(&read_root, &id)).await?;
                let declared = screen
                    .actions
                    .iter()
                    .find(|known| known.name == action)
                    .ok_or_else(|| format!("This screen has no action named {action}."))?;
                if !screen.allowed() {
                    return Err(NOT_ALLOWED.into());
                }
                let variables = arguments(declared, &params)?;
                let outcome =
                    run::execute(&root, &namespace, &screen.site, declared, variables).await?;
                encode(&outcome)
            }
            Request::Mcp {
                id,
                server,
                tool,
                arguments,
            } => {
                let screen = blocking(move || read(&root, &id)).await?;
                screen.tool(&server, &tool)?;
                let account = screen.account.clone().ok_or(NO_ACCOUNT)?;
                self.calls
                    .call(&screen, &account, launch, &server, &tool, arguments)
                    .await
            }
            Request::Approve { id, digest } => {
                let _change = self.changes.lock().await;
                let screen = blocking(move || {
                    let mut screen = read(&root, &id)?;
                    if screen.digest() != digest {
                        return Err("This screen's actions changed since they were shown. Review them again.".to_string());
                    }
                    screen.approval = Some(Approval { digest, at: now() });
                    write(&root, &screen)?;
                    Ok(screen)
                })
                .await?;
                encode(&Detail::from(&screen))
            }
            Request::Revoke { id } => {
                let _change = self.changes.lock().await;
                let screen = blocking(move || {
                    let mut screen = read(&root, &id)?;
                    screen.approval = None;
                    write(&root, &screen)?;
                    Ok(screen)
                })
                .await?;
                // A screen that may call nothing keeps no CLI for its calls.
                self.calls.release(&screen.id).await;
                encode(&Detail::from(&screen))
            }
            Request::Delete { id } => {
                let _change = self.changes.lock().await;
                self.calls.release(&id).await;
                blocking(move || {
                    checked_id(&id)?;
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

pub const NOT_ALLOWED: &str = "The user has not allowed this screen's actions yet. They can review and allow them above the screen.";
const NO_ACCOUNT: &str =
    "This screen has no account to call MCP tools with. Ask a chat to save it again.";

/// A window or another device reads this computer's screens, runs one of their actions or
/// calls one of their MCP tools. `environmentId` only routes the request here.
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
    // An action or a tool runs once, however many copies of its call the window sends
    // (calls.rs).
    if matches!(request, Request::Run { .. } | Request::Mcp { .. }) {
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
    // Its next call starts a CLI that reads the account's servers and sign-ins as they are now.
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

    #[test]
    fn a_screen_declares_the_mcp_tools_its_page_calls() {
        let mut args = submission();
        args["mcpTools"] = json!([
            {"server": "claude.ai Linear", "tool": "list_issues", "description": "Lists my\nissues"},
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
                },
                McpTool {
                    server: "github".into(),
                    tool: "search_pull_requests".into(),
                    description: String::new(),
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
        refuse(json!([{"server": "line\u{200b}ar", "tool": "x"}]), "U+200B");
        refuse(
            json!([{"server": "linear", "tool": "a\nb"}]),
            "hidden character",
        );
        refuse(
            json!([{"server": "linear", "tool": "x", "args": {}}]),
            "unknown field args",
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
    fn the_approval_names_the_tools_and_their_account_and_keeps_earlier_digests() {
        let mut screen = Screen {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            title: "x".into(),
            description: String::new(),
            html: "x".into(),
            actions: definition(&json!({"title":"x","html":"x","actions":[{"name":"list","shell":"bash","script":"ls"}]}))
                .unwrap()
                .actions,
            mcp_tools: vec![],
            site: Site {
                environment_id: "e".into(),
                distribution: None,
                folder: "/w".into(),
                project: String::new(),
            },
            account: Some(account("first")),
            conversation_id: String::new(),
            run_id: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            approval: None,
        };
        // Screens without MCP tools keep the digest earlier releases recorded approvals with,
        // whatever account they now record.
        let earlier = r#"{"actions":[{"name":"list","script":"ls","shell":"bash"}],"site":{"environmentId":"e","folder":"/w","project":""}}"#;
        assert_eq!(screen.digest(), hex(&Sha256::digest(earlier.as_bytes())));
        screen.approval = Some(Approval {
            digest: screen.digest(),
            at: now(),
        });
        assert!(screen.allowed());
        // Declaring a tool, or calling it as another account, needs the user again.
        screen.mcp_tools = vec![McpTool {
            server: "linear".into(),
            tool: "list_issues".into(),
            description: String::new(),
        }];
        assert!(!screen.allowed());
        assert_eq!(
            screen.tool("linear", "list_issues").unwrap_err(),
            NOT_ALLOWED
        );
        screen.approval = Some(Approval {
            digest: screen.digest(),
            at: now(),
        });
        assert!(screen.allowed());
        assert_eq!(
            screen.tool("linear", "list_issues").unwrap().tool,
            "list_issues"
        );
        assert!(screen
            .tool("linear", "delete_issue")
            .unwrap_err()
            .contains("declares no MCP tool delete_issue of linear"));
        screen.account = Some(account("second"));
        assert!(!screen.allowed());
        // A screen of tools alone waits for the user too.
        screen.actions.clear();
        screen.approval = None;
        assert!(!screen.allowed());
        screen.mcp_tools.clear();
        assert!(screen.allowed());
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
        // Another chat's update keeps it, and with it the user's approval.
        let mut allowed = created.clone();
        allowed.approval = Some(Approval {
            digest: allowed.digest(),
            at: now(),
        });
        write(&root, &allowed).unwrap();
        args["id"] = json!(created.id);
        args["html"] = json!("<p>new</p>");
        let updated = save(&args, "other", &|_| true);
        assert_eq!(updated.account, Some(account("creator")));
        assert!(updated.allowed());
        // An account no longer connected there gives way to the saving chat's.
        let moved = save(&args, "other", &|kept| {
            kept.connection_id.as_deref() != Some("creator")
        });
        assert_eq!(moved.account, Some(account("other")));
        assert!(!moved.allowed());
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
        refuse(
            &|a| a["title"] = json!("safe\u{202e}txt"),
            "hidden character",
        );
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
        refuse(
            &|a| a["actions"][0]["script"] = json!("rm\u{200b} -rf x"),
            "U+200B",
        );
        refuse(&|a| a["actions"][0]["timeout"] = json!(0), "at least 1");
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
            &|a| a["actions"][0]["params"]["since"]["pattern"] = json!("^a\u{202e}$"),
            "pattern contains a hidden character (U+202E)",
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
    fn values_reach_scripts_as_checked_environment_variables() {
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
        for (input, expected) in [
            (json!({"limit": 5}), "needs a value for query"),
            (
                json!({"query": "a", "limit": 5.5}),
                "limit must be a whole number",
            ),
            (json!({"query": "a", "limit": 51}), "outside the range"),
            (json!({"query": "x".repeat(21), "limit": 5}), "at most 20"),
            (
                json!({"query": "a", "limit": 5, "state": "x".repeat(2000)}),
                "one of the values",
            ),
            (
                json!({"query": "a", "limit": 5, "state": "merged"}),
                "one of the values",
            ),
            (
                json!({"query": "a", "limit": 5, "other": 1}),
                "no parameter named other",
            ),
            (json!({"query": "a\u{0}b", "limit": 5}), "NUL"),
            (json!({"query": 4, "limit": 5}), "query must be text"),
        ] {
            let error = arguments(action, &values(input)).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
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
    fn the_store_keeps_revisions_and_approval_only_for_the_same_actions() {
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
        assert!(created && screen.revision == 1 && !screen.allowed());
        assert_eq!(all(&root).len(), 1);
        // The user allows exactly what they reviewed.
        let mut allowed = read(&root, &screen.id).unwrap();
        allowed.approval = Some(Approval {
            digest: allowed.digest(),
            at: now(),
        });
        write(&root, &allowed).unwrap();
        assert!(read(&root, &screen.id).unwrap().allowed());
        // New HTML keeps the approval; the same id names the screen and its folder stays.
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
        assert!(!created && updated.revision == 2 && updated.allowed());
        assert_eq!(updated.site.folder, "C:\\Projects\\studio");
        // A changed script needs the user again.
        update["actions"][0]["script"] = json!("gh pr list");
        let (changed, _) = store(
            &root,
            definition(&update).unwrap(),
            site(),
            None,
            &|_| true,
            &conversation,
            &run,
        )
        .unwrap();
        assert!(changed.revision == 3 && !changed.allowed() && changed.approval.is_none());
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
    async fn requests_allow_run_save_and_delete_by_id_alone() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("screens");
        let screens = Screens::default();
        let conversation = uuid::Uuid::new_v4().to_string();
        let (screen, _) = store(
            &root,
            definition(&submission()).unwrap(),
            site(),
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
        assert_eq!(listed["screens"][0]["allowed"], false);
        assert!(listed["screens"][0].get("html").is_none());
        // Nothing runs before the user allows it.
        let refused = ask(json!({"op": "run", "id": screen.id, "action": "list_prs", "params": {"since": "2026-09-28"}}))
            .await
            .unwrap_err();
        assert_eq!(refused, NOT_ALLOWED);
        // Allowing needs the digest of the actions the user saw.
        let detail = ask(json!({"op": "read", "id": screen.id})).await.unwrap();
        let stale = ask(json!({"op": "approve", "id": screen.id, "digest": "0".repeat(64)}))
            .await
            .unwrap_err();
        assert!(stale.contains("changed since"), "{stale}");
        let approved = ask(json!({"op": "approve", "id": screen.id, "digest": detail["digest"]}))
            .await
            .unwrap();
        assert_eq!(approved["allowed"], true);
        let unknown = ask(json!({"op": "run", "id": screen.id, "action": "other"}))
            .await
            .unwrap_err();
        assert!(unknown.contains("no action named other"));
        let invalid = ask(json!({"op": "run", "id": screen.id, "action": "list_prs", "params": {"since": "yesterday"}}))
            .await
            .unwrap_err();
        assert!(invalid.contains("pattern"), "{invalid}");
        let revoked = ask(json!({"op": "revoke", "id": screen.id})).await.unwrap();
        assert_eq!(revoked["allowed"], false);
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
        ask(json!({"op": "delete", "id": screen.id})).await.unwrap();
        assert_eq!(
            ask(json!({"op": "read", "id": screen.id}))
                .await
                .unwrap_err(),
            MISSING
        );
        assert!(!data_file(&root, &screen.id).exists());
    }

    #[tokio::test]
    async fn a_page_calls_only_the_tools_it_declares_once_allowed_as_its_account() {
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
        assert_eq!(listed["screens"][0]["allowed"], false);
        assert_eq!(ask(call("list_issues")).await.unwrap_err(), NOT_ALLOWED);
        let detail = ask(json!({"op": "read", "id": screen.id})).await.unwrap();
        assert_eq!(
            detail["mcpTools"],
            json!([{"server": "linear", "tool": "list_issues"}])
        );
        assert_eq!(
            detail["account"],
            json!({"provider": "claude", "connectionId": "creator"})
        );
        ask(json!({"op": "approve", "id": screen.id, "digest": detail["digest"]}))
            .await
            .unwrap();
        assert!(ask(call("delete_issue"))
            .await
            .unwrap_err()
            .contains("declares no MCP tool"));
        // An allowed tool goes to the CLI of the screen's own account.
        assert_eq!(
            ask(call("list_issues")).await.unwrap_err(),
            "No CLI for creator here."
        );
        // A screen without an account has none to call with.
        let mut older = read(&root, &screen.id).unwrap();
        older.account = None;
        older.approval = Some(Approval {
            digest: older.digest(),
            at: now(),
        });
        write(&root, &older).unwrap();
        assert_eq!(ask(call("list_issues")).await.unwrap_err(), NO_ACCOUNT);
    }
}
