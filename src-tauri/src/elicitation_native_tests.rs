//! Real child processes exercise production stdin/stdout runners, including the
//! Claude fallback that previously rejected elicitation and Codex correlation.
use super::*;
use crate::providers::{elicitation::Input, questions::Questions, Executable};
use serde_json::json;
use std::process::Stdio;

#[tokio::test]
#[ignore = "Opt-in installed CLI account test with a disposable MCP server; may use subscription capacity."]
async fn elicitation_installed_clis_round_trip_through_the_production_runners() {
    for provider in ["claude", "codex"] {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("chat-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/elicitation-mcp-fixture.mjs")
            .canonicalize()
            .unwrap();
        // Node's Windows ESM entrypoint cannot use canonicalize's verbatim prefix.
        let fixture = fixture
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let request: RunRequest = serde_json::from_value(json!({"runId":run_id,"agent":{"provider":provider,"model":if provider=="claude" {"sonnet"} else {""},"instructions":""},"messages":[{"role":"user","text":"This is an MCP elicitation integration test. Call the elicitation_fixture MCP server's prompt tool with mode form exactly once, wait for its response, then call it with mode url exactly once. The client supplies synthetic answers. Do not answer on the user's behalf. Do not substitute studio_ask_user. Do not use files, shell, network, subagents, or any other integrations. You may discover this server's tool if necessary. After both results, reply ELICITATION_REAL_PASSED and the reported actions."}]})).unwrap();
        let mut request = request;
        // Claude Code 2.1.277 rejects URL mode before emitting a control request.
        // Both URL adapters remain covered by the deterministic runner test below.
        if provider == "claude" {
            request.messages[0].text = "This is an MCP elicitation integration test. Call elicitation_fixture's prompt tool with mode form exactly once, wait for the supplied synthetic answer, then reply ELICITATION_REAL_PASSED and the reported action. Discover that tool if needed; do not use any other tool, file, shell, network or subagent, and do not answer on the user's behalf.".into();
        }
        request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let exe = crate::providers::resolve(provider).await.unwrap();
        let mut command = crate::providers::chat_command(&request, &runtime, &exe)
            .await
            .unwrap();
        if provider == "claude" {
            command.args(["--strict-mcp-config", "--mcp-config"]).arg(
                json!({"mcpServers":{"elicitation_fixture":{"command":"node","args":[fixture]}}})
                    .to_string(),
            );
        } else {
            command.arg("-c").arg(format!(
                "mcp_servers.elicitation_fixture={{command=\"node\",args=[{}]}}",
                serde_json::to_string(&fixture).unwrap()
            ));
        }
        let mut process = crate::pool::Process::new(
            exe,
            command.spawn().unwrap(),
            "real-elicitation-test".into(),
            request.native_session.as_ref().unwrap().id().to_string(),
        )
        .unwrap();
        let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| {
            let _ = tx.send(event);
            Ok(())
        });
        let hub = Questions::default();
        let mut questions = hub.open(&run_id, None, channel.clone()).unwrap();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let provider_name = provider.to_string();
        let task = tokio::spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(180), async {
                if provider_name == "codex" {
                    crate::providers::codex_chat::run(
                        &mut process,
                        &request,
                        Some(&channel),
                        cancel,
                        &mut questions,
                        None,
                        false,
                    )
                    .await
                } else {
                    stream_turn(
                        &mut process,
                        &request,
                        Some(&channel),
                        cancel,
                        None,
                        Some(&mut questions),
                        false,
                    )
                    .await
                }
            })
            .await;
            process.kill().await;
            result
        });
        let mut modes = vec![];
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_secs(190), events.recv()).await
        {
            if let RunEvent::Elicitation { elicitation: r } = event {
                if r.status != "pending" {
                    continue;
                }
                let action = if r.mode == "form" {
                    "accept"
                } else {
                    "decline"
                };
                modes.push(r.mode.clone());
                hub.2
                    .manage(
                        &run_id,
                        None,
                        Input {
                            request_id: r.id,
                            action: Some(action.into()),
                            content: (action == "accept").then(|| json!({"name":"Ada"})),
                        },
                    )
                    .await
                    .unwrap();
            }
        }
        stop.cancel();
        let (status, text) = task
            .await
            .unwrap()
            .expect("Installed CLI test timed out")
            .expect("Installed CLI failed");
        assert_eq!(status, "complete");
        assert_eq!(
            modes,
            if provider == "claude" {
                vec!["form"]
            } else {
                vec!["form", "url"]
            },
            "{provider}: {text}"
        );
        assert!(text.contains("ELICITATION_REAL_PASSED"));
        eprintln!("{provider}: real MCP modes {modes:?} answered; native reply continued.");
    }
}

#[tokio::test]
async fn elicitation_native_runners_continue_after_form_and_url_accept_decline_cancel() {
    for provider in ["claude", "codex"] {
        for mode in ["form", "url"] {
            for action in ["accept", "decline", "cancel"] {
                let exe = Executable {
                    provider: provider.into(),
                    program: "node".into(),
                    prefix: vec![],
                    wsl: None,
                };
                let mut command = exe.command();
                command
                    .arg(
                        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("../scripts/elicitation-cli-fixture.mjs"),
                    )
                    .args([provider, action, mode])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                let mut process = crate::pool::Process::new(
                    exe,
                    command.spawn().unwrap(),
                    "fixture".into(),
                    String::new(),
                )
                .unwrap();
                let run_id = uuid::Uuid::new_v4().to_string();
                let request: RunRequest = serde_json::from_value(json!({"runId":run_id,"agent":{"provider":provider,"model":"fixture","instructions":""},"messages":[{"role":"user","text":"Elicitation fixture"}]})).unwrap();
                let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
                let channel = EventSink::new(move |event| {
                    tx.send(event).unwrap();
                    Ok(())
                });
                let hub = Questions::default();
                let mut questions = hub
                    .open(&run_id, Some("connection".into()), channel.clone())
                    .unwrap();
                let provider = provider.to_string();
                let run = tokio::spawn(async move {
                    let result = tokio::time::timeout(Duration::from_secs(15), async {
                        if provider == "codex" {
                            crate::providers::codex_chat::run(
                                &mut process,
                                &request,
                                Some(&channel),
                                CancellationToken::new(),
                                &mut questions,
                                None,
                                false,
                            )
                            .await
                        } else {
                            stream_turn(
                                &mut process,
                                &request,
                                Some(&channel),
                                CancellationToken::new(),
                                None,
                                Some(&mut questions),
                                false,
                            )
                            .await
                        }
                    })
                    .await;
                    process.kill().await;
                    result.unwrap().unwrap()
                });
                let receipt = tokio::time::timeout(Duration::from_secs(10), async {
                    while let Some(event) = events.recv().await {
                        if let RunEvent::Elicitation { elicitation } = event {
                            return elicitation;
                        }
                    }
                    panic!("Runner never displayed MCP input");
                })
                .await
                .unwrap();
                assert_eq!(receipt.mode, mode);
                hub.2
                    .manage(
                        &run_id,
                        Some("connection"),
                        Input {
                            request_id: receipt.id,
                            action: Some(action.into()),
                            content: (action == "accept" && mode == "form")
                                .then(|| json!({"name":"Ada"})),
                        },
                    )
                    .await
                    .unwrap();
                let (status, text) = run.await.unwrap();
                assert_eq!(status, "complete");
                assert!(text.contains("ELICITATION ROUNDTRIP PASSED"));
            }
        }
    }
}
