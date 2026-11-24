//! Git worktrees that keep the runs of a comparison apart (docs/COMPARISONS.md). Each run of the
//! same task works in a worktree of its own, made from one snapshot of the chosen folder that
//! holds its uncommitted and untracked files, so every run starts from what the user sees and none
//! touches another's files or the folder itself. Worktrees live in this app's data, never in the
//! repository, each on a branch of its own. The host records the worktrees it made, so a window
//! names a comparison and a run, never a path.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::Manager;

const VERSION: u32 = 1;
const NOT_A_REPOSITORY: &str = "Compare needs a git repository, or Standalone.";
/// The snapshot commit is git's object, written by no one: it names this app as its author.
const AUTHOR: [&str; 4] = [
    "-c",
    "user.name=Agent Studio",
    "-c",
    "user.email=agent-studio@localhost",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    environment_id: String,
    /// The WSL distribution the folder is in; none on this computer's own system.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    distribution: Option<String>,
    /// The folder the comparison started in.
    source: String,
    /// The repository's top folder, and the chosen folder's place in it, such as `app/`.
    top: String,
    prefix: String,
    snapshot: String,
    worktrees: Vec<Tree>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tree {
    root: String,
    branch: String,
    /// Whether this app made its folder and branch, which neither existed before: only then
    /// does removing it remove them.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    made: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    removed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub snapshot: String,
    pub worktrees: Vec<Worktree>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Where the run works: the worktree's own copy of the chosen folder.
    pub path: String,
    pub branch: String,
}

/// A file a run changed, from the snapshot to what its worktree holds now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// added, modified, deleted or changed (its type).
    pub status: String,
}

#[derive(Clone, Debug, PartialEq)]
enum Place {
    /// This computer's own system.
    Here,
    /// A WSL distribution this computer manages.
    Wsl(String),
}

impl Place {
    fn of(record: &Record) -> Self {
        record.distribution.clone().map_or(Place::Here, Place::Wsl)
    }
    fn join(&self, base: &str, rest: &str) -> String {
        let rest = rest.trim_matches('/');
        if rest.is_empty() {
            return base.to_string();
        }
        match self {
            Place::Here => Path::new(base)
                .join(rest.replace('/', std::path::MAIN_SEPARATOR_STR))
                .to_string_lossy()
                .into_owned(),
            Place::Wsl(_) => format!("{}/{rest}", base.trim_end_matches('/')),
        }
    }
    /// Whether `path` is `root` or a folder inside it.
    fn inside(&self, path: &str, root: &str) -> bool {
        match self {
            Place::Here => {
                let fold = |p: &str| {
                    let p = p.replace('\\', "/");
                    let p = p.trim_end_matches('/').to_string();
                    if cfg!(windows) {
                        p.to_lowercase()
                    } else {
                        p
                    }
                };
                let (path, root) = (fold(path), fold(root));
                path == root || path.starts_with(&format!("{root}/"))
            }
            Place::Wsl(_) => {
                let root = root.trim_end_matches('/');
                path == root || path.starts_with(&format!("{root}/"))
            }
        }
    }
}

fn command(place: &Place, program: &str, env: &[(&str, &str)]) -> tokio::process::Command {
    let mut command = match place {
        Place::Here => {
            let mut command = tokio::process::Command::new(program);
            command.envs(env.iter().copied());
            command
        }
        Place::Wsl(distribution) => {
            let mut command = tokio::process::Command::new("wsl.exe");
            command.args(["--distribution", distribution, "--cd", "~", "--exec", "env"]);
            command.args(env.iter().map(|(k, v)| format!("{k}={v}")));
            command.arg(program);
            command
        }
    };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Runs git in `dir` and returns its output. Git never asks for anything here.
async fn git(
    place: &Place,
    dir: &str,
    args: &[&str],
    env: &[(&str, &str)],
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let mut env = env.to_vec();
    env.push(("GIT_TERMINAL_PROMPT", "0"));
    let mut command = command(place, "git", &env);
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = command.spawn().map_err(|error| {
        match (place, error.kind()) {
            (Place::Here, std::io::ErrorKind::NotFound) => "Git is not installed on this computer.",
            (Place::Wsl(_), std::io::ErrorKind::NotFound) => "WSL is not available.",
            _ => "Cannot start Git.",
        }
        .to_string()
    })?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // Written beside the read of git's answer, which a large patch could otherwise block.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&input).await;
        });
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|_| "Git stopped unexpectedly.")?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    if matches!(place, Place::Wsl(_)) && output.status.code() == Some(127) {
        return Err("Git is not installed in this WSL distribution.".into());
    }
    Err(git_error(&output.stderr))
}

async fn text(
    place: &Place,
    dir: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String, String> {
    let output = git(place, dir, args, env, None).await?;
    Ok(String::from_utf8(output)
        .map_err(|_| "Git answered with unreadable text.")?
        .trim_end_matches(['\n', '\r'])
        .to_string())
}

/// Git's own reasons: its `fatal:` and `error:` lines, else its first line.
fn git_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let reasons: Vec<&str> = lines
        .iter()
        .filter_map(|line| {
            line.strip_prefix("fatal:")
                .or_else(|| line.strip_prefix("error:"))
                .map(str::trim)
        })
        .collect();
    let reasons = if reasons.is_empty() {
        lines.into_iter().take(1).collect()
    } else {
        reasons
    };
    let reason: String = reasons
        .join("; ")
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if reason.is_empty() {
        "Git failed.".into()
    } else {
        format!("Git: {reason}")
    }
}

/// Runs a program other than git in a WSL distribution, and tells whether it succeeded.
async fn wsl_run(distribution: &str, program: &str, args: &[&str]) -> bool {
    let mut command = command(&Place::Wsl(distribution.into()), program, &[]);
    command.args(args).stdin(Stdio::null());
    command
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

async fn exists(place: &Place, path: &str) -> bool {
    match place {
        Place::Here => Path::new(path).exists(),
        Place::Wsl(distribution) => wsl_run(distribution, "test", &["-e", path]).await,
    }
}

async fn copy_file(place: &Place, from: &str, to: &str) -> bool {
    match place {
        Place::Here => std::fs::copy(from, to).is_ok(),
        Place::Wsl(distribution) => wsl_run(distribution, "cp", &["-f", "--", from, to]).await,
    }
}

async fn remove_file(place: &Place, path: &str) {
    match place {
        Place::Here => {
            let _ = std::fs::remove_file(path);
        }
        Place::Wsl(distribution) => {
            wsl_run(distribution, "rm", &["-f", "--", path]).await;
        }
    }
}

/// Removes a folder this app made under `base`, and nothing outside it.
async fn remove_folder(place: &Place, base: &str, path: &str) -> bool {
    if !place.inside(path, base) || place.inside(base, path) {
        return false;
    }
    match place {
        Place::Here => {
            let path = PathBuf::from(path);
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(path).is_ok())
                .await
                .unwrap_or(false)
        }
        Place::Wsl(distribution) => wsl_run(distribution, "rm", &["-rf", "--", path]).await,
    }
}

struct Snapshot {
    top: String,
    prefix: String,
    commit: String,
}

/// A commit of everything `folder`'s repository holds now, uncommitted and untracked files
/// included, made through an index of its own so the user's index, stash and files stay as
/// they are. Ignored files stay out, as git leaves them out.
async fn snapshot(place: &Place, folder: &str) -> Result<Snapshot, String> {
    let top = text(place, folder, &["rev-parse", "--show-toplevel"], &[])
        .await
        .map_err(|error| {
            if error.starts_with("Git: not a git repository") || error.contains("not a git") {
                NOT_A_REPOSITORY.to_string()
            } else {
                error
            }
        })?;
    if top.is_empty() {
        return Err(NOT_A_REPOSITORY.into());
    }
    let prefix = text(place, folder, &["rev-parse", "--show-prefix"], &[]).await?;
    let head = text(
        place,
        &top,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        &[],
    )
    .await
    .ok()
    .filter(|head| !head.is_empty());
    let git_path = |name: String| {
        let top = top.clone();
        async move {
            text(
                place,
                &top,
                &["rev-parse", "--path-format=absolute", "--git-path", &name],
                &[],
            )
            .await
        }
    };
    let index = git_path("index".into()).await?;
    let temporary = git_path(format!(
        "agent-studio-snapshot-{}.index",
        uuid::Uuid::new_v4().simple()
    ))
    .await?;
    // Starting from the user's index only spares git rereading unchanged files; an empty
    // repository has none.
    if exists(place, &index).await {
        copy_file(place, &index, &temporary).await;
    }
    let env = [("GIT_INDEX_FILE", temporary.as_str())];
    let staged = async {
        git(place, &top, &["add", "--all"], &env, None).await?;
        text(place, &top, &["write-tree"], &env).await
    }
    .await;
    remove_file(place, &temporary).await;
    let tree = staged?;
    let mut args = AUTHOR.to_vec();
    args.extend([
        "commit-tree",
        &tree,
        "-m",
        "Agent Studio comparison snapshot",
    ]);
    if let Some(head) = &head {
        args.extend(["-p", head]);
    }
    let commit = text(place, &top, &args, &[]).await?;
    Ok(Snapshot {
        top,
        prefix,
        commit,
    })
}

/// Files the repository's `.worktreeinclude` names that git leaves out of the snapshot (such as
/// `.env`), copied into each new worktree, as Claude Code copies them into its own.
async fn include(place: &Place, record: &Record) -> Result<(), String> {
    let list = place.join(&record.top, ".worktreeinclude");
    if !exists(place, &list).await {
        return Ok(());
    }
    let files = git(
        place,
        &record.top,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-from=.worktreeinclude",
        ],
        &[],
        None,
    )
    .await?;
    if files.is_empty() {
        return Ok(());
    }
    let roots: Vec<String> = record.worktrees.iter().map(|t| t.root.clone()).collect();
    match place {
        Place::Here => {
            let top = PathBuf::from(&record.top);
            tokio::task::spawn_blocking(move || copy_included(&top, &roots, &files))
                .await
                .map_err(|_| "Cannot copy the files .worktreeinclude names.")?
        }
        Place::Wsl(_) => {
            let script = crate::wsl::embedded_script(include_str!("worktree-include.sh"));
            let mut command = command(place, "bash", &[]);
            // `command` ends with `env bash`: the script and its arguments follow as data.
            command
                .args(["-c", &script, "agent-studio", &record.top])
                .args(&roots)
                .stdin(Stdio::piped());
            let mut child = command
                .spawn()
                .map_err(|_| "Cannot copy the files .worktreeinclude names.")?;
            if let Some(mut stdin) = child.stdin.take() {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(&files).await;
                });
            }
            let output = child
                .wait_with_output()
                .await
                .map_err(|_| "Cannot copy the files .worktreeinclude names.")?;
            if output.status.success() {
                Ok(())
            } else {
                Err("Cannot copy the files .worktreeinclude names.".into())
            }
        }
    }
}

fn copy_included(top: &Path, roots: &[String], files: &[u8]) -> Result<(), String> {
    for name in files.split(|b| *b == 0).filter(|name| !name.is_empty()) {
        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let source = top.join(relative);
        // Links are skipped, as Claude Code skips them: one could lead out of the repository.
        match std::fs::symlink_metadata(&source) {
            Ok(meta) if meta.file_type().is_file() => {}
            _ => continue,
        }
        for root in roots {
            let target = Path::new(root).join(relative);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| format!("Cannot copy {name} into a worktree."))?;
            }
            std::fs::copy(&source, &target)
                .map_err(|_| format!("Cannot copy {name} into a worktree."))?;
        }
    }
    Ok(())
}

fn record_file(records: &Path, comparison_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(comparison_id).map_err(|_| "Invalid comparison id")?;
    Ok(records.join(format!("{id}.json")))
}

fn read(file: &Path) -> Result<Option<Record>, String> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot read this comparison's worktrees.".into()),
    };
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| "This comparison's record of its worktrees is invalid; it was kept.")?;
    if record.version != VERSION {
        return Err("This comparison's worktrees were made by another release.".into());
    }
    Ok(Some(record))
}

fn save(file: &Path, record: &Record) -> Result<(), String> {
    let folder = file
        .parent()
        .ok_or("Cannot save this comparison's worktrees.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(folder)
        .map_err(|_| "Cannot save this comparison's worktrees.")?;
    std::io::Write::write_all(
        &mut temporary,
        &serde_json::to_vec_pretty(record)
            .map_err(|_| "Cannot save this comparison's worktrees.")?,
    )
    .map_err(|_| "Cannot save this comparison's worktrees.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot save this comparison's worktrees.")?;
    temporary
        .persist(file)
        .map_err(|_| "Cannot save this comparison's worktrees.")?;
    Ok(())
}

fn records(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate the app data directory")?
        .join("worktrees"))
}

/// Where a place keeps this app's worktrees: app data here, and the app's own folder in a WSL
/// distribution's home.
async fn base(app: &tauri::AppHandle, place: &Place) -> Result<String, String> {
    match place {
        Place::Here => Ok(records(app)?.to_string_lossy().into_owned()),
        Place::Wsl(distribution) => {
            let mut command = command(place, "printenv", &[]);
            command.arg("HOME").stdin(Stdio::null());
            let output = command
                .output()
                .await
                .map_err(|_| "Cannot reach this WSL distribution.")?;
            let home = String::from_utf8(output.stdout).unwrap_or_default();
            let home = home.trim_end_matches(['\n', '\r']);
            if !output.status.success() || !home.starts_with('/') {
                return Err(format!("Cannot find the home folder in {distribution}."));
            }
            Ok(format!(
                "{}/.local/share/{}/worktrees",
                home.trim_end_matches('/'),
                app.config().identifier
            ))
        }
    }
}

/// Makes `count` worktrees of `path`'s repository for a comparison, each from one snapshot.
pub async fn create(
    app: tauri::AppHandle,
    environment_id: String,
    path: String,
    comparison_id: String,
    count: u32,
) -> Result<Created, String> {
    let distribution = crate::folders::environment_distribution(&app, &environment_id)?;
    crate::folders::validate_path(&path, distribution.is_some() || !cfg!(windows))?;
    if path.is_empty() {
        return Err(NOT_A_REPOSITORY.into());
    }
    let place = distribution.clone().map_or(Place::Here, Place::Wsl);
    let base = base(&app, &place).await?;
    create_at(
        &records(&app)?,
        &base,
        place,
        environment_id,
        path,
        &comparison_id,
        count,
    )
    .await
}

async fn create_at(
    records: &Path,
    base: &str,
    place: Place,
    environment_id: String,
    path: String,
    comparison_id: &str,
    count: u32,
) -> Result<Created, String> {
    if count == 0 {
        return Err("A comparison needs at least one run.".into());
    }
    let file = record_file(records, comparison_id)?;
    std::fs::create_dir_all(records).map_err(|_| "Cannot prepare the worktrees folder.")?;
    if file.exists() {
        return Err("This comparison already has its worktrees.".into());
    }
    let snapshot = snapshot(&place, &path).await?;
    let short = &comparison_id.replace('-', "")[..8];
    let mut record = Record {
        version: VERSION,
        environment_id,
        distribution: match &place {
            Place::Here => None,
            Place::Wsl(distribution) => Some(distribution.clone()),
        },
        source: path,
        top: snapshot.top,
        prefix: snapshot.prefix,
        snapshot: snapshot.commit,
        worktrees: (1..=count)
            .map(|n| Tree {
                root: place.join(base, &format!("{short}-{n}")),
                branch: format!("agent-studio/compare-{short}-{n}"),
                made: false,
                removed: false,
            })
            .collect(),
    };
    // Recorded before the first worktree, so Remove finds whatever a failure leaves.
    save(&file, &record)?;
    let made = async {
        for index in 0..record.worktrees.len() {
            let tree = record.worktrees[index].clone();
            // A folder or branch of that name is someone else's: nothing of it is touched.
            let branch = format!("refs/heads/{}", tree.branch);
            if exists(&place, &tree.root).await
                || git(
                    &place,
                    &record.top,
                    &["rev-parse", "--verify", "--quiet", &branch],
                    &[],
                    None,
                )
                .await
                .is_ok()
            {
                return Err(format!("{} or its branch already exists.", tree.root));
            }
            // Whatever the attempt leaves, even when it fails half way, is this app's.
            record.worktrees[index].made = true;
            save(&file, &record)?;
            let mut args = Vec::new();
            if cfg!(windows) && place == Place::Here {
                // Worktrees in app data sit deeper than the repository the user chose.
                args.extend(["-c", "core.longpaths=true"]);
            }
            args.extend([
                "worktree",
                "add",
                "-b",
                &tree.branch,
                &tree.root,
                &record.snapshot,
            ]);
            git(&place, &record.top, &args, &[], None).await?;
        }
        include(&place, &record).await
    }
    .await;
    let _ = save(&file, &record);
    if let Err(error) = made {
        // A comparison that could not start leaves nothing behind.
        remove_trees(&place, base, &mut record).await;
        if record.worktrees.iter().all(|t| t.removed) {
            let _ = std::fs::remove_file(&file);
        } else {
            let _ = save(&file, &record);
        }
        return Err(error);
    }
    Ok(Created {
        snapshot: record.snapshot.clone(),
        worktrees: record
            .worktrees
            .iter()
            .map(|tree| Worktree {
                path: place.join(&tree.root, &record.prefix),
                branch: tree.branch.clone(),
            })
            .collect(),
    })
}

/// The files a run changed since the snapshot and, with `apply`, those changes put into the
/// folder the comparison started in, as uncommitted changes. A folder changed since the
/// snapshot in the same places refuses them whole, with git's reasons.
pub async fn changes(
    app: tauri::AppHandle,
    comparison_id: String,
    run: usize,
    apply: bool,
) -> Result<Vec<Change>, String> {
    changes_at(&records(&app)?, &comparison_id, run, apply).await
}

async fn changes_at(
    records: &Path,
    comparison_id: &str,
    run: usize,
    apply: bool,
) -> Result<Vec<Change>, String> {
    let file = record_file(records, comparison_id)?;
    let record = read(&file)?.ok_or("This comparison has no worktrees on this computer.")?;
    let tree = record
        .worktrees
        .get(run)
        .filter(|tree| !tree.removed)
        .ok_or("This run's worktree was removed.")?;
    let place = Place::of(&record);
    let result = result_tree(&place, &tree.root).await?;
    let names = git(
        &place,
        &tree.root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            &record.snapshot,
            &result,
        ],
        &[],
        None,
    )
    .await?;
    let changes = parse_changes(&names);
    if !apply || changes.is_empty() {
        return Ok(changes);
    }
    let patch = git(
        &place,
        &tree.root,
        &[
            "diff",
            "--binary",
            "--full-index",
            "--no-renames",
            &record.snapshot,
            &result,
        ],
        &[],
        None,
    )
    .await?;
    git(
        &place,
        &record.top,
        &["apply", "--whitespace=nowarn", "-"],
        &[],
        Some(patch),
    )
    .await?;
    Ok(changes)
}

/// The tree a worktree holds now, its uncommitted and untracked files included, read through an
/// index of its own so the worktree's own stays as the run left it.
async fn result_tree(place: &Place, root: &str) -> Result<String, String> {
    let git_path = |name: String| async move {
        text(
            place,
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", &name],
            &[],
        )
        .await
    };
    let index = git_path("index".into()).await?;
    let temporary = git_path(format!(
        "agent-studio-result-{}.index",
        uuid::Uuid::new_v4().simple()
    ))
    .await?;
    if exists(place, &index).await {
        copy_file(place, &index, &temporary).await;
    }
    let env = [("GIT_INDEX_FILE", temporary.as_str())];
    let tree = async {
        git(place, root, &["add", "--all"], &env, None).await?;
        text(place, root, &["write-tree"], &env).await
    }
    .await;
    remove_file(place, &temporary).await;
    tree
}

fn parse_changes(output: &[u8]) -> Vec<Change> {
    let mut fields = output
        .split(|b| *b == 0)
        .filter(|field| !field.is_empty())
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut changes = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        let status = match status.chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('T') => "changed",
            _ => "modified",
        };
        changes.push(Change {
            path,
            status: status.into(),
        });
    }
    changes
}

/// Removes a comparison's worktrees and their branches. The changes in them go with them.
pub async fn remove(app: tauri::AppHandle, comparison_id: String) -> Result<(), String> {
    let records = records(&app)?;
    let file = record_file(&records, &comparison_id)?;
    let Some(record) = read(&file)? else {
        return Ok(());
    };
    let base = base(&app, &Place::of(&record)).await?;
    remove_at(&records, &base, &comparison_id).await
}

async fn remove_at(records: &Path, base: &str, comparison_id: &str) -> Result<(), String> {
    let file = record_file(records, comparison_id)?;
    let Some(mut record) = read(&file)? else {
        return Ok(());
    };
    let place = Place::of(&record);
    let failed = remove_trees(&place, base, &mut record).await;
    if record.worktrees.iter().all(|tree| tree.removed) {
        std::fs::remove_file(&file).map_err(|_| "Cannot forget this comparison's worktrees.")?;
    } else {
        save(&file, &record)?;
    }
    failed.map_or(Ok(()), Err)
}

async fn remove_trees(place: &Place, base: &str, record: &mut Record) -> Option<String> {
    let mut failed = None;
    let top = record.top.clone();
    for tree in record.worktrees.iter_mut().filter(|tree| !tree.removed) {
        if !tree.made {
            tree.removed = true;
            continue;
        }
        if let Err(error) = git(
            place,
            &top,
            &["worktree", "remove", "--force", &tree.root],
            &[],
            None,
        )
        .await
        {
            // Never made, already gone, or holding what git will not remove (submodules): only
            // the folder this app made is left to remove.
            if exists(place, &tree.root).await && !remove_folder(place, base, &tree.root).await {
                failed.get_or_insert(error);
                continue;
            }
        }
        let _ = git(place, &top, &["worktree", "prune"], &[], None).await;
        let _ = git(place, &top, &["branch", "-D", &tree.branch], &[], None).await;
        tree.removed = true;
    }
    failed
}

/// What a reply learns when it works in one of a comparison's worktrees, read from this
/// computer's own record of them, never from the window.
pub fn note(data: &Path, location: &crate::folders::ChatLocation) -> Option<String> {
    let entries = std::fs::read_dir(data.join("worktrees")).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(Some(record)) = read(&path) else {
            continue;
        };
        if record.environment_id != location.environment_id {
            continue;
        }
        let place = Place::of(&record);
        if let Some(tree) = record
            .worktrees
            .iter()
            .find(|tree| !tree.removed && place.inside(&location.path, &tree.root))
        {
            return Some(format!(
                "This conversation is one run of a comparison: the same task runs several times, each in a git worktree of its own. This one works on branch {}, made from a snapshot of {} with its uncommitted changes. Keep all work in this worktree: don't push, merge, rebase or switch branches, and don't change {} or other worktrees.",
                tree.branch, record.source, record.source
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=Test", "-c", "user.email=test@localhost"])
            .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    /// A repository with a commit, a staged change, an unstaged change, an untracked file, an
    /// ignored file and an ignored file .worktreeinclude names.
    fn repository() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("project");
        std::fs::create_dir_all(repo.join("app")).unwrap();
        run(&repo, &["init", "-q"]);
        run(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join(".gitignore"), "build/\n.env\n").unwrap();
        std::fs::write(repo.join(".worktreeinclude"), ".env\n").unwrap();
        std::fs::write(repo.join("app/main.txt"), "one\n").unwrap();
        std::fs::write(repo.join("app/staged.txt"), "staged\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-q", "-m", "first"]);
        std::fs::write(repo.join("app/staged.txt"), "staged twice\n").unwrap();
        run(&repo, &["add", "app/staged.txt"]);
        std::fs::write(repo.join("app/main.txt"), "one\ntwo\n").unwrap();
        std::fs::write(repo.join("app/new.txt"), "untracked\n").unwrap();
        std::fs::create_dir_all(repo.join("build")).unwrap();
        std::fs::write(repo.join("build/out.bin"), "ignored").unwrap();
        std::fs::write(repo.join(".env"), "SECRET=kept-local\n").unwrap();
        (dir, repo)
    }

    fn location(path: &str) -> crate::folders::ChatLocation {
        serde_json::from_value(serde_json::json!({
            "computerId": uuid::Uuid::new_v4().to_string(),
            "environmentId": "e",
            "path": path,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn runs_start_from_what_the_folder_holds_and_leave_it_alone() {
        if !git_available() {
            return;
        }
        let (dir, repo) = repository();
        let status_before = run(&repo, &["status", "--porcelain"]);
        let records = dir.path().join("data").join("worktrees");
        let base = records.to_string_lossy().into_owned();
        let id = uuid::Uuid::new_v4().to_string();
        let created = create_at(
            &records,
            &base,
            Place::Here,
            "e".into(),
            repo.join("app").to_string_lossy().into_owned(),
            &id,
            2,
        )
        .await
        .unwrap();
        assert_eq!(created.worktrees.len(), 2);
        for worktree in &created.worktrees {
            // The chosen folder inside the repository maps to the same folder in each worktree.
            let folder = Path::new(&worktree.path);
            assert!(folder.ends_with("app"), "{}", worktree.path);
            assert_eq!(
                std::fs::read_to_string(folder.join("main.txt")).unwrap(),
                "one\ntwo\n"
            );
            assert_eq!(
                std::fs::read_to_string(folder.join("staged.txt")).unwrap(),
                "staged twice\n"
            );
            assert_eq!(
                std::fs::read_to_string(folder.join("new.txt")).unwrap(),
                "untracked\n"
            );
            let top = folder.parent().unwrap();
            assert!(!top.join("build").exists());
            // .worktreeinclude brings what git ignores.
            assert_eq!(
                std::fs::read_to_string(top.join(".env")).unwrap(),
                "SECRET=kept-local\n"
            );
            assert!(worktree.branch.starts_with("agent-studio/compare-"));
        }
        // The user's own folder, index and staged state are untouched.
        assert_eq!(run(&repo, &["status", "--porcelain"]), status_before);
        assert_eq!(
            run(&repo, &["diff", "--cached", "--name-only"]),
            "app/staged.txt"
        );
        assert!(!run(&repo, &["branch", "--list", "agent-studio/*"]).is_empty());

        // The note a run's reply reads names its own branch.
        let told = note(
            records.parent().unwrap(),
            &location(&created.worktrees[1].path),
        )
        .unwrap();
        assert!(told.contains(&created.worktrees[1].branch), "{told}");
        assert!(note(
            records.parent().unwrap(),
            &location(&repo.to_string_lossy())
        )
        .is_none());

        // Run 1 edits, adds and deletes files; nothing changed in run 2.
        let first = Path::new(&created.worktrees[0].path);
        std::fs::write(first.join("main.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(first.join("added.txt"), "added\n").unwrap();
        std::fs::remove_file(first.join("new.txt")).unwrap();
        let changes = changes_at(&records, &id, 0, false).await.unwrap();
        let mut seen: Vec<_> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.status.as_str()))
            .collect();
        seen.sort();
        assert_eq!(
            seen,
            [
                ("app/added.txt", "added"),
                ("app/main.txt", "modified"),
                ("app/new.txt", "deleted"),
            ]
        );
        assert!(changes_at(&records, &id, 1, false)
            .await
            .unwrap()
            .is_empty());
        // Previewing changes nothing in the folder.
        assert_eq!(run(&repo, &["status", "--porcelain"]), status_before);

        // Applying puts the run's changes into the folder as uncommitted changes, leaving its
        // index as it was.
        changes_at(&records, &id, 0, true).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(repo.join("app/main.txt")).unwrap(),
            "one\ntwo\nthree\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("app/added.txt")).unwrap(),
            "added\n"
        );
        assert!(!repo.join("app/new.txt").exists());
        assert_eq!(
            run(&repo, &["diff", "--cached", "--name-only"]),
            "app/staged.txt"
        );
        // Applying again refuses whole: the folder no longer matches the snapshot there.
        let error = changes_at(&records, &id, 0, true).await.unwrap_err();
        assert!(error.starts_with("Git:"), "{error}");

        // Removing takes the worktrees, their branches and the record.
        remove_at(&records, &base, &id).await.unwrap();
        for worktree in &created.worktrees {
            assert!(!Path::new(&worktree.path).exists());
        }
        assert!(run(&repo, &["branch", "--list", "agent-studio/*"]).is_empty());
        assert!(!record_file(&records, &id).unwrap().exists());
        assert!(note(
            records.parent().unwrap(),
            &location(&created.worktrees[0].path)
        )
        .is_none());
        // Removing again is nothing to do.
        remove_at(&records, &base, &id).await.unwrap();
    }

    #[tokio::test]
    async fn a_folder_outside_git_or_a_failed_worktree_leaves_nothing() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let records = dir.path().join("data").join("worktrees");
        let base = records.to_string_lossy().into_owned();
        let id = uuid::Uuid::new_v4().to_string();
        let error = create_at(
            &records,
            &base,
            Place::Here,
            "e".into(),
            plain.to_string_lossy().into_owned(),
            &id,
            2,
        )
        .await
        .unwrap_err();
        // A temporary folder can sit inside a repository of its own on a developer's machine.
        if error == NOT_A_REPOSITORY {
            assert!(!record_file(&records, &id).unwrap().exists());
        }

        // The second worktree's branch exists already: the first is removed again.
        let (_repo_dir, repo) = repository();
        let id = uuid::Uuid::new_v4().to_string();
        let short = &id.replace('-', "")[..8];
        run(
            &repo,
            &["branch", &format!("agent-studio/compare-{short}-2")],
        );
        let error = create_at(
            &records,
            &base,
            Place::Here,
            "e".into(),
            repo.to_string_lossy().into_owned(),
            &id,
            2,
        )
        .await
        .unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert!(!Path::new(&base).join(format!("{short}-1")).exists());
        assert!(!record_file(&records, &id).unwrap().exists());
        assert!(run(
            &repo,
            &[
                "branch",
                "--list",
                &format!("agent-studio/compare-{short}-1")
            ]
        )
        .is_empty());
        // The branch that was there first is still there.
        assert!(!run(
            &repo,
            &[
                "branch",
                "--list",
                &format!("agent-studio/compare-{short}-2")
            ]
        )
        .is_empty());
    }

    /// The same inside a WSL distribution, through wsl.exe and the fixed copy script. Run with
    /// AGENT_STUDIO_TEST_WSL=<distribution> and `--ignored`; everything it makes is under /tmp.
    #[tokio::test]
    #[ignore = "needs a WSL distribution named by AGENT_STUDIO_TEST_WSL"]
    async fn wsl_runs_work_in_worktrees_inside_the_distribution() {
        let Ok(distribution) = std::env::var("AGENT_STUDIO_TEST_WSL") else {
            return;
        };
        let shell = |script: &str| {
            std::process::Command::new("wsl.exe")
                .args([
                    "--distribution",
                    &distribution,
                    "--cd",
                    "~",
                    "--exec",
                    "bash",
                    "-c",
                ])
                .arg(script)
                .output()
                .unwrap()
        };
        let text =
            |output: std::process::Output| String::from_utf8_lossy(&output.stdout).into_owned();
        let root = format!(
            "/tmp/agent-studio-worktrees-{}",
            uuid::Uuid::new_v4().simple()
        );
        let setup = shell(&format!(
            "set -e; mkdir -p {root}/repo/app && cd {root}/repo && git init -q && git config user.email t@localhost && git config user.name T && printf 'one\\n' > app/a.txt && printf '.env\\n' > .gitignore && printf '.env\\n' > .worktreeinclude && git add -A && git commit -qm first && printf 'two\\n' >> app/a.txt && printf 'S=1\\n' > .env && printf 'new\\n' > app/new.txt"
        ));
        assert!(
            setup.status.success(),
            "{}",
            String::from_utf8_lossy(&setup.stderr)
        );
        let dir = tempfile::tempdir().unwrap();
        let records = dir.path().join("worktrees");
        let base = format!("{root}/worktrees");
        let id = uuid::Uuid::new_v4().to_string();
        let created = create_at(
            &records,
            &base,
            Place::Wsl(distribution.clone()),
            "e".into(),
            format!("{root}/repo/app"),
            &id,
            2,
        )
        .await
        .unwrap();
        let first = &created.worktrees[0].path;
        assert_eq!(
            first,
            &format!("{base}/{}-1/app", &id.replace('-', "")[..8])
        );
        assert_eq!(
            text(shell(&format!(
                "cat {first}/a.txt {first}/new.txt {}/../.env",
                created.worktrees[1].path
            ))),
            "one\ntwo\nnew\nS=1\n"
        );
        assert!(shell(&format!("printf 'three\\n' >> {first}/a.txt"))
            .status
            .success());
        assert_eq!(
            changes_at(&records, &id, 0, true).await.unwrap(),
            [Change {
                path: "app/a.txt".into(),
                status: "modified".into()
            }]
        );
        assert_eq!(
            text(shell(&format!("cat {root}/repo/app/a.txt"))),
            "one\ntwo\nthree\n"
        );
        remove_at(&records, &base, &id).await.unwrap();
        assert_eq!(
            text(shell(&format!(
                "ls {base} | wc -l; git -C {root}/repo branch --list 'agent-studio/*' | wc -l"
            ))),
            "0\n0\n"
        );
        shell(&format!("rm -rf {root}"));
    }

    #[test]
    fn included_files_never_leave_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().join("top");
        let root = dir.path().join("tree");
        std::fs::create_dir_all(top.join("config")).unwrap();
        std::fs::write(top.join("config/.env"), "a").unwrap();
        std::fs::write(dir.path().join("outside"), "b").unwrap();
        let roots = [root.to_string_lossy().into_owned()];
        copy_included(
            &top,
            &roots,
            b"config/.env\0../outside\0/etc/passwd\0missing\0",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("config/.env")).unwrap(),
            "a"
        );
        // Only config/ was made: nothing outside the repository, nothing absolute, no missing file.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn places_join_and_contain_paths_as_their_system_does() {
        let wsl = Place::Wsl("Ubuntu".into());
        assert_eq!(wsl.join("/home/a/w/1", "app/"), "/home/a/w/1/app");
        assert_eq!(wsl.join("/home/a/w/1", ""), "/home/a/w/1");
        assert!(wsl.inside("/home/a/w/1/app", "/home/a/w/1"));
        assert!(!wsl.inside("/home/a/w/10", "/home/a/w/1"));
        assert!(Place::Here.inside(&Place::Here.join("/data/w/1", "src/app"), "/data/w/1"));
        assert!(!Place::Here.inside("/data/w/12", "/data/w/1"));
        assert_eq!(
            parse_changes(b"M\0a.txt\0A\0b c.txt\0D\0d.txt\0T\0e\0"),
            [
                Change {
                    path: "a.txt".into(),
                    status: "modified".into()
                },
                Change {
                    path: "b c.txt".into(),
                    status: "added".into()
                },
                Change {
                    path: "d.txt".into(),
                    status: "deleted".into()
                },
                Change {
                    path: "e".into(),
                    status: "changed".into()
                },
            ]
        );
        assert_eq!(
            git_error(
                b"hint: x\nerror: patch failed: a.txt:1\nerror: a.txt: patch does not apply\n"
            ),
            "Git: patch failed: a.txt:1; a.txt: patch does not apply"
        );
        assert_eq!(git_error(b""), "Git failed.");
    }
}
