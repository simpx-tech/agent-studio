use super::*;
use crate::protocol::activity::ToolDecoder;

fn broker_with(background: Vec<BackgroundWork>, history: Option<PathBuf>) -> Arc<Broker> {
    Broker::new(
        Box::new(|_| {}),
        Box::new(|c| match c {
            "bench" => Some("Chunk benchmark".into()),
            "ui" => Some("Fix inventory UI".into()),
            _ => None,
        }),
        Box::new(move || background.clone()),
        history,
    )
}

/// A Claude command `id` that runs `command`, then the same call once it ended.
fn command(id: &str, command: &str) -> (ToolActivity, ToolActivity) {
    let mut decoder = ToolDecoder::default();
    let started = decoder
        .decode(
            "claude",
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Bash","input":{"command":command}}]}}),
        )
        .pop()
        .unwrap();
    let ended = decoder
        .decode(
            "claude",
            &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":"done"}]}}),
        )
        .pop()
        .unwrap();
    assert_eq!(started.status, "running");
    assert_ne!(ended.status, "running");
    (started, ended)
}

#[tokio::test]
async fn the_window_opens_once_other_chats_commands_finish() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    let (build, built) = command("build", "Build.bat BluevoxEditor Win64 Development");
    let (status, _) = command("status", "git status");
    broker.tool("run-ui", &build);
    broker.tool("run-ui", &status);
    broker.run_started("run-bench", "bench");
    let text = broker.reserve(
        "run-bench",
        "bench",
        "Benchmark of chunk meshing",
        Some(5.0),
    );
    assert!(
        text.starts_with("Reserved: from now on other chats' commands wait"),
        "{text}"
    );
    assert!(
        text.contains(
            "- the chat \"Fix inventory UI\": `Build.bat BluevoxEditor Win64 Development`"
        ),
        "{text}"
    );
    // A light command never keeps the window closed.
    assert!(!text.contains("`git status`"), "{text}");
    let view = &broker.snapshot().reservations[0];
    assert_eq!(view.phase, "draining");
    assert_eq!(view.waiting_for.len(), 1);
    assert_eq!(view.waiting_for[0].conversation_id, "ui");
    // The holder's own commands never keep its window closed.
    let (own, _) = command("own", "cargo build");
    broker.tool("run-bench", &own);
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    // The window opens when the build ends, and the holder's wait returns.
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("bench", &CancellationToken::new()).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!waiting.is_finished());
    broker.tool("run-ui", &built);
    let opened = waiting.await.unwrap().unwrap();
    assert!(opened.starts_with("The window is open"), "{opened}");
    assert!(
        opened.contains("Before it opened: the chat \"Fix inventory UI\" `Build.bat"),
        "{opened}"
    );
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
}

#[tokio::test]
async fn the_gate_counts_refusals_and_the_report_tells_what_happened() {
    let broker = broker_with(vec![], None);
    broker.reserve("run-bench", "bench", "Profile", None);
    assert!(broker.gate("bench", "cargo build").is_none());
    assert!(broker.gate("ui", "git log -3").is_none());
    let reason = broker.gate("ui", "Build.bat Game Win64 Shipping").unwrap();
    assert!(reason.contains("it has been measuring for"), "{reason}");
    assert!(reason.contains("pc_wait"), "{reason}");
    // A command another chat runs anyway, such as a Codex chat's, is in the report.
    broker.run_started("run-codex", "codex");
    let (test, _) = command("test", "npm test");
    broker.tool("run-codex", &test);
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("The window opened 0.0s after the reservation"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("Other chats' work that ran during it anyway: another chat `npm test`"),
        "{}",
        report.text
    );
    assert!(report.text.contains("1 command waited"), "{}", report.text);
    assert_eq!(report.record["held"]["refused"], 1);
    assert_eq!(report.record["endedBy"], "release");
    assert!(broker.release("bench").is_none());
    assert!(broker.gate("ui", "Build.bat").is_none());
}

#[tokio::test]
async fn the_window_waits_for_work_in_progress_but_not_for_work_left_running() {
    let background = vec![
        BackgroundWork {
            conversation: "srv".into(),
            id: "claude:server".into(),
            label: "npm run dev".into(),
        },
        BackgroundWork {
            conversation: "ui".into(),
            id: "claude:cook".into(),
            label: "Cook the game".into(),
        },
    ];
    let broker = broker_with(background, None);
    // Chat "ui" still replies, waiting for its background cook; chat "srv" left a server.
    broker.run_started("run-ui", "ui");
    let text = broker.reserve("run-bench", "bench", "Benchmark", None);
    assert!(text.contains("Still running in other chats (the window waits for these):\n- the chat \"Fix inventory UI\": background Cook the game"), "{text}");
    assert!(
        text.contains("Left running by other chats whose replies ended"),
        "{text}"
    );
    assert!(
        text.contains("- another chat: background npm run dev"),
        "{text}"
    );
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    // Its reply ended: the cook is left running now, and the window opens.
    broker.run_ended("run-ui");
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    let status = broker.status("other", None);
    assert!(
        status.starts_with(
            "The chat \"Chunk benchmark\" holds the computer (Benchmark); its window is open."
        ),
        "{status}"
    );
    assert!(
        status.contains("background Cook the game (left running after its reply ended)"),
        "{status}"
    );
}

#[tokio::test]
async fn reservations_take_turns_and_a_reply_that_ends_releases_its_own() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("reservations").join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    broker.reserve("run-bench", "bench", "First", None);
    let second = broker.reserve("run-ui", "ui", "Second", Some(2.0));
    assert!(
        second.starts_with("Reserved, after the chat \"Chunk benchmark\" (First)"),
        "{second}"
    );
    let view = broker.snapshot();
    assert_eq!(
        view.reservations
            .iter()
            .map(|r| r.phase)
            .collect::<Vec<_>>(),
        ["open", "queued"]
    );
    // The queued chat's own commands wait for the first too.
    assert!(broker.gate("ui", "cargo build").is_some());
    // Reserving again only brings the reservation up to date.
    broker.reserve("run-ui-2", "ui", "Second, again", None);
    assert_eq!(broker.snapshot().reservations.len(), 2);
    assert_eq!(broker.snapshot().reservations[1].purpose, "Second, again");
    assert_eq!(broker.snapshot().reservations[1].minutes, Some(2.0));
    broker.run_ended("run-bench");
    let view = broker.snapshot();
    assert_eq!(view.reservations.len(), 1);
    assert_eq!(view.reservations[0].conversation_id, "ui");
    assert_eq!(view.reservations[0].phase, "open");
    // The run id moved with the update: the old reply's end leaves it.
    broker.run_ended("run-ui");
    assert_eq!(broker.snapshot().reservations.len(), 1);
    broker.run_ended("run-ui-2");
    assert!(broker.snapshot().reservations.is_empty());
    let lines: Vec<Value> = std::fs::read_to_string(&history)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["purpose"], "First");
    assert_eq!(lines[0]["endedBy"], "reply");
    assert_eq!(lines[1]["purpose"], "Second, again");
}

#[tokio::test]
async fn a_wait_ends_when_its_call_stops() {
    let broker = broker_with(vec![], None);
    broker.reserve("run-bench", "bench", "Benchmark", None);
    let cancel = CancellationToken::new();
    let waiting = {
        let (broker, cancel) = (broker.clone(), cancel.clone());
        tokio::spawn(async move { broker.wait("ui", &cancel).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(broker.snapshot().reservations[0].held, 1);
    cancel.cancel();
    assert!(waiting.await.unwrap().unwrap_err().contains("Stopped"));
    assert_eq!(broker.snapshot().reservations[0].held, 0);
    // Not reserved: a wait returns at once.
    broker.release("bench");
    assert_eq!(
        broker.wait("ui", &CancellationToken::new()).await.unwrap(),
        "The computer is not reserved: run your command now."
    );
}

#[test]
fn held_time_goes_to_what_kept_the_window_closed() {
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let span = |label: &str, from: u64, until: u64| Span {
        key: label.into(),
        conversation: "ui".into(),
        label: label.into(),
        from: at(from),
        until: Some(at(until)),
    };
    let reservation = Reservation {
        id: "pc-1".into(),
        conversation: "bench".into(),
        run_id: "run".into(),
        purpose: "Benchmark".into(),
        minutes: None,
        asked: t0,
        asked_at: 0,
        first: Some(t0),
        opened: Some(at(6)),
        opened_at: None,
        blockers: vec![span("build", 0, 4), span("cook", 2, 6)],
        others: vec![],
        refused: 0,
        measure: machine::Window::default(),
    };
    let waits = vec![
        Wait {
            id: 1,
            conversation: "other".into(),
            from: at(1),
            until: Some(at(8)),
        },
        // The holder's own waits never count.
        Wait {
            id: 2,
            conversation: "bench".into(),
            from: at(0),
            until: Some(at(8)),
        },
    ];
    let held = held(&reservation, &waits, at(10));
    assert_eq!(held.chats, 1);
    assert_eq!(held.total, Duration::from_secs(7));
    // 1–2 the build alone, 2–4 both, 4–6 the cook alone; 6–8 the window itself.
    assert_eq!(
        held.causes
            .iter()
            .map(|(_, label, time)| (label.as_str(), time.as_secs()))
            .collect::<Vec<_>>(),
        [("cook", 3), ("build", 2)]
    );
}

#[test]
fn durations_read_as_the_app_writes_them() {
    assert_eq!(duration(Duration::from_millis(4_640)), "4.6s");
    assert_eq!(duration(Duration::from_millis(59_990)), "59.9s");
    assert_eq!(duration(Duration::from_secs(60)), "1m 0s");
    assert_eq!(duration(Duration::from_secs(28 * 60 + 31)), "28m 31s");
    assert_eq!(
        duration(Duration::from_secs(3600 + 7 * 60 + 32)),
        "1h 7m 32s"
    );
}

#[test]
fn labels_name_a_call_by_its_description_and_command() {
    let mut decoder = ToolDecoder::default();
    let tool = decoder
        .decode(
            "claude",
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"\n  RunUAT.bat BuildCookRun -project=game.uproject\nnext line","description":"Cook the game"}}]}}),
        )
        .pop()
        .unwrap();
    assert_eq!(
        label_of(&tool),
        "Cook the game `RunUAT.bat BuildCookRun -project=game.uproject`"
    );
    assert_eq!(shortened("abcdef", 3), "abc…");
    assert_eq!(shortened("ab", 3), "ab");
}
