//! The sync checkpoint, `sync-state.json`: the relay's copy of the workspace as this device last
//! agreed with it, which the next start of the app merges against.
//!
//! It holds every conversation, and the window used to send all of it for each write: 86 MB of
//! text written in the page and parsed on this process's window thread once a minute while
//! replies ran, with the page blocked for half a second or more each time (docs/PERFORMANCE.md).
//! A write now carries the conversations that changed since the last one, as bytes (sent.rs),
//! and names every conversation in order; the rest are copied from the file as they are, without
//! being parsed into values. A conversation neither sent nor in the file fails the write with
//! `NEEDS_WHOLE`, and the window then sends everything, as it does the first time. The file is
//! written to disk as it is put together, never first into a buffer of its whole size.
//!
//! Neither does the window read or send all of it as one text any more (parts.rs): it opens
//! the checkpoint and reads its conversations a few megabytes at a time, and a write of many
//! conversations sends them ahead in calls of that size, which its last call names.
use crate::parts::{self, Chats, Opened, Split, Staged};
use crate::sent::Sent;
use serde::{de, Deserialize, Deserializer};
use serde_json::{value::RawValue, Map, Value};
use std::{borrow::Cow, collections::HashMap, io::Write, path::Path};

/// Told when a write cannot be completed from the file, so the window sends everything.
pub const NEEDS_WHOLE: &str = "The whole sync checkpoint is needed to save this change.";
const FILE: &str = "sync-state.json";

/// What the app holds of the checkpoint between a window's calls.
#[derive(Default)]
pub struct Held {
    /// The conversations of the file a window opened, under the number its reads name, until it
    /// has read them or another window opens the file.
    opened: Option<(u64, Chats)>,
    opens: u64,
    /// The conversations a write sent ahead of its last call.
    pub staged: Staged,
}

impl Held {
    /// Some of the conversations of the file opened as `read`, as the bytes of their JSON list.
    pub fn read(&self, read: u64, ids: &[String]) -> Result<Vec<u8>, String> {
        match &self.opened {
            Some((number, chats)) if *number == read => parts::list(chats, ids),
            _ => Err(parts::MOVED.into()),
        }
    }

    /// The window that opened the file as `read` is done with it.
    pub fn close(&mut self, read: u64) {
        if self
            .opened
            .as_ref()
            .is_some_and(|(number, _)| *number == read)
        {
            self.opened = None;
        }
    }
}

/// A checkpoint with the conversations of its baseline taken out.
struct File {
    rest: Map<String, Value>,
    base: Split,
}

impl<'de> Deserialize<'de> for File {
    fn deserialize<D: Deserializer<'de>>(json: D) -> Result<Self, D::Error> {
        struct Read;
        impl<'de> de::Visitor<'de> for Read {
            type Value = File;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a sync checkpoint")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<File, A::Error> {
                let mut rest = Map::new();
                let mut base = None;
                while let Some(name) = map.next_key::<String>()? {
                    if name != "base" {
                        rest.insert(name, map.next_value()?);
                    } else if base.is_some() {
                        return Err(de::Error::duplicate_field("base"));
                    } else {
                        base = Some(map.next_value()?);
                    }
                }
                let base = base.ok_or_else(|| de::Error::missing_field("base"))?;
                Ok(File { rest, base })
            }
        }
        json.deserialize_map(Read)
    }
}

/// Opens the checkpoint for a window to read: the file without its conversations, which stay
/// here for it to read a few at a time. `None` for a file to read whole: one that cannot be
/// taken apart, or that holds images to move into the image store.
pub fn open(root: &Path, held: &mut Held) -> Result<Option<Opened>, String> {
    // Whatever an earlier window was reading, it reads no more.
    held.opened = None;
    let bytes = match std::fs::read(root.join(FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Some(Opened::Whole(None))),
        Err(_) => return Err("Cannot read sync checkpoint".into()),
    };
    let Ok(File { mut rest, base }) = serde_json::from_slice(&bytes) else {
        return Ok(None);
    };
    drop(bytes);
    if base
        .conversations
        .iter()
        .any(|conversation| crate::chat_images::holds_inline(conversation.get()))
    {
        return Ok(None);
    }
    let Some((chats, kept)) = parts::named(base.conversations) else {
        return Ok(None);
    };
    rest.insert("base".into(), Value::Object(base.rest));
    held.opens += 1;
    held.opened = Some((held.opens, kept));
    Ok(Some(Opened::Parts {
        rest: Value::Object(rest),
        chats,
        read: held.opens,
    }))
}

/// Writes the checkpoint a window sent: whole, or the conversations that changed with the order
/// of them all, those sent ahead under the name `staged` gives among them.
pub fn save(root: &Path, sent: Sent, staged: &mut Staged) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Written {
        value: Value,
        order: Option<Vec<String>>,
        #[serde(default)]
        upsert: Vec<Box<RawValue>>,
        #[serde(default)]
        staged: Option<String>,
    }
    let written: Written = match sent {
        Sent::Bytes(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid sync checkpoint")?
        }
        plain => plain.read()?,
    };
    // Sent ahead by this write, or by one that never finished and is forgotten here.
    let ahead = staged.take(written.staged.as_deref());
    match written.order {
        Some(order) => patch(
            root,
            written.value,
            &order,
            &written.upsert,
            &ahead.ok_or(NEEDS_WHOLE)?,
        ),
        None => write(root, &written.value),
    }
}

/// Writes a whole checkpoint.
pub fn write(root: &Path, value: &Value) -> Result<(), String> {
    replace(root, |out| {
        serde_json::to_writer(out, value).map_err(Into::into)
    })
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
/// each from `upsert` or `ahead` when it was sent, and otherwise as the file holds it.
fn patch(
    root: &Path,
    value: Value,
    order: &[String],
    upsert: &[Box<RawValue>],
    ahead: &Chats,
) -> Result<(), String> {
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
    let mut sent: HashMap<Cow<'_, str>, &RawValue> = ahead
        .iter()
        .map(|(id, conversation)| (Cow::Borrowed(id.as_str()), &**conversation))
        .collect();
    for conversation in upsert {
        sent.insert(
            id(conversation).ok_or("Invalid sync checkpoint")?,
            conversation,
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
    if order
        .iter()
        .any(|id| !sent.contains_key(id.as_str()) && !kept.contains_key(id.as_str()))
    {
        return Err(NEEDS_WHOLE.into());
    }
    replace(root, |out| {
        let field = |out: &mut dyn Write, first: &mut bool, name: &str| {
            if !std::mem::take(first) {
                out.write_all(b",")?;
            }
            serde_json::to_writer(&mut *out, name)?;
            out.write_all(b":")
        };
        out.write_all(b"{")?;
        let mut first = true;
        for (name, item) in &value {
            field(out, &mut first, name)?;
            serde_json::to_writer(&mut *out, item)?;
        }
        field(out, &mut first, "base")?;
        out.write_all(b"{")?;
        let mut first = true;
        for (name, item) in base.iter().filter(|(name, _)| *name != "conversations") {
            field(out, &mut first, name)?;
            serde_json::to_writer(&mut *out, item)?;
        }
        field(out, &mut first, "conversations")?;
        out.write_all(b"[")?;
        for (index, id) in order.iter().enumerate() {
            if index > 0 {
                out.write_all(b",")?;
            }
            // Every conversation named was found above.
            if let Some(conversation) = sent.get(id.as_str()).or_else(|| kept.get(id.as_str())) {
                out.write_all(conversation.get().as_bytes())?;
            }
        }
        out.write_all(b"]}}")
    })
}

/// Replaces the file with what `write` writes, written to disk beside it and flushed first.
fn replace(
    root: &Path,
    write: impl FnOnce(&mut dyn Write) -> std::io::Result<()>,
) -> Result<(), String> {
    let mut file =
        tempfile::NamedTempFile::new_in(root).map_err(|_| "Cannot prepare sync checkpoint")?;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, file.as_file_mut());
    write(&mut out)
        .and_then(|()| out.flush())
        .map_err(|_| "Cannot write sync checkpoint")?;
    drop(out);
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
        save(
            folder.path(),
            Sent::Plain(json!({"value": whole})),
            &mut Staged::default(),
        )
        .unwrap();
        assert_eq!(saved(folder.path()), whole);
        let other = checkpoint(vec![chat("b", "Second")]);
        let bytes = serde_json::to_vec(&json!({"value": other})).unwrap();
        save(folder.path(), Sent::Bytes(bytes), &mut Staged::default()).unwrap();
        assert_eq!(saved(folder.path()), other);
    }

    #[test]
    fn opens_a_checkpoint_for_reading_a_few_conversations_at_a_time() {
        let folder = tempfile::tempdir().unwrap();
        let mut held = Held::default();
        // No file: nothing to read.
        assert!(matches!(
            open(folder.path(), &mut held).unwrap(),
            Some(Opened::Whole(None))
        ));
        // Text a parser and a writer could change between them.
        let odd = r#"{"id":"a","title":"\u00e9\/","n":1.0000000000000000000001,"messages":[]}"#;
        let other = r#"{"id":"b","messages":[]}"#;
        let file = format!(
            r#"{{"url":"u","base":{{"fleet":{{}},"conversations":[{odd},{other}]}},"revisions":{{"revision":3}}}}"#
        );
        std::fs::write(folder.path().join(FILE), &file).unwrap();
        let Some(Opened::Parts { rest, chats, read }) = open(folder.path(), &mut held).unwrap()
        else {
            panic!("read whole");
        };
        assert_eq!(
            rest,
            json!({"url": "u", "base": {"fleet": {}}, "revisions": {"revision": 3}})
        );
        assert_eq!(
            chats,
            vec![("a".to_string(), odd.len()), ("b".to_string(), other.len())]
        );
        let text = |held: &Held, read: u64, ids: &[&str]| {
            let ids: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            held.read(read, &ids)
                .map(|bytes| String::from_utf8(bytes).unwrap())
        };
        assert_eq!(text(&held, read, &["b"]).unwrap(), format!("[{other}]"));
        // A write meanwhile changes nothing of what the window opened.
        let next = checkpoint(vec![]);
        save(folder.path(), written(&next, &["b"], &[]), &mut held.staged).unwrap();
        assert_eq!(
            text(&held, read, &["a", "b"]).unwrap(),
            format!("[{odd},{other}]")
        );
        // Another window's reads never answer from it, nor does a conversation it lacks.
        assert_eq!(text(&held, read + 1, &["a"]).unwrap_err(), parts::MOVED);
        assert_eq!(text(&held, read, &["c"]).unwrap_err(), parts::MOVED);
        held.close(read + 1);
        assert!(text(&held, read, &["a"]).is_ok());
        held.close(read);
        assert_eq!(text(&held, read, &["a"]).unwrap_err(), parts::MOVED);
        // Opening again reads the file as it is now, under another number.
        let Some(Opened::Parts {
            chats, read: again, ..
        }) = open(folder.path(), &mut held).unwrap()
        else {
            panic!("read whole");
        };
        assert_eq!(chats, vec![("b".to_string(), other.len())]);
        assert_ne!(again, read);
    }

    #[test]
    fn reads_whole_a_checkpoint_it_cannot_take_apart() {
        let folder = tempfile::tempdir().unwrap();
        let mut held = Held::default();
        for file in [
            r#"{"url":"u"}"#,
            r#"{"base":{}}"#,
            r#"{"base":{"conversations":[{"title":"x"}]}}"#,
            r#"{"base":{"conversations":[{"id":"a"},{"id":"a"}]}}"#,
            r#"{"base":{"conversations":[{"id":"a","messages":[{"images":[{"data":"AAAA"}]}]}]}}"#,
            r#"{"base":"#,
        ] {
            std::fs::write(folder.path().join(FILE), file).unwrap();
            assert!(open(folder.path(), &mut held).unwrap().is_none(), "{file}");
            assert_eq!(held.read(held.opens, &[]).unwrap_err(), parts::MOVED);
        }
    }

    #[test]
    fn a_write_of_many_conversations_sends_them_ahead() {
        let folder = tempfile::tempdir().unwrap();
        let mut staged = Staged::default();
        let ahead = |save: &str, chats: &[Value]| parts::Ahead {
            save: save.into(),
            upsert: chats
                .iter()
                .map(|chat| serde_json::value::to_raw_value(chat).unwrap())
                .collect(),
        };
        let named = |value: &Value, order: &[&str], upsert: &[Value], save: &str| {
            let mut head = value.clone();
            head["base"]
                .as_object_mut()
                .unwrap()
                .remove("conversations");
            json!({"value": head, "order": order, "upsert": upsert, "staged": save})
        };
        let next = checkpoint(vec![]);
        // No file yet: every conversation arrives, most of them ahead of the write.
        staged
            .add(ahead("one", &[chat("a", "First"), chat("b", "Second")]))
            .unwrap();
        staged.add(ahead("one", &[chat("c", "Third")])).unwrap();
        let sent = named(&next, &["d", "c", "b", "a"], &[chat("d", "Fourth")], "one");
        save(
            folder.path(),
            Sent::Bytes(serde_json::to_vec(&sent).unwrap()),
            &mut staged,
        )
        .unwrap();
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([
                chat("d", "Fourth"),
                chat("c", "Third"),
                chat("b", "Second"),
                chat("a", "First")
            ])
        );
        // The same as plain arguments, completed from the file.
        staged.add(ahead("two", &[chat("a", "Renamed")])).unwrap();
        save(
            folder.path(),
            Sent::Plain(named(&next, &["a", "b"], &[], "two")),
            &mut staged,
        )
        .unwrap();
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([chat("a", "Renamed"), chat("b", "Second")])
        );
        // A write whose conversations are gone asks for everything, and writes nothing.
        let lost = named(&next, &["a"], &[], "two");
        assert_eq!(
            save(folder.path(), Sent::Plain(lost), &mut staged).unwrap_err(),
            NEEDS_WHOLE
        );
        // What one write sent ahead never reaches another.
        staged.add(ahead("three", &[chat("e", "Fifth")])).unwrap();
        save(folder.path(), written(&next, &["b"], &[]), &mut staged).unwrap();
        let late = named(&next, &["b", "e"], &[], "three");
        assert_eq!(
            save(folder.path(), Sent::Plain(late), &mut staged).unwrap_err(),
            NEEDS_WHOLE
        );
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([chat("b", "Second")])
        );
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
        save(folder.path(), sent, &mut Staged::default()).unwrap();
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
        save(folder.path(), sent, &mut Staged::default()).unwrap();
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
        save(folder.path(), sent, &mut Staged::default()).unwrap();
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
        save(folder.path(), sent, &mut Staged::default()).unwrap();
        assert_eq!(
            saved(folder.path())["base"]["conversations"],
            json!([chat("a", "First")])
        );
        // No conversation at all is a checkpoint too.
        save(
            folder.path(),
            written(&next, &[], &[]),
            &mut Staged::default(),
        )
        .unwrap();
        assert_eq!(saved(folder.path())["base"]["conversations"], json!([]));
    }

    #[test]
    fn asks_for_everything_rather_than_dropping_a_conversation() {
        let folder = tempfile::tempdir().unwrap();
        let next = checkpoint(vec![]);
        // No file to complete the write from.
        let missing = written(&next, &["a", "b"], &[chat("a", "First")]);
        assert_eq!(
            save(folder.path(), missing, &mut Staged::default()).unwrap_err(),
            NEEDS_WHOLE
        );
        assert!(!folder.path().join(FILE).exists());
        write(folder.path(), &checkpoint(vec![chat("a", "First")])).unwrap();
        // A conversation neither sent nor in the file.
        let unknown = written(&next, &["a", "b"], &[]);
        assert_eq!(
            save(folder.path(), unknown, &mut Staged::default()).unwrap_err(),
            NEEDS_WHOLE
        );
        // A conversation sent but not named in the order.
        let unnamed = written(&next, &["a"], &[chat("b", "Second")]);
        assert_eq!(
            save(folder.path(), unnamed, &mut Staged::default()).unwrap_err(),
            NEEDS_WHOLE
        );
        // A file that is not a checkpoint.
        std::fs::write(folder.path().join(FILE), b"{\"base\":").unwrap();
        let broken = written(&next, &["a", "b"], &[chat("b", "Second")]);
        assert_eq!(
            save(folder.path(), broken, &mut Staged::default()).unwrap_err(),
            NEEDS_WHOLE
        );
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
                save(folder.path(), sent, &mut Staged::default()).unwrap_err(),
                "Invalid sync checkpoint"
            );
        }
        assert_eq!(
            save(
                folder.path(),
                Sent::Plain(json!({})),
                &mut Staged::default()
            )
            .unwrap_err(),
            "Invalid request"
        );
        assert!(!folder.path().join(FILE).exists());
    }
}
