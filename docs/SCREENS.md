# Screens

A screen is a lasting page a chat builds for you in Agent Studio: a dashboard, a tracker, a report you revisit or a small tool, with its own interface and the commands it may run on the computer that keeps it. Ask a Claude or Codex chat for one ("make a page of the pull requests I opened this week"), and it saves the screen with its `save_screen` tool. The reply shows a card that opens it, and the **Screens** tab of the sidebar lists every screen by computer, beside Active and History. `/screens` opens that tab.

## How a chat builds one

Claude and Codex chats of a saved conversation get three Agent Studio tools, Claude through the `agent_studio` SDK server (`mcp__agent_studio__save_screen`, `…list_screens`, `…read_screen`) and Codex as dynamic tools of the same names (`src-tauri/src/screens/tools.rs`):

- `save_screen` takes a `title` (80 characters), an optional one-line `description`, the page's `html` (512,000 bytes) and its `actions`, and returns the screen's id. Passing that `id` again replaces the screen with the complete new version. Only the conversation's own call reaches it: Claude's registered parent tool use, Codex's parent thread without a namespace; sub-agents' calls are refused.
- `list_screens` names the screens this computer keeps, their folders and actions, whether you allowed them and whether this conversation can update each one.
- `read_screen` returns one screen whole, with the values its page saved, so a later chat can change it.

The prompt mentions the tools only briefly; the `save_screen` description holds the page API below. A Codex thread keeps the dynamic tools it started with, so chats begun before this feature reach screens only in Claude (whose tool list is read when its process starts) or in a new Codex chat.

A saved screen belongs to the computer whose CLI ran the reply, and its actions run in that conversation's working folder: the project folder, or the Standalone chat's own folder. Both are recorded on that computer when the screen is created, never taken from a request, and an update keeps them. A screen of a WSL distribution runs its actions in that distribution and can be updated only from a chat there.

## The page

The page runs in the sandbox that shows artifacts and visualizations (`src/lib/artifact-preview.html`, served as `studio-artifact` on desktop and `/artifact-preview` by the relay): an opaque origin with `sandbox allow-scripts` and a CSP that blocks every network request, remote script, style, font and frame. Its document starts with the app's theme variables (`--foreground`, `--heading`, `--muted-foreground`, `--card`, `--border`, `--primary`, `--viz-series-1…6`, in the resolved light or dark theme), gentle defaults the page may override, and the bridge, then the page itself, a fragment or a whole document (`screenDocument` in `src/lib/screens.ts`). It fills the main area and scrolls by itself.

The page reaches Agent Studio only through the global `studio` object:

- `studio.run(name, params)` runs one of its actions and resolves to `{exitCode, stdout, stderr, truncated, timedOut, durationMs}`. It rejects when the action cannot run, such as before you allowed the screen's actions.
- `studio.json(name, params)` runs an action and parses its stdout, rejecting with its stderr when the exit code is not 0 or it stopped at its limit.
- `studio.load(key)` and `studio.save(key, value)` keep JSON values for this screen on its computer, 1 MB in all; saving `null` removes a value.
- `studio.chat(text)` opens a new conversation in the screen's folder with the text as its draft, which you send yourself. It works only while the screen's frame has focus, right after you clicked or typed in it, so a page cannot open chats by itself.
- `studio.theme` is `dark` or `light`, and `studio.screen` holds its id and title.

The window that shows the page checks every message (`screenCall`): it must come from that frame, carry the frame's token and be a known call with bounded values (an action name, at most 12 parameters and 64,000 characters of them, a 100-character key, a 1 MB value, an 8,000-character chat). A frame may wait for eight answers at once; more are refused. A reloaded or closed frame is never answered.

## Actions and their approval

Each action declares `name`, `description`, `shell`, `script`, `params` and `timeout`:

- `shell` is `powershell` (Windows: PowerShell 7 when it is on PATH, otherwise Windows PowerShell 5.1) or `bash` (Git Bash on Windows, bash in WSL, Linux and macOS). The chat hears at once when its computer has no such shell.
- `params` maps each name to `{type: string | number | integer | boolean, description, enum, pattern, maxLength, minimum, maximum, optional}`. The computer refuses values that do not fit before anything runs. Each value reaches the script only as the environment variable `PARAM_<NAME>` (`since` is `PARAM_SINCE`), never as script text, and a run's values total at most 16,000 bytes.
- `timeout` is 1 to 600 seconds, 60 by default.

Nothing runs until you allow exactly the actions a screen declares now. The screen shows a request until then, and **Review actions** lists each action's shell, time limit, parameters and complete script, with the computer and folder they run in. Allowing records a SHA-256 digest of the actions and where they run on that computer (`screens/<id>.json`); the request names the digest you reviewed, so actions that changed meanwhile are never allowed unseen. A chat that changes the actions, or anything about where they run, clears the approval; changing only the page keeps it. Revoke from the same dialog. Scripts and every text you review refuse hidden characters (controls, zero-width and bidirectional formatting), as Run in console does.

The computer runs an action (`src-tauri/src/screens/run.rs`) in the screen's folder with stdin closed, without the variables of an agent session, and with `NO_COLOR=1`:

- PowerShell receives a constant command (`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`) that sets UTF-8 output, adds the user's current PATH from the registry, reads the script from a private file named by an environment variable and deletes it, and runs it as a function named after the action, so its errors name the action and their lines. It ends with the script's `exit` or the exit code of the last program it ran. (`-EncodedCommand` would make Windows PowerShell write its errors as CLIXML.)
- bash starts as a login shell, as agents run commands, returns to the folder after the profile and runs the script from its file.
- In WSL, `wsl.exe` runs the fixed `screen-run.sh`, which reads the folder, the script, the limit and each value as lines of base64 on stdin, never on a command line, exports the values, and runs the script with `setsid` under a job marker `wsl-cancel.sh` can stop; a watchdog there ends it at its limit even if Windows lost the run.

Each output stream keeps 4 MiB (`truncated` says when it was cut). An action past its limit is stopped with everything it started, and its outcome keeps what it printed. Six actions run at once on a computer; others wait up to a minute for their turn.

## Where screens live

A screen lives on the computer that runs its actions, under app data `screens/` (`<id>.json`, and `<id>.data.json` for saved values), written atomically. Like tool results, it is never part of the workspace, exports, relay sync or prompts. A reply keeps only the bounded card of each screen it saved (`screens` on the message: id, revision, title, environment, at most 12), which syncs, exports and merges with the conversation like its other metadata.

Windows reach screens through transport (`listScreens`, `readScreen`, `runScreenAction`, `allowScreen`, `revokeScreen`, `deleteScreen`, `loadScreenData`, `saveScreenData` in `src/lib/transport.ts`), routed by environment to the computer that keeps them: the desktop's own through `manage_screen`, others' and the Viewer's through the relay's `screens` job, whose request the relay validates strictly (`screenRequestSchema`) and whose large results leave once read. A run may take its action's longest limit plus the way there and back (11 minutes). The Screens tab asks each reachable computer for its list when it opens and a computer's list again when a reply there saves a screen; an offline computer's screens stay listed as last read, and its screen opens again once it connects. Deleting a screen asks first and removes its page, actions and saved values from its computer; chats keep their cards.

Remote screens need a relay that knows the `screens` job, which arrives with the release that brings this feature to the VPS.

## Verification

On 2026-10-02 the installed CLIs built a screen through the production loops: `installed_claude_saves_a_screen_whose_action_runs_once_allowed` (Claude Code 2.1.287, Sonnet, 6 s) and `installed_codex_saves_a_screen_whose_action_runs_once_allowed` (Codex CLI 0.160.0, its default model, 22 s) each asked for a screen with one PowerShell action. Each model called `save_screen` with a valid definition (Codex's app-server accepted the dynamic tools on a new thread), the action was refused until allowed, then ran in real PowerShell and printed the expected JSON, and an out-of-range value was refused. Both opt-in tests use subscription capacity; run them with `cargo test --manifest-path src-tauri/Cargo.toml --lib saves_a_screen_whose_action -- --ignored --nocapture --test-threads=1`, with the inherited `CLAUDE*` session variables removed except `CLAUDE_CONFIG_DIR`. The native app's window, a remote computer's screen through the released relay and macOS or Linux hosts were not exercised.

Rust unit tests cover submission checks, parameter values, the store's revisions and approvals, the request handler, parent-only tool calls for both providers, and real PowerShell and Git Bash runs on Windows (folder, quoting, UTF-8, exit codes, errors as text, time limits). `cargo test --lib -- --ignored a_real_wsl_action` runs actions in the first WSL distribution, including a missing folder and a background child that ends at the limit. `src/lib/screens.test.ts` covers request and bridge validation, the page document, and cards through events, storage and merges. `tests/screens.spec.ts` drives a reply that saves a screen, approval, runs, saved values, `studio.chat` and deletion in the desktop window, and a page that tries to open chats by itself, forge calls or flood its bridge. `tests/screens-viewer.spec.ts` opens a computer's screen from the phone Viewer through a real relay, which refuses malformed screen jobs.
