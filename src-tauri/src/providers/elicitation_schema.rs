//! MCP's flat form subset. Unknown validation keywords fail closed; nothing is
//! executed and the provider's schema never becomes executable UI or HTML.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const INVALID: &str = "This MCP form is unsupported or exceeds the input limits.";
pub fn text(value: &Value, max: usize) -> Result<String, &'static str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max && !s.contains('\0'))
        .map(String::from)
        .ok_or(INVALID)
}
fn optional_text(value: &Value, max: usize) -> Result<String, &'static str> {
    if value.is_null() {
        Ok(String::new())
    } else {
        value
            .as_str()
            .filter(|s| s.encode_utf16().count() <= max && !s.contains('\0'))
            .map(String::from)
            .ok_or(INVALID)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Choice {
    pub value: String,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub required: bool,
    pub options: Vec<Choice>,
    pub min_length: Option<usize>,
    pub max_length: Option<usize>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub min_items: Option<usize>,
    pub max_items: Option<usize>,
    pub format: Option<String>,
    pub pattern: Option<String>,
    pub default: Option<Value>,
}
fn allowed(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| keys.contains(&k.as_str())))
}
fn count(v: &Value, max: usize) -> Result<Option<usize>, &'static str> {
    if v.is_null() {
        return Ok(None);
    }
    v.as_u64()
        .filter(|n| *n <= max as u64)
        .map(|n| Some(n as usize))
        .ok_or(INVALID)
}
fn number(v: &Value) -> Result<Option<f64>, &'static str> {
    if v.is_null() {
        return Ok(None);
    }
    v.as_f64()
        .filter(|n| n.is_finite())
        .map(Some)
        .ok_or(INVALID)
}
fn choices(v: &Value, titled: &str) -> Result<Vec<Choice>, &'static str> {
    let mut result = vec![];
    if let Some(values) = v.get("enum") {
        if !v[titled].is_null() {
            return Err(INVALID);
        }
        let values = values.as_array().ok_or(INVALID)?;
        let labels = if v["enumNames"].is_null() {
            None
        } else {
            Some(
                v["enumNames"]
                    .as_array()
                    .filter(|a| a.len() == values.len())
                    .ok_or(INVALID)?,
            )
        };
        for (i, value) in values.iter().enumerate() {
            let value = text(value, 200)?;
            result.push(Choice {
                label: labels
                    .map(|l| text(&l[i], 200))
                    .transpose()?
                    .unwrap_or_else(|| value.clone()),
                value,
            });
        }
    } else if let Some(values) = v.get(titled) {
        for value in values.as_array().ok_or(INVALID)? {
            if !allowed(value, &["const", "title"]) {
                return Err(INVALID);
            }
            result.push(Choice {
                value: text(&value["const"], 200)?,
                label: text(&value["title"], 200)?,
            });
        }
    } else {
        return Ok(result);
    }
    if result.is_empty()
        || result.len() > 32
        || result
            .iter()
            .map(|c| &c.value)
            .collect::<HashSet<_>>()
            .len()
            != result.len()
    {
        return Err(INVALID);
    }
    Ok(result)
}
pub fn parse(schema: &Value) -> Result<Vec<Field>, &'static str> {
    if !allowed(
        schema,
        &[
            "$schema",
            "type",
            "properties",
            "required",
            "title",
            "description",
            "additionalProperties",
        ],
    ) || schema["type"] != "object"
        || schema
            .get("additionalProperties")
            .is_some_and(|v| v != false)
    {
        return Err(INVALID);
    }
    let props = schema["properties"]
        .as_object()
        .filter(|p| p.len() <= 16)
        .ok_or(INVALID)?;
    let required: Vec<String> = if schema["required"].is_null() {
        vec![]
    } else {
        serde_json::from_value(schema["required"].clone()).map_err(|_| INVALID)?
    };
    if required.iter().collect::<HashSet<_>>().len() != required.len()
        || required.iter().any(|k| !props.contains_key(k))
    {
        return Err(INVALID);
    }
    let mut fields = vec![];
    for (key, v) in props {
        text(&Value::String(key.clone()), 100)?;
        if !allowed(
            v,
            &[
                "type",
                "title",
                "description",
                "default",
                "minLength",
                "maxLength",
                "minimum",
                "maximum",
                "minItems",
                "maxItems",
                "format",
                "pattern",
                "enum",
                "enumNames",
                "oneOf",
                "items",
            ],
        ) {
            return Err(INVALID);
        }
        let kind = text(&v["type"], 16)?;
        if !matches!(
            kind.as_str(),
            "string" | "number" | "integer" | "boolean" | "array"
        ) {
            return Err(INVALID);
        }
        let mut field = Field {
            key: key.clone(),
            title: if v["title"].is_null() {
                key.clone()
            } else {
                text(&v["title"], 200)?
            },
            description: optional_text(&v["description"], 1000)?,
            kind,
            required: required.contains(key),
            options: vec![],
            min_length: count(&v["minLength"], 4000)?,
            max_length: count(&v["maxLength"], 4000)?,
            minimum: number(&v["minimum"])?,
            maximum: number(&v["maximum"])?,
            min_items: count(&v["minItems"], 32)?,
            max_items: count(&v["maxItems"], 32)?,
            format: v.get("format").map(|v| text(v, 32)).transpose()?,
            pattern: v.get("pattern").map(|v| text(v, 500)).transpose()?,
            default: None,
        };
        if field.kind == "array" {
            if v.get("enum").is_some() || v.get("oneOf").is_some() || v.get("enumNames").is_some() {
                return Err(INVALID);
            }
            let items = &v["items"];
            if !allowed(items, &["type", "enum", "anyOf"])
                || items.get("type").is_some_and(|t| t != "string")
            {
                return Err(INVALID);
            }
            field.options = choices(items, "anyOf")?;
            if field.options.is_empty() {
                return Err(INVALID);
            }
        } else {
            field.options = choices(v, "oneOf")?;
            if (!field.options.is_empty() && field.kind != "string") || v.get("items").is_some() {
                return Err(INVALID);
            }
        }
        if (field.kind != "string"
            && (field.min_length.is_some()
                || field.max_length.is_some()
                || field.format.is_some()
                || field.pattern.is_some()))
            || (!matches!(field.kind.as_str(), "number" | "integer")
                && (field.minimum.is_some() || field.maximum.is_some()))
            || (field.kind != "array" && (field.min_items.is_some() || field.max_items.is_some()))
            || (v.get("enumNames").is_some() && v.get("enum").is_none())
        {
            return Err(INVALID);
        }
        if field
            .min_length
            .zip(field.max_length)
            .is_some_and(|(a, b)| a > b)
            || field.minimum.zip(field.maximum).is_some_and(|(a, b)| a > b)
            || field
                .min_items
                .zip(field.max_items)
                .is_some_and(|(a, b)| a > b)
        {
            return Err(INVALID);
        }
        if field
            .format
            .as_deref()
            .is_some_and(|f| !matches!(f, "email" | "uri" | "date" | "date-time"))
            || field
                .pattern
                .as_ref()
                .is_some_and(|p| regex::Regex::new(p).is_err())
        {
            return Err(INVALID);
        }
        if let Some(value) = v.get("default") {
            if !valid_value(&field, value) {
                return Err(INVALID);
            }
            field.default = Some(value.clone());
        }
        fields.push(field);
    }
    Ok(fields)
}
pub fn valid_value(f: &Field, v: &Value) -> bool {
    match f.kind.as_str() {
        "string" => v.as_str().is_some_and(|s| {
            let len = s.chars().count();
            s.encode_utf16().count() <= 4000
                && !s.contains('\0')
                && f.min_length.is_none_or(|n| len >= n)
                && f.max_length.is_none_or(|n| len <= n)
                && (f.options.is_empty() || f.options.iter().any(|o| o.value == s))
                && f.pattern
                    .as_ref()
                    .is_none_or(|p| regex::Regex::new(p).is_ok_and(|r| r.is_match(s)))
                && match f.format.as_deref() {
                    Some("email") => s.split_once('@').is_some_and(|(a, b)| {
                        !a.is_empty()
                            && b.contains('.')
                            && !b.contains('@')
                            && !s.chars().any(char::is_whitespace)
                    }),
                    Some("uri") => reqwest::Url::parse(s).is_ok(),
                    Some("date") => {
                        s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
                    }
                    Some("date-time") => chrono::DateTime::parse_from_rfc3339(s).is_ok(),
                    None => true,
                    _ => false,
                }
        }),
        "number" | "integer" => v.as_f64().is_some_and(|n| {
            n.is_finite()
                && n.abs() <= 9_007_199_254_740_991.0
                && (f.kind != "integer" || n.fract() == 0.0)
                && f.minimum.is_none_or(|m| n >= m)
                && f.maximum.is_none_or(|m| n <= m)
        }),
        "boolean" => v.is_boolean(),
        "array" => v.as_array().is_some_and(|a| {
            a.len() <= 32
                && f.min_items.is_none_or(|m| a.len() >= m)
                && f.max_items.is_none_or(|m| a.len() <= m)
                && a.iter().all(|v| {
                    v.as_str()
                        .is_some_and(|s| f.options.iter().any(|o| o.value == s))
                })
                && a.iter().map(Value::to_string).collect::<HashSet<_>>().len() == a.len()
        }),
        _ => false,
    }
}
pub fn valid_content(fields: &[Field], content: &Value) -> bool {
    content.as_object().is_some_and(|o| {
        o.len() <= fields.len()
            && o.keys().all(|key| fields.iter().any(|f| &f.key == key))
            && fields
                .iter()
                .all(|f| o.get(&f.key).map_or(!f.required, |v| valid_value(f, v)))
    })
}
pub fn safe_url(value: &Value) -> Result<String, &'static str> {
    let raw = text(value, 8000)?;
    let url = reqwest::Url::parse(&raw).map_err(|_| INVALID)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err("This MCP request contains an unsupported URL.");
    }
    Ok(raw)
}
