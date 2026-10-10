//! Questions Claude is still writing. Claude streams a question tool's input as JSON for
//! seconds before the CLI calls the tool, so the reply shows the question as it is written and
//! the recorded request replaces it. A draft is display data only: it cannot be answered, and
//! it is never saved, synced or replayed.
use super::*;

/// Claude's question tools, whose input holds the questions.
const TOOLS: [&str; 2] = ["AskUserQuestion", "mcp__agent_studio__studio_ask_user"];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftQuestion {
    pub header: String,
    pub question: String,
    pub options: Vec<OptionItem>,
    pub multi_select: bool,
}
/// The questions one call has written so far.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Draft {
    /// The tool call writing them.
    pub id: String,
    pub revision: u64,
    pub questions: Vec<DraftQuestion>,
    /// The call ended without a question to answer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub closed: bool,
}
impl Draft {
    pub(super) fn closing(mut self) -> Self {
        self.revision += 1;
        self.closed = true;
        self.questions.clear();
        self
    }
}
struct Writing {
    json: String,
    draft: Draft,
}
#[derive(Default)]
pub(super) struct Drafts {
    /// Calls still being written, by their content block's index in the message.
    writing: HashMap<u64, Writing>,
    /// Written calls whose question is not recorded yet, with the draft last sent.
    written: HashMap<String, Draft>,
}
impl Drafts {
    /// The drafts a Claude line changes. Only the parent conversation asks questions.
    pub(super) fn observe(&mut self, value: &Value) -> Vec<Draft> {
        if !value["parent_tool_use_id"].is_null() {
            return vec![];
        }
        match value["type"].as_str() {
            Some("stream_event") => self.stream(&value["event"]),
            // A call that returns before its question was recorded never asks it: the CLI
            // refused its input, or the question was refused.
            Some("user") => value["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_result")
                .filter_map(|b| b["tool_use_id"].as_str())
                .filter_map(|id| self.take(id).map(Draft::closing))
                .collect(),
            _ => vec![],
        }
    }
    fn stream(&mut self, event: &Value) -> Vec<Draft> {
        let index = event["index"].as_u64();
        match event["type"].as_str().unwrap_or_default() {
            // A new message never continues a call an earlier one left unfinished.
            "message_start" => {
                let cut: Vec<String> = self.writing.values().map(|w| w.draft.id.clone()).collect();
                cut.iter()
                    .filter_map(|id| self.take(id).map(Draft::closing))
                    .collect()
            }
            "content_block_start" => {
                let block = &event["content_block"];
                let (Some(index), Some(id)) = (index, block["id"].as_str()) else {
                    return vec![];
                };
                if block["type"] != "tool_use"
                    || !TOOLS.contains(&block["name"].as_str().unwrap_or_default())
                    || !filled(id)
                {
                    return vec![];
                }
                let draft = Draft {
                    id: id.into(),
                    revision: 1,
                    questions: vec![],
                    closed: false,
                };
                self.writing.insert(
                    index,
                    Writing {
                        json: String::new(),
                        draft: draft.clone(),
                    },
                );
                vec![draft]
            }
            "content_block_delta" if event["delta"]["type"] == "input_json_delta" => {
                let (Some(writing), Some(text)) = (
                    index.and_then(|index| self.writing.get_mut(&index)),
                    event["delta"]["partial_json"].as_str(),
                ) else {
                    return vec![];
                };
                writing.json.push_str(text);
                let Some(input) = partial(&writing.json) else {
                    return vec![];
                };
                let questions = questions(&input);
                if questions == writing.draft.questions {
                    return vec![];
                }
                writing.draft.revision += 1;
                writing.draft.questions = questions;
                vec![writing.draft.clone()]
            }
            "content_block_stop" => {
                if let Some(writing) = index.and_then(|index| self.writing.remove(&index)) {
                    self.written.insert(writing.draft.id.clone(), writing.draft);
                }
                vec![]
            }
            _ => vec![],
        }
    }
    /// Stops following a call's draft: its question was recorded, or it ended without one.
    pub(super) fn take(&mut self, id: &str) -> Option<Draft> {
        if let Some(draft) = self.written.remove(id) {
            return Some(draft);
        }
        let index = *self.writing.iter().find(|(_, w)| w.draft.id == id)?.0;
        self.writing.remove(&index).map(|w| w.draft)
    }
}

/// The questions an input holds so far, each whole.
fn questions(input: &Value) -> Vec<DraftQuestion> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|q| q.is_object())
        .map(|q| DraftQuestion {
            header: text(&q["header"]),
            question: text(&q["question"]),
            options: q["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let label = text(&o["label"]);
                    (!label.trim().is_empty()).then(|| OptionItem {
                        label,
                        description: text(&o["description"]),
                    })
                })
                .collect(),
            multi_select: q["multiSelect"].as_bool().unwrap_or(false),
        })
        .collect()
}
fn text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| *c != '\0')
        .collect()
}

/// Reads the start of a JSON document still being written. A string, array or object cut off
/// at the end keeps what it holds so far; a member whose value has not begun, and a number or
/// literal that may still grow, are left out. Malformed text reads as nothing.
fn partial(text: &str) -> Option<Value> {
    match (Reader {
        text,
        at: 0,
        depth: 0,
    })
    .value()?
    {
        Read::Value(value, _) => Some(value),
        Read::Cut => None,
    }
}
enum Read {
    /// A value, and whether it is complete.
    Value(Value, bool),
    /// The text ends before the value shows anything.
    Cut,
}
struct Reader<'a> {
    text: &'a str,
    at: usize,
    depth: usize,
}
impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }
    /// None for malformed text.
    fn value(&mut self) -> Option<Read> {
        self.space();
        match self.peek() {
            None => Some(Read::Cut),
            Some(b'"') => {
                let (text, complete) = self.string()?;
                Some(Read::Value(Value::String(text), complete))
            }
            Some(b'{' | b'[') if self.depth >= 16 => None,
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(_) => self.scalar(),
        }
    }
    fn scalar(&mut self) -> Option<Read> {
        let start = self.at;
        while let Some(b) = self.peek() {
            if matches!(b, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r') {
                break;
            }
            self.at += 1;
        }
        // At the end, `1` may become `12` and `fals` is still being written.
        if self.peek().is_none() {
            return Some(Read::Cut);
        }
        serde_json::from_str(&self.text[start..self.at])
            .ok()
            .map(|value| Read::Value(value, true))
    }
    /// A string and whether its closing quote arrived. An escape cut off at the end is left out.
    fn string(&mut self) -> Option<(String, bool)> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' {
                    break;
                }
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.peek() {
                None => return Some((out, false)),
                Some(b'"') => {
                    self.at += 1;
                    return Some((out, true));
                }
                _ => {}
            }
            let Some(kind) = self.text.as_bytes().get(self.at + 1).copied() else {
                self.at = self.text.len();
                return Some((out, false));
            };
            self.at += 2;
            let c = match kind {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => match self.unicode()? {
                    Some(c) => c,
                    None => {
                        self.at = self.text.len();
                        return Some((out, false));
                    }
                },
                _ => return None,
            };
            out.push(c);
        }
    }
    /// The character of a `\u` escape, or None inside when the text ends within it.
    fn unicode(&mut self) -> Option<Option<char>> {
        let Some(high) = self.hex()? else {
            return Some(None);
        };
        if !(0xD800..0xDC00).contains(&high) {
            return Some(Some(char::from_u32(high).unwrap_or('\u{FFFD}')));
        }
        // A high surrogate pairs with the escape after it.
        let rest = &self.text.as_bytes()[self.at..];
        if rest.len() < 2 && b"\\u".starts_with(rest) {
            return Some(None);
        }
        if !rest.starts_with(b"\\u") {
            return Some(Some('\u{FFFD}'));
        }
        let mark = self.at;
        self.at += 2;
        match self.hex()? {
            None => Some(None),
            Some(low) if (0xDC00..0xE000).contains(&low) => Some(Some(
                char::from_u32(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
                    .unwrap_or('\u{FFFD}'),
            )),
            Some(_) => {
                self.at = mark;
                Some(Some('\u{FFFD}'))
            }
        }
    }
    /// Four hex digits, or None inside when the text ends first.
    fn hex(&mut self) -> Option<Option<u32>> {
        let rest = &self.text.as_bytes()[self.at..];
        let digits = &rest[..rest.len().min(4)];
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        if digits.len() < 4 {
            return Some(None);
        }
        self.at += 4;
        u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16)
            .ok()
            .map(Some)
    }
    fn object(&mut self) -> Option<Read> {
        self.at += 1;
        self.depth += 1;
        let mut map = serde_json::Map::new();
        let complete = loop {
            self.space();
            match self.peek() {
                None => break false,
                Some(b'}') => {
                    self.at += 1;
                    break true;
                }
                Some(b',') => {
                    self.at += 1;
                    continue;
                }
                Some(b'"') => {}
                Some(_) => return None,
            }
            let (key, complete) = self.string()?;
            if !complete {
                break false;
            }
            self.space();
            match self.peek() {
                None => break false,
                Some(b':') => self.at += 1,
                Some(_) => return None,
            }
            match self.value()? {
                Read::Cut => break false,
                Read::Value(value, complete) => {
                    map.insert(key, value);
                    if !complete {
                        break false;
                    }
                }
            }
        };
        self.depth -= 1;
        Some(Read::Value(Value::Object(map), complete))
    }
    fn array(&mut self) -> Option<Read> {
        self.at += 1;
        self.depth += 1;
        let mut items = vec![];
        let complete = loop {
            self.space();
            match self.peek() {
                None => break false,
                Some(b']') => {
                    self.at += 1;
                    break true;
                }
                Some(b',') => {
                    self.at += 1;
                    continue;
                }
                Some(_) => {}
            }
            match self.value()? {
                Read::Cut => break false,
                Read::Value(value, complete) => {
                    items.push(value);
                    if !complete {
                        break false;
                    }
                }
            }
        };
        self.depth -= 1;
        Some(Read::Value(Value::Array(items), complete))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(event: Value) -> Value {
        json!({"type":"stream_event","parent_tool_use_id":null,"event":event})
    }
    fn delta(index: u64, text: &str) -> Value {
        stream(
            json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":text}}),
        )
    }
    fn start(index: u64, id: &str, name: &str) -> Value {
        stream(
            json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
        )
    }

    #[test]
    fn partial_json_keeps_what_each_prefix_holds() {
        let input = json!({"questions":[{"id":"theme","header":"Theme","question":"Which \"theme\"?\nPick one 🎨 \u{e9}","multiSelect":true,"options":[{"label":"Dark","description":"Easy on the eyes"},{"label":"Light","description":""}]}]});
        let text = serde_json::to_string(&input)
            .unwrap()
            .replace('🎨', "\\ud83c\\udfa8")
            .replace('é', "\\u00e9");
        let mut last = Value::Null;
        // Every prefix reads, never loses what an earlier one showed, and ends as the input.
        for end in (0..=text.len()).filter(|end| text.is_char_boundary(*end)) {
            let Some(value) = partial(&text[..end]) else {
                assert!(end < 16, "{}", &text[..end]);
                continue;
            };
            let question = value["questions"][0]["question"]
                .as_str()
                .unwrap_or_default();
            let before = last["questions"][0]["question"]
                .as_str()
                .unwrap_or_default();
            assert!(question.starts_with(before), "{before:?} → {question:?}");
            last = value;
        }
        assert_eq!(last, input);
        assert_eq!(
            partial(r#"{"questions":[{"id":"a","header""#).unwrap(),
            json!({"questions":[{"id":"a"}]})
        );
        assert_eq!(
            partial(r#"{"questions":[{"multiSelect":fals"#).unwrap(),
            json!({"questions":[{}]})
        );
        assert_eq!(partial(r#"{"q":"a\"#).unwrap(), json!({"q":"a"}));
        assert_eq!(partial(r#"{"q":"a\ud83c"#).unwrap(), json!({"q":"a"}));
        assert_eq!(partial(r#"{"q":"a\ud83c\"#).unwrap(), json!({"q":"a"}));
        assert_eq!(partial(r#"{"q":"a\u00"#).unwrap(), json!({"q":"a"}));
        assert_eq!(
            partial(r#"{"q":"\ud83cx"}"#).unwrap(),
            json!({"q":"\u{FFFD}x"})
        );
        for malformed in [r#"{"q" 1}"#, r#"{q:1}"#, r#"{"q":"\x"}"#, r#"{"q":tru}"#] {
            assert!(partial(malformed).is_none(), "{malformed}");
        }
        assert!(partial(&"[".repeat(100)).is_none());
    }

    #[test]
    fn a_question_call_streams_drafts_until_its_question_is_recorded() {
        let mut drafts = Drafts::default();
        let id = "toolu_question";
        assert_eq!(
            drafts.observe(&start(1, id, "mcp__agent_studio__studio_ask_user")),
            vec![Draft {
                id: id.into(),
                revision: 1,
                questions: vec![],
                closed: false
            }]
        );
        assert!(drafts.observe(&start(2, "toolu_other", "Bash")).is_empty());
        let mut shown = vec![];
        for part in [
            r#"{"questions": [{"id": "theme", "hea"#,
            r#"der": "Theme", "question": "Which the"#,
            r#"me do you prefer?", "multiSelect": false, "options": [{"label": "Da"#,
            r#"rk", "description": "Easy on"#,
            r#" the eyes"}]}]}"#,
        ] {
            shown.extend(drafts.observe(&delta(1, part)));
        }
        assert_eq!(
            shown
                .iter()
                .map(|d| d.questions[0].question.as_str())
                .collect::<Vec<_>>(),
            [
                "",
                "Which the",
                "Which theme do you prefer?",
                "Which theme do you prefer?",
                "Which theme do you prefer?"
            ]
        );
        assert_eq!(
            shown.iter().map(|d| d.revision).collect::<Vec<_>>(),
            [2, 3, 4, 5, 6]
        );
        let last = shown.last().unwrap();
        assert_eq!(last.questions[0].options[0].description, "Easy on the eyes");
        // A delta that changes nothing visible sends nothing.
        assert!(drafts.observe(&delta(1, " ")).is_empty());
        // A child's stream never drafts the parent's question.
        let mut child = start(3, "toolu_child", "AskUserQuestion");
        child["parent_tool_use_id"] = json!("toolu_agent");
        assert!(drafts.observe(&child).is_empty());
        drafts.observe(&stream(json!({"type":"content_block_stop","index":1})));
        assert_eq!(drafts.take(id).unwrap().revision, 6);
        assert!(drafts.take(id).is_none());
        // Its result, once answered, closes nothing.
        assert!(drafts
            .observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":id}]}}))
            .is_empty());
    }

    #[test]
    fn a_call_that_ends_without_a_question_closes_its_draft() {
        let mut drafts = Drafts::default();
        drafts.observe(&start(0, "refused", "AskUserQuestion"));
        drafts.observe(&delta(0, r#"{"questions":[{"question":"Why"#));
        drafts.observe(&stream(json!({"type":"content_block_stop","index":0})));
        let closed = drafts.observe(&json!({"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"refused","is_error":true}]}}));
        assert_eq!(
            closed,
            vec![Draft {
                id: "refused".into(),
                revision: 3,
                questions: vec![],
                closed: true
            }]
        );
        // A retried request abandons a call it left unfinished.
        drafts.observe(&start(0, "cut", "AskUserQuestion"));
        let closed = drafts.observe(&stream(json!({"type":"message_start","message":{}})));
        assert_eq!(closed.len(), 1);
        assert!(closed[0].closed && closed[0].id == "cut");
        // Input of any length keeps updating the draft, past the 32,000 bytes earlier releases
        // followed.
        drafts.observe(&start(0, "long", "AskUserQuestion"));
        let long = "a".repeat(40_000);
        let text = format!(r#"{{"questions":[{{"question":"{long}"#);
        assert_eq!(
            drafts.observe(&delta(0, &text))[0].questions[0].question,
            long
        );
        assert_eq!(
            drafts.observe(&delta(0, "b"))[0].questions[0].question,
            format!("{long}b")
        );
    }
}
