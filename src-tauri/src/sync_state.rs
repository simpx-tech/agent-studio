//! The sync checkpoint, `sync-state.json`: the relay's copy of the workspace as this device last
//! agreed with it, which the next start of the app merges against.
//!
//! It holds every conversation, and the window used to send all of it for each write: 86 MB of
//! text written in the page and parsed on this process's window thread once a minute while
//! replies ran, with the page blocked for half a second or more each time (docs/PERFORMANCE.md).
//! A write now carries the conversations that changed since the last one, as bytes (sent.rs),
//! and names every conversation in order; the rest are copied from the file as they are, without
//! being parsed into values. A conversation neither sent nor in the file fails the write with
//! `NEEDS_WHOLE`, and the window then sends everything, as it does the first time.
use crate::sent::Sent;
use serde::Deserialize;
use serde_json::{value::RawValue, Value};
use std::{borrow::Cow, collections::HashMap, io::Write, path::Path};

/// Told when a write cannot be completed from the file, so the window sends everything.
pub const NEEDS_WHOLE: &str = "The whole sync checkpoint is needed to save this change.";
const FILE: &str = "sync-state.json";

/// Writes the checkpoint a window sent: whole, or the conversations that changed with the order
/// of them all.
pub fn save(root: &Path, sent: Sent) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Whole {
        value: Value,
    }
    #[derive(Deserialize)]
    struct Written<'a> {
        value: Value,
        order: Option<Vec<String>>,
        #[serde(borrow, default)]
        upsert: Vec<&'a RawValue>,
    }
    match sent {
        Sent::Plain(_) => write(root, &sent.read::<Whole>()?.value),
        Sent::Bytes(bytes) => {
            let written: Written =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid sync checkpoint")?;
            match written.order {
                Some(order) => patch(root, written.value, &order, &written.upsert),
                None => write(root, &written.value),
            }
        }
    }
}

/// Writes a whole checkpoint.
pub fn write(root: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode sync checkpoint")?;
    replace(root, &bytes)
}

/// A conversation's id, read without building the conversation.
fn id(conversation: &RawValue) -> Option<Cow<'_, str>> {
    #[derive(Deserialize)]
    struct Named<'a> {
        #[serde(borrow)]
        id: Cow<'a, str>,
    }
    serde_json::from_str::<Named>(conversation.get())
        .ok()
        .map(|named| named.id)
}

/// Writes `value`, a checkpoint without its conversations, with the conversations `order` names:
/// each from `upsert` when it was sent, and otherwise as the file holds it.
fn patch(root: &Path, value: Value, order: &[String], upsert: &[&RawValue]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Kept<'a> {
        #[serde(borrow)]
        base: KeptBase<'a>,
    }
    #[derive(Deserialize)]
    struct KeptBase<'a> {
        #[serde(borrow, default)]
        conversations: Vec<&'a RawValue>,
    }
    let Value::Object(mut value) = value else {
        return Err("Invalid sync checkpoint".into());
    };
    let Some(Value::Object(base)) = value.remove("base") else {
        return Err("Invalid sync checkpoint".into());
    };
    let mut sent = HashMap::new();
    for conversation in upsert {
        sent.insert(
            id(conversation).ok_or("Invalid sync checkpoint")?,
            *conversation,
        );
    }
    // Only a write that leaves a conversation out reads the file.
    let complete = order.iter().all(|id| sent.contains_key(id.as_str()));
    let existing = if complete {
        Vec::new()
    } else {
        std::fs::read(root.join(FILE)).map_err(|_| NEEDS_WHOLE)?
    };
    let mut kept = HashMap::new();
    if !complete {
        let file: Kept = serde_json::from_slice(&existing).map_err(|_| NEEDS_WHOLE)?;
        for conversation in file.base.conversations {
            kept.insert(id(conversation).ok_or(NEEDS_WHOLE)?, conversation);
        }
    }
    // A conversation sent but left out of the order would be silently discarded.
    if sent.keys().any(|id| !order.iter().any(|named| named == id)) {
        return Err(NEEDS_WHOLE.into());
    }
    let size = upsert.iter().map(|c| c.get().len()).sum::<usize>() + existing.len();
    let mut out = Vec::with_capacity(size + 4096);
    let failed = |_| "Cannot encode sync checkpoint".to_string();
    let field = |out: &mut Vec<u8>, first: &mut bool, name: &str| {
        if !std::mem::take(first) {
            out.push(b',');
        }
        serde_json::to_writer(&mut *out, name)?;
        out.push(b':');
        Ok::<(), serde_json::Error>(())
    };
    out.push(b'{');
    let mut first = true;
    for (name, item) in &value {
        field(&mut out, &mut first, name).map_err(failed)?;
        serde_json::to_writer(&mut out, item).map_err(failed)?;
    }
    field(&mut out, &mut first, "base").map_err(failed)?;
    out.push(b'{');
    let mut first = true;
    for (name, item) in base.iter().filter(|(name, _)| *name != "conversations") {
        field(&mut out, &mut first, name).map_err(failed)?;
        serde_json::to_writer(&mut out, item).map_err(failed)?;
    }
    field(&mut out, &mut first, "conversations").map_err(failed)?;
    out.push(b'[');
    for (index, id) in order.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        let conversation = sent
            .get(id.as_str())
            .or_else(|| kept.get(id.as_str()))
            .ok_or(NEEDS_WHOLE)?;
        out.extend_from_slice(conversation.get().as_bytes());
    }
    out.extend_from_slice(b"]}}");
    replace(root, &out)
}

/// Replaces the file with these bytes, written and flushed beside it first.
fn replace(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare sync checkpoint")?;
    file.write_all(bytes)
        .map_err(|_| "Cannot write sync checkpoint")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush sync checkpoint")?;
    file.persist(root.join(FILE))
        .map_err(|_| "Cannot save sync checkpoint")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chat(id: &str, title: &str) -> Value {
        json!({"title": title, "id": id, "messages": [{"id": "m", "blocks": []}]})
    }
    fn checkpoint(chats: Vec<Value>) -> Value {
        json!({
            "url": "https://relay.example",
            "instanceId": "relay",
            "revisions": {"revision": 3, "chats": {}, "metaRevision": 1},
            "base": {"fleet": {"computers": []}, "conversations": chats},
        })
    }
    fn saved(root: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(root.join(FILE)).unwrap()).unwrap()
    }
    /// A write that sends `upsert` and names `order`, as the window sends it.
    fn written(value: &Value, order: &[&str], upsert: &[Value]) -> Sent {
        let mut head = value.clone();
        head["base"]
            .as_object_mut()
            .unwrap()
            .remove("conversations");
        Sent::Bytes(
            serde_json::to_vec(&json!({"value": head, "order": order, "upsert": upsert})).unwrap(),
        )
    }

    #[test]
    fn writes_a_whole_checkpoint_sent_either_way() {
        let folder = tempfile::tempdir().unwrap();
        let whole = checkpoint(vec![chat("a", "First")]);
        save(folder.path(), Sent::Plain(json!({"value": whole}))).unwrap();
        assert_eq!(saved(folder.path()), whole);
        let other = checkpoint(vec![chat("b", "Second")]);
        let bytes = serde_json::to_vec(&json!({"value": other})).unwrap();
        save(folder.path(), Sent::Bytes(bytes)).unwrap();
        assert_eq!(saved(folder.path()), other);
    }

    #[test]
    fn completes_a_write_from_the_file_it_replaces() {
        let folder = tempfile::tempdir().unwrap();
        let first = checkpoint(vec![
            chat("a", "First"),
            chat("b", "Second"),
            chat("c", "Third"),
        ]);
        write(folder.path(), &first).unwrap();
        // One conversation changed, one is new, one is gone, and the order moved.
        let mut next = checkpoint(vec![]);
        next["revisions"]["revision"] = json!(4);
        let sent = written(
            &next,
            &["d", "c", "a"],
            &[chat("a", "Renamed"), chat("d", "New")],
        );
        save(folder.path(), sent).unwrap();
        let after = saved(folder.path());
        assert_eq!(after["revisions"]["revision"], 4);
        assert_eq!(after["url"], "https://relay.example");
        assert_eq!(after["base"]["fleet"], json!({"computers": []}));
        assert_eq!(
            after["base"]["conversations"],
            json!([chat("d", "New"), chat("c", "Third"), chat("a", "Renamed")])
        );
        // And again, from the file that write left.
        let sent = written(&next, &["c", "d"], &[]);
        save(folder.path(), sent).unwrap();
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([chat("c", "Third"), chat("d", "New")])
        );
    }

    #[test]
    fn keeps_an_unchanged_conversation_byte_for_byte() {
        let folder = tempfile::tempdir().unwrap();
        // Text a parser and a writer could change between them: escapes, a long number.
        let odd = r#"{"id":"a","title":"\u00e9\/ \ud83d\ude00","n":1.0000000000000000000001,"messages":[]}"#;
        let file = format!(r#"{{"url":"u","base":{{"conversations":[{odd}]}}}}"#);
        std::fs::write(folder.path().join(FILE), &file).unwrap();
        let sent = Sent::Bytes(
            br#"{"value":{"url":"u","base":{}},"order":["b","a"],"upsert":[{"id":"b"}]}"#.to_vec(),
        );
        save(folder.path(), sent).unwrap();
        let after = std::fs::read_to_string(folder.path().join(FILE)).unwrap();
        assert_eq!(
            after,
            format!(r#"{{"url":"u","base":{{"conversations":[{{"id":"b"}},{odd}]}}}}"#)
        );
    }

    #[test]
    fn writes_without_the_file_when_every_conversation_is_sent() {
        let folder = tempfile::tempdir().unwrap();
        let next = checkpoint(vec![]);
        let sent = written(&next, &["a"], &[chat("a", "First")]);
        save(folder.path(), sent).unwrap();
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([chat("a", "First")])
        );
        // No conversation at all is a checkpoint too.
        save(folder.path(), written(&next, &[], &[])).unwrap();
        assert_eq!(saved(folder.path())["base"]["conversations"], json!([]));
    }

    #[test]
    fn asks_for_everything_rather_than_dropping_a_conversation() {
        let folder = tempfile::tempdir().unwrap();
        let next = checkpoint(vec![]);
        // No file to complete the write from.
        let missing = written(&next, &["a", "b"], &[chat("a", "First")]);
        assert_eq!(save(folder.path(), missing).unwrap_err(), NEEDS_WHOLE);
        assert!(!folder.path().join(FILE).exists());
        write(folder.path(), &checkpoint(vec![chat("a", "First")])).unwrap();
        // A conversation neither sent nor in the file.
        let unknown = written(&next, &["a", "b"], &[]);
        assert_eq!(save(folder.path(), unknown).unwrap_err(), NEEDS_WHOLE);
        // A conversation sent but not named in the order.
        let unnamed = written(&next, &["a"], &[chat("b", "Second")]);
        assert_eq!(save(folder.path(), unnamed).unwrap_err(), NEEDS_WHOLE);
        // A file that is not a checkpoint.
        std::fs::write(folder.path().join(FILE), b"{\"base\":").unwrap();
        let broken = written(&next, &["a", "b"], &[chat("b", "Second")]);
        assert_eq!(save(folder.path(), broken).unwrap_err(), NEEDS_WHOLE);
        // Each refusal left the file as it was.
        assert_eq!(
            std::fs::read(folder.path().join(FILE)).unwrap(),
            b"{\"base\":"
        );
    }

    #[test]
    fn refuses_what_is_not_a_checkpoint() {
        let folder = tempfile::tempdir().unwrap();
        for sent in [
            Sent::Bytes(b"{".to_vec()),
            Sent::Bytes(br#"{"value":[],"order":[]}"#.to_vec()),
            Sent::Bytes(br#"{"value":{"base":[]},"order":[]}"#.to_vec()),
            Sent::Bytes(
                br#"{"value":{"base":{}},"order":["a"],"upsert":[{"title":"x"}]}"#.to_vec(),
            ),
        ] {
            assert_eq!(
                save(folder.path(), sent).unwrap_err(),
                "Invalid sync checkpoint"
            );
        }
        assert_eq!(
            save(folder.path(), Sent::Plain(json!({}))).unwrap_err(),
            "Invalid request"
        );
        assert!(!folder.path().join(FILE).exists());
    }
}
