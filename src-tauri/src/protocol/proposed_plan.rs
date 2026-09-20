//! Proposed plan documents are independent of the progress/TODO list.
use serde::Serialize;
use serde_json::Value;

const LIMIT: usize = 64_000;
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProposedPlan {
    pub id: String,
    pub revision: u64,
    pub text: String,
    pub complete: bool,
    pub truncated: bool,
}
#[derive(Default)]
pub struct ProposedPlans(Vec<ProposedPlan>);
impl ProposedPlans {
    pub fn completed(&self) -> bool {
        self.0
            .iter()
            .any(|p| p.complete && !p.text.trim().is_empty())
    }
    pub fn codex(&mut self, value: &Value) -> Option<ProposedPlan> {
        let p = &value["params"];
        let method = value["method"].as_str()?;
        let delta = method == "item/plan/delta";
        let complete = method == "item/completed";
        if !delta
            && !(matches!(method, "item/started" | "item/completed") && p["item"]["type"] == "plan")
        {
            return None;
        }
        let id = if delta {
            p["itemId"].as_str()?
        } else {
            p["item"]["id"].as_str()?
        };
        if id.is_empty() || id.len() > 240 {
            return None;
        }
        let text = if delta {
            p["delta"].as_str()?
        } else {
            p["item"]["text"].as_str()?
        };
        let index = if let Some(i) = self.0.iter().position(|v| v.id == id) {
            i
        } else {
            if self.0.len() >= 8 {
                return None;
            }
            self.0.push(ProposedPlan {
                id: id.into(),
                revision: 0,
                text: String::new(),
                complete: false,
                truncated: false,
            });
            self.0.len() - 1
        };
        let current = &mut self.0[index];
        // Completion is authoritative, including an empty replacement. Late deltas
        // and duplicate starts/completions must never resurrect a finished item.
        if current.complete || (!delta && !complete && current.revision > 0) {
            return None;
        }
        let mut next = current.clone();
        if !delta {
            next.text.clear();
            next.truncated = false;
        }
        let remaining = LIMIT.saturating_sub(next.text.chars().count());
        next.text.extend(text.chars().take(remaining));
        next.truncated |= text.chars().count() > remaining;
        next.complete = complete;
        if next == *current && current.revision > 0 {
            return None;
        }
        next.revision += 1;
        *current = next.clone();
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn plan_only_reply_keeps_commentary_out_of_the_final_answer() {
        let mut d = crate::protocol::Decoder::default();
        d.decode_codex_server(&json!({"method":"item/completed","params":{"threadId":"t","item":{"type":"agentMessage","id":"a","phase":"commentary","text":"Investigating"}}}),"t");
        d.decode_codex_server(&json!({"method":"item/completed","params":{"threadId":"t","item":{"type":"plan","id":"p","text":"Final proposal"}}}),"t");
        d.decode_codex_server(
            &json!({"method":"turn/completed","params":{"threadId":"t"}}),
            "t",
        );
        assert!(d.text.is_empty());
        assert!(d.proposed_plans.completed());
        d.decode_codex_server(&json!({"method":"item/completed","params":{"threadId":"t","item":{"type":"agentMessage","id":"final","phase":"final_answer","text":"Final explanation"}}}),"t");
        d.decode_codex_server(
            &json!({"method":"turn/completed","params":{"threadId":"t"}}),
            "t",
        );
        assert_eq!(d.text, "Final explanation");
    }
    #[test]
    fn final_plan_replaces_stream_and_late_events_cannot_reopen_it() {
        let mut d = ProposedPlans::default();
        let delta = json!({"method":"item/plan/delta","params":{"itemId":"p","delta":"Draft"}});
        assert_eq!(d.codex(&delta).unwrap().text, "Draft");
        let final_item = json!({"method":"item/completed","params":{"item":{"id":"p","type":"plan","text":"Final plan"}}});
        assert_eq!(d.codex(&final_item).unwrap().text, "Final plan");
        assert!(d.completed());
        assert!(d.codex(&delta).is_none());
        assert!(d.codex(&final_item).is_none());
    }
    #[test]
    fn bounded_stream_can_be_replaced_by_full_final_text() {
        let mut d = ProposedPlans::default();
        let p = d.codex(&json!({"method":"item/plan/delta","params":{"itemId":"p","delta":"x".repeat(LIMIT+1)}})).unwrap();
        assert!(p.truncated);
        assert_eq!(p.text.len(), LIMIT);
        let p = d.codex(&json!({"method":"item/completed","params":{"item":{"id":"p","type":"plan","text":""}}})).unwrap();
        assert!(!p.truncated);
        assert!(!d.completed());
    }
}
