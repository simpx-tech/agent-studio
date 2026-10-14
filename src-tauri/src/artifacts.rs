use std::io::Write;
use tauri::Manager;

/// How a chat agent with Agent Studio's tools delivers an artifact: a page it writes to a file
/// and shows with show_artifact, which previews it (`providers/artifact_tool.rs`).
const TOOL: &str = "When a request calls for a page the user opens beside the chat, such as a document, report, explainer, diagram, dashboard, prototype or small tool, make it an artifact with the show_artifact tool (Claude: mcp__agent_studio__show_artifact): write the complete page to an .html file (an .svg file for a standalone drawing) in a temporary folder, outside the project unless the user wants it there, and call show_artifact with a stable id, a short title and the file's absolute path. Agent Studio shows it in your reply as a card that opens the page in a sandboxed viewer, and the result returns screenshots of the page at the viewer's widths in light and dark themes with the problems found. Fix what they show in the file and call show_artifact again with the same id until the page looks finished, then place <!-- artifact:ID --> on its own line between blank lines in your final answer, where the page belongs, introduced in a sentence or two; never paste its source or a fenced copy. Use visualize for a visual that sits among your explanation instead. Do not create an artifact unless it serves the user's request.";
/// How any other chat agent delivers one: a named html or svg fence, which the window shows as a
/// card that opens it (`src/lib/artifacts.ts`).
const FENCE: &str = "When a request calls for a page the user opens beside the chat, such as a document, report, explainer, diagram, dashboard, prototype or small tool, deliver it as an artifact: one fenced html block (svg for a standalone drawing) holding the complete page, its opening fence naming it after the language, as in ```html Release dashboard. Agent Studio shows that block as a card that opens the page in a sandboxed viewer, never as code, so introduce it in a sentence or two rather than repeating or summarizing its source. Do not create an artifact unless it serves the user's request.";
/// What makes a page good in the sandboxed viewer that renders it (the constant
/// `artifact-preview.html` under `PAGE_CSP` below).
const PAGE_RULES: &str = "Make it a finished, polished page. Libraries and fonts: scripts load only from https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net/npm/ and https://unpkg.com, pinned to an exact version (react@18.3.1, never a range or @latest) and placed before the inline script that uses them; stylesheets and fonts may come from those CDNs and from Google Fonts (fonts.googleapis.com and fonts.gstatic.com), with a system font stack as fallback. Everything else is blocked without an error: other hosts, images that are not inline SVG or data: URIs, and every fetch, XHR or WebSocket, a library's own included, so inline the data the page shows. Theme-aware: define the palette as CSS custom properties on :root, redefine them under @media (prefers-color-scheme: dark), give body an explicit background and text color, and keep contrast readable in both themes. Responsive: it opens in a wide dialog or in a side panel or phone about 390px wide, so let rows wrap or stack, never let the page scroll sideways, and give wide tables and code their own overflow-x: auto container. Designed: a clear title and hierarchy, a consistent spacing scale, a comfortable line length for prose, restrained color with one accent, and tabular figures; organize long material with a contents list, sections or tabs. Code: show it in pre blocks with line numbers where they help, highlighted with highlight.js or Prism from cdnjs, and keep long lines scrollable rather than cut off. Give the page a <title> matching its name.";

/// The artifact guidance of a chat agent, with the show_artifact tool or without it.
pub fn guidance(tool: bool) -> String {
    format!("{} {PAGE_RULES}", if tool { TOOL } else { FENCE })
}

#[tauri::command]
pub async fn save_artifact(
    app: tauri::AppHandle,
    call: crate::calls::Call,
    source: String,
    filename: String,
    language: String,
) -> Result<String, String> {
    // File work stays off the UI thread, which also handles the window's input.
    call.once(async move {
        tauri::async_runtime::spawn_blocking(move || write(&app, &source, &filename, &language))
            .await
            .map_err(|_| "Could not finish saving the artifact")?
    })
    .await
}

fn write(
    app: &tauri::AppHandle,
    source: &str,
    filename: &str,
    language: &str,
) -> Result<String, String> {
    if !matches!(language, "html" | "svg") {
        return Err("Artifacts are saved as HTML or SVG".into());
    }
    let name: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect();
    let name = name
        .trim_matches('.')
        .trim_end_matches(&format!(".{language}"));
    let name = if name.is_empty() { "artifact" } else { name };
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Cannot locate Downloads")?;
    std::fs::create_dir_all(&directory).map_err(|_| "Cannot create Downloads")?;
    let path = directory.join(format!(
        "agent-studio-{name}-{}.{}",
        uuid::Uuid::new_v4(),
        language
    ));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|_| "Cannot save artifact in Downloads")?;
    file.write_all(source.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not finish saving the artifact")?;
    Ok(path.to_string_lossy().into_owned())
}

/// The constant bootstrap every sandboxed preview starts from, which writes the source it is
/// sent into its own document.
pub const BOOTSTRAP: &[u8] = include_bytes!("../../src/lib/artifact-preview.html");
/// The sandbox visualizations and screens render in: nothing loads from the network.
pub const FRAME_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
/// The sandbox artifact pages render in (requested 2026-10-14): scripts, stylesheets and fonts
/// also load from three CDNs, at the versions a page pins, and Google Fonts, as Claude Code's
/// artifact viewer allows; a page still makes no request of its own. relay/artifact-preview.ts
/// serves the same two policies to browsers.
pub const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.googleapis.com; img-src data: blob:; font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://fonts.gstatic.com; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";

pub fn response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let policy = match path {
        "/" => Some(FRAME_CSP),
        "/page" => Some(PAGE_CSP),
        _ => None,
    };
    tauri::http::Response::builder()
        .status(if policy.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", policy.unwrap_or(FRAME_CSP))
        .body(if policy.is_some() {
            BOOTSTRAP.to_vec()
        } else {
            Vec::new()
        })
        .expect("constant artifact response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_load_pinned_cdns_while_visuals_and_screens_stay_offline() {
        let header = |path: &str| {
            let response = response(path);
            (
                response.status().as_u16(),
                response.headers()["Content-Security-Policy"]
                    .to_str()
                    .unwrap()
                    .to_string(),
            )
        };
        let (status, frame) = header("/");
        assert_eq!(status, 200);
        assert!(!frame.contains("https:"));
        let (status, page) = header("/page");
        assert_eq!(status, 200);
        for host in [
            "https://cdnjs.cloudflare.com",
            "https://cdn.jsdelivr.net/npm/",
            "https://unpkg.com",
            "https://fonts.googleapis.com",
            "https://fonts.gstatic.com",
        ] {
            assert!(page.contains(host), "{host}");
        }
        // A page still makes no request of its own, and both keep their sandbox.
        for policy in [&frame, &page] {
            assert!(
                policy.contains("connect-src 'none'") && policy.ends_with("sandbox allow-scripts")
            );
        }
        assert_eq!(header("/other").0, 404);
        assert!(response("/other").body().is_empty());
    }
}
