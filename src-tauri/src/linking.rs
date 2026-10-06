//! A separate Claude profile that shares this computer's CLI context links everything but its
//! account to that context's directory (`~/.claude`), so Agent Studio, the Claude app and the
//! terminal use the same settings, instructions, memories, transcripts, checkpoints, plugins,
//! skills, agents and commands. The profile keeps only what belongs to its account: its login
//! and MCP sign-ins (`.credentials.json`), its account state and MCP definitions
//! (`.claude.json`), organization policy and runtime state.
//!
//! Linking a profile that already holds such files moves them into the shared directory first,
//! never replacing anything there: an identical copy is dropped, and a copy that differs stays in
//! the profile's `before-sharing` folder. Profiles in a WSL distribution are linked inside Linux
//! by the launch script (`wsl-share.sh`) with the same rules.
use std::{
    collections::HashMap,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

/// Files the profile shares with the directory.
pub const SHARED_FILES: [&str; 2] = ["settings.json", "CLAUDE.md"];
/// Folders the profile shares with the directory.
pub const SHARED_DIRS: [&str; 11] = [
    "projects",
    "file-history",
    "tasks",
    "plans",
    "todos",
    "plugins",
    "skills",
    "agents",
    "commands",
    "output-styles",
    "rules",
];
/// Where copies that differ from the shared directory's are kept, inside the profile.
pub const SET_ASIDE: &str = "before-sharing";
/// Windows creates symbolic links only with Developer Mode on, or as an administrator.
pub const NEEDS_DEVELOPER_MODE: &str = "Turn on Developer Mode (Windows Settings → System → For developers), then restart Agent Studio, so this account shares settings, memories, chats and plugins with the Claude app. Until then it keeps its own.";
/// Files move into the shared directory only before any CLI of the app's run uses them.
pub const NEEDS_RESTART: &str = "Restart Agent Studio to share this account's settings, memories, chats and plugins with the Claude app. Until then it keeps its own.";

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Linked,
    /// Linking was not possible; the profile keeps its own files and shares context the older
    /// way. The text says why.
    Unlinked(String),
}

/// Whether every shared item of `root` is a link to the same item of `source`.
pub fn linked(root: &Path, source: &Path) -> bool {
    SHARED_FILES
        .iter()
        .chain(SHARED_DIRS.iter())
        .all(|name| points_to(&root.join(name), &source.join(name)))
}

fn points_to(link: &Path, target: &Path) -> bool {
    std::fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink())
        && std::fs::read_link(link).is_ok_and(|t| same_path(&t, target))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| {
        if cfg!(windows) {
            let text = p.to_string_lossy().replace('/', "\\");
            let text = text.strip_prefix("\\\\?\\").unwrap_or(&text).to_string();
            text.trim_end_matches('\\').to_lowercase()
        } else {
            p.to_string_lossy().trim_end_matches('/').to_string()
        }
    };
    normal(a) == normal(b)
}

/// Whether the profile still holds something of its own where a shared item belongs: a file, or
/// a folder with anything in it.
fn holds_content(root: &Path) -> bool {
    SHARED_FILES.iter().chain(SHARED_DIRS.iter()).any(|name| {
        let path = root.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => false,
            Ok(meta) if meta.is_dir() => {
                std::fs::read_dir(&path).is_ok_and(|mut entries| entries.next().is_some())
            }
            Ok(_) => true,
            Err(_) => false,
        }
    })
}

type Tracked = (Arc<tokio::sync::Mutex<()>>, Option<State>);
fn tracked() -> &'static Mutex<HashMap<PathBuf, Tracked>> {
    static TRACKED: OnceLock<Mutex<HashMap<PathBuf, Tracked>>> = OnceLock::new();
    TRACKED.get_or_init(Default::default)
}

/// Links the profile at `root` to `source` and reports the result. The first attempt in each run
/// of the app comes before any CLI of that run uses the profile, so only that attempt moves files
/// into the shared directory: a CLI could lose sight of a transcript moved from under it. Later
/// attempts link a profile only while it holds nothing to move.
pub async fn ensure(root: PathBuf, source: PathBuf) -> State {
    let lock = tracked()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(root.clone())
        .or_insert_with(|| (Arc::new(tokio::sync::Mutex::new(())), None))
        .0
        .clone();
    let _guard = lock.lock().await;
    let tried = tracked()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&root)
        .and_then(|(_, state)| state.clone());
    let state = {
        let (root, source) = (root.clone(), source.clone());
        // One migration at a time across profiles: two may move folders into the same place.
        static MIGRATING: OnceLock<Mutex<()>> = OnceLock::new();
        tauri::async_runtime::spawn_blocking(move || {
            if linked(&root, &source) {
                return State::Linked;
            }
            if let Some(tried) = tried.filter(|_| holds_content(&root)) {
                return State::Unlinked(match tried {
                    State::Unlinked(reason)
                        if reason != NEEDS_DEVELOPER_MODE || probe(&root).is_err() =>
                    {
                        reason
                    }
                    _ => NEEDS_RESTART.into(),
                });
            }
            let _one = MIGRATING
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            match link(&root, &source) {
                Ok(()) => State::Linked,
                Err(error) => State::Unlinked(error),
            }
        })
        .await
        .unwrap_or_else(|_| State::Unlinked("Could not share this account's files".into()))
    };
    if let Some(entry) = tracked()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(&root)
    {
        entry.1 = Some(state.clone());
    }
    state
}

/// Links the current profile before its CLI starts, when it shares this computer's Claude
/// directory. A profile in a WSL distribution is linked inside Linux by its launch instead.
pub async fn prepare() {
    let profile = crate::profiles::current();
    if !profile.shares_directory() || profile.distribution.is_some() {
        return;
    }
    let (Some(root), Some(source)) = (
        profile.root.clone(),
        crate::context::native_default_root("claude"),
    ) else {
        return;
    };
    ensure(root, source).await;
}

/// The last result for a profile in this app run, if it was linked or tried.
pub fn last(root: &Path) -> Option<State> {
    tracked()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(root)
        .and_then(|(_, state)| state.clone())
}

/// Links each shared item of the profile at `root` to the same item of `source`, moving what the
/// profile kept there before into `source` first.
pub fn link(root: &Path, source: &Path) -> Result<(), String> {
    if same_path(root, source) || source.starts_with(root) || root.starts_with(source) {
        return Err("This account's profile cannot share its own directory".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot prepare this account's profile")?;
    std::fs::create_dir_all(source).map_err(|_| "Cannot prepare the shared Claude directory")?;
    probe(root)?;
    for (name, dir) in SHARED_DIRS
        .iter()
        .map(|n| (*n, true))
        .chain(SHARED_FILES.iter().map(|n| (*n, false)))
    {
        link_one(root, source, name, dir).map_err(|error| {
            format!("Could not share {name} with the Claude app's directory: {error}")
        })?;
    }
    Ok(())
}

/// Creating a link here must be allowed before anything moves.
fn probe(root: &Path) -> Result<(), String> {
    let probe = root.join(".agent-studio-link-probe");
    let _ = remove_link(&probe);
    match make_link(&root.join(SHARED_FILES[0]), &probe, false) {
        Ok(()) => {
            let _ = remove_link(&probe);
            Ok(())
        }
        Err(error) if cfg!(windows) && error.raw_os_error() == Some(1314) => {
            Err(NEEDS_DEVELOPER_MODE.into())
        }
        Err(_) => Err("Cannot create links in this account's profile".into()),
    }
}

fn link_one(root: &Path, source: &Path, name: &str, dir: bool) -> io::Result<()> {
    let entry = root.join(name);
    let target = source.join(name);
    if dir {
        std::fs::create_dir_all(&target)?;
    }
    match std::fs::symlink_metadata(&entry) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(meta) if meta.file_type().is_symlink() => {
            if points_to(&entry, &target) {
                return Ok(());
            }
            // A link to another directory, such as an earlier source.
            remove_link(&entry)?;
        }
        Ok(_) => adopt(&entry, &target, &root.join(SET_ASIDE).join(name))?,
    }
    make_link(&target, &entry, dir)
}

/// Moves `from` to `to` without replacing anything at `to`: a folder merges into an existing
/// one, an identical file is dropped, and anything else that differs moves to `aside`.
pub fn adopt(from: &Path, to: &Path, aside: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_dir() {
        if std::fs::symlink_metadata(to).is_err() {
            match std::fs::rename(from, to) {
                Ok(()) => return Ok(()),
                // Another drive, permissions or a busy file: stop rather than hide the folder.
                Err(error) if std::fs::symlink_metadata(to).is_err() => return Err(error),
                // Created meanwhile: merge into it below.
                Err(_) => {}
            }
        }
        if std::fs::symlink_metadata(to).is_ok_and(|m| m.is_dir()) {
            for child in std::fs::read_dir(from)? {
                let child = child?;
                let name = child.file_name();
                adopt(&child.path(), &to.join(&name), &aside.join(&name))?;
            }
            return std::fs::remove_dir(from);
        }
        return set_aside(from, aside);
    }
    match move_file(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !meta.file_type().is_symlink() && same_content(from, to)? {
                std::fs::remove_file(from)
            } else {
                set_aside(from, aside)
            }
        }
        Err(error) => Err(error),
    }
}

/// Moves a file to a path that must not exist yet. A hard link fails when it does, so nothing
/// is ever replaced, even if another program creates the file meanwhile.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    let is_link = std::fs::symlink_metadata(from)?.file_type().is_symlink();
    if !is_link && std::fs::hard_link(from, to).is_ok() {
        return std::fs::remove_file(from);
    }
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    std::fs::rename(from, to)
}

fn set_aside(from: &Path, aside: &Path) -> io::Result<()> {
    if let Some(parent) = aside.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut target = aside.to_path_buf();
    let mut n = 0;
    while std::fs::symlink_metadata(&target).is_ok() {
        n += 1;
        let mut name = aside.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{n}"));
        target = aside.with_file_name(name);
    }
    std::fs::rename(from, target)
}

fn same_content(a: &Path, b: &Path) -> io::Result<bool> {
    let (ma, mb) = (std::fs::metadata(a)?, std::fs::metadata(b)?);
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return Ok(false);
    }
    let (mut fa, mut fb) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let read = fa.read(&mut ba)?;
        if read == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut bb[..read])?;
        if ba[..read] != bb[..read] {
            return Ok(false);
        }
    }
}

fn make_link(target: &Path, link: &Path, dir: bool) -> io::Result<()> {
    #[cfg(windows)]
    {
        if dir {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
    #[cfg(unix)]
    {
        let _ = dir;
        std::os::unix::fs::symlink(target, link)
    }
}

fn remove_link(link: &Path) -> io::Result<()> {
    // Windows removes a folder link as a folder and a file link as a file.
    std::fs::remove_file(link).or_else(|error| {
        if std::fs::symlink_metadata(link).is_err() {
            Err(error)
        } else {
            std::fs::remove_dir(link)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Links need Developer Mode or administrator rights on Windows; tests that create them say
    /// so instead of failing on a computer without them.
    fn links_allowed(dir: &Path) -> bool {
        let probe = dir.join("probe");
        let allowed = make_link(&dir.join("missing"), &probe, false).is_ok();
        let _ = remove_link(&probe);
        if !allowed {
            eprintln!("skipped: this computer does not allow symbolic links");
        }
        allowed
    }

    #[test]
    fn adopting_moves_new_items_merges_folders_and_never_replaces_anything() {
        let dir = tempfile::tempdir().unwrap();
        let (profile, shared, aside) = (
            dir.path().join("profile/projects"),
            dir.path().join("shared/projects"),
            dir.path().join("profile/before-sharing/projects"),
        );
        std::fs::create_dir_all(profile.join("k/memory")).unwrap();
        std::fs::create_dir_all(shared.join("k/memory")).unwrap();
        std::fs::create_dir_all(profile.join("only-here")).unwrap();
        std::fs::write(profile.join("only-here/a.jsonl"), "a").unwrap();
        std::fs::write(profile.join("k/b.jsonl"), "b").unwrap();
        std::fs::write(profile.join("k/memory/MEMORY.md"), "profile memory").unwrap();
        std::fs::write(shared.join("k/memory/MEMORY.md"), "shared memory").unwrap();
        std::fs::write(profile.join("k/memory/same.md"), "same").unwrap();
        std::fs::write(shared.join("k/memory/same.md"), "same").unwrap();
        adopt(&profile, &shared, &aside).unwrap();
        assert!(!profile.exists());
        let read = |p: PathBuf| std::fs::read_to_string(p).unwrap();
        assert_eq!(read(shared.join("only-here/a.jsonl")), "a");
        assert_eq!(read(shared.join("k/b.jsonl")), "b");
        assert_eq!(read(shared.join("k/memory/same.md")), "same");
        // The shared copy stays; the profile's different one is kept aside.
        assert_eq!(read(shared.join("k/memory/MEMORY.md")), "shared memory");
        assert_eq!(read(aside.join("k/memory/MEMORY.md")), "profile memory");
        assert!(!aside.join("k/memory/same.md").exists());
        // A second copy kept aside does not replace the first.
        std::fs::create_dir_all(profile.join("k/memory")).unwrap();
        std::fs::write(profile.join("k/memory/MEMORY.md"), "second").unwrap();
        adopt(&profile, &shared, &aside).unwrap();
        assert_eq!(read(aside.join("k/memory/MEMORY.md")), "profile memory");
        assert_eq!(read(aside.join("k/memory/MEMORY.md.1")), "second");
    }

    #[test]
    fn a_file_never_replaces_one_already_shared() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to, aside) = (
            dir.path().join("settings.json"),
            dir.path().join("shared/settings.json"),
            dir.path().join("before-sharing/settings.json"),
        );
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::write(&from, "{\"profile\":true}").unwrap();
        std::fs::write(&to, "{\"shared\":true}").unwrap();
        adopt(&from, &to, &aside).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "{\"shared\":true}");
        assert_eq!(
            std::fs::read_to_string(&aside).unwrap(),
            "{\"profile\":true}"
        );
        // Without a shared copy, the profile's becomes the shared one.
        std::fs::write(&from, "{\"only\":true}").unwrap();
        let fresh = dir.path().join("shared/CLAUDE.md");
        adopt(&from, &fresh, &aside).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "{\"only\":true}");
        assert!(!from.exists());
    }

    #[test]
    fn linking_shares_every_item_but_the_account_and_is_repeatable() {
        let dir = tempfile::tempdir().unwrap();
        if !links_allowed(dir.path()) {
            return;
        }
        let (root, source) = (dir.path().join("profile"), dir.path().join("claude"));
        std::fs::create_dir_all(root.join("projects/k")).unwrap();
        std::fs::create_dir_all(source.join("skills/blender")).unwrap();
        std::fs::write(root.join("projects/k/s.jsonl"), "transcript").unwrap();
        std::fs::write(root.join(".credentials.json"), "login").unwrap();
        std::fs::write(root.join(".claude.json"), "{}").unwrap();
        std::fs::write(source.join("settings.json"), "{\"cleanupPeriodDays\":365}").unwrap();
        assert!(!linked(&root, &source));
        link(&root, &source).unwrap();
        assert!(linked(&root, &source));
        // The profile's transcript moved into the shared directory and reads through the link.
        assert_eq!(
            std::fs::read_to_string(source.join("projects/k/s.jsonl")).unwrap(),
            "transcript"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("projects/k/s.jsonl")).unwrap(),
            "transcript"
        );
        assert!(root.join("skills/blender").is_dir());
        assert_eq!(
            std::fs::read_to_string(root.join("settings.json")).unwrap(),
            "{\"cleanupPeriodDays\":365}"
        );
        // The account's own files stay in the profile.
        for own in [".credentials.json", ".claude.json"] {
            assert!(!std::fs::symlink_metadata(root.join(own))
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!source.join(own).exists());
        }
        // Writing through a link writes the shared file.
        std::fs::write(root.join("CLAUDE.md"), "shared instructions").unwrap();
        assert_eq!(
            std::fs::read_to_string(source.join("CLAUDE.md")).unwrap(),
            "shared instructions"
        );
        link(&root, &source).unwrap();
        assert!(linked(&root, &source));
        // A link left pointing elsewhere is pointed back.
        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join("agents")).unwrap();
        remove_link(&root.join("agents")).unwrap();
        make_link(&other.join("agents"), &root.join("agents"), true).unwrap();
        assert!(!linked(&root, &source));
        link(&root, &source).unwrap();
        assert!(linked(&root, &source));
    }

    #[tokio::test]
    async fn only_the_first_attempt_of_a_run_moves_files() {
        let dir = tempfile::tempdir().unwrap();
        let (root, source) = (dir.path().join("profile"), dir.path().join("claude"));
        std::fs::create_dir_all(root.join("projects/k")).unwrap();
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::write(root.join("projects/k/s.jsonl"), "transcript").unwrap();
        assert!(holds_content(&root));
        // An earlier attempt in this run failed, and a CLI may have used the profile since: its
        // transcript stays where that CLI looks for it.
        tracked().lock().unwrap().insert(
            root.clone(),
            (Default::default(), Some(State::Unlinked("busy".into()))),
        );
        assert_eq!(
            ensure(root.clone(), source.clone()).await,
            State::Unlinked("busy".into())
        );
        assert!(root.join("projects/k/s.jsonl").is_file());
        assert!(!source.join("projects").exists());
        // With nothing of its own left (an empty folder holds nothing), it links at any time.
        std::fs::remove_dir_all(root.join("projects")).unwrap();
        assert!(!holds_content(&root));
        let state = ensure(root.clone(), source.clone()).await;
        if links_allowed(dir.path()) {
            assert_eq!(state, State::Linked);
            assert!(linked(&root, &source));
            assert!(!holds_content(&root));
        } else {
            assert_eq!(state, State::Unlinked(NEEDS_DEVELOPER_MODE.into()));
        }
    }

    #[test]
    fn a_profile_never_shares_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(link(dir.path(), dir.path()).is_err());
        assert!(link(&dir.path().join("profile"), dir.path()).is_err());
        assert!(link(dir.path(), &dir.path().join("inside")).is_err());
    }
}
