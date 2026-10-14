use std::io::Write;
use tauri::Manager;

/// How a chat agent delivers an artifact: a named html or svg fence, which the window shows as a
/// card that opens it (`src/lib/artifacts.ts`), and what makes the page good in the sandboxed
/// viewer that renders it (the constant `artifact-preview.html` with its CSP below).
pub const GUIDANCE: &str = "When a request calls for a page the user opens beside the chat, such as a document, report, explainer, diagram, dashboard, prototype or small tool, deliver it as an artifact: one fenced html block (svg for a standalone drawing) holding the complete page, its opening fence naming it after the language, as in ```html Release dashboard. Agent Studio shows that block as a card that opens the page in a sandboxed viewer, never as code, so introduce it in a sentence or two rather than repeating or summarizing its source. Do not create an artifact unless it serves the user's request. Make it a finished, polished page. Self-contained: inline CSS and JavaScript, inline SVG and data: images only; the viewer blocks every external script, stylesheet, font, image and request without showing an error, so draw charts and diagrams with inline SVG or canvas and use system font stacks (system-ui, ui-monospace). Theme-aware: define the palette as CSS custom properties on :root, redefine them under @media (prefers-color-scheme: dark), give body an explicit background and text color, and keep contrast readable in both themes. Responsive: it opens in a wide dialog or in a side panel about 360px wide, so let rows wrap or stack, never let the page scroll sideways, and give wide tables and code their own overflow-x: auto container. Designed: a clear title and hierarchy, a consistent spacing scale, a comfortable line length for prose, restrained color with one accent, and tabular figures; organize long material with a contents list, sections or tabs. Code: show it in pre blocks with line numbers where they help, color it with a small inline highlighter, and keep long lines scrollable rather than cut off. Give the page a <title> matching the fence's name.";

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

pub fn response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let ok = path == "/";
    tauri::http::Response::builder()
        .status(if ok { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
        .body(if ok { include_bytes!("../../src/lib/artifact-preview.html").to_vec() } else { Vec::new() })
        .expect("constant artifact response")
}
