//! Arguments a call sends as the bytes of their JSON.
//!
//! Tauri writes a call's arguments as text in the page, with a function that visits every value,
//! and this process then parses that text on its window thread before the command runs. A call
//! that carries a conversation carries megabytes: sending one 9.8 MB chat to the relay took the
//! page 70 ms and the window thread about as long, with every poll while its reply ran. The page
//! keeps each unchanged part of a conversation as bytes already written
//! (`src/lib/chat-bytes.ts`), so such a call sends the same arguments as one buffer, which
//! arrives here untouched and is read off the window thread.
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::ipc::InvokeBody;

/// What a call sent as its arguments.
pub enum Sent {
    /// Plain arguments, as Tauri parsed them.
    Plain(Value),
    /// The bytes of the arguments' JSON.
    Bytes(Vec<u8>),
}

impl Sent {
    /// Takes the arguments out of a request, before its command first waits. Once Tauri has
    /// moved the page's calls to `postMessage`, which carries only JSON, bytes arrive as an
    /// array of numbers (calls.rs).
    pub fn of(body: &InvokeBody) -> Self {
        match body {
            InvokeBody::Raw(bytes) => Self::Bytes(bytes.clone()),
            InvokeBody::Json(Value::Array(numbers)) => numbers
                .iter()
                .map(|number| number.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect::<Option<Vec<u8>>>()
                .map_or_else(|| Self::Plain(Value::Array(numbers.clone())), Self::Bytes),
            InvokeBody::Json(value) => Self::Plain(value.clone()),
        }
    }

    /// The arguments as `T`. Run it where megabytes may be parsed: off the window thread.
    pub fn read<T: DeserializeOwned>(self) -> Result<T, String> {
        match self {
            Self::Plain(value) => serde_json::from_value(value),
            Self::Bytes(bytes) => serde_json::from_slice(&bytes),
        }
        .map_err(|_| "Invalid request".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize, PartialEq, Debug)]
    struct Arguments {
        name: String,
        count: u32,
    }

    #[test]
    fn reads_plain_arguments_and_the_bytes_of_their_json_alike() {
        let expected = Arguments {
            name: "a".into(),
            count: 2,
        };
        let plain = InvokeBody::Json(json!({"name": "a", "count": 2}));
        assert_eq!(Sent::of(&plain).read::<Arguments>().unwrap(), expected);
        let bytes = br#"{"name":"a","count":2}"#.to_vec();
        let raw = InvokeBody::Raw(bytes.clone());
        assert_eq!(Sent::of(&raw).read::<Arguments>().unwrap(), expected);
        // What `postMessage` makes of the same bytes.
        let numbers = InvokeBody::Json(Value::Array(bytes.iter().map(|b| json!(b)).collect()));
        assert_eq!(Sent::of(&numbers).read::<Arguments>().unwrap(), expected);
    }

    #[test]
    fn refuses_what_is_not_the_arguments() {
        for body in [
            InvokeBody::Raw(b"{\"name\":\"a\"".to_vec()),
            InvokeBody::Raw(vec![0xff, 0xfe]),
            InvokeBody::Json(json!({"name": "a"})),
            // An array that is no list of bytes stays what it is.
            InvokeBody::Json(json!([1, 2, 300])),
            InvokeBody::Json(json!(["a"])),
        ] {
            assert_eq!(
                Sent::of(&body).read::<Arguments>().unwrap_err(),
                "Invalid request"
            );
        }
    }
}
