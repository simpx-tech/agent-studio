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

/// What a command asks of the computer while it runs, so that the broker makes room for it and
/// holds that room until it ends (requested 2026-11-26, after a build that started with 6 GB of
/// commit free lost a compiler to an internal error once other chats' builds and games, started
/// after it, took the rest).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    /// A build: many compilers of a few gigabytes each.
    Build,
    /// A build of a few files: a project's build script run with `-Check` or `-SingleFile`.
    Light,
    /// A game, an editor or a test run of an engine: one program of several gigabytes.
    Run,
}
impl Weight {
    pub fn name(self) -> &'static str {
        match self {
            Weight::Build => "build",
            Weight::Light => "light",
            Weight::Run => "run",
        }
    }
    /// What the agent's command is called in what it is told.
    pub fn what(self) -> &'static str {
        match self {
            Weight::Build => "build",
            Weight::Light => "build of a few files",
            Weight::Run => "game or test run",
        }
    }
    fn rank(self) -> u8 {
        match self {
            Weight::Light => 0,
            Weight::Run => 1,
            Weight::Build => 2,
        }
    }
}

/// What one compiler of bluevox's module commits: 2.5 to 3.5 GB.
pub const COMPILER: u64 = 3584 << 20;
/// Free memory a build of a few files needs to start beside work holding a grant.
pub const LIGHT_FREE: u64 = 4 << 30;
/// Free memory a game, an editor or a test run needs to start beside work holding a grant: a
/// rendering client or an editor takes 4 to 12 GB.
pub const RUN_FREE: u64 = 8 << 30;
/// What a grant leaves to the rest of the computer: its tools, shells and browsers.
pub const GRANT_KEEP: u64 = 3 << 30;
/// The most a build is granted: eight compilers, as many as one build ran alone with room.
pub const GRANT_MOST: u64 = 8 * COMPILER;
/// The most a build of a few files is granted: two compilers.
pub const LIGHT_GRANT: u64 = 2 * COMPILER;

/// The fewest compilers a build is started with while other work holds memory that may soon free
/// (requested 2026-11-27, after two bluevox builds ran 12 and 15 minutes on one compiler, granted
/// 3.5 GB while 15.7 GB of commit was free and held for other chats' runs, where the same builds
/// took about four minutes on six to eight): below it, a build waits up to `FEW_WAIT` since it
/// first asked for more room, then starts with what there is.
pub const FEW: u64 = 2 * COMPILER;
/// How long a build waits for room for `FEW` before it starts with less.
pub const FEW_WAIT: Duration = Duration::from_secs(3 * 60);

/// Whether a build that would be granted `bytes` waits for more: under `FEW`, while other work
/// holds memory that may free (`others_hold`), until it has waited `FEW_WAIT`.
pub fn waits_for_more(bytes: u64, others_hold: bool, waited: Duration) -> bool {
    bytes < FEW && others_hold && waited < FEW_WAIT
}

/// The least and the most a run is asked to have free, however little or much it took before.
pub const RUN_LEAST: u64 = 2 << 30;
pub const RUN_MOST: u64 = 16 << 30;
/// How many of a kind of run's last peaks are kept (`signature`).
pub const PEAKS_KEPT: usize = 10;

/// What a run whose kind took `peaks` of memory at its most the last times needs free to start
/// (requested 2026-11-27, after a 30-second filtered test run waited 4 and 16 minutes for the
/// 8 GB every run asked): the most it took, a quarter more and half a gigabyte, between
/// `RUN_LEAST` and `RUN_MOST`; `RUN_FREE` before any is known.
pub fn run_need(peaks: &[u64]) -> u64 {
    match peaks.iter().max() {
        None => RUN_FREE,
        Some(most) => (most + most / 4 + (512 << 20)).clamp(RUN_LEAST, RUN_MOST),
    }
}

/// The memory work of `weight` is granted while it runs, from what is `available` as it starts:
/// free memory less what earlier grants have not taken yet. A build gets what is left after
/// `GRANT_KEEP`, between one compiler and `GRANT_MOST`, a build of a few files up to two
/// compilers, a run what it needs to start (`need`, `run_need`). A build's own script reads it
/// (`AGENT_STUDIO_PC_GRANT`) and runs as many compilers as it holds.
pub fn grant(weight: Weight, available: Option<u64>, need: u64) -> u64 {
    let left = |most: u64| {
        available.map_or(most, |free| {
            free.saturating_sub(GRANT_KEEP).clamp(COMPILER, most)
        })
    };
    match weight {
        Weight::Build => left(GRANT_MOST),
        Weight::Light => left(LIGHT_GRANT),
        Weight::Run => need,
    }
}

/// Whether work of `weight` may start now, with `running` builds running and the last build
/// started `since` ago: `granted` tells whether any work holds a grant now, and `available` is
/// free memory less what those grants have not taken yet. A build is admitted as before (alone
/// always, beside others with a slot, `BESIDE_FREE` and `RAMP`), now on the memory grants leave;
/// a build of a few files or a run needs room of its own, `LIGHT_FREE` or what the run needs
/// (`need`, `run_need`), unless no grant holds memory, and never takes a slot or waits for the
/// last build to grow.
pub fn admits_weight(
    weight: Weight,
    running: usize,
    granted: bool,
    available: Option<u64>,
    cores: u32,
    since: Option<Duration>,
    need: u64,
) -> bool {
    match weight {
        Weight::Build => admits(running, available, cores, since),
        Weight::Light => !granted || available.is_none_or(|free| free >= LIGHT_FREE),
        Weight::Run => !granted || available.is_none_or(|free| free >= need),
    }
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

/// Scripts that run a game, an editor or tests of an engine, by their name: bluevox's runners.
const RUN_SCRIPTS: &[&str] = &["run-game", "run-net", "run-tests", "run-editor"];

/// How much `command`, as its agent wrote it, asks of the computer: a build (Unreal's build tool
/// or `Build.bat`, RunUAT, a project's own build script, whose name starts with "build", a
/// compiler driver such as `cargo build`, `cargo test`, `dotnet build`, `cmake --build`, MSBuild,
/// Ninja or make, or Tauri's release build), a build of a few files (a build script run with
/// `-Check` or `-SingleFile`), or a game, an editor or a test run of an engine (`UnrealEditor`
/// itself, or a project's `Run-Game`, `Run-Net`, `Run-Tests` or `Run-Editor` script); None for
/// anything else, a build script's dry run (`-WhatIf`) included. Of several commands, the
/// heaviest. Light commands never ask anything.
pub fn weight(command: &str) -> Option<Weight> {
    light::parts(command)
        .iter()
        .filter_map(|part| part_weight(part))
        .max_by_key(|weight| weight.rank())
}

/// A script's argument that makes it run nothing: PowerShell's `-WhatIf`.
fn dry_run(word: &str) -> bool {
    word == "-whatif" || word == "-whatif:$true"
}

/// A build script's argument that makes it compile a few files alone, linking nothing.
fn few_files(word: &str) -> bool {
    matches!(word, "-check" | "-check:$true" | "-singlefile") || word.starts_with("-singlefile:")
}

/// What a part of a command line runs once its shells and runners are taken off: its words from
/// the program or script on, or a command line of its own that a shell runs.
enum Core<'a> {
    Words(Vec<&'a String>),
    /// `pwsh -Command "..."` and `bash -c "..."` run a command line of their own.
    Line(&'a str),
}

fn core(words: &[String]) -> Option<Core<'_>> {
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
        if let [line] = words.as_slice() {
            if line.contains(char::is_whitespace) {
                return Some(Core::Line(line));
            }
        }
    }
    (!words.is_empty()).then_some(Core::Words(words))
}

fn part_weight(words: &[String]) -> Option<Weight> {
    match core(words)? {
        Core::Line(line) => weight(line),
        Core::Words(words) => core_weight(&words),
    }
}

/// Flags of a run that change what it takes, which its signature keeps (`signature`): every other
/// word is left out, so that runs of one kind share their peaks whatever their names, logs and
/// ports.
const SIGNATURE_FLAGS: &[&str] = &[
    "-filter",
    "-changed",
    "-game",
    "-server",
    "-nullrhi",
    "-renderoffscreen",
    "-hostnullrhi",
    "-clientnullrhi",
    "-mode",
    "-run",
];
/// Flags whose value matters too: Run-Game's `-Mode net` runs two programs, and an editor's
/// `-run=` names its commandlet.
const SIGNATURE_VALUES: &[&str] = &["-mode", "-run"];

/// The kind of run `command` is (requested 2026-11-27): the program or script it runs and the
/// flags that change what it takes, such as `run-tests -filter` or `unrealeditor-cmd -game
/// -nullrhi`, under which the broker keeps the memory runs of that kind took at their most
/// (`run_need`). None for a command that is not a run.
pub fn signature(command: &str) -> Option<String> {
    light::parts(command)
        .iter()
        .find_map(|part| match core(part)? {
            Core::Line(line) => signature(line),
            Core::Words(words) => {
                if core_weight(&words) != Some(Weight::Run) {
                    return None;
                }
                let program = light::program_name(words[0]);
                let name = if script(words[0]) {
                    program
                        .rsplit_once('.')
                        .map_or(program.as_str(), |(stem, _)| stem)
                } else {
                    program.as_str()
                };
                let rest: Vec<String> = words[1..].iter().map(|w| w.to_ascii_lowercase()).collect();
                let mut flags: Vec<String> = vec![];
                for (index, word) in rest.iter().enumerate() {
                    let (flag, value) = match word.split_once(['=', ':']) {
                        Some((flag, value)) => (flag, Some(value.to_string())),
                        None => (word.as_str(), None),
                    };
                    if !SIGNATURE_FLAGS.contains(&flag) {
                        continue;
                    }
                    let value = SIGNATURE_VALUES.contains(&flag).then(|| {
                        value.or_else(|| {
                            rest.get(index + 1)
                                .filter(|next| !next.starts_with('-'))
                                .cloned()
                        })
                    });
                    let flag = match value.flatten() {
                        Some(value) => format!("{flag} {value}"),
                        None => flag.to_string(),
                    };
                    if !flags.contains(&flag) {
                        flags.push(flag);
                    }
                }
                flags.sort();
                Some(
                    std::iter::once(name.to_string())
                        .chain(flags)
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            }
        })
}

/// Whether `command` draws on the GPU while it runs (requested 2026-11-27): a game, an editor or a
/// run of an engine not given `-NullRHI` (bluevox's `Run-Tests` runs its editor under it), or
/// browser tests (Playwright, and `npm run verify`, which runs them). A measurement of GPU work
/// alone (`pc_reserve` with `scope: "gpu"`) holds only these of other chats' work.
pub fn renders(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let run = weight(command) == Some(Weight::Run)
        && !lower.contains("-nullrhi")
        && signature(command).is_none_or(|kind| !kind.starts_with("run-tests"));
    run || lower.contains("playwright")
        || lower.contains("test:e2e")
        || lower.contains("npm run verify")
}

/// What the words of a part ask once its shells and runners are taken off (`core`).
fn core_weight(words: &[&String]) -> Option<Weight> {
    let first = words.first()?;
    let program = light::program_name(first);
    let rest: Vec<String> = words[1..].iter().map(|w| w.to_ascii_lowercase()).collect();
    if script(first) {
        let stem = program
            .rsplit_once('.')
            .map_or(program.as_str(), |(stem, _)| stem);
        if stem.starts_with("build") || stem == "runuat" {
            if rest.iter().any(|w| dry_run(w)) {
                return None;
            }
            if stem.starts_with("build") && rest.iter().any(|w| few_files(w)) {
                return Some(Weight::Light);
            }
            return Some(Weight::Build);
        }
        return RUN_SCRIPTS.contains(&stem).then_some(Weight::Run);
    }
    // `UnrealEditor.exe`, `UnrealEditor-Cmd.exe` and their DebugGame builds: a game, an editor,
    // a test run or a commandlet.
    if program.starts_with("unrealeditor") {
        return Some(Weight::Run);
    }
    let build = if BUILDERS.contains(&program.as_str()) || program == "runuat" {
        true
    } else if program == "cmake" {
        rest.iter().any(|w| w == "--build")
    } else if program == "dotnet" && rest.iter().any(|w| w.ends_with("unrealbuildtool.dll")) {
        // `dotnet ...UnrealBuildTool.dll`, as Build.bat and bluevox's script run it.
        true
    } else if matches!(
        program.as_str(),
        "npm" | "npx" | "pnpm" | "yarn" | "bun" | "bunx"
    ) {
        // `npm run tauri build`, `npx tauri build`, `cargo tauri build`.
        rest.windows(2)
            .any(|pair| pair[0] == "tauri" && pair[1] == "build")
    } else {
        SUBCOMMANDS
            .iter()
            .find(|(name, _)| *name == program)
            .is_some_and(|(_, subcommands)| {
                rest.iter()
                    // `cargo +nightly build`, `cargo -q test`.
                    .find(|w| !w.starts_with('-') && !w.starts_with('+'))
                    .is_some_and(|sub| subcommands.contains(&sub.as_str()))
            })
    };
    build.then_some(Weight::Build)
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

    /// Whether `command` builds, a few files or many.
    fn is_build(command: &str) -> bool {
        matches!(weight(command), Some(Weight::Build | Weight::Light))
    }

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
    fn commands_weigh_as_builds_builds_of_a_few_files_or_runs() {
        for (command, expected) in [
            (r".\Tools\Build.ps1 -Candidate", Some(Weight::Build)),
            (
                r#"& "D:\p\Tools\Build.ps1" -Target Bluevox"#,
                Some(Weight::Build),
            ),
            // A dry run builds nothing (requested 2026-11-26: the gate held `-WhatIf` twice).
            (r".\Tools\Build.ps1 -Candidate -WhatIf", None),
            (r"& .\Tools\Build.ps1 -WhatIf:$true", None),
            (r".\Tools\Build.ps1 -WhatIf:$false", Some(Weight::Build)),
            (r".\Tools\Build.ps1 -Check", Some(Weight::Light)),
            (
                r#"& "D:\p\Tools\Build.ps1" -SingleFile "D:\p\Source\A.cpp""#,
                Some(Weight::Light),
            ),
            (
                r"powershell -NoProfile -File .\Tools\Run-Tests.ps1 -Filter Bluevox.Water",
                Some(Weight::Run),
            ),
            (
                r#"& "D:\p\Tools\Run-Game.ps1" -Mode net -HostTimeline h.txt"#,
                Some(Weight::Run),
            ),
            (r".\Tools\Run-Editor.ps1 -Game", Some(Weight::Run)),
            (
                r#"& "D:\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "D:\p\Bluevox.uproject" -run=pythonscript"#,
                Some(Weight::Run),
            ),
            // The heaviest of several.
            (
                r".\Tools\Run-Tests.ps1; .\Tools\Build.ps1 -Check",
                Some(Weight::Run),
            ),
            (
                r".\Tools\Build.ps1 -Check; .\Tools\Build.ps1",
                Some(Weight::Build),
            ),
            (r".\Tools\Release-Worktree.ps1", None),
            ("git status", None),
        ] {
            assert_eq!(weight(command), expected, "{command}");
        }
        assert!(is_build(r".\Tools\Build.ps1 -Check"));
        assert!(!is_build(r".\Tools\Run-Game.ps1"));
    }

    #[test]
    fn work_is_granted_memory_it_holds_and_what_starts_beside_it_needs_room() {
        let admits = |weight, running, granted, available, since, need| {
            admits_weight(weight, running, granted, available, 32, since, need)
        };
        // A build: what is left after a few gigabytes, between one compiler and eight.
        assert_eq!(grant(Weight::Build, Some(20 << 30), RUN_FREE), 17 << 30);
        assert_eq!(grant(Weight::Build, Some(2 << 30), RUN_FREE), COMPILER);
        assert_eq!(grant(Weight::Build, Some(90 << 30), RUN_FREE), GRANT_MOST);
        assert_eq!(grant(Weight::Build, None, RUN_FREE), GRANT_MOST);
        // A build of a few files: up to two compilers; a run, what it needs.
        assert_eq!(grant(Weight::Light, Some(40 << 30), RUN_FREE), LIGHT_GRANT);
        assert_eq!(grant(Weight::Run, Some(40 << 30), RUN_FREE), RUN_FREE);
        assert_eq!(grant(Weight::Run, Some(40 << 30), 3 << 30), 3 << 30);
        // A run or a build of a few files needs room of its own beside granted work...
        assert!(!admits(Weight::Run, 1, true, Some(6 << 30), None, RUN_FREE));
        assert!(admits(Weight::Run, 1, true, Some(9 << 30), None, RUN_FREE));
        // ...as much as its kind took lately (requested 2026-11-27).
        assert!(admits(Weight::Run, 1, true, Some(4 << 30), None, 3 << 30));
        assert!(!admits(
            Weight::Light,
            1,
            true,
            Some(3 << 30),
            None,
            RUN_FREE
        ));
        assert!(admits(
            Weight::Light,
            4,
            true,
            Some(5 << 30),
            None,
            RUN_FREE
        ));
        // ...but none when nothing granted holds memory, and never a slot or the ramp.
        assert!(admits(Weight::Run, 0, false, Some(1 << 30), None, RUN_FREE));
        assert!(admits(
            Weight::Light,
            4,
            true,
            Some(5 << 30),
            Some(Duration::ZERO),
            RUN_FREE
        ));
        // A build as before.
        assert!(admits(
            Weight::Build,
            0,
            true,
            Some(1 << 30),
            None,
            RUN_FREE
        ));
        assert!(!admits(
            Weight::Build,
            1,
            true,
            Some(6 << 30),
            None,
            RUN_FREE
        ));
    }

    #[test]
    fn a_run_needs_what_its_kind_took_lately_and_a_build_waits_a_while_for_two_compilers() {
        // Before any peak, the room every run asked; after, the most it took and some spare.
        assert_eq!(run_need(&[]), RUN_FREE);
        assert_eq!(
            run_need(&[2 << 30, 3 << 30]),
            (3 << 30) + (3 << 28) + (512 << 20)
        );
        assert_eq!(run_need(&[100 << 20]), RUN_LEAST);
        assert_eq!(run_need(&[40 << 30]), RUN_MOST);
        // A build granted one compiler waits for two while other work holds memory, for a while.
        assert!(waits_for_more(COMPILER, true, Duration::ZERO));
        assert!(!waits_for_more(COMPILER, true, FEW_WAIT));
        assert!(!waits_for_more(COMPILER, false, Duration::ZERO));
        assert!(!waits_for_more(FEW, true, Duration::ZERO));
    }

    #[test]
    fn runs_of_one_kind_share_a_signature_and_only_some_of_them_render() {
        for (command, expected) in [
            (
                r#"& "D:\p\Tools\Run-Tests.ps1" -Filter Bluevox.Persistence.TearDownSave -Name red"#,
                Some("run-tests -filter"),
            ),
            (
                r"powershell -NoProfile -File .\Tools\Run-Tests.ps1 -Name ExitSave-candidate",
                Some("run-tests"),
            ),
            (
                r#"& "D:\p\Tools\Run-Game.ps1" -Mode net -HostTimeline h.txt -Name x"#,
                Some("run-game -mode net"),
            ),
            (
                r#"& "D:\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "D:\p\Bluevox.uproject" L_Empty -server -log "-abslog=D:\x.log""#,
                Some("unrealeditor-cmd -server"),
            ),
            (
                r#"UnrealEditor-Cmd.exe p.uproject -run=pythonscript -script=x.py"#,
                Some("unrealeditor-cmd -run pythonscript"),
            ),
            (r".\Tools\Build.ps1 -Candidate", None),
            ("git status", None),
        ] {
            assert_eq!(signature(command).as_deref(), expected, "{command}");
        }
        // A run's name, log or port never splits its kind.
        assert_eq!(
            signature(r".\Tools\Run-Tests.ps1 -Filter A -Name one"),
            signature(r".\Tools\Run-Tests.ps1 -Name two -Filter B")
        );
        for command in [
            r".\Tools\Run-Editor.ps1 -Game",
            r#"& "D:\p\Tools\Run-Net.ps1" -Mode net -HostNullRHI"#,
            "UnrealEditor.exe p.uproject -game",
            "npx playwright test tests/e2e",
            "npm run verify",
        ] {
            assert!(renders(command), "{command}");
        }
        for command in [
            r".\Tools\Run-Tests.ps1 -Filter Bluevox.Water",
            "UnrealEditor-Cmd.exe p.uproject 127.0.0.1:7777 -game -NullRHI",
            r".\Tools\Build.ps1 -Candidate",
            "cargo test",
            "git commit -m x",
        ] {
            assert!(!renders(command), "{command}");
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
            ..Default::default()
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
