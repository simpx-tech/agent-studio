mod artifacts;
mod badges;
mod cli_queries;
mod context;
mod folders;
mod models;
mod notifications;
mod profiles;
mod protocol;
mod providers;
mod relay;
mod runner;
mod titles;
mod usage;
mod wsl;
use std::io::Write;
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, State};
use tokio_util::sync::CancellationToken;
#[derive(Default)]
struct Storage(Mutex<()>);

#[tauri::command]
async fn read_context(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    location: Option<folders::ChatLocation>,
    connection_id: Option<String>,
) -> Result<context::ContextSnapshot, String> {
    folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profile.folder_distribution = location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    profiles::scope(profile, context::read(app, provider, model, location)).await
}

#[tauri::command]
async fn read_usage(
    app: tauri::AppHandle,
    state: State<'_, usage::UsageState>,
    provider: String,
    model: String,
    force: bool,
    connection_id: Option<String>,
) -> Result<usage::UsageSnapshot, String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profiles::scope(profile, usage::read(app, &state, &provider, &model, force)).await
}

#[tauri::command]
async fn generate_title(
    app: tauri::AppHandle,
    titles: State<'_, titles::Titles>,
    conversation_id: String,
    provider: String,
    first_message: String,
    connection_id: Option<String>,
) -> Result<titles::GeneratedTitle, String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    let cancel = CancellationToken::new();
    {
        let mut active = titles.0.lock().map_err(|_| "Title registry lock failed")?;
        if active.contains_key(&conversation_id) || active.len() >= 2 {
            return Err("Title generation is already busy".into());
        }
        active.insert(conversation_id.clone(), cancel.clone());
    }
    let result = profiles::scope(
        profile,
        titles::generate(app, &provider, &first_message, cancel),
    )
    .await;
    if let Ok(mut active) = titles.0.lock() {
        active.remove(&conversation_id);
    }
    result
}
#[tauri::command]
fn cancel_title(titles: State<titles::Titles>, conversation_id: String) {
    if let Ok(active) = titles.0.lock() {
        if let Some(cancel) = active.get(&conversation_id) {
            cancel.cancel();
        }
    }
}

#[tauri::command]
async fn list_models(
    app: tauri::AppHandle,
    provider: Option<String>,
    connection_id: Option<String>,
) -> Result<std::collections::BTreeMap<String, Vec<models::ModelInfo>>, String> {
    let profile = profiles::resolve(
        &app,
        provider.as_deref().unwrap_or("codex"),
        connection_id.as_deref(),
    )?;
    Ok(profiles::scope(
        profile,
        models::catalog(provider.as_deref().unwrap_or("codex")),
    )
    .await)
}

#[tauri::command]
fn get_installation(app: tauri::AppHandle) -> Result<profiles::Installation, String> {
    profiles::installation(&app)
}
#[tauri::command]
async fn discover_wsl(app: tauri::AppHandle) -> Result<wsl::Discovery, String> {
    wsl::discover(&profiles::installation(&app)?.id).await
}
#[tauri::command]
async fn inspect_environment_clis(
    app: tauri::AppHandle,
    environment_id: String,
) -> Result<Vec<providers::CliInstallation>, String> {
    match folders::environment_distribution(&app, &environment_id)? {
        Some(distribution) => wsl::installations(&distribution).await,
        None => Ok(providers::native_installations()),
    }
}
#[tauri::command]
async fn list_folders(
    app: tauri::AppHandle,
    environment_id: String,
    path: String,
) -> Result<folders::FolderListing, String> {
    folders::list(app, environment_id, path).await
}
#[tauri::command]
async fn detect_connection(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
) -> Result<providers::ProviderStatus, String> {
    let profile = profiles::resolve(&app, &provider, Some(&connection_id))?;
    Ok(profiles::scope(profile, providers::detect_one(&provider)).await)
}
#[tauri::command]
async fn relay_connect(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
    url: String,
    token: String,
) -> Result<(), String> {
    relay::connect(
        &state,
        &app.config().identifier,
        url,
        token,
        profiles::installation(&app)?.id,
    )
    .await
}
#[tauri::command]
async fn relay_resume(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
) -> Result<Option<String>, String> {
    relay::resume(
        &state,
        &app.config().identifier,
        profiles::installation(&app)?.id,
    )
    .await
}
#[tauri::command]
async fn relay_disconnect(
    app: tauri::AppHandle,
    state: State<'_, relay::Relay>,
) -> Result<(), String> {
    relay::disconnect(
        &state,
        &app.config().identifier,
        &profiles::installation(&app)?.id,
    )
    .await
}
#[tauri::command]
async fn relay_request(
    state: State<'_, relay::Relay>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    relay::request(&state, &method, &path, body).await
}
#[tauri::command]
fn load_sync_state(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("sync-state.json");
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Sync checkpoint is unreadable".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read sync checkpoint".into()),
    }
}
#[tauri::command]
fn save_sync_state(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let mut file =
        tempfile::NamedTempFile::new_in(&root).map_err(|_| "Cannot prepare sync checkpoint")?;
    file.write_all(&serde_json::to_vec(&value).map_err(|_| "Cannot encode sync checkpoint")?)
        .map_err(|_| "Cannot write sync checkpoint")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush sync checkpoint")?;
    file.persist(root.join("sync-state.json"))
        .map_err(|_| "Cannot save sync checkpoint")?;
    Ok(())
}

#[tauri::command]
async fn detect_providers() -> Vec<providers::ProviderStatus> {
    let (a, b, c) = tokio::join!(
        providers::detect_one("codex"),
        providers::detect_one("claude"),
        providers::detect_one("gemini")
    );
    vec![a, b, c]
}
#[tauri::command]
fn load_workspace(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("workspace.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            "Saved workspace is unreadable. Your existing file has been preserved.".into()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read the saved workspace. Check your app data permissions.".into()),
    }
}
#[tauri::command]
fn save_workspace(
    app: tauri::AppHandle,
    storage: State<Storage>,
    workspace: serde_json::Value,
) -> Result<(), String> {
    let _lock = storage.0.lock().map_err(|_| "Storage lock failed")?;
    if workspace["version"] != 3
        || !workspace["preferences"].is_object()
        || !workspace["conversations"].is_array()
    {
        return Err("Invalid workspace".into());
    }
    let bytes = serde_json::to_vec(&workspace).map_err(|_| "Cannot serialize workspace")?;
    if bytes.len() > 20_000_000 {
        return Err("Workspace exceeds 20 MB. Export and remove older conversations.".into());
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create app data directory")?;
    let mut file =
        tempfile::NamedTempFile::new_in(&root).map_err(|_| "Cannot prepare workspace save")?;
    file.write_all(&bytes)
        .map_err(|_| "Cannot write workspace")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Cannot flush workspace")?;
    let path = root.join("workspace.json");
    // Keep the original pre-migration workspace once, without rewriting its data.
    if path.is_file() {
        if let Ok(old) = std::fs::read(&path) {
            if let Ok(previous) = serde_json::from_slice::<serde_json::Value>(&old) {
                if let Some(version @ (1 | 2)) = previous["version"].as_u64() {
                    let backup = root.join(format!("workspace-v{version}-backup.json"));
                    if !backup.exists() {
                        std::fs::write(&backup, old)
                            .map_err(|_| "Cannot back up the previous workspace")?;
                    }
                }
            }
        }
    }
    file.persist(path)
        .map_err(|_| "Cannot finish workspace save. The previous file was preserved.")?;
    Ok(())
}
#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    runs: State<'_, runner::Runs>,
    request: providers::RunRequest,
    on_event: Channel<protocol::RunEvent>,
    connection_id: Option<String>,
) -> Result<String, String> {
    request.validate()?;
    folders::validate_chat(&app, request.location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &request.agent.provider, connection_id.as_deref())?;
    profile.folder_distribution = request
        .location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    let cancel = CancellationToken::new();
    {
        let mut active = runs.0.lock().map_err(|_| "Run registry lock failed")?;
        if !active.is_empty() {
            return Err(
                "Another response is still running. Stop it or wait for it to finish.".into(),
            );
        }
        active.insert(request.run_id.clone(), cancel.clone());
    }
    let id = request.run_id.clone();
    let _ = on_event.send(protocol::RunEvent::Activity {
        text: "Starting the provider CLI".into(),
    });
    let result = profiles::scope(profile, runner::run(app, request, on_event, cancel)).await;
    if let Ok(mut active) = runs.0.lock() {
        active.remove(&id);
    }
    result
}
#[tauri::command]
async fn cancel_run(
    runs: State<'_, runner::Runs>,
    run_id: String,
    wait_for_completion: Option<bool>,
) -> Result<(), String> {
    {
        let active = runs.0.lock().map_err(|_| "Run registry lock failed")?;
        if let Some(token) = active.get(&run_id) {
            token.cancel();
        }
    }
    if wait_for_completion.unwrap_or(false) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while runs
            .0
            .lock()
            .map_err(|_| "Run registry lock failed")?
            .contains_key(&run_id)
        {
            if std::time::Instant::now() >= deadline {
                return Err("The response has not stopped yet. Try deleting again.".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    Ok(())
}
#[tauri::command]
async fn sign_in(
    app: tauri::AppHandle,
    provider: String,
    connection_id: Option<String>,
) -> Result<(), String> {
    let profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?
        .join("sign-in");
    profiles::scope(profile, providers::sign_in(&provider, &directory)).await
}

#[tauri::command]
fn export_workspace(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<String, String> {
    if workspace["version"] != 3 {
        return Err("Invalid workspace".into());
    }
    let root = app
        .path()
        .download_dir()
        .map_err(|_| "Cannot locate Downloads")?;
    std::fs::create_dir_all(&root).map_err(|_| "Cannot create Downloads directory")?;
    let path = root.join(format!("agent-studio-{}.json", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(&workspace).map_err(|_| "Cannot encode export")?;
    std::fs::write(&path, bytes).map_err(|_| "Cannot write workspace export")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("studio-artifact", |_context, request| {
            artifacts::response(request.uri().path())
        })
        .plugin(tauri_plugin_opener::init())
        .manage(runner::Runs::default())
        .manage(titles::Titles::default())
        .manage(Storage::default())
        .manage(notifications::Notifications::default())
        .manage(relay::Relay::default())
        .manage(usage::UsageState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let mut tokens = window
                    .state::<runner::Runs>()
                    .0
                    .lock()
                    .map(|active| active.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                tokens.extend(
                    window
                        .state::<titles::Titles>()
                        .0
                        .lock()
                        .map(|active| active.values().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
                );
                tokens.extend(
                    window
                        .state::<usage::UsageState>()
                        .active
                        .lock()
                        .map(|a| a.values().cloned().collect::<Vec<_>>())
                        .unwrap_or_default(),
                );
                if !tokens.is_empty() {
                    // Cancel all owned work before closing the window.
                    for token in tokens {
                        token.cancel();
                    }
                    api.prevent_close();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                            if window
                                .state::<runner::Runs>()
                                .0
                                .lock()
                                .map(|r| r.is_empty())
                                .unwrap_or(true)
                                && window
                                    .state::<titles::Titles>()
                                    .0
                                    .lock()
                                    .map(|r| r.is_empty())
                                    .unwrap_or(true)
                                && window
                                    .state::<usage::UsageState>()
                                    .active
                                    .lock()
                                    .map(|r| r.is_empty())
                                    .unwrap_or(true)
                            {
                                break;
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        let _ = window.close();
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            badges::set_pending_chat_badge,
            notifications::desktop_notification_settings,
            notifications::set_desktop_notifications,
            notifications::desktop_notification,
            artifacts::save_artifact,
            get_installation,
            discover_wsl,
            inspect_environment_clis,
            list_folders,
            detect_connection,
            relay_connect,
            relay_resume,
            relay_disconnect,
            relay_request,
            load_sync_state,
            save_sync_state,
            detect_providers,
            list_models,
            read_usage,
            read_context,
            load_workspace,
            save_workspace,
            run_agent,
            generate_title,
            cancel_title,
            cancel_run,
            sign_in,
            export_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
