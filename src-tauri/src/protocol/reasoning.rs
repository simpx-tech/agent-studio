//! Only provider-exposed parent reasoning text. Signatures, encrypted and redacted
//! payloads never enter the display channel or the answer/prompt text.
use super::RunEvent;
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

const MAX_ITEMS: usize = 64;
const MAX_TEXT: usize = 16000;
/// Claude messages remembered while their snapshot lines arrive.
const RECENT_MESSAGES: usize = 8;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 240 && !id.chars().any(char::is_control)
}

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
    /// Claude messages whose thinking arrived as partial stream events.
    streamed: VecDeque<String>,
    /// Content blocks already printed in each Claude message's snapshot lines.
    printed: VecDeque<(String, usize)>,
}
impl ReasoningDecoder {
    /// Only reported text reserves one of the bounded items; an empty start does not.
    fn item(&mut self, id: &str, create: bool) -> Option<&mut Item> {
        if !valid_id(id) {
            return None;
        }
        let index = if let Some(index) = self.items.iter().position(|i| i.id == id) {
            index
        } else {
            if !create || self.items.len() >= MAX_ITEMS {
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
        let item = self.item(id, !text.is_empty())?;
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
                let item = self.item(p["itemId"].as_str()?, !delta.is_empty())?;
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
                let reported = ["summary", "content"].iter().any(|key| {
                    source[*key].as_array().is_some_and(|values| {
                        values
                            .iter()
                            .take(64)
                            .any(|text| text.as_str().is_some_and(|text| !text.is_empty()))
                    })
                });
                let item = self.item(source["id"].as_str()?, reported)?;
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
                    if valid_id(&id) && !self.streamed.iter().any(|m| m == current_message) {
                        if self.streamed.len() >= RECENT_MESSAGES {
                            self.streamed.pop_front();
                        }
                        self.streamed.push_back(current_message.to_owned());
                    }
                    events.extend(self.text(&id, text, append));
                }
            }
            Some("assistant") => {
                let id = value["message"]["id"].as_str().unwrap_or(current_message);
                let Some(blocks) = value["message"]["content"].as_array() else {
                    return events;
                };
                if !valid_id(id) {
                    return events;
                }
                // Claude Code prints each content block of a message as its own assistant
                // line, so a block's array index is not its position in the message.
                let offset = self.printed(id, blocks.len());
                // Partial messages already reported this message's thinking, numbered by
                // stream index; the snapshot would add a second copy under another number.
                if self.streamed.iter().any(|m| m == id) {
                    return events;
                }
                for (index, block) in blocks.iter().enumerate() {
                    let position = offset + index;
                    if position >= 256 {
                        break;
                    }
                    if block["type"] == "thinking" {
                        if let Some(text) = block["thinking"].as_str() {
                            events.extend(self.text(&format!("{id}:{position}"), text, false));
                        }
                    }
                }
            }
            _ => {}
        }
        events
    }
    /// Returns how many content blocks earlier snapshot lines printed for this message.
    fn printed(&mut self, message: &str, count: usize) -> usize {
        if let Some(entry) = self.printed.iter_mut().find(|(m, _)| m == message) {
            let offset = entry.1;
            entry.1 = offset.saturating_add(count);
            return offset;
        }
        if self.printed.len() >= RECENT_MESSAGES {
            self.printed.pop_front();
        }
        self.printed.push_back((message.to_owned(), count));
        0
    }
}
