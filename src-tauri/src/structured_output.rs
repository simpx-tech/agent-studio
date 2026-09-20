use serde_json::Value;

pub const MAX_SCHEMA_BYTES: usize = 16_000;
pub const MAX_RESULT_BYTES: usize = 512_000;

fn bounded(value: &Value, depth: usize) -> bool {
    depth <= 32
        && match value {
            Value::Object(values) => values.values().all(|v| bounded(v, depth + 1)),
            Value::Array(values) => values.iter().all(|v| bounded(v, depth + 1)),
            _ => true,
        }
}

pub fn schema(text: &str) -> Result<Value, String> {
    if text.len() > MAX_SCHEMA_BYTES {
        return Err("JSON Schema must be at most 16,000 bytes.".into());
    }
    let value: Value =
        serde_json::from_str(text).map_err(|_| "Enter valid JSON for the output schema.")?;
    if !value.is_object() || value["type"] != "object" {
        return Err("JSON Schema must describe an object (\"type\": \"object\").".into());
    }
    if !bounded(&value, 0) {
        return Err("JSON Schema is too deeply nested (maximum 32 levels).".into());
    }
    Ok(value)
}

pub fn result(value: &Value) -> Result<String, String> {
    if !value.is_object() {
        return Err("The provider did not return a structured JSON object. Try again or disable structured output.".into());
    }
    let text = serde_json::to_string_pretty(value).map_err(|_| "Invalid structured output.")?;
    if text.len() > MAX_RESULT_BYTES {
        return Err("Structured output exceeds the 512,000-byte limit.".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounds_and_object_roots_are_checked_without_changing_the_schema() {
        let input = r##"{"type":"object","$defs":{"n":{"type":"string"}},"properties":{"answer":{"$ref":"#/$defs/n"}},"required":["answer"],"additionalProperties":false}"##;
        assert_eq!(
            schema(input).unwrap(),
            serde_json::from_str::<Value>(input).unwrap()
        );
        for input in ["{", "null", "[]", "true", r#"{"type":"string"}"#, r#"{}"#] {
            assert!(schema(input).is_err());
        }
        assert!(
            schema(&json!({"type":"object","description":"é".repeat(9000)}).to_string()).is_err()
        );
        let mut nested = json!({});
        for _ in 0..33 {
            nested = json!({"items":nested});
        }
        assert!(schema(&json!({"type":"object","properties":nested}).to_string()).is_err());
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
        assert!(result(&json!({"big":"x".repeat(MAX_RESULT_BYTES)})).is_err());
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
