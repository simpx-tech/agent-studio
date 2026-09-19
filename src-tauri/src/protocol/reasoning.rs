//! Only provider-exposed parent reasoning text. Signatures, encrypted and redacted
//! payloads never enter the display channel or the answer/prompt text.
use super::RunEvent;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_ITEMS: usize = 64;
const MAX_TEXT: usize = 16000;

#[derive(Default)]
struct Parts {
    text: BTreeMap<usize, String>,
    truncated: bool,
}
impl Parts {
    fn update(&mut self, index: usize, text: &str, append: bool) {
        if index >= 64 {
            return;
        }
        let used: usize = self
            .text
            .iter()
            .filter(|(i, _)| **i != index)
            .map(|(_, s)| s.chars().count() + 2)
            .sum();
        let current = self.text.entry(index).or_default();
        let prefix = if append { current.as_str() } else { "" };
        let mut chars = prefix.chars().chain(text.chars());
        let next: String = chars.by_ref().take(MAX_TEXT.saturating_sub(used)).collect();
        self.truncated |= chars.next().is_some();
        *current = next;
    }
    fn joined(&self) -> String {
        self.text
            .values()
            .filter(|s| !s.is_empty())
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[derive(Default)]
struct Item {
    id: String,
    summary: Parts,
    content: Parts,
    text: String,
    truncated: bool,
    revision: u64,
}

#[derive(Default)]
pub struct ReasoningDecoder {
    items: Vec<Item>,
}
impl ReasoningDecoder {
    fn item(&mut self, id: &str) -> Option<&mut Item> {
        if id.is_empty() || id.len() > 240 || id.chars().any(char::is_control) {
            return None;
        }
        let index = if let Some(index) = self.items.iter().position(|i| i.id == id) {
            index
        } else {
            if self.items.len() >= MAX_ITEMS {
                return None;
            }
            self.items.push(Item {
                id: id.into(),
                ..Default::default()
            });
            self.items.len() - 1
        };
        Some(&mut self.items[index])
    }
    fn emit(item: &mut Item) -> Option<RunEvent> {
        // Prefer the summary if both forms are reported for the same Codex item.
        let summary = item.summary.joined();
        let (text, truncated) = if summary.is_empty() {
            (item.content.joined(), item.content.truncated)
        } else {
            (summary, item.summary.truncated)
        };
        if text.is_empty() || (text == item.text && truncated == item.truncated) {
            return None;
        }
        item.text = text;
        item.truncated = truncated;
        item.revision += 1;
        Some(RunEvent::Reasoning {
            id: item.id.clone(),
            revision: item.revision,
            text: item.text.clone(),
            truncated,
        })
    }
    pub fn text(&mut self, id: &str, text: &str, append: bool) -> Option<RunEvent> {
        let item = self.item(id)?;
        item.content.update(0, text, append);
        Self::emit(item)
    }
    pub fn codex_server(&mut self, value: &Value) -> Option<RunEvent> {
        let p = &value["params"];
        match value["method"].as_str()? {
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                let summary = value["method"] == "item/reasoning/summaryTextDelta";
                let index = p[if summary {
                    "summaryIndex"
                } else {
                    "contentIndex"
                }]
                .as_u64()?;
                if index >= 64 {
                    return None;
                }
                let delta = p["delta"].as_str()?;
                let item = self.item(p["itemId"].as_str()?)?;
                let parts = if summary {
                    &mut item.summary
                } else {
                    &mut item.content
                };
                parts.update(index as usize, delta, true);
                Self::emit(item)
            }
            "item/started" | "item/completed" if p["item"]["type"] == "reasoning" => {
                let source = &p["item"];
                let item = self.item(source["id"].as_str()?)?;
                for (key, parts) in [
                    ("summary", &mut item.summary),
                    ("content", &mut item.content),
                ] {
                    if let Some(values) = source[key].as_array() {
                        for (index, text) in values.iter().take(64).enumerate() {
                            if let Some(text) = text.as_str() {
                                parts.update(index, text, false);
                            }
                        }
                    }
                }
                Self::emit(item)
            }
            _ => None,
        }
    }
    pub fn claude(&mut self, value: &Value, current_message: &str) -> Vec<RunEvent> {
        let mut events = Vec::new();
        match value["type"].as_str() {
            Some("stream_event") => {
                let event = &value["event"];
                let Some(index) = event["index"].as_u64().filter(|i| *i < 256) else {
                    return events;
                };
                let id = format!("{current_message}:{index}");
                let update = match event["type"].as_str() {
                    Some("content_block_start") if event["content_block"]["type"] == "thinking" => {
                        event["content_block"]["thinking"]
                            .as_str()
                            .map(|s| (s, false))
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "thinking_delta" => {
                        event["delta"]["thinking"].as_str().map(|s| (s, true))
                    }
                    _ => None,
                };
                if let Some((text, append)) = update {
                    events.extend(self.text(&id, text, append));
                }
            }
            Some("assistant") => {
                let id = value["message"]["id"].as_str().unwrap_or(current_message);
                if let Some(blocks) = value["message"]["content"].as_array() {
                    for (index, block) in blocks.iter().take(256).enumerate() {
                        if block["type"] == "thinking" {
                            if let Some(text) = block["thinking"].as_str() {
                                events.extend(self.text(&format!("{id}:{index}"), text, false));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        events
    }
}
