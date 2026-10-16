use crate::providers::resolve;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    process::Stdio,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// Claude Code's documented aliases. The selected CLI decides which model each one means.
const CLAUDE_ALIASES: [(&str, &str); 4] = [
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("fable", "Fable"),
    ("haiku", "Haiku"),
];

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
    reasoning_levels: Vec<String>,
    default_reasoning: String,
    context_window: Option<u64>,
    context_source: Option<String>,
    /// The model offers Fast mode: Claude's `supportsFastMode`, or a Fast service tier of Codex.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    fast_mode: bool,
    /// What the CLI says Fast mode gives this model, such as Codex's "2x speed, increased usage".
    #[serde(skip_serializing_if = "Option::is_none")]
    fast_mode_detail: Option<String>,
    /// Why Claude says Fast mode cannot serve this account (`FAST_MODE_BLOCKS`).
    #[serde(skip_serializing_if = "Option::is_none")]
    fast_mode_blocked: Option<String>,
}
fn automatic() -> ModelInfo {
    ModelInfo {
        name: "CLI default".into(),
        ..ModelInfo::default()
    }
}
/// `runtime` is the neutral folder Claude's alias query runs in; without it the aliases keep
/// their family names.
pub async fn catalog(provider: &str, runtime: Option<&Path>) -> BTreeMap<String, Vec<ModelInfo>> {
    // A catalog request belongs to one exact provider/profile. Do not start a
    // different provider's CLI (and potentially its interactive login fallback).
    let codex = if provider == "codex" {
        codex_models().await
    } else {
        None
    };
    let gemini = if provider == "gemini" {
        gemini_models().await
    } else {
        None
    };
    let aliases = match runtime.filter(|_| provider == "claude") {
        Some(runtime) => claude_aliases(runtime).await.unwrap_or_default(),
        None => ClaudeCatalog::default(),
    };
    BTreeMap::from([
        ("codex".into(), codex.unwrap_or_else(|| vec![automatic()])),
        ("claude".into(), claude_models(&aliases)),
        (
            "gemini".into(),
            gemini.unwrap_or_else(|| {
                parse_gemini("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)")
            }),
        ),
    ])
}
/// Each alias is named for the model the selected CLI resolves it to. An older CLI maps
/// `opus` to an older Opus, so no name may promise the newest one; an alias the CLI did not
/// resolve keeps its family name. Availability is still enforced by the CLI.
fn claude_models(catalog: &ClaudeCatalog) -> Vec<ModelInfo> {
    let fast = |alias: &str| ModelInfo {
        fast_mode: catalog.fast_mode(alias),
        fast_mode_blocked: catalog
            .fast_mode(alias)
            .then(|| catalog.fast.blocked.clone())
            .flatten(),
        ..ModelInfo::default()
    };
    let mut models = vec![ModelInfo {
        name: "CLI default".into(),
        ..fast("")
    }];
    for (id, family) in CLAUDE_ALIASES {
        models.push(ModelInfo {
            id: id.into(),
            name: catalog
                .resolved
                .get(id)
                .map_or_else(|| family.into(), |model| claude_name(model)),
            reasoning_levels: if id == "haiku" {
                vec![]
            } else {
                ["low", "medium", "high", "xhigh", "max"]
                    .map(String::from)
                    .to_vec()
            },
            ..fast(id)
        });
    }
    models
}
/// The reasons Claude Code gives for Fast mode that last until the account changes: no paid
/// plan, an organization that turned it off, no usage credits. A network failure or a check
/// still under way says nothing about the account.
const FAST_MODE_BLOCKS: [&str; 3] = ["free", "preference", "extra_usage_disabled"];
/// What the selected Claude CLI reports about its aliases: the model each one means, and which
/// models have Fast mode.
#[derive(Default)]
struct ClaudeCatalog {
    resolved: BTreeMap<String, String>,
    fast: FastModes,
}
impl ClaudeCatalog {
    /// Whether the alias (`""` for the CLI default) means a model with Fast mode.
    fn fast_mode(&self, alias: &str) -> bool {
        if alias.is_empty() {
            return self.fast.values.contains("default");
        }
        self.fast.values.contains(alias)
            || self
                .resolved
                .get(alias)
                .is_some_and(|model| self.fast.models.contains(without_context(model)))
    }
}
/// The models Claude Code's `initialize` answer lists with `supportsFastMode`, by choice
/// (`value`: an alias, `default` or an ID) and by the model it means (`resolvedModel`), and why
/// Fast mode cannot serve the account (`fast_mode_disabled_reason`), which the query asks about
/// by opting in as a chat does.
#[derive(Default)]
struct FastModes {
    values: HashSet<String>,
    models: HashSet<String>,
    blocked: Option<String>,
}
impl FastModes {
    fn read(answer: &Value) -> Self {
        let mut fast = FastModes::default();
        for model in answer["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|model| model["supportsFastMode"] == true)
        {
            if let Some(value) = model["value"].as_str() {
                fast.values.insert(without_context(value).to_string());
            }
            if let Some(resolved) = model["resolvedModel"].as_str() {
                fast.models.insert(without_context(resolved).to_string());
            }
        }
        fast.blocked = answer["fast_mode_disabled_reason"]
            .as_str()
            .filter(|reason| FAST_MODE_BLOCKS.contains(reason))
            .map(String::from);
        fast
    }
}
/// `claude-fable-5-1[1m]` is the same model as `claude-fable-5-1`.
fn without_context(model: &str) -> &str {
    model.strip_suffix("[1m]").unwrap_or(model)
}
/// `claude-opus-5-5` reads as Opus 5.5 and `claude-haiku-4-5-20251001` as Haiku 4.5, without
/// a provider prefix (`us.anthropic.`), snapshot date or context suffix (`[1m]`). Any other
/// ID, such as a gateway's own model, keeps its spelling. `formatModelName` in
/// `src/lib/replies.ts` names reported models the same way.
fn claude_name(model: &str) -> String {
    let named = || {
        let base = model.split(['[', '@', ':']).next()?;
        let mut parts: Vec<&str> = base[base.find("claude-")? + "claude-".len()..]
            .split('-')
            .collect();
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        if parts
            .last()
            .is_some_and(|part| part.len() == 8 && digits(part))
        {
            parts.pop();
        }
        let (family, version) = parts.split_first()?;
        let valid = !family.is_empty()
            && family.bytes().all(|b| b.is_ascii_lowercase())
            && !version.is_empty()
            && version.iter().all(|part| part.len() <= 2 && digits(part));
        valid.then(|| {
            format!(
                "{}{} {}",
                family[..1].to_ascii_uppercase(),
                &family[1..],
                version.join(".")
            )
        })
    };
    named().unwrap_or_else(|| model.into())
}
/// Asks the selected Claude CLI which model each alias means, the way a chat selects one.
/// One process answers every alias without a prompt, tools or customizations, in the same
/// neutral folder as usage readings; alias resolution needs no sign-in. It opts in to Fast
/// mode as a chat with Fast mode on does, so the CLI says whether the account can use it.
async fn claude_aliases(directory: &Path) -> Option<ClaudeCatalog> {
    std::fs::create_dir_all(directory).ok()?;
    let exe = resolve("claude").await.ok()?;
    let mut child = exe
        .command()
        .current_dir(directory)
        .args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--safe-mode",
            "--strict-mcp-config",
            "--tools",
            "",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
            "--settings",
            &json!({crate::retention::KEY: crate::retention::DAYS, "fastMode": true}).to_string(),
        ])
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let (Some(mut input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
        exe.kill(&mut child).await;
        return None;
    };
    let mut output = BufReader::new(output);
    let result = resolve_aliases(&mut input, &mut output).await;
    // The CLI started renewing an expired login as it started, which this query never waits for.
    exe.finish(child, Some(input), Some(Box::new(output)));
    result
}
#[derive(Clone, Copy)]
enum Ask {
    Initialize,
    Select,
    Read,
}
/// One control request at a time, each answered before the next: `initialize`, whose answer
/// lists the models with Fast mode, then for each alias `set_model` and a context summary that
/// reports the selected model. An alias the CLI refuses stays unresolved; a refused
/// `initialize` ends the query.
async fn resolve_aliases(
    input: &mut (impl AsyncWrite + Unpin),
    output: impl AsyncBufRead + Unpin,
) -> Option<ClaudeCatalog> {
    let mut lines = output.lines();
    let mut aliases = CLAUDE_ALIASES.iter().map(|(alias, _)| *alias);
    let mut catalog = ClaudeCatalog::default();
    let (mut ask, mut alias) = (Ask::Initialize, "");
    loop {
        let (id, request) = match ask {
            Ask::Initialize => ("init".to_string(), json!({"subtype":"initialize"})),
            Ask::Select => (
                format!("model:{alias}"),
                json!({"subtype":"set_model","model":alias}),
            ),
            Ask::Read => (
                format!("context:{alias}"),
                json!({"subtype":"get_context_usage","detail":"summary"}),
            ),
        };
        let line = json!({"type":"control_request","request_id":id,"request":request});
        input.write_all(format!("{line}\n").as_bytes()).await.ok()?;
        let response = loop {
            let line = lines.next_line().await.ok()??;
            let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["type"] == "control_response" && value["response"]["request_id"] == id {
                break value["response"].take();
            }
        };
        let answered = response["subtype"] == "success";
        match ask {
            Ask::Initialize if !answered => return None,
            Ask::Initialize => catalog.fast = FastModes::read(&response["response"]),
            Ask::Select if answered => {
                ask = Ask::Read;
                continue;
            }
            Ask::Read if answered => {
                if let Some(model) = response["response"]["model"]
                    .as_str()
                    .filter(|m| !m.is_empty() && !m.contains(char::is_control))
                {
                    catalog
                        .resolved
                        .insert(alias.to_string(), model.to_string());
                }
            }
            _ => {}
        }
        let Some(next) = aliases.next() else {
            return Some(catalog);
        };
        (ask, alias) = (Ask::Select, next);
    }
}
fn parse_codex(data: &[Value], local: bool) -> Vec<ModelInfo> {
    let mut models = vec![automatic()];
    let capacities = if local {
        codex_contexts()
    } else {
        BTreeMap::new()
    };
    for model in data {
        let Some(id) = model["model"].as_str() else {
            continue;
        };
        let levels: Vec<String> = model["supportedReasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|level| level["reasoningEffort"].as_str().map(String::from))
            .collect();
        let context_window = capacities.get(id).copied();
        let context_source =
            context_window.map(|_| "Codex CLI model metadata (effective window)".to_string());
        // Fast mode is the model's Fast service tier (`priority`, which the CLI also takes as
        // `fast`), or `fast` among the extra speeds older CLIs list.
        let tier = model["serviceTiers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|tier| {
                matches!(tier["id"].as_str(), Some("priority" | "fast"))
                    || tier["name"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case("fast"))
            });
        let fast_mode = tier.is_some()
            || model["additionalSpeedTiers"]
                .as_array()
                .is_some_and(|tiers| tiers.iter().any(|tier| tier == "fast"));
        let fast_mode_detail = tier
            .and_then(|tier| tier["description"].as_str())
            .map(str::trim)
            .filter(|text| !text.is_empty() && !text.contains(char::is_control))
            .map(String::from);
        if model["isDefault"] == true {
            models[0].name = format!(
                "CLI default · {}",
                model["displayName"].as_str().unwrap_or(id)
            );
            models[0].reasoning_levels = levels.clone();
            models[0].context_window = context_window;
            models[0].context_source = context_source.clone();
            models[0].fast_mode = fast_mode;
            models[0].fast_mode_detail = fast_mode_detail.clone();
        }
        models.push(ModelInfo {
            id: id.into(),
            name: model["displayName"].as_str().unwrap_or(id).into(),
            reasoning_levels: levels,
            default_reasoning: model["defaultReasoningEffort"]
                .as_str()
                .unwrap_or("")
                .into(),
            context_window,
            context_source,
            fast_mode,
            fast_mode_detail,
            fast_mode_blocked: None,
        });
    }
    models
}
fn codex_contexts() -> BTreeMap<String, u64> {
    let load = || -> Option<BTreeMap<String, u64>> {
        // Public model metadata maintained by the CLI; never inspect auth/config files.
        let root = crate::profiles::current()
            .root
            .filter(|_| crate::profiles::current().provider == "codex")
            .or_else(|| {
                std::env::var_os("CODEX_HOME")
                    .map(std::path::PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("USERPROFILE")
                            .or_else(|| std::env::var_os("HOME"))
                            .map(|p| std::path::PathBuf::from(p).join(".codex"))
                    })
            })?;
        let path = root.join("models_cache.json");
        let data: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        Some(
            data["models"]
                .as_array()?
                .iter()
                .filter_map(|entry| {
                    let raw = entry["context_window"].as_u64().filter(|n| *n > 0)?;
                    let percent = entry["effective_context_window_percent"]
                        .as_u64()
                        .filter(|n| *n > 0 && *n <= 100)
                        .unwrap_or(100);
                    Some((
                        entry["slug"].as_str()?.to_string(),
                        raw.checked_mul(percent)? / 100,
                    ))
                })
                .collect(),
        )
    };
    load().unwrap_or_default()
}
async fn codex_models() -> Option<Vec<ModelInfo>> {
    let exe = resolve("codex").await.ok()?;
    // A separate WSL profile signs in with its account's Windows login before listing models.
    let login = match crate::lending::codex_lender() {
        Some(lender) => Some(crate::lending::codex_login(&lender, false).await.ok()?),
        None => None,
    };
    let mut child = exe
        .command()
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut input = child.stdin.take()?;
    let mut lines = BufReader::new(child.stdout.take()?).lines();
    let query = async {
        let request = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agent_studio","version":"0.1.0"}}});
        input
            .write_all(format!("{request}\n").as_bytes())
            .await
            .ok()?;
        let mut data = vec![];
        let mut cursors = HashSet::new();
        while let Some(line) = lines.next_line().await.ok()? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["error"].is_object() {
                return None;
            }
            let list =
                json!({"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}});
            if value["id"] == 1 {
                let request = match &login {
                    Some(login) => json!({"id":3,"method":"account/login/start","params":login}),
                    None => list,
                };
                input
                    .write_all(format!("{{\"method\":\"initialized\"}}\n{request}\n").as_bytes())
                    .await
                    .ok()?;
            } else if value["id"] == 3 {
                input.write_all(format!("{list}\n").as_bytes()).await.ok()?;
            } else if value["id"] == 2 {
                data.extend(value["result"]["data"].as_array()?.iter().cloned());
                // Every page; a cursor that repeats would never end.
                if let Some(cursor) = value["result"]["nextCursor"].as_str() {
                    if !cursors.insert(cursor.to_string()) {
                        return None;
                    }
                    let request = json!({"id":2,"method":"model/list","params":{"cursor":cursor,"limit":100,"includeHidden":false}});
                    input
                        .write_all(format!("{request}\n").as_bytes())
                        .await
                        .ok()?;
                } else {
                    return Some(parse_codex(&data, exe.wsl.is_none()));
                }
            }
        }
        None
    };
    let result = query.await;
    exe.finish(child, Some(input), Some(Box::new(lines.into_inner())));
    result
}
fn parse_gemini(text: &str) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = vec![];
    for line in text.lines() {
        let Some((slug, name)) = line.split_once('\t') else {
            continue;
        };
        if !slug.starts_with("gemini-") {
            continue;
        }
        let Some((base, effort)) = slug.rsplit_once('-') else {
            continue;
        };
        if !["low", "medium", "high"].contains(&effort) {
            continue;
        }
        let index = models
            .iter()
            .position(|model| model.id == base)
            .unwrap_or_else(|| {
                models.push(ModelInfo {
                    id: base.into(),
                    name: name
                        .rsplit_once(" (")
                        .map(|(name, _)| name)
                        .unwrap_or(name)
                        .into(),
                    reasoning_levels: vec![],
                    default_reasoning: effort.into(),
                    context_window: if matches!(
                        base,
                        "gemini-3.8-flash"
                            | "gemini-3.7-flash"
                            | "gemini-3.6-flash"
                            | "gemini-3.1-pro"
                    ) {
                        Some(1_048_576)
                    } else {
                        None
                    },
                    context_source: if matches!(
                        base,
                        "gemini-3.8-flash"
                            | "gemini-3.7-flash"
                            | "gemini-3.6-flash"
                            | "gemini-3.1-pro"
                    ) {
                        Some("Published Gemini input limit".into())
                    } else {
                        None
                    },
                    ..ModelInfo::default()
                });
                models.len() - 1
            });
        if !models[index]
            .reasoning_levels
            .iter()
            .any(|level| level == effort)
        {
            models[index].reasoning_levels.push(effort.into());
        }
        if effort == "medium" {
            models[index].default_reasoning = effort.into();
        }
    }
    for model in &mut models {
        model.reasoning_levels.sort_by_key(|level| {
            ["low", "medium", "high"]
                .iter()
                .position(|v| v == level)
                .unwrap_or(3)
        });
    }
    models
}
async fn gemini_models() -> Option<Vec<ModelInfo>> {
    let exe = resolve("gemini").await.ok()?;
    crate::providers::require_gemini_login(&exe, &tokio_util::sync::CancellationToken::new())
        .await
        .ok()?;
    let output = exe
        .command()
        .arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let models = parse_gemini(&String::from_utf8_lossy(&output.stdout));
    (!models.is_empty()).then_some(models)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gemini_groups_only_advertised_efforts_by_model() {
        let models = parse_gemini("Fetching...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gemini-3.8-flash");
        assert_eq!(models[0].reasoning_levels, ["low", "medium", "high"]);
        assert_eq!(models[0].default_reasoning, "medium");
        assert_eq!(models[1].reasoning_levels, ["high"]);
    }
    #[test]
    fn codex_keeps_per_model_capabilities() {
        let models = parse_codex(
            &[
                json!({"model":"test-model","displayName":"Test","isDefault":true,"defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}),
            ],
            true,
        );
        assert_eq!(models[1].reasoning_levels, ["low", "high"]);
        assert_eq!(models[0].reasoning_levels, models[1].reasoning_levels);
        assert_eq!(models[1].default_reasoning, "low");
        assert!(!models[1].fast_mode);
    }
    #[test]
    fn codex_models_with_a_fast_tier_offer_fast_mode() {
        // Codex 0.163.0 lists each model's tiers; older CLIs list `fast` among extra speeds.
        let models = parse_codex(
            &[
                json!({"model":"sol","isDefault":true,"serviceTiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"}],"additionalSpeedTiers":["fast"]}),
                json!({"model":"luna","serviceTiers":[{"id":"ultrafast","name":"Ultrafast","description":"Fastest"},{"id":"fast","name":"Speedy","description":" 1.5x speed "}]}),
                json!({"model":"noisy","serviceTiers":[{"id":"other","name":"FAST","description":"1.5x\u{7}speed"}]}),
                json!({"model":"older","additionalSpeedTiers":["fast"]}),
                json!({"model":"plain","serviceTiers":[{"id":"ultrafast","name":"Ultrafast"}],"additionalSpeedTiers":["flex"]}),
            ],
            false,
        );
        let fast: Vec<_> = models
            .iter()
            .map(|m| (m.id.as_str(), m.fast_mode, m.fast_mode_detail.as_deref()))
            .collect();
        assert_eq!(
            fast,
            [
                ("", true, Some("2x speed, increased usage")),
                ("sol", true, Some("2x speed, increased usage")),
                ("luna", true, Some("1.5x speed")),
                ("noisy", true, None),
                ("older", true, None),
                ("plain", false, None),
            ]
        );
        let json = serde_json::to_value(&models).unwrap();
        assert_eq!(json[1]["fastMode"], true);
        assert_eq!(json[1]["fastModeDetail"], "2x speed, increased usage");
        assert!(json[5].get("fastMode").is_none() && json[5].get("fastModeDetail").is_none());
        assert!(json
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m.get("fastModeBlocked").is_none()));
    }
    #[test]
    fn claude_aliases_name_the_resolved_model_and_never_promise_the_latest() {
        let names = |resolved: &[(&str, &str)]| {
            let resolved = resolved
                .iter()
                .map(|(alias, model)| (alias.to_string(), model.to_string()))
                .collect();
            claude_models(&ClaudeCatalog {
                resolved,
                ..ClaudeCatalog::default()
            })
            .into_iter()
            .map(|model| (model.id, model.name))
            .collect::<Vec<_>>()
        };
        let unresolved = names(&[]);
        assert_eq!(
            unresolved,
            [
                ("", "CLI default"),
                ("opus", "Opus"),
                ("sonnet", "Sonnet"),
                ("fable", "Fable"),
                ("haiku", "Haiku")
            ]
            .map(|(id, name)| (id.to_string(), name.to_string()))
        );
        // Claude Code 2.1.278 resolved `opus` to Opus 5; 2.1.281 resolves it to Opus 5.5.
        let older = names(&[
            ("opus", "claude-opus-5"),
            ("sonnet", "claude-sonnet-5"),
            ("fable", "claude-fable-5-1"),
            ("haiku", "claude-haiku-4-5-20251001"),
        ]);
        let older: Vec<_> = older.iter().map(|(_, name)| name.as_str()).collect();
        assert_eq!(
            older,
            [
                "CLI default",
                "Opus 5",
                "Sonnet 5",
                "Fable 5.1",
                "Haiku 4.5"
            ]
        );
        assert_eq!(names(&[("opus", "claude-opus-5-5")])[1].1, "Opus 5.5");
        for (id, name) in [
            ("claude-opus-5-5[1m]", "Opus 5.5"),
            ("us.anthropic.claude-opus-5-5", "Opus 5.5"),
            ("claude-sonnet-4-5@20250929", "Sonnet 4.5"),
            ("claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022"),
            ("claude-sonnet-20250929", "claude-sonnet-20250929"),
            ("claude-", "claude-"),
            ("gateway-large", "gateway-large"),
        ] {
            assert_eq!(claude_name(id), name, "{id}");
        }
    }
    #[test]
    fn only_lasting_reasons_block_claude_fast_mode() {
        for (reason, blocked) in [
            ("extra_usage_disabled", true),
            ("free", true),
            ("preference", true),
            ("network_error", false),
            ("pending", false),
            ("unknown", false),
            ("sdk_opt_in_required", false),
            ("model_not_allowed", false),
        ] {
            let fast = FastModes::read(&json!({"fast_mode_disabled_reason":reason}));
            assert_eq!(fast.blocked.is_some(), blocked, "{reason}");
        }
        // An older CLI lists no models and gives no reason.
        let fast = FastModes::read(&json!({"commands":[]}));
        assert!(fast.values.is_empty() && fast.models.is_empty() && fast.blocked.is_none());
    }
    #[tokio::test]
    async fn claude_aliases_resolve_one_answered_request_at_a_time() {
        // A scripted CLI: every answer follows unrelated output and a foreign response,
        // `fable` is refused, and each context summary reports the selected model.
        async fn cli(stream: tokio::io::DuplexStream, refuse_initialize: bool) -> Vec<String> {
            let (read, mut write) = tokio::io::split(stream);
            let mut requests = BufReader::new(read).lines();
            let (mut seen, mut model) = (vec![], String::new());
            while let Ok(Some(line)) = requests.next_line().await {
                let value: Value = serde_json::from_str(&line).unwrap();
                let (id, request) = (value["request_id"].clone(), &value["request"]);
                seen.push(id.as_str().unwrap().to_string());
                let refused = (refuse_initialize && request["subtype"] == "initialize")
                    || request["model"] == "fable";
                if request["subtype"] == "set_model" && !refused {
                    model = format!("claude-{}-5", request["model"].as_str().unwrap());
                }
                // Claude Code 2.1.301 lists `fable` by its ID, with the 1M context suffix.
                let response = if refused {
                    json!({"subtype":"error","request_id":id,"error":"refused"})
                } else if request["subtype"] == "initialize" {
                    json!({"subtype":"success","request_id":id,"response":{"models":[
                        {"value":"default","resolvedModel":"claude-opus-5","supportsFastMode":true},
                        {"value":"opus","resolvedModel":"claude-opus-5","supportsFastMode":true},
                        {"value":"claude-sonnet-5[1m]","resolvedModel":"claude-sonnet-5","supportsFastMode":true},
                        {"value":"haiku","resolvedModel":"claude-haiku-5"},
                        {"value":"fable","resolvedModel":"claude-fable-5","supportsFastMode":false}
                    ],"fast_mode_state":"off","fast_mode_disabled_reason":"extra_usage_disabled"}})
                } else {
                    json!({"subtype":"success","request_id":id,"response":{"model":model}})
                };
                let noise = json!({"type":"system","subtype":"status"});
                let foreign = json!({"type":"control_response","response":{"subtype":"success","request_id":"other","response":{"model":"foreign"}}});
                let answer = json!({"type":"control_response","response":response});
                write
                    .write_all(format!("{noise}\n{foreign}\n{answer}\n").as_bytes())
                    .await
                    .unwrap();
            }
            seen
        }
        let (app, peer) = tokio::io::duplex(64 * 1024);
        let script = tokio::spawn(cli(peer, false));
        let (read, mut write) = tokio::io::split(app);
        let catalog = resolve_aliases(&mut write, BufReader::new(read))
            .await
            .unwrap();
        write.shutdown().await.unwrap();
        assert_eq!(
            catalog.resolved.clone().into_iter().collect::<Vec<_>>(),
            [
                ("haiku", "claude-haiku-5"),
                ("opus", "claude-opus-5"),
                ("sonnet", "claude-sonnet-5")
            ]
            .map(|(alias, model)| (alias.to_string(), model.to_string()))
        );
        // Fast mode follows the model an alias means, and the account's lasting block goes
        // with every model that has it.
        let fast: Vec<_> = claude_models(&catalog)
            .into_iter()
            .map(|m| (m.id, m.fast_mode, m.fast_mode_blocked))
            .collect();
        let blocked = || Some("extra_usage_disabled".to_string());
        assert_eq!(
            fast,
            [
                (String::new(), true, blocked()),
                ("opus".into(), true, blocked()),
                ("sonnet".into(), true, blocked()),
                ("fable".into(), false, None),
                ("haiku".into(), false, None),
            ]
        );
        assert_eq!(
            script.await.unwrap(),
            [
                "init",
                "model:opus",
                "context:opus",
                "model:sonnet",
                "context:sonnet",
                "model:fable",
                "model:haiku",
                "context:haiku"
            ],
            "a refused alias is never read back"
        );
        let (app, peer) = tokio::io::duplex(64 * 1024);
        let script = tokio::spawn(cli(peer, true));
        let (read, mut write) = tokio::io::split(app);
        assert!(resolve_aliases(&mut write, BufReader::new(read))
            .await
            .is_none());
        write.shutdown().await.unwrap();
        assert_eq!(script.await.unwrap(), ["init"]);
        // A CLI that exits before answering resolves nothing.
        let (app, peer) = tokio::io::duplex(1024);
        drop(peer);
        let (read, mut write) = tokio::io::split(app);
        assert!(resolve_aliases(&mut write, BufReader::new(read))
            .await
            .is_none());
    }
    #[tokio::test]
    #[ignore = "Opt-in installed Claude CLI test; starts the CLI but sends no prompt."]
    async fn installed_claude_names_each_alias_for_its_model() {
        let runtime = tempfile::tempdir().unwrap();
        let catalog = catalog("claude", Some(runtime.path())).await;
        let names: Vec<_> = catalog["claude"].iter().map(|m| m.name.as_str()).collect();
        println!("{names:?}");
        for model in &catalog["claude"] {
            println!(
                "{:?}: fast mode {} {:?}",
                model.id, model.fast_mode, model.fast_mode_blocked
            );
        }
        assert_eq!(names[0], "CLI default");
        for (name, (_, family)) in names[1..].iter().zip(CLAUDE_ALIASES) {
            let version = name.strip_prefix(family).and_then(|v| v.strip_prefix(' '));
            assert!(version.is_some_and(|v| !v.is_empty()), "{names:?}");
        }
    }
}
