use serde_json::Value;

/// A schema of any size or depth that describes an object; the provider reports what it cannot
/// use.
pub fn schema(text: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|_| "Enter valid JSON for the output schema.")?;
    if !value.is_object() || value["type"] != "object" {
        return Err("JSON Schema must describe an object (\"type\": \"object\").".into());
    }
    Ok(value)
}

/// The reply's structured object as exact JSON, whole.
pub fn result(value: &Value) -> Result<String, String> {
    if !value.is_object() {
        return Err("The provider did not return a structured JSON object. Try again or disable structured output.".into());
    }
    serde_json::to_string_pretty(value).map_err(|_| "Invalid structured output.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn object_roots_are_checked_without_changing_the_schema() {
        let input = r##"{"type":"object","$defs":{"n":{"type":"string"}},"properties":{"answer":{"$ref":"#/$defs/n"}},"required":["answer"],"additionalProperties":false}"##;
        assert_eq!(
            schema(input).unwrap(),
            serde_json::from_str::<Value>(input).unwrap()
        );
        for input in ["{", "null", "[]", "true", r#"{"type":"string"}"#, r#"{}"#] {
            assert!(schema(input).is_err());
        }
        // Past the 16,000 bytes and 32 levels earlier releases accepted.
        assert!(
            schema(&json!({"type":"object","description":"é".repeat(9000)}).to_string()).is_ok()
        );
        let mut nested = json!({});
        for _ in 0..40 {
            nested = json!({"items":nested});
        }
        assert!(schema(&json!({"type":"object","properties":nested}).to_string()).is_ok());
    }
    #[test]
    fn structured_result_is_exact_json_and_never_truncated() {
        let value = json!({"answer":"<script>bad()</script> ```json\n", "no":false, "zero":0, "nothing":null});
        assert_eq!(
            serde_json::from_str::<Value>(&result(&value).unwrap()).unwrap(),
            value
        );
        assert_eq!(result(&json!({})).unwrap(), "{}");
        assert!(result(&Value::Null).is_err());
        // Past the 512,000 bytes earlier releases accepted.
        let big = json!({"big":"x".repeat(600_000)});
        assert_eq!(
            serde_json::from_str::<Value>(&result(&big).unwrap()).unwrap(),
            big
        );
    }
    #[test]
    fn claude_result_is_authoritative_parent_only_and_missing_output_fails() {
        let mut decoder = crate::protocol::Decoder::default();
        decoder.expect_structured_output = true;
        decoder.decode("claude", r#"{"type":"assistant","message":{"id":"a","content":[{"type":"text","text":"Here you go"}]}}"#);
        decoder.decode(
            "claude",
            r#"{"type":"result","parent_tool_use_id":"child","structured_output":{"wrong":true}}"#,
        );
        assert_eq!(decoder.text, "Here you go");
        let events = decoder.decode("claude", r#"{"type":"result","is_error":false,"result":"ignored","structured_output":{"ok":true},"total_cost_usd":0.01}"#);
        assert_eq!(
            serde_json::from_str::<Value>(&decoder.text).unwrap(),
            json!({"ok":true})
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, crate::protocol::RunEvent::Text { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, crate::protocol::RunEvent::Usage { .. })));
        decoder.decode(
            "claude",
            r#"{"type":"result","is_error":false,"result":"not structured"}"#,
        );
        assert!(decoder.failure.as_ref().unwrap().contains("structured"));
        assert!(decoder.text.is_empty());
        let mut failed = crate::protocol::Decoder::default();
        failed.expect_structured_output = true;
        failed.decode("claude", r#"{"type":"result","is_error":true,"subtype":"error_max_structured_output_retries","errors":[],"structured_output":{"partial":true}}"#);
        assert!(failed
            .failure
            .as_ref()
            .unwrap()
            .contains("error_max_structured_output_retries"));
        assert!(failed.text.is_empty());
    }
}
