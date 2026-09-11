//! Native Claude Workflow observations only; this module never executes scripts.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    runs: Vec<WorkflowRun>,
    limited: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowRun {
    id: String,
    task_id: String,
    run_id: String,
    name: String,
    status: String,
    description: String,
    script_path: String,
    error: String,
    phases: Vec<Phase>,
    agents: Vec<Agent>,
    tokens: Option<u64>,
    duration_ms: Option<u64>,
    limited: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
struct Phase {
    index: u64,
    title: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Agent {
    index: u64,
    id: String,
    label: String,
    phase_index: Option<u64>,
    model: String,
    status: String,
    tokens: Option<u64>,
    duration_ms: Option<u64>,
    result: String,
}
#[derive(Default)]
pub struct WorkflowDecoder {
    snapshot: Snapshot,
}
fn text(value: &Value, key: &str, limit: usize) -> String {
    value[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(limit)
        .collect()
}
fn state(value: &str) -> &'static str {
    match value {
        "pending" | "queued" => "pending",
        "running" | "start" => "running",
        "completed" | "done" | "cached" => "complete",
        "failed" | "error" => "error",
        "killed" | "stopped" | "cancelled" => "cancelled",
        "paused" => "paused",
        _ => "unknown",
    }
}
impl WorkflowDecoder {
    fn ensure(&mut self, id: &str) -> Option<&mut WorkflowRun> {
        if id.is_empty() || id.len() > 240 {
            return None;
        }
        if let Some(index) = self.snapshot.runs.iter().position(|r| r.id == id) {
            return self.snapshot.runs.get_mut(index);
        }
        if self.snapshot.runs.len() >= 16 {
            self.snapshot.limited = true;
            return None;
        }
        self.snapshot.runs.push(WorkflowRun {
            id: id.into(),
            task_id: String::new(),
            run_id: String::new(),
            name: "Claude workflow".into(),
            status: "pending".into(),
            description: String::new(),
            script_path: String::new(),
            error: String::new(),
            phases: vec![],
            agents: vec![],
            tokens: None,
            duration_ms: None,
            limited: false,
        });
        self.snapshot.runs.last_mut()
    }
    pub fn decode(&mut self, v: &Value) -> Option<Snapshot> {
        if v["parent_tool_use_id"].as_str().is_some() {
            return None;
        }
        let previous = self.snapshot.clone();
        match v["type"].as_str().unwrap_or_default() {
            "assistant" => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] != "tool_use" || block["name"] != "Workflow" {
                        continue;
                    }
                    if let Some(run) = self.ensure(&text(block, "id", 240)) {
                        let name = text(&block["input"], "name", 200);
                        if !name.is_empty() {
                            run.name = name;
                        }
                        // Inline scripts and args are deliberately not forwarded.
                    }
                }
            }
            "user" => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] != "tool_result" {
                        continue;
                    }
                    let id = text(block, "tool_use_id", 240);
                    let Some(run) = self.snapshot.runs.iter_mut().find(|r| r.id == id) else {
                        continue;
                    };
                    let result = &v["tool_use_result"];
                    if block["is_error"] == true || result["error"].is_string() {
                        run.status = "error".into();
                        run.error =
                            "Claude could not launch this workflow. See its reply for details."
                                .into();
                        continue;
                    }
                    if result["status"] == "async_launched" || result["status"] == "remote_launched"
                    {
                        run.task_id = text(result, "taskId", 240);
                        run.run_id = text(result, "runId", 240);
                        run.name = text(result, "workflowName", 200);
                        run.description = text(result, "summary", 1000);
                        run.script_path = text(result, "scriptPath", 4096);
                        if matches!(run.status.as_str(), "pending" | "running") {
                            run.status = "running".into();
                        }
                    }
                }
            }
            "system" => {
                let task = text(v, "task_id", 240);
                if v["subtype"] == "task_started" && v["task_type"] == "local_workflow" {
                    let id = text(v, "tool_use_id", 240);
                    if let Some(run) = self.ensure(if id.is_empty() { &task } else { &id }) {
                        run.task_id = task.clone();
                        run.name = text(v, "workflow_name", 200);
                        run.description = text(v, "description", 1000);
                        if run.status == "pending" {
                            run.status = "running".into();
                        }
                    }
                }
                if let Some(run) = self
                    .snapshot
                    .runs
                    .iter_mut()
                    .find(|r| !task.is_empty() && r.task_id == task)
                {
                    match v["subtype"].as_str().unwrap_or_default() {
                        "task_updated" => {
                            if let Some(status) = v["patch"]["status"].as_str() {
                                run.status = state(status).into();
                            }
                        }
                        "task_notification" => {
                            run.status = state(v["status"].as_str().unwrap_or_default()).into();
                        }
                        "task_progress" => {
                            for entry in v["workflow_progress"].as_array().into_iter().flatten() {
                                let Some(index) = entry["index"].as_u64() else {
                                    continue;
                                };
                                if entry["type"] == "workflow_phase" {
                                    let phase = Phase {
                                        index,
                                        title: text(entry, "title", 200),
                                    };
                                    if let Some(old) =
                                        run.phases.iter_mut().find(|p| p.index == index)
                                    {
                                        *old = phase;
                                    } else if run.phases.len() < 64 {
                                        run.phases.push(phase);
                                    } else {
                                        run.limited = true;
                                    }
                                } else if entry["type"] == "workflow_agent" {
                                    let agent = Agent {
                                        index,
                                        id: text(entry, "agentId", 240),
                                        label: text(entry, "label", 200),
                                        phase_index: entry["phaseIndex"].as_u64(),
                                        model: text(entry, "model", 200),
                                        status: state(entry["state"].as_str().unwrap_or_default())
                                            .into(),
                                        tokens: entry["tokens"].as_u64(),
                                        duration_ms: entry["durationMs"].as_u64(),
                                        result: text(entry, "resultPreview", 2000),
                                    };
                                    if let Some(old) =
                                        run.agents.iter_mut().find(|a| a.index == index)
                                    {
                                        *old = agent;
                                    } else if run.agents.len() < 128 {
                                        run.agents.push(agent);
                                    } else {
                                        run.limited = true;
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                    if let Some(tokens) = v["usage"]["total_tokens"].as_u64() {
                        run.tokens = Some(tokens);
                    }
                    if let Some(duration) = v["usage"]["duration_ms"].as_u64() {
                        run.duration_ms = Some(duration);
                    }
                }
            }
            _ => {}
        }
        if self.snapshot == previous {
            return None;
        }
        self.snapshot.revision += 1;
        Some(self.snapshot.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn native_launch_progress_and_completion_are_distinct_and_bounded() {
        let mut d = WorkflowDecoder::default();
        d.decode(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"Workflow","input":{"script":"private script"}}]}}));
        d.decode(&json!({"type":"system","subtype":"task_started","task_id":"task","tool_use_id":"call","task_type":"local_workflow","workflow_name":"audit"}));
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call"}]},"tool_use_result":{"status":"async_launched","taskId":"task","runId":"wf_1","workflowName":"audit"}});
        assert_eq!(d.decode(&result).unwrap().runs[0].status, "running");
        let progress = json!({"type":"system","subtype":"task_progress","task_id":"task","workflow_progress":[{"type":"workflow_phase","index":1,"title":"Review"},{"type":"workflow_agent","index":1,"agentId":"agent","phaseIndex":1,"label":"Route","state":"done","resultPreview":"Checked","promptPreview":"private prompt","toolCalls":[{"input":"private arguments"}]}]});
        let snapshot = d.decode(&progress).unwrap();
        assert_eq!(snapshot.runs[0].agents[0].status, "complete");
        assert_eq!(snapshot.runs[0].status, "running");
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("private"));
        assert!(d.decode(&progress).is_none());
        let done = d.decode(&json!({"type":"system","subtype":"task_notification","task_id":"task","status":"completed"})).unwrap();
        assert_eq!(done.runs[0].status, "complete");
        assert!(d.decode(&json!({"type":"system","subtype":"task_notification","task_id":"other","status":"failed"})).is_none());
    }
    #[test]
    fn failed_launch_and_child_events_cannot_claim_success() {
        let mut d = WorkflowDecoder::default();
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"x","name":"Workflow"}]}});
        let mut child = call.clone();
        child["parent_tool_use_id"] = json!("parent");
        assert!(d.decode(&child).is_none());
        d.decode(&call);
        let failed = d.decode(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x"}]},"tool_use_result":{"status":"async_launched","error":"Syntax error private source"}})).unwrap();
        assert_eq!(failed.runs[0].status, "error");
        assert!(failed.runs[0].task_id.is_empty());
    }
}
