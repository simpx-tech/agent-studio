//! The installed Claude CLI and the production runner: a reply waits for the tests the
//! model declared, never for a server it left running, and Stop ends a waiting reply;
//! each reply's cost is the change in its process's running total, reused or fresh.
use super::*;
use crate::providers::questions::Questions;
use serde_json::json;

async fn run(
    text: &str,
    stop_while_waiting: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>, bool) {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-background-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        if stop_while_waiting
            && matches!(&event, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        {
            stop.cancel();
        }
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            cancel,
            None,
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    let parkable = process.healthy && process.alive();
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    (result, events, parkable)
}

fn waited(events: &[RunEvent]) -> bool {
    events.iter().any(
        |e| matches!(e, RunEvent::Activity { text } if text == "Waiting for background work to finish"),
    )
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_reply_waits_for_declared_tests_but_not_servers() {
    let started = std::time::Instant::now();
    let (result, events, parkable) = run("This is an Agent Studio integration test in a disposable folder. Start a stand-in dev server for me to try, in the background: node -e \"setInterval(()=>{},1000)\" . Also run the slow test suite in the background: sleep 20 && echo BACKGROUND_TESTS_PASSED . Report the test output when it is done, and leave the server running for me.", false).await;
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    assert!(text.contains("BACKGROUND_TESTS_PASSED"), "{text}");
    assert!(started.elapsed() >= Duration::from_secs(20));
    assert!(waited(&events));
    assert!(parkable);
    // Activity shows commands by description only; keep the final state of each.
    let mut commands = std::collections::HashMap::new();
    for event in &events {
        if let RunEvent::Tool { tool } = event {
            let tool = serde_json::to_value(tool).unwrap();
            if tool["operation"] == "command" {
                commands.insert(
                    tool["id"].to_string(),
                    (tool["status"].clone(), tool["background"] == true),
                );
            }
        }
    }
    let states: Vec<_> = commands.values().collect();
    assert!(
        states.contains(&&(json!("running"), true)),
        "the server outlives the reply in the background: {states:?}"
    );
    assert!(
        states.contains(&&(json!("complete"), true)),
        "the declared tests finished in the background: {states:?}"
    );
    eprintln!(
        "Reply waited {:?} for the declared tests: {text}",
        started.elapsed()
    );
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_stop_ends_a_waiting_reply_and_keeps_the_process() {
    let started = std::time::Instant::now();
    let (result, events, parkable) = run("This is an Agent Studio integration test in a disposable folder. Run the slow test suite in the background: sleep 240 && echo LATE_RESULT . I need its output before you are done, so wait for it.", true).await;
    let (status, _) = result.expect("Installed CLI failed");
    assert_eq!(status, "cancelled");
    assert!(waited(&events));
    assert!(
        parkable,
        "acknowledged stops keep the CLI for the next reply"
    );
    assert!(started.elapsed() < Duration::from_secs(200));
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_background_work_outlives_its_reply() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":"This is an Agent Studio integration test in a disposable folder. Start two things in the background and do not wait for either: a stand-in dev server for me to try, node -e \"setInterval(()=>{},1000)\" , and a short job, sleep 15 && echo JOB_DONE . Reply right away that both started; I will check the job myself later."}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let (tx, mut reported) = tokio::sync::mpsc::unbounded_channel();
    let watch = crate::background_work::Watch::new(
        "conversation",
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    let mut process = crate::pool::Process::new_observed(
        exe,
        command.spawn().unwrap(),
        "real-background-work-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
        crate::background_work::observer(None, Some(watch.clone())),
    )
    .unwrap();
    process.background = Some(watch.clone());
    let channel = EventSink::new(|_| Ok(()));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            None,
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    assert_eq!(result.expect("Installed CLI failed").0, "complete");
    // As after a production reply: the watch takes over and the process waits, parked.
    watch.detach(&request.run_id);
    process.park();
    let listed = watch.snapshot().runs;
    let outcome = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            match reported.recv().await {
                Some(crate::background_work::Event::Tool(outcome)) => break Some(outcome),
                Some(_) => {}
                None => break None,
            }
        }
    })
    .await
    .ok()
    .flatten();
    let left = watch.snapshot().runs;
    // Releasing the process stops the server it still ran. Release it before asserting,
    // so a failure never leaves the stand-in server running.
    process.kill().await;
    let mut stopped = vec![];
    while let Ok(event) = reported.try_recv() {
        if let crate::background_work::Event::Tool(outcome) = event {
            stopped.push((outcome.tool.id.clone(), outcome.tool.status.clone()));
        }
    }
    assert_eq!(
        listed.len(),
        2,
        "both launches outlive the reply: {listed:?}"
    );
    let outcome = outcome.expect("The parked process never reported the job's outcome");
    assert_eq!(outcome.tool.status, "complete");
    assert!(outcome.tool.background);
    // Within a second of the 15-second job: the launch returns just after it starts.
    let elapsed = outcome.tool.elapsed_ms.unwrap();
    assert!((14_000..60_000).contains(&elapsed), "{elapsed}");
    assert_eq!(left.len(), 1, "the server keeps running: {left:?}");
    assert_eq!(
        stopped,
        [(left[0].id.clone(), "cancelled".to_string())],
        "{stopped:?}"
    );
    assert!(watch.snapshot().runs.is_empty());
    eprintln!("Listed {listed:?}; the job finished after {elapsed} ms while parked.");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_message_takes_over_a_reply_waiting_for_a_background_agent() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let ask = "This is an Agent Studio integration test in a disposable folder. Start exactly one sub-agent in the background with the Agent tool (run_in_background: true) whose task is: run the shell command sleep 40 && echo AGENT_DONE and report its output. Do not wait for it: end your turn right away, saying only that the agent started. When it reports back, reply with its output.";
    let question = "A quick question while the agent works: what is 17 + 25? Answer with the number only, and do not wait for the agent for this answer.";
    let mut first: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":ask}]})).unwrap();
    first.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &first).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&first, &runtime, &exe)
        .await
        .unwrap();
    let (tx, mut reported) = tokio::sync::mpsc::unbounded_channel();
    let watch = crate::background_work::Watch::new(
        &conversation,
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    let mut next: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"sonnet","instructions":""},"messages":[{"role":"user","text":ask},{"role":"assistant","text":"Pending"},{"role":"user","text":question}]})).unwrap();
    // The launch identity execute gives both replies, which the CLI's reported mode confirms.
    let identity = crate::pool::fingerprint(&next, &exe).unwrap();
    let mut process = crate::pool::Process::new_observed(
        exe,
        command.spawn().unwrap(),
        identity.clone(),
        first.native_session.as_ref().unwrap().id().to_string(),
        crate::background_work::observer(None, Some(watch.clone())),
    )
    .unwrap();
    process.background = Some(watch.clone());
    let hub = Questions::default();
    let (tx, mut first_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = hub.open(&first.run_id, None, channel.clone()).unwrap();
    let first_id = first.run_id.clone();
    let task = tokio::spawn(async move {
        let result = stream_turn(
            &mut process,
            &first,
            Some(&channel),
            CancellationToken::new(),
            None,
            Some(&mut questions),
            false,
        )
        .await;
        (process, result, first)
    });
    let wait = tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(event) = first_events.recv().await {
            if let RunEvent::BackgroundWait { wait: Some(wait) } = event {
                return Some(wait);
            }
        }
        None
    })
    .await
    .ok()
    .flatten();
    let started = std::time::Instant::now();
    let next_id = next.run_id.clone();
    let answered = Arc::new(Mutex::new(None));
    let first_answer = answered.clone();
    let (tx, mut next_events) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        if matches!(&event, RunEvent::Progress { text, .. } | RunEvent::Text { text } if text.contains("42"))
        {
            first_answer
                .lock()
                .unwrap()
                .get_or_insert(started.elapsed());
        }
        let _ = tx.send(event);
        Ok(())
    });
    let mut next_questions = hub.open(&next_id, None, channel.clone()).unwrap();
    let offer = wait.map(|wait| {
        next_questions
            .take_over
            .request(
                &crate::providers::take_over::Target {
                    run_id: first_id.clone(),
                    wait,
                },
                identity.clone(),
            )
            .unwrap()
    });
    let (mut process, result, first) = task.await.unwrap();
    let Some(offer) = offer else {
        process.kill().await;
        panic!("The model never ended its turn while the agent worked: {result:?}");
    };
    let Some(hand_off) = process.hand_off.take() else {
        process.kill().await;
        let mut seen = vec![];
        while let Ok(event) = first_events.try_recv() {
            seen.push(serde_json::to_string(&event).unwrap());
        }
        let refusal = offer.await.map(|offer| offer.err());
        panic!(
            "The reply did not hand over ({refusal:?}): {result:?}\n{}",
            seen.join("\n")
        );
    };
    let (status, waiting_text) = result.expect("Installed CLI failed");
    process.turns += 1;
    drop(first);
    assert!(hand_off.send(Ok(process)).is_ok());
    let mut process = offer.await.unwrap().ok().unwrap();
    next.messages[1].text = waiting_text;
    next.native_session = crate::providers::sessions::Session::prepare(root.path(), &next).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &next,
            Some(&channel),
            CancellationToken::new(),
            None,
            Some(&mut next_questions),
            true,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    let ended = started.elapsed();
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = next_events.try_recv() {
        events.push(event);
    }
    let mut earlier = vec![];
    while let Ok(event) = reported.try_recv() {
        if let crate::background_work::Event::Tool(outcome) = event {
            if outcome.run_id == first_id {
                earlier.push(serde_json::to_value(&outcome.tool).unwrap());
            }
        }
    }
    assert_eq!(status, "complete");
    let (status, text) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let answered = answered
        .lock()
        .unwrap()
        .expect("The question was never answered");
    // The question was answered at once, and the reply then waited for the agent's report.
    assert!(answered < Duration::from_secs(30), "{answered:?}");
    assert!(
        ended > answered + Duration::from_secs(5),
        "{answered:?} {ended:?}"
    );
    let waits: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            RunEvent::BackgroundWait { wait } => Some(*wait),
            _ => None,
        })
        .collect();
    assert_eq!(waits.first(), Some(&Some(1)), "{waits:?}");
    assert_eq!(waits.last(), Some(&None), "{waits:?}");
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, RunEvent::Tool { tool } if tool.id == "claude:agents")),
        "the agent stays with the reply that started it"
    );
    let group = earlier
        .iter()
        .rfind(|tool| tool["id"] == "claude:agents")
        .expect("The agent's progress never reached the reply that started it");
    assert_eq!(group["agents"][0]["status"], "complete", "{group}");
    eprintln!(
        "Answered after {answered:?}, ended after {ended:?} with {text:?}; {} updates reached the earlier reply.",
        earlier.len()
    );
}

async fn reply_cost(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    reused: bool,
) -> (Result<(String, String), String>, Option<f64>) {
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        stream_turn(
            process,
            request,
            Some(&channel),
            CancellationToken::new(),
            None,
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    drop(channel);
    let mut cost = None;
    while let Ok(event) = received.try_recv() {
        if let RunEvent::Usage { usage } = event {
            cost = usage.cost_usd;
        }
    }
    (result, cost)
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity."]
async fn installed_claude_reply_costs_follow_each_process_running_total() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut messages = vec![];
    let mut process: Option<crate::pool::Process> = None;
    let (mut costs, mut totals) = (vec![], vec![]);
    // A new session, the same parked process, then a fresh process resuming the session.
    for (index, word) in ["ONE", "TWO", "THREE"].into_iter().enumerate() {
        messages.push(json!({"role":"user","text":format!("Reply with the single word {word}.")}));
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"haiku","instructions":""},"messages":messages})).unwrap();
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let reused = index == 1;
        if reused {
            let parked = process.as_mut().unwrap();
            parked.turns += 1;
            parked.park();
            parked.claim();
        } else {
            if let Some(mut previous) = process.take() {
                previous.kill().await;
            }
            let mut command = crate::providers::chat_command(&request, &runtime, &exe)
                .await
                .unwrap();
            process = Some(
                crate::pool::Process::new(
                    exe.clone(),
                    command.spawn().unwrap(),
                    "real-cost-test".into(),
                    request.native_session.as_ref().unwrap().id().to_string(),
                )
                .unwrap(),
            );
        }
        let (result, cost) = reply_cost(process.as_mut().unwrap(), &request, reused).await;
        let (status, text) = result.expect("Installed CLI failed");
        assert_eq!(status, "complete");
        assert!(text.contains(word), "{text}");
        costs.push(cost.expect("Each reply reports its own cost"));
        totals.push(process.as_ref().unwrap().cost_total);
        messages.push(json!({"role":"assistant","text":text}));
    }
    process.unwrap().kill().await;
    assert!(costs.iter().all(|cost| *cost > 0.0), "{costs:?}");
    // The CLI's total runs on within one process: the reused reply pays only its change.
    assert!((costs[0] - totals[0]).abs() < 1e-9, "{costs:?} {totals:?}");
    assert!(
        (costs[0] + costs[1] - totals[1]).abs() < 1e-9,
        "{costs:?} {totals:?}"
    );
    // A fresh process that resumes the session restarts the total, since parked processes
    // are terminated rather than exiting cleanly; this per-process accounting relies on it.
    assert!(totals[2] < totals[1], "{totals:?}");
    assert!((costs[2] - totals[2]).abs() < 1e-9, "{costs:?} {totals:?}");
    eprintln!("Reply costs {costs:?} for running totals {totals:?}.");
}

#[tokio::test]
#[ignore = "Opt-in installed Claude CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_claude_shows_its_question_while_it_writes_it() {
    use crate::providers::questions::{Answer, AnswerItem};
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "Before writing anything else, call mcp__agent_studio__studio_ask_user once to ask which color theme I prefer for a dashboard, with four options that each have a one-sentence description. After my answer, reply with the theme I chose.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"claude","model":"opus","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("claude").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = crate::pool::Process::new(
        exe,
        command.spawn().unwrap(),
        "real-question-test".into(),
        request.native_session.as_ref().unwrap().id().to_string(),
    )
    .unwrap();
    let hub = Questions::default();
    let started = std::time::Instant::now();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (answering, run_id) = (hub.clone(), request.run_id.clone());
    // The user picks the first choice as soon as the question can be answered.
    let channel = EventSink::new(move |event| {
        if let RunEvent::Question { question, .. } = &event {
            if question.status == "pending" {
                let answer = Answer {
                    request_id: question.id.clone(),
                    skipped: false,
                    answers: question
                        .questions
                        .iter()
                        .map(|q| AnswerItem {
                            id: q.id.clone(),
                            values: vec![q
                                .options
                                .first()
                                .map_or("Dark".into(), |o| o.label.clone())],
                        })
                        .collect(),
                };
                let (hub, run_id) = (answering.clone(), run_id.clone());
                tokio::spawn(async move { hub.answer(&run_id, None, answer).await });
            }
        }
        let _ = tx.send((started.elapsed(), event));
        Ok(())
    });
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        stream_turn(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            None,
            Some(&mut questions),
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(channel);
    let mut events = vec![];
    while let Ok(event) = received.try_recv() {
        events.push(event);
    }
    let (status, answer) = result.expect("Installed CLI failed");
    assert_eq!(status, "complete");
    let (asked_at, call) = events
        .iter()
        .find_map(|(at, e)| match e {
            RunEvent::Question { question, draft } if question.status == "pending" => {
                Some((*at, draft.clone().expect("The question replaces its draft")))
            }
            _ => None,
        })
        .expect("Claude asked no question");
    let written: Vec<(Duration, String)> = events
        .iter()
        .filter_map(|(at, e)| match e {
            RunEvent::QuestionDraft { question_draft } if question_draft.id == call => Some((
                *at,
                question_draft
                    .questions
                    .first()
                    .map(|q| q.question.clone())
                    .unwrap_or_default(),
            )),
            _ => None,
        })
        .collect();
    let first = written.first().expect("No draft before the question").0;
    let texts: std::collections::HashSet<_> = written.iter().map(|(_, t)| t).collect();
    // The question showed as it was written, well before its call could be answered.
    assert!(texts.len() >= 3, "{written:?}");
    assert!(
        asked_at > first + Duration::from_millis(500),
        "{written:?} {asked_at:?}"
    );
    assert!(written.iter().all(|(at, _)| *at <= asked_at));
    assert!(!answer.is_empty());
    eprintln!(
        "Draft shown at {first:?}, {} updates, question recorded at {asked_at:?}; answer: {answer}",
        written.len()
    );
}
