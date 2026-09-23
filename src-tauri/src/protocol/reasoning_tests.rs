use super::*;
use serde_json::json;

fn reasoning(events: Vec<RunEvent>) -> Vec<Value> {
    events
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .filter(|e| e["kind"] == "reasoning")
        .collect()
}

#[test]
fn reasoning_claude_stream_and_snapshot_are_one_block() {
    let mut d = Decoder::default();
    d.decode(
        "claude",
        &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg1"}}})
            .to_string(),
    );
    let events = reasoning(d.decode("claude", &json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Compare the options."}}}).to_string()));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["text"], "Compare the options.");
    assert!(d.text.is_empty());
    let snapshot = json!({"type":"assistant","message":{"id":"msg1","content":[{"type":"thinking","thinking":"Compare the options.","signature":"never-display"},{"type":"text","text":"Answer"}]}});
    assert!(reasoning(d.decode("claude", &snapshot.to_string())).is_empty());
    assert_eq!(d.text, "Answer");
}

#[test]
fn reasoning_codex_summary_deltas_and_completion_are_one_block() {
    let mut d = Decoder::default();
    let delta = json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"root","itemId":"r1","summaryIndex":0,"delta":"Compare the options."}});
    let events = reasoning(d.decode_codex_server(&delta, "root"));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["text"], "Compare the options.");
    assert!(d.text.is_empty());
    let complete = json!({"method":"item/completed","params":{"threadId":"root","item":{"type":"reasoning","id":"r1","summary":["Compare the options."],"content":[]}}});
    assert!(reasoning(d.decode_codex_server(&complete, "root")).is_empty());
}

#[test]
fn reasoning_claude_handles_blocks_messages_and_excludes_private_and_child_payloads() {
    let mut d = Decoder::default();
    for id in ["msg1", "msg2"] {
        d.decode(
            "claude",
            &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":id}}})
                .to_string(),
        );
        let start = json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"First "}}});
        let first = reasoning(d.decode("claude", &start.to_string()));
        assert_eq!(first[0]["id"], format!("{id}:0"));
        let delta = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step."}}});
        let next = reasoning(d.decode("claude", &delta.to_string()));
        assert_eq!(next[0]["text"], "First step.");
        assert_eq!(next[0]["revision"], 2);
        let mut child = delta.clone();
        child["parent_tool_use_id"] = json!("child");
        assert!(reasoning(d.decode("claude", &child.to_string())).is_empty());
    }
    for payload in [
        json!({"type":"assistant","message":{"id":"omitted","content":[{"type":"thinking","thinking":"","signature":"PRIVATE"}]}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"PRIVATE"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"PRIVATE"}}}),
        json!({"type":"assistant","message":{"id":"only-redacted","content":[{"type":"redacted_thinking","data":"PRIVATE"}]}}),
    ] {
        assert!(reasoning(d.decode("claude", &payload.to_string())).is_empty());
    }
    let saved = reasoning(d.decode("claude", &json!({"type":"assistant","message":{"id":"snapshot","content":[{"type":"thinking","thinking":"Snapshot only","signature":"PRIVATE"},{"type":"thinking","thinking":"Second block"}]}}).to_string()));
    assert_eq!(saved.len(), 2);
    assert!(!serde_json::to_string(&saved).unwrap().contains("PRIVATE"));
    assert!(d.text.is_empty());
}

#[test]
fn reasoning_codex_content_summary_parts_and_exec_snapshots() {
    let mut d = Decoder::default();
    let event = |method: &str, extra: Value| {
        let mut params = json!({"threadId":"root","itemId":"r1"});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"method":method,"params":params})
    };
    let content = event(
        "item/reasoning/textDelta",
        json!({"contentIndex":0,"delta":"Exposed text"}),
    );
    assert_eq!(
        reasoning(d.decode_codex_server(&content, "root"))[0]["text"],
        "Exposed text"
    );
    let summary = event(
        "item/reasoning/summaryTextDelta",
        json!({"summaryIndex":0,"delta":"Summary"}),
    );
    assert_eq!(
        reasoning(d.decode_codex_server(&summary, "root"))[0]["text"],
        "Summary"
    );
    assert!(reasoning(d.decode_codex_server(&content, "root")).is_empty());
    let next = event(
        "item/reasoning/summaryTextDelta",
        json!({"summaryIndex":1,"delta":"Next part"}),
    );
    assert_eq!(
        reasoning(d.decode_codex_server(&next, "root"))[0]["text"],
        "Summary\n\nNext part"
    );
    let mut child = next.clone();
    child["params"]["threadId"] = json!("child");
    assert!(reasoning(d.decode_codex_server(&child, "root")).is_empty());
    let invalid = event(
        "item/reasoning/textDelta",
        json!({"contentIndex":-1,"delta":"No"}),
    );
    assert!(reasoning(d.decode_codex_server(&invalid, "root")).is_empty());
    let snapshot = json!({"method":"item/completed","params":{"threadId":"root","item":{"type":"reasoning","id":"r2","summary":[],"content":["Snapshot text"],"encryptedContent":"PRIVATE"}}});
    assert_eq!(
        reasoning(d.decode_codex_server(&snapshot, "root"))[0]["text"],
        "Snapshot text"
    );
    let exec = json!({"type":"item.completed","item":{"id":"exec-r","type":"reasoning","text":"Exec summary"}});
    assert_eq!(
        reasoning(d.decode("codex", &exec.to_string()))[0]["text"],
        "Exec summary"
    );
    assert!(reasoning(d.decode("codex", &exec.to_string())).is_empty());
    assert!(d.text.is_empty());
}

#[test]
fn reasoning_bounds_unicode_text_and_item_count() {
    let mut d = Decoder::default();
    for index in 0..70 {
        let value = json!({"type":"assistant","message":{"id":format!("m{index}"),"content":[{"type":"thinking","thinking":"✨🦀".repeat(16001)}]}});
        let events = reasoning(d.decode("claude", &value.to_string()));
        if index < 64 {
            assert_eq!(events[0]["text"].as_str().unwrap().chars().count(), 16000);
            assert_eq!(events[0]["truncated"], true);
        } else {
            assert!(events.is_empty());
        }
    }
}

#[test]
fn reasoning_claude_split_snapshot_lines_after_stream_are_one_block() {
    // Claude Code prints each content block as its own assistant line. This message opens
    // with an omitted thinking block, so the visible one streams at index 1 while its
    // snapshot line holds it at array index 0.
    let mut d = Decoder::default();
    let mut events = Vec::new();
    for value in [
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"msg1"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"PRIVATE"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
        json!({"type":"assistant","message":{"id":"msg1","content":[{"type":"thinking","thinking":"","signature":"PRIVATE"}]}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"Leave the folder "}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"untouched."}}}),
        json!({"type":"stream_event","event":{"type":"content_block_stop","index":1}}),
        json!({"type":"assistant","message":{"id":"msg1","content":[{"type":"thinking","thinking":"Leave the folder untouched.","signature":"PRIVATE"}]}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool1","name":"Bash","input":{}}}}),
        json!({"type":"assistant","message":{"id":"msg1","content":[{"type":"tool_use","id":"tool1","name":"Bash","input":{"command":"ls"}}]}}),
    ] {
        events.extend(reasoning(d.decode("claude", &value.to_string())));
    }
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e["id"] == "msg1:1"));
    assert_eq!(events[1]["text"], "Leave the folder untouched.");
    assert_eq!(events[1]["revision"], 2);
    assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
}

#[test]
fn reasoning_claude_split_snapshot_lines_without_stream_keep_their_positions() {
    let mut d = Decoder::default();
    let line = |text: &str| {
        json!({"type":"assistant","message":{"id":"msg2","content":[{"type":"thinking","thinking":text}]}})
            .to_string()
    };
    let mut events = reasoning(d.decode("claude", &line("")));
    for text in ["First thought.", "Second thought.", "Second thought."] {
        events.extend(reasoning(d.decode("claude", &line(text))));
    }
    let ids: Vec<_> = events.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["msg2:1", "msg2:2", "msg2:3"]);
    assert_eq!(events[0]["text"], "First thought.");
    // A snapshot that prints every block in one line keeps its array positions.
    let whole = json!({"type":"assistant","message":{"id":"msg3","content":[{"type":"thinking","thinking":"A"},{"type":"text","text":"B"},{"type":"thinking","thinking":"C"}]}});
    let ids: Vec<_> = reasoning(d.decode("claude", &whole.to_string()))
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["msg3:0", "msg3:2"]);
}

#[test]
fn reasoning_empty_blocks_and_items_reserve_no_display_slot() {
    let mut d = Decoder::default();
    let mut ids = Vec::new();
    for index in 0..65 {
        let message = format!("m{index}");
        for value in [
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":message}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}}),
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"Step"}}}),
        ] {
            ids.extend(
                reasoning(d.decode("claude", &value.to_string()))
                    .iter()
                    .map(|e| e["id"].as_str().unwrap().to_owned()),
            );
        }
    }
    assert_eq!(ids.len(), 64);
    assert_eq!(ids[0], "m0:1");
    assert_eq!(ids[63], "m63:1");

    let mut codex = Decoder::default();
    for index in 0..70 {
        let empty = json!({"method":"item/started","params":{"threadId":"root","item":{"type":"reasoning","id":format!("e{index}"),"summary":[],"content":[""]}}});
        assert!(reasoning(codex.decode_codex_server(&empty, "root")).is_empty());
    }
    let summary = json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"root","itemId":"e3","summaryIndex":0,"delta":"Now reported"}});
    let events = reasoning(codex.decode_codex_server(&summary, "root"));
    assert_eq!(events[0]["id"], "e3");
    assert_eq!(events[0]["text"], "Now reported");
}
