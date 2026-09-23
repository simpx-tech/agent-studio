//! Exercise the Claude stream-json turn loop with a controlled child: in-band interrupt,
//! a second turn on the same process, and the kill fallback when no result arrives.
#![cfg(windows)]
use super::*;
use crate::providers::questions::Questions;
use std::process::Stdio;

const FIXTURE: &str = r#"
$ErrorActionPreference = 'Stop'
$turn = 0
# Like the real CLI, results report the process's running cost total.
$total = 0d
function Cost([decimal]$amount) {
    $script:total += $amount
    return $script:total.ToString([Globalization.CultureInfo]::InvariantCulture)
}
$open = $false
while ($null -ne ($line = [Console]::ReadLine())) {
    $value = $line | ConvertFrom-Json
    $settingsLog = Join-Path (Split-Path $PSCommandPath) 'settings.jsonl'
    Add-Content -LiteralPath $settingsLog -Value $line
    if ($value.type -eq 'control_request' -and $value.request.subtype -in @('set_model', 'set_max_thinking_tokens')) {
        # Unrelated, stale and child responses must not release the next prompt.
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"error","request_id":"foreign","error":"PRIVATE"}}')
        [Console]::WriteLine('{"type":"result","subtype":"success","num_turns":1,"result":"STALE"}')
        $modeFile = Join-Path (Split-Path $PSCommandPath) 'settings-mode'
        $mode = if (Test-Path -LiteralPath $modeFile) { Get-Content -LiteralPath $modeFile } else { '' }
        if ($mode -eq 'exit') { exit 1 }
        if ($mode -eq 'hang') { continue }
        $status = if ($mode -eq 'reject' -or ($mode -eq 'partial' -and $value.request.subtype -eq 'set_max_thinking_tokens')) { 'error' } else { 'success' }
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"' + $status + '","request_id":"' + $value.request_id + '","error":"PRIVATE"}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'initialize') {
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '"}}')
        continue
    }
    if ($value.type -eq 'control_request' -and $value.request.subtype -eq 'stop_task') {
        [Console]::WriteLine('{"type":"system","subtype":"task_updated","task_id":"' + $value.request.task_id + '","patch":{"status":"killed"}}')
        [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"' + $value.request.task_id + '","status":"stopped"}')
        [Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"' + $value.request_id + '","response":{}}}')
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
        if ($value.message.content[0].text -like '/compact*') {
            [Console]::WriteLine('{"type":"system","subtype":"status","status":"compacting"}')
            if ($value.message.content[0].text -ne '/compact missing') {
                [Console]::WriteLine('{"type":"system","subtype":"compact_boundary","uuid":"boundary","compact_metadata":{"trigger":"manual","pre_tokens":90000,"post_tokens":5000}}')
            }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":""}')
            continue
        }
        [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
        $mode = $value.message.content[0].text
        if ($mode -like 'Await*') {
            # A dev server and a test run go to the background; only the tests are declared.
            foreach ($task in @('server', 'tests')) {
                [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"' + $task + '","content":[{"type":"tool_use","id":"' + $task + '-call","name":"Bash","input":{"run_in_background":true}}]}}')
                [Console]::WriteLine('{"type":"system","subtype":"task_started","task_id":"' + $task + '","tool_use_id":"' + $task + '-call","task_type":"local_bash"}')
                [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"' + $task + '-call","content":"Running in background"}]},"tool_use_result":{"backgroundTaskId":"' + $task + '"}}')
            }
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"await","content":[{"type":"tool_use","id":"await-call","name":"mcp__agent_studio__await_background_tasks","input":{"task_ids":["tests"]}}]}}')
            [Console]::WriteLine('{"type":"control_request","request_id":"await-request","request":{"subtype":"mcp_message","server_name":"agent_studio","message":{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"await_background_tasks","arguments":{"task_ids":["tests"]}}}}}')
            Add-Content -LiteralPath $settingsLog -Value ([Console]::ReadLine())
            [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"await-call","content":"Registered"}]}}')
            [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"waiting","content":[{"type":"text","text":"Waiting for tests"}]}}')
            if ($mode -in @('Await race', 'Await replay', 'Await lost')) {
                # The tests finish after the model's last request of this turn.
                [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"tests","status":"completed"}')
            }
            if ($mode -eq 'Await replay') {
                [Console]::WriteLine('{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":"<task-notification>\n<task-id>tests</task-id>\n<status>completed</status>\n</task-notification>"}}')
            }
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Waiting for tests","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
            if ($mode -eq 'Await') {
                Start-Sleep -Milliseconds 500
                [Console]::WriteLine('{"type":"system","subtype":"task_updated","task_id":"tests","patch":{"status":"completed"}}')
                [Console]::WriteLine('{"type":"system","subtype":"task_notification","task_id":"tests","status":"completed"}')
            }
            if ($mode -in @('Await', 'Await race')) {
                # The CLI re-invokes the model with the finished task.
                [Console]::WriteLine('{"type":"system","subtype":"init","session_id":"' + $env:STUDIO_TEST_SESSION + '","parent_tool_use_id":null}')
                [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"report","content":[{"type":"text","text":"Tests passed"}]}}')
                [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Tests passed","usage":{"input_tokens":20,"output_tokens":3},"total_cost_usd":' + (Cost 0.002d) + ',"origin":{"kind":"task-notification"}}')
            }
            continue
        }
        if (Test-Path -LiteralPath (Join-Path (Split-Path $PSCommandPath) 'tool-progress')) {
            [Console]::WriteLine('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"cmd","name":"Bash","input":{}}]}}')
            [Console]::WriteLine('{"type":"tool_progress","tool_use_id":"cmd","parent_tool_use_id":null,"tool_name":"Bash","elapsed_time_seconds":12.5,"message":"PRIVATE_OUTPUT"}')
            Start-Sleep -Milliseconds 2200
            [Console]::WriteLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"cmd","content":"PRIVATE_OUTPUT"}]}}')
            [Console]::WriteLine('{"type":"tool_progress","tool_use_id":"cmd","parent_tool_use_id":null,"elapsed_time_seconds":90}')
            [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Done"}')
            continue
        }
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg' + $turn + '"}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}')
        [Console]::WriteLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Compare paths."}}}')
        [Console]::WriteLine('{"type":"assistant","parent_tool_use_id":null,"message":{"id":"msg' + $turn + '","model":"fixture-model","content":[{"type":"thinking","thinking":"Compare paths."},{"type":"text","text":"Turn ' + $turn + '"}],"usage":{"input_tokens":10,"output_tokens":2}}}')
        if ($turn -eq 1 -and $env:STUDIO_TEST_HANG -eq 'true') {
            # Keep the turn open like a long tool call while still reading control requests.
            $open = $true
            continue
        }
        [Console]::WriteLine('{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"Turn ' + $turn + '","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":' + (Cost 0.001d) + '}')
    }
}
"#;

#[tokio::test]
async fn claude_tool_progress_native_loop_ticks_without_output_or_late_revival() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("tool-progress"), "enabled").unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Progress"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let (result, events) = turn(
        &mut process,
        &request,
        CancellationToken::new(),
        false,
        false,
    )
    .await;
    process.kill().await;
    assert_eq!(result.unwrap().0, "complete");
    assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
    let tools: Vec<_> = events
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Tool { tool } => Some(serde_json::to_value(tool).unwrap()),
            _ => None,
        })
        .collect();
    assert!(tools
        .iter()
        .any(|t| t["status"] == "running" && t["elapsedMs"].as_u64().unwrap_or(0) >= 13000));
    assert!(tools.last().unwrap()["elapsedMs"].as_u64().unwrap() < 90000);
    assert_eq!(tools.last().unwrap()["status"], "complete");
    assert_eq!(tools.last().unwrap()["progress"]["kind"], "heartbeat");
}

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

#[tokio::test]
async fn declared_background_tests_hold_the_reply_until_the_model_reports_them() {
    for (mode, text) in [
        ("Await", "Tests passed"),
        ("Await race", "Tests passed"),
        ("Await replay", "Waiting for tests"),
        ("Await lost", "Waiting for tests"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":mode}]),
        );
        let session = first.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &session, false, false);
        let started = std::time::Instant::now();
        let (result, events) =
            turn(&mut process, &first, CancellationToken::new(), false, false).await;
        assert_eq!(result.unwrap(), ("complete".into(), text.into()), "{mode}");
        assert!(process.alive() && process.healthy, "{mode}");
        if mode == "Await lost" {
            // The CLI started no turn for the finished tests, so the reply ends after the grace.
            assert!(started.elapsed() >= FOLLOW_UP_GRACE);
        }
        let waiting = events.iter().any(|e| {
            matches!(e, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        });
        assert_eq!(waiting, mode != "Await replay", "{mode}");
        let accepted = settings_input(root.path())
            .into_iter()
            .find(|v| v["response"]["request_id"] == "await-request")
            .unwrap();
        let result = &accepted["response"]["response"]["mcp_response"]["result"];
        assert_eq!(result["isError"], false, "{mode}");
        if text == "Tests passed" {
            // The reply's token counts cover both of its CLI turns.
            assert!(events.iter().any(|e| matches!(e, RunEvent::Usage { usage } if usage.input == Some(30) && usage.output == Some(5))));
        }
        let cost = |events: &[RunEvent], expected: f64| {
            events.iter().any(|e| matches!(e, RunEvent::Usage { usage } if usage.cost_usd.is_some_and(|c| (c - expected).abs() < 1e-9)))
        };
        let charged = if text == "Tests passed" { 0.003 } else { 0.001 };
        assert!(cost(&events, charged), "{mode}");
        // A follow-up turn's init must not leave the delivered message unconfirmed, and
        // the next reply pays only for itself although the CLI reports a running total.
        drop(first);
        process.turns += 1;
        process.park();
        process.claim();
        let next = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":mode},{"role":"assistant","text":text},{"role":"user","text":"Next"}]),
        );
        let session = next.native_session.as_ref().unwrap();
        assert!(
            session.resumed && session.unconfirmed_message.is_none(),
            "{mode}"
        );
        assert!(!session.instructions_changed, "{mode}");
        let (result, events) =
            turn(&mut process, &next, CancellationToken::new(), true, false).await;
        assert!(result.is_ok(), "{mode}");
        assert!(cost(&events, 0.001), "{mode}");
        process.kill().await;
    }
}

#[tokio::test]
async fn stop_while_waiting_stops_only_declared_work_and_keeps_the_process() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let request = request(
        root.path(),
        &conversation,
        serde_json::json!([{"role":"user","text":"Await stop"}]),
    );
    let session = request.native_session.as_ref().unwrap().id().to_string();
    let mut process = fixture(root.path(), &session, false, false);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let channel = EventSink::new(move |event| {
        // The CLI is idle between turns: an interrupt alone produces no result.
        if matches!(&event, RunEvent::Activity { text } if text == "Waiting for background work to finish")
        {
            stop.cancel();
        }
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
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
    .unwrap();
    assert_eq!(
        result.unwrap(),
        ("cancelled".into(), "Waiting for tests".into())
    );
    assert!(
        process.alive() && process.healthy,
        "acknowledged stops park the process without the kill fallback"
    );
    let stopped: Vec<_> = settings_input(root.path())
        .into_iter()
        .filter(|v| v["request"]["subtype"] == "stop_task")
        .map(|v| v["request"]["task_id"].clone())
        .collect();
    assert_eq!(stopped, ["tests"], "the dev server keeps running");
    process.kill().await;
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

fn settings_input(root: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(root.join("settings.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line.trim_start_matches('\u{feff}')).unwrap())
        .collect()
}

#[tokio::test]
async fn claude_settings_acknowledged_before_prompt_and_reused_without_restart() {
    let root = tempfile::tempdir().unwrap();
    let conversation = uuid::Uuid::new_v4().to_string();
    let mut messages = serde_json::json!([{"role":"user","text":"First"}]);
    let mut process = None;
    let mut first_pid = None;
    for (index, (model, budget)) in [
        ("fixture", Some(1024)),
        ("other", Some(4096)),
        ("other", Some(4096)),
        ("", Some(0)),
        ("", None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut r = request(root.path(), &conversation, messages.clone());
        r.agent.model = model.into();
        r.agent.max_thinking_tokens = budget;
        r.claude_default_model = Some("configured-default".into());
        if process.is_none() {
            let mut p = fixture(
                root.path(),
                r.native_session.as_ref().unwrap().id(),
                false,
                false,
            );
            p.fingerprint = crate::pool::fingerprint(&r, &p.exe).unwrap();
            first_pid = p.child.id();
            process = Some(p);
        }
        let p = process.as_mut().unwrap();
        if index > 0 {
            assert!(p.serves(
                &crate::pool::fingerprint(&r, &p.exe).unwrap(),
                r.native_session.as_ref().unwrap()
            ));
            p.claim();
        }
        let (result, _) = turn(p, &r, CancellationToken::new(), index > 0, false).await;
        assert_eq!(
            result.unwrap(),
            ("complete".into(), format!("Turn {}", index + 1))
        );
        assert_eq!(p.child.id(), first_pid);
        assert!(p.healthy && p.alive());
        p.turns += 1;
        p.park();
        messages.as_array_mut().unwrap().extend([
            serde_json::json!({"role":"assistant","text":format!("Turn {}", index + 1)}),
            serde_json::json!({"role":"user","text":"Next"}),
        ]);
    }
    process.as_mut().unwrap().kill().await;
    let input = settings_input(root.path());
    let controls: Vec<_> = input
        .iter()
        .filter(|v| v["type"] == "control_request" && v["request"]["subtype"] != "initialize")
        .map(|v| v["request"].clone())
        .collect();
    assert_eq!(
        controls,
        vec![
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":1024}),
            serde_json::json!({"subtype":"set_model","model":"other"}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":4096}),
            serde_json::json!({"subtype":"set_model","model":"configured-default"}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":0}),
            serde_json::json!({"subtype":"set_max_thinking_tokens","max_thinking_tokens":null}),
        ]
    );
    let order: Vec<_> = input
        .iter()
        .filter(|v| v["shouldQuery"] != false)
        .map(|v| {
            if v["type"] == "user" {
                "user"
            } else {
                v["request"]["subtype"].as_str().unwrap()
            }
        })
        .collect();
    assert_eq!(
        order,
        [
            "initialize",
            "set_max_thinking_tokens",
            "user",
            "set_model",
            "set_max_thinking_tokens",
            "user",
            "user",
            "set_model",
            "set_max_thinking_tokens",
            "user",
            "set_max_thinking_tokens",
            "user"
        ]
    );
}

#[tokio::test]
async fn claude_settings_failure_never_sends_the_prompt_or_reuses_partial_state() {
    for mode in ["reject", "partial", "exit", "cancel", "timeout"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let r = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let mut process = fixture(
            root.path(),
            r.native_session.as_ref().unwrap().id(),
            false,
            false,
        );
        assert!(
            turn(&mut process, &r, CancellationToken::new(), false, false)
                .await
                .0
                .is_ok()
        );
        drop(r);
        let before = process.claude_settings.clone();
        let mut r = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":"Must not send"}]),
        );
        r.agent.model = "other".into();
        r.agent.max_thinking_tokens = Some(4096);
        std::fs::write(
            root.path().join("settings-mode"),
            if matches!(mode, "cancel" | "timeout") {
                "hang"
            } else {
                mode
            },
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let result = stream_turn(&mut process, &r, None, cancel, None, None, true).await;
            (process, result)
        });
        if matches!(mode, "cancel" | "timeout") {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !settings_input(root.path())
                    .iter()
                    .any(|v| v["request"]["subtype"] == "set_model")
                {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            if mode == "cancel" {
                stop.cancel();
            } else {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(31)).await;
            }
        }
        let (mut process, result) = task.await.unwrap();
        if mode == "timeout" {
            tokio::time::resume();
        }
        if mode == "cancel" {
            assert_eq!(result.unwrap().0, "cancelled");
        } else {
            let error = result.unwrap_err();
            assert!(!error.contains("PRIVATE"));
            if mode == "timeout" {
                assert!(error.contains("30 seconds"));
            }
        }
        assert!(!process.healthy);
        assert_eq!(process.claude_settings, before);
        process.kill().await;
        assert_eq!(
            settings_input(root.path())
                .iter()
                .filter(|v| v["type"] == "user" && v["shouldQuery"] != false)
                .count(),
            1,
            "{mode}: no second human message"
        );
    }
}

#[tokio::test]
async fn manual_compaction_requires_a_boundary_and_keeps_the_native_process() {
    for command in ["/compact", "/compact missing"] {
        let root = tempfile::tempdir().unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let first = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"}]),
        );
        let id = first.native_session.as_ref().unwrap().id().to_string();
        let mut process = fixture(root.path(), &id, false, false);
        assert!(
            turn(&mut process, &first, CancellationToken::new(), false, false)
                .await
                .0
                .is_ok()
        );
        drop(first);
        let mut next = request(
            root.path(),
            &conversation,
            serde_json::json!([{"role":"user","text":"First"},{"role":"assistant","text":"Turn 1"},{"role":"user","text":command}]),
        );
        next.compact = true;
        let (result, events) =
            turn(&mut process, &next, CancellationToken::new(), true, false).await;
        if command == "/compact" {
            assert_eq!(
                result.unwrap(),
                ("complete".into(), "Context compacted.".into())
            );
            assert!(process.alive() && process.healthy);
            assert!(events.iter().any(
                |e| matches!(e, RunEvent::Compaction{compaction} if compaction.status == "complete")
            ));
        } else {
            assert!(result
                .unwrap_err()
                .contains("without confirming compaction"));
        }
        process.kill().await;
    }
}

async fn turn(
    process: &mut crate::pool::Process,
    request: &RunRequest,
    cancel: CancellationToken,
    reused: bool,
    interrupt_after_progress: bool,
) -> (Result<(String, String), String>, Vec<RunEvent>) {
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let stop = cancel.clone();
    let channel = EventSink::new(move |event| {
        // Process startup can exceed a fixed delay under full-suite load. Wait for
        // parent output so interruption exercises the active turn, not early Stop.
        if interrupt_after_progress && matches!(event, RunEvent::Progress { .. }) {
            stop.cancel();
        }
        events.send(event).map_err(|e| e.to_string())
    });
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
    let (result, _) = turn(&mut process, &first, cancel, false, true).await;
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
    let (result, events) = turn(&mut process, &second, CancellationToken::new(), true, false).await;
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
    let started = std::time::Instant::now();
    let (result, _) = turn(&mut process, &first, cancel, false, true).await;
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
    let (result, events) = turn(&mut process, &first, CancellationToken::new(), false, false).await;
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
