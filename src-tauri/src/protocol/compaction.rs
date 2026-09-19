use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub id: String,
    pub revision: u64,
    pub status: String,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<u64>,
    pub usage_revision: u64,
}

#[derive(Default)]
pub struct Compactions {
    items: Vec<(String, Compaction)>,
    boundaries: Vec<String>,
    pub manual: bool,
}
impl Compactions {
    pub fn completed(&self) -> bool {
        self.items.iter().any(|(_, c)| c.status == "complete")
    }
    fn update(
        &mut self,
        key: String,
        done: bool,
        trigger: &str,
        metadata: &Value,
    ) -> Option<Compaction> {
        let index = self.items.iter().position(|(k, _)| *k == key);
        let index = match index {
            Some(i) => i,
            None if self.items.len() < 32 => {
                let id = format!("compaction-{}", self.items.len() + 1);
                self.items.push((
                    key,
                    Compaction {
                        id,
                        revision: 0,
                        status: "running".into(),
                        trigger: trigger.into(),
                        pre_tokens: None,
                        post_tokens: None,
                        usage_revision: 0,
                    },
                ));
                self.items.len() - 1
            }
            _ => return None,
        };
        let c = &mut self.items[index].1;
        if c.status == "complete" || (!done && c.revision > 0) {
            return None;
        }
        c.revision += 1;
        c.status = if done { "complete" } else { "running" }.into();
        c.trigger = trigger.into();
        // Never expose the summary, preserved message IDs, or arbitrary provider data.
        c.pre_tokens = metadata["pre_tokens"]
            .as_u64()
            .filter(|n| *n <= 1_000_000_000);
        c.post_tokens = metadata["post_tokens"]
            .as_u64()
            .filter(|n| *n <= 1_000_000_000);
        Some(c.clone())
    }
    pub fn claude(&mut self, v: &Value) -> Option<Compaction> {
        if v["type"] != "system" || !v["parent_tool_use_id"].is_null() {
            return None;
        }
        let done = v["subtype"] == "compact_boundary";
        if !done && !(v["subtype"] == "status" && v["status"] == "compacting") {
            return None;
        }
        if done {
            if let Some(id) = v["uuid"].as_str() {
                if self.boundaries.iter().any(|s| s == id) {
                    return None;
                }
                if self.boundaries.len() < 32 {
                    self.boundaries.push(id.chars().take(240).collect());
                }
            }
        }
        let key = self
            .items
            .last()
            .filter(|(_, c)| c.status == "running")
            .map(|(key, _)| key.clone())
            .unwrap_or_else(|| format!("claude-{}", self.items.len()));
        let trigger = match v["compact_metadata"]["trigger"].as_str() {
            Some("manual") => "manual",
            Some("auto") => "auto",
            _ if self.manual => "manual",
            _ => "unknown",
        };
        self.update(key, done, trigger, &v["compact_metadata"])
    }
    pub fn codex(&mut self, v: &Value) -> Option<Compaction> {
        let p = &v["params"];
        let turn = p["turnId"].as_str().unwrap_or_default();
        let legacy = v["method"] == "thread/compacted";
        let done = legacy || v["method"] == "item/completed";
        if !legacy
            && !(p["item"]["type"] == "contextCompaction"
                && (done || v["method"] == "item/started"))
        {
            return None;
        }
        let prefix = format!("{turn}:");
        let legacy_key = format!("{prefix}legacy");
        let key = if legacy {
            // Current CLIs may also emit the deprecated alias for the same boundary.
            match self
                .items
                .iter()
                .rev()
                .find(|(key, _)| key.starts_with(&prefix))
            {
                Some((key, c)) if c.status == "running" => key.clone(),
                Some(_) => return None,
                None => legacy_key,
            }
        } else {
            let id = p["item"]["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 240)?;
            if let Some((key, _)) = self.items.iter_mut().find(|(key, _)| *key == legacy_key) {
                *key = format!("{prefix}{id}");
                return None;
            }
            format!("{prefix}{id}")
        };
        self.update(
            key,
            done,
            if self.manual { "manual" } else { "unknown" },
            &Value::Null,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Decoder, RunEvent};
    use serde_json::json;

    #[test]
    fn claude_boundary_is_bounded_parent_metadata_and_clears_old_context() {
        let mut d = Decoder::default();
        d.decode(
            "claude",
            r#"{"type":"assistant","message":{"content":[],"usage":{"input_tokens":90000}}}"#,
        );
        let boundary = json!({"type":"system","subtype":"compact_boundary","uuid":"boundary","compact_metadata":{"trigger":"auto","pre_tokens":90000,"post_tokens":4000,"summary":"private source"}});
        let mut child = boundary.clone();
        child["parent_tool_use_id"] = json!("child");
        assert!(d.decode("claude", &child.to_string()).is_empty());
        let events = d.decode("claude", &boundary.to_string());
        assert!(
            matches!(&events[..], [RunEvent::Compaction { compaction }] if compaction.pre_tokens == Some(90000) && compaction.post_tokens == Some(4000) && compaction.trigger == "auto")
        );
        assert!(!serde_json::to_string(&events)
            .unwrap()
            .contains("private source"));
        assert!(d.decode("claude", &boundary.to_string()).is_empty());
        assert!(d.context_input.is_none());
    }

    #[test]
    fn codex_aliases_deduplicate_without_losing_later_compactions_or_accepting_children() {
        for legacy_first in [true, false] {
            let mut d = Decoder::default();
            let legacy =
                json!({"method":"thread/compacted","params":{"threadId":"root","turnId":"t"}});
            let modern = json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"id":"c1","type":"contextCompaction"}}});
            let (a, b) = if legacy_first {
                (&legacy, &modern)
            } else {
                (&modern, &legacy)
            };
            assert_eq!(d.decode_codex_server(a, "root").len(), 1);
            assert!(d.decode_codex_server(b, "root").is_empty());
            assert!(d.decode_codex_server(&modern, "root").is_empty());
            let mut second = modern.clone();
            second["params"]["item"]["id"] = json!("c2");
            assert_eq!(d.decode_codex_server(&second, "root").len(), 1);
            second["params"]["threadId"] = json!("child");
            assert!(d
                .decode_codex_server(&second, "root")
                .iter()
                .all(|e| !matches!(e, RunEvent::Compaction { .. })));
        }
    }
    #[test]
    fn completed_compaction_cannot_regress_to_running_and_records_are_bounded() {
        let mut c = Compactions::default();
        for i in 0..50 {
            let start = json!({"method":"item/started","params":{"turnId":"t","item":{"id":format!("c{i}"),"type":"contextCompaction"}}});
            let mut end = start.clone();
            end["method"] = json!("item/completed");
            let first = c.codex(&start);
            let last = c.codex(&end);
            if i < 32 {
                assert_eq!(first.unwrap().revision, 1);
                assert_eq!(last.unwrap().revision, 2);
            } else {
                assert!(first.is_none() && last.is_none());
            }
            assert!(c.codex(&start).is_none());
        }
    }
}
