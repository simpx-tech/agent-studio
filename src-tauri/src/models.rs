use crate::providers::resolve;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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
pub async fn catalog() -> BTreeMap<String, Vec<ModelInfo>> {
    let (codex, gemini) = tokio::join!(codex_models(), gemini_models());
    let mut claude = vec![automatic()];
    // Documented Claude Code aliases; their availability is enforced by its CLI.
    for (id, name) in [
        ("opus", "Opus"),
        ("sonnet", "Sonnet"),
        ("fable", "Fable"),
        ("haiku", "Haiku"),
    ] {
        claude.push(ModelInfo {
            id: id.into(),
            name: format!("{name} (latest)"),
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
    BTreeMap::from([
        ("codex".into(), codex.unwrap_or_else(|| vec![automatic()])),
        ("claude".into(), claude),
        (
            "gemini".into(),
            gemini.unwrap_or_else(|| {
                parse_gemini("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)")
            }),
        ),
    ])
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
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        resolve("gemini")
            .await
            .ok()?
            .command()
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
}
