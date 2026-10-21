//! Artifacts a Claude reply publishes to claude.ai with Claude Code's own Artifact tools
//! (requested 2026-10-21, in place of Agent Studio's show_artifact for Claude chats). A headless
//! CLI offers those tools only when its launch sets `CLAUDE_CODE_ARTIFACT` (`ENV`), and publishes
//! with its own claude.ai login, so Agent Studio reads no credential. The reply keeps a card for
//! each artifact its parent calls published or opened, from the call's structured result: the
//! artifact's id, link and title, never the page. A new artifact and an open call also ask the
//! window that runs the reply to open the link, as the CLI's terminal opens the browser.
use crate::protocol::RunEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// What a Claude chat's launch adds to its environment: the Artifact tools, which a headless
/// session leaves out unless asked (`sdk_default_off` in Claude Code 2.1.306), without the
/// automatic comment replies a parked process would make unseen.
pub const ENV: [(&str, &str); 2] = [
    ("CLAUDE_CODE_ARTIFACT", "1"),
    ("CLAUDE_CODE_ARTIFACT_COMMENTS_AUTOREACT", "0"),
];

/// The tool that publishes, opens and lists artifacts.
const TOOL: &str = "Artifact";

/// A claude.ai artifact as the saved reply keeps it (`src/lib/published-artifacts.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublishedArtifact {
    pub id: String,
    pub revision: u64,
    pub url: String,
    pub title: String,
}

/// An artifact's own link on claude.ai: `/artifact/<short id>` or `/code/artifact/<uuid>`.
pub fn valid_url(url: &str) -> bool {
    if let Some(id) = url.strip_prefix("https://claude.ai/artifact/") {
        return id.len() == 22
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b));
    }
    url.strip_prefix("https://claude.ai/code/artifact/")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)
}

/// The cards of one reply, from its parent's Artifact calls.
#[derive(Default)]
pub struct PublishedArtifacts {
    /// Each parent call by id, with the action it asked for.
    calls: HashMap<String, String>,
    cards: Vec<PublishedArtifact>,
}
impl PublishedArtifacts {
    /// Whether this reply published or opened an artifact, so a card alone is a complete answer.
    pub fn has_artifacts(&self) -> bool {
        !self.cards.is_empty()
    }
    /// Claude reports a parent call before it runs and its result, with the tool's structured
    /// answer beside it, when it finishes. Only successful results make a card.
    pub fn observe_claude(&mut self, value: &Value) -> Vec<RunEvent> {
        if !value["parent_tool_use_id"].is_null() {
            return vec![];
        }
        let Some(blocks) = value["message"]["content"].as_array() else {
            return vec![];
        };
        if value["type"] == "assistant" {
            for block in blocks {
                if block["type"] == "tool_use" && block["name"] == TOOL {
                    if let Some(id) = block["id"].as_str() {
                        let action = block["input"]["action"].as_str().unwrap_or("publish");
                        self.calls.insert(id.into(), action.into());
                    }
                }
            }
            return vec![];
        }
        // Each result line answers one call; the structured answer belongs to that one alone.
        let results: Vec<_> = blocks
            .iter()
            .filter(|b| b["type"] == "tool_result")
            .collect();
        if value["type"] != "user" || results.len() != 1 {
            return vec![];
        }
        let block = results[0];
        let Some(action) = block["tool_use_id"]
            .as_str()
            .and_then(|id| self.calls.remove(id))
        else {
            return vec![];
        };
        if block["is_error"] == true {
            return vec![];
        }
        self.card(&action, &value["tool_use_result"])
            .into_iter()
            .collect()
    }
    fn card(&mut self, action: &str, result: &Value) -> Option<RunEvent> {
        // A new artifact opens, as the CLI's own first publish does; so does an open call.
        let open = match action {
            "publish" => result["updated"] != true,
            "open" if result["opened"] == true => true,
            _ => return None,
        };
        let id = result["artifact_id"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)?
            .to_ascii_lowercase();
        let url = result["url"].as_str().filter(|url| valid_url(url))?;
        // One line, as the card shows it.
        let title: String = result["title"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let title = match title.trim() {
            "" => "Untitled artifact",
            title => title,
        };
        let index = self.cards.iter().position(|card| card.id == id);
        let card = PublishedArtifact {
            revision: index.map_or(1, |i| self.cards[i].revision + 1),
            id,
            url: url.into(),
            title: title.into(),
        };
        match index {
            Some(i) => self.cards[i] = card.clone(),
            None => self.cards.push(card.clone()),
        }
        Some(RunEvent::PublishedArtifact {
            published_artifact: card,
            open,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "61f14ff2-c402-429d-ad1b-42de9c796ca9";
    const URL: &str = "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax";

    fn call(id: &str, input: Value, parent: Value) -> Value {
        json!({"type":"assistant","parent_tool_use_id":parent,"message":{"content":[{"type":"tool_use","id":id,"name":"Artifact","input":input}]}})
    }
    fn result(id: &str, answer: Value, error: bool) -> Value {
        json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":error,"content":"Published"}]},"tool_use_result":answer})
    }
    // The answers Claude Code 2.1.306 gave for a real publish and open on 2026-10-21.
    fn published(updated: bool) -> Value {
        json!({"url":URL,"path":"C:\\Temp\\test-page.html","artifact_id":ID,"title":"Agent Studio publish test","updated":updated,"owned":true,"icon":"test","audience":"owner","seq":1,"version":"1792592971-ea59","contract":"0.0.0","liveSubscription":"publish_context"})
    }
    fn cards(events: Vec<RunEvent>) -> Vec<(PublishedArtifact, bool)> {
        events
            .into_iter()
            .map(|event| match event {
                RunEvent::PublishedArtifact {
                    published_artifact,
                    open,
                } => (published_artifact, open),
                _ => panic!("card"),
            })
            .collect()
    }

    #[test]
    fn a_publish_makes_a_card_that_a_new_artifact_opens() {
        let mut seen = PublishedArtifacts::default();
        assert!(seen
            .observe_claude(&call(
                "t1",
                json!({"file_path":"C:\\Temp\\test-page.html"}),
                Value::Null
            ))
            .is_empty());
        let made = cards(seen.observe_claude(&result("t1", published(false), false)));
        assert_eq!(
            made,
            vec![(
                PublishedArtifact {
                    id: ID.into(),
                    revision: 1,
                    url: URL.into(),
                    title: "Agent Studio publish test".into(),
                },
                true
            )]
        );
        assert!(seen.has_artifacts());
        // Publishing it again updates the same card and opens nothing; opening it opens it.
        seen.observe_claude(&call(
            "t2",
            json!({"action":"publish","file_path":"x"}),
            Value::Null,
        ));
        let again = cards(seen.observe_claude(&result("t2", published(true), false)));
        assert_eq!((again[0].0.revision, again[0].1), (2, false));
        seen.observe_claude(&call("t3", json!({"action":"open","url":URL}), Value::Null));
        let opened = cards(seen.observe_claude(&result(
            "t3",
            json!({"opened":true,"url":URL,"artifact_id":ID,"title":"Agent Studio publish test","owned":true}),
            false,
        )));
        assert_eq!((opened[0].0.revision, opened[0].1), (3, true));
        // The structured answer is the event's only source: the event names nothing else.
        let event = serde_json::to_value(RunEvent::PublishedArtifact {
            published_artifact: opened[0].0.clone(),
            open: false,
        })
        .unwrap();
        assert_eq!(
            event,
            json!({"kind":"publishedartifact","publishedArtifact":{"id":ID,"revision":3,"url":URL,"title":"Agent Studio publish test"}})
        );
    }

    #[test]
    fn only_the_parents_successful_publishes_and_opens_make_cards() {
        let mut seen = PublishedArtifacts::default();
        // A sub-agent's call, a failed call, an unknown call and other actions make none.
        seen.observe_claude(&call("child", json!({}), json!("agent")));
        assert!(seen
            .observe_claude(&result("child", published(false), false))
            .is_empty());
        seen.observe_claude(&call("failed", json!({}), Value::Null));
        assert!(seen
            .observe_claude(&result("failed", published(false), true))
            .is_empty());
        assert!(seen
            .observe_claude(&result("unknown", published(false), false))
            .is_empty());
        seen.observe_claude(&call("list", json!({"action":"list"}), Value::Null));
        assert!(seen
            .observe_claude(&result("list", json!({"artifacts":[],"total":4}), false))
            .is_empty());
        // A call of another Artifact tool makes none.
        seen.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"other","name":"ArtifactComments","input":{}}]}}));
        assert!(seen
            .observe_claude(&result("other", published(false), false))
            .is_empty());
        // An answer naming another site, or a malformed id, is refused.
        for answer in [
            json!({"url":"https://example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax","artifact_id":ID}),
            json!({"url":URL,"artifact_id":"not-a-uuid"}),
            json!({"url":"https://claude.ai/artifact/short","artifact_id":ID}),
        ] {
            seen.observe_claude(&call("odd", json!({}), Value::Null));
            assert!(seen
                .observe_claude(&result("odd", answer, false))
                .is_empty());
        }
        assert!(!seen.has_artifacts());
        // A line answering two calls at once leaves its structured answer unattributed.
        seen.observe_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"a","name":"Artifact","input":{}},{"type":"tool_use","id":"b","name":"Artifact","input":{}}]}}));
        let both = json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"a"},{"type":"tool_result","tool_use_id":"b"}]},"tool_use_result":published(false)});
        assert!(seen.observe_claude(&both).is_empty());
        // A result without a title gets one, on one line.
        seen.observe_claude(&call("untitled", json!({}), Value::Null));
        let untitled = cards(seen.observe_claude(&result(
            "untitled",
            json!({"url":URL,"artifact_id":ID.to_uppercase(),"title":"Two\nlines"}),
            false,
        )));
        assert_eq!(untitled[0].0.title, "Two lines");
        assert_eq!(untitled[0].0.id, ID);
    }

    #[test]
    fn knows_claude_ai_artifact_links() {
        assert!(valid_url(URL));
        assert!(valid_url(&format!("https://claude.ai/code/artifact/{ID}")));
        for url in [
            "http://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax",
            "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3a0",
            "https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax?x=1",
            "https://claude.ai/code/artifact/not-a-uuid",
            "https://claude.ai.example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax",
        ] {
            assert!(!valid_url(url), "{url}");
        }
    }
}
