//! Native plan-mode decisions use the existing authenticated question channel,
//! with a strict two-action contract and no caller-supplied permission rules.
use super::*;

#[derive(Clone, Debug, Serialize)]
pub struct PlanApproval {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
#[derive(Default)]
pub(super) struct Tracker {
    parents: HashMap<String, (String, Value)>,
}
pub(super) fn response(value: &Value, answer: Option<&Answer>, error: Option<&str>) -> Value {
    let approved = error.is_none()
        && answer.is_some_and(|a| {
            !a.skipped
                && a.answers.len() == 1
                && a.answers[0].id == "approval"
                && a.answers[0].values == ["Approve"]
        });
    let result = if approved {
        json!({"behavior":"allow","updatedInput":value["request"]["input"],
            "updatedPermissions":[{"type":"setMode","mode":if value["request"]["tool_name"] == "EnterPlanMode" {"plan"} else {"bypassPermissions"},"destination":"session"}]})
    } else {
        json!({"behavior":"deny","message":error.unwrap_or("The user declined this plan-mode change. Do not implement the plan. Ask for feedback or continue planning.")})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":result}})
}
impl Session {
    pub(super) fn observe_plan(&mut self, value: &Value) {
        if value["type"] != "assistant" || !value["parent_tool_use_id"].is_null() {
            return;
        }
        for b in value["message"]["content"].as_array().into_iter().flatten() {
            if b["type"] != "tool_use"
                || !matches!(b["name"].as_str(), Some("EnterPlanMode" | "ExitPlanMode"))
            {
                continue;
            }
            if let Some(id) = b["id"].as_str().filter(|s| bounded(s, 240)) {
                if self.approvals.parents.len() < 32
                    && b["input"].is_object()
                    && b["input"].to_string().len() <= 32_000
                {
                    self.approvals.parents.entry(id.into()).or_insert_with(|| {
                        (b["name"].as_str().unwrap().into(), b["input"].clone())
                    });
                }
            }
        }
    }
    pub fn claude_plan(&mut self, value: &Value, active: bool) -> Option<Option<Value>> {
        let r = &value["request"];
        if r["subtype"] != "can_use_tool"
            || !matches!(
                r["tool_name"].as_str(),
                Some("EnterPlanMode" | "ExitPlanMode")
            )
        {
            return None;
        }
        let invalid = |why: &str| Some(Some(response(value, None, Some(why))));
        let parent = r["tool_use_id"].as_str().and_then(|id| {
            self.approvals
                .parents
                .get(id)
                .filter(|(name, input)| {
                    r["tool_name"] == *name && r["input"] == *input && !self.consumed.contains(id)
                })
                .map(|_| id.to_owned())
        });
        if !active
            || parent.is_none()
            || !value["parent_tool_use_id"].is_null()
            || !value["request_id"]
                .as_str()
                .is_some_and(|s| bounded(s, 240))
        {
            return invalid("Only a current parent plan-mode request can ask for approval.");
        }
        let id = parent.unwrap();
        self.consumed.insert(id);
        let exit = r["tool_name"] == "ExitPlanMode";
        let text = if exit {
            match r["input"]["plan"].as_str().filter(|s| bounded(s,24000) && s.len() <= 24000) {
                Some(text) => Some(text.to_owned()),
                None => return invalid("Include the complete proposed plan as text (at most 24 KB). Agent Studio cannot approve a missing or oversized plan or read a plan file path."),
            }
        } else {
            None
        };
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            status: "pending".into(),
            response: None,
            plan_approval: Some(PlanApproval {
                action: if exit { "exit" } else { "enter" }.into(),
                text,
            }),
            questions: vec![Question {
                id: "approval".into(),
                header: "Plan mode".into(),
                question: if exit {
                    "Approve this plan and allow implementation?"
                } else {
                    "Allow Claude to enter plan mode?"
                }
                .into(),
                options: vec![
                    OptionItem {
                        label: "Approve".into(),
                        description: String::new(),
                    },
                    OptionItem {
                        label: "Decline".into(),
                        description: String::new(),
                    },
                ],
                multi_select: false,
            }],
        };
        let Some(mut runs) = self.hub.0.lock().ok() else {
            return invalid("Plan approval is unavailable.");
        };
        let Some(run) = runs.get_mut(&self.run_id) else {
            return invalid("This run ended.");
        };
        let size = serde_json::to_vec(&request).unwrap().len();
        if size > 32000
            || run.entries.len() >= 16
            || run
                .entries
                .values()
                .map(Entry::retained_size)
                .sum::<usize>()
                + size
                > 200000
        {
            return invalid("This plan exceeds the reply's approval limit. Use a shorter plan.");
        }
        run.entries.insert(
            request.id.clone(),
            Entry {
                request: request.clone(),
                wire: Wire::ClaudePlan(value.clone()),
                submitted: None,
            },
        );
        let _ = self.channel.send(RunEvent::Question { question: request });
        Some(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(tool: &str, input: Value) -> Value {
        json!({"type":"control_request","request_id":"control","request":{"subtype":"can_use_tool","tool_name":tool,"tool_use_id":"tool","input":input}})
    }
    fn observed(session: &mut Session, call: &Value, child: bool) {
        session.observe_claude(&json!({"type":"assistant","parent_tool_use_id":if child {json!("child")} else {Value::Null},"message":{"content":[{"type":"tool_use","id":"tool","name":call["request"]["tool_name"],"input":call["request"]["input"]}]}}));
    }
    fn answer(q: &Request, value: &str) -> Answer {
        Answer {
            request_id: q.id.clone(),
            skipped: false,
            answers: vec![AnswerItem {
                id: "approval".into(),
                values: vec![value.into()],
            }],
        }
    }
    #[tokio::test]
    async fn native_plan_approval_is_explicit_scoped_and_preserves_exact_input() {
        for tool in ["EnterPlanMode", "ExitPlanMode"] {
            let hub = Questions::default();
            let (tx, mut events) = mpsc::unbounded_channel();
            let mut s = hub
                .open(
                    "run",
                    Some("connection".into()),
                    EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string())),
                )
                .unwrap();
            let input = if tool == "ExitPlanMode" {
                json!({"plan":"# Complete plan","planFilePath":"private-native-path","allowedPrompts":[{"tool":"Bash","prompt":"arbitrary"}]})
            } else {
                json!({})
            };
            let call = call(tool, input.clone());
            observed(&mut s, &call, false);
            assert!(s.claude_plan(&call, true).unwrap().is_none());
            let RunEvent::Question { question: q } = events.recv().await.unwrap() else {
                panic!("approval")
            };
            assert!(!serde_json::to_string(&q)
                .unwrap()
                .contains("private-native-path"));
            assert!(!serde_json::to_string(&q)
                .unwrap()
                .contains("allowedPrompts"));
            assert!(s.rx.try_recv().is_err(), "receipt must never auto approve");
            assert!(hub
                .answer("run", Some("foreign"), answer(&q, "Approve"))
                .await
                .is_err());
            assert!(hub
                .answer("run", Some("connection"), answer(&q, "yes"))
                .await
                .is_err());
            let h = hub.clone();
            let a = answer(&q, "Approve");
            let pending = tokio::spawn(async move { h.answer("run", Some("connection"), a).await });
            let delivery = s.rx.recv().await.unwrap();
            assert!(s.can_deliver(&delivery));
            let wire = &delivery.payload["response"]["response"];
            assert_eq!(wire["behavior"], "allow");
            assert_eq!(wire["updatedInput"], input);
            assert_eq!(
                wire["updatedPermissions"],
                json!([{"type":"setMode","mode":if tool=="EnterPlanMode" {"plan"} else {"bypassPermissions"},"destination":"session"}])
            );
            s.delivered(delivery, Ok(()));
            assert!(pending.await.unwrap().is_ok());
            assert!(
                s.claude_plan(&call, true).unwrap().is_some(),
                "duplicate tool request rejected"
            );
            assert!(hub
                .answer("run", Some("connection"), answer(&q, "Decline"))
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn withdrawal_and_stop_reject_queued_approval() {
        for stop in [false, true] {
            let hub = Questions::default();
            let mut s = hub.open("run", None, EventSink::new(|_| Ok(()))).unwrap();
            let c = call("ExitPlanMode", json!({"plan":"Review me"}));
            observed(&mut s, &c, false);
            assert!(s.claude_plan(&c, true).unwrap().is_none());
            let q = hub.0.lock().unwrap()["run"]
                .entries
                .values()
                .next()
                .unwrap()
                .request
                .clone();
            let h = hub.clone();
            let a = answer(&q, "Approve");
            let pending = tokio::spawn(async move { h.answer("run", None, a).await });
            let delivery = s.rx.recv().await.unwrap();
            if stop {
                s.close();
            } else {
                s.observe_claude(&json!({"type":"control_cancel_request","request_id":"control"}));
            }
            assert!(!s.can_deliver(&delivery));
            s.delivered(delivery, Err("Closed".into()));
            assert!(pending.await.unwrap().is_err());
            assert!(hub
                .answer("run", None, answer(&q, "Approve"))
                .await
                .is_err());
        }
    }
    #[test]
    fn child_foreign_inactive_malformed_and_oversized_plans_fail_closed() {
        for (child, active, input) in [
            (true, true, json!({"plan":"x"})),
            (false, false, json!({"plan":"x"})),
            (false, true, json!({"planFilePath":"do-not-read"})),
            (false, true, json!({"plan":"x".repeat(24001)})),
        ] {
            let hub = Questions::default();
            let mut s = hub.open("run", None, EventSink::new(|_| Ok(()))).unwrap();
            let c = call("ExitPlanMode", input);
            observed(&mut s, &c, child);
            assert_eq!(
                s.claude_plan(&c, active).unwrap().unwrap()["response"]["response"]["behavior"],
                "deny"
            );
        }
        let c = call("ExitPlanMode", json!({"plan":"x"}));
        assert_eq!(
            response(&c, None, None)["response"]["response"]["behavior"],
            "deny"
        );
    }
}
