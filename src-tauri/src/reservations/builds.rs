//! Build slots (requested 2026-11-24, artifacts/time-backfill/agent-time-follow-up.md §8): several
//! heavy builds at once compete for the computer's memory before its cores, and with three or
//! four chats building, free commit fell to 3.5 GB and a shell could not start a thread. A cap
//! kept inside one project's build script sees none of the others, so the broker counts every
//! build on this computer, whoever runs it, and holds a chat's build at its gate while another
//! would not fit: the chat then waits in `pc_wait`, which its reply's time report shows apart.
//!
//! A build is recognized from the command a chat asks to run (`is_build`), and builds this app
//! does not gate, such as a Claude app session's or one started by hand, from the compilers that
//! run on the computer (`compiling`). Sizes come from bluevox's measurements that day: a compiler
//! of its module commits 2.5 to 3.5 GB, one build alone ran 8 compilers with 17 GB free, and two
//! heavy builds together took free commit from 17 GB to 2.3. So a build always starts alone; one
//! beside others starts while fewer builds run than the cores allow (one per eight) and at least
//! 10 GB stays free, and only once the last build that started had half a minute to grow.
use super::light;
use super::machine::{Owner, Owners, Reading};
use std::collections::HashMap;
use std::time::Duration;

/// Free memory (commit, on Windows) a build beside another needs to start.
pub const BESIDE_FREE: u64 = 10 << 30;
/// How long a build that started is given to take its memory before another may start beside it.
pub const RAMP: Duration = Duration::from_secs(30);

/// How many builds may run at once: one per eight cores, and always one.
pub fn slots(cores: u32) -> usize {
    (cores as usize / 8).max(1)
}

/// Whether another build may start now, with `running` builds running, `free` memory left (when
/// it can be read) and the last build started `since` ago.
pub fn admits(running: usize, free: Option<u64>, cores: u32, since: Option<Duration>) -> bool {
    running == 0
        || (running < slots(cores)
            && free.is_none_or(|free| free >= BESIDE_FREE)
            && since.is_none_or(|since| since >= RAMP))
}

/// Programs that build what they are given, by the name a command line calls them.
const BUILDERS: &[&str] = &[
    "unrealbuildtool",
    "msbuild",
    "devenv",
    "ninja",
    "make",
    "mingw32-make",
    "nmake",
    "jom",
    "xcodebuild",
    "scons",
];
/// Programs that build with one of their subcommands, and those subcommands.
const SUBCOMMANDS: &[(&str, &[&str])] = &[
    (
        "cargo",
        &[
            "build", "b", "test", "t", "check", "c", "clippy", "run", "r", "bench", "doc",
            "install", "nextest", "rustc", "tauri",
        ],
    ),
    (
        "dotnet",
        &["build", "test", "publish", "pack", "run", "msbuild"],
    ),
    ("go", &["build", "test", "install", "vet"]),
    ("swift", &["build", "test"]),
    ("bazel", &["build", "test", "run"]),
    ("bazelisk", &["build", "test", "run"]),
    ("gradle", &["build", "assemble", "test", "compilejava"]),
    ("gradlew", &["build", "assemble", "test", "compilejava"]),
    ("mvn", &["compile", "package", "install", "test", "verify"]),
    ("mvnw", &["compile", "package", "install", "test", "verify"]),
];
/// Shells and runners whose first script argument is what runs.
const RUNNERS: &[&str] = &[
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "cmd",
    "call",
    "&",
    ".",
    "source",
    "exec",
    "time",
    "nice",
    "sudo",
    "env",
    "start",
];
const SCRIPTS: &[&str] = &[".ps1", ".bat", ".cmd", ".sh"];

/// Whether `command`, as its agent wrote it, builds: Unreal's build tool or `Build.bat`, RunUAT,
/// a project's own build script (a script whose name starts with "build"), a compiler driver
/// (`cargo build`, `cargo test`, `dotnet build`, `cmake --build`, MSBuild, Ninja, make and the
/// like), or Tauri's release build. Light commands never are.
pub fn is_build(command: &str) -> bool {
    light::parts(command).iter().any(|part| build_part(part))
}

fn build_part(words: &[String]) -> bool {
    let mut words: Vec<&String> = words.iter().skip_while(|w| light::assignment(w)).collect();
    // `& "Tools/Build.ps1"`, `pwsh -File Tools/Build.ps1`, `cmd /c build.bat`, `sudo make`.
    while let Some(first) = words.first() {
        let program = light::program_name(first);
        if !RUNNERS.contains(&program.as_str()) {
            break;
        }
        words.remove(0);
        // What a shell runs is its first script, else what follows its options.
        if let Some(at) = words.iter().position(|w| script(w)) {
            words.drain(..at);
            break;
        }
        while words.first().is_some_and(|w| option(w)) {
            words.remove(0);
        }
        // `pwsh -Command "..."` and `bash -c "..."` run a command line of their own.
        if let [line] = words.as_slice() {
            if line.contains(char::is_whitespace) {
                return is_build(line);
            }
        }
    }
    let Some(first) = words.first() else {
        return false;
    };
    let program = light::program_name(first);
    let rest: Vec<String> = words[1..].iter().map(|w| w.to_ascii_lowercase()).collect();
    if script(first) {
        let stem = program
            .rsplit_once('.')
            .map_or(program.as_str(), |(stem, _)| stem);
        return stem.starts_with("build") || stem == "runuat";
    }
    if BUILDERS.contains(&program.as_str()) {
        return true;
    }
    if program == "runuat" {
        return true;
    }
    if program == "cmake" {
        return rest.iter().any(|w| w == "--build");
    }
    // `dotnet ...UnrealBuildTool.dll`, as Build.bat and bluevox's script run it.
    if program == "dotnet" && rest.iter().any(|w| w.ends_with("unrealbuildtool.dll")) {
        return true;
    }
    // `npm run tauri build`, `npx tauri build`, `cargo tauri build`.
    if matches!(
        program.as_str(),
        "npm" | "npx" | "pnpm" | "yarn" | "bun" | "bunx"
    ) {
        return rest
            .windows(2)
            .any(|pair| pair[0] == "tauri" && pair[1] == "build");
    }
    SUBCOMMANDS
        .iter()
        .find(|(name, _)| *name == program)
        .is_some_and(|(_, subcommands)| {
            rest.iter()
                // `cargo +nightly build`, `cargo -q test`.
                .find(|w| !w.starts_with('-') && !w.starts_with('+'))
                .is_some_and(|sub| subcommands.contains(&sub.as_str()))
        })
}

fn script(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    SCRIPTS.iter().any(|ext| lower.ends_with(ext))
}

/// An option of a shell or runner: `-NoProfile`, `-lc`, `/c`, `/wait`.
fn option(word: &str) -> bool {
    word.starts_with('-')
        || word
            .strip_prefix('/')
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphabetic()))
}

/// Compilers and linkers, by the name of their program: a build runs them while it compiles.
const COMPILERS: &[&str] = &[
    "cl", "clang-cl", "clang", "clang++", "rustc", "link", "lld-link", "ld.lld", "cc1", "cc1plus",
    "ispc",
];
/// What drives a build's compilers: the build itself.
const DRIVERS: &[&str] = &[
    "unrealbuildtool",
    "dotnet",
    "cargo",
    "msbuild",
    "devenv",
    "ninja",
    "make",
    "mingw32-make",
    "nmake",
    "jom",
    "cmake",
    "xcodebuild",
    "bazel",
    "go",
];

/// A build running on the computer, from its compilers.
#[derive(Clone, Debug, PartialEq)]
pub struct Compiling {
    pub owner: Owner,
    /// What drives it, such as UnrealBuildTool.exe or cargo.exe.
    pub name: String,
    pub compilers: usize,
}

/// The builds compiling on the computer now, one for each driver its compilers run under (or
/// their own parent, without one), with whose they are.
pub fn compiling(reading: &Reading, owners: &Owners) -> Vec<Compiling> {
    let index: HashMap<u32, &super::machine::Process> =
        reading.processes.iter().map(|p| (p.pid, p)).collect();
    let mut builds: Vec<(u32, Compiling)> = vec![];
    for process in &reading.processes {
        if !COMPILERS.contains(&light::program_name(&process.name).as_str()) {
            continue;
        }
        // The nearest driver above it, as a parent that began before its child.
        let mut root = None;
        let mut current = process;
        for _ in 0..16 {
            let Some(parent) = index
                .get(&current.parent)
                .filter(|p| p.pid != current.pid && p.began <= current.began)
            else {
                break;
            };
            if DRIVERS.contains(&light::program_name(&parent.name).as_str()) {
                root = Some(*parent);
                break;
            }
            current = parent;
        }
        let Some(root) = root.or_else(|| {
            index
                .get(&process.parent)
                .copied()
                .filter(|p| p.pid != process.pid)
        }) else {
            continue;
        };
        // A linker a compiler driver runs is the same build.
        if COMPILERS.contains(&light::program_name(&root.name).as_str()) {
            continue;
        }
        match builds.iter_mut().find(|(pid, _)| *pid == root.pid) {
            Some((_, build)) => build.compilers += 1,
            None => builds.push((
                root.pid,
                Compiling {
                    owner: owners.of(root.pid),
                    name: root.name.clone(),
                    compilers: 1,
                },
            )),
        }
    }
    builds.into_iter().map(|(_, build)| build).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reservations::jobs::Members;
    use crate::reservations::machine::Process;
    use std::time::Instant;

    #[test]
    fn builds_are_told_from_their_commands() {
        for command in [
            r#"& "D:\UE_5.8\Engine\Build\BatchFiles\Build.bat" BluevoxEditor Win64 Development -Project="D:\p\Bluevox.uproject""#,
            r"powershell -NoProfile -ExecutionPolicy Bypass -File .\Tools\Build.ps1 -Check",
            r"pwsh -File Tools/Build.ps1",
            r".\Tools\Build.ps1 -Target Bluevox",
            "Tools/build.sh release",
            "cargo build --release",
            "cargo +nightly test -p agent-studio",
            "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
            "cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=8",
            "npm run tauri build -- --debug --no-bundle",
            "dotnet build Bluevox.sln",
            r#"dotnet "..\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.dll" BluevoxEditor Win64 Development"#,
            "cmake --build build --config Release",
            "MSBuild.exe Bluevox.sln /m",
            r#"D:\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat BuildCookRun -project=x"#,
            "ninja -C out",
            "cd src-tauri && cargo build",
            r#"bash -lc "cargo build --release""#,
            "CARGO_TARGET_DIR=target-qa cargo build",
        ] {
            assert!(is_build(command), "{command}");
        }
        for command in [
            "git status",
            "cargo fmt --check",
            "cargo metadata",
            "npm run check",
            "npx vitest run",
            "npm run build",
            "node scripts/release.ts notes",
            "rg Build.ps1",
            "cat Tools/Build.ps1",
            "cmake -S . -B build",
            "Get-Content Build.ps1",
            r"powershell -File .\Tools\Run-Tests.ps1 -Filter Bluevox.Water",
        ] {
            assert!(!is_build(command), "{command}");
        }
    }

    #[test]
    fn a_build_starts_alone_and_beside_others_only_with_room() {
        // Alone, whatever the memory.
        assert!(admits(0, Some(1 << 30), 32, Some(Duration::ZERO)));
        // Beside another: a slot, 10 GB free, and half a minute since the last began.
        assert!(admits(1, Some(12 << 30), 32, Some(Duration::from_secs(40))));
        assert!(!admits(1, Some(6 << 30), 32, Some(Duration::from_secs(40))));
        assert!(!admits(1, Some(12 << 30), 32, Some(Duration::from_secs(5))));
        // One slot for each eight cores.
        assert_eq!(slots(32), 4);
        assert_eq!(slots(6), 1);
        assert!(!admits(4, Some(40 << 30), 32, None));
        assert!(!admits(1, Some(40 << 30), 6, None));
        // Memory that cannot be read does not hold a build.
        assert!(admits(1, None, 32, None));
    }

    fn process(pid: u32, parent: u32, name: &str) -> Process {
        Process {
            pid,
            parent,
            name: name.into(),
            cpu_ms: 0,
            memory: 0,
            began: u64::from(pid),
            system: false,
        }
    }

    #[test]
    fn compilers_tell_the_builds_that_run_and_whose_they_are() {
        let reading = Reading {
            at: Instant::now(),
            busy_ms: 0,
            total_ms: 0,
            memory_total: 64 << 30,
            memory_available: 8 << 30,
            commit_available: Some(8 << 30),
            cores: 32,
            processes: vec![
                process(1, 0, "explorer.exe"),
                // A chat's build: its CLI, a shell, UBT under dotnet and three compilers.
                process(10, 1, "claude.exe"),
                process(11, 10, "pwsh.exe"),
                process(12, 11, "dotnet.exe"),
                process(13, 12, "cl.exe"),
                process(14, 12, "cl.exe"),
                process(15, 12, "link.exe"),
                // A terminal's cargo build: rustc under cargo.
                process(20, 1, "WindowsTerminal.exe"),
                process(21, 20, "pwsh.exe"),
                process(22, 21, "claude.exe"),
                process(23, 22, "cargo.exe"),
                process(24, 23, "rustc.exe"),
                // A compiler without a driver: its parent stands for its build.
                process(30, 1, "ninja-like.exe"),
                process(31, 30, "clang-cl.exe"),
                // Not a compiler.
                process(40, 1, "node.exe"),
            ],
        };
        let members = Members {
            chats: HashMap::from([(10, "chat-a".to_string())]),
            roots: HashMap::new(),
        };
        let owners = Owners::new(&reading, &members, 999);
        let builds = compiling(&reading, &owners);
        assert_eq!(builds.len(), 3, "{builds:?}");
        assert_eq!(builds[0].name, "dotnet.exe");
        assert_eq!(builds[0].owner, Owner::Chat("chat-a".into()));
        assert_eq!(builds[0].compilers, 3);
        assert_eq!(builds[1].name, "cargo.exe");
        assert_eq!(builds[1].owner, Owner::Session("claude-cli"));
        assert_eq!(builds[2].name, "ninja-like.exe");
        assert_eq!(builds[2].owner, Owner::Yours);
    }
}
