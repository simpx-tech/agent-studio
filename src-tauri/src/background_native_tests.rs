//! The installed Claude CLI and the production runner: a reply waits for the tests the
//! model declared, never for a server it left running, and Stop ends a waiting reply.
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
    // Activity shows commands by description only; keep the final status of each.
    let mut commands = std::collections::HashMap::new();
    for event in &events {
        if let RunEvent::Tool { tool } = event {
            let tool = serde_json::to_value(tool).unwrap();
            if tool["operation"] == "command" {
                commands.insert(tool["id"].to_string(), tool["status"].clone());
            }
        }
    }
    let statuses: Vec<_> = commands.values().collect();
    assert!(
        statuses.contains(&&json!("running")),
        "the server outlives the reply: {statuses:?}"
    );
    assert!(statuses.contains(&&json!("complete")), "{statuses:?}");
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
