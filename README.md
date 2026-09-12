# Agent Studio

A desktop workspace for your AI agents, with a mobile PWA to control them from your phone. Tauri 2 + Svelte 5 + TypeScript, with an HTML interface and a Rust bridge to installed CLIs.

## Start

```powershell
npm install
npm run tauri dev
```

Choose **Codex**, **Claude**, or **Gemini**, then send a message. The app uses the CLI's existing login. Open **Connections** to check installations and launch sign-in. Authentication runs in the provider's own browser/CLI flow; you complete it yourself.

The built Windows executable is `src-tauri/target/release/agent-studio.exe`. The installer is `src-tauri/target/release/bundle/nsis/Agent Studio_0.1.0_x64-setup.exe`.

`npm run dev` opens the frontend for development. For phone access, build the frontend and run the relay server; it hosts the PWA and API together. Open its HTTPS address on your phone, pair in **Connections**, and install it from your browser. Agents execute on your paired computers. See [mobile setup](docs/MOBILE.md). No mock AI responses are shipped in the app.

## Included

- One **Connections** page for agent setup, computers, account profiles, and the relay. Each WSL distribution appears as a separate computer managed by Windows. The selected computer supplies the CLI and account, with no fallback; Desktop agents can also work in WSL folders.
- Separate Claude/Codex CLI login profiles and a self-hosted relay for app chat synchronization, presence, remote progress, and cancellation. See the [setup and VPS deployment guide](docs/MULTI-COMPUTER.md).
- Share one VPS with separate users through private workspace keys. Each workspace has its own chats, computers, environments, and notifications. Designate admin workspaces to create and manage access from Connections. See [private workspace setup](docs/PRIVATE-WORKSPACES.md).

- Codex via your ChatGPT login, Claude via Claude Code, and Gemini via Google login in Antigravity CLI.
- Rich Markdown messages, selectable code blocks, tables, copy actions, and structured activity.
- Agent/provider, model, and reasoning controls directly in every chat, plus optional chat instructions.
- Last model remembered per provider; last reasoning level remembered independently per provider and model.
- Saved conversations with search, multi-turn context, retry, stop, and deletion.
- Automatic conversation titles from the first message, generated once in the background with a small model.
- Provider-reported chat context where available (currently Claude), saved reply token counts, live 5-hour/weekly subscription meters, and a Fable-specific meter when Fable is selected. Compact colored arrows show pace, with full meanings on hover. See [usage details and data sources](docs/USAGE.md).
- Colored arrows show quota pace and remaining allowance. Context guidance highlights limited room and rapid growth using measured readings; hover an arrow for its full meaning.
- Provider installation/login status and workspace export to JSON in Downloads.
- Explicit browser-preview, missing-CLI, login, quota, timeout, and storage error states.

The first version runs one response at a time. You can navigate while it runs. Choose the computer, folder, and agent before sending the first message; those choices are fixed for the existing conversation. Change its model, reasoning, or instructions between replies; the next request uses that configuration. Earlier replies retain their original settings. New chats start with your latest choices and allow a different computer, folder, or agent, while reopening a saved chat restores its own configuration. Custom instructions belong only to their conversation.

The model picker loads Codex models and supported reasoning levels through its app-server `model/list`, and groups Gemini's installed CLI model variants into model/reasoning choices. Claude uses its documented model aliases and effort levels; availability and organization limits remain controlled by Claude Code. Refresh the model list from the chat toolbar. CLI default keeps provider defaults; Gemini starts with Gemini 3.8 Flash at Medium. Choices are passed as actual CLI arguments, not prompt instructions.

## Automatic titles

New chats initially display an excerpt of the first message. A separate request names the conversation using the same provider: **GPT-5.6 Luna / Low**, **Claude Haiku**, or **Gemini 3.8 Flash / Low**. It receives at most 2,000 characters of the first message, never changes your chat settings or remembered choices, and has a 30-second timeout. Titles are saved locally. Failure keeps the excerpt; subsequent messages, retries, and restarts do not generate another title. Existing chats keep their names. Title requests use the CLI account's quota and the same tool restrictions as chat.

This small-model policy was checked on September 8, 2026 against [Codex credit rates](https://learn.chatgpt.com/docs/pricing), [Claude cost guidance](https://code.claude.com/docs/en/costs), and [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Gemini 3.6, 3.7, and 3.8 Flash share the same listed token rates. Availability and subscription accounting are provider-controlled; unavailable title models fall back to the excerpt without switching to a more expensive model.

## Provider setup

| Provider                 | Install                                                                         | Sign in                             |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------------------- |
| Codex                    | `npm install -g @openai/codex`                                                  | `codex login`                       |
| Claude Code              | Follow [Claude Code setup](https://code.claude.com/docs/en/setup)               | `claude auth login`                 |
| Gemini (Antigravity CLI) | Follow [Antigravity installation](https://antigravity.google/docs/cli/install/) | `agy`, then complete Google sign-in |

Use current CLI versions. This implementation was checked with Codex CLI 0.153.4, Claude Code 2.1.263, and Antigravity CLI 1.1.27 on Windows. Older versions may not support the required flags. Gemini's sign-in is checked through the CLI's built-in `/usage` account query without generating a model response. Connections updates at startup, on Refresh, and when you return to the app. After Open sign-in, it also checks every five seconds for up to ten minutes; the sign-in terminal can stay open. Successful checks show **Connected** before any chat. If the CLI requests authentication, the check stops and shows **Sign in**; connection errors remain unverified. Run `agy models` to see available model names.

**Gemini CLI retirement:** Google [stopped serving individual accounts through the old `gemini` CLI on June 18, 2026](https://github.com/google-gemini/gemini-cli/discussions/28017), including free, AI Pro, and AI Ultra accounts. Browser OAuth can succeed and still return “This client is no longer supported.” Repeating sign-in does not fix that. Agent Studio now resolves `agy` for Gemini and never falls back to `gemini`; existing agents and conversation history are retained. Enterprise/API-key support in the old CLI is outside this subscription-based adapter.

On Windows, Open sign-in launches a dedicated console with a persistent PowerShell session, so interactive prompts and errors remain visible. The command is encoded and its paths are quoted literally; no temporary script file or existing terminal process is required. Close that console after authentication.

Prompts and conversation context are sent to the selected provider and count toward its account limits. No API keys are needed by Agent Studio. Existing environment settings can affect a provider CLI's own authentication; the app never reads or copies credentials.

## Local data and execution

Windows workspace data: `%LOCALAPPDATA%\com.vinicius.agentstudio\workspace.json`. Tauri selects the equivalent application-data path on other platforms. Saves replace the file atomically. A corrupt or unsupported file is preserved and reported, rather than silently reset. Browser previews have separate localStorage data.

Workspace version 3 adds computers, environments, accounts, and connections while migrating v1/v2 conversations, instructions, and provider attribution. Retired preset definitions are retained under `legacyAgents` for data preservation, with no agent-library UI. The first desktop save after migration keeps the original file as `workspace-v1-backup.json` or `workspace-v2-backup.json` beside the workspace. Relay setup and synchronization boundaries are documented in [MULTI-COMPUTER.md](docs/MULTI-COMPUTER.md). Conversation files and JSON exports are plain text. They contain chat instructions and message content, so treat them like local notes. Provider credentials are never included.

The Rust backend resolves known executables (and npm's declared Node entrypoints) without passing user prompts through a shell. Prompts go through stdin. Runs use an application-owned directory, not an arbitrary repository. Stop and window close cancel active runs and terminate their process trees. A five-minute timeout bounds stalled runs.

Claude and Codex conversations enable their built-in tools, including file reading, editing, and commands, and load the selected CLI profile's configured integrations, skills, and project guidance. Chat tool calls run with full access and without approval prompts. Hover the account line in the composer to see the tool-access policy for the selected provider. Context, 5-hour, and Weekly usage appear as three progress bars below the input. Existing conversations receive this behavior on their next reply. Background title generation and account/usage queries remain restricted. Gemini uses an application-owned primary-agent definition plus a wildcard `PreToolUse` hook that denies every tool invocation. Antigravity 1.1.27 still advertises tools with `tools: []`, so the hook enforces the restriction. It is generated only in the app's runtime directory; personal CLI settings and credentials are not modified. Slash-command expansion and inherited MCP are disabled for this agent. The provider still loads its own global configuration and writes its normal CLI session data. When a conversation has a selected folder, the CLI starts there with its provider-specific tool access; app-owned configuration stays in app data. Missing folders fail before a response starts, with no runtime-directory fallback.

Existing CLI project sessions are not resumed. The complete local conversation is replayed on each turn, up to 200 messages / 400 KB, with an explicit error at the limit. This is portable across providers but less token-efficient than native session resumption.

## Architecture and workflows

```text
Svelte components → transport.ts → Tauri IPC → Rust CLI adapters
                                            ↓
message content blocks ← normalized events ← JSONL decoder
```

- `src/lib/domain.ts`: versioned workspace schema, migration, per-chat settings, remembered choices, and content blocks.
- `src/lib/components/ChoicePicker.svelte`: styled HTML selectors with keyboard navigation.
- `src-tauri/src/models.rs`: CLI model discovery and supported reasoning levels.
- `src/lib/transport.ts`: desktop boundary; replace it with an authenticated backend transport to enable browser chat later.
- `src/lib/components/MessageView.svelte`: HTML presentation; sanitized Markdown and structured status.
- `src-tauri/src/providers.rs`: CLI detection, authentication launching, process arguments, input validation.
- `src-tauri/src/protocol.rs`: provider JSONL to normalized text/activity/usage events.
- `src-tauri/src/runner.rs`: streaming, deadlines, cancellation, and process cleanup.
- `src-tauri/src/titles.rs`: bounded first-message title generation and the small-model policy.

There is no terminal emulator. Raw CLI events and ANSI output are not the interface. Scripts, remote images, embeds, and unsafe links are stripped from model output; the desktop CSP limits renderer access. Fonts and icons are bundled locally.

Type `/` in the composer to find app commands, Claude native commands, and available Claude/Codex skills. Use arrows and Enter/Tab to complete a choice, then add arguments and send. Commands and skills belong to the selected computer, account, and folder. Ask for **Claude Code native Dynamic Workflows** through ordinary chat or their saved `/name` commands. The progress panel shows reported phases, agents, results, and usage alongside provider plans. Saved scripts remain in Claude's own project/profile/plugin locations; reported progress survives history, export, and relay sync. Codex and Claude can call the **visualize** tool for interactive charts, diagrams, and simulations that flow between explanatory paragraphs and share the reply typography and transparent background, with saved source, revisions, and an expandable sandboxed preview. Completed HTML/SVG code blocks also open in the artifact viewer with source inspection and downloads. See [capabilities and limits](docs/CAPABILITIES.md).

## Development and verification

Prerequisites: Node.js, Rust, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs MSVC C++ build tools and WebView2. Desktop runtime testing was performed on Windows; macOS and Linux remain unverified. On those platforms, use the displayed terminal login commands.

```powershell
npm run verify
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --bundles nsis
```

Browser tests use Microsoft Edge (`channel: msedge`) and controlled IPC fixtures. They never call real providers. They cover persistence, transcript routing, HTML sanitization, keyboard focus, responsive layout, errors, retry, and cancellation. Rust tests cover JSONL reconciliation, input validation, and literal quoting for the login launcher.

For opt-in native verification, start a **development** build with a WebView2 debugging port, then run the smoke script. This sends small synthetic prompts using your real accounts. Do not enable a debugging port in production.

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9427'
npm run tauri dev
# In another terminal:
node scripts/native-smoke.mjs Codex Claude Gemini
```

Runtime screenshots and results are kept under ignored `artifacts/`. See [verification notes](docs/VERIFICATION.md) for the latest checked boundaries.

CLI references: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/), [Claude programmatic use](https://code.claude.com/docs/en/headless), [Antigravity headless mode](https://antigravity.google/docs/cli/headless/), [Antigravity tool hooks](https://antigravity.google/docs/hooks/).
