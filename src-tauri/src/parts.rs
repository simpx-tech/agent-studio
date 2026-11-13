//! The conversations of a saved file, read and written a few at a time.
//!
//! `workspace.json` and the sync checkpoint each hold every conversation. The window used to
//! take each as one JSON text when it loaded, and to send everything back as one whenever a
//! save could name nothing less, as the first save after every start did. The page's JavaScript
//! holds a text of at most 536,870,888 characters and 4 GB in all: on 2026-11-13 a 465 MB
//! workspace filled that memory while one save was written as text, the window loaded again,
//! and the next page did the same, in a loop (docs/DIAGNOSTICS.md). So the app keeps the
//! conversations as the texts the file holds, tells the window their ids and sizes, and hands
//! them over a few megabytes at a time; a save that carries many conversations sends them ahead
//! in calls of that size, under a name its last call gives.
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{value::RawValue, Map, Value};
use std::collections::HashMap;

/// Told when the file changed between two reads of its parts, so the window starts again.
pub const MOVED: &str = "The saved file changed while it was read.";

/// Conversations by id, each the JSON text it was saved or sent as.
pub type Chats = HashMap<String, Box<RawValue>>;

/// What a window gets when it opens a saved file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Opened {
    /// The file as one value, or nothing when there is none: a file whose conversations cannot
    /// be told apart by id, or one an earlier version of the app wrote.
    Whole(Option<Value>),
    /// The file without its conversations, the id and size in bytes of each in the file's order,
    /// and the number its reads name.
    Parts {
        rest: Value,
        chats: Vec<(String, usize)>,
        read: u64,
    },
}

/// A JSON object with its `conversations` taken out, each as the text the file holds.
#[derive(Default)]
pub struct Split {
    pub rest: Map<String, Value>,
    pub conversations: Vec<Box<RawValue>>,
}

impl<'de> Deserialize<'de> for Split {
    fn deserialize<D: Deserializer<'de>>(json: D) -> Result<Self, D::Error> {
        struct Read;
        impl<'de> de::Visitor<'de> for Read {
            type Value = Split;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object that lists conversations")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Split, A::Error> {
                let mut split = Split::default();
                let mut listed = false;
                while let Some(name) = map.next_key::<String>()? {
                    if name != "conversations" {
                        split.rest.insert(name, map.next_value()?);
                    } else if std::mem::replace(&mut listed, true) {
                        return Err(de::Error::duplicate_field("conversations"));
                    } else {
                        split.conversations = map.next_value()?;
                    }
                }
                if listed {
                    Ok(split)
                } else {
                    Err(de::Error::missing_field("conversations"))
                }
            }
        }
        json.deserialize_map(Read)
    }
}

/// A conversation's id, read without building the conversation.
pub fn id(conversation: &RawValue) -> Option<String> {
    #[derive(Deserialize)]
    struct Named<'a> {
        #[serde(borrow)]
        id: std::borrow::Cow<'a, str>,
    }
    serde_json::from_str::<Named>(conversation.get())
        .ok()
        .map(|named| named.id.into_owned())
}

/// The conversations by id, with the id and size of each in their order. `None` when one has no
/// id or two share one: such a file is read whole, as it always was.
pub fn named(conversations: Vec<Box<RawValue>>) -> Option<(Vec<(String, usize)>, Chats)> {
    let mut listed = Vec::with_capacity(conversations.len());
    let mut chats = Chats::with_capacity(conversations.len());
    for conversation in conversations {
        let id = id(&conversation)?;
        listed.push((id.clone(), conversation.get().len()));
        if chats.insert(id, conversation).is_some() {
            return None;
        }
    }
    Some((listed, chats))
}

/// `[a,b]`: the texts of the conversations named, in that order.
pub fn list(chats: &Chats, ids: &[String]) -> Result<Vec<u8>, String> {
    let mut found = Vec::with_capacity(ids.len());
    for id in ids {
        found.push(chats.get(id).ok_or(MOVED)?.get());
    }
    let size = found.iter().map(|text| text.len() + 1).sum::<usize>() + 2;
    let mut out = Vec::with_capacity(size);
    out.push(b'[');
    for (index, text) in found.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        out.extend_from_slice(text.as_bytes());
    }
    out.push(b']');
    Ok(out)
}

/// Conversations a window sends ahead of the save that will name them: `save` is that name.
#[derive(Deserialize)]
pub struct Ahead {
    pub save: String,
    pub upsert: Vec<Box<RawValue>>,
}

/// The conversations sent ahead of one save, until its last call takes them.
#[derive(Default)]
pub struct Staged(Option<(String, Chats)>);

impl Staged {
    /// Keeps more conversations for the save named, letting go of what another save sent and
    /// never finished. Fails on a conversation without an id, keeping nothing of that save.
    pub fn add(&mut self, ahead: Ahead) -> Result<(), ()> {
        let mut chats = match self.0.take() {
            Some((save, chats)) if save == ahead.save => chats,
            _ => Chats::new(),
        };
        for conversation in ahead.upsert {
            chats.insert(id(&conversation).ok_or(())?, conversation);
        }
        self.0 = Some((ahead.save, chats));
        Ok(())
    }

    /// What was sent ahead of the save named, which nothing is kept of afterwards: no
    /// conversations for a save that names none, and `None` for a name nothing was kept under.
    pub fn take(&mut self, save: Option<&str>) -> Option<Chats> {
        let held = self.0.take();
        match save {
            None => Some(Chats::new()),
            Some(save) => held
                .filter(|(name, _)| name == save)
                .map(|(_, chats)| chats),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(text: &str) -> Box<RawValue> {
        RawValue::from_string(text.into()).unwrap()
    }
    fn ahead(save: &str, chats: &[&str]) -> Ahead {
        Ahead {
            save: save.into(),
            upsert: chats.iter().map(|text| raw(text)).collect(),
        }
    }

    #[test]
    fn takes_the_conversations_out_as_the_text_the_file_holds() {
        // Text a parser and a writer could change between them: escapes, a long number.
        let odd = r#"{"id":"a","title":"é\/ 😀","n":1.0000000000000000000001}"#;
        let file =
            format!(r#"{{"version":3,"conversations":[{odd}, {{"id":"b"}}],"preferences":{{}}}}"#);
        let split: Split = serde_json::from_str(&file).unwrap();
        assert_eq!(
            Value::Object(split.rest),
            json!({"version": 3, "preferences": {}})
        );
        let (listed, chats) = named(split.conversations).unwrap();
        assert_eq!(
            listed,
            vec![("a".to_string(), odd.len()), ("b".to_string(), 10)]
        );
        assert_eq!(chats["a"].get(), odd);
        assert_eq!(
            list(&chats, &["b".into(), "a".into()]).unwrap(),
            format!(r#"[{{"id":"b"}},{odd}]"#).into_bytes()
        );
        assert_eq!(list(&chats, &[]).unwrap(), b"[]");
        // A conversation the file no longer holds: the window reads it again.
        assert_eq!(list(&chats, &["c".into()]).unwrap_err(), MOVED);
    }

    #[test]
    fn leaves_a_file_it_cannot_take_apart_to_be_read_whole() {
        for file in [
            r#"{"version":3}"#,
            r#"{"conversations":{}}"#,
            r#"{"conversations":[],"conversations":[]}"#,
            r#"[]"#,
            r#"{"conversations":[]"#,
        ] {
            assert!(serde_json::from_str::<Split>(file).is_err(), "{file}");
        }
        // No id, an id that is no text, and one id twice.
        for conversations in [
            vec![raw(r#"{"title":"x"}"#)],
            vec![raw(r#"{"id":1}"#)],
            vec![raw("[]")],
            vec![raw(r#"{"id":"a"}"#), raw(r#"{"id":"a","title":"again"}"#)],
        ] {
            assert!(named(conversations).is_none());
        }
        assert!(named(Vec::new()).is_some());
    }

    #[test]
    fn keeps_what_one_save_sends_ahead_until_its_last_call() {
        let mut staged = Staged::default();
        staged
            .add(ahead("one", &[r#"{"id":"a"}"#, r#"{"id":"b"}"#]))
            .unwrap();
        staged
            .add(ahead("one", &[r#"{"id":"c"}"#, r#"{"id":"a","n":2}"#]))
            .unwrap();
        let chats = staged.take(Some("one")).unwrap();
        assert_eq!(chats.len(), 3);
        assert_eq!(chats["a"].get(), r#"{"id":"a","n":2}"#);
        // Taken once.
        assert!(staged.take(Some("one")).is_none());
    }

    #[test]
    fn never_mixes_two_saves() {
        let mut staged = Staged::default();
        staged.add(ahead("one", &[r#"{"id":"a"}"#])).unwrap();
        // Another save begins: the first one's conversations go.
        staged.add(ahead("two", &[r#"{"id":"b"}"#])).unwrap();
        assert!(staged.take(Some("one")).is_none());
        // Which also let go of the second's.
        assert!(staged.take(Some("two")).is_none());
        staged.add(ahead("three", &[r#"{"id":"c"}"#])).unwrap();
        // A save that names nothing uses nothing, and nothing waits for a later one.
        assert!(staged.take(None).unwrap().is_empty());
        assert!(staged.take(Some("three")).is_none());
        // A conversation without an id keeps nothing of its save.
        staged.add(ahead("four", &[r#"{"id":"d"}"#])).unwrap();
        assert!(staged.add(ahead("four", &[r#"{"title":"x"}"#])).is_err());
        assert!(staged.take(Some("four")).is_none());
    }
}
