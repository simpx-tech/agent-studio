//! Exercise the real protocol loop with a controlled child, without a model call
//! or an hour-long wall-clock wait. The child's gate is independent of Tokio time.
#![cfg(windows)]
use super::*;
use crate::{protocol::RunEvent, providers::questions::Questions};
use std::process::Stdio;

#[tokio::test]
async fn native_run_survives_two_hours_and_still_completes_or_cancels() {
    for waiting_for_answer in [false, true] {
        let folder = tempfile::tempdir().unwrap();
        let script = folder.path().join("provider.ps1");
        let gate = folder.path().join("finish");
        std::fs::write(&script, r#"
$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    switch ($request.method) {
        'initialize' { [Console]::WriteLine('{"id":1,"result":{}}') }
        'thread/start' { [Console]::WriteLine('{"id":2,"result":{"thread":{"id":"fixture"}}}') }
        'turn/start' {
            [Console]::WriteLine('{"id":3,"result":{"turn":{"id":"turn"}}}')
            if ($env:STUDIO_TEST_QUESTION -eq 'true') {
                [Console]::WriteLine('{"id":10,"method":"item/tool/call","params":{"threadId":"fixture","tool":"studio_ask_user","arguments":{"questions":[{"id":"choice","question":"Continue?"}]}}}')
            }
            [Console]::WriteLine('{"method":"item/agentMessage/delta","params":{"threadId":"fixture","itemId":"reply","delta":"READY"}}')
            if ($env:STUDIO_TEST_QUESTION -ne 'true') {
                while (-not (Test-Path -LiteralPath $env:STUDIO_TEST_GATE)) { Start-Sleep -Milliseconds 10 }
                [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn","status":"completed"}}}')
            }
        }
        'turn/interrupt' {
            [Console]::WriteLine('{"method":"turn/completed","params":{"threadId":"fixture","turn":{"id":"turn","status":"interrupted"}}}')
        }
    }
}
"#).unwrap();
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg(script)
            .env("STUDIO_TEST_GATE", &gate)
            .env("STUDIO_TEST_QUESTION", waiting_for_answer.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| events.send(event).map_err(|e| e.to_string()));
        let request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"fixture","instructions":""},"messages":[{"role":"user","text":"Controlled timer test"}]})).unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let mut task = tokio::spawn(async move {
            let mut questions = Questions::default()
                .open(&request.run_id, None, channel.clone())
                .unwrap();
            let result = run(
                &mut child,
                &request,
                Some(&channel),
                cancel,
                &mut questions,
                None,
            )
            .await;
            crate::runner::kill_tree(&mut child).await;
            result
        });
        let mut question_pending = false;
        tokio::time::timeout(Duration::from_secs(15), async {
            while let Some(event) = received.recv().await {
                match event {
                    RunEvent::Question { question } => {
                        question_pending = question.status == "pending"
                    }
                    RunEvent::Progress { text, .. } if text == "READY" => break,
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(question_pending, waiting_for_answer);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(7200)).await;
        tokio::time::resume();
        tokio::select! {
            result = &mut task => panic!("The native run expired after two simulated hours: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        if waiting_for_answer {
            stop.cancel();
        } else {
            std::fs::write(gate, "complete").unwrap();
        }
        let result = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            result.0,
            if waiting_for_answer {
                "cancelled"
            } else {
                "complete"
            }
        );
        assert_eq!(result.1, "READY");
    }
}
