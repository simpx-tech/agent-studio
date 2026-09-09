# Model context

Choose an Agent and Model in the chat toolbar, then open **Model context** using the book icon. The inspector lists instruction files, skills, and memories for that connection and folder. Each row shows the file path, source scope, and discovery status. Filter the list or copy a path; Refresh repeats the inspection. Conversation instructions are displayed separately.

In Skills, **Use in next message** adds a skill request to the existing draft without sending it. Disabled skills cannot be selected, and Gemini has no invocation action. Actual skill invocations and observed skill-file reads appear in the reply's [tool activity](CAPABILITIES.md); inventory entries do not claim a skill was used.

After the first inspection, reopening shows the latest cached result immediately with an **Updating…** indicator while refreshing. A failed refresh keeps that result and its original check time visible. Reopening during an existing refresh shares the same request. The cache holds up to 32 recently viewed selections for the current app session, separated by provider, model, connection, computer, environment, and folder; restarting the app clears it.

Context sources belong to the CLI profile and project, so models using the same account and folder generally share sources. A fresh inspection uses the selected model. Historical replies retain their captured model settings, but the inspector is not a record of every file they read. File contents are not exported by the inspector, and inventories are not saved in conversation history.

## Sources and evidence

- **Codex:** discovers global and project `AGENTS.override.md` / `AGENTS.md`, configured global fallback filenames, companion `CLAUDE` guidance, local skills, and profile memory Markdown files. Skills reported by `skills/list` replace filesystem candidates and preserve disabled entries. Instructions and memories remain discovery evidence; custom configuration layers, trust, imports, and size limits can affect loading. See [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [skill discovery](https://learn.chatgpt.com/docs/build-skills).
- **Claude:** discovers user/project `CLAUDE.md`, `CLAUDE.local.md`, rules, skills, legacy commands, skills from enabled installed plugins, and the selected project's memory directory. A fresh `get_context_usage` query adds reported loaded instruction paths and imports. The query disables hooks and MCP startup and requests no model response; it does not reproduce hook-injected content. Managed configuration and conditional skill availability are not fully resolved by filesystem discovery. See [Claude memory and instructions](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills).
- **Gemini / Antigravity:** lists known global and project guidance and skill locations as candidates. Actual loading and memory availability are unknown. Agent Studio's conversation-only restrictions still apply. See [Antigravity context paths](https://www.antigravity.google/docs/cli/gcli-migration/) and [CLI skills](https://www.antigravity.google/docs/cli/plugins/).

Discovery is bounded to 600 entries and 6,000 filesystem visits with cycle detection; reaching a limit is visible. An unavailable CLI or folder produces an error, and a failed provider metadata query retains discovered entries with an explicit caveat. The source computer performs relay inspections. No credential files or other projects' Claude transcripts/memory folders are inventoried.

## Native verification

`scripts/context-native-smoke.mjs` uses a separate `com.vinicius.agentstudio.context-qa` installation and WebView CDP port 9447. Build with `scripts/native-context.tauri.json` and an isolated Cargo target, then launch with a separate WebView user-data folder. The script verifies live metadata queries across Claude and Codex models, Antigravity discovery, profile isolation, invalid selections, and the actual rendered inspector. It requests no generated model replies. Evidence goes under `artifacts/context-native*`.

`scripts/context-wsl-native-smoke.mjs` additionally checks Windows-first context for a WSL folder and a separate Linux profile. If Ubuntu has no Linux Codex CLI, it verifies that inspection fails without falling back to the Windows account and records the untested Linux boundary.
