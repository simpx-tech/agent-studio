//! Explicit file-edit results, kept separate from activity metadata and prompt replay.
//! Never reads paths, command output, or arbitrary tool result bodies.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePatch {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_path: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunks: Option<Vec<Hunk>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edit {
    pub id: String,
    pub files: Vec<FilePatch>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub revision: u64,
    pub edits: Vec<Edit>,
}
pub struct FileChangeDecoder {
    snapshot: Snapshot,
    claude_calls: HashMap<String, (String, String)>,
}
impl Snapshot {
    pub fn empty() -> Self {
        Self {
            revision: 1,
            edits: vec![],
        }
    }
}
impl Default for FileChangeDecoder {
    fn default() -> Self {
        Self {
            snapshot: Snapshot::empty(),
            claude_calls: HashMap::new(),
        }
    }
}
fn valid_path(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        .map(String::from)
}
pub(crate) fn private_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_lowercase();
    let name = normalized.rsplit('/').next().unwrap_or_default();
    name == ".env"
        || name.starts_with(".env.")
        || matches!(
            name,
            "auth.json" | "credentials.json" | ".credentials.json" | "id_rsa" | "id_ed25519"
        )
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|ext| name.ends_with(ext))
}
fn valid_hunks(hunks: &[Hunk]) -> bool {
    let mut previous_end: u64 = 0;
    for h in hunks {
        let index = if h.old_lines == 0 {
            h.old_start
        } else {
            h.old_start.saturating_sub(1)
        };
        if index < previous_end
            || (h.old_lines > 0 && h.old_start == 0)
            || (h.new_lines > 0 && h.new_start == 0)
        {
            return false;
        }
        let Some(end) = index.checked_add(h.old_lines) else {
            return false;
        };
        previous_end = end;
        let (mut old, mut new) = (0, 0);
        for (i, line) in h.lines.iter().enumerate() {
            match line.as_bytes().first() {
                Some(b' ') => {
                    old += 1;
                    new += 1;
                }
                Some(b'-') => old += 1,
                Some(b'+') => new += 1,
                _ if line == "\\ No newline at end of file" && i > 0 && h.lines[i - 1] != *line => {
                }
                _ => return false,
            }
        }
        if old != h.old_lines || new != h.new_lines {
            return false;
        }
    }
    true
}
fn range(s: &str) -> Option<(u64, u64)> {
    let (start, count) = s.split_once(',').unwrap_or((s, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}
fn unified(text: &str) -> Option<Vec<Hunk>> {
    if text.contains('\0') {
        return None;
    }
    let mut hunks: Vec<Hunk> = vec![];
    // Retain CR bytes from source lines so file Undo can compare/restore CRLF exactly.
    for line in text.split_terminator('\n') {
        if line.starts_with("@@ ") {
            let mut header = line.split_whitespace();
            header.next()?;
            let (old_start, old_lines) = range(header.next()?.strip_prefix('-')?)?;
            let (new_start, new_lines) = range(header.next()?.strip_prefix('+')?)?;
            if header.next()? != "@@" {
                return None;
            }
            hunks.push(Hunk {
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: vec![],
            });
        } else if let Some(hunk) = hunks.last_mut() {
            hunk.lines.push(
                if line.trim_end_matches('\r') == "\\ No newline at end of file" {
                    "\\ No newline at end of file".into()
                } else {
                    line.into()
                },
            );
        }
    }
    (!hunks.is_empty() && valid_hunks(&hunks)).then_some(hunks)
}
fn structured(value: &Value) -> Option<Vec<Hunk>> {
    let mut hunks = vec![];
    for h in value.as_array()? {
        let lines = h["lines"]
            .as_array()?
            .iter()
            .map(|line| {
                let text = line.as_str()?;
                (!text.contains('\0')).then(|| text.to_owned())
            })
            .collect::<Option<Vec<_>>>()?;
        hunks.push(Hunk {
            old_start: h["oldStart"].as_u64()?,
            old_lines: h["oldLines"].as_u64()?,
            new_start: h["newStart"].as_u64()?,
            new_lines: h["newLines"].as_u64()?,
            lines,
        });
    }
    valid_hunks(&hunks).then_some(hunks)
}
fn created(content: &str) -> Option<Vec<Hunk>> {
    if content.contains('\0') {
        return None;
    }
    let mut lines: Vec<String> = content
        .split_inclusive('\n')
        .map(|s| format!("+{}", s.strip_suffix('\n').unwrap_or(s)))
        .collect();
    let count = lines.len() as u64;
    if !content.is_empty() && !content.ends_with('\n') {
        lines.push("\\ No newline at end of file".into());
    }
    let hunks = if content.is_empty() {
        vec![]
    } else {
        vec![Hunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: count,
            lines,
        }]
    };
    valid_hunks(&hunks).then_some(hunks)
}
impl FileChangeDecoder {
    fn publish(&mut self, edit: Option<Edit>) -> Option<Snapshot> {
        let mut next = self.snapshot.clone();
        if let Some(edit) = edit {
            if let Some(index) = next.edits.iter().position(|e| e.id == edit.id) {
                next.edits[index] = edit;
            } else {
                next.edits.push(edit);
            }
        }
        if next == self.snapshot {
            return None;
        }
        next.revision += 1;
        self.snapshot = next.clone();
        Some(next)
    }
    pub fn codex_server(&mut self, value: &Value) -> Option<Snapshot> {
        let params = &value["params"];
        let item = &params["item"];
        if value["method"] == "item/completed" && item["type"] == "fileChange" {
            let id = format!(
                "codex:{}:{}",
                params["threadId"].as_str()?,
                item["id"].as_str()?
            );
            self.codex_item(item, &id)
        } else {
            self.publish(None)
        }
    }
    fn codex_item(&mut self, item: &Value, id: &str) -> Option<Snapshot> {
        if !matches!(item["status"].as_str(), Some("completed" | "complete")) {
            return self.publish(None);
        }
        let changes = item["changes"].as_array()?;
        let mut files = vec![];
        for change in changes {
            let Some(path) = valid_path(&change["path"]) else {
                continue;
            };
            let kind = change["kind"]
                .as_str()
                .or_else(|| change["kind"]["type"].as_str());
            let previous_path = path.clone();
            let moved = valid_path(&change["kind"]["movePath"])
                .or_else(|| valid_path(&change["move_path"]));
            let (path, previous_path, kind) = if let Some(moved) = moved {
                (moved, Some(previous_path), "renamed")
            } else {
                (
                    path,
                    None,
                    match kind {
                        Some("add" | "added") => "added",
                        Some("delete" | "deleted") => "deleted",
                        _ => "modified",
                    },
                )
            };
            let hunks = if private_path(&path) || previous_path.as_deref().is_some_and(private_path)
            {
                None
            } else if kind == "added" {
                // App-server add/delete events carry the complete file text in `diff`;
                // updates carry unified hunks. This is confirmed tool-result source.
                change["diff"].as_str().and_then(created)
            } else if kind == "deleted" {
                change["diff"].as_str().and_then(created).map(|mut hunks| {
                    for h in &mut hunks {
                        h.old_start = h.new_start;
                        h.old_lines = h.new_lines;
                        h.new_start = 0;
                        h.new_lines = 0;
                        for line in &mut h.lines {
                            if line.starts_with('+') {
                                line.replace_range(..1, "-");
                            }
                        }
                    }
                    hunks
                })
            } else {
                change["diff"]
                    .as_str()
                    .and_then(unified)
                    .or_else(|| (kind == "renamed" && change["diff"] == "").then(Vec::new))
            };
            files.push(FilePatch {
                path,
                previous_path,
                kind: kind.into(),
                hunks,
            });
        }
        self.publish(Some(Edit {
            id: id.into(),
            files,
        }))
    }
    pub fn decode(&mut self, provider: &str, value: &Value) -> Option<Snapshot> {
        if provider == "codex" {
            if value["type"] == "item.completed" && value["item"]["type"] == "file_change" {
                return self.codex_item(
                    &value["item"],
                    &format!("codex:{}", value["item"]["id"].as_str()?),
                );
            }
            return self.publish(None);
        }
        if provider != "claude" {
            return None;
        }
        let mut changed = None;
        if let Some(blocks) = value["message"]["content"].as_array() {
            for block in blocks {
                if block["type"] == "tool_use" {
                    if let (Some(id), Some(name), Some(path)) = (
                        block["id"].as_str(),
                        block["name"].as_str(),
                        valid_path(&block["input"]["file_path"]),
                    ) {
                        if matches!(name, "Edit" | "Write" | "MultiEdit") {
                            self.claude_calls.insert(id.into(), (name.into(), path));
                        }
                    }
                } else if block["type"] == "tool_result" {
                    let Some(id) = block["tool_use_id"].as_str() else {
                        continue;
                    };
                    let Some((name, path)) = self.claude_calls.get(id) else {
                        continue;
                    };
                    if block["is_error"] == true {
                        continue;
                    }
                    let result = &value["tool_use_result"];
                    let is_create = name == "Write" && result["type"] == "create";
                    let hunks = if private_path(path) {
                        None
                    } else if is_create {
                        result["content"]
                            .as_str()
                            .and_then(created)
                            .or_else(|| structured(&result["structuredPatch"]))
                    } else {
                        structured(&result["structuredPatch"])
                    };
                    let edit = Some(Edit {
                        id: format!("claude:{id}"),
                        files: vec![FilePatch {
                            path: path.clone(),
                            previous_path: None,
                            kind: if is_create { "added" } else { "modified" }.into(),
                            hunks,
                        }],
                    });
                    if let Some(next) = self.publish(edit) {
                        changed = Some(next);
                    }
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn writes_creates_renames_and_missing_results_keep_honest_metadata() {
        let mut d = FileChangeDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"write","name":"Write","input":{"file_path":"new.txt","content":"not trusted before success"}}]}}));
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"write"}]},"tool_use_result":{"type":"create","content":"created\n","structuredPatch":[]}});
        let created = d.decode("claude", &result).unwrap();
        assert_eq!(created.edits[0].files[0].kind, "added");
        assert_eq!(
            created.edits[0].files[0].hunks.as_ref().unwrap()[0].lines,
            ["+created"]
        );
        let rename = json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"rename","type":"fileChange","status":"completed","changes":[{"path":"old.txt","kind":{"type":"update","movePath":"renamed.txt"},"diff":""}]}}});
        let renamed = d.codex_server(&rename).unwrap();
        assert_eq!(renamed.edits[1].files[0].path, "renamed.txt");
        assert_eq!(
            renamed.edits[1].files[0].previous_path.as_deref(),
            Some("old.txt")
        );
        assert_eq!(renamed.edits[1].files[0].hunks, Some(vec![]));
    }
    #[test]
    fn unrelated_codex_threads_and_failed_claude_edits_never_supply_diffs() {
        let mut decoder = crate::protocol::Decoder::default();
        let event = json!({"method":"item/completed","params":{"threadId":"unrelated","item":{"id":"1","type":"fileChange","status":"completed","changes":[{"path":"a","kind":{"type":"update"},"diff":"@@ -1 +1 @@\n-old\n+new\n"}]}}});
        assert!(decoder.decode_codex_server(&event, "root").is_empty());
        let mut d = FileChangeDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"failed","name":"Edit","input":{"file_path":"a"}}]}}));
        assert!(d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"failed","is_error":true}]},"tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-old","+new"]}]}})).is_none());
    }
    #[test]
    fn codex_changes_are_confirmed_and_not_command_output() {
        let mut d = FileChangeDecoder::default();
        let event = json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"1","type":"fileChange","status":"completed","changes":[{"path":"src/a.ts","kind":{"type":"update"},"diff":"@@ -1 +1 @@\n-old\n+new\n"}]}}});
        let s = d.codex_server(&event).unwrap();
        assert_eq!(
            s.edits[0].files[0].hunks.as_ref().unwrap()[0].lines,
            ["-old", "+new"]
        );
        assert!(d.codex_server(&event).is_none());
        let mut failed = event.clone();
        failed["params"]["item"]["status"] = json!("failed");
        assert!(d.codex_server(&failed).is_none());
        let command = json!({"method":"item/completed","params":{"item":{"type":"commandExecution","aggregatedOutput":"@@ -1 +1 @@\n-secret\n+data"}}});
        assert!(d.codex_server(&command).is_none());
    }
    #[test]
    fn claude_uses_matching_successful_structured_results() {
        let mut d = FileChangeDecoder::default();
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Edit","input":{"file_path":"a.ts","old_string":"not forwarded"}}]}}));
        let event = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","content":"not forwarded"}]},"tool_use_result":{"structuredPatch":[{"oldStart":2,"oldLines":1,"newStart":2,"newLines":1,"lines":["-before","+after"]}]}});
        let s = d.decode("claude", &event).unwrap();
        assert!(s.edits[0].files[0].hunks.is_some());
        assert!(!serde_json::to_string(&s).unwrap().contains("not forwarded"));
        assert!(d.decode("claude", &event).is_none());
    }
    #[test]
    fn malformed_and_private_diffs_are_not_published_as_source() {
        assert!(unified("@@ -1,2 +1 @@\n-before\n+after").is_none());
        assert!(unified("@@ -1 +1 @@\n-before\0\n+after").is_none());
        // Diffs of any size are recorded, past the 128,000 bytes earlier releases kept.
        let long = format!(
            "@@ -1 +1 @@\n-{}\n+{}\n",
            "a".repeat(100_000),
            "b".repeat(100_000)
        );
        assert_eq!(unified(&long).unwrap()[0].lines[1].len(), 100_001);
        assert!(created(&"line\n".repeat(50_000)).is_some());
        assert!(private_path("C:\\Project\\.env.local"));
        assert!(private_path("/home/test/.codex/auth.json"));
        assert!(!private_path("src/auth.ts"));
        let h = created("line without newline").unwrap();
        assert_eq!(h[0].lines[1], "\\ No newline at end of file");
    }
    #[test]
    fn codex_add_delete_results_contain_source_text_not_unified_hunks() {
        let mut decoder = FileChangeDecoder::default();
        let result = decoder.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","item":{"id":"add","type":"fileChange","status":"completed","changes":[{"path":"new.txt","kind":{"type":"add"},"diff":"ORIGINAL\n"},{"path":"gone.txt","kind":{"type":"delete"},"diff":"gone"}]}}})).unwrap();
        assert_eq!(
            result.edits[0].files[0].hunks.as_ref().unwrap()[0].lines,
            vec!["+ORIGINAL"]
        );
        let deleted = &result.edits[0].files[1].hunks.as_ref().unwrap()[0];
        assert_eq!(deleted.old_lines, 1);
        assert_eq!(deleted.new_lines, 0);
        assert_eq!(deleted.lines, vec!["-gone", "\\ No newline at end of file"]);
    }
    #[test]
    fn every_claude_edit_of_a_reply_is_recorded() {
        // Past the 100 calls earlier releases tracked, which lost later edits.
        let mut d = FileChangeDecoder::default();
        let mut last = None;
        for index in 0..150 {
            let id = format!("edit{index}");
            d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Edit","input":{"file_path":format!("f{index}.ts")}}]}}));
            last = d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id}]},"tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-old","+new"]}]}}));
        }
        let snapshot = last.unwrap();
        assert_eq!(snapshot.edits.len(), 150);
        assert!(snapshot.edits.iter().all(|e| e.files[0].hunks.is_some()));
    }
    #[test]
    fn source_line_endings_are_not_normalized() {
        assert_eq!(created("new\r\n").unwrap()[0].lines, vec!["+new\r"]);
        assert_eq!(
            unified("@@ -1 +1 @@\n-old\r\n+new\r\n").unwrap()[0].lines,
            vec!["-old\r", "+new\r"]
        );
    }
}
