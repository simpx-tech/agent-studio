//! The installed Codex CLI and the production loop: its app-server accepts Agent Studio's
//! dynamic tools on a new thread, and its model builds a screen through save_screen.
use super::*;
use crate::{protocol::RunEvent, providers::questions::Questions};
use std::sync::Arc;

/// The installed CLI takes Fast mode as each turn's service tier, on and off.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity, at the Fast tier's rate once."]
async fn installed_codex_answers_with_fast_mode_on_and_off() {
    for fast in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let runtime = root.path().join("chat-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":"","fastMode":fast},"messages":[{"role":"user","text":"This is an Agent Studio integration test. Run no tool. Reply with just the word OK."}]})).unwrap();
        request.validate().unwrap();
        request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
        request.native_session =
            crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
        let exe = crate::providers::resolve("codex").await.unwrap();
        let mut command = crate::providers::chat_command(&request, &runtime, &exe)
            .await
            .unwrap();
        let mut process = Process::new(
            exe,
            command.spawn().unwrap(),
            "real-fast-test".into(),
            String::new(),
        )
        .unwrap();
        let (tx, _received) = tokio::sync::mpsc::unbounded_channel();
        let channel = EventSink::new(move |event| {
            let _ = tx.send(event);
            Ok(())
        });
        let mut questions = Questions::default()
            .open(&request.run_id, None, channel.clone())
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(300),
            run(
                &mut process,
                &request,
                Some(&channel),
                CancellationToken::new(),
                &mut questions,
                None,
                false,
            ),
        )
        .await
        .expect("Installed CLI test timed out");
        process.kill().await;
        let (status, answer) = result.expect("Installed CLI failed");
        assert_eq!(status, "complete", "Fast mode {fast}");
        assert!(answer.contains("OK"), "Fast mode {fast}: {answer}");
        eprintln!("Fast mode {fast}: {answer}");
    }
}

#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_saves_a_screen_whose_action_runs_once_allowed() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let data = root.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let text = "This is an Agent Studio integration test. Call the save_screen tool once to save a screen titled Probe screen. Its html is a paragraph with id status that shows the passing count from await studio.json('count', { limit: 3 }). Give it exactly one action: name count, shell powershell, an integer parameter limit with minimum 1 and maximum 5, and a script that prints, with ConvertTo-Json -Compress, an object whose passing property is [int]$env:PARAM_LIMIT. Run no other tool and no command. Then reply with one short sentence.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-screen-test".into(),
        String::new(),
    )
    .unwrap();
    let screens = Arc::new(crate::screens::Screens::default());
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    })
    .with_screens(crate::screens::tools::Context::for_test(
        data.clone(),
        screens.clone(),
        &request,
    ));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
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
    let card = events
        .iter()
        .find_map(|event| match event {
            RunEvent::Screen { screen } => Some(screen.clone()),
            _ => None,
        })
        .expect("Codex saved no screen");
    assert_eq!(card.title, "Probe screen");
    let ask = |request: Value| {
        let (screens, root) = (screens.clone(), data.join("screens"));
        async move {
            screens
                .handle(
                    root,
                    "agent-studio-test".into(),
                    &crate::screens::mcp::Unlaunched,
                    serde_json::from_value(request).unwrap(),
                )
                .await
        }
    };
    let detail = ask(json!({"op":"read","id":card.id})).await.unwrap();
    assert_eq!(detail["actions"][0]["name"], "count", "{detail}");
    let run = json!({"op":"run","id":card.id,"action":"count","params":{"limit":3}});
    assert_eq!(
        ask(run.clone()).await.unwrap_err(),
        crate::screens::NOT_ALLOWED
    );
    ask(json!({"op":"approve","id":card.id,"digest":detail["digest"]}))
        .await
        .unwrap();
    let outcome = ask(run).await.unwrap();
    assert_eq!(outcome["exitCode"], 0, "{outcome}");
    let printed: Value = serde_json::from_str(outcome["stdout"].as_str().unwrap().trim()).unwrap();
    assert_eq!(printed["passing"], 3, "{outcome}");
    eprintln!(
        "Saved {} with {}; answer: {answer}",
        card.title, detail["actions"][0]["script"]
    );
}

/// A chat shows a page it wrote through its call of the show_artifact dynamic tool, which reads
/// the file where the chat runs and answers with the page as the viewer renders it: screenshots
/// as image items and the problems the preview found (a page too wide for a phone here).
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity, a model's tool choice and Edge or Chrome."]
async fn installed_codex_shows_an_artifact_and_reads_its_preview() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let page = root.path().join("probe.html");
    std::fs::write(&page, "<!doctype html><html><head><title>Probe page</title><style>body{margin:0;background:#fff;color:#111;font:16px system-ui}.wide{width:700px;height:40px;background:#c4e88c}</style></head><body><h1>Probe page</h1><div class=\"wide\"></div></body></html>").unwrap();
    let text = format!("This is an Agent Studio integration test. Call the show_artifact tool once with id probe, title Probe page and path {}. Run no command and change no file. Reply with one sentence naming the problems the preview reported, followed by <!-- artifact:probe --> on its own line.", page.display());
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-artifact-test".into(),
        String::new(),
    )
    .unwrap();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    });
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
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
    let artifact = events
        .iter()
        .find_map(|event| match event {
            RunEvent::Artifact { artifact } => Some(artifact.clone()),
            _ => None,
        })
        .expect("Codex showed no artifact");
    assert_eq!(artifact.id, "probe");
    assert!(artifact.source.contains("<h1>Probe page</h1>"));
    assert!(answer.contains("<!-- artifact:probe -->"), "{answer}");
    let told = answer.to_lowercase();
    assert!(
        told.contains("sideways") || told.contains("scroll") || told.contains("wide"),
        "{answer}"
    );
    eprintln!("Answer: {answer}");
}

/// A chat compares two files through its call of the compare_files dynamic tool, which checks
/// both where the chat runs and records them as one comparison, each file with its label.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_compares_two_files_side_by_side() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let [before, after] = [("before.png", 4, 3), ("after.png", 8, 6)].map(|(name, w, h)| {
        let path = root.path().join(name);
        crate::providers::sent_files::test_png(&path, w, h);
        path.display().to_string()
    });
    let text = format!("This is an Agent Studio integration test. Call the compare_files tool once with id pair, the two files {before} and {after} in that order, and the labels Before and After. Run no command and change no file. Reply with one short sentence followed by <!-- files:pair --> on its own line.");
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-compare-test".into(),
        String::new(),
    )
    .unwrap();
    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel();
    let channel = EventSink::new(move |event| {
        let _ = tx.send(event);
        Ok(())
    })
    .with_outputs(crate::tool_output::Recorder::detached(&request.run_id));
    let mut questions = Questions::default()
        .open(&request.run_id, None, channel.clone())
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
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
    let shown = events
        .iter()
        .find_map(|event| match event {
            RunEvent::SentFiles { sent_files } => Some(sent_files.clone()),
            _ => None,
        })
        .expect("Codex compared no files");
    assert_eq!(shown.id, "pair");
    assert!(shown.compare);
    let files: Vec<_> = shown
        .files
        .iter()
        .map(|file| (file.name.as_str(), file.label.as_deref(), file.width))
        .collect();
    assert_eq!(
        files,
        [
            ("before.png", Some("Before"), Some(4)),
            ("after.png", Some("After"), Some(8))
        ]
    );
    assert!(answer.contains("<!-- files:pair -->"), "{answer}");
    eprintln!("Answer: {answer}");
}

/// An orchestrator's Codex thread starts with the workflow tools as dynamic tools, and its calls
/// reach this computer's window, here a stand-in, whose answers reach the model.
#[tokio::test]
#[ignore = "Opt-in installed Codex CLI test; uses subscription capacity and a model's tool choice."]
async fn installed_codex_answers_workflow_tools_through_the_window() {
    use crate::providers::workflow_calls::{Binding, Call, Context};
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("chat-runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    let text = "This is an Agent Studio integration test. Call the workflow_list tool once, then call the mission_state tool once. Run no other tool and no command. Then reply with one short sentence naming the workflow and the mission title they report.";
    let mut request: RunRequest = serde_json::from_value(json!({"runId":uuid::Uuid::new_v4(),"agent":{"provider":"codex","model":"","reasoning":"low","instructions":""},"messages":[{"role":"user","text":text}]})).unwrap();
    request.conversation_id = Some(uuid::Uuid::new_v4().to_string());
    let mission = Binding {
        run_id: uuid::Uuid::new_v4().to_string(),
        role: "orchestrator".into(),
    };
    request.mission = Some(mission.clone());
    request.native_session =
        crate::providers::sessions::Session::prepare(root.path(), &request).unwrap();
    let exe = crate::providers::resolve("codex").await.unwrap();
    let mut command = crate::providers::chat_command(&request, &runtime, &exe)
        .await
        .unwrap();
    let mut process = Process::new(
        exe,
        command.spawn().unwrap(),
        "real-workflow-test".into(),
        String::new(),
    )
    .unwrap();
    let channel = EventSink::new(|_| Ok(()));
    let hub = Questions::default();
    let mut questions = hub.open(&request.run_id, None, channel.clone()).unwrap();
    let (calls, mut heard) = tokio::sync::mpsc::unbounded_channel::<Call>();
    questions.workflow.attach(Some(Context {
        conversation_id: request.conversation_id.clone().unwrap(),
        connection_id: None,
        mission: Some(mission.clone()),
        emit: Arc::new(move |call: &Call| {
            let _ = calls.send(call.clone());
        }),
    }));
    let window = {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut tools = vec![];
            while let Some(call) = heard.recv().await {
                tools.push(call.tool.clone());
                let text = match call.tool.as_str() {
                    "workflow_list" => json!({"workflows":[{"id":"w1","name":"Nightly report","steps":3}],"runs":[]}).to_string(),
                    "mission_state" => json!({"mission":{"title":"Probe mission","status":"running"}}).to_string(),
                    other => format!("Unexpected tool {other}"),
                };
                let _ = hub
                    .4
                    .answer(&call.run_id, None, &call.id, text, false)
                    .await;
            }
            tools
        })
    };
    let result = tokio::time::timeout(
        Duration::from_secs(300),
        run(
            &mut process,
            &request,
            Some(&channel),
            CancellationToken::new(),
            &mut questions,
            None,
            false,
        ),
    )
    .await
    .expect("Installed CLI test timed out");
    process.kill().await;
    drop(questions);
    let (status, answer) = result.expect("Installed CLI failed");
    let tools = tokio::time::timeout(Duration::from_secs(5), window)
        .await
        .ok()
        .and_then(|t| t.ok())
        .unwrap_or_default();
    assert_eq!(status, "complete");
    assert!(tools.contains(&"workflow_list".to_string()), "{tools:?}");
    assert!(tools.contains(&"mission_state".to_string()), "{tools:?}");
    assert!(answer.contains("Nightly report"), "{answer}");
    assert!(answer.contains("Probe mission"), "{answer}");
    eprintln!("Tools {tools:?}; answer: {answer}");
}
