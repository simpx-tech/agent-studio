//! Named reservations (requested 2026-11-24, artifacts/time-backfill/agent-time-follow-up.md §8):
//! a thing one chat at a time may hold across its calls, such as a shared folder, an editor that
//! holds a project's assets, or a repository's landing (from fetching and merging its main branch
//! through the final pipeline to the push). An agent cannot make such a lock itself: each of its
//! calls is a process of its own, and a lock file a chat that died left behind stays forever. So
//! the broker holds the name, says who holds it, lets chats wait their turn and drops it when the
//! reply that took it ends. This module names them: the same thing reads as one name however it
//! is written, and a landing turn belongs to the repository, whichever checkout or worktree of it
//! a chat works in.
use std::path::{Path, PathBuf};

/// A name as the broker compares it: without case, runs of spaces or the difference between
/// Windows' and Unix's folder separators, and without a separator at its end.
pub fn key(name: &str) -> String {
    let words = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut key = words.to_lowercase().replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') {
        key.pop();
    }
    key
}

/// The landing turn of the repository `folder` belongs to: its key and how it reads. The
/// repository is its `origin` remote, else its common Git folder, so that every checkout and
/// worktree of one shares a turn.
pub fn landing(folder: &Path) -> Result<(String, String), String> {
    let repository = repository(folder).ok_or_else(|| {
        "This chat's folder is not in a Git repository: name what you reserve with name instead."
            .to_string()
    })?;
    Ok((
        format!("landing:{}", key(&repository)),
        format!("the landing of {repository}"),
    ))
}

/// The repository a folder is in, as one name for all its checkouts: its `origin` remote without
/// scheme, user or `.git`, else its common Git folder. Read from Git's own files, so it works for
/// a WSL folder through its Windows path and needs no Git program.
pub fn repository(folder: &Path) -> Option<String> {
    let common = common_dir(folder)?;
    let config = std::fs::read_to_string(common.join("config")).unwrap_or_default();
    match origin(&config) {
        Some(url) => Some(remote_name(&url)),
        None => Some(
            std::fs::canonicalize(&common)
                .unwrap_or(common)
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .to_string(),
        ),
    }
}

/// The Git folder every worktree of `folder`'s repository shares.
fn common_dir(folder: &Path) -> Option<PathBuf> {
    let mut current = Some(folder);
    while let Some(dir) = current {
        let git = dir.join(".git");
        if git.is_dir() {
            return Some(git);
        }
        if git.is_file() {
            // A worktree's or a submodule's `.git` file names its own Git folder, whose
            // `commondir` names the one its repository shares.
            let text = std::fs::read_to_string(&git).ok()?;
            let own = text.trim().strip_prefix("gitdir:")?.trim();
            let own = dir.join(own);
            return Some(match std::fs::read_to_string(own.join("commondir")) {
                Ok(common) => own.join(common.trim()),
                Err(_) => own,
            });
        }
        current = dir.parent();
    }
    None
}

/// The url of the `origin` remote in a Git config file's text.
fn origin(config: &str) -> Option<String> {
    let mut inside = false;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            let section = line.trim_start_matches('[').trim_end_matches(']').trim();
            let (kind, name) = section
                .split_once(char::is_whitespace)
                .unwrap_or((section, ""));
            inside =
                kind.eq_ignore_ascii_case("remote") && name.trim().trim_matches('"') == "origin";
            continue;
        }
        if !inside {
            continue;
        }
        if let Some((name, value)) = line.split_once('=') {
            if name.trim().eq_ignore_ascii_case("url") {
                let value = value.trim().trim_matches('"').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// A remote's url as a name: `github.com/owner/repository`, whether it was written as https,
/// ssh or `git@host:path`, without a user, a password, a port or `.git`.
fn remote_name(url: &str) -> String {
    let mut rest = url.trim();
    if let Some((_, after)) = rest.split_once("://") {
        rest = after;
    } else if let Some((host, path)) = rest.split_once(':') {
        // `git@github.com:owner/repository`, unless it is a Windows path such as `C:\repos\x`.
        if host.len() > 1 && !path.starts_with('\\') {
            return remote_name(&format!("ssh://{host}/{path}"));
        }
    }
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = host.split(':').next().unwrap_or(host);
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if path.is_empty() {
        host.to_lowercase()
    } else {
        format!("{}/{}", host.to_lowercase(), path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_reads_the_same_however_it_is_written() {
        assert_eq!(
            key(r"D:\bluevox-server-build\ "),
            key("d:/BLUEVOX-server-build")
        );
        assert_eq!(key("  Unreal   editor "), "unreal editor");
        assert_eq!(key("/"), "/");
    }

    #[test]
    fn a_remote_reads_as_its_host_and_path() {
        for url in [
            "https://github.com/simpx-tech/bluevox.git",
            "https://user:token@github.com/simpx-tech/bluevox",
            "git@github.com:simpx-tech/bluevox.git",
            "ssh://git@github.com:22/simpx-tech/bluevox.git",
            "https://GitHub.com/simpx-tech/bluevox/",
        ] {
            assert_eq!(remote_name(url), "github.com/simpx-tech/bluevox", "{url}");
        }
    }

    #[test]
    fn every_worktree_of_a_repository_shares_its_landing() {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("main");
        let git = main.join(".git");
        std::fs::create_dir_all(git.join("worktrees").join("feature")).unwrap();
        std::fs::write(
            git.join("config"),
            "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://example.com/other.git\n[remote \"origin\"]\n\turl = git@github.com:simpx-tech/bluevox.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
        )
        .unwrap();
        // A worktree elsewhere: its `.git` file names its own folder, which names the common one.
        let worktree = root.path().join("worktrees").join("feature");
        std::fs::create_dir_all(worktree.join("Source")).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!(
                "gitdir: {}\n",
                git.join("worktrees").join("feature").display()
            ),
        )
        .unwrap();
        std::fs::write(
            git.join("worktrees").join("feature").join("commondir"),
            "../..\n",
        )
        .unwrap();
        let (key, name) = landing(&main.join("Source")).unwrap();
        assert_eq!(key, "landing:github.com/simpx-tech/bluevox");
        assert_eq!(name, "the landing of github.com/simpx-tech/bluevox");
        assert_eq!(landing(&worktree.join("Source")).unwrap().0, key);
        // A repository without a remote is known by its Git folder.
        let local = root.path().join("local");
        std::fs::create_dir_all(local.join(".git")).unwrap();
        let (local_key, _) = landing(&local).unwrap();
        assert!(local_key.starts_with("landing:"), "{local_key}");
        assert_ne!(local_key, key);
        // A folder outside any repository has no landing.
        let outside = tempfile::tempdir().unwrap();
        assert!(landing(outside.path()).is_err());
    }
}
