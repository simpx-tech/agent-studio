use super::*;

fn form() -> Value {
    json!({"type":"object","properties":{"name":{"type":"string","minLength":2,"pattern":"^[A-Z]"},"age":{"type":"integer","minimum":1,"maximum":99},"ok":{"type":"boolean"},"tags":{"type":"array","items":{"anyOf":[{"const":"blue","title":"Blue"},{"const":"red","title":"Red"}]},"minItems":1,"maxItems":2},"optional":{"type":"string"}},"required":["name","age","ok","tags"]})
}
fn call(claude: bool, url: bool) -> Value {
    let mode = if url { "url" } else { "form" };
    if claude {
        json!({"type":"control_request","request_id":"call","request":{"subtype":"elicitation","mcp_server_name":"fixture","mode":mode,"message":"Private request message","requested_schema":form(),"url":"https://example.com/verify?nonce=private-nonce","elicitation_id":"private-id"}})
    } else {
        json!({"id":17,"method":"mcpServer/elicitation/request","params":{"threadId":"root","turnId":"turn","serverName":"fixture","mode":mode,"message":"Private request message","requestedSchema":form(),"url":"https://example.com/verify?nonce=private-nonce","elicitationId":"private-id"}})
    }
}
fn fixture() -> (Hub, Session, Arc<Mutex<Vec<Value>>>) {
    let events = Arc::new(Mutex::new(vec![]));
    let copy = events.clone();
    let hub = Hub::default();
    let session = hub.open(
        "run",
        Some("connection".into()),
        EventSink::new(move |event| {
            copy.lock()
                .unwrap()
                .push(serde_json::to_value(event).unwrap());
            Ok(())
        }),
    );
    (hub, session, events)
}
fn submit(session: &mut Session, claude: bool, call: &Value) -> Option<Option<Value>> {
    if claude {
        session.claude(call, true)
    } else {
        session.codex(call, "root", "turn", true)
    }
}
fn input(id: &str, action: Option<&str>, content: Option<Value>) -> Input {
    Input {
        request_id: id.into(),
        action: action.map(String::from),
        content,
    }
}

#[tokio::test]
async fn elicitation_forms_and_urls_round_trip_all_actions_without_persisting_private_data() {
    for claude in [false, true] {
        for url in [false, true] {
            for action in ["accept", "decline", "cancel"] {
                let (hub, mut session, events) = fixture();
                let call = call(claude, url);
                assert!(matches!(submit(&mut session, claude, &call), Some(None)));
                // Duplicate native request IDs never create a second prompt or response.
                assert!(matches!(submit(&mut session, claude, &call), Some(None)));
                assert_eq!(events.lock().unwrap().len(), 1);
                let id = events.lock().unwrap()[0]["elicitation"]["id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert!(hub
                    .manage("run", Some("other"), input(&id, None, None))
                    .await
                    .is_err());
                let request = hub
                    .manage("run", Some("connection"), input(&id, None, None))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(request.receipt.mode, if url { "url" } else { "form" });
                let content = (!url && action == "accept")
                    .then(|| json!({"name":"Ada","age":32,"ok":false,"tags":["blue"]}));
                let send = hub.manage(
                    "run",
                    Some("connection"),
                    input(&id, Some(action), content.clone()),
                );
                tokio::pin!(send);
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(5), &mut send)
                        .await
                        .is_err()
                );
                let delivery = session.rx.recv().await.unwrap();
                assert!(session.can_deliver(&delivery));
                let result = if claude {
                    &delivery.payload["response"]["response"]
                } else {
                    &delivery.payload["result"]
                };
                assert_eq!(result["action"], action);
                assert_eq!(
                    result.get("content"),
                    if claude && content.is_none() {
                        None
                    } else {
                        Some(content.as_ref().unwrap_or(&Value::Null))
                    }
                );
                if claude {
                    assert_eq!(delivery.payload["response"]["request_id"], "call");
                } else {
                    assert_eq!(delivery.payload["id"], 17);
                }
                session.delivered(delivery, Ok(()));
                assert!(send.await.is_ok());
                assert!(hub
                    .manage("run", Some("connection"), input(&id, None, None))
                    .await
                    .is_err());
                let recorded = serde_json::to_string(&*events.lock().unwrap()).unwrap();
                for private in [
                    "Private request",
                    "private-nonce",
                    "private-id",
                    "Ada",
                    "requestedSchema",
                    "fields",
                    "url\":",
                ] {
                    assert!(!recorded.contains(private), "{private}");
                }
            }
        }
    }
}

#[tokio::test]
async fn elicitation_cancellation_invalidation_and_validation_prevent_stale_delivery() {
    for claude in [false, true] {
        let (hub, mut session, events) = fixture();
        let mut value = call(claude, false);
        if claude {
            value["parent_tool_use_id"] = json!("child");
        } else {
            value["params"]["turnId"] = json!("stale");
        }
        assert!(submit(&mut session, claude, &value).unwrap().is_some());
        assert!(events.lock().unwrap().is_empty());
        let value = call(claude, false);
        submit(&mut session, claude, &value);
        let id = events.lock().unwrap()[0]["elicitation"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(hub
            .manage(
                "run",
                Some("connection"),
                input(&id, Some("accept"), Some(json!({"name":"a"})))
            )
            .await
            .is_err());
        let send = hub.manage("run", Some("connection"), input(&id, Some("decline"), None));
        tokio::pin!(send);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut send)
                .await
                .is_err()
        );
        let delivery = session.rx.recv().await.unwrap();
        if claude {
            session.observe(
                &json!({"type":"control_cancel_request","request_id":"call"}),
                None,
            );
        } else {
            session.observe(&json!({"method":"serverRequest/resolved","params":{"threadId":"root","requestId":17}}),Some("root"));
        }
        assert!(!session.can_deliver(&delivery));
        session.delivered(delivery, Err("Request withdrawn".into()));
        assert!(send.await.is_err());
        assert_eq!(
            events.lock().unwrap().last().unwrap()["elicitation"]["status"],
            "cancelled"
        );
        session.close();
        assert!(hub
            .manage("run", Some("connection"), input(&id, None, None))
            .await
            .is_err());
    }
}

#[test]
fn elicitation_preserves_full_access_only_for_empty_codex_tool_approvals() {
    for (flag, value, automatic) in [
        ("codex_approval_kind", json!("mcp_tool_call"), true),
        ("codex_approval_kind", json!("browser_auth"), false),
        ("codex_requires_user_input", json!(true), false),
        ("codex_strict_auto_review", json!(true), false),
        ("codex_sensitive_action", json!(true), false),
    ] {
        let (_, mut session, events) = fixture();
        let mut v = call(false, false);
        v["params"]["requestedSchema"] = json!({"type":"object","properties":{}});
        v["params"]["_meta"] = json!({"codex_approval_kind":"mcp_tool_call"});
        v["params"]["_meta"][flag] = value;
        let result = session.codex(&v, "root", "turn", true).unwrap();
        assert_eq!(result.is_some(), automatic);
        assert_eq!(events.lock().unwrap().is_empty(), automatic);
        if let Some(r) = result {
            assert_eq!(r["result"]["action"], "accept");
            assert_eq!(r["result"]["content"], json!({}));
        }
    }
    let (_, mut session, events) = fixture();
    let mut v = call(false, false);
    v["params"]["_meta"] = json!({"codex_approval_kind":"mcp_tool_call"});
    assert!(session.codex(&v, "root", "turn", true).unwrap().is_none());
    assert_eq!(events.lock().unwrap().len(), 1);
}

#[test]
fn elicitation_schema_checks_required_types_constraints_choices_formats_and_limits() {
    let fields = schema::parse(&form()).unwrap();
    let valid = json!({"name":"Ada","age":32,"ok":false,"tags":["blue"]});
    assert!(schema::valid_content(&fields, &valid));
    for (key, bad) in [
        ("name", json!("a")),
        ("age", json!(1.5)),
        ("ok", json!("true")),
        ("tags", json!(["blue", "blue"])),
        ("tags", json!(["unknown"])),
    ] {
        let mut content = valid.clone();
        content[key] = bad;
        assert!(!schema::valid_content(&fields, &content));
    }
    let mut extra = valid.clone();
    extra["unrequested"] = json!("no");
    assert!(!schema::valid_content(&fields, &extra));
    for property in [
        json!({"type":"object"}),
        json!({"type":"string","format":"password"}),
        json!({"type":"string","minLength":5000}),
        json!({"type":"number","multipleOf":2}),
        json!({"type":"string","pattern":"(?=bad)"}),
    ] {
        assert!(schema::parse(&json!({"type":"object","properties":{"field":property}})).is_err());
    }
    for (format, value) in [
        ("email", "ada@example.com"),
        ("uri", "https://example.com"),
        ("date", "2024-02-29"),
        ("date-time", "2024-02-29T12:00:00Z"),
    ] {
        let f = schema::parse(
            &json!({"type":"object","properties":{"value":{"type":"string","format":format}}}),
        )
        .unwrap();
        assert!(schema::valid_content(&f, &json!({"value":value})));
        assert!(!schema::valid_content(&f, &json!({"value":"invalid"})));
    }
    for url in [
        "javascript:alert(1)",
        "file:///C:/private",
        "https://user:pass@example.com",
        "http://example.com",
    ] {
        assert!(schema::safe_url(&json!(url)).is_err());
    }
    assert!(schema::safe_url(&json!("https://example.com/continue")).is_ok());
    assert!(schema::safe_url(&json!("http://127.0.0.1:1234/continue")).is_ok());
}
