//! Commands light enough to run while another chat measures this computer (chosen 2026-11-24):
//! reading files, listing folders, searching text and asking Git about the checkout, which end
//! in moments and use next to no CPU. Anything else, an unknown program included, waits. The
//! test is about load, not side effects, and leans towards waiting: a command substitution or a
//! program this list does not name makes the whole command wait. A script block does too, unless
//! it is one a loop or a filter runs for each item and every statement in it is light (requested
//! 2026-11-27, after a PowerShell loop that only read files waited out a measurement), and so is
//! a PowerShell variable set to a light command or to a read-only .NET call.

/// Programs that only read or print, by the name a command line calls them.
const PROGRAMS: &[&str] = &[
    "cat", "cd", "date", "dir", "echo", "false", "file", "find", "grep", "head", "hostname",
    "less", "ls", "more", "popd", "printf", "pushd", "pwd", "readlink", "realpath", "rg", "sort",
    "stat", "tail", "test", "tr", "true", "type", "uname", "uniq", "wc", "where", "which",
    "whoami", // PowerShell's own aliases of the same.
    "cls", "gc", "gci", "gi", "gl", "pwd", "sl", "sls", "select",
];
/// PowerShell cmdlets that only read, look up or format: their verb or their whole name. A loop's
/// or a filter's own cmdlet is light once its block is (`without_blocks`).
const CMDLETS: &[&str] = &[
    "%",
    "?",
    "foreach",
    "foreach-object",
    "where",
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
    // What a substitution, a backtick or a program a variable holds runs cannot be told from here.
    if ["$(", "`", "<(", ">(", "Invoke-", "iex"]
        .iter()
        .any(|mark| command.contains(mark))
        || calls_a_variable(command)
    {
        return false;
    }
    let Some(flat) = without_blocks(command) else {
        return false;
    };
    let parts = parts(&flat);
    !parts.is_empty() && parts.iter().all(|part| light_part(part))
}

/// Whether `&` runs what a variable holds, `& $exe build`, which names no program this can judge.
fn calls_a_variable(command: &str) -> bool {
    command
        .match_indices('&')
        .any(|(at, _)| command[at + 1..].trim_start().starts_with('$'))
}

/// Cmdlets, by the names a command line calls them, that run their block for each item they are
/// given, as a filter, a loop or a sort key.
const BLOCK_OWNERS: &[&str] = &[
    "%",
    "?",
    "foreach",
    "foreach-object",
    "sort-object",
    "where",
    "where-object",
];

/// `command` with its script blocks taken out once each reads as light: the block a
/// `ForEach-Object` or a `Where-Object` runs for each item (`%`, `?`, `foreach` and `where` too),
/// and a `foreach (...)` loop's with its head, each of whose statements is itself light. None
/// when a block is anything else, such as an `if`, a function or a hashtable, or holds what is not
/// light, or when its braces do not match.
fn without_blocks(command: &str) -> Option<String> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            out.push(c);
            index += 1;
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                out.push(c);
                index += 1;
                continue;
            }
            '}' => return None,
            '{' => {}
            _ => {
                out.push(c);
                index += 1;
                continue;
            }
        }
        let end = matching_brace(&chars, index)?;
        let body: String = chars[index + 1..end].iter().collect();
        if !body.trim().is_empty() && !is_light(&body) {
            return None;
        }
        let before = out.trim_end();
        if let Some(head) = before.strip_suffix(')') {
            // `foreach ($item in $list) { ... }`: its head and block go once both read as light,
            // and its keyword stays, light itself, for the statement to have a word.
            let open = head.rfind('(')?;
            let (word, inside) = (head[..open].trim_end(), &head[open + 1..]);
            let keyword = word.rsplit(char::is_whitespace).next().unwrap_or(word);
            if !keyword.eq_ignore_ascii_case("foreach") || !light_loop_head(inside) {
                return None;
            }
            let kept = word.len();
            out.truncate(kept);
        } else {
            let owner = before.rsplit(char::is_whitespace).next().unwrap_or(before);
            if !BLOCK_OWNERS.contains(&owner.to_ascii_lowercase().as_str()) {
                return None;
            }
        }
        index = end + 1;
    }
    quote.is_none().then_some(out)
}

/// Where the block opened at `open` closes, braces inside quotes left alone.
fn matching_brace(chars: &[char], open: usize) -> Option<usize> {
    let (mut depth, mut quote) = (0usize, None);
    for (index, &c) in chars.iter().enumerate().skip(open) {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

/// A `foreach` loop's head, `$item in what`, that runs nothing heavy: what it walks is a variable,
/// a list of quoted words, or a light command.
fn light_loop_head(inside: &str) -> bool {
    // Lower case keeps every byte where it was, so where ` in ` stands holds in `inside` too.
    let Some(at) = inside.to_ascii_lowercase().find(" in ") else {
        return false;
    };
    let (item, what) = (inside[..at].trim(), inside[at + 4..].trim());
    let variable = |text: &str| {
        text.strip_prefix('$').is_some_and(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':'))
        })
    };
    variable(item)
        && (variable(what) || quoted_list(what) || (!what.contains('(') && is_light(what)))
}

/// `'a', "b"`: quoted words separated by commas, which name things rather than run them.
fn quoted_list(text: &str) -> bool {
    let mut quote = None;
    let mut inside_any = false;
    for c in text.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                inside_any = true;
            }
            None if c == ',' || c.is_whitespace() => {}
            None => return false,
        }
    }
    quote.is_none() && inside_any
}

/// .NET members a PowerShell line may call that only read or compute, by how the call begins.
const READ_ONLY_CALLS: &[&str] = &[
    "[io.file]::readall",
    "[system.io.file]::readall",
    "[io.file]::exists",
    "[system.io.file]::exists",
    "[io.directory]::exists",
    "[system.io.directory]::exists",
    "[io.path]::",
    "[system.io.path]::",
    "[regex]::",
    "[math]::",
    "[string]::",
    "[convert]::",
    "[text.encoding]::",
    "[system.text.encoding]::",
    "[datetime]::",
    "[datetimeoffset]::",
    "[timespan]::",
];

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

/// PowerShell's comparison and format operators, which a statement reading a variable may apply.
const OPERATORS: &[&str] = &[
    "-and",
    "-as",
    "-contains",
    "-eq",
    "-f",
    "-ge",
    "-gt",
    "-in",
    "-is",
    "-isnot",
    "-join",
    "-le",
    "-like",
    "-lt",
    "-match",
    "-ne",
    "-not",
    "-notcontains",
    "-notin",
    "-notlike",
    "-notmatch",
    "-or",
    "-replace",
    "-split",
];

/// A statement that only reads a variable, as a loop's or a filter's block does: `$_.FullName`,
/// `$_.Length -gt 100`, `$_ -match 'error'`. A bare `$name` is not one, since a POSIX shell runs
/// the program it holds, nor is a path built on one (`$UE/Build.bat`), nor a method's call.
fn reads_a_variable(words: &[String]) -> bool {
    let Some((first, rest)) = words.split_first() else {
        return false;
    };
    let property = first
        .strip_prefix('$')
        .and_then(|name| name.split_once('.'))
        .is_some_and(|(name, member)| !name.is_empty() && !member.is_empty());
    (first == "$_" || property)
        && !first.contains(['/', '\\'])
        && !words.iter().any(|word| word.contains('('))
        && rest
            .first()
            .is_none_or(|operator| OPERATORS.contains(&operator.to_ascii_lowercase().as_str()))
}

fn light_part(words: &[String]) -> bool {
    // A PowerShell variable set to what follows: `$text = Get-Content log.txt -Raw`.
    let words = match words {
        [name, equals, rest @ ..] if name.starts_with('$') && equals == "=" => rest,
        _ => words,
    };
    let Some(start) = words.iter().position(|word| !assignment(word)) else {
        // Only variable assignments.
        return true;
    };
    let words = &words[start..];
    let first = words[0].to_ascii_lowercase();
    if READ_ONLY_CALLS.iter().any(|call| first.starts_with(call)) || reads_a_variable(words) {
        return true;
    }
    let program = program_name(&words[0]);
    if program == "git" {
        // Options before the subcommand, such as -C path or --no-pager. `-C` takes a value.
        let mut rest = words[1..].iter().peekable();
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
    fn a_loop_or_a_filter_whose_block_only_reads_is_light_and_any_other_block_waits() {
        for command in [
            "Get-ChildItem *.log | ForEach-Object { Get-Content $_.FullName -Tail 5 }",
            "Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1000000 } | Select-Object FullName",
            "gci | ? { $_.Name -match '\\.log$' } | % { $_.FullName }",
            "foreach ($f in Get-ChildItem *.log) { Get-Content $f -Tail 3 }",
            "foreach ($name in 'a.txt', 'b.txt') { Test-Path $name }",
            "foreach ($f in $files) { Select-String -Path $f -Pattern TODO }; git status",
            "$text = Get-Content log.txt -Raw; $text.Length",
            "$lines = [IO.File]::ReadAllLines('log.txt'); $lines.Count",
            "Get-ChildItem | Sort-Object { $_.LastWriteTime } | Select-Object -Last 3",
            "git log --format='%h {%s}' -3",
        ] {
            assert!(is_light(command), "{command}");
        }
        for command in [
            "Get-ChildItem | ForEach-Object { & .\\build.ps1 }",
            "foreach ($p in $projects) { cargo build }",
            "if (Test-Path x) { Remove-Item x }",
            "Measure-Command { npm run verify }",
            "function f { ls }; f",
            "& $exe build",
            "$cmd = 'cargo build'; & $cmd",
            "UE=/d/UE; $UE/Build.bat Game Win64",
            "BUILD='cargo build'; $BUILD",
            "foreach ($f in (Get-Item x).Children) { cat $f }",
            "Get-ChildItem | ForEach-Object { $_.Delete() }",
            "Get-ChildItem | ForEach-Object { }  | ForEach-Object { make }",
            "echo ${HOME}",
            "ls }",
            "ls {",
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
