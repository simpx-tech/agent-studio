//! Commands light enough to run while another chat measures this computer (chosen 2026-11-24):
//! reading files, listing folders, searching text and asking Git about the checkout, which end
//! in moments and use next to no CPU. Anything else, an unknown program included, waits. The
//! test is about load, not side effects, and leans towards waiting: a command substitution, a
//! script block or a program this list does not name makes the whole command wait.

/// Programs that only read or print, by the name a command line calls them.
const PROGRAMS: &[&str] = &[
    "cat", "cd", "date", "dir", "echo", "false", "file", "find", "grep", "head", "hostname",
    "less", "ls", "more", "popd", "printf", "pushd", "pwd", "readlink", "realpath", "rg", "sort",
    "stat", "tail", "test", "tr", "true", "type", "uname", "uniq", "wc", "where", "which",
    "whoami", // PowerShell's own aliases of the same.
    "cls", "gc", "gci", "gi", "gl", "pwd", "sl", "sls", "select",
];
/// PowerShell cmdlets that only read, look up or format: their verb or their whole name.
const CMDLETS: &[&str] = &[
    "format-list",
    "format-table",
    "join-path",
    "measure-object",
    "out-string",
    "resolve-path",
    "select-object",
    "select-string",
    "set-location",
    "sort-object",
    "split-path",
    "test-path",
    "where-object",
    "write-host",
    "write-output",
];
/// Git asked about the checkout, never changing it nor running its hooks.
const GIT: &[&str] = &[
    "blame",
    "branch",
    "cat-file",
    "describe",
    "diff",
    "grep",
    "log",
    "ls-files",
    "ls-tree",
    "merge-base",
    "reflog",
    "remote",
    "rev-list",
    "rev-parse",
    "shortlog",
    "show",
    "show-ref",
    "status",
    "tag",
    "whatchanged",
];

/// Whether a line is one a CLI hook put before the agent's command, running a script under a
/// hooks folder, as `primaryCommand` in `src/lib/tool-presentation.ts` tells them: a Codex
/// `PreToolUse` hook may prepend one to every command it lets run.
pub fn hook_line(line: &str) -> bool {
    static LINE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    LINE.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)^(?:&\s*)?["']?(?:node|python3?|py|pwsh|powershell|bash|sh|deno|bun)(?:\.exe)?["']?\s+["']?[^"'\s]*[\\/]hooks?[\\/]"#,
        )
        .expect("the hook line pattern")
    })
    .is_match(line.trim())
}

/// Whether an MCP server's tools run elsewhere, so a call to one loads this computer no more than
/// a light command: claude.ai's connectors (`claude_ai_…` in Claude Code) and Codex's apps
/// (`codex_apps`). Every other server may drive a program here, as unreal-mcp drives an editor.
pub fn remote_server(server: &str) -> bool {
    server.starts_with("claude_ai_") || server == "codex_apps"
}

/// A command as its agent wrote it, without the lines CLI hooks put before it.
pub fn own(command: &str) -> String {
    command
        .lines()
        .filter(|line| !hook_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether every part of `command` is light. Parts are what `&&`, `||`, `;`, `|` and line
/// breaks separate.
pub fn is_light(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    // What a substitution, a script block or a backtick runs cannot be told from here.
    if ["$(", "`", "<(", ">(", "{", "Invoke-", "iex"]
        .iter()
        .any(|mark| command.contains(mark))
    {
        return false;
    }
    parts(command).iter().all(|part| light_part(part))
}

/// The parts of a command line, split where `&&`, `||`, `;`, `|` and line breaks stand outside
/// quotes, each as its words with quotes taken away.
pub(super) fn parts(command: &str) -> Vec<Vec<String>> {
    let (mut parts, mut words, mut word) = (vec![], vec![], String::new());
    let (mut quote, mut quoted) = (None, false);
    let end_word = |words: &mut Vec<String>, word: &mut String, quoted: &mut bool| {
        if *quoted || !word.is_empty() {
            words.push(std::mem::take(word));
        }
        *quoted = false;
    };
    for c in command.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                quoted = true;
            }
            None if matches!(c, '\n' | ';' | '|' | '&') => {
                end_word(&mut words, &mut word, &mut quoted);
                if !words.is_empty() {
                    parts.push(std::mem::take(&mut words));
                }
            }
            None if c.is_whitespace() => end_word(&mut words, &mut word, &mut quoted),
            None => word.push(c),
        }
    }
    end_word(&mut words, &mut word, &mut quoted);
    if !words.is_empty() {
        parts.push(words);
    }
    parts
}

fn light_part(words: &[String]) -> bool {
    let mut words = words.iter().skip_while(|word| assignment(word));
    let Some(program) = words.next().map(|word| program_name(word)) else {
        // Only variable assignments.
        return true;
    };
    if program == "git" {
        // Options before the subcommand, such as -C path or --no-pager. `-C` takes a value.
        let mut rest = words.peekable();
        while let Some(word) = rest.next_if(|word| word.starts_with('-')) {
            if word == "-C" || word == "-c" {
                rest.next();
            }
        }
        return rest.next().is_some_and(|sub| {
            let sub = sub.to_ascii_lowercase();
            GIT.contains(&sub.as_str())
                // A branch, tag or remote that lists rather than changes.
                && match sub.as_str() {
                    "branch" | "tag" | "remote" => rest.all(|word| {
                        word.starts_with('-')
                            && !matches!(
                                word.as_str(),
                                "-d" | "-D" | "-m" | "-M" | "-f" | "--delete" | "--move" | "--force"
                            )
                    }),
                    _ => true,
                }
        });
    }
    PROGRAMS.contains(&program.as_str())
        || CMDLETS.contains(&program.as_str())
        || program.starts_with("get-")
        || program.starts_with("format-")
}

/// `NAME=value`, which a POSIX shell sets for the command after it.
pub(super) fn assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// The program a word names: its file name without folders or `.exe`, in lower case.
pub(super) fn program_name(word: &str) -> String {
    let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let name = name.to_ascii_lowercase();
    name.strip_suffix(".exe").map(String::from).unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_a_cli_hook_put_before_the_command_is_not_the_agent_s() {
        // A user's Codex PreToolUse hook prepends one to every command it lets run.
        let command = "node \"C:/Users/u/.codex/hooks/claude-context/context-hook.cjs\" --record-cwd 2d2a\ngit status --short";
        assert!(hook_line(command.lines().next().unwrap()));
        assert_eq!(own(command), "git status --short");
        assert!(is_light(&own(command)));
        assert!(!is_light(command));
        for line in [
            "& node.exe C:\\x\\hooks\\gate.js",
            "python3 ~/.claude/hook/check.py",
            "bash ./hooks/pre.sh",
        ] {
            assert!(hook_line(line), "{line}");
        }
        for line in [
            "node build.js",
            "git status",
            "npm run hooks",
            "node scripts/webhooks.js",
        ] {
            assert!(!hook_line(line), "{line}");
        }
    }

    #[test]
    fn reading_listing_searching_and_asking_git_are_light() {
        for command in [
            "git status",
            "git -C /repo --no-pager log --oneline -5",
            "git diff --stat && git show HEAD:src/main.rs | head -40",
            "ls -la src; cat README.md",
            "rg -n \"fn main|struct Broker\" src | wc -l",
            "cd C:/work/game && git status",
            "Get-ChildItem -Recurse src | Select-Object -First 5",
            "Get-Content log.txt -Tail 20",
            "Select-String -Path *.log -Pattern error",
            "& \"C:\\Program Files\\Git\\bin\\git.exe\" status",
            "LANG=C grep -rn TODO .",
            "git branch --list",
            "git tag",
            "echo done",
            "find . -name '*.uproject'",
        ] {
            assert!(is_light(command), "{command}");
        }
    }

    #[test]
    fn builds_runs_unknown_programs_and_hidden_commands_wait() {
        for command in [
            "",
            "Build.bat BluevoxEditor Win64 Development -Project=game.uproject",
            "RunUAT.bat BuildCookRun -project=game.uproject",
            "UnrealEditor.exe game.uproject -game -benchmark",
            "cargo build --release",
            "npm run verify",
            "git status && cargo test",
            "git commit -m wip",
            "git push origin development",
            "git checkout main",
            "git branch -D old",
            "git tag -d v1",
            "ls $(cargo metadata)",
            "echo `make`",
            "Get-ChildItem | ForEach-Object { & .\\build.ps1 }",
            "Invoke-Expression $script",
            "iex (Get-Content run.ps1 -Raw)",
            "python bench.py",
            "sudo ls",
            "./bench.sh",
        ] {
            assert!(!is_light(command), "{command}");
        }
    }

    #[test]
    fn only_assignments_are_light_and_names_ignore_paths_and_case() {
        assert!(is_light("A=1 B=2"));
        assert_eq!(program_name("C:\\Tools\\RG.EXE"), "rg");
        assert_eq!(program_name("/usr/bin/git"), "git");
        assert!(assignment("FOO_1=bar") && !assignment("1A=b") && !assignment("=b"));
    }

    #[test]
    fn parts_split_outside_quotes_and_keep_quoted_words_whole() {
        assert_eq!(
            parts("rg \"a|b\" src && echo 'x; y' | wc"),
            vec![
                vec!["rg".to_string(), "a|b".into(), "src".into()],
                vec!["echo".into(), "x; y".into()],
                vec!["wc".into()],
            ]
        );
        assert_eq!(
            parts("echo \"\""),
            vec![vec!["echo".to_string(), String::new()]]
        );
        assert!(parts("  ;; ").is_empty());
    }
}
