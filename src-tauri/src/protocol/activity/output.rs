//! Commands, inputs and results of tool calls. A command and input travel with the activity
//! record, shortened there when long; the result, and the complete command or input, go to
//! the executing computer's store (`crate::tool_output`) whole. Only the result's size and
//! exit status reach the activity, since outputs and images are far too large for the
//! synced workspace.
use super::*;

/// Characters of a command shown in the activity record; the store keeps all of it.
pub(super) const COMMAND_LIMIT: usize = 8_000;
/// Characters of a tool input shown in the activity record; the store keeps all of it.
pub(super) const INPUT_LIMIT: usize = 4_000;
pub const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// What the activity record says about a result kept on the executing computer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSummary {
    /// Lines of text, counting standard output and error.
    pub lines: u64,
    /// UTF-8 bytes of text.
    pub bytes: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub images: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stderr: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// The provider shortened what it returned, such as a file search's match list.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}
fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Clone, Debug, PartialEq)]
pub enum ImageSource {
    /// Base64 bytes the provider returned with the result.
    Base64 { media_type: String, data: String },
    /// A file the provider reported viewing, copied when the result is stored.
    File { path: String },
}

/// A result waiting to be stored on the executing computer, exactly as the provider sent it.
#[derive(Clone, Debug, PartialEq)]
pub struct CapturedOutput {
    pub tool_id: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub exit_code: Option<i64>,
    /// The first line number of file content, when the text is a file read.
    pub start_line: Option<u64>,
    pub images: Vec<ImageSource>,
    /// The complete command or input when the activity record shows a shortened one.
    pub command: Option<String>,
    pub input: Option<String>,
}
impl CapturedOutput {
    pub(crate) fn new(tool_id: &str) -> Self {
        Self {
            tool_id: tool_id.into(),
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            exit_code: None,
            start_line: None,
            images: vec![],
            command: None,
            input: None,
        }
    }
    fn summary(&self) -> OutputSummary {
        OutputSummary {
            lines: line_count(&self.stdout) + line_count(&self.stderr),
            bytes: (self.stdout.len() + self.stderr.len()) as u64,
            images: self.images.len() as u32,
            stderr: !self.stderr.is_empty(),
            exit_code: self.exit_code,
            truncated: self.truncated,
        }
    }
}
/// Lines of terminal text: each line ending, plus a final unterminated line.
fn line_count(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let endings = text.bytes().filter(|b| *b == b'\n').count() as u64;
    endings + u64::from(!text.ends_with('\n'))
}

/// Normalizes terminal text for display: CRLF endings, carriage-return progress redraws,
/// ANSI escape sequences and other control characters. Tabs and newlines remain.
pub(crate) fn terminal_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    let mut line_start = 0;
    // A lone carriage return redraws its line, as progress output does: the next printed
    // character replaces the line, and a line ending keeps it.
    let mut redraw = false;
    while let Some(c) = chars.next() {
        if redraw && !c.is_control() || c == '\t' {
            if redraw {
                out.truncate(line_start);
            }
            redraw = false;
        }
        match c {
            '\u{1b}' => match chars.peek() {
                // CSI: parameters and intermediates, then one final byte.
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC and string sequences end with BEL or ESC \.
                Some(']' | 'P' | '_' | '^' | 'X') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\r' if chars.peek() == Some(&'\n') => {}
            '\r' => redraw = true,
            '\n' => {
                out.push('\n');
                line_start = out.len();
                redraw = false;
            }
            '\t' => out.push('\t'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Cuts a string to `limit` characters, reporting whether anything was removed.
pub(super) fn shortened(value: &str, limit: usize) -> (String, bool) {
    let cleaned = clean(value, limit + 1);
    if cleaned.chars().count() > limit {
        (cleaned.chars().take(limit).collect(), true)
    } else {
        (cleaned, false)
    }
}

/// Words of a quoted command line. Single quotes are literal; double quotes take `\` escapes
/// before `"`, `\`, `$` and backquote, as the Codex app-server writes them. Unquoted
/// backslashes stay literal for Windows paths.
fn words(command: &str, limit: usize) -> Option<Vec<String>> {
    let mut words = vec![];
    let mut current = String::new();
    let mut in_word = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => current.push(c),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => match chars.next()? {
                            c @ ('"' | '\\' | '$' | '`') => current.push(c),
                            c => {
                                current.push('\\');
                                current.push(c);
                            }
                        },
                        c => current.push(c),
                    }
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                    if words.len() > limit {
                        return None;
                    }
                }
            }
            c => {
                in_word = true;
                current.push(c);
            }
        }
    }
    if in_word {
        words.push(current);
    }
    Some(words)
}

/// The script a shell wrapper runs and the shell's name, or the command unchanged. Codex
/// reports `"…\powershell.exe" -Command '<script>'` or `/bin/bash -lc '<script>'`.
pub(super) fn unwrap_shell(command: &str) -> (Option<&'static str>, String) {
    let unchanged = (None, command.to_string());
    let Some(words) = words(command, 64) else {
        return unchanged;
    };
    let Some(first) = words.first() else {
        return unchanged;
    };
    let name = first
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(first)
        .to_ascii_lowercase();
    let shell = match name.strip_suffix(".exe").unwrap_or(&name) {
        "pwsh" | "powershell" => "powershell",
        "bash" => "bash",
        "sh" | "dash" => "sh",
        "zsh" => "zsh",
        "cmd" => "cmd",
        _ => return unchanged,
    };
    for (index, word) in words.iter().enumerate().skip(1) {
        let flag = word.to_ascii_lowercase();
        let script = match shell {
            "powershell" => matches!(flag.as_str(), "-command" | "-c"),
            "cmd" => flag == "/c",
            _ => flag.starts_with('-') && !flag.starts_with("--") && flag.contains('c'),
        };
        if script {
            let rest = &words[index + 1..];
            return match (shell, rest) {
                (_, []) => unchanged,
                ("cmd", rest) => (Some(shell), rest.join(" ")),
                (_, [script, ..]) => (Some(shell), script.clone()),
            };
        }
        if !(flag.starts_with('-') || flag.starts_with('/')) {
            break;
        }
    }
    unchanged
}

/// Pretty JSON of a tool's arguments.
pub(super) fn input_text(value: &Value) -> Option<String> {
    if value.is_null() || value.as_object().is_some_and(|o| o.is_empty()) {
        return None;
    }
    let text = match value.as_str() {
        Some(text) => text.to_string(),
        None => serde_json::to_string_pretty(value).ok()?,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// Text and images of a provider result: a string, or an array of content blocks in the
/// Claude/MCP (`text`, `image` with base64 `source` or `data`) and Codex dynamic tool
/// (`inputText`, `inputImage` data URL) shapes.
pub(super) fn result_parts(value: &Value) -> (String, Vec<ImageSource>) {
    if let Some(text) = value.as_str() {
        return (text.into(), vec![]);
    }
    let mut text = String::new();
    let mut images = vec![];
    for block in value.as_array().into_iter().flatten() {
        match block["type"].as_str().unwrap_or_default() {
            "text" | "inputText" => {
                if let Some(part) = block["text"].as_str() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(part);
                }
            }
            "image" => {
                let (media_type, data) = if block["source"]["type"] == "base64" {
                    (&block["source"]["media_type"], &block["source"]["data"])
                } else {
                    (&block["mimeType"], &block["data"])
                };
                if let Some(image) = base64_image(media_type.as_str(), data.as_str()) {
                    images.push(image);
                }
            }
            "inputImage" => {
                if let Some(image) = block["imageUrl"].as_str().and_then(data_url_image) {
                    images.push(image);
                }
            }
            _ => {}
        }
    }
    (text, images)
}
fn base64_image(media_type: Option<&str>, data: Option<&str>) -> Option<ImageSource> {
    let media_type = media_type?.to_ascii_lowercase();
    let data = data?;
    (IMAGE_TYPES.contains(&media_type.as_str()) && !data.is_empty()).then(|| ImageSource::Base64 {
        media_type,
        data: data.into(),
    })
}
fn data_url_image(url: &str) -> Option<ImageSource> {
    let (header, data) = url.strip_prefix("data:")?.split_once(',')?;
    let media_type = header.strip_suffix(";base64")?;
    base64_image(Some(media_type), Some(data))
}

/// The exit code Claude's shell tools report on the first line of a failed result.
pub(super) fn claude_exit_code(text: &str) -> Option<(i64, &str)> {
    let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
    let code = first.trim().strip_prefix("Exit code ")?.parse().ok()?;
    Some((code, rest))
}

/// Removes the `<tool_use_error>` envelope Claude puts around errors raised before a tool ran.
pub(super) fn claude_error_text(text: &str) -> &str {
    text.trim()
        .strip_prefix("<tool_use_error>")
        .and_then(|t| t.strip_suffix("</tool_use_error>"))
        .unwrap_or(text)
}

impl ToolDecoder {
    /// Records a shell call's command, shortened in the activity record when long; the
    /// complete command then goes to the store with the call's result.
    pub(super) fn set_command(
        &mut self,
        tool: &mut ToolActivity,
        command: &str,
        shell: Option<&'static str>,
    ) {
        let (short, truncated) = shortened(command, COMMAND_LIMIT);
        if short.trim().is_empty() {
            return;
        }
        tool.command = Some(short);
        tool.command_truncated = truncated;
        tool.shell = shell;
        Self::remember(
            &mut self.full_commands,
            &tool.id,
            truncated.then_some(command),
        );
    }
    /// Records a tool's arguments, shortened in the activity record when long.
    pub(super) fn set_input(&mut self, tool: &mut ToolActivity, value: &Value) {
        let Some(text) = input_text(value) else {
            return;
        };
        let (short, truncated) = shortened(&text, INPUT_LIMIT);
        tool.input = Some(short);
        tool.input_truncated = truncated;
        Self::remember(&mut self.full_inputs, &tool.id, truncated.then_some(&text));
    }
    fn remember(map: &mut HashMap<String, String>, id: &str, full: Option<&str>) {
        match full {
            Some(full) if map.len() < 256 || map.contains_key(id) => {
                map.insert(id.into(), clean(full, usize::MAX));
            }
            Some(_) => {}
            None => {
                map.remove(id);
            }
        }
    }

    /// Queues a result for the executing computer's store and records its summary.
    pub(super) fn capture(&mut self, tool: &mut ToolActivity, mut output: CapturedOutput) {
        output.command = self.full_commands.remove(&tool.id);
        output.input = self.full_inputs.remove(&tool.id);
        tool.output = Some(output.summary());
        if output.stdout.is_empty()
            && output.stderr.is_empty()
            && output.images.is_empty()
            && output.command.is_none()
            && output.input.is_none()
        {
            return;
        }
        self.captured.retain(|o| o.tool_id != output.tool_id);
        self.captured.push(output);
    }

    /// Results decoded since the last call, for the executing computer's store.
    pub fn take_outputs(&mut self) -> Vec<CapturedOutput> {
        std::mem::take(&mut self.captured)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_text_drops_escapes_and_keeps_the_last_progress_redraw() {
        let raw = "\u{1b}[32mok\u{1b}[0m line\r\nDownloading 10%\rDownloading 100%\n\u{1b}]0;title\u{7}done\u{1}\tend\nkept\r";
        assert_eq!(
            terminal_text(raw),
            "ok line\nDownloading 100%\ndone\tend\nkept"
        );
        assert_eq!(
            [
                line_count(""),
                line_count("a"),
                line_count("a\n"),
                line_count("a\r\nb")
            ],
            [0, 1, 1, 2]
        );
    }

    #[test]
    fn codex_shell_wrappers_unwrap_to_their_scripts() {
        for (command, shell, script) in [
            (
                "\"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'git status'",
                Some("powershell"),
                "git status",
            ),
            (
                "\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command \"node \\\"hook.cjs\\\"\nWrite-Output 'it''s'\"",
                Some("powershell"),
                "node \"hook.cjs\"\nWrite-Output 'it''s'",
            ),
            ("/bin/bash -lc 'ls -la | head'", Some("bash"), "ls -la | head"),
            ("bash -l -c \"echo \\$HOME\"", Some("bash"), "echo $HOME"),
            ("cmd.exe /c dir /b", Some("cmd"), "dir /b"),
            ("git status", None, "git status"),
            ("pwsh -NoProfile", None, "pwsh -NoProfile"),
            ("powershell -Command 'unterminated", None, "powershell -Command 'unterminated"),
        ] {
            assert_eq!(unwrap_shell(command), (shell, script.to_string()), "{command}");
        }
    }

    #[test]
    fn result_parts_split_text_from_supported_images_only() {
        let (text, images) = result_parts(&json!([
            {"type":"text","text":"first"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}},
            {"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"PHN2Zz4="}},
            {"type":"image","data":"R0lGODlh","mimeType":"image/gif"},
            {"type":"inputImage","imageUrl":"data:image/webp;base64,UklGRg=="},
            {"type":"inputImage","imageUrl":"https://example.com/remote.png"},
            {"type":"inputText","text":"second"}
        ]));
        assert_eq!(text, "first\nsecond");
        assert_eq!(images.len(), 3);
        assert!(
            matches!(&images[0], ImageSource::Base64 { media_type, .. } if media_type == "image/png")
        );
        assert_eq!(result_parts(&json!("plain")).0, "plain");
    }

    fn claude_call(d: &mut ToolDecoder, id: &str, name: &str, input: Value) {
        d.decode("claude", &json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}));
    }
    fn claude_result(
        d: &mut ToolDecoder,
        id: &str,
        error: bool,
        content: Value,
        result: Value,
    ) -> ToolActivity {
        d.decode("claude", &json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":error,"content":content}]},"tool_use_result":result})).remove(0)
    }

    #[test]
    fn claude_shell_results_keep_streams_exit_codes_and_git_operations() {
        let mut d = ToolDecoder::default();
        claude_call(
            &mut d,
            "ok",
            "Bash",
            json!({"command":"git commit -m fix","description":"Commit the fix"}),
        );
        let ok = claude_result(
            &mut d,
            "ok",
            false,
            json!("[main 1a2b3c4] fix"),
            json!({"stdout":"[main 1a2b3c4] fix\n","stderr":"hint: x\n","interrupted":false,"gitOperation":{"commit":{"sha":"1a2b3c4d5e6f","kind":"commit","branch":"main"}}}),
        );
        assert_eq!(ok.command.as_deref(), Some("git commit -m fix"));
        let summary = ok.output.clone().unwrap();
        assert_eq!(
            (summary.lines, summary.exit_code, summary.stderr),
            (2, Some(0), true)
        );
        assert!(ok
            .facts
            .iter()
            .any(|f| f.label == "Git" && f.value == "Committed 1a2b3c4 on main"));
        claude_call(
            &mut d,
            "bad",
            "PowerShell",
            json!({"command":"npm test","description":"Run tests"}),
        );
        let bad = claude_result(
            &mut d,
            "bad",
            true,
            json!("Exit code 1\nFAIL src/a.test.ts"),
            json!("Error: Exit code 1"),
        );
        assert_eq!(bad.status, "error");
        assert_eq!(bad.shell, Some("powershell"));
        // The description stays; the failure's output explains it.
        assert_eq!(bad.detail.as_deref(), Some("Run tests"));
        assert_eq!(bad.output.as_ref().unwrap().exit_code, Some(1));
        claude_call(&mut d, "grep", "Bash", json!({"command":"rg missing"}));
        let none = claude_result(
            &mut d,
            "grep",
            false,
            json!(""),
            json!({"stdout":"","stderr":"","interrupted":false,"returnCodeInterpretation":"No matches found"}),
        );
        assert_eq!(none.output.as_ref().unwrap().exit_code, None);
        assert!(none.facts.iter().any(|f| f.value == "No matches found"));
        let outputs = d.take_outputs();
        assert_eq!(outputs.len(), 2);
        assert_eq!(
            (outputs[0].stdout.as_str(), outputs[0].stderr.as_str()),
            ("[main 1a2b3c4] fix\n", "hint: x\n")
        );
        assert_eq!(
            (outputs[1].stdout.as_str(), outputs[1].exit_code),
            ("FAIL src/a.test.ts", Some(1))
        );
    }

    #[test]
    fn claude_image_reads_mcp_tools_and_web_pages_keep_their_results() {
        let mut d = ToolDecoder::default();
        claude_call(
            &mut d,
            "shot",
            "Read",
            json!({"file_path":"C:/tmp/screen.png"}),
        );
        assert_eq!(d.tools[0].name, "View image");
        let png = json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]);
        let shot = claude_result(
            &mut d,
            "shot",
            false,
            png,
            json!({"type":"image","file":{"base64":"iVBORw0KGgo=","type":"image/png"}}),
        );
        assert_eq!(shot.operation.as_deref(), Some("viewImage"));
        assert_eq!(shot.output.as_ref().unwrap().images, 1);
        claude_call(
            &mut d,
            "mcp",
            "mcp__browser__take_screenshot",
            json!({"fullPage":true}),
        );
        assert_eq!(
            d.tools[1].input.as_deref(),
            Some("{\n  \"fullPage\": true\n}")
        );
        claude_result(
            &mut d,
            "mcp",
            false,
            json!([{"type":"text","text":"Captured"},{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"/9j/4AAQ"}}]),
            Value::Null,
        );
        claude_call(
            &mut d,
            "viz",
            "mcp__agent_studio__visualize",
            json!({"html":"<p>kept elsewhere</p>"}),
        );
        assert!(d.tools[2].input.is_none());
        claude_result(&mut d, "viz", false, json!("Shown"), Value::Null);
        claude_call(
            &mut d,
            "page",
            "WebFetch",
            json!({"url":"https://example.com/","prompt":"Summarize it"}),
        );
        let page = claude_result(
            &mut d,
            "page",
            false,
            json!("summary"),
            json!({"code":200,"codeText":"OK","result":"Example summary","url":"https://example.com/"}),
        );
        assert!(page
            .facts
            .iter()
            .any(|f| f.label == "Prompt" && f.value == "Summarize it"));
        assert!(page
            .facts
            .iter()
            .any(|f| f.label == "HTTP status" && f.value == "200 OK"));
        let outputs = d.take_outputs();
        assert_eq!(
            outputs
                .iter()
                .map(|o| o.tool_id.as_str())
                .collect::<Vec<_>>(),
            ["claude:shot", "claude:mcp", "claude:page"]
        );
        assert_eq!(
            (outputs[1].stdout.as_str(), outputs[1].images.len()),
            ("Captured", 1)
        );
        assert_eq!(outputs[2].stdout, "Example summary");
    }

    #[test]
    fn codex_commands_image_views_and_tools_record_what_they_ran_and_returned() {
        let mut d = ToolDecoder::default();
        let command = "\"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'node \"C:/hooks/context-hook.cjs\" --record-cwd abc\ngit --version'";
        let done = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"type":"commandExecution","id":"cmd","command":command,"cwd":"C:\\work","status":"completed","commandActions":[{"type":"unknown","command":"git --version"}],"aggregatedOutput":"\u{1b}[1mgit version 2.55\u{1b}[0m\r\n","exitCode":0,"durationMs":178}}}), "root");
        assert_eq!(
            done[0].command.as_deref(),
            Some("node \"C:/hooks/context-hook.cjs\" --record-cwd abc\ngit --version")
        );
        assert_eq!(done[0].shell, Some("powershell"));
        assert_eq!(done[0].output.as_ref().unwrap().exit_code, Some(0));
        let view = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"type":"imageView","id":"img","path":"C:\\work\\shot.png"}}}), "root");
        assert_eq!(
            (view[0].name.as_str(), view[0].status.as_str()),
            ("View image", "complete")
        );
        assert_eq!(view[0].path.as_deref(), Some("C:\\work\\shot.png"));
        let mcp = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"type":"mcpToolCall","id":"m","server":"docs","tool":"search","status":"failed","arguments":{"q":"layout"},"result":null,"error":{"message":"Server offline"}}}}), "root");
        assert_eq!(mcp[0].input.as_deref(), Some("{\n  \"q\": \"layout\"\n}"));
        assert!(mcp[0].output.as_ref().unwrap().stderr);
        d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"type":"dynamicToolCall","id":"plan","tool":"studio_update_plan","arguments":{"steps":[]},"status":"completed","success":true,"contentItems":[{"type":"inputText","text":"ok"}]}}}), "root");
        let custom = d.codex_server(&json!({"method":"item/completed","params":{"threadId":"root","turnId":"t","item":{"type":"dynamicToolCall","id":"dyn","tool":"lookup","arguments":{"id":7},"status":"completed","success":true,"contentItems":[{"type":"inputText","text":"Found 7"}]}}}), "root");
        assert!(custom[0].input.is_some());
        let outputs = d.take_outputs();
        let ids: Vec<_> = outputs.iter().map(|o| o.tool_id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "codex:root:cmd",
                "codex:root:img",
                "codex:root:m",
                "codex:root:dyn"
            ]
        );
        // Results are kept exactly as the provider sent them and cleaned when shown.
        assert_eq!(outputs[0].stdout, "\u{1b}[1mgit version 2.55\u{1b}[0m\r\n");
        assert_eq!(
            outputs[1].images,
            [ImageSource::File {
                path: "C:\\work\\shot.png".into()
            }]
        );
        assert_eq!(outputs[2].stderr, "Server offline");
        assert_eq!(outputs[3].stdout, "Found 7");
    }

    #[test]
    fn large_results_and_long_commands_are_kept_whole() {
        let mut d = ToolDecoder::default();
        let heredoc = format!("cat > big.txt <<'EOF'\n{}EOF", "line\n".repeat(3000));
        claude_call(&mut d, "big", "Bash", json!({ "command": heredoc }));
        assert_eq!(
            d.tools[0].command.as_ref().map(|c| c.chars().count()),
            Some(COMMAND_LIMIT)
        );
        assert!(d.tools[0].command_truncated);
        let stdout = ("x".repeat(99) + "\n").repeat(50_000);
        let big = claude_result(
            &mut d,
            "big",
            false,
            json!(""),
            json!({"stdout":stdout,"stderr":""}),
        );
        let summary = big.output.unwrap();
        assert_eq!(
            (summary.lines, summary.bytes, summary.truncated),
            (50_000, 5_000_000, false)
        );
        let output = d.take_outputs().remove(0);
        assert_eq!(output.stdout.len(), 5_000_000);
        assert_eq!(output.command.as_deref(), Some(heredoc.as_str()));
        // A short command has nothing more to keep.
        claude_call(&mut d, "small", "Bash", json!({"command":"ls"}));
        claude_result(
            &mut d,
            "small",
            false,
            json!(""),
            json!({"stdout":"a\n","stderr":""}),
        );
        assert_eq!(d.take_outputs()[0].command, None);
        let images = json!((0..20).map(|_| json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}})).collect::<Vec<_>>());
        claude_call(&mut d, "shots", "mcp__browser__screenshots", json!({}));
        let shots = claude_result(&mut d, "shots", false, images, Value::Null);
        assert_eq!(shots.output.unwrap().images, 20);
    }

    #[test]
    fn claude_errors_report_exit_codes_and_drop_envelopes() {
        assert_eq!(
            claude_exit_code("Exit code 2\nboom\nmore"),
            Some((2, "boom\nmore"))
        );
        assert_eq!(claude_exit_code("Exit code x\nboom"), None);
        assert_eq!(
            claude_error_text("<tool_use_error>Blocked: no</tool_use_error>"),
            "Blocked: no"
        );
    }
}
