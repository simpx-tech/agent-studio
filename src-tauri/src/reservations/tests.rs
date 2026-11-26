use super::*;
use crate::protocol::activity::ToolDecoder;

fn broker_with(background: Vec<BackgroundWork>, history: Option<PathBuf>) -> Arc<Broker> {
    let broker = lulling(background, history);
    broker.set_settings(Settings { lull_minutes: 0.0 }).unwrap();
    broker
}

/// A broker whose reservations wait for a lull as this computer's setting says.
fn lulling(background: Vec<BackgroundWork>, history: Option<PathBuf>) -> Arc<Broker> {
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

/// A wait for the computer that does not tell what it waits for.
fn quiet(_: Option<&'static str>) {}

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
        text.starts_with("Reserved: from now on other chats' commands and MCP tool calls wait"),
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
        tokio::spawn(async move {
            broker
                .wait("bench", &CancellationToken::new(), &quiet)
                .await
        })
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
    assert!(
        report.text.contains("1 command or tool call waited"),
        "{}",
        report.text
    );
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
    // The window reads them back, leaving out a line the app did not finish writing.
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&history)
            .unwrap();
        write!(file, "{{\"id\":\"pc-9\",\"purp").unwrap();
    }
    let kept = broker.history();
    assert_eq!(kept.len(), 2);
    assert_eq!(kept[0]["purpose"], "First");
    assert!(broker_with(vec![], None).history().is_empty());
}

#[tokio::test]
async fn a_wait_ends_when_its_call_stops() {
    let broker = broker_with(vec![], None);
    broker.reserve("run-bench", "bench", "Benchmark", None);
    let cancel = CancellationToken::new();
    let waiting = {
        let (broker, cancel) = (broker.clone(), cancel.clone());
        tokio::spawn(async move { broker.wait("ui", &cancel, &quiet).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(broker.snapshot().reservations[0].held, 1);
    cancel.cancel();
    assert!(waiting.await.unwrap().unwrap_err().contains("Stopped"));
    assert_eq!(broker.snapshot().reservations[0].held, 0);
    // Not reserved: a wait returns at once.
    broker.release("bench");
    assert_eq!(
        broker
            .wait("ui", &CancellationToken::new(), &quiet)
            .await
            .unwrap(),
        "The computer is not reserved: run your command or tool call now."
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
    // A call that asks again is still one command that waited.
    assert!(broker
        .gate("ui", "cargo build", Some(&build.id), "pc_wait")
        .is_some());
    broker.tool("run-ui", &build);
    broker.tool("run-ui", &built);
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("During it, no other chat ran a command or an MCP tool call."),
        "{}",
        report.text
    );
    assert!(
        report.text.contains("1 command or tool call waited"),
        "{}",
        report.text
    );
    assert!(broker.lock().refused.is_empty());
}

/// A Claude call `id` of the MCP tool `name`, then the same call once it ended.
fn mcp_call(id: &str, name: &str) -> (ToolActivity, ToolActivity) {
    let mut decoder = ToolDecoder::default();
    let started = decoder
        .decode(
            "claude",
            &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":{"code":"print(1)"}}]}}),
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
    (started, ended)
}

#[tokio::test]
async fn other_chats_mcp_calls_wait_and_keep_the_window_closed_while_they_run() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    // A call that drives a program here, such as an editor through unreal-mcp, runs while the
    // reservation begins; one of claude.ai's connectors runs elsewhere.
    let (editor, edited) = mcp_call("e1", "mcp__unreal-mcp__execute_python");
    let (linear, _) = mcp_call("l1", "mcp__claude_ai_Linear__list_issues");
    assert_eq!(editor.connected(), Some(("unreal-mcp", "execute_python")));
    broker.tool("run-ui", &editor);
    broker.tool("run-ui", &linear);
    broker.reserve("run-bench", "bench", "Benchmark", None);
    let view = &broker.snapshot().reservations[0];
    assert_eq!(view.phase, "draining");
    assert_eq!(view.waiting_for.len(), 1);
    assert_eq!(view.waiting_for[0].label, "execute_python of unreal-mcp");
    broker.tool("run-ui", &edited);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // New calls wait like commands, but for the holder's own, Agent Studio's and connectors'.
    let reason = broker
        .gate_call("ui", "unreal-mcp", None, "pc_wait")
        .unwrap();
    assert!(reason.starts_with("This tool call did not run: the chat \"Chunk benchmark\""));
    assert!(reason.contains("then make the same call again"), "{reason}");
    assert!(broker
        .gate_call("bench", "unreal-mcp", None, "pc_wait")
        .is_none());
    for server in ["agent_studio", "claude_ai_Linear", "codex_apps"] {
        assert!(broker.gate_call("ui", server, None, "pc_wait").is_none());
    }
    let report = broker.release("bench").unwrap();
    assert!(
        report.text.contains("1 command or tool call waited"),
        "{}",
        report.text
    );
    // Agent Studio's own tools are no MCP server's.
    let (own, _) = mcp_call("s1", "mcp__agent_studio__pc_status");
    assert_eq!(own.connected(), None);
}

#[test]
fn held_time_goes_to_what_kept_the_window_closed() {
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let span = |label: &str, from: u64, until: u64| Span {
        key: label.into(),
        conversation: "ui".into(),
        label: label.into(),
        background: false,
        idle: false,
        woke: false,
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
        holding: Some(t0),
        opened: Some(at(6)),
        opened_at: None,
        blockers: vec![span("build", 0, 4), span("cook", 2, 6)],
        others: vec![],
        refused: 0,
        refused_calls: HashSet::new(),
        asks: vec![],
        stopped: vec![],
        frozen: vec![],
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
    let read = broker
        .wait("ui", &CancellationToken::new(), &quiet)
        .await
        .unwrap();
    assert!(
        read.starts_with("The chat \"Chunk benchmark\" (id bench), another agent working on this computer (not the user), holds it for a performance measurement (Benchmark) and asks you to hand over what you hold: Close the editor once you are done."),
        "{read}"
    );
    assert!(
        read.ends_with(
            "Your commands and tool calls run again until you hand over with pc_release."
        ),
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
        handed.starts_with("Handed over to the chat \"Chunk benchmark\" (id bench) for its measurement (Benchmark). This chat left no programs running. From now on your commands and MCP tool calls wait"),
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
        tokio::spawn(async move { broker.wait("ui", &CancellationToken::new(), &quiet).await })
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
            "The computer is still reserved: call pc_wait again before running a command or an MCP tool call."
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
    // What a chat stopped before reserving belongs to the reservation it makes next.
    broker.reserve("run-bench", "bench", "Benchmark", None);
    let report = broker.release("bench").unwrap();
    assert!(
        report.text.contains(
            "This chat stopped what another chat left running: its background work stopped with its CLI."
        ),
        "{}",
        report.text
    );
    assert_eq!(report.record["stopped"][0]["background"], true);
    assert_eq!(report.record["stopped"][0]["conversationId"], "srv");
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
    broker.jobs.adopt("ui", &cli, None);
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

/// A chat's CLI running `command` through a command of its own.
#[cfg(windows)]
fn cli_running(command: &str) -> tokio::process::Child {
    use std::os::windows::process::CommandExt;
    let mut cli = std::process::Command::new("cmd.exe");
    cli.raw_arg(format!("/C cmd /C \"{command}\""))
        .stdout(std::process::Stdio::null())
        .creation_flags(0x08000000);
    tokio::process::Command::from(cli).spawn().unwrap()
}

/// Background work a chat started that pings for two seconds, then starts another ping.
const BACKGROUND: &str = "ping -n 3 127.0.0.1 >NUL & ping -n 2 127.0.0.2 >NUL";

#[cfg(windows)]
async fn ends_within(child: &mut tokio::process::Child, time: Duration) -> bool {
    tokio::time::timeout(time, child.wait()).await.is_ok()
}

/// What work a chat that no longer replies began before the window opened starts while another
/// chat measures waits, frozen at birth, until the measurement ends.
#[cfg(windows)]
#[tokio::test]
async fn a_process_a_chat_s_work_starts_while_another_measures_waits_for_the_measurement() {
    let broker = broker_with(vec![], None);
    let mut cli = cli_running(BACKGROUND);
    broker.jobs.adopt("ui", &cli, None);
    tokio::time::sleep(Duration::from_millis(500)).await;
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // Three seconds of pings, held past six.
    assert!(!ends_within(&mut cli, Duration::from_secs(6)).await);
    let status = broker.status("bench", None);
    assert!(
        status.to_lowercase().contains(
            "processes other chats' programs started while your window is open wait for it to end: ping.exe (the chat \"fix inventory ui\")"
        ),
        "{status}"
    );
    let report = broker.release("bench").unwrap();
    assert!(
        report.text.to_lowercase().contains(
            "processes other chats' programs started while the window was open waited for it to end: ping.exe (the chat \"fix inventory ui\")."
        ),
        "{}",
        report.text
    );
    assert_eq!(report.record["frozen"][0]["conversationId"], "ui");
    assert_eq!(report.record["frozen"][0]["processes"], 1);
    // Released, the ping finishes.
    assert!(ends_within(&mut cli, Duration::from_secs(10)).await);
}

/// A replying chat's commands are its gate's to hold, and what a chat's CLI starts itself while
/// another measures, such as an MCP server, is its own: both run.
#[cfg(windows)]
#[tokio::test]
async fn what_a_chat_s_cli_starts_runs_while_another_measures() {
    let broker = broker_with(vec![], None);
    let mut replying = cli_running(BACKGROUND);
    broker.jobs.adopt("ui", &replying, None);
    broker.run_started("run-ui", "ui");
    tokio::time::sleep(Duration::from_millis(500)).await;
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Benchmark", None);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    let mut started = cli_running("ping -n 2 127.0.0.1 >NUL");
    broker.jobs.adopt("srv", &started, None);
    assert!(ends_within(&mut replying, Duration::from_secs(10)).await);
    assert!(ends_within(&mut started, Duration::from_secs(10)).await);
    let report = broker.release("bench").unwrap();
    assert_eq!(report.record["frozen"].as_array().map(Vec::len), Some(0));
}

fn reading(
    at: Instant,
    total_ms: u64,
    cores: u32,
    free: u64,
    processes: Vec<machine::Process>,
) -> machine::Reading {
    machine::Reading {
        at,
        busy_ms: 0,
        total_ms,
        memory_total: 64 << 30,
        memory_available: free,
        commit_available: Some(free),
        cores,
        processes,
    }
}
/// Eight cores, one build at a time, and room for it.
fn eight_cores() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 8, 32 << 30, vec![]))
}
/// Thirty-two cores with little memory left.
fn little_memory() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 32, 6 << 30, vec![]))
}
/// Thirty-two cores with room.
fn roomy() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 32, 40 << 30, vec![]))
}

/// What a wait told its reply, in order.
type Told = Arc<Mutex<Vec<Option<&'static str>>>>;

/// What a wait told its reply it waits for, in order.
fn heard() -> (Told, impl Fn(Option<&'static str>) + Send + Sync + 'static) {
    let heard = Arc::new(Mutex::new(vec![]));
    let tell = heard.clone();
    (heard, move |reason| tell.lock().unwrap().push(reason))
}

#[tokio::test]
async fn a_reservation_waits_for_a_lull_before_it_holds_other_chats() {
    let broker = lulling(vec![], None);
    broker.run_started("run-ui", "ui");
    let (build, built) = command("build", "Build.bat BluevoxEditor Win64 Development");
    broker.tool("run-ui", &build);
    let text = broker.reserve("run-bench", "bench", "Frame timing", None);
    assert!(
        text.starts_with("Reserved: your window opens at the first moment no other chat runs"),
        "{text}"
    );
    assert!(text.contains("within 3m 0s"), "{text}");
    let view = &broker.snapshot().reservations[0];
    assert_eq!(view.phase, "lull");
    assert!(view
        .holds_at
        .is_some_and(|at| at >= view.asked_at + 180_000));
    // Other chats work on meanwhile, and their waits return at once.
    assert!(broker.gate("ui", "npm test", None, "pc_wait").is_none());
    let free = broker
        .wait("ui", &CancellationToken::new(), &quiet)
        .await
        .unwrap();
    assert!(
        free.starts_with("A measurement waits for a moment"),
        "{free}"
    );
    let status = broker.status("ui", None);
    assert!(
        status.contains("waits for a moment when no other chat runs heavy work"),
        "{status}"
    );
    // The first moment nothing runs, the window opens and holds their new work.
    broker.tool("run-ui", &built);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    assert!(broker.gate("ui", "npm test", None, "pc_wait").is_some());
    let report = broker.release("bench").unwrap();
    assert!(
        report
            .text
            .contains("at a moment no other chat ran heavy work"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("Measurement: clean, no other heavy work ran"),
        "{}",
        report.text
    );
    assert_eq!(report.record["contaminated"], false);
}

#[tokio::test]
async fn without_a_lull_in_time_a_reservation_holds_other_chats_new_work() {
    let broker = lulling(vec![], None);
    // 30 milliseconds.
    broker
        .set_settings(Settings {
            lull_minutes: 0.0005,
        })
        .unwrap();
    broker.run_started("run-ui", "ui");
    let (build, built) = command("build", "Build.bat BluevoxEditor Win64 Development");
    broker.tool("run-ui", &build);
    broker.reserve("run-bench", "bench", "Frame timing", None);
    assert_eq!(broker.snapshot().reservations[0].phase, "lull");
    assert!(broker.gate("ui", "npm test", None, "pc_wait").is_none());
    tokio::time::sleep(Duration::from_millis(80)).await;
    broker.changed();
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    assert!(broker.gate("ui", "npm test", None, "pc_wait").is_some());
    broker.tool("run-ui", &built);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    let report = broker.release("bench").unwrap();
    assert!(
        report.text.contains("waiting for a lull, then"),
        "{}",
        report.text
    );
    assert!(report.record["lullMs"].as_u64().unwrap() >= 30);
    // A wait is a number of minutes, zero or more.
    assert!(broker
        .set_settings(Settings { lull_minutes: -1.0 })
        .is_err());
    assert!(broker
        .set_settings(Settings {
            lull_minutes: f64::NAN
        })
        .is_err());
}

#[tokio::test]
async fn the_setting_is_kept_beside_the_history() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("reservations").join("history.jsonl");
    let broker = lulling(vec![], Some(history.clone()));
    assert_eq!(broker.settings(), Settings::default());
    assert_eq!(Settings::default().lull_minutes, 3.0);
    broker
        .set_settings(Settings { lull_minutes: 10.0 })
        .unwrap();
    let again = lulling(vec![], Some(history));
    assert_eq!(again.settings().lull_minutes, 10.0);
}

#[tokio::test]
async fn a_measurement_beside_other_heavy_work_says_so_and_whose() {
    let broker = broker_with(vec![], None);
    broker.reserve("run-bench", "bench", "Frame timing", None);
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // A command another chat runs anyway, such as a Codex chat's without its gate.
    broker.run_started("run-codex", "codex");
    let (test, _) = command("test", "npm test");
    broker.tool("run-codex", &test);
    // And a program of the user's, busy over two readings of four cores.
    {
        let members = jobs::Members::default();
        let start = Instant::now();
        let mut state = broker.lock();
        for (second, chrome) in [(0, 0), (2, 3_000), (4, 6_000)] {
            let processes = vec![machine::Process {
                pid: 20,
                parent: 1,
                name: "chrome.exe".into(),
                cpu_ms: chrome,
                memory: 1 << 30,
                began: 20,
                system: false,
            }];
            let r = reading(
                start + Duration::from_secs(second),
                second * 4_000,
                4,
                32 << 30,
                processes,
            );
            let owners = machine::Owners::new(&r, &members, 1);
            state.queue[0].measure.add(r, &owners, "bench", false);
        }
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
    let report = broker.release("bench").unwrap();
    assert!(
        report.text.contains(
            "Measurement: ran beside other heavy work, so its numbers may be off: another chat ran `npm test` for"
        ),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("programs of yours (chrome.exe) at 38% of the CPU, 38% at most, for 4.0s"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .ends_with("Tell the user, and offer to measure again.")
            || report
                .text
                .contains("Tell the user, and offer to measure again.\n"),
        "{}",
        report.text
    );
    assert_eq!(report.record["contaminated"], true);
    assert_eq!(report.record["ranBeside"][0]["conversationId"], "codex");
    assert_eq!(report.record["ranBeside"][1]["owner"], "user");
    assert_eq!(report.record["ranBeside"][1]["name"], "chrome.exe");
    // A reservation whose window never opened measured nothing.
    broker.run_started("run-ui", "ui");
    let (build, _) = command("build", "Build.bat Game Win64 Shipping");
    broker.tool("run-ui", &build);
    broker.reserve("run-bench", "bench", "Frame timing", None);
    let unopened = broker.release("bench").unwrap();
    assert!(!unopened.text.contains("Measurement:"), "{}", unopened.text);
    assert!(unopened.record["contaminated"].is_null());
}

/// Settles the first reservation as it stands at `now`.
fn settle_at(broker: &Broker, now: Instant) {
    let mut state = broker.lock();
    let items = items(&state, &[], now);
    settle(&mut state, &items, now, broker.settings().lull());
}

/// A reading of `chat`'s work on this computer, `cores` busy from `from` to `until`.
fn read_work(broker: &Broker, chat: &str, cores: f64, from: Instant, until: Instant) {
    let mut state = broker.lock();
    let work = HashMap::from([(chat.to_string(), cores)]);
    heard_work(&mut state, false, [chat.to_string()], &work, from, until);
}

/// Ends the first reservation at `now`, as releasing it does, on a test's own timeline.
fn release_at(broker: &Broker, now: Instant) -> Report {
    let mut state = broker.lock();
    broker.end(&mut state, 0, now, "release")
}

#[tokio::test]
async fn idle_work_never_keeps_a_window_closed_and_stays_out_of_its_measurement() {
    let broker = lulling(vec![], None);
    broker.run_started("run-ui", "ui");
    let (watch, _) = command(
        "watch",
        "python3 watch-pr-comments.py 5201 --max-hours 3 --poll 90",
    );
    broker.tool("run-ui", &watch);
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Frame timing", None);
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    assert_eq!(broker.snapshot().reservations[0].phase, "lull");
    // A reading that found the watcher busy, then idle ones: the window waits until it has
    // stayed idle for ten seconds.
    read_work(&broker, "ui", 0.6, t0, at(2));
    read_work(&broker, "ui", 0.01, at(2), at(4));
    settle_at(&broker, at(4));
    assert_eq!(broker.snapshot().reservations[0].phase, "lull");
    for second in [6, 8, 10, 12] {
        read_work(&broker, "ui", 0.0, at(second - 2), at(second));
    }
    {
        let state = broker.lock();
        let standing = broker.standing(&state, "bench", &items(&state, &[], at(12)));
        assert!(
            standing.contains("Idle in other chats (the window does not wait for these while they stay idle):\n- the chat \"Fix inventory UI\": `python3 watch-pr-comments.py"),
            "{standing}"
        );
    }
    settle_at(&broker, at(12));
    let view = &broker.snapshot().reservations[0];
    assert_eq!(view.phase, "open");
    assert!(view.waiting_for.is_empty());
    // It stays idle while the window is open, so the measurement is clean.
    read_work(&broker, "ui", 0.0, at(12), at(14));
    settle_at(&broker, at(14));
    let report = release_at(&broker, at(16));
    assert!(
        report.text.contains(
            "It opened beside other chats' work that stayed idle: the chat \"Fix inventory UI\" `python3 watch-pr-comments.py"
        ),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("Measurement: clean, no other heavy work ran"),
        "{}",
        report.text
    );
    assert_eq!(report.record["contaminated"], false);
    assert_eq!(report.record["idle"][0]["conversationId"], "ui");
    assert_eq!(report.record["idle"][0]["ms"], 4_000);
    assert_eq!(report.record["others"].as_array().map(Vec::len), Some(0));
    // pc_status says which of other chats' work is idle.
    broker.run_started("run-x", "x");
    let (serve, _) = command("serve", "npm run dev");
    broker.tool("run-x", &serve);
    let now = Instant::now();
    let earlier = now.checked_sub(Duration::from_secs(12)).unwrap_or(now);
    read_work(&broker, "x", 0.0, earlier, now);
    let status = broker.status("bench", None);
    assert!(
        status.contains("`npm run dev` (idle, so a reservation's window does not wait for it)"),
        "{status}"
    );
}

#[tokio::test]
async fn idle_work_that_wakes_while_a_window_is_open_ran_beside_it() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    let (serve, _) = command("serve", "npm run dev");
    broker.tool("run-ui", &serve);
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Frame timing", None);
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    for second in [2, 4, 6, 8, 10, 12] {
        read_work(&broker, "ui", 0.02, at(second - 2), at(second));
    }
    settle_at(&broker, at(12));
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // Then it works: it ran beside the measurement.
    read_work(&broker, "ui", 1.5, at(12), at(14));
    settle_at(&broker, at(14));
    let report = release_at(&broker, at(16));
    assert!(
        report.text.contains(
            "Other chats' work that ran during it anyway: the chat \"Fix inventory UI\" `npm run dev`"
        ),
        "{}",
        report.text
    );
    assert!(
        report.text.contains(
            "Measurement: ran beside other heavy work, so its numbers may be off: the chat \"Fix inventory UI\" ran `npm run dev`"
        ),
        "{}",
        report.text
    );
    assert_eq!(report.record["contaminated"], true);
}

#[tokio::test]
async fn a_wsl_chat_s_work_is_idle_only_by_fresh_readings_inside_wsl() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    let (watch, _) = command("watch", "python3 watch.py");
    broker.tool("run-ui", &watch);
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Frame timing", None);
    broker.lock().in_wsl.insert("ui".into());
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let inside = |cores: Option<f64>, from: u64, until: u64| {
        let mut state = broker.lock();
        let work: HashMap<String, f64> = cores.map(|c| ("ui".to_string(), c)).into_iter().collect();
        heard_work(
            &mut state,
            true,
            ["ui".to_string()],
            &work,
            at(from),
            at(until),
        );
    };
    // This computer sees only the chat's wsl.exe, which does nothing.
    for second in (2..=16).step_by(2) {
        read_work(&broker, "ui", 0.0, at(second - 2), at(second));
    }
    settle_at(&broker, at(16));
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    // Inside WSL: a reading that could not read it counts as busy, then idle ones.
    inside(None, 0, 5);
    inside(Some(0.03), 5, 9);
    inside(Some(0.03), 9, 13);
    settle_at(&broker, at(14));
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    // Readings that stopped coming tell nothing.
    settle_at(&broker, at(40));
    assert_eq!(broker.snapshot().reservations[0].phase, "draining");
    // Once both have found it idle for ten seconds, the window opens.
    for second in (42..=52).step_by(2) {
        read_work(&broker, "ui", 0.0, at(second - 2), at(second));
        inside(Some(0.03), second - 2, second);
    }
    settle_at(&broker, at(52));
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
}

#[tokio::test]
async fn an_open_window_reads_inside_wsl_only_the_idle_work_it_opened_beside_and_rarely() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-ui", "ui");
    let (watch, _) = command("watch", "python3 watch.py");
    broker.tool("run-ui", &watch);
    broker.run_started("run-api", "api");
    let (test, tested) = command("test", "npm test");
    broker.tool("run-api", &test);
    broker.run_started("run-bench", "bench");
    let (own, _) = command("own", "cargo build");
    broker.tool("run-bench", &own);
    broker.reserve("run-bench", "bench", "Frame timing", None);
    broker.lock().in_wsl.insert("ui".into());
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let wanted = |now: Instant| {
        let state = broker.lock();
        let items = items(&state, &[], now);
        let mut wanted: Vec<String> = wanted_inside(&state, &items, now).into_iter().collect();
        wanted.sort();
        wanted
    };
    // While the window waits: every other chat with work in progress, never the holder.
    assert_eq!(wanted(at(0)), ["api", "ui"]);
    broker.lock().reading_wsl = true;
    assert!(wanted(at(0)).is_empty(), "one reading at a time");
    broker.lock().reading_wsl = false;
    // The tests end and the watcher stays idle: the window opens beside it.
    broker.tool("run-api", &tested);
    for second in (2..=12).step_by(2) {
        read_work(&broker, "ui", 0.0, at(second - 2), at(second));
        let mut state = broker.lock();
        let idle = HashMap::from([("ui".to_string(), 0.02)]);
        heard_work(
            &mut state,
            true,
            ["ui".to_string()],
            &idle,
            at(second - 2),
            at(second),
        );
    }
    settle_at(&broker, at(12));
    assert_eq!(broker.snapshot().reservations[0].phase, "open");
    // While it is open: the chat whose idle work it opened beside, every ten seconds.
    assert_eq!(wanted(at(12)), ["ui"]);
    broker.lock().read_wsl_at = Some(at(12));
    assert!(wanted(at(15)).is_empty());
    assert_eq!(wanted(at(22)), ["ui"]);
    // A reading inside WSL finds it working: it ran beside the measurement.
    {
        let mut state = broker.lock();
        let busy = HashMap::from([("ui".to_string(), 1.0)]);
        heard_work(&mut state, true, ["ui".to_string()], &busy, at(22), at(23));
    }
    settle_at(&broker, at(23));
    assert!(
        wanted(at(40)).is_empty(),
        "work that woke is no longer idle"
    );
    let report = release_at(&broker, at(25));
    assert!(
        report.text.contains(
            "Measurement: ran beside other heavy work, so its numbers may be off: the chat \"Fix inventory UI\" ran `python3 watch.py`"
        ),
        "{}",
        report.text
    );
    assert_eq!(report.record["contaminated"], true);
}

#[tokio::test]
async fn a_build_waits_for_a_slot_and_takes_the_one_its_turn_brings() {
    let broker = broker_with(vec![], None);
    broker.read_with(eight_cores);
    broker.run_started("run-ui", "ui");
    let (build, built) = command("build", "cargo build --release");
    broker.tool("run-ui", &build);
    // Another chat's build waits: one build at a time on eight cores.
    broker.run_started("run-art", "art");
    let reason = broker
        .gate(
            "art",
            "pwsh -File Tools/Build.ps1 -Target Bluevox",
            Some("claude:art-build"),
            "pc_wait",
        )
        .unwrap();
    assert!(
        reason.starts_with(
            "This build did not run: 1 build runs on this computer now (the chat \"Fix inventory UI\": `cargo build --release`), and this computer runs 1 build at once"
        ),
        "{reason}"
    );
    assert!(reason.contains("Call pc_wait"), "{reason}");
    // A command that is not a build runs.
    assert!(broker.gate("art", "npm test", None, "pc_wait").is_none());
    // A third chat's build waits behind it.
    broker.run_started("run-bench", "bench");
    let behind = broker.gate("bench", "cargo test", None, "pc_wait").unwrap();
    assert!(
        behind.contains("1 chat's build waits its turn before it"),
        "{behind}"
    );
    let waiting: Vec<String> = broker
        .snapshot()
        .slots
        .iter()
        .map(|s| s.conversation_id.clone())
        .collect();
    assert_eq!(waiting, ["art", "bench"]);
    assert!(broker
        .status("art", None)
        .contains("waits for a slot (1 in line"));
    // Its wait tells the reply it waits for a slot, and returns once the build ends.
    let (told, tell) = heard();
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("art", &CancellationToken::new(), &tell).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    broker.tool("run-ui", &built);
    let free = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        free.starts_with("A build slot is free for this chat after"),
        "{free}"
    );
    assert_eq!(*told.lock().unwrap(), [None, Some("slot"), None]);
    // The slot is its build's, ahead of the chat behind it.
    assert!(broker
        .gate("bench", "cargo test", None, "pc_wait")
        .is_some());
    assert!(broker
        .gate(
            "art",
            "pwsh -File Tools/Build.ps1 -Target Bluevox",
            None,
            "pc_wait"
        )
        .is_none());
    assert_eq!(broker.snapshot().slots.len(), 1);
    // A chat whose reply ends no longer waits.
    broker.run_ended("run-bench");
    assert!(broker.snapshot().slots.is_empty());
}

#[tokio::test]
async fn a_build_beside_others_needs_free_memory_and_time_for_the_last_to_grow() {
    let (build, _) = command("build", "cargo build");
    let broker = broker_with(vec![], None);
    broker.read_with(little_memory);
    broker.run_started("run-ui", "ui");
    broker.tool("run-ui", &build);
    let reason = broker.gate("art", "dotnet build", None, "pc_wait").unwrap();
    assert!(
        reason.contains(
            "a build beside them needs 10.0 GB of free memory (commit) and 6.0 GB is free"
        ),
        "{reason}"
    );
    // With room, one starts beside it, and the next waits while that one grows.
    let broker = broker_with(vec![], None);
    broker.read_with(roomy);
    broker.run_started("run-ui", "ui");
    broker.tool("run-ui", &build);
    assert!(broker
        .gate("art", "dotnet build", None, "pc_wait")
        .is_none());
    let reason = broker.gate("bench", "cargo test", None, "pc_wait").unwrap();
    assert!(reason.contains("the last build started"), "{reason}");
    // A build alone always starts.
    let broker = broker_with(vec![], None);
    broker.read_with(little_memory);
    assert!(broker
        .gate("art", "dotnet build", None, "pc_wait")
        .is_none());
}

#[tokio::test]
async fn named_reservations_take_turns_and_end_with_their_reply() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    let key = named::key(r"D:\bluevox-server-build");
    let held = broker.take_turn(
        "run-bench",
        "bench",
        &key,
        r"D:\bluevox-server-build",
        false,
        "Server build",
    );
    assert!(
        held.starts_with(r"This chat holds D:\bluevox-server-build now"),
        "{held}"
    );
    let asked = broker.take_turn(
        "run-ui",
        "ui",
        &named::key("d:/BLUEVOX-server-build/"),
        "d:/BLUEVOX-server-build/",
        false,
        "Mirror sources",
    );
    assert!(
        asked.starts_with(
            "Asked for d:/BLUEVOX-server-build/: the chat \"Chunk benchmark\" (id bench) holds it (Server build)"
        ),
        "{asked}"
    );
    // A turn holds nothing else.
    assert!(broker.gate("ui", "npm test", None, "pc_wait").is_none());
    let status = broker.status("ui", None);
    assert!(
        status.contains(
            r#"Named reservation, D:\bluevox-server-build: held by the chat "Chunk benchmark" (id bench) (Server build)"#
        ),
        "{status}"
    );
    assert!(status.contains("waiting: this chat"), "{status}");
    let turns = broker.snapshot().turns;
    assert_eq!(turns.len(), 2);
    assert!(turns[0].granted_at.is_some() && turns[1].granted_at.is_none());
    let (told, tell) = heard();
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("ui", &CancellationToken::new(), &tell).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    let released = broker.release_turns("bench", Some(&key)).unwrap();
    assert!(
        released.starts_with(r"Released D:\bluevox-server-build (Server build): this chat held it"),
        "{released}"
    );
    assert!(
        released.ends_with("The chat \"Fix inventory UI\" (id ui) has it now."),
        "{released}"
    );
    let came = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        came.starts_with("Your turn came after") && came.contains("d:/BLUEVOX-server-build/"),
        "{came}"
    );
    assert_eq!(*told.lock().unwrap(), [None, Some("turn"), None]);
    // The reply that took it ends: so does its turn, which the history keeps.
    broker.run_ended("run-ui");
    assert!(broker.snapshot().turns.is_empty());
    let records = read_history(&history);
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|r| r["kind"] == "turn"));
    assert_eq!(records[1]["endedBy"], "reply");
    assert_eq!(records[1]["conversationId"], "ui");
    assert!(broker.release_turns("ui", None).is_none());
}

#[tokio::test]
async fn reserving_again_soon_after_releasing_asks_for_one_reservation_a_series() {
    let broker = broker_with(vec![], None);
    broker.reserve("run-bench", "bench", "Run 1 of 5", None);
    broker.release("bench");
    let again = broker.reserve("run-bench", "bench", "Run 2 of 5", None);
    assert!(
        again.contains("keep one reservation for a whole series of measured runs"),
        "{again}"
    );
    // Another reply's reservation begins another series.
    broker.release("bench");
    let next = broker.reserve("run-bench-2", "bench", "After the fix", None);
    assert!(!next.contains("whole series"), "{next}");
}

/// Twenty gigabytes free on thirty-two cores.
fn twenty_free() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 32, 20 << 30, vec![]))
}

#[tokio::test]
async fn work_holds_the_memory_it_was_granted_and_a_run_beside_it_needs_room() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("reservations").join("history.jsonl");
    let broker = broker_with(vec![], Some(history));
    broker.read_with(twenty_free);
    broker.run_started("run-ui", "ui");
    // A build is granted what is left after a few gigabytes, and its script reads it from the
    // file its chat's environment names (requested 2026-11-26).
    let candidate = r".\Tools\Build.ps1 -Candidate";
    assert!(broker
        .gate("ui", candidate, Some("claude:build"), "pc_wait")
        .is_none());
    let (build, built) = command("build", candidate);
    broker.tool("run-ui", &build);
    let file = grant_file(folder.path(), "ui");
    let grant: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(grant["bytes"], 17u64 << 30);
    assert_eq!(grant["weight"], "build");
    let granted = broker.snapshot().grants;
    assert_eq!(granted.len(), 1);
    assert_eq!(
        (granted[0].conversation_id.as_str(), granted[0].weight),
        ("ui", "build")
    );
    // A game run beside it waits: the build has not taken its memory yet, and holds it.
    broker.run_started("run-art", "art");
    let game = r#"& "D:\p\Tools\Run-Game.ps1" -Mode net"#;
    let reason = broker.gate("art", game, None, "pc_wait").unwrap();
    assert!(
        reason.starts_with(
            "This run did not start: 1 build runs on this computer now (the chat \"Fix inventory UI\""
        ),
        "{reason}"
    );
    assert!(
        reason.contains(
            "a game or test run needs 8.0 GB of free memory (commit) and 3.0 GB is free beside the 17.0 GB held for the work started before it"
        ),
        "{reason}"
    );
    assert!(
        reason.contains("returns once there is room for it"),
        "{reason}"
    );
    let waiting = broker.snapshot().slots;
    assert_eq!(
        (waiting[0].conversation_id.as_str(), waiting[0].weight),
        ("art", "run")
    );
    // A dry run builds nothing and never waits; a build of a few files needs room of its own.
    assert!(broker
        .gate(
            "bench",
            r".\Tools\Build.ps1 -Candidate -WhatIf",
            None,
            "pc_wait"
        )
        .is_none());
    let check = broker
        .gate("bench", r".\Tools\Build.ps1 -Check", None, "pc_wait")
        .unwrap();
    assert!(
        check.contains(
            "a build of a few files needs 4.0 GB of free memory (commit) and 3.0 GB is free"
        ),
        "{check}"
    );
    // The grant ends once its call ended, the chat compiles no more and the build had time to
    // grow; its file goes with it.
    broker.tool("run-ui", &built);
    {
        let mut state = broker.lock();
        let now = Instant::now();
        assert!(!broker.settle_grants(&mut state, None, None, now));
        assert!(broker.settle_grants(&mut state, None, None, now + builds::RAMP));
    }
    assert!(!file.exists());
    assert!(broker.snapshot().grants.is_empty());
    // Then the run starts, granted what it needs.
    assert!(broker.gate("art", game, None, "pc_wait").is_none());
    let run: Value =
        serde_json::from_slice(&std::fs::read(grant_file(folder.path(), "art")).unwrap()).unwrap();
    assert_eq!(
        (run["weight"].as_str(), run["bytes"].as_u64()),
        (Some("run"), Some(8 << 30))
    );
    assert!(broker
        .snapshot()
        .slots
        .iter()
        .all(|s| s.conversation_id != "art"));
    // A grant whose work never started ends too, and a reply that ends ends its work's grant.
    {
        let mut state = broker.lock();
        let now = Instant::now();
        assert!(broker.settle_grants(&mut state, None, None, now + GRANT + builds::RAMP));
    }
    assert!(broker.snapshot().grants.is_empty());
}

#[tokio::test]
async fn the_window_names_the_chats_waiting_for_the_computer() {
    let broker = broker_with(vec![], None);
    broker.run_started("run-bench", "bench");
    broker.reserve("run-bench", "bench", "Frame timing", None);
    broker.run_started("run-ui", "ui");
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("ui", &CancellationToken::new(), &quiet).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    // Its row in the sidebar marks it (requested 2026-11-26).
    assert_eq!(broker.snapshot().waiting, ["ui"]);
    broker.release("bench");
    let free = waiting.await.unwrap().unwrap();
    assert!(free.starts_with("The computer is free again"), "{free}");
    assert!(broker.snapshot().waiting.is_empty());
}

#[tokio::test]
async fn a_chat_in_line_for_its_turn_waits_for_its_turn_while_another_measures() {
    let broker = broker_with(vec![], None);
    let key = named::key("github.com/simpx-tech/bluevox");
    broker.run_started("run-bench", "bench");
    broker.take_turn(
        "run-bench",
        "bench",
        &key,
        "github.com/simpx-tech/bluevox",
        true,
        "Final pipeline and push",
    );
    broker.run_started("run-ui", "ui");
    broker.take_turn(
        "run-ui",
        "ui",
        &key,
        "github.com/simpx-tech/bluevox",
        true,
        "Final pipeline and push",
    );
    // A third chat measures, and holds other chats' commands meanwhile.
    broker.run_started("run-perf", "perf");
    broker.reserve("run-perf", "perf", "Frame timing", None);
    let (told, tell) = heard();
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("ui", &CancellationToken::new(), &tell).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    // Its wait is for its turn, as its time report says, and no wait the measurement caused.
    assert_eq!(*told.lock().unwrap(), [None, Some("turn")]);
    assert!(broker.snapshot().waiting.is_empty());
    assert_eq!(broker.snapshot().reservations[0].held, 0);
    // Its turn comes while the measurement still holds the computer: from then on it waits for
    // the computer, whose window its commands could not run beside, and hears once both are its.
    broker.release_turns("bench", Some(&key));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    assert_eq!(*told.lock().unwrap(), [None, Some("turn"), Some("held")]);
    broker.release("perf");
    let came = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(came.starts_with("Your turn came after"), "{came}");
}
