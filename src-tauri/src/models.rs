use crate::providers::resolve;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// Claude Code's documented aliases. The selected CLI decides which model each one means.
const CLAUDE_ALIASES: [(&str, &str); 4] = [
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("fable", "Fable"),
    ("haiku", "Haiku"),
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
    reasoning_levels: Vec<String>,
    default_reasoning: String,
    context_window: Option<u64>,
    context_source: Option<String>,
}
fn automatic() -> ModelInfo {
    ModelInfo {
        id: String::new(),
        name: "CLI default".into(),
        reasoning_levels: vec![],
        default_reasoning: String::new(),
        context_window: None,
        context_source: None,
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
        None => BTreeMap::new(),
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
fn claude_models(resolved: &BTreeMap<String, String>) -> Vec<ModelInfo> {
    let mut models = vec![automatic()];
    for (id, family) in CLAUDE_ALIASES {
        models.push(ModelInfo {
            id: id.into(),
            name: resolved
                .get(id)
                .map_or_else(|| family.into(), |model| claude_name(model)),
            reasoning_levels: if id == "haiku" {
                vec![]
            } else {
                ["low", "medium", "high", "xhigh", "max"]
                    .map(String::from)
                    .to_vec()
            },
            default_reasoning: String::new(),
            context_window: None,
            context_source: None,
        });
    }
    models
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
/// neutral folder as usage readings; alias resolution needs no sign-in.
async fn claude_aliases(directory: &Path) -> Option<BTreeMap<String, String>> {
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
        ])
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let result = match (child.stdin.take(), child.stdout.take()) {
        (Some(mut input), Some(output)) => tokio::time::timeout(
            Duration::from_secs(20),
            resolve_aliases(&mut input, BufReader::new(output)),
        )
        .await
        .ok()
        .flatten(),
        _ => None,
    };
    exe.kill(&mut child).await;
    result
}
#[derive(Clone, Copy)]
enum Ask {
    Initialize,
    Select,
    Read,
}
/// One control request at a time, each answered before the next: `set_model`, then a context
/// summary that reports the selected model. An alias the CLI refuses stays unresolved; a
/// refused `initialize` ends the query.
async fn resolve_aliases(
    input: &mut (impl AsyncWrite + Unpin),
    output: impl AsyncBufRead + Unpin,
) -> Option<BTreeMap<String, String>> {
    let mut lines = output.lines();
    let mut aliases = CLAUDE_ALIASES.iter().map(|(alias, _)| *alias);
    let mut resolved = BTreeMap::new();
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
            if line.len() > 2_000_000 {
                return None;
            }
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
            Ask::Select if answered => {
                ask = Ask::Read;
                continue;
            }
            Ask::Read if answered => {
                if let Some(model) = response["response"]["model"]
                    .as_str()
                    .filter(|m| !m.is_empty() && m.len() <= 200 && !m.contains(char::is_control))
                {
                    resolved.insert(alias.to_string(), model.to_string());
                }
            }
            _ => {}
        }
        let Some(next) = aliases.next() else {
            return Some(resolved);
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
        if model["isDefault"] == true {
            models[0].name = format!(
                "CLI default · {}",
                model["displayName"].as_str().unwrap_or(id)
            );
            models[0].reasoning_levels = levels.clone();
            models[0].context_window = context_window;
            models[0].context_source = context_source.clone();
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
        if std::fs::metadata(&path).ok()?.len() > 10_000_000 {
            return None;
        }
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
        while let Some(line) = lines.next_line().await.ok()? {
            if line.len() > 2_000_000 {
                return None;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["error"].is_object() {
                return None;
            }
            if value["id"] == 1 {
                let request = json!({"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}});
                input
                    .write_all(format!("{{\"method\":\"initialized\"}}\n{request}\n").as_bytes())
                    .await
                    .ok()?;
            } else if value["id"] == 2 {
                data.extend(value["result"]["data"].as_array()?.iter().cloned());
                if let Some(cursor) = value["result"]["nextCursor"].as_str() {
                    if data.len() > 500 {
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
    let result = tokio::time::timeout(Duration::from_secs(20), query)
        .await
        .ok()
        .flatten();
    exe.kill(&mut child).await;
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
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        exe.command()
            .arg("models")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .ok()?
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
    }
    #[test]
    fn claude_aliases_name_the_resolved_model_and_never_promise_the_latest() {
        let names = |resolved: &[(&str, &str)]| {
            let resolved = resolved
                .iter()
                .map(|(alias, model)| (alias.to_string(), model.to_string()))
                .collect();
            claude_models(&resolved)
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
                let response = if refused {
                    json!({"subtype":"error","request_id":id,"error":"refused"})
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
        let resolved = resolve_aliases(&mut write, BufReader::new(read))
            .await
            .unwrap();
        write.shutdown().await.unwrap();
        assert_eq!(
            resolved.into_iter().collect::<Vec<_>>(),
            [
                ("haiku", "claude-haiku-5"),
                ("opus", "claude-opus-5"),
                ("sonnet", "claude-sonnet-5")
            ]
            .map(|(alias, model)| (alias.to_string(), model.to_string()))
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
        assert_eq!(names[0], "CLI default");
        for (name, (_, family)) in names[1..].iter().zip(CLAUDE_ALIASES) {
            let version = name.strip_prefix(family).and_then(|v| v.strip_prefix(' '));
            assert!(version.is_some_and(|v| !v.is_empty()), "{names:?}");
        }
    }
}
