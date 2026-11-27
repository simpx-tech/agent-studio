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
        scope: Scope::Computer,
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
async fn named_reservations_take_turns_and_outlive_their_reply_a_few_minutes() {
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
    // The reply that took it ends, as a message the user sends ends one: the turn waits a few
    // minutes for its chat's next reply, which takes it on (requested 2026-11-26).
    broker.run_ended("run-ui");
    let kept = broker.snapshot().turns;
    assert_eq!(kept.len(), 1);
    assert!(kept[0].granted_at.is_some() && kept[0].kept_until.is_some());
    let status = broker.status("bench", None);
    assert!(
        status.contains("whose reply ended")
            && status.contains("unless a reply of that chat takes it on"),
        "{status}"
    );
    broker.watch_at(None, &[], Instant::now() + TURN_KEEP / 2);
    broker.run_started("run-ui-2", "ui");
    let taken = broker.snapshot().turns;
    assert_eq!(taken.len(), 1);
    assert!(taken[0].granted_at.is_some() && taken[0].kept_until.is_none());
    broker.watch_at(None, &[], Instant::now() + TURN_KEEP * 2);
    assert_eq!(broker.snapshot().turns.len(), 1);
    // That reply ends too, and none takes the turn on in time: it ends, which the history keeps.
    broker.run_ended("run-ui-2");
    broker.watch_at(
        None,
        &[],
        Instant::now() + TURN_KEEP - Duration::from_secs(1),
    );
    assert_eq!(broker.snapshot().turns.len(), 1);
    broker.watch_at(None, &[], Instant::now() + TURN_KEEP);
    assert!(broker.snapshot().turns.is_empty());
    let records = read_history(&history);
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|r| r["kind"] == "turn"));
    assert_eq!(records[1]["endedBy"], "reply");
    assert_eq!(records[1]["conversationId"], "ui");
    assert!(broker.release_turns("ui", None).is_none());
}

/// A chat holding `key`'s landing turn, and another in line for it.
fn two_in_line(broker: &Broker, key: &str) {
    broker.run_started("run-bench", "bench");
    broker.take_turn(
        "run-bench",
        "bench",
        key,
        "the landing of github.com/simpx-tech/bluevox",
        true,
        "Final check and push",
    );
    broker.run_started("run-ui", "ui");
    broker.take_turn(
        "run-ui",
        "ui",
        key,
        "the landing of github.com/simpx-tech/bluevox",
        true,
        "Final check and push",
    );
}

#[tokio::test]
async fn a_turn_whose_holder_runs_work_that_uses_no_cpu_goes_to_the_next_in_line() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    let key = named::key("landing:github.com/simpx-tech/bluevox");
    two_in_line(&broker, &key);
    // Its holder builds, and the build stops using the CPU, as one did for 94 minutes on a full
    // page file while four chats waited (requested 2026-11-26).
    let (build, built) = command("build", r".\Tools\Build.ps1 -Candidate");
    broker.tool("run-bench", &build);
    let quiet: HashMap<String, f64> = [("bench".to_string(), 0.02), ("ui".to_string(), 0.0)].into();
    let start = Instant::now();
    broker.watch_at(Some(&quiet), &[], start);
    broker.watch_at(
        Some(&quiet),
        &[],
        start + STALL_WARN - Duration::from_secs(1),
    );
    assert!(broker.deliver("bench").is_none());
    assert!(broker.snapshot().turns[0].stalled_at.is_none());
    // After a while its holder hears it may have stalled, once.
    broker.watch_at(Some(&quiet), &[], start + STALL_WARN);
    let warned = broker.deliver("bench").unwrap();
    assert!(
        warned.starts_with("Agent Studio: this chat holds the landing of github.com/simpx-tech/bluevox (Final check and push), and the work it runs (")
            && warned.contains("has used no CPU for 10m 0s: it may have stalled")
            && warned.contains("pc_release (landing: true) if you cannot go on soon: 1 chat waits for it.")
            && warned.contains("Once that work has used no CPU for 20m 0s, the turn goes to the next chat in line"),
        "{warned}"
    );
    assert!(broker.snapshot().turns[0].stalled_at.is_some());
    assert!(broker.status("ui", None).contains("it may have stalled"));
    broker.watch_at(
        Some(&quiet),
        &[],
        start + STALL_WARN + Duration::from_secs(10),
    );
    assert!(broker.deliver("bench").is_none());
    // Work that uses the CPU again starts the count afresh.
    let busy: HashMap<String, f64> = [("bench".to_string(), 3.5)].into();
    broker.watch_at(
        Some(&busy),
        &[],
        start + STALL_WARN + Duration::from_secs(20),
    );
    assert!(broker.snapshot().turns[0].stalled_at.is_none());
    broker.watch_at(Some(&quiet), &[], start + STALL_RELEASE);
    assert_eq!(broker.snapshot().turns[0].conversation_id, "bench");
    // Quiet long enough, it goes to the next chat in line, and its holder hears why.
    let again = start + STALL_RELEASE + Duration::from_secs(1);
    broker.watch_at(Some(&quiet), &[], again + STALL_RELEASE);
    let turns = broker.snapshot().turns;
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].conversation_id, "ui");
    assert!(turns[0].granted_at.is_some());
    let told = broker.deliver("bench").unwrap();
    assert!(
        told.contains("the landing of github.com/simpx-tech/bluevox went to the next chat in line")
            && told.contains("used no CPU for 20m 1s, and 1 chat waited for it"),
        "{told}"
    );
    let records = read_history(&history);
    assert_eq!(records[0]["endedBy"], "stalled");
    assert_eq!(records[0]["conversationId"], "bench");
    broker.tool("run-bench", &built);
}

#[tokio::test]
async fn a_turn_is_kept_while_its_holder_waits_thinks_or_works_and_nobody_waits_for_it() {
    let broker = broker_with(vec![], None);
    let key = named::key("landing:github.com/simpx-tech/bluevox");
    broker.run_started("run-bench", "bench");
    broker.take_turn(
        "run-bench",
        "bench",
        &key,
        "the landing of github.com/simpx-tech/bluevox",
        true,
        "Final check and push",
    );
    let quiet: HashMap<String, f64> = [("bench".to_string(), 0.0)].into();
    let start = Instant::now();
    // No build or run, nor background work, so its agent thinks: nothing to watch.
    broker.watch_at(Some(&quiet), &[], start);
    broker.watch_at(Some(&quiet), &[], start + STALL_RELEASE * 2);
    assert!(broker.deliver("bench").is_none());
    // A test run in the background that stops using the CPU is warned of, and kept while
    // nobody waits for the name.
    let tests = BackgroundWork {
        conversation: "bench".into(),
        id: "tests".into(),
        label: "Run the test suite".into(),
    };
    broker.watch_at(Some(&quiet), std::slice::from_ref(&tests), start);
    broker.watch_at(
        Some(&quiet),
        std::slice::from_ref(&tests),
        start + STALL_RELEASE * 2,
    );
    let warned = broker.deliver("bench").unwrap();
    assert!(
        warned.contains("the work it runs (Run the test suite) has used no CPU"),
        "{warned}"
    );
    assert!(!warned.contains("waits for it"), "{warned}");
    assert_eq!(broker.snapshot().turns.len(), 1);
}

#[tokio::test]
async fn a_closed_chat_lets_go_of_its_turns_at_once() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    let key = named::key("landing:github.com/simpx-tech/bluevox");
    two_in_line(&broker, &key);
    broker.run_ended("run-bench");
    assert!(broker.snapshot().turns[0].kept_until.is_some());
    broker.chat_closed("bench");
    let turns = broker.snapshot().turns;
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].conversation_id, "ui");
    assert!(turns[0].granted_at.is_some());
    assert_eq!(read_history(&history)[0]["endedBy"], "closed");
    // Closing a chat that holds nothing changes nothing.
    broker.chat_closed("bench");
    assert_eq!(read_history(&history).len(), 1);
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

/// A grant a chat's work took `ago` from now, as `hold_grant` makes one.
fn grant_of(weight: builds::Weight, bytes: u64, ago: Duration, signature: Option<&str>) -> Grant {
    let now = Instant::now();
    Grant {
        weight,
        bytes,
        at: now.checked_sub(ago).unwrap_or(now),
        at_ms: epoch_ms(),
        call: None,
        ended: false,
        train: false,
        compiled: false,
        signature: signature.map(String::from),
        base: Some(0),
        peak: 0,
    }
}

/// Thirty-two cores with five gigabytes free.
fn five_free() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 32, 5 << 30, vec![]))
}
/// Thirty-two cores with nine gigabytes free: room for one compiler beside what a grant keeps.
fn nine_free() -> Option<machine::Reading> {
    Some(reading(Instant::now(), 0, 32, 9 << 30, vec![]))
}

#[tokio::test]
async fn a_run_needs_what_runs_of_its_kind_took_at_their_most_and_each_run_s_peak_is_kept() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    broker.read_with(five_free);
    {
        let mut state = broker.lock();
        // Filtered test runs took 2 GB at their most: one needs 3 GB free.
        state
            .peaks
            .insert("run-tests -filter".into(), vec![2 << 30]);
        // Another chat's work holds memory, so a run needs room of its own.
        state.grants.insert(
            "bench".into(),
            grant_of(builds::Weight::Build, 0, Duration::ZERO, None),
        );
    }
    broker.run_started("run-ui", "ui");
    assert!(broker
        .gate(
            "ui",
            "pwsh -File Tools/Run-Tests.ps1 -Filter Bluevox.Water -Name water",
            None,
            "pc_wait"
        )
        .is_none());
    assert_eq!(broker.lock().grants["ui"].bytes, 3 << 30);
    assert_eq!(
        broker.lock().grants["ui"].signature.as_deref(),
        Some("run-tests -filter")
    );
    // A kind of run never measured still asks for 8 GB, and only 2 GB are left beside the first.
    broker.run_started("run-art", "art");
    let reason = broker
        .gate(
            "art",
            "pwsh -File Tools/Run-Game.ps1 -Mode net -Timeline t.txt",
            None,
            "pc_wait",
        )
        .unwrap();
    assert!(
        reason
            .contains("a game or test run needs 8.0 GB of free memory (commit) and 2.0 GB is free"),
        "{reason}"
    );
    // A run's peak, the most its chat used beyond what it used as it began, is kept with its kind
    // once its grant ends, and saved beside the history.
    {
        let mut state = broker.lock();
        let mut ran = grant_of(
            builds::Weight::Run,
            3 << 30,
            Duration::from_secs(60),
            Some("run-tests -filter"),
        );
        ran.peak = 6 << 30;
        state.grants.insert("ui".into(), ran);
        broker.end_grant(&mut state, "ui");
        assert_eq!(state.peaks["run-tests -filter"], [2 << 30, 6 << 30]);
        // One that ended at once was never read, and counts for nothing.
        let mut short = grant_of(
            builds::Weight::Run,
            3 << 30,
            Duration::ZERO,
            Some("run-editor"),
        );
        short.peak = 1 << 30;
        state.grants.insert("ui".into(), short);
        broker.end_grant(&mut state, "ui");
        assert!(!state.peaks.contains_key("run-editor"));
    }
    let saved: HashMap<String, Vec<u64>> =
        serde_json::from_slice(&std::fs::read(folder.path().join(PEAKS)).unwrap()).unwrap();
    assert_eq!(saved["run-tests -filter"], [2 << 30, 6 << 30]);
    // A broker started later reads them back.
    let again = broker_with(vec![], Some(history));
    assert_eq!(again.lock().peaks["run-tests -filter"].len(), 2);
}

#[tokio::test]
async fn a_build_short_of_room_for_two_compilers_waits_a_while_and_its_wait_is_kept() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    broker.read_with(nine_free);
    // Alone, a build starts with what there is.
    assert!(broker.gate("ui", "cargo build", None, "pc_wait").is_none());
    broker.lock().grants.clear();
    // Beside other chats' work holding memory, one compiler's room makes it wait for a second.
    broker.lock().grants.insert(
        "bench".into(),
        grant_of(builds::Weight::Run, 0, Duration::ZERO, None),
    );
    broker.run_started("run-ui", "ui");
    let reason = broker
        .gate("ui", "cargo build", Some("claude:b1"), "pc_wait")
        .unwrap();
    assert!(
        reason.contains("it would start with memory for 1 compiler")
            && reason.contains("waits up to 3m 0s since it first asked for room for two"),
        "{reason}"
    );
    assert_eq!(broker.lock().slots[0].why, "compilers");
    // Once it has waited that long, it starts with what there is, and its wait is kept.
    {
        let mut state = broker.lock();
        let now = Instant::now();
        state.slots[0].since = now
            .checked_sub(builds::FEW_WAIT + Duration::from_secs(1))
            .unwrap_or(now);
    }
    assert!(broker
        .gate("ui", "cargo build", Some("claude:b2"), "pc_wait")
        .is_none());
    assert!(broker.snapshot().slots.is_empty());
    // Another chat's build waits for room beside the first, and its reply ends.
    let (build, _) = command("build", "cargo build");
    broker.tool("run-ui", &build);
    broker.run_started("run-art", "art");
    broker.read_with(little_memory);
    assert!(broker
        .gate("art", "dotnet build", None, "pc_wait")
        .is_some());
    broker.run_ended("run-art");
    let waits: Vec<Value> = read_history(&history)
        .into_iter()
        .filter(|r| r["kind"] == "wait")
        .collect();
    assert_eq!(waits.len(), 2, "{waits:?}");
    assert_eq!(waits[0]["conversationId"], "ui");
    assert_eq!(waits[0]["why"], "compilers");
    assert_eq!(waits[0]["endedBy"], "started");
    assert_eq!(waits[0]["weight"], "build");
    assert!(waits[0]["waitedMs"].as_u64().unwrap() >= ms(builds::FEW_WAIT));
    assert_eq!(waits[1]["conversationId"], "art");
    assert_eq!(waits[1]["why"], "memory");
    assert_eq!(waits[1]["endedBy"], "reply");
}

#[tokio::test]
async fn a_measurement_of_gpu_work_alone_holds_only_what_renders() {
    let broker = broker_with(vec![], None);
    broker.read_with(roomy);
    broker.run_started("run-ui", "ui");
    let (build, _) = command("build", "cargo build --release");
    broker.tool("run-ui", &build);
    broker.run_started("run-bench", "bench");
    let text = broker.reserve_scoped("run-bench", "bench", "Frame timing", None, Scope::Gpu);
    assert!(
        text.contains("This reservation is of GPU work alone"),
        "{text}"
    );
    // Another chat's build renders nothing: the window opens beside it.
    let first = broker.snapshot().reservations[0].clone();
    assert_eq!((first.scope, first.phase), ("gpu", "open"));
    // Builds and headless runs go on; a game waits.
    assert!(broker.gate("ui", "cargo test", None, "pc_wait").is_none());
    assert!(broker
        .gate(
            "ui",
            "UnrealEditor-Cmd.exe Game.uproject -ExecCmds=\"Automation RunTests Bluevox\" -nullrhi",
            None,
            "pc_wait"
        )
        .is_none());
    let held = broker
        .gate(
            "ui",
            "UnrealEditor.exe Game.uproject -game",
            None,
            "pc_wait",
        )
        .unwrap();
    assert!(
        held.contains("reserved this computer's GPU for a measurement of GPU work"),
        "{held}"
    );
    let status = broker.status("ui", None);
    assert!(status.contains("It reserved GPU work alone"), "{status}");
    let report = broker.release("bench").unwrap();
    assert_eq!(report.record["scope"], "gpu");
}

/// The repository github.com/simpx-tech/bluevox with a merge train: its main checkout, and a
/// worktree for each of `branches`, each branch on a commit of its own (`a…`, `b…`).
fn repository_with_train(root: &Path, branches: &[&str]) -> (PathBuf, Vec<PathBuf>) {
    let main = root.join("main");
    let git = main.join(".git");
    std::fs::create_dir_all(git.join("refs").join("heads")).unwrap();
    std::fs::write(
        git.join("config"),
        "[remote \"origin\"]\n\turl = https://github.com/simpx-tech/bluevox.git\n",
    )
    .unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::create_dir_all(main.join(".agent-studio")).unwrap();
    std::fs::write(
        main.join(train::CONFIG),
        r#"{"branch":"main","command":["land-train"],"maxCars":4}"#,
    )
    .unwrap();
    let worktrees = branches
        .iter()
        .enumerate()
        .map(|(index, branch)| {
            let own = git.join("worktrees").join(branch);
            std::fs::create_dir_all(&own).unwrap();
            std::fs::write(own.join("commondir"), "../..\n").unwrap();
            std::fs::write(own.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
            std::fs::write(
                git.join("refs").join("heads").join(branch),
                format!("{:x}", index + 10).repeat(40),
            )
            .unwrap();
            let worktree = root.join("worktrees").join(branch);
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}\n", own.display()),
            )
            .unwrap();
            worktree
        })
        .collect();
    (main, worktrees)
}

/// A runner that hands each train it is given to the test, then reports what the test says.
struct Rails {
    rides: tokio::sync::mpsc::UnboundedReceiver<train::Ride>,
    outcomes: tokio::sync::mpsc::UnboundedSender<Result<train::Outcome, String>>,
}
fn rails(broker: &Broker) -> Rails {
    let (ride_tx, rides) = tokio::sync::mpsc::unbounded_channel();
    let (outcomes, outcome_rx) = tokio::sync::mpsc::unbounded_channel();
    let outcome_rx = Arc::new(tokio::sync::Mutex::new(outcome_rx));
    broker.run_trains_with(Arc::new(move |ride| {
        let (ride_tx, outcome_rx) = (ride_tx.clone(), outcome_rx.clone());
        Box::pin(async move {
            let _ = ride_tx.send(ride);
            outcome_rx
                .lock()
                .await
                .recv()
                .await
                .unwrap_or_else(|| Err("the test ended".into()))
        })
    }));
    Rails { rides, outcomes }
}
impl Rails {
    async fn next(&mut self) -> train::Ride {
        tokio::time::timeout(Duration::from_secs(10), self.rides.recv())
            .await
            .expect("a train left")
            .unwrap()
    }
}

#[tokio::test]
async fn a_merge_train_lands_the_branches_queued_and_gives_back_the_one_it_left_out() {
    let folder = tempfile::tempdir().unwrap();
    let history = folder.path().join("data").join("history.jsonl");
    let broker = broker_with(vec![], Some(history.clone()));
    let mut rails = rails(&broker);
    let (_, worktrees) =
        repository_with_train(folder.path(), &["worktree-rivers", "worktree-inventory"]);
    broker.run_started("run-bench", "bench");
    broker.run_started("run-ui", "ui");
    let queued = broker
        .land("bench", &worktrees[0].join("Source"), "Fed rivers")
        .unwrap();
    assert!(
        queued.starts_with("Queued worktree-rivers (aaaaaaaaaa) on the merge train of github.com/simpx-tech/bluevox, to land on main"),
        "{queued}"
    );
    let second = broker
        .land("ui", &worktrees[1], "Inventory sorting")
        .unwrap();
    assert!(second.contains("1 car waits before it"), "{second}");
    // The train takes the landing turn, then a build slot, then both cars.
    broker.regrant();
    let ride = rails.next().await;
    let train_id = "train:github.com/simpx-tech/bluevox";
    assert_eq!(ride.conversation, train_id);
    assert_eq!(ride.config.branch, "main");
    let cars: Vec<(&str, &str)> = ride
        .cars
        .iter()
        .map(|c| (c.conversation.as_str(), c.branch.as_str()))
        .collect();
    assert_eq!(
        cars,
        [("bench", "worktree-rivers"), ("ui", "worktree-inventory")]
    );
    assert_eq!(ride.cars[0].title, "Chunk benchmark");
    assert_eq!(ride.cars[1].sha, "b".repeat(40));
    assert!(ride.env.iter().any(|(name, value)| name == GRANT_ENV
        && value.ends_with("train_github_com_simpx-tech_bluevox.json")));
    let snapshot = broker.snapshot();
    assert_eq!(snapshot.trains.len(), 1);
    assert!(snapshot.trains[0].started_at.is_some());
    assert!(snapshot.trains[0].cars.iter().all(|c| c.riding));
    assert_eq!(snapshot.turns[0].conversation_id, train_id);
    assert_eq!(snapshot.turns[0].purpose, "merge train of 2 branches");
    assert!(snapshot
        .grants
        .iter()
        .any(|g| g.conversation_id == train_id));
    // The same commit again is no second car.
    let again = broker.land("bench", &worktrees[0], "Fed rivers").unwrap();
    assert!(
        again.starts_with("worktree-rivers (aaaaaaaaaa) is on the merge train of github.com/simpx-tech/bluevox running now"),
        "{again}"
    );
    assert_eq!(broker.snapshot().trains[0].cars.len(), 2);
    // A chat landing by hand waits behind the train.
    broker.run_started("run-art", "art");
    let asked = broker.take_turn(
        "run-art",
        "art",
        "landing:github.com/simpx-tech/bluevox",
        "the landing of github.com/simpx-tech/bluevox",
        true,
        "Final check and push",
    );
    assert!(
        asked.contains(
            "the merge train of github.com/simpx-tech/bluevox holds it (merge train of 2 branches)"
        ),
        "{asked}"
    );
    let status = broker.status("bench", None);
    assert!(
        status.contains("Merge train of github.com/simpx-tech/bluevox: on its way for")
            && status.contains("worktree-rivers (this chat: Fed rivers)"),
        "{status}"
    );
    // The chat whose branch rides waits for it, as for its turn.
    let (told, tell) = heard();
    let waiting = {
        let broker = broker.clone();
        tokio::spawn(async move { broker.wait("bench", &CancellationToken::new(), &tell).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiting.is_finished());
    assert_eq!(*told.lock().unwrap(), [None, Some("turn")]);
    rails
        .outcomes
        .send(Ok(train::Outcome {
            landed: vec![ride.cars[0].id.clone()],
            sha: Some("c".repeat(40)),
            ejected: vec![train::Ejected {
                id: ride.cars[1].id.clone(),
                reason: "it conflicts with main in Source/Inventory.cpp".into(),
                log: Some("merge.log".into()),
            }],
            requeue: vec![],
            note: Some("1 landed, 1 ejected".into()),
        }))
        .unwrap();
    let landed = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        landed.contains("your branch worktree-rivers (aaaaaaaaaa) landed on main of github.com/simpx-tech/bluevox at cccccccccc, on a merge train of 2 branches")
            && landed.contains("(1 landed, 1 ejected)")
            && landed.ends_with("nothing more to wait for."),
        "{landed}"
    );
    let ejected = broker.deliver("ui").unwrap();
    assert!(
        ejected.contains("your branch worktree-inventory (bbbbbbbbbb) left the merge train of github.com/simpx-tech/bluevox without landing: it conflicts with main in Source/Inventory.cpp (log: merge.log)"),
        "{ejected}"
    );
    // The chat landing by hand has the turn now, and hears that main moved.
    let moved = broker.deliver("art").unwrap();
    assert!(
        moved.contains("main of github.com/simpx-tech/bluevox moved to cccccccccc"),
        "{moved}"
    );
    let snapshot = broker.snapshot();
    assert!(snapshot.trains.is_empty());
    assert_eq!(snapshot.turns.len(), 1);
    assert_eq!(snapshot.turns[0].conversation_id, "art");
    assert!(snapshot.grants.is_empty());
    assert!(broker
        .status("art", None)
        .contains("Landed on github.com/simpx-tech/bluevox"));
    // The history keeps the train, its turn and its wait for a slot.
    let records = read_history(&history);
    let train = records.iter().find(|r| r["kind"] == "train").unwrap();
    assert_eq!(train["repository"], "github.com/simpx-tech/bluevox");
    assert_eq!(train["cars"][0]["outcome"], "landed");
    assert_eq!(train["cars"][1]["outcome"], "ejected");
    assert!(records.iter().any(|r| r["kind"] == "turn"
        && r["conversationId"] == train_id
        && r["endedBy"] == "train"));
    assert!(records.iter().any(|r| r["kind"] == "wait"
        && r["conversationId"] == train_id
        && r["endedBy"] == "started"));
}

#[tokio::test]
async fn a_train_that_fails_gives_its_cars_back_and_twice_in_a_row_to_their_chats() {
    let folder = tempfile::tempdir().unwrap();
    let broker = broker_with(vec![], None);
    let mut rails = rails(&broker);
    let (_, worktrees) = repository_with_train(folder.path(), &["worktree-rivers"]);
    broker.run_started("run-bench", "bench");
    broker.land("bench", &worktrees[0], "Fed rivers").unwrap();
    broker.regrant();
    let _ = rails.next().await;
    rails.outcomes.send(Err("git fetch failed".into())).unwrap();
    // It goes first on the next train.
    let ride = rails.next().await;
    assert_eq!(ride.cars[0].conversation, "bench");
    let back = broker.deliver("bench").unwrap();
    assert!(
        back.contains("waits for the next merge train of github.com/simpx-tech/bluevox: the train failed: git fetch failed. It goes first."),
        "{back}"
    );
    rails.outcomes.send(Err("git fetch failed".into())).unwrap();
    for _ in 0..50 {
        if broker.snapshot().trains.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let given = broker.deliver("bench").unwrap();
    assert!(
        given.contains("the merge train failed 2 times in a row")
            && given.contains("Land by hand with pc_reserve and landing: true"),
        "{given}"
    );
    assert!(broker.snapshot().trains.is_empty());
    assert!(broker.snapshot().turns.is_empty());
}

#[tokio::test]
async fn a_car_waiting_for_its_train_can_be_brought_up_to_date_or_taken_off() {
    let folder = tempfile::tempdir().unwrap();
    let broker = broker_with(vec![], None);
    let (main, worktrees) = repository_with_train(folder.path(), &["worktree-rivers"]);
    broker.run_started("run-bench", "bench");
    // A chat holding the landing turn of the repository gives it to its own train.
    broker.take_turn(
        "run-bench",
        "bench",
        "landing:github.com/simpx-tech/bluevox",
        "the landing of github.com/simpx-tech/bluevox",
        true,
        "Push",
    );
    let queued = broker.land("bench", &worktrees[0], "Fed rivers").unwrap();
    assert!(
        queued.contains("The landing turn this chat held or waited for was released"),
        "{queued}"
    );
    // A new commit: the car carries it, in its place.
    std::fs::write(
        main.join(".git")
            .join("refs")
            .join("heads")
            .join("worktree-rivers"),
        "d".repeat(40),
    )
    .unwrap();
    let again = broker
        .land("bench", &worktrees[0], "Fed rivers, banks")
        .unwrap();
    assert!(
        again.starts_with("Brought up to date: worktree-rivers (dddddddddd)"),
        "{again}"
    );
    let cars = broker.snapshot().trains[0].cars.clone();
    assert_eq!(cars.len(), 1);
    assert_eq!(cars[0].purpose, "Fed rivers, banks");
    // Taken off before it left, the train gives back its turn.
    let off = broker.withdraw("bench").unwrap();
    assert!(
        off.starts_with("Took worktree-rivers (dddddddddd) off the merge train"),
        "{off}"
    );
    assert!(broker.snapshot().trains.is_empty());
    assert!(broker.snapshot().turns.is_empty());
    assert!(broker.withdraw("bench").is_none());
    // A branch on main itself, or a repository without a train, is refused.
    let on_main = broker.land("bench", &main, "x").unwrap_err();
    assert!(on_main.contains("is on main itself"), "{on_main}");
    std::fs::remove_file(main.join(train::CONFIG)).unwrap();
    let none = broker.land("bench", &worktrees[0], "x").unwrap_err();
    assert!(none.contains("has no merge train"), "{none}");
}
