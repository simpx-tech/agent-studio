//! Merge trains (requested 2026-11-27, after five chats each ran a whole pipeline again under a
//! repository's landing turn, since every push moved the main branch under the next chat): a chat
//! whose branch passed its own pipeline queues it with `pc_land`, and the broker runs the
//! repository's own train script on the cars queued, which merges them onto the main branch as one
//! candidate, runs one pipeline and pushes once, leaving out a car that conflicts or breaks it.
//!
//! A repository says how in `.agent-studio/train.json` in its main checkout:
//! `{"branch": "main", "command": ["powershell.exe", "-File", "Tools/Land-Train.ps1"], "maxCars": 4}`.
//! The command runs in the main checkout with `AGENT_STUDIO_TRAIN_CARS` (the path of a JSON file
//! of the cars, earliest first), `AGENT_STUDIO_TRAIN_RESULT` (where it writes what became of each:
//! `{"landed": [ids], "sha": …, "ejected": [{"id", "reason", "log"}], "requeue": [ids], "note": …}`),
//! `AGENT_STUDIO_TRAIN_DIR` (a folder for its logs) and the train's memory grant
//! (`AGENT_STUDIO_PC_GRANT`), in a job of its own, so that the broker counts its builds and runs
//! as a chat's. It exits 0 once it wrote its result, and otherwise its cars wait for the next
//! train. A train holds the repository's landing turn while it runs: a chat that lands by hand
//! waits for it, and a train for that chat.
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Where a repository's main checkout says how its train runs.
pub const CONFIG: &str = ".agent-studio/train.json";
pub const CARS_ENV: &str = "AGENT_STUDIO_TRAIN_CARS";
pub const RESULT_ENV: &str = "AGENT_STUDIO_TRAIN_RESULT";
pub const DIR_ENV: &str = "AGENT_STUDIO_TRAIN_DIR";
/// How the id a repository's trains go by in place of a chat's begins: `train:` and the
/// repository, as `named::key` writes it.
pub const PREFIX: &str = "train:";
/// The longest a train runs before it is stopped and its cars wait for the next.
pub const LONGEST: Duration = Duration::from_secs(3 * 60 * 60);
/// How many trains of a repository may fail in a row before the cars they carried are given back
/// to their chats to land by hand.
pub const FAILURES: u32 = 2;

/// How a repository's trains run, from its `.agent-studio/train.json`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The branch its trains land on.
    #[serde(default = "main_branch")]
    pub branch: String,
    /// The program and its arguments, run in the main checkout.
    pub command: Vec<String>,
    /// The most cars one train carries.
    #[serde(default = "most_cars")]
    pub max_cars: usize,
}
fn main_branch() -> String {
    "main".into()
}
fn most_cars() -> usize {
    4
}

/// The train of the repository whose main checkout is `main`.
pub fn config(main: &Path) -> Result<Config, String> {
    let path = main.join(CONFIG);
    let text = std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "This repository has no merge train ({CONFIG} in its main checkout, {}): land with pc_reserve and landing: true.",
            main.display()
        )
    })?;
    let config: Config = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("{} does not say how a train runs: {error}", path.display()))?;
    if config
        .command
        .first()
        .is_none_or(|program| program.trim().is_empty())
    {
        return Err(format!("{} names no command.", path.display()));
    }
    Ok(Config {
        max_cars: config.max_cars.clamp(1, 32),
        ..config
    })
}

/// A chat's branch queued to land.
#[derive(Clone, Debug)]
pub struct Car {
    pub id: String,
    pub conversation: String,
    pub title: String,
    pub purpose: String,
    /// The checkout the chat works in, a worktree of the repository.
    pub worktree: PathBuf,
    pub branch: String,
    /// The commit it lands: the branch's head when the chat queued it.
    pub sha: String,
    pub queued: Instant,
    pub queued_at: u64,
}

/// A repository's line of cars, with the train it runs now.
pub struct Line {
    /// The repository, as one name for all its checkouts (`named::repository`).
    pub repository: String,
    pub main: PathBuf,
    pub config: Config,
    /// Cars waiting for a train, earliest first.
    pub waiting: Vec<Car>,
    /// Its turn at the repository's landing (`Turn::id`), asked for once cars wait.
    pub turn: Option<String>,
    pub running: Option<Running>,
    /// Trains in a row that failed.
    pub failures: u32,
}

/// A train on its way.
pub struct Running {
    pub id: String,
    pub cars: Vec<Car>,
    pub started: Instant,
    pub started_at: u64,
    pub dir: PathBuf,
}

/// A train that landed something, for chats to hear what moved the main branch.
#[derive(Clone, Debug)]
pub struct Landing {
    pub repository: String,
    pub sha: Option<String>,
    pub at: Instant,
    /// What it landed: each car's chat and purpose.
    pub cars: Vec<(String, String)>,
}

/// What a train's script reports.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Outcome {
    pub landed: Vec<String>,
    /// The main branch's commit after its push, when it pushed.
    pub sha: Option<String>,
    pub ejected: Vec<Ejected>,
    pub requeue: Vec<String>,
    pub note: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Ejected {
    pub id: String,
    pub reason: String,
    pub log: Option<String>,
}

/// One train for its runner to run.
#[derive(Clone, Debug)]
pub struct Ride {
    pub id: String,
    /// The id its repository's trains go by (`PREFIX`), whose job its processes join.
    pub conversation: String,
    pub repository: String,
    pub main: PathBuf,
    pub config: Config,
    pub cars: Vec<Car>,
    /// Its own folder, for its cars, its result and its logs.
    pub dir: PathBuf,
    /// What its command finds in its environment besides the train's own: its grant.
    pub env: Vec<(String, String)>,
}

/// Runs a train (tests give their own): what it reports, or why it reported nothing.
pub type Runner = std::sync::Arc<
    dyn Fn(Ride) -> futures_util::future::BoxFuture<'static, Result<Outcome, String>> + Send + Sync,
>;

/// The cars a train's command reads (`CARS_ENV`).
pub fn cars_json(ride: &Ride) -> Value {
    json!({
        "train": ride.id,
        "repository": ride.repository,
        "branch": ride.config.branch,
        "cars": ride.cars.iter().map(|car| json!({
            "id": car.id,
            "chat": car.conversation,
            "title": car.title,
            "purpose": car.purpose,
            "worktree": car.worktree.to_string_lossy(),
            "branch": car.branch,
            "sha": car.sha,
        })).collect::<Vec<_>>(),
    })
}

/// Runs `ride` on this computer: writes its cars, starts its command in the main checkout with the
/// train's environment, lets `adopt` put its process in the train's job, keeps what it prints in
/// `train.log` in its folder, waits for it (at most `LONGEST`) and reads its result.
pub async fn run(
    ride: Ride,
    adopt: impl FnOnce(&tokio::process::Child),
) -> Result<Outcome, String> {
    let folder = |error: std::io::Error| {
        format!(
            "Cannot write the train's folder {}: {error}",
            ride.dir.display()
        )
    };
    std::fs::create_dir_all(&ride.dir).map_err(folder)?;
    let (cars, result, log) = (
        ride.dir.join("cars.json"),
        ride.dir.join("result.json"),
        ride.dir.join("train.log"),
    );
    let _ = std::fs::remove_file(&result);
    std::fs::write(
        &cars,
        serde_json::to_vec_pretty(&cars_json(&ride)).unwrap_or_default(),
    )
    .map_err(folder)?;
    let out = std::fs::File::create(&log).map_err(folder)?;
    let err = out.try_clone().map_err(folder)?;
    let mut command = tokio::process::Command::new(&ride.config.command[0]);
    command
        .args(&ride.config.command[1..])
        .current_dir(&ride.main)
        .env(CARS_ENV, &cars)
        .env(RESULT_ENV, &result)
        .env(DIR_ENV, &ride.dir)
        .envs(ride.env.iter().map(|(name, value)| (name, value)))
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .kill_on_drop(true);
    // No console window of its own.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "The train's command ({}) did not start: {error}",
            ride.config.command.join(" ")
        )
    })?;
    adopt(&child);
    let status = match tokio::time::timeout(LONGEST, child.wait()).await {
        Ok(status) => status.map_err(|error| format!("The train's command was lost: {error}"))?,
        Err(_) => {
            crate::runner::kill_tree(&mut child).await;
            return Err(format!(
                "The train ran {} and was stopped. Its log: {}",
                super::duration(LONGEST),
                log.display()
            ));
        }
    };
    if !status.success() {
        return Err(format!(
            "The train's command ended with {status}. Its log: {}",
            log.display()
        ));
    }
    let text = std::fs::read_to_string(&result).map_err(|_| {
        format!(
            "The train's command wrote no result to {}. Its log: {}",
            result.display(),
            log.display()
        )
    })?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|error| {
        format!(
            "The train's result is not one ({error}). Its log: {}",
            log.display()
        )
    })
}

/// A commit as text: its first ten characters.
pub fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_says_how_its_train_runs() {
        let main = tempfile::tempdir().unwrap();
        let refused = config(main.path()).unwrap_err();
        assert!(refused.contains("has no merge train"), "{refused}");
        std::fs::create_dir_all(main.path().join(".agent-studio")).unwrap();
        std::fs::write(
            main.path().join(CONFIG),
            "\u{feff}{\"command\":[\"powershell.exe\",\"-File\",\"Tools/Land-Train.ps1\"],\"maxCars\":99}",
        )
        .unwrap();
        let read = config(main.path()).unwrap();
        assert_eq!(read.branch, "main");
        assert_eq!(read.command[2], "Tools/Land-Train.ps1");
        assert_eq!(read.max_cars, 32);
        std::fs::write(main.path().join(CONFIG), "{\"command\":[]}").unwrap();
        assert!(config(main.path())
            .unwrap_err()
            .contains("names no command"));
    }

    #[test]
    fn an_outcome_reads_whatever_its_script_left_out_as_empty() {
        let outcome: Outcome = serde_json::from_str(
            r#"{"landed":["car-1"],"sha":null,"ejected":[{"id":"car-2","reason":"conflict in a.txt"}]}"#,
        )
        .unwrap();
        assert_eq!(outcome.landed, ["car-1"]);
        assert_eq!(outcome.sha, None);
        assert_eq!(outcome.ejected[0].log, None);
        assert!(outcome.requeue.is_empty() && outcome.note.is_none());
    }

    fn ride(dir: &Path, command: Vec<String>) -> Ride {
        Ride {
            id: "train-1".into(),
            conversation: format!("{PREFIX}example.com/game"),
            repository: "example.com/game".into(),
            main: dir.to_path_buf(),
            config: Config {
                branch: "main".into(),
                command,
                max_cars: 4,
            },
            cars: vec![Car {
                id: "car-1".into(),
                conversation: "chat-a".into(),
                title: "Rivers".into(),
                purpose: "Fed rivers".into(),
                worktree: dir.join("wt"),
                branch: "worktree-rivers".into(),
                sha: "a".repeat(40),
                queued: Instant::now(),
                queued_at: 1,
            }],
            dir: dir.join("trains").join("train-1"),
            env: vec![("AGENT_STUDIO_PC_GRANT".into(), "grant.json".into())],
        }
    }

    /// A script in `dir` that runs `windows` under cmd.exe or `unix` under sh, as a command.
    fn script(dir: &Path, windows: &str, unix: &str) -> Vec<String> {
        if cfg!(windows) {
            let path = dir.join("train.cmd");
            std::fs::write(&path, format!("@echo off\r\n{windows}\r\n")).unwrap();
            vec!["cmd.exe".into(), "/C".into(), path.to_string_lossy().into()]
        } else {
            let path = dir.join("train.sh");
            std::fs::write(&path, format!("{unix}\n")).unwrap();
            vec!["sh".into(), path.to_string_lossy().into()]
        }
    }

    #[tokio::test]
    async fn a_train_runs_its_command_in_the_main_checkout_and_reads_its_result() {
        let main = tempfile::tempdir().unwrap();
        // Copies its cars beside its result, then lands the first car, naming its grant.
        let command = script(
            main.path(),
            "copy \"%AGENT_STUDIO_TRAIN_CARS%\" \"%AGENT_STUDIO_TRAIN_DIR%\\seen.json\" >NUL\r\necho {\"landed\":[\"car-1\"],\"sha\":\"%AGENT_STUDIO_PC_GRANT%\"}> \"%AGENT_STUDIO_TRAIN_RESULT%\"",
            "cp \"$AGENT_STUDIO_TRAIN_CARS\" \"$AGENT_STUDIO_TRAIN_DIR/seen.json\"\nprintf '{\"landed\":[\"car-1\"],\"sha\":\"%s\"}' \"$AGENT_STUDIO_PC_GRANT\" > \"$AGENT_STUDIO_TRAIN_RESULT\"",
        );
        let ride = ride(main.path(), command);
        let dir = ride.dir.clone();
        let mut adopted = false;
        let outcome = run(ride, |_| adopted = true).await.unwrap();
        assert!(adopted);
        assert_eq!(outcome.landed, ["car-1"]);
        assert_eq!(outcome.sha.as_deref(), Some("grant.json"));
        let seen: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("seen.json")).unwrap()).unwrap();
        assert_eq!(seen["train"], "train-1");
        assert_eq!(seen["cars"][0]["branch"], "worktree-rivers");
        assert_eq!(seen["cars"][0]["sha"], "a".repeat(40));
    }

    #[tokio::test]
    async fn a_train_that_fails_or_writes_nothing_says_where_its_log_is() {
        let main = tempfile::tempdir().unwrap();
        let fails = script(main.path(), "exit 3", "exit 3");
        let failed = run(ride(main.path(), fails), |_| {}).await.unwrap_err();
        assert!(
            failed.contains("ended with") && failed.contains("train.log"),
            "{failed}"
        );
        let silent = script(main.path(), "echo nothing", "echo nothing");
        let silent = run(ride(main.path(), silent), |_| {}).await.unwrap_err();
        assert!(silent.contains("wrote no result"), "{silent}");
        let missing = run(
            ride(main.path(), vec!["no-such-program-of-a-train".into()]),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(missing.contains("did not start"), "{missing}");
    }
}
