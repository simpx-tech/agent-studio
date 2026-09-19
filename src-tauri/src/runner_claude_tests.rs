//! Exercise the Claude stream-json turn loop with a controlled child: in-band interrupt,
//! a second turn on the same process, and the kill fallback when no result arrives.
#![cfg(windows)]
use super::*;
use crate::providers::questions::Questions;
use std::process::Stdio;

const FIXTURE: &str = r#"
$ErrorActionPreference = 'Stop'
$turn = 0
$open = $false
while ($null -ne ($line = [Console]::ReadLine())) {
    $value = $line | ConvertFrom-Json
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'initialize') {
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '"}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'interrupt') {
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '"}}')
        if ($open -and $env:STUDIO_TEST_SILENT_INTERRUPT -ne 'true') {
            [Console]::WriteLine('{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"result":""}')
        }
        $open = $false
        continue
    }
    if ($value.type -eq 'user') {
        if ($open -and $value.uuid) {
            if ($value.message.content[0].text -ne 'Race completion') { [Console]::WriteLine($line) }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"STEERED"}')
            continue
        }
        if ($value.shouldQuery -eq $false) {
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}')
            continue
        }
        $turn += 1
        [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg' + $turn + '"}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Compare paths."}}}')
        [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg' + $turn + '","model":"fixture-model","content":[{"type":"thinking","thinking":"Compare paths."},{"type":"text","text":"Turn ' + $turn + '"}],"usage":{"input_tokens":10,"output_tokens":2}}}')
        if ($turn -eq 1 -and $env:STUDIO_TEST_HANG -eq 'true') {
            # Keep the turn open like a long tool call while still reading control requests.
            $open = $true
            continue
        }
        [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Turn ' + $turn + '","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":0.001}')
    }
}
"#;

#[tokio::test]
async fn steering_requires_the_human_echo_and_kills_unconfirmed_input_at_completion() {
    for text in ["Correction", "Race completion"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let mut process = fixture(
            root.path(),
            first.native_session.as_ref().unwrap().id(),
            true,
            false,
        );
        let hub = Questions::default();
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string()));
        let mut questions = hub.open(&first.run_id, None, channel.clone()).unwrap();
        let run_id = first.run_id.clone();
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
            let healthy = process.healthy;
            process.kill().await;
            (result, healthy)
        });
        while let Some(e) = events.recv().await {
            if matches!(e, RunEvent::Progress { .. }) {
                break;
            }
        }
        let sent = hub
            .1
            .send(
                &run_id,
                None,
                crate::providers::steering::Input {
                    id: uuid::Uuid::new_v4().to_string(),
                    text: text.into(),
                },
            )
            .await;
        let (result, healthy) = task.await.unwrap();
        assert_eq!(sent.is_ok(), text == "Correction");
        assert_eq!(healthy, text == "Correction");
        assert_eq!(result.unwrap().0, "complete");
    }
}

/// The real CLI is launched with the binding's --session-id, so the fixture echoes it.
fn fixture(
    root: &std::path::Path,
    session: &str,
    hang: bool,
    silent_interrupt: bool,
) -> crate::pool::Process {
    let script = root.join("claude.ps1");
    std::fs::write(&script, FIXTURE).unwrap();
    let exe = crate::providers::Executable {
        provider: "claude".into(),
        program: "powershell.exe".into(),
        prefix: vec![],
        wsl: None,
    };
    let mut command = exe.command();
    command
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(script)
        .env("STUDIO_TEST_SESSION", session)
        .env("STUDIO_TEST_HANG", hang.to_string())
        .env("STUDIO_TEST_SILENT_INTERRUPT", silent_interrupt.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = command.spawn().unwrap();
    crate::pool::Process::new(exe, child, "fixture".into(), session.into()).unwrap()
}

fn request(root: &std::path::Path, conversation: &str, messages: serde_json::Value) -> RunRequest {
    let mut request: RunRequest = serde_json::from_value(serde_json::json!({"runId":uuid::Uuid::new_v4(),"conversationId":conversation,"agent":{"provider":"claude","model":"fixture","instructions":""},"messages":messages})).unwrap();
    request.native_session = crate::providers::sessions::Session::prepare(root, &request).unwrap();
    assert!(request.native_session.is_some());
    request
}

async fn turn(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    cancel: CancellationToken,
    reused: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>) {
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| events.send(event).map_err(|e| e.to_string()));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        stream_turn(
            process,
            request,
            Some(&channel),
            cancel,
            None,
            Some(&mut questions),
            reused,
        ),
    )
    .await
    .expect("the turn must finish");
    drop(channel);
    let mut all = vec![];
    while let Ok(event) = received.try_recv() {
        all.push(event);
    }
    (result, all)
}

#[tokio::test]
async fn interrupt_keeps_the_process_and_the_next_reply_reuses_it() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, true, false);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        stop.cancel();
    });
    let (result, _) = turn(&mut process, &first, cancel, false).await;
    assert_eq!(result.unwrap().0, "cancelled");
    assert!(
        process.alive() && process.healthy,
        "an acknowledged interrupt keeps the CLI"
    );
    drop(first);
    process.turns += 1;
    process.park();
    process.claim();
    let second = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":"Second"}]),
    );
    let session = second.native_session.as_ref().unwrap();
    assert!(session.resumed);
    assert_eq!(session.id(), session_id);
    let (result, events) = turn(&mut process, &second, CancellationToken::new(), true).await;
    assert_eq!(
        result.unwrap(),
        ("complete".to_string(), "Turn 2".to_string())
    );
    assert!(process.alive() && process.healthy);
    assert!(events
        .iter()
        .any(|e| matches!(e, RunEvent::Usage { usage } if usage.cost_usd == Some(0.001))));
    process.kill().await;
    assert!(!process.alive());
}

#[tokio::test]
async fn an_unconfirmed_interrupt_falls_back_to_killing_the_process() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"First"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, true, true);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        stop.cancel();
    });
    let started = std::time::Instant::now();
    let (result, _) = turn(&mut process, &first, cancel, false).await;
    assert_eq!(result.unwrap().0, "cancelled");
    assert!(started.elapsed() >= crate::pool::INTERRUPT_GRACE);
    assert!(!process.healthy);
    assert!(!process.alive());
}

#[tokio::test]
async fn a_completed_turn_leaves_the_process_waiting_for_input() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let first = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Only"}]),
    );
    let session_id = first.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session_id, false, false);
    let (result, events) = turn(&mut process, &first, CancellationToken::new(), false).await;
    assert_eq!(
        result.unwrap(),
        ("complete".to_string(), "Turn 1".to_string())
    );
    assert!(process.alive() && process.healthy);
    assert!(events
        .iter()
        .any(|e| matches!(e, RunEvent::Text { text } if text == "Turn 1")));
    let reasoning: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, RunEvent::Reasoning { .. }))
        .collect();
    assert_eq!(
        reasoning.len(),
        1,
        "The full block must not duplicate its streamed text"
    );
    assert!(
        matches!(reasoning[0], RunEvent::Reasoning { id, text, revision: 1, truncated: false } if id == "msg1:0" && text == "Compare paths.")
    );
    process.kill().await;
}
