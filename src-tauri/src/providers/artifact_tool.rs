//! Pages a Codex reply shows as artifacts (requested 2026-10-14; Claude chats publish to
//! claude.ai instead since 2026-10-21, `published_artifacts.rs`). The agent writes a page to a
//! file and names it in its show_artifact call, the conversation's own call alone (its parent
//! thread without a namespace). The computer running the conversation reads the file whole, the
//! reply keeps its source as a revision of the id, shown as a card at its <!-- artifact:ID -->
//! marker, and the call's result shows the agent the page as the viewer renders it
//! (`page_preview.rs`): a screenshot of each view with the problems found, so it can fix the file
//! and show the page again under the same id. The path is read and never kept.
use super::sent_files::Staging;
use crate::protocol::RunEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const NAME: &str = "show_artifact";

/// A page the reply showed, as the saved reply keeps it (`src/lib/artifact-records.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRecord {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub language: String,
    pub source: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Saved pages a request may carry back as earlier context.
pub fn valid_history(items: &[ArtifactRecord]) -> bool {
    items.iter().map(|a| &a.id).collect::<HashSet<_>>().len() == items.len()
        && items.iter().all(|a| {
            valid_id(&a.id)
                && a.revision > 0
                && a.revision <= 9_007_199_254_740_991
                && !a.title.trim().is_empty()
                && !a.title.chars().any(char::is_control)
                && matches!(a.language.as_str(), "html" | "svg")
                && !a.source.trim().is_empty()
                && !a.source.contains('\0')
        })
}

const DESCRIPTION: &str = "Show the user a page you wrote to a file as an artifact: a card in your reply that opens the page in Agent Studio's sandboxed viewer. Pass a stable id (call again with it to replace the page), a short title, and the file's absolute path on this computer: an .html page, or an .svg drawing. The result shows you the page as the viewer renders it, a screenshot of each view's first screen at 1100px and 390px wide in light and dark themes, with the problems found: sideways scrolling, content cut off or running past the edge, a missing background, low contrast, errors the page reported, and loads that were blocked or failed. Fix what they show in the file and call again with the same id, which updates the card. Then place <!-- artifact:ID --> in your final answer where the page belongs.";
/// How a Codex script reads the result: its code mode hands a dynamic tool's result to the
/// script as one string, the text with each screenshot inlined as a data URL, and the model sees
/// only what the script passes to text() and image() (checked with Codex 0.162 on 2026-10-14).
const CODEX_SCRIPT: &str = " Called from an exec script, it returns one string: the report, then each view's label and screenshot as a data:image/png URL. Print the report without the image data and show every screenshot, as in: const r = await tools.show_artifact({id, title, path}); const shots = /data:image\\/png;base64,[A-Za-z0-9+\\/=]+/g; text(r.replace(shots, '')); for (const m of r.matchAll(shots)) image(m[0]);";

/// The Codex dynamic tool.
pub fn codex_tool() -> Value {
    json!({"type":"function","name":NAME,"description":format!("{DESCRIPTION}{CODEX_SCRIPT}"),"deferLoading":false,"inputSchema":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1,"pattern":"^[a-zA-Z0-9_-]+$","description":"Stable identifier; reuse it to replace this artifact within the current reply."},
            "title":{"type":"string","minLength":1,"description":"A short name, shown on the card and above the page."},
            "path":{"type":"string","minLength":1,"description":"The page's absolute path on the computer running this conversation: an .html file, or an .svg file."}
        },"required":["id","title","path"],"additionalProperties":false}})
}

const INVALID: &str = "Provide id (letters, digits, _ or -), title (one line) and path (the page's absolute path on this computer). No other fields are accepted.";

#[derive(Debug)]
struct Submission {
    id: String,
    title: String,
    path: String,
}
fn parse(args: &Value) -> Result<Submission, String> {
    if !args.is_object() {
        return Err(INVALID.into());
    }
    let unexpected = super::unexpected_fields(args, &["id", "title", "path"]);
    if !unexpected.is_empty() {
        return Err(super::unexpected_message(&unexpected, INVALID));
    }
    let id = args["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or(INVALID)?;
    // One line, as the card shows it: line breaks and other control characters become spaces.
    let title: String = args["title"]
        .as_str()
        .ok_or(INVALID)?
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let title = title.trim();
    let path = args["path"]
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
        .ok_or(INVALID)?;
    if title.is_empty() {
        return Err(INVALID.into());
    }
    Ok(Submission {
        id: id.into(),
        title: title.into(),
        path: path.into(),
    })
}

/// Whether a page is HTML or SVG: by its name, or by how it begins when its name does not say.
fn language(path: &str, text: &str) -> Result<&'static str, String> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm" | "xhtml") => return Ok("html"),
        Some("svg") => return Ok("svg"),
        _ => {}
    }
    let head: String = text
        .trim_start()
        .chars()
        .take(1024)
        .collect::<String>()
        .to_ascii_lowercase();
    if !head.starts_with('<') {
        return Err("is not an HTML or SVG page".into());
    }
    Ok(match (head.find("<svg"), head.find("<html")) {
        (Some(svg), Some(html)) if svg < html => "svg",
        (Some(_), None) => "svg",
        _ => "html",
    })
}

/// Reads a page whole where the conversation runs, with its language.
async fn read(staging: &Staging, path: &str) -> Result<(String, &'static str), String> {
    let host = staging.host_path(path).await?;
    let reported = path.to_string();
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::metadata(&host).map_err(|_| "cannot be read".to_string())?;
        if !metadata.is_file() {
            return Err("is not a file".into());
        }
        let bytes = std::fs::read(&host).map_err(|_| "cannot be read".to_string())?;
        let text = String::from_utf8(bytes).map_err(|_| "is not UTF-8 text".to_string())?;
        let text = match text.strip_prefix('\u{feff}') {
            Some(rest) => rest.to_string(),
            None => text,
        };
        if text.trim().is_empty() {
            return Err("is empty".into());
        }
        if text.contains('\0') {
            return Err("holds a NUL character, which no page can show".into());
        }
        let language = language(&reported, &text)?;
        Ok((text, language))
    })
    .await
    .unwrap_or_else(|_| Err("could not be read".into()))
}

/// A page shown, with how it rendered or why it could not.
struct Outcome {
    record: ArtifactRecord,
    preview: Result<crate::page_preview::Preview, String>,
}

#[derive(Default)]
pub struct ArtifactShower {
    shown: Vec<ArtifactRecord>,
    published: bool,
}
impl ArtifactShower {
    async fn submit(&mut self, args: &Value, staging: &Staging) -> Result<Outcome, String> {
        let submission = parse(args)?;
        let read = tokio::select! {
            read = read(staging, &submission.path) => read,
            _ = staging.cancel().cancelled() => Err("was not read: the reply stopped".into()),
        };
        let (source, language) = read.map_err(|reason| {
            format!(
                "{} {reason}. Nothing was shown: write the page to a file and call {NAME} with its absolute path. Do not claim the page is visible.",
                submission.path
            )
        })?;
        let index = self.shown.iter().position(|a| a.id == submission.id);
        let record = ArtifactRecord {
            id: submission.id,
            revision: index.map_or(1, |i| self.shown[i].revision + 1),
            title: submission.title,
            language: language.into(),
            source,
        };
        match index {
            Some(i) => self.shown[i] = record.clone(),
            None => self.shown.push(record.clone()),
        }
        let preview = crate::page_preview::render(&record.source, staging.cancel()).await;
        Ok(Outcome { record, preview })
    }
    /// Whether this reply showed a page, so a page alone is a complete answer.
    pub fn has_artifacts(&self) -> bool {
        self.published
    }
    /// A Codex dynamic tool call, answered once the page is read and previewed here.
    pub async fn codex(
        &mut self,
        value: &Value,
        root: &str,
        staging: &Staging,
    ) -> Option<(Value, Option<RunEvent>)> {
        let p = &value["params"];
        if value["method"] != "item/tool/call" || p["tool"] != NAME {
            return None;
        }
        let result = if !root.is_empty() && p["threadId"] == root && p["namespace"].is_null() {
            self.submit(&p["arguments"], staging).await
        } else {
            Err("Artifacts must be shown by the parent conversation.".into())
        };
        let (items, event) = match result {
            Ok(outcome) => {
                let mut items = vec![json!({"type":"inputText","text":text(&outcome)})];
                for (label, png) in views(&outcome) {
                    items.push(json!({"type":"inputText","text":label}));
                    items.push(json!({"type":"inputImage","imageUrl":format!("data:image/png;base64,{png}")}));
                }
                self.published = true;
                (
                    items,
                    Some(RunEvent::Artifact {
                        artifact: outcome.record,
                    }),
                )
            }
            Err(error) => (vec![json!({"type":"inputText","text":error})], None),
        };
        let response =
            json!({"id":value["id"],"result":{"success":event.is_some(),"contentItems":items}});
        Some((response, event))
    }
}

/// Each view's label and screenshot.
fn views(outcome: &Outcome) -> Vec<(String, &str)> {
    match &outcome.preview {
        Ok(preview) => preview
            .views
            .iter()
            .map(|view| {
                (
                    format!("{}px wide, {} theme:", view.width, view.theme),
                    view.png.as_str(),
                )
            })
            .collect(),
        Err(_) => vec![],
    }
}

/// What the agent reads about the page it showed.
fn text(outcome: &Outcome) -> String {
    let record = &outcome.record;
    let mut text = format!(
        "\"{}\" is shown in your reply as an artifact card (revision {} of {}). Place <!-- artifact:{} --> on its own line between blank lines in your final answer, where the page belongs, and introduce it in a sentence or two; never paste its source.",
        record.title, record.revision, record.id, record.id
    );
    match &outcome.preview {
        Ok(preview) => {
            text.push_str("\n\n");
            text.push_str(&preview.report);
            text.push_str(&format!("\n\nIf the screenshots or the problems show anything to fix, change the file and call {NAME} again with the same id: the card updates in place."));
        }
        Err(reason) => text.push_str(&format!(
            "\n\nThe page could not be previewed on this computer: {reason}. Tell the user in one clause that it was not checked here."
        )),
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;

    fn stage() -> Staging {
        Staging::new("run", None, None, CancellationToken::new())
    }
    fn args(path: &str) -> Value {
        json!({"id":"report","title":"Quarterly report","path":path})
    }
    fn record(id: &str, revision: u64) -> ArtifactRecord {
        ArtifactRecord {
            id: id.into(),
            revision,
            title: "Report".into(),
            language: "html".into(),
            source: "<h1>Q3</h1>".into(),
        }
    }

    #[test]
    fn takes_an_id_a_one_line_title_and_a_path() {
        assert!(parse(&args("/tmp/report.html")).is_ok());
        let parsed =
            parse(&json!({"id":"r","title":"Two\nlines\u{7}","path":" /tmp/r.html "})).unwrap();
        assert_eq!(parsed.title, "Two lines");
        assert_eq!(parsed.path, "/tmp/r.html");
        let misnamed = parse(&json!({"id":"r","title":"R","html":"<p>"})).unwrap_err();
        assert!(
            misnamed.contains("sent html, which this tool does not accept"),
            "{misnamed}"
        );
        for invalid in [
            json!({"id":"a b","title":"R","path":"/tmp/r.html"}),
            json!({"id":"r","title":"  ","path":"/tmp/r.html"}),
            json!({"id":"r","title":"R","path":""}),
            json!({"id":"r","title":"R"}),
            json!(["r"]),
        ] {
            assert!(parse(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn tells_codex_scripts_how_to_read_the_screenshots() {
        // Codex's code mode hands a script the result as one string with the images inlined.
        let codex = codex_tool();
        let told = codex["description"].as_str().unwrap();
        assert!(
            told.contains("image(m[0])") && told.contains("text(r.replace"),
            "{told}"
        );
        assert_eq!(codex["type"], "function");
        assert_eq!(codex["name"], NAME);
        assert_eq!(
            codex["inputSchema"]["required"],
            json!(["id", "title", "path"])
        );
    }

    #[test]
    fn knows_a_page_by_its_name_or_how_it_begins() {
        assert_eq!(language("/tmp/a.HTML", "x"), Ok("html"));
        assert_eq!(language("C:\\pages\\logo.svg", "x"), Ok("svg"));
        assert_eq!(language("/tmp/page", "\n<!doctype html><html>"), Ok("html"));
        assert_eq!(
            language("/tmp/page", "<?xml version=\"1.0\"?><svg>"),
            Ok("svg")
        );
        assert_eq!(language("/tmp/page", "<div>snippet</div>"), Ok("html"));
        assert!(language("/tmp/notes.txt", "plain notes").is_err());
    }

    #[test]
    fn checks_saved_pages_a_request_carries() {
        assert!(valid_history(&[record("a", 1), record("b", 4)]));
        assert!(!valid_history(&[record("a", 1), record("a", 2)]));
        assert!(!valid_history(&[record("a b", 1)]));
        assert!(!valid_history(&[record("a", 0)]));
        let mut svg = record("a", 1);
        svg.language = "js".into();
        assert!(!valid_history(&[svg]));
        let mut empty = record("a", 1);
        empty.source = " ".into();
        assert!(!valid_history(&[empty]));
    }

    #[tokio::test]
    async fn reads_the_page_where_the_conversation_runs() {
        let dir = tempfile::tempdir().unwrap();
        let page = dir.path().join("report.html");
        std::fs::write(&page, "\u{feff}<!doctype html><title>Q3</title>").unwrap();
        let staging = stage();
        let (text, language) = read(&staging, &page.to_string_lossy()).await.unwrap();
        assert_eq!(text, "<!doctype html><title>Q3</title>");
        assert_eq!(language, "html");
        let binary = dir.path().join("shot.html");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(&staging, &binary.to_string_lossy())
            .await
            .unwrap_err()
            .contains("UTF-8"));
        assert!(read(&staging, &dir.path().to_string_lossy())
            .await
            .unwrap_err()
            .contains("not a file"));
        assert!(read(&staging, "relative.html").await.is_err());
        let blank = dir.path().join("blank.html");
        std::fs::write(&blank, "  \n").unwrap();
        assert!(read(&staging, &blank.to_string_lossy())
            .await
            .unwrap_err()
            .contains("empty"));
    }

    #[tokio::test]
    async fn only_the_parent_conversation_shows_pages() {
        let staging = stage();
        let mut shower = ArtifactShower::default();
        let call = |thread: &str, namespace: Value| json!({"id":7,"method":"item/tool/call","params":{"threadId":thread,"tool":NAME,"namespace":namespace,"arguments":args("/tmp/missing.html")}});
        assert!(shower
            .codex(
                &json!({"id":7,"method":"item/tool/call","params":{"threadId":"root","tool":"visualize"}}),
                "root",
                &staging
            )
            .await
            .is_none());
        for value in [call("child", Value::Null), call("root", json!("mcp"))] {
            let (response, event) = shower.codex(&value, "root", &staging).await.unwrap();
            assert_eq!(response["result"]["success"], false);
            assert!(event.is_none());
        }
        // The parent's own call reaches the file, which must exist.
        let (response, event) = shower
            .codex(&call("root", Value::Null), "root", &staging)
            .await
            .unwrap();
        assert_eq!(response["result"]["success"], false);
        assert!(event.is_none());
        assert!(response["result"]["contentItems"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Nothing was shown"));
        assert!(!shower.has_artifacts());
    }

    #[test]
    fn tells_the_agent_where_the_page_goes_and_what_the_preview_found() {
        let outcome = Outcome {
            record: record("report", 2),
            preview: Err("no Edge, Chrome or Chromium was found on this computer".into()),
        };
        let told = text(&outcome);
        assert!(told.contains("<!-- artifact:report -->"), "{told}");
        assert!(told.contains("revision 2 of report"), "{told}");
        assert!(
            told.contains("could not be previewed on this computer: no Edge"),
            "{told}"
        );
        assert!(views(&outcome).is_empty());
        let outcome = Outcome {
            record: record("report", 1),
            preview: Ok(crate::page_preview::Preview {
                views: vec![crate::page_preview::View {
                    width: 390,
                    theme: "dark",
                    png: "iVBOR".into(),
                }],
                report: "No problems found.".into(),
            }),
        };
        assert!(text(&outcome).contains("No problems found."));
        assert_eq!(
            views(&outcome),
            vec![("390px wide, dark theme:".to_string(), "iVBOR")]
        );
    }
}
