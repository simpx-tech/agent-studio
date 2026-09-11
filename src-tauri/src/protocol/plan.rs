use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Plan {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    pub steps: Vec<Step>,
}
fn text(v: &Value, key: &str, limit: usize) -> Option<String> {
    v[key]
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(limit)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
}
fn status(v: &Value) -> Option<String> {
    Some(
        match v.as_str()? {
            "pending" => "pending",
            "in_progress" | "inProgress" | "running" => "running",
            "completed" | "complete" => "complete",
            _ => return None,
        }
        .into(),
    )
}
fn step(v: &Value, id: String, title_key: &str) -> Option<Step> {
    Some(Step {
        id,
        title: text(v, title_key, 1000)?,
        status: status(&v["status"])?,
        active_form: text(v, "activeForm", 1000),
    })
}
#[derive(Default)]
pub struct PlanDecoder {
    current: Plan,
    pending: HashMap<String, (String, Value)>,
}
impl PlanDecoder {
    fn publish(&mut self, mut next: Plan) -> Option<Plan> {
        next.revision = self.current.revision;
        if next == self.current {
            return None;
        }
        next.revision += 1;
        self.current = next.clone();
        Some(next)
    }
    pub fn codex(&mut self, params: &Value) -> Option<Plan> {
        let rows = params["plan"].as_array()?;
        if rows.len() > 64 {
            return None;
        }
        let steps = rows
            .iter()
            .enumerate()
            .map(|(i, row)| step(row, i.to_string(), "step"))
            .collect::<Option<Vec<_>>>()?;
        self.publish(Plan {
            revision: 0,
            steps,
            explanation: text(params, "explanation", 2000),
        })
    }
    pub fn claude(&mut self, v: &Value) -> Option<Plan> {
        if v["parent_tool_use_id"].as_str().is_some() {
            return None;
        }
        let mut changed = None;
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_use" {
                let name = block["name"].as_str().unwrap_or_default();
                if matches!(
                    name,
                    "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet"
                ) && self.pending.len() < 128
                    && block["input"].to_string().len() <= 128_000
                {
                    if let Some(id) = text(block, "id", 240) {
                        self.pending
                            .insert(id, (name.into(), block["input"].clone()));
                    }
                }
            } else if block["type"] == "tool_result" {
                let Some(id) = text(block, "tool_use_id", 240) else {
                    continue;
                };
                let Some((name, input)) = self.pending.remove(&id) else {
                    continue;
                };
                if block["is_error"] == true {
                    continue;
                }
                let mut result = v["tool_use_result"].clone();
                if !result.is_object() && !result.is_array() {
                    let raw = block["content"]
                        .as_str()
                        .map(String::from)
                        .unwrap_or_else(|| {
                            block["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|b| b["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        });
                    if raw.len() <= 128_000 {
                        result = serde_json::from_str(&raw).unwrap_or(Value::Null);
                    }
                }
                let mut next = self.current.clone();
                if result["success"] == false {
                    continue;
                }
                match name.as_str() {
                    "TodoWrite" => {
                        let Some(rows) = input["todos"].as_array().filter(|r| r.len() <= 64) else {
                            continue;
                        };
                        let Some(steps) = rows
                            .iter()
                            .enumerate()
                            .map(|(i, row)| step(row, i.to_string(), "content"))
                            .collect::<Option<Vec<_>>>()
                        else {
                            continue;
                        };
                        next.steps = steps;
                    }
                    "TaskCreate" => {
                        let task = &result["task"];
                        let Some(task_id) =
                            text(task, "id", 240).or_else(|| text(&result, "taskId", 240))
                        else {
                            continue;
                        };
                        let Some(title) = text(&input, "subject", 1000) else {
                            continue;
                        };
                        if next.steps.len() < 64 && !next.steps.iter().any(|s| s.id == task_id) {
                            next.steps.push(Step {
                                id: task_id,
                                title,
                                status: "pending".into(),
                                active_form: text(&input, "activeForm", 1000),
                            });
                        }
                    }
                    "TaskUpdate" => {
                        let Some(task_id) = text(&input, "taskId", 240) else {
                            continue;
                        };
                        if input["status"] == "deleted" {
                            next.steps.retain(|s| s.id != task_id);
                        } else if let Some(item) = next.steps.iter_mut().find(|s| s.id == task_id) {
                            if let Some(value) = status(&input["status"]) {
                                item.status = value;
                            }
                            if let Some(value) = text(&input, "subject", 1000) {
                                item.title = value;
                            }
                            if let Some(value) = text(&input, "activeForm", 1000) {
                                item.active_form = Some(value);
                            }
                        }
                    }
                    "TaskList" => {
                        let Some(rows) = result
                            .as_array()
                            .or_else(|| result["tasks"].as_array())
                            .filter(|r| r.len() <= 64)
                        else {
                            continue;
                        };
                        let Some(steps) = rows
                            .iter()
                            .map(|row| step(row, text(row, "id", 240)?, "subject"))
                            .collect::<Option<Vec<_>>>()
                        else {
                            continue;
                        };
                        next.steps = steps;
                    }
                    "TaskGet" => {
                        let task = if result["task"].is_object() {
                            &result["task"]
                        } else {
                            &result
                        };
                        let Some(item) =
                            text(task, "id", 240).and_then(|id| step(task, id, "subject"))
                        else {
                            continue;
                        };
                        if let Some(existing) = next.steps.iter_mut().find(|s| s.id == item.id) {
                            *existing = item;
                        } else if next.steps.len() < 64 {
                            next.steps.push(item);
                        }
                    }
                    _ => {}
                }
                if let Some(plan) = self.publish(next) {
                    changed = Some(plan);
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn call(
        decoder: &mut PlanDecoder,
        id: &str,
        name: &str,
        input: Value,
        result: Value,
        failed: bool,
    ) -> Option<Plan> {
        assert!(decoder.claude(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}})).is_none());
        decoder.claude(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":failed}]},"tool_use_result":result}))
    }
    #[test]
    fn tasks_wait_for_success_keep_assigned_ids_and_ignore_children() {
        let mut d = PlanDecoder::default();
        assert!(call(
            &mut d,
            "bad",
            "TaskCreate",
            json!({"subject":"Failed"}),
            json!({"task":{"id":"1"}}),
            true
        )
        .is_none());
        let p = call(
            &mut d,
            "a",
            "TaskCreate",
            json!({"subject":"Inspect","description":"PRIVATE_DESCRIPTION"}),
            json!({"task":{"id":"7"}}),
            false,
        )
        .unwrap();
        assert_eq!(p.steps[0].id, "7");
        assert!(!serde_json::to_string(&p)
            .unwrap()
            .contains("PRIVATE_DESCRIPTION"));
        assert!(d.claude(&json!({"parent_tool_use_id":"child","message":{"content":[{"type":"tool_use","id":"c","name":"TaskUpdate","input":{"taskId":"7","status":"completed"}}]}})).is_none());
        assert!(call(
            &mut d,
            "b",
            "TaskUpdate",
            json!({"taskId":"7","status":"completed"}),
            json!({}),
            true
        )
        .is_none());
        assert!(call(
            &mut d,
            "unsuccessful",
            "TaskUpdate",
            json!({"taskId":"7","status":"completed"}),
            json!({"success":false}),
            false
        )
        .is_none());
        let p = call(
            &mut d,
            "c",
            "TaskUpdate",
            json!({"taskId":"7","status":"completed"}),
            json!({}),
            false,
        )
        .unwrap();
        assert_eq!(p.steps[0].status, "complete");
        assert_eq!(p.revision, 2);
    }
    #[test]
    fn todo_and_codex_snapshots_replace_without_duplicate_revisions() {
        let mut d = PlanDecoder::default();
        let p = call(
            &mut d,
            "a",
            "TodoWrite",
            json!({"todos":[{"content":"Read","status":"in_progress","activeForm":"Reading"}]}),
            json!({}),
            false,
        )
        .unwrap();
        assert_eq!(p.steps[0].status, "running");
        let params = json!({"plan":[{"step":"Check","status":"inProgress"}]});
        assert_eq!(d.codex(&params).unwrap().steps[0].title, "Check");
        assert!(d.codex(&params).is_none());
        assert!(d
            .codex(&json!({"plan":[{"step":"bad","status":"invented"}]}))
            .is_none());
        assert!(d.codex(&json!({"plan":[]})).unwrap().steps.is_empty());
    }
}
