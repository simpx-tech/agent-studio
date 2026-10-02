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

mod run;
pub mod tools;

pub const MAX_TITLE: usize = 80;
pub const MAX_DESCRIPTION: usize = 300;
pub const MAX_HTML: usize = 512_000;
pub const MAX_ACTIONS: usize = 24;
pub const MAX_SCRIPT: usize = 32_000;
pub const MAX_PARAMS: usize = 12;
const MAX_NAME: usize = 40;
const MAX_CHOICES: usize = 64;
const MAX_CHOICE: usize = 200;
const MAX_PATTERN: usize = 300;
const MAX_STRING: u64 = 8_000;
const DEFAULT_STRING: usize = 1_000;
const DEFAULT_TIMEOUT: u32 = 60;
pub const MAX_TIMEOUT: u32 = 600;
/// What one run's parameter values hold together, well within what an environment carries.
const MAX_ARGUMENTS: usize = 16_000;
/// Screens one computer keeps.
const MAX_SCREENS: usize = 200;
/// What one screen keeps with `studio.save`, serialized.
pub const MAX_DATA: usize = 1_000_000;
const MAX_KEY: usize = 100;
/// Actions running at once on this computer, across its screens.
const MAX_RUNNING: usize = 6;
/// How long an action waits for its turn when that many already run.
const QUEUE_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

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
    pub timeout: u32,
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

/// The card a reply shows for a screen it saved: bounded metadata only, never the screen.
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
    pub site: Site,
    /// The conversation that created the screen, and the reply that saved it last.
    pub conversation_id: String,
    pub run_id: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
}

impl Screen {
    /// What the user allows: the actions and where they run. The HTML can only call them.
    pub fn digest(&self) -> String {
        let canonical = json!({ "actions": self.actions, "site": self.site });
        hex(&Sha256::digest(canonical.to_string().as_bytes()))
    }
    /// Whether its actions may run: none to allow, or the user allowed exactly these.
    pub fn allowed(&self) -> bool {
        self.actions.is_empty()
            || self
                .approval
                .as_ref()
                .is_some_and(|approval| approval.digest == self.digest())
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
    /// What allowing these actions names, so a changed screen is never allowed unseen.
    pub digest: String,
}

impl From<&Screen> for Detail {
    fn from(screen: &Screen) -> Self {
        Self {
            summary: screen.into(),
            html: screen.html.clone(),
            actions: screen.actions.clone(),
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
}

/// Text the user reads when allowing a screen: bounded, on one line, and without characters
/// that hide or reorder what it says.
fn line(value: Option<&Value>, field: &str, max: usize, required: bool) -> Result<String, String> {
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
    if text.chars().count() > max {
        return Err(format!("{field} must be at most {max} characters."));
    }
    Ok(text.into())
}

/// A name a screen's script calls an action or reads a parameter by.
fn identifier(name: &str) -> bool {
    (1..=MAX_NAME).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn unexpected(object: &Map<String, Value>, accepted: &[&str]) -> Result<(), String> {
    let extra: Vec<_> = object
        .keys()
        .filter(|key| !accepted.contains(&key.as_str()))
        .take(5)
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

/// A script as its shell will read it: plain line ends, bounded, and nothing in it the user
/// could not see when allowing it.
fn script(value: Option<&Value>) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or("script must be the text of the command to run.")?;
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim_end_matches('\n');
    if text.trim().is_empty() {
        return Err("script must not be empty.".into());
    }
    if text.len() > MAX_SCRIPT {
        return Err(format!("script must be at most {MAX_SCRIPT} bytes."));
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
    let description = line(
        object.get("description"),
        "description",
        MAX_DESCRIPTION,
        false,
    )?;
    let choices = match object.get("enum") {
        None | Some(Value::Null) => None,
        Some(Value::Array(values)) if (1..=MAX_CHOICES).contains(&values.len()) => {
            for value in values {
                let fits = match kind {
                    Kind::String => value.as_str().is_some_and(|s| {
                        s.chars().count() <= MAX_CHOICE
                            && !s
                                .chars()
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
                            "line of at most 200 characters"
                        } else {
                            "value"
                        }
                    ));
                }
            }
            Some(values.clone())
        }
        Some(_) => return Err(format!("enum must list 1 to {MAX_CHOICES} values.")),
    };
    let pattern = match object.get("pattern") {
        None | Some(Value::Null) => None,
        Some(Value::String(pattern)) if kind == Kind::String => {
            if pattern.chars().count() > MAX_PATTERN {
                return Err(format!("pattern must be at most {MAX_PATTERN} characters."));
            }
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
                .filter(|n| (1..=MAX_STRING).contains(n))
                .ok_or(format!("maxLength must be from 1 to {MAX_STRING}."))?,
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
        .ok_or("name must be 1 to 40 lowercase letters, digits or _, starting with a letter.")?
        .to_string();
    let named = |error: String| format!("Action {name}: {error}");
    let description = line(
        object.get("description"),
        "description",
        MAX_DESCRIPTION,
        false,
    )
    .map_err(named)?;
    let shell = match object.get("shell").and_then(Value::as_str) {
        Some("powershell") => Shell::Powershell,
        Some("bash") => Shell::Bash,
        _ => return Err(named("shell must be powershell or bash.".into())),
    };
    let script = script(object.get("script")).map_err(named)?;
    let params = match object.get("params") {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(params)) => {
            if params.len() > MAX_PARAMS {
                return Err(named(format!(
                    "declare at most {MAX_PARAMS} parameters."
                )));
            }
            let mut declared = BTreeMap::new();
            for (key, spec) in params {
                if !identifier(key) {
                    return Err(named(format!(
                        "parameter {key} must be named with 1 to 40 lowercase letters, digits or _, starting with a letter."
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
    let timeout = match object.get("timeout") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT,
        Some(value) => value
            .as_u64()
            .filter(|seconds| (1..=u64::from(MAX_TIMEOUT)).contains(seconds))
            .ok_or_else(|| {
                named("timeout must be a whole number of seconds from 1 to 600.".into())
            })? as u32,
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

pub const FIELDS: &[&str] = &["id", "title", "description", "html", "actions"];

/// Checks a chat's submission completely, before anything is saved.
pub fn definition(args: &Value) -> Result<Definition, String> {
    let object = args
        .as_object()
        .ok_or("Send title, html and optionally id, description and actions.")?;
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
    let title = line(object.get("title"), "title", MAX_TITLE, true)?;
    let description = line(
        object.get("description"),
        "description",
        MAX_DESCRIPTION,
        false,
    )?;
    let html = object
        .get("html")
        .and_then(Value::as_str)
        .filter(|html| !html.trim().is_empty())
        .ok_or("html must be the screen's complete HTML.")?;
    if html.len() > MAX_HTML || html.contains('\0') {
        return Err(format!("html must be at most {MAX_HTML} UTF-8 bytes."));
    }
    let actions = match object.get("actions") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(list)) => {
            if list.len() > MAX_ACTIONS {
                return Err(format!("A screen declares at most {MAX_ACTIONS} actions."));
            }
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
    Ok(Definition {
        id,
        title,
        description,
        html: html.into(),
        actions,
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
                let limit = param.max_length.map_or(DEFAULT_STRING, |n| n as usize);
                if text.chars().count() > limit {
                    return Err(format!("{name} must be at most {limit} characters."));
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
    if variables
        .iter()
        .map(|(name, value)| name.len() + value.len())
        .sum::<usize>()
        > MAX_ARGUMENTS
    {
        return Err(format!(
            "The values of one run must total at most {MAX_ARGUMENTS} bytes."
        ));
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
/// An update keeps where the screen runs, and keeps the user's approval while the actions
/// stay the same.
pub(crate) fn store(
    root: &Path,
    definition: Definition,
    site: Site,
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
                    site: previous.site.clone(),
                    conversation_id: previous.conversation_id.clone(),
                    run_id: run_id.into(),
                    created_at: previous.created_at.clone(),
                    updated_at: time,
                    approval: previous.approval.clone(),
                },
                false,
            )
        }
        None => {
            if all(root).len() >= MAX_SCREENS {
                return Err(format!(
                    "This computer already keeps {MAX_SCREENS} screens. Ask the user to delete one, or update an existing screen by its id."
                ));
            }
            (
                Screen {
                    id: uuid::Uuid::new_v4().to_string(),
                    revision: 1,
                    title: definition.title,
                    description: definition.description,
                    html: definition.html,
                    actions: definition.actions,
                    site,
                    conversation_id: conversation_id.into(),
                    run_id: run_id.into(),
                    created_at: time.clone(),
                    updated_at: time,
                    approval: None,
                },
                true,
            )
        }
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
pub struct Screens {
    changes: tokio::sync::Mutex<()>,
    running: tokio::sync::Semaphore,
}
impl Default for Screens {
    fn default() -> Self {
        Self {
            changes: tokio::sync::Mutex::new(()),
            running: tokio::sync::Semaphore::new(MAX_RUNNING),
        }
    }
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
    pub async fn handle(
        &self,
        root: PathBuf,
        namespace: String,
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
                let _turn = tokio::time::timeout(QUEUE_LIMIT, self.running.acquire())
                    .await
                    .map_err(|_| {
                        "Too many screen actions are running on this computer. Try again in a moment."
                            .to_string()
                    })?
                    .map_err(|_| "Screen actions are unavailable".to_string())?;
                let outcome =
                    run::execute(&root, &namespace, &screen.site, declared, variables).await?;
                encode(&outcome)
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
                encode(&Detail::from(&screen))
            }
            Request::Delete { id } => {
                let _change = self.changes.lock().await;
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
                if key.is_empty()
                    || key.chars().count() > MAX_KEY
                    || key.chars().any(|c| c.is_control())
                {
                    return Err(format!(
                        "A saved value needs a key of 1 to {MAX_KEY} characters."
                    ));
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
                    if bytes.len() > MAX_DATA {
                        return Err(format!(
                            "A screen keeps at most {MAX_DATA} bytes of saved values. Save less, or remove values it no longer needs."
                        ));
                    }
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

/// A window or another device reads this computer's screens or runs one of their actions.
/// `environmentId` only routes the request here.
#[tauri::command]
pub async fn manage_screen(
    app: tauri::AppHandle,
    screens: tauri::State<'_, std::sync::Arc<Screens>>,
    request: Request,
) -> Result<Value, String> {
    let root = root(&app)?;
    let namespace = app.config().identifier.clone();
    screens.handle(root, namespace, request).await
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
pub(crate) async fn saved(
    screens: &Screens,
    root: PathBuf,
    definition: Definition,
    site: Site,
    conversation_id: String,
    run_id: String,
) -> Result<(Screen, bool), String> {
    let _change = screens.changes.lock().await;
    blocking(move || store(&root, definition, site, &conversation_id, &run_id)).await
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

    #[test]
    fn a_submission_is_checked_whole_before_anything_is_saved() {
        let parsed = definition(&submission()).unwrap();
        assert_eq!(parsed.title, "My pull requests");
        assert_eq!(parsed.actions[0].timeout, 30);
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
        refuse(&|a| a["title"] = json!("x".repeat(81)), "at most 80");
        refuse(
            &|a| a["title"] = json!("safe\u{202e}txt"),
            "hidden character",
        );
        refuse(&|a| a["html"] = json!(""), "html must be");
        refuse(
            &|a| a["html"] = json!("x".repeat(MAX_HTML + 1)),
            "at most 512000",
        );
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
        refuse(
            &|a| a["actions"][0]["timeout"] = json!(601),
            "from 1 to 600",
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
        // Saved values stay with the screen, bounded.
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
            json!({"op": "save", "id": screen.id, "key": "big", "value": "x".repeat(MAX_DATA)}),
        )
        .await
        .unwrap_err();
        assert!(large.contains("at most"), "{large}");
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
}
