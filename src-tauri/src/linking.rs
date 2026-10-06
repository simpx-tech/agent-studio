//! A separate Claude profile that shares this computer's CLI context links everything but its
//! account to that context's directory (`~/.claude`), so Agent Studio, the Claude app and the
//! terminal use the same settings, instructions, memories, transcripts, checkpoints, plugins,
//! skills, agents and commands. The profile keeps only what belongs to its account: its login
//! and MCP sign-ins (`.credentials.json`), its account state and MCP definitions
//! (`.claude.json`), organization policy and runtime state.
//!
//! Folders are linked as directory junctions on Windows, which need no permission, and as
//! symbolic links elsewhere. The two files need symbolic links, which Windows creates only with
//! Developer Mode on or for an administrator: Agent Studio asks Windows once to run this program
//! elevated for that (`request_permission`, `elevated_main`), for every account that needs it,
//! while Agent Studio itself keeps running as the user. Declined, those two files stay the
//! account's own.
//!
//! Linking a profile that already holds such files moves them into the shared directory first,
//! never replacing anything there: an identical copy is dropped, and a copy that differs stays in
//! the profile's `before-sharing` folder. Profiles in a WSL distribution are linked inside Linux
//! by the launch script (`wsl-share.sh`) with the same rules.
use std::{
    collections::HashMap,
    future::Future,
    io::{self, Read},
    path::{Path, PathBuf},
    pin::Pin,
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
/// Shown while Windows has not allowed the two file links yet.
pub const NEEDS_PERMISSION: &str = "Windows asks once before this account shares settings.json and CLAUDE.md with the Claude app; until then those two stay its own. Its chats, memories, plugins, skills and other folders are shared already.";
/// Files move into the shared directory only before any CLI of the app's run uses them.
pub const NEEDS_RESTART: &str = "Restart Agent Studio to share this account's chats, memories and plugins with the Claude app. Until then it keeps its own.";
/// The argument that starts this program as the elevated helper linking the two shared files.
pub const ELEVATED: &str = "--share-claude-files";

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    /// Every shared item is linked.
    Linked,
    /// The folders are linked; the two files wait for Windows to allow their links.
    NeedsPermission,
    /// Linking was not possible; the profile keeps its own files and shares context the older
    /// way. The text says why.
    Unlinked(String),
}

/// Whether every shared folder of `root` is a link to the same folder of `source`.
pub fn folders_linked(root: &Path, source: &Path) -> bool {
    SHARED_DIRS
        .iter()
        .all(|name| points_to(&root.join(name), &source.join(name)))
}

/// Whether both shared files of `root` are links to the same files of `source`.
pub fn files_linked(root: &Path, source: &Path) -> bool {
    SHARED_FILES
        .iter()
        .all(|name| points_to(&root.join(name), &source.join(name)))
}

/// Whether every shared item of `root` is a link to the same item of `source`.
pub fn linked(root: &Path, source: &Path) -> bool {
    folders_linked(root, source) && files_linked(root, source)
}

// A junction counts as a link: Windows marks both as name surrogates.
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

/// Whether a shared folder of the profile still holds something of its own.
fn folders_hold_content(root: &Path) -> bool {
    SHARED_DIRS.iter().any(|name| {
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
/// of the app comes before any CLI of that run uses the profile, so only that attempt moves
/// folders' contents into the shared directory: a CLI could lose sight of a transcript moved from
/// under it. Later attempts link folders only while the profile holds nothing to move.
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
            if !folders_linked(&root, &source) {
                if let Some(tried) = tried.filter(|_| folders_hold_content(&root)) {
                    return State::Unlinked(match tried {
                        State::Unlinked(reason) => reason,
                        _ => NEEDS_RESTART.into(),
                    });
                }
                let _one = MIGRATING
                    .get_or_init(Default::default)
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Err(error) = link_folders(&root, &source) {
                    return State::Unlinked(error);
                }
            }
            match link_files(&root, &source) {
                Ok(true) => State::Linked,
                Ok(false) => State::NeedsPermission,
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

type Ask = Box<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
static ASK: OnceLock<Ask> = OnceLock::new();
/// What asks Windows' permission for the two file links when a profile needs it: the app
/// registers it at startup, for every account at once.
pub fn on_permission_needed(ask: Ask) {
    let _ = ASK.set(ask);
}

/// Links the current profile before its CLI starts, when it shares this computer's Claude
/// directory, asking Windows' permission for the two file links the first time they need it. A
/// profile in a WSL distribution is linked inside Linux by its launch instead.
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
    if ensure(root.clone(), source.clone()).await == State::NeedsPermission {
        if let Some(ask) = ASK.get() {
            ask().await;
            // What Windows allowed is this run's state from now on.
            ensure(root, source).await;
        }
    }
}

/// The last result for a profile in this app run, if it was linked or tried.
pub fn last(root: &Path) -> Option<State> {
    tracked()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(root)
        .and_then(|(_, state)| state.clone())
}

fn check_paths(root: &Path, source: &Path) -> Result<(), String> {
    if same_path(root, source) || source.starts_with(root) || root.starts_with(source) {
        return Err("This account's profile cannot share its own directory".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot prepare this account's profile")?;
    std::fs::create_dir_all(source).map_err(|_| "Cannot prepare the shared Claude directory")?;
    Ok(())
}

/// Links each shared folder of the profile at `root` to the same folder of `source`, moving what
/// the profile kept there before into `source` first.
pub fn link_folders(root: &Path, source: &Path) -> Result<(), String> {
    check_paths(root, source)?;
    for name in SHARED_DIRS {
        link_one(root, source, name, true).map_err(|error| {
            format!("Could not share {name} with the Claude app's directory: {error}")
        })?;
    }
    Ok(())
}

/// Links both shared files, or reports `false` when this process may not create file links
/// here, before anything moves.
fn link_files(root: &Path, source: &Path) -> Result<bool, String> {
    if files_linked(root, source) {
        return Ok(true);
    }
    check_paths(root, source)?;
    let probe = root.join(".agent-studio-link-probe");
    let _ = remove_link(&probe);
    match make_link(&root.join(SHARED_FILES[0]), &probe, false) {
        Ok(()) => {
            let _ = remove_link(&probe);
        }
        Err(error) if cfg!(windows) && error.raw_os_error() == Some(1314) => return Ok(false),
        Err(_) => return Err("Cannot create links in this account's profile".into()),
    }
    for name in SHARED_FILES {
        link_one(root, source, name, false).map_err(|error| {
            format!("Could not share {name} with the Claude app's directory: {error}")
        })?;
    }
    Ok(true)
}

/// Links every shared item of the profile at `root` to the same item of `source`.
#[cfg(test)]
fn link(root: &Path, source: &Path) -> Result<(), String> {
    link_folders(root, source)?;
    if link_files(root, source)? {
        Ok(())
    } else {
        Err(NEEDS_PERMISSION.into())
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
            junction(target, link)
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

/// Creates a directory junction, which Windows allows without any permission: an empty folder
/// whose mount-point reparse data names the target.
#[cfg(windows)]
fn junction(target: &Path, link: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let text = target.to_string_lossy();
    let plain = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    if !Path::new(plain).is_absolute() || plain.starts_with("\\\\") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a folder link needs a local absolute target",
        ));
    }
    let substitute: Vec<u16> = format!("\\??\\{plain}").encode_utf16().collect();
    let print: Vec<u16> = plain.encode_utf16().collect();
    // Offsets and lengths in bytes; both names end with a NUL the lengths leave out.
    let names = (substitute.len() + print.len() + 2) * 2;
    let data = 8 + names;
    if data > 16 * 1024 - 8 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "folder link target too long",
        ));
    }
    let mut buffer: Vec<u8> = Vec::with_capacity(8 + data);
    buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    for value in [
        data,
        0,
        0,
        substitute.len() * 2,
        (substitute.len() + 1) * 2,
        print.len() * 2,
    ] {
        buffer.extend_from_slice(&(value as u16).to_le_bytes());
    }
    for unit in substitute
        .iter()
        .chain(&[0])
        .chain(print.iter())
        .chain(&[0])
    {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::create_dir(link)?;
    let wide: Vec<u16> = link.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: a NUL-terminated path, no security attributes or template.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        let _ = std::fs::remove_dir(link);
        return Err(error);
    }
    let mut returned = 0u32;
    // SAFETY: the handle is open; the buffer is a complete reparse data buffer of its length.
    let set = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    let error = io::Error::last_os_error();
    // SAFETY: closes the handle opened above once.
    unsafe { CloseHandle(handle) };
    if set == 0 {
        let _ = std::fs::remove_dir(link);
        return Err(error);
    }
    Ok(())
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

/// Quotes one command-line argument the way Windows programs split their command lines.
#[cfg_attr(not(windows), allow(dead_code))]
fn quote(argument: &str) -> String {
    let mut out = String::from('"');
    let mut slashes = 0usize;
    for c in argument.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        let escaped = if c == '"' { slashes * 2 + 1 } else { slashes };
        out.extend(std::iter::repeat_n('\\', escaped));
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

/// The helper's arguments: `--source <directory>` and canonical connection ids.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_elevated(args: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let [flag, source, ids @ ..] = args else {
        return Err("Missing arguments".into());
    };
    if flag != "--source" || ids.is_empty() || ids.len() > 64 {
        return Err("Unexpected arguments".into());
    }
    let ids = ids
        .iter()
        .map(|id| {
            uuid::Uuid::parse_str(id)
                .ok()
                .filter(|parsed| parsed.hyphenated().to_string() == *id)
                .map(|_| id.clone())
                .ok_or_else(|| "Invalid connection id".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((PathBuf::from(source), ids))
}

/// A real folder: not a link that could lead the elevated helper somewhere else.
#[cfg_attr(not(windows), allow(dead_code))]
fn real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

/// The shared directory the helper may link to: a real folder inside the user's own profile.
#[cfg_attr(not(windows), allow(dead_code))]
fn checked_source(source: &Path, home: &Path) -> Result<PathBuf, String> {
    let inside = {
        let (source, home) = (
            source.to_string_lossy().to_lowercase(),
            home.to_string_lossy().to_lowercase(),
        );
        source
            .strip_prefix(home.trim_end_matches(['\\', '/']))
            .is_some_and(|rest| rest.starts_with(['\\', '/']))
    };
    if !source.is_absolute()
        || !inside
        || source
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || !real_dir(source)
    {
        return Err("The shared Claude directory is not a folder in this user's profile".into());
    }
    Ok(source.to_path_buf())
}

/// The elevated helper: links the two shared files of each named profile in this app's data to
/// the shared directory. It accepts connection ids only and finds every path itself, refusing
/// links along the way, so it creates nothing outside those profiles.
#[cfg(windows)]
pub fn elevated_main(data: &Path, args: &[String]) -> i32 {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    match home.map(|home| elevated_run(data, &home, args)) {
        Some(Ok(())) => 0,
        _ => 2,
    }
}
#[cfg_attr(not(windows), allow(dead_code))]
fn elevated_run(data: &Path, home: &Path, args: &[String]) -> Result<(), String> {
    let (source, ids) = parse_elevated(args)?;
    let source = checked_source(&source, home)?;
    let profiles = data.join("profiles").join("claude");
    if ![data, &data.join("profiles"), &profiles]
        .iter()
        .all(|path| real_dir(path))
    {
        return Err("Agent Studio's profiles are not real folders".into());
    }
    let mut failed = false;
    for id in ids {
        let root = profiles.join(id);
        if !real_dir(&root) {
            failed = true;
            continue;
        }
        for name in SHARED_FILES {
            if link_one(&root, &source, name, false).is_err() {
                failed = true;
            }
        }
    }
    if failed {
        Err("Some links could not be created".into())
    } else {
        Ok(())
    }
}

/// Answered when the user declines Windows' permission prompt.
#[cfg(windows)]
pub const DECLINED: &str = "Windows' permission was declined, so settings.json and CLAUDE.md stay this account's own. Choose Allow to ask again.";

/// Asks Windows to run this program as the elevated helper for the profiles named by connection
/// id, and waits for it: one prompt covers them all. `owner` is the window the prompt belongs to.
#[cfg(windows)]
pub fn request_permission(
    source: &Path,
    connections: &[String],
    owner: isize,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot locate Agent Studio")?;
    request_permission_with(&exe, source, connections, owner)
}
#[cfg(windows)]
fn request_permission_with(
    exe: &Path,
    source: &Path,
    connections: &[String],
    owner: isize,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
    if connections.is_empty() {
        return Ok(());
    }
    let mut parameters = format!("{ELEVATED} --source {}", quote(&source.to_string_lossy()));
    for id in connections {
        parse_elevated(&["--source".into(), String::new(), id.clone()])?;
        parameters.push(' ');
        parameters.push_str(id);
    }
    // The elevated process starts in the system folder, so it needs the full path.
    let exe = std::path::absolute(exe).map_err(|_| "Cannot locate Agent Studio")?;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, params) = (wide("runas"), wide(&parameters));
    let file: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: all-zero is a valid empty SHELLEXECUTEINFOW; the strings outlive the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.hwnd = owner as _;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_HIDE;
    // SAFETY: COM for this thread, as ShellExecuteEx asks; balanced below.
    let com = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    // SAFETY: info is initialized as documented.
    let started = unsafe { ShellExecuteExW(&mut info) };
    let error = unsafe { GetLastError() };
    if com >= 0 {
        // SAFETY: balances a successful CoInitializeEx on this thread.
        unsafe { CoUninitialize() };
    }
    if started == 0 {
        return Err(if error == ERROR_CANCELLED {
            DECLINED.into()
        } else {
            "Windows could not ask for permission to share these files".into()
        });
    }
    if info.hProcess.is_null() {
        return Err("Windows did not start the sharing helper".into());
    }
    let mut code = 1u32;
    // SAFETY: the process handle stays open until CloseHandle.
    let finished = unsafe { WaitForSingleObject(info.hProcess, 120_000) } == WAIT_OBJECT_0
        && unsafe { GetExitCodeProcess(info.hProcess, &mut code) } != 0;
    // SAFETY: closes the process handle once.
    unsafe { CloseHandle(info.hProcess) };
    if !finished || code != 0 {
        return Err("Some of this account's files could not be shared with the Claude app".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// File links need Developer Mode or administrator rights on Windows; tests that create them
    /// say so instead of failing on a computer without them.
    fn file_links_allowed(dir: &Path) -> bool {
        let probe = dir.join("probe");
        let allowed = make_link(&dir.join("missing"), &probe, false).is_ok();
        let _ = remove_link(&probe);
        if !allowed {
            eprintln!("skipped: this computer does not allow file links without permission");
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
    fn folders_are_shared_without_any_permission_and_relinked_when_moved() {
        let dir = tempfile::tempdir().unwrap();
        let (root, source) = (dir.path().join("profile"), dir.path().join("claude"));
        std::fs::create_dir_all(root.join("projects/k")).unwrap();
        std::fs::create_dir_all(source.join("skills/blender")).unwrap();
        std::fs::write(root.join("projects/k/s.jsonl"), "transcript").unwrap();
        std::fs::write(root.join(".credentials.json"), "login").unwrap();
        std::fs::write(root.join(".claude.json"), "{}").unwrap();
        assert!(!folders_linked(&root, &source));
        link_folders(&root, &source).unwrap();
        assert!(folders_linked(&root, &source));
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
        // Writing through a folder link writes into the shared folder.
        std::fs::write(root.join("agents/reviewer.md"), "agent").unwrap();
        assert_eq!(
            std::fs::read_to_string(source.join("agents/reviewer.md")).unwrap(),
            "agent"
        );
        // The account's own files stay in the profile.
        for own in [".credentials.json", ".claude.json"] {
            assert!(!std::fs::symlink_metadata(root.join(own))
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!source.join(own).exists());
        }
        link_folders(&root, &source).unwrap();
        assert!(folders_linked(&root, &source));
        // A folder link left pointing elsewhere is pointed back.
        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join("agents")).unwrap();
        remove_link(&root.join("agents")).unwrap();
        make_link(&other.join("agents"), &root.join("agents"), true).unwrap();
        assert!(!folders_linked(&root, &source));
        link_folders(&root, &source).unwrap();
        assert!(folders_linked(&root, &source));
        // Removing a link leaves the shared folder's contents.
        remove_link(&root.join("skills")).unwrap();
        assert!(source.join("skills/blender").is_dir());
    }

    #[test]
    fn files_are_linked_when_this_process_may_link_them() {
        let dir = tempfile::tempdir().unwrap();
        let (root, source) = (dir.path().join("profile"), dir.path().join("claude"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(root.join("CLAUDE.md"), "profile instructions").unwrap();
        std::fs::write(source.join("settings.json"), "{\"cleanupPeriodDays\":365}").unwrap();
        if !file_links_allowed(dir.path()) {
            // Nothing moves before the links can be made.
            assert_eq!(link_files(&root, &source), Ok(false));
            assert!(root.join("CLAUDE.md").is_file());
            assert!(!source.join("CLAUDE.md").exists());
            return;
        }
        assert_eq!(link_files(&root, &source), Ok(true));
        assert!(files_linked(&root, &source));
        assert_eq!(
            std::fs::read_to_string(root.join("settings.json")).unwrap(),
            "{\"cleanupPeriodDays\":365}"
        );
        // The profile's own CLAUDE.md became the shared one, as there was none.
        assert_eq!(
            std::fs::read_to_string(source.join("CLAUDE.md")).unwrap(),
            "profile instructions"
        );
    }

    #[tokio::test]
    async fn only_the_first_attempt_of_a_run_moves_folders() {
        let dir = tempfile::tempdir().unwrap();
        let (root, source) = (dir.path().join("profile"), dir.path().join("claude"));
        std::fs::create_dir_all(root.join("projects/k")).unwrap();
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::fs::write(root.join("projects/k/s.jsonl"), "transcript").unwrap();
        assert!(folders_hold_content(&root));
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
        assert!(!folders_hold_content(&root));
        let state = ensure(root.clone(), source.clone()).await;
        assert!(folders_linked(&root, &source));
        if file_links_allowed(dir.path()) {
            assert_eq!(state, State::Linked);
        } else {
            assert_eq!(state, State::NeedsPermission);
        }
    }

    #[test]
    fn a_profile_never_shares_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(link(dir.path(), dir.path()).is_err());
        assert!(link(&dir.path().join("profile"), dir.path()).is_err());
        assert!(link(dir.path(), &dir.path().join("inside")).is_err());
    }

    #[test]
    fn the_elevated_helper_accepts_only_its_own_arguments() {
        let id = "0f8e7a3c-1d2b-4c5d-8e9f-a0b1c2d3e4f5".to_string();
        let args = |rest: &[&str]| rest.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (source, ids) =
            parse_elevated(&args(&["--source", "C:\\Users\\me\\.claude", &id])).unwrap();
        assert_eq!(source, PathBuf::from("C:\\Users\\me\\.claude"));
        assert_eq!(ids.as_slice(), std::slice::from_ref(&id));
        for bad in [
            args(&[]),
            args(&["--source", "C:\\x"]),
            args(&["--target", "C:\\x", &id]),
            args(&["--source", "C:\\x", "..\\..\\Windows"]),
            args(&["--source", "C:\\x", &id.to_uppercase()]),
            args(&["--source", "C:\\x", &format!("{{{id}}}")]),
        ] {
            assert!(parse_elevated(&bad).is_err(), "{bad:?}");
        }
        // The shared directory must be a real folder inside the user's own profile.
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(dir.path().join("homeother")).unwrap();
        assert!(checked_source(&home.join(".claude"), &home).is_ok());
        assert!(checked_source(&home, &home).is_err());
        assert!(checked_source(&dir.path().join("homeother"), &home).is_err());
        assert!(checked_source(&home.join(".claude").join(".."), &home).is_err());
        assert!(checked_source(&home.join("missing"), &home).is_err());
    }

    #[test]
    fn the_elevated_helper_links_only_inside_this_apps_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let (home, data, outside) = (
            dir.path().join("home"),
            dir.path().join("data"),
            dir.path().join("elsewhere"),
        );
        let source = home.join(".claude");
        let profiles = data.join("profiles").join("claude");
        let id = "0f8e7a3c-1d2b-4c5d-8e9f-a0b1c2d3e4f5";
        for path in [&source, &outside, &profiles.join(id)] {
            std::fs::create_dir_all(path).unwrap();
        }
        let args = |source: &Path, id: &str| {
            vec![
                "--source".to_string(),
                source.to_string_lossy().into_owned(),
                id.to_string(),
            ]
        };
        let created = |root: &Path| std::fs::symlink_metadata(root.join("settings.json")).is_ok();
        // A shared directory outside the user's folder is refused before anything is created.
        assert!(elevated_run(&data, &home, &args(&outside, id)).is_err());
        assert!(!created(&profiles.join(id)));
        // So is a profile folder that is itself a link, which could lead somewhere else.
        let linked = "1f8e7a3c-1d2b-4c5d-8e9f-a0b1c2d3e4f5";
        make_link(&outside, &profiles.join(linked), true).unwrap();
        assert!(elevated_run(&data, &home, &args(&source, linked)).is_err());
        assert!(!created(&outside));
        // With the right to create file links, the profile's two files become links.
        let result = elevated_run(&data, &home, &args(&source, id));
        if file_links_allowed(dir.path()) {
            assert!(result.is_ok());
            assert!(files_linked(&profiles.join(id), &source));
        } else {
            assert!(result.is_err());
        }
    }

    /// Asks Windows' permission for real, then has the installed Claude Code write through the
    /// links: run with `AGENT_STUDIO_ELEVATION_PROBE` naming a built agent-studio.exe and approve
    /// the prompt. Its throwaway profile (a random id in this app's data) and its throwaway shared
    /// directory (in the user's .cache) are removed afterwards.
    #[cfg(windows)]
    #[test]
    #[ignore = "Opt-in: shows one Windows permission prompt and runs the installed Claude Code"]
    fn windows_permission_links_both_files_and_claude_code_writes_through_them() {
        let exe = PathBuf::from(std::env::var("AGENT_STUDIO_ELEVATION_PROBE").expect("exe"));
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json")).unwrap(),
        )
        .unwrap();
        let data = crate::startup::data_root(config["identifier"].as_str().unwrap()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let root = data.join("profiles").join("claude").join(&id);
        let home = PathBuf::from(std::env::var_os("USERPROFILE").unwrap());
        let scratch = home
            .join(".cache")
            .join(format!("agent-studio-share-probe-{id}"));
        let source = scratch.join("claude");
        let market = scratch.join("market");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(market.join(".claude-plugin")).unwrap();
        std::fs::create_dir_all(market.join("demo/.claude-plugin")).unwrap();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("settings.json"),
            "{\n  \"cleanupPeriodDays\": 365\n}\n",
        )
        .unwrap();
        std::fs::write(market.join(".claude-plugin/marketplace.json"), r#"{"name":"studio-fixture","owner":{"name":"Fixture"},"plugins":[{"name":"demo","source":"./demo","description":"Synthetic"}]}"#).unwrap();
        std::fs::write(
            market.join("demo/.claude-plugin/plugin.json"),
            r#"{"name":"demo","version":"0.0.1","description":"Synthetic"}"#,
        )
        .unwrap();
        let cleanup = || {
            for name in SHARED_FILES {
                let _ = remove_link(&root.join(name));
            }
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::remove_dir_all(&scratch);
        };
        let result = request_permission_with(&exe, &source, std::slice::from_ref(&id), 0);
        let linked = files_linked(&root, &source);
        let claude = |args: &[&str]| {
            let mut command = std::process::Command::new("claude");
            for (name, _) in std::env::vars().filter(|(name, _)| name.starts_with("CLAUDE")) {
                command.env_remove(name);
            }
            command
                .env("CLAUDE_CONFIG_DIR", &root)
                .args(args)
                .stdin(std::process::Stdio::null())
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        };
        let wrote = linked
            && claude(&["plugin", "marketplace", "add", &market.to_string_lossy()])
            && claude(&[
                "plugin",
                "install",
                "demo@studio-fixture",
                "--scope",
                "user",
            ]);
        let shared = std::fs::read_to_string(source.join("settings.json")).unwrap_or_default();
        let still_linked = files_linked(&root, &source);
        cleanup();
        assert_eq!(result, Ok(()), "the helper did not link the files");
        assert!(linked, "the files are not links after the helper ran");
        assert!(wrote, "Claude Code failed to install the fixture plugin");
        assert!(shared.contains("enabledPlugins") && shared.contains("cleanupPeriodDays"));
        assert!(still_linked, "Claude Code replaced a linked file");
    }

    #[test]
    fn arguments_are_quoted_as_windows_splits_them() {
        assert_eq!(
            quote("C:\\Users\\me\\.claude"),
            "\"C:\\Users\\me\\.claude\""
        );
        assert_eq!(quote("C:\\with space\\"), "\"C:\\with space\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a\\\"b"), "\"a\\\\\\\"b\"");
    }
}
