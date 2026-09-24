mod artifacts;
mod background_work;
mod badges;
mod cli_queries;
mod context;
mod drafts;
mod folders;
mod live_usage;
mod mcp;
mod mentions;
mod models;
mod native_instructions;
mod notifications;
mod plugins;
mod pool;
mod profiles;
mod protocol;
mod providers;
mod relay;
mod runner;
mod saved;
mod shared_context;
mod spend;
mod standalone;
mod startup;
mod structured_output;
mod titles;
mod undo;
mod updates;
mod usage;
mod wsl;
use std::io::Write;
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, State};
use tokio_util::sync::CancellationToken;
/// Serializes workspace and sync checkpoint writes. Holds whether `workspace.json` is known to
/// be current, which spares later saves a check for a pre-migration file to back up.
#[derive(Default)]
struct Storage(Mutex<bool>);

#[tauri::command]
async fn manage_plugins(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
    conversation_id: Option<String>,
    location: Option<folders::ChatLocation>,
    action: plugins::Action,
) -> Result<plugins::ResultView, String> {
    plugins::manage(
        app,
        provider,
        connection_id,
        conversation_id,
        location,
        action,
    )
    .await
}

#[tauri::command]
async fn manage_mcp(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
    conversation_id: Option<String>,
    location: Option<folders::ChatLocation>,
    action: mcp::Action,
) -> Result<mcp::ResultView, String> {
    mcp::manage(
        app,
        provider,
        connection_id,
        conversation_id,
        location,
        action,
    )
    .await
}

#[tauri::command]
async fn read_native_instructions(
    app: tauri::AppHandle,
    conversation_id: String,
    provider: String,
    connection_id: Option<String>,
) -> Result<native_instructions::NativeInstructions, String> {
    native_instructions::read(app, conversation_id, provider, connection_id).await
}

#[tauri::command]
async fn search_mentions(
    app: tauri::AppHandle,
    provider: String,
    connection_id: String,
    location: Option<folders::ChatLocation>,
    conversation_id: Option<String>,
    kind: String,
    query: String,
) -> Result<mentions::Results, String> {
    folders::validate_chat(&app, location.as_ref(), Some(&connection_id))?;
    let mut profile = profiles::resolve(&app, &provider, Some(&connection_id))?;
    profile.folder_distribution = location
        .as_ref()
        .map(|l| folders::environment_distribution(&app, &l.environment_id))
        .transpose()?
        .flatten();
    profiles::scope(
        profile,
        mentions::read(app, provider, location, conversation_id, kind, query),
    )
    .await
}

#[tauri::command]
async fn read_context(
    app: tauri::AppHandle,
    provider: String,
    model: String,
    location: Option<folders::ChatLocation>,
    connection_id: Option<String>,
    conversation_id: Option<String>,
    forked: Option<bool>,
) -> Result<context::ContextSnapshot, String> {
    folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &provider, connection_id.as_deref())?;
    profile.folder_distribution = location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    profiles::scope(
        profile,
        context::read(
            app,
            provider,
            model,
            location,
            conversation_id,
            forked.unwrap_or(false),
        ),
    )
    .await
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
fn live_account_updates(state: State<'_, live_usage::LiveUsage>) -> Vec<live_usage::Update> {
    state.snapshots()
}

#[tauri::command]
fn background_work(state: State<'_, background_work::Registry>) -> Vec<background_work::Snapshot> {
    state.snapshots()
}

#[tauri::command]
async fn manage_account(
    app: tauri::AppHandle,
    connection_id: String,
    input: live_usage::Action,
) -> Result<serde_json::Value, String> {
    let profile = profiles::resolve(&app, "codex", Some(&connection_id))?;
    profiles::scope(profile, live_usage::manage(&app, input)).await
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
// Read-only check of one environment's existing CLI login, used before a connection exists so
// the app can tell whether that login is already connected through another profile.
#[tauri::command]
async fn detect_environment_login(
    app: tauri::AppHandle,
    provider: String,
    environment_id: String,
) -> Result<providers::ProviderStatus, String> {
    let profile = profiles::environment_profile(&app, &provider, &environment_id)?;
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
        &app.path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?,
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
        &app.path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?,
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
// Workspace and checkpoint saves write megabytes. Keep them off the UI thread: it also
// handles window input, so a blocked save made text selection and typing stall.
#[tauri::command]
async fn save_sync_state(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_sync_state(&app, &value))
        .await
        .map_err(|_| "Cannot save sync checkpoint")?
}
fn write_sync_state(app: &tauri::AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let storage = app.state::<Storage>();
    let _lock = storage.0.lock().map_err(|_| "Storage lock failed")?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate app data")?;
    let mut file =
        tempfile::NamedTempFile::new_in(&root).map_err(|_| "Cannot prepare sync checkpoint")?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| "Cannot encode sync checkpoint")?)
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
async fn save_workspace(app: tauri::AppHandle, workspace: serde_json::Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_workspace(&app, &workspace))
        .await
        .map_err(|_| "Cannot save the workspace")?
}
fn write_workspace(app: &tauri::AppHandle, workspace: &serde_json::Value) -> Result<(), String> {
    let storage = app.state::<Storage>();
    let mut current = storage.0.lock().map_err(|_| "Storage lock failed")?;
    if workspace["version"] != 3
        || !workspace["preferences"].is_object()
        || !workspace["conversations"].is_array()
    {
        return Err("Invalid workspace".into());
    }
    let bytes = serde_json::to_vec(workspace).map_err(|_| "Cannot serialize workspace")?;
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
    // Keep the original pre-migration workspace once, without rewriting its data. Only the
    // file found at launch can be older, since this app writes the current version.
    if !*current && path.is_file() {
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
    *current = true;
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
    // A request from a window or device that has not received a later rewind or file Undo
    // must not continue the replaced history. A newer request may arrive before sync does.
    if let Some(id) = &request.conversation_id {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?;
        if let Ok(bytes) = std::fs::read(root.join("workspace.json")) {
            if let Some(conversation) =
                saved::conversations(&bytes).and_then(|list| list.into_iter().find(|c| c.id == *id))
            {
                if conversation.history_revision.as_u64().unwrap_or(0) > request.history_revision {
                    return Err(providers::sessions::STALE_HISTORY.into());
                }
            }
        }
    }
    folders::validate_chat(&app, request.location.as_ref(), connection_id.as_deref())?;
    let mut profile = profiles::resolve(&app, &request.agent.provider, connection_id.as_deref())?;
    profile.folder_distribution = request
        .location
        .as_ref()
        .map(|location| folders::environment_distribution(&app, &location.environment_id))
        .transpose()?
        .flatten();
    let cancel = CancellationToken::new();
    runs.begin(&request.run_id, cancel.clone()).await?;
    let id = request.run_id.clone();
    let _ = on_event.send(protocol::RunEvent::Activity {
        text: "Starting the provider CLI".into(),
    });
    let result = profiles::scope(
        profile,
        runner::run(app, request, on_event, cancel, connection_id),
    )
    .await;
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
async fn release_conversation(
    pool: State<'_, pool::Pool>,
    conversation_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
    pool.release(&conversation_id).await;
    Ok(())
}
#[tauri::command]
async fn undo_files(
    app: tauri::AppHandle,
    runs: State<'_, runner::Runs>,
    storage: State<'_, Storage>,
    conversation_id: String,
    run_id: String,
    connection_id: Option<String>,
    commit: bool,
) -> Result<undo::Preview, String> {
    let operation = uuid::Uuid::new_v4().to_string();
    runs.begin(&operation, CancellationToken::new()).await?;
    let result = async {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Cannot locate app data")?;
        let conversation = saved::conversations(
            &std::fs::read(root.join("workspace.json"))
                .map_err(|_| "Save the conversation before Undo")?,
        )
        .ok_or("Cannot read the saved conversation")?
        .into_iter()
        .find(|c| c.id == conversation_id)
        .ok_or("Conversation is unavailable")?;
        if conversation.settings["connectionId"].as_str() != connection_id.as_deref() {
            return Err("The selected account changed. Reopen Undo.".into());
        }
        let messages = conversation
            .messages
            .as_ref()
            .ok_or("Invalid conversation")?;
        if messages.iter().any(|m| m.status == "running") {
            return Err("Wait for the response to finish before Undo".into());
        }
        if !messages
            .iter()
            .any(|m| m.role == "assistant" && m.run_id == run_id)
        {
            return Err("The response is no longer in this conversation".into());
        }
        let provider = conversation.settings["provider"]
            .as_str()
            .ok_or("Invalid provider")?;
        let location: Option<folders::ChatLocation> = if conversation.location["path"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            None
        } else {
            Some(
                serde_json::from_value(conversation.location.clone())
                    .map_err(|_| "Invalid conversation folder")?,
            )
        };
        folders::validate_chat(&app, location.as_ref(), connection_id.as_deref())?;
        let mut profile = profiles::resolve(&app, provider, connection_id.as_deref())?;
        profile.folder_distribution = location
            .as_ref()
            .map(|l| folders::environment_distribution(&app, &l.environment_id))
            .transpose()?
            .flatten();
        uuid::Uuid::parse_str(&conversation_id).map_err(|_| "Invalid conversation id")?;
        std::fs::create_dir_all(root.join("native-sessions"))
            .map_err(|_| "Cannot lock the conversation")?;
        let lock = std::fs::File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(
                root.join("native-sessions")
                    .join(format!("{conversation_id}.lock")),
            )
            .map_err(|_| "Cannot lock the conversation")?;
        lock.try_lock()
            .map_err(|_| "This conversation is running in another window")?;
        if commit {
            app.state::<pool::Pool>().release(&conversation_id).await;
        }
        let preview = profiles::scope(profile, async {
            let scope = providers::sessions::location_scope(provider, location.as_ref())?;
            undo::apply(&root, &conversation_id, &run_id, &scope, commit)
        })
        .await?;
        if preview.undone {
            // Save the receipt on the executing host even if the requesting Viewer
            // disconnects before receiving its result. Retrying is idempotent.
            let _storage = storage.0.lock().map_err(|_| "Storage lock failed")?;
            let mut workspace: serde_json::Value =
                serde_json::from_slice(&std::fs::read(root.join("workspace.json")).map_err(
                    |_| "Files were undone, but their status could not be saved. Retry Undo.",
                )?)
                .map_err(|_| "Cannot read workspace")?;
            if let Some(conversation) = workspace["conversations"]
                .as_array_mut()
                .and_then(|list| list.iter_mut().find(|c| c["id"] == conversation_id))
            {
                if let Some(message) = conversation["messages"]
                    .as_array_mut()
                    .and_then(|list| list.iter_mut().find(|m| m["runId"] == run_id))
                {
                    if message["filesUndone"] != true {
                        message["filesUndone"] = true.into();
                        conversation["historyRevision"] =
                            (conversation["historyRevision"].as_u64().unwrap_or(0) + 1).into();
                    }
                }
            }
            let mut file = tempfile::NamedTempFile::new_in(&root).map_err(|_| {
                "Files were undone, but their status could not be saved. Retry Undo."
            })?;
            file.write_all(&serde_json::to_vec(&workspace).map_err(|_| "Cannot encode workspace")?)
                .map_err(|_| "Cannot save Undo status")?;
            file.as_file()
                .sync_all()
                .map_err(|_| "Cannot flush Undo status")?;
            file.persist(root.join("workspace.json"))
                .map_err(|_| "Cannot save Undo status")?;
        }
        Ok(preview)
    }
    .await;
    if let Ok(mut active) = runs.0.lock() {
        active.remove(&operation);
    }
    result
}
#[tauri::command]
async fn answer_question(
    questions: State<'_, providers::questions::Questions>,
    run_id: String,
    connection_id: Option<String>,
    answer: providers::questions::Answer,
) -> Result<(), String> {
    questions
        .answer(&run_id, connection_id.as_deref(), answer)
        .await
}
#[tauri::command]
async fn manage_elicitation(
    questions: State<'_, providers::questions::Questions>,
    run_id: String,
    connection_id: Option<String>,
    input: providers::elicitation::Input,
) -> Result<Option<providers::elicitation::Request>, String> {
    questions
        .2
        .manage(&run_id, connection_id.as_deref(), input)
        .await
}
#[tauri::command]
async fn steer_run(
    questions: State<'_, providers::questions::Questions>,
    run_id: String,
    connection_id: Option<String>,
    input: providers::steering::Input,
) -> Result<(), String> {
    questions
        .1
        .send(&run_id, connection_id.as_deref(), input)
        .await
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

/// Cancellation tokens of work this app owns: replies, titles, usage reads, and plugin evaluations.
fn owned_tokens(app: &tauri::AppHandle) -> Vec<CancellationToken> {
    let mut tokens = app
        .state::<runner::Runs>()
        .0
        .lock()
        .map(|active| active.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    tokens.extend(
        app.state::<titles::Titles>()
            .0
            .lock()
            .map(|active| active.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    tokens.extend(
        app.state::<usage::UsageState>()
            .active
            .lock()
            .map(|a| a.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    tokens.extend(plugins::active_tokens());
    tokens
}

fn has_owned_work(app: &tauri::AppHandle) -> bool {
    !owned_tokens(app).is_empty()
        || app.state::<pool::Pool>().len() > 0
        || app.state::<mcp::Management>().has_work()
}

/// Cancel all owned work, release parked CLIs, and wait until owned processes have stopped.
async fn release_owned_work(app: &tauri::AppHandle) {
    for token in owned_tokens(app) {
        token.cancel();
    }
    app.state::<mcp::Management>().sweep(app, true).await;
    app.state::<pool::Pool>().shutdown().await;
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if owned_tokens(app).is_empty() {
            break;
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let version = context.package_info().version.to_string();
    let check_only = std::env::args_os()
        .skip(1)
        .any(|arg| arg == "--check-startup");
    if let Err(message) = startup::verify(&context.config().identifier) {
        eprintln!("{message}");
        if !check_only {
            startup::show_error(message);
        }
        std::process::exit(1);
    }
    if check_only {
        println!("Agent Studio startup storage verified.");
        return;
    }
    tauri::Builder::default()
        .register_uri_scheme_protocol("studio-artifact", |_context, request| {
            artifacts::response(request.uri().path())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::Updates::new(version))
        .manage(runner::Runs::default())
        .manage(pool::Pool::default())
        .manage(mcp::Management::default())
        .manage(providers::questions::Questions::default())
        .manage(titles::Titles::default())
        .manage(Storage::default())
        .manage(drafts::DraftStorage::default())
        .manage(notifications::Notifications::default())
        .manage(relay::Relay::default())
        .manage(usage::UsageState::default())
        .manage(live_usage::LiveUsage::default())
        .manage(background_work::Registry::default())
        .setup(|app| {
            // Release parked CLI processes that stayed idle past their limit.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    handle.state::<pool::Pool>().sweep().await;
                    handle
                        .state::<mcp::Management>()
                        .sweep(&handle, false)
                        .await;
                }
            });
            updates::start(app.handle());
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                webview.state::<runner::Runs>().interrupt_for_reload();
                for token in plugins::active_tokens() {
                    token.cancel();
                }
                let handle = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<mcp::Management>().sweep(&handle, true).await;
                });
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                // Restart to update is already stopping work; its installer ends the app.
                if updates::installing(&app) {
                    api.prevent_close();
                    return;
                }
                // An idle app installs a downloaded update as it closes, without relaunching.
                let update = updates::take_for_close(&app);
                if update.is_none() && !has_owned_work(&app) {
                    return;
                }
                // Cancel all owned work and release parked CLIs before closing the window.
                for token in owned_tokens(&app) {
                    token.cancel();
                }
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    release_owned_work(&app).await;
                    if let Some(update) = update {
                        if updates::install_on_close(&app, update) {
                            app.exit(0);
                            return;
                        }
                    }
                    let _ = window.close();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            badges::set_pending_chat_badge,
            notifications::desktop_notification_settings,
            notifications::set_desktop_notifications,
            notifications::desktop_notification,
            updates::app_update_status,
            updates::check_app_update,
            updates::install_app_update,
            artifacts::save_artifact,
            get_installation,
            discover_wsl,
            inspect_environment_clis,
            list_folders,
            detect_connection,
            detect_environment_login,
            relay_connect,
            relay_resume,
            relay_disconnect,
            relay_request,
            load_sync_state,
            save_sync_state,
            detect_providers,
            list_models,
            read_usage,
            live_account_updates,
            background_work,
            manage_account,
            read_context,
            search_mentions,
            manage_mcp,
            manage_plugins,
            read_native_instructions,
            load_workspace,
            save_workspace,
            drafts::load_drafts,
            drafts::save_drafts,
            run_agent,
            generate_title,
            cancel_title,
            cancel_run,
            release_conversation,
            undo_files,
            answer_question,
            manage_elicitation,
            steer_run,
            sign_in,
            export_workspace
        ])
        .run(context)
        .expect("error while running tauri application");
}
