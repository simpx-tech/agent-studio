use crate::{
    protocol::{RunEvent, TokenUsage},
    providers::{ChatMessage, RunRequest},
    runner::{execute, EventSink},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Step {
    pub title: String,
    pub prompt: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub steps: Vec<Step>,
}
impl Workflow {
    pub fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.steps.is_empty()
            || self.steps.len() > 12
            || self.steps.iter().any(|s| {
                s.title.trim().is_empty()
                    || s.title.chars().count() > 100
                    || s.prompt.trim().is_empty()
                    || s.prompt.chars().count() > 8000
            })
        {
            return Err("A workflow needs a name and 1–12 steps, each with a title and prompt (up to 8,000 characters).".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct StepProgress {
    pub title: String,
    pub status: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub revision: u64,
    pub name: String,
    pub steps: Vec<StepProgress>,
}
impl Progress {
    fn send(&mut self, channel: &EventSink, index: usize, status: &str) -> Result<(), String> {
        self.revision += 1;
        self.steps[index].status = status.into();
        channel.send(RunEvent::Workflow {
            workflow: self.clone(),
        })
    }
}
fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a.zip(b).map(|(a, b)| a.saturating_add(b))
}
fn totals(previous: &Option<TokenUsage>, current: &TokenUsage) -> TokenUsage {
    let Some(previous) = previous else {
        return current.clone();
    };
    TokenUsage {
        input: add(previous.input, current.input),
        output: add(previous.output, current.output),
        cached_input: add(previous.cached_input, current.cached_input),
        reasoning_output: add(previous.reasoning_output, current.reasoning_output),
        cost_usd: previous.cost_usd.zip(current.cost_usd).map(|(a, b)| a + b),
        context_input: current.context_input,
        context_window: current.context_window,
        model: current.model.clone(),
    }
}

pub async fn run(
    app: tauri::AppHandle,
    request: RunRequest,
    channel: EventSink,
    cancel: CancellationToken,
) -> Result<String, String> {
    run_sequence(request, channel, cancel, move |request, channel, cancel| {
        execute(
            app.clone(),
            request,
            Some(channel),
            cancel,
            Duration::from_secs(300),
            "chat-runtime",
        )
    })
    .await
}

async fn run_sequence<F, Fut>(
    mut request: RunRequest,
    channel: EventSink,
    cancel: CancellationToken,
    mut run_step: F,
) -> Result<String, String>
where
    F: FnMut(RunRequest, EventSink, CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<(String, String), String>>,
{
    let workflow = request.workflow.take().ok_or("Missing workflow")?;
    workflow.validate()?;
    let mut progress = Progress {
        revision: 0,
        name: workflow.name.clone(),
        steps: workflow
            .steps
            .iter()
            .map(|step| StepProgress {
                title: step.title.clone(),
                status: "pending".into(),
            })
            .collect(),
    };
    let mut completed_output = String::new();
    let mut previous_usage = None;
    for (index, step) in workflow.steps.iter().enumerate() {
        if cancel.is_cancelled() {
            progress.send(&channel, index, "cancelled")?;
            return Ok("cancelled".into());
        }
        progress.send(&channel, index, "running")?;
        channel.send(RunEvent::Plan {
            plan: crate::protocol::plan::Plan {
                revision: index as u64 * 1_000_000,
                explanation: None,
                steps: vec![],
            },
        })?;
        // Never reroute a workflow or mutate the selected profile/location/settings.
        request.messages.push(ChatMessage { role: "user".into(), text: format!("Workflow {:?}, step {} of {}: {}\n\n{}\n\nCarry out only this step, using the earlier conversation and step results. Report its result; the application will start the next step.", workflow.name, index + 1, workflow.steps.len(), step.title, step.prompt), images: vec![] });
        if let Err(error) = request.validate() {
            progress.send(&channel, index, "error")?;
            return Err(error);
        }
        let prefix = format!("wf{index}:");
        let heading = format!(
            "## Step {}: {}\n\n",
            index + 1,
            step.title.replace(['\n', '\r'], " ")
        );
        let prior = format!("{completed_output}{heading}");
        let out = channel.clone();
        let previous = previous_usage.clone();
        let usage = Arc::new(Mutex::new(None));
        let reading = usage.clone();
        let sink = EventSink::new(move |event| {
            let event = match event {
                RunEvent::Text { text } => RunEvent::Text {
                    text: format!("{prior}{text}"),
                },
                RunEvent::Progress { id, revision, text } => RunEvent::Progress {
                    id: format!("{prefix}{id}"),
                    revision,
                    text,
                },
                RunEvent::Tool { mut tool } => {
                    tool.scope(&prefix);
                    RunEvent::Tool { tool }
                }
                RunEvent::Plan { mut plan } => {
                    plan.revision += (index as u64) * 1_000_000;
                    RunEvent::Plan { plan }
                }
                RunEvent::Usage { usage: current } => {
                    let total = totals(&previous, &current);
                    *reading.lock().map_err(|_| "Workflow usage unavailable")? =
                        Some(total.clone());
                    RunEvent::Usage { usage: total }
                }
                other => other,
            };
            out.send(event)
        });
        let result = run_step(request.clone(), sink, cancel.clone()).await;
        match result {
            Ok((status, text)) if status == "complete" => {
                completed_output.push_str(&format!("{heading}{text}\n\n"));
                channel.send(RunEvent::Text {
                    text: completed_output.clone(),
                })?;
                let measured = usage
                    .lock()
                    .map_err(|_| "Workflow usage unavailable")?
                    .clone();
                let total = measured.unwrap_or(TokenUsage {
                    input: None,
                    output: None,
                    cached_input: None,
                    reasoning_output: None,
                    cost_usd: None,
                    context_input: None,
                    context_window: None,
                    model: None,
                });
                channel.send(RunEvent::Usage {
                    usage: total.clone(),
                })?;
                previous_usage = Some(total);
                request.messages.push(ChatMessage {
                    role: "assistant".into(),
                    text,
                    images: vec![],
                });
                progress.send(&channel, index, "complete")?;
            }
            Ok(_) => {
                progress.send(&channel, index, "cancelled")?;
                return Ok("cancelled".into());
            }
            Err(error) => {
                progress.send(&channel, index, "error")?;
                return Err(format!(
                    "Workflow step {} ({}) failed: {error}",
                    index + 1,
                    step.title
                ));
            }
        }
    }
    Ok("complete".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> RunRequest {
        serde_json::from_value(serde_json::json!({"runId": uuid::Uuid::new_v4(), "agent":{"provider":"claude","model":"sonnet","instructions":"","reasoning":"low"}, "messages":[{"role":"user","text":"input"}], "workflow":{"id":uuid::Uuid::new_v4(),"name":"Test","steps":[{"title":"First","prompt":"first"},{"title":"Second","prompt":"second"},{"title":"Third","prompt":"third"}]}})).unwrap()
    }
    #[tokio::test]
    async fn sequence_carries_outputs_and_stops_on_failure_or_cancellation() {
        for failure in [false, true] {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let received = seen.clone();
            let sink = EventSink::new(move |event| {
                received.lock().unwrap().push(event);
                Ok(())
            });
            let mut calls = 0;
            let result = run_sequence(
                request(),
                sink,
                CancellationToken::new(),
                |request, _sink, _cancel| {
                    calls += 1;
                    let outcome = if calls == 1 {
                        Ok(("complete".into(), "FIRST_RESULT".into()))
                    } else {
                        assert!(request
                            .messages
                            .iter()
                            .any(|m| m.role == "assistant" && m.text == "FIRST_RESULT"));
                        assert_eq!(request.agent.model, "sonnet");
                        if failure {
                            Err("fixture failure".into())
                        } else {
                            Ok(("cancelled".into(), String::new()))
                        }
                    };
                    std::future::ready(outcome)
                },
            )
            .await;
            assert_eq!(calls, 2);
            if failure {
                assert!(result.unwrap_err().contains("step 2"));
            } else {
                assert_eq!(result.unwrap(), "cancelled");
            }
            let events = seen.lock().unwrap();
            let RunEvent::Workflow { workflow } = events.last().unwrap() else {
                panic!("Missing final progress")
            };
            assert_eq!(workflow.steps[0].status, "complete");
            assert_eq!(
                workflow.steps[1].status,
                if failure { "error" } else { "cancelled" }
            );
            assert_eq!(workflow.steps[2].status, "pending");
            assert!(events
                .iter()
                .any(|e| matches!(e,RunEvent::Text{text} if text.contains("FIRST_RESULT"))));
        }
    }
    #[tokio::test]
    async fn cancellation_between_steps_never_launches_the_next_step() {
        let cancel = CancellationToken::new();
        let output = EventSink::new(|_| Ok(()));
        let mut calls = 0;
        let result = run_sequence(request(), output, cancel.clone(), |_, _, token| {
            calls += 1;
            token.cancel();
            std::future::ready(Ok(("complete".into(), "done".into())))
        })
        .await;
        assert_eq!(result.unwrap(), "cancelled");
        assert_eq!(calls, 1);
    }
    #[tokio::test]
    async fn an_unmeasured_step_keeps_later_workflow_totals_unknown() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let output = EventSink::new(move |event| {
            events.lock().unwrap().push(event);
            Ok(())
        });
        let mut calls = 0;
        run_sequence(request(), output, CancellationToken::new(), |_, sink, _| {
            calls += 1;
            if calls != 2 {
                sink.send(RunEvent::Usage {
                    usage: TokenUsage {
                        input: Some(5),
                        output: Some(2),
                        cached_input: None,
                        reasoning_output: None,
                        cost_usd: Some(0.1),
                        context_input: Some(5),
                        context_window: Some(100),
                        model: Some("fixture".into()),
                    },
                })
                .unwrap();
            }
            std::future::ready(Ok(("complete".into(), "done".into())))
        })
        .await
        .unwrap();
        let events = received.lock().unwrap();
        let usage = events
            .iter()
            .rev()
            .find_map(|event| {
                if let RunEvent::Usage { usage } = event {
                    Some(usage)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(usage.input, None);
        assert_eq!(usage.cost_usd, None);
        assert_eq!(usage.context_input, Some(5));
    }
    #[test]
    fn validation_bounds_steps_and_keeps_prompt_as_data() {
        let mut w = Workflow {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Review".into(),
            steps: vec![Step {
                title: "Inspect".into(),
                prompt: "literal $(example); `text`".into(),
            }],
        };
        assert!(w.validate().is_ok());
        w.steps = vec![w.steps[0].clone(); 13];
        assert!(w.validate().is_err());
    }
    #[test]
    fn usage_sums_turns_but_keeps_last_context_and_missing_cost_unknown() {
        let a = TokenUsage {
            input: Some(4),
            output: Some(2),
            cached_input: None,
            reasoning_output: None,
            context_input: Some(4),
            context_window: Some(100),
            cost_usd: None,
            model: None,
        };
        let b = TokenUsage {
            input: Some(7),
            context_input: Some(7),
            cost_usd: Some(0.2),
            ..a.clone()
        };
        let result = totals(&Some(a), &b);
        assert_eq!(result.input, Some(11));
        assert_eq!(result.context_input, Some(7));
        assert_eq!(result.cost_usd, None);
    }
}
