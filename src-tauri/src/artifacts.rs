use std::io::Write;
use tauri::Manager;

#[tauri::command]
pub async fn save_artifact(
    app: tauri::AppHandle,
    source: String,
    filename: String,
    language: String,
) -> Result<String, String> {
    // File work stays off the UI thread, which also handles the window's input.
    tauri::async_runtime::spawn_blocking(move || write(&app, &source, &filename, &language))
        .await
        .map_err(|_| "Could not finish saving the artifact")?
}

fn write(
    app: &tauri::AppHandle,
    source: &str,
    filename: &str,
    language: &str,
) -> Result<String, String> {
    if source.len() > 512_000 || !matches!(language, "html" | "svg") {
        return Err("Artifact exceeds the supported size or format".into());
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
