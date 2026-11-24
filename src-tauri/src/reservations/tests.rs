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
    assert!(broker
        .gate("bench", "cargo build", None, "pc_wait")
        .is_none());
    assert!(broker.gate("ui", "git log -3", None, "pc_wait").is_none());
    let reason = broker
        .gate("ui", "Build.bat Game Win64 Shipping", None, "pc_wait")
        .unwrap();
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
    assert!(broker.gate("ui", "Build.bat", None, "pc_wait").is_none());
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
            "The chat \"Chunk benchmark\" (id bench) holds the computer (Benchmark); its window is open."
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
    assert!(broker.gate("ui", "cargo build", None, "pc_wait").is_some());
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

#[tokio::test]
async fn a_call_takes_its_command_once_claude_streams_it() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    let mut decoder = ToolDecoder::default();
    let mut call = |input: Value| {
        decoder
            .decode(
                "claude",
                &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"b1","name":"Bash","input":input}]}}),
            )
            .pop()
            .unwrap()
    };
    broker.tool("run-ui", &call(json!({})));
    broker.reserve("run-bench", "bench", "Benchmark", None);
    assert_eq!(
        broker.snapshot().reservations[0].waiting_for[0].label,
        "Run command"
    );
    broker.tool(
        "run-ui",
        &call(json!({"command":"Build.bat Game Win64 Development"})),
    );
    assert_eq!(
        broker.snapshot().reservations[0].waiting_for[0].label,
        "`Build.bat Game Win64 Development`"
    );
}

#[tokio::test]
async fn a_command_the_gate_refused_never_counts_as_run() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    // Claude Code reports the call as started before it asks the gate, which refuses it.
    let (build, built) = command("late", "cargo build");
    broker.tool("run-ui", &build);
    assert!(broker
        .gate("ui", "cargo build", Some(&build.id), "pc_wait")
        .is_some());
    broker.tool("run-ui", &build);
    broker.tool("run-ui", &built);
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("During it, no other chat ran a command."),
        "{}",
        report.text
    );
    assert!(report.text.contains("1 command waited"), "{}", report.text);
    assert!(broker.lock().refused.is_empty());
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
        refused_calls: HashSet::new(),
        asks: vec![],
        stopped: vec![],
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

#[tokio::test]
async fn a_chat_asked_to_hand_over_works_on_and_the_window_waits_for_it() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    broker.attach("run-ui", "ui", None);
    broker.reserve("run-bench", "bench", "Benchmark", None);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // Only the chat holding the computer asks another to hand over.
    let refused = broker
        .message("ui", "bench", "Mine first", true)
        .unwrap_err();
    assert!(
        refused.starts_with("Only the chat holding the computer"),
        "{refused}"
    );
    let sent = broker
        .message(
            "bench",
            "Fix inventory UI",
            "Close the editor once you are done.",
            true,
        )
        .unwrap();
    assert!(
        sent.contains("Your window stays closed until it hands over"),
        "{sent}"
    );
    // The open window closes again until it does.
    let view = &broker.snapshot().reservations[0];
    assert_eq!(view.phase, "draining");
    assert_eq!(view.waiting_for[0].conversation_id, "ui");
    assert_eq!(view.waiting_for[0].label, HANDING_OVER);
    // Its commands still run; other chats' wait.
    assert!(broker.gate("ui", "cargo build", None, "pc_wait").is_none());
    assert!(broker
        .gate("other", "cargo build", None, "pc_wait")
        .is_some());
    // A chat waiting for the computer reads the request at once.
    let read = broker.wait("ui", &CancellationToken::new()).await.unwrap();
    assert!(
        read.starts_with("The chat \"Chunk benchmark\" (id bench), another agent working on this computer (not the user), holds it for a performance measurement (Benchmark) and asks you to hand over what you hold: Close the editor once you are done."),
        "{read}"
    );
    assert!(
        read.ends_with("Your commands run again until you hand over with pc_release."),
        "{read}"
    );
    let status = broker.status("bench", None);
    assert!(
        status.contains("Asked the chat \"Fix inventory UI\" (id ui) to hand over: it read the request and has not handed over yet."),
        "{status}"
    );
    // Handing over opens the window, and its commands wait from then on.
    let handed = broker.hand_over("ui").await.unwrap().unwrap();
    assert!(
        handed.starts_with("Handed over to the chat \"Chunk benchmark\" (id bench) (Benchmark). This chat left no programs running. From now on your commands wait"),
        "{handed}"
    );
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    assert!(broker.gate("ui", "cargo build", None, "pc_wait").is_some());
    assert!(broker.hand_over("ui").await.is_none());
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("Before it opened: the chat \"Fix inventory UI\" handing over for"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("Asked the chat \"Fix inventory UI\" to hand over: it handed over"),
        "{}",
        report.text
    );
    assert_eq!(report.record["asks"][0]["ended"], HANDED_OVER);
    assert_eq!(report.record["asks"][0]["conversationId"], "ui");
}

#[tokio::test]
async fn an_ask_ends_with_the_reply_and_a_message_it_never_read_goes_back() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    broker
        .message("bench", "ui", "Hand over, please.", true)
        .unwrap();
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    broker.run_ended("run-ui");
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    let notice = broker.deliver("bench").unwrap();
    assert_eq!(
        notice,
        "Agent Studio: Your message to the chat \"Fix inventory UI\" (id ui) was not read: its reply ended first. pc_status lists what it left running, which pc_stop stops."
    );
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("Asked the chat \"Fix inventory UI\" to hand over: its reply ended"),
        "{}",
        report.text
    );
    assert_eq!(report.record["asks"][0]["ended"], REPLY_ENDED);
}

#[tokio::test]
async fn a_chat_that_read_an_ask_hears_when_the_measurement_no_longer_needs_it() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    broker
        .message("bench", "ui", "Hand over, please.", true)
        .unwrap();
    assert!(broker.deliver("ui").is_some());
    broker.release("bench");
    let notice = broker.deliver("ui").unwrap();
    assert!(
        notice.ends_with("no longer needs you to hand over: its measurement ended."),
        "{notice}"
    );
}

#[tokio::test]
async fn a_message_ends_a_wait_and_says_where_the_computer_stands() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("ui", &CancellationToken::new()).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!waiting.is_finished());
    broker
        .message("bench", "ui", "About ten minutes.", false)
        .unwrap();
    let read = waiting.await.unwrap().unwrap();
    assert!(read.contains("About ten minutes."), "{read}");
    assert!(
        read.ends_with(
            "The computer is still reserved: call pc_wait again before running a command."
        ),
        "{read}"
    );
    // Read once.
    assert!(broker.deliver("ui").is_none());
}

#[tokio::test]
async fn only_what_a_chat_that_no_longer_replies_left_running_is_stopped() {
    let background = vec![BackgroundWork {
        conversation: "srv".into(),
        id: "claude:server".into(),
        label: "npm run dev".into(),
    }];
    let broker = broker_with(background, None);
    let released = Arc::new(Mutex::new(vec![]));
    let record = released.clone();
    broker.set_release(Box::new(move |conversation| {
        record.lock().unwrap().push(conversation);
        Box::pin(async { true })
    }));
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    // A chat that replies hands over instead.
    let replying = broker.stop("bench", "ui", &[7], false).await.unwrap_err();
    assert!(
        replying.contains("is replying now: ask it to hand over"),
        "{replying}"
    );
    // A chat's own background work is its own to stop.
    let own = broker.stop("bench", "bench", &[], true).await.unwrap_err();
    assert!(
        own.starts_with("Stop this chat's own background work"),
        "{own}"
    );
    let nothing = broker.stop("bench", "srv", &[], false).await.unwrap_err();
    assert!(
        nothing.starts_with("Name the programs to stop"),
        "{nothing}"
    );
    let unknown = broker
        .stop("bench", "srv", &[4242], false)
        .await
        .unwrap_err();
    assert_eq!(
        unknown,
        "Another chat (id srv) left no program 4242 running. It left none."
    );
    // Its background work stops with its CLI.
    let stopped = broker.stop("bench", "srv", &[], true).await.unwrap();
    assert_eq!(
        stopped,
        "Its background work stopped with its CLI, which starts again with its next reply."
    );
    assert_eq!(*released.lock().unwrap(), ["srv"]);
}

/// A chat's CLI whose command started a program and let it go, as an editor started from a
/// command is: the program stays in the chat's job, outside its CLI's tree.
#[cfg(windows)]
#[tokio::test]
async fn handing_over_ends_the_programs_a_chat_left_running() {
    use std::os::windows::process::CommandExt;
    let broker = broker_with(vec![], None);
    let mut cli = std::process::Command::new("cmd.exe");
    cli.raw_arg("/C \"cmd /C start /B ping -n 120 127.0.0.1 >NUL & ping -n 120 127.0.0.2 >NUL\"")
        .stdout(std::process::Stdio::null())
        .creation_flags(0x08000000);
    let mut cli = tokio::process::Command::from(cli).spawn().unwrap();
    broker.jobs.adopt("ui", &cli);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    let mut left = vec![];
    for _ in 0..100 {
        left = programs::now(broker.jobs.members())
            .await
            .remove("ui")
            .unwrap_or_default();
        if !left.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(left.len(), 1, "{left:?}");
    assert_eq!(left[0].name.to_lowercase(), "ping.exe");
    assert!(!left[0].window);
    // The chat measuring reads it, with what to do about it.
    let now = machine::now(broker.jobs.members()).await.unwrap();
    let status = broker.status("bench", Some(&now));
    assert!(
        status.contains(&format!(
            "- the chat \"Fix inventory UI\" (id ui), replying (to have them closed, ask it to hand over with chat_message and hand_over: true): {} (program {}), ",
            left[0].name, left[0].pid
        )),
        "{status}"
    );
    broker.reserve("run-bench", "bench", "Benchmark", None);
    broker
        .message("bench", "ui", "Hand over, please.", true)
        .unwrap();
    let handed = broker.hand_over("ui").await.unwrap().unwrap();
    assert!(
        handed
            .to_lowercase()
            .contains("what this chat left running: ping.exe ended."),
        "{handed}"
    );
    assert!(programs::now(broker.jobs.members())
        .await
        .remove("ui")
        .unwrap_or_default()
        .is_empty());
    let report = broker.release("bench").unwrap();
    assert_eq!(report.record["asks"][0]["programs"][0]["outcome"], "ended");
    crate::runner::kill_tree(&mut cli).await;
}
