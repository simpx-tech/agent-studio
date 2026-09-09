# Skills, web search, and sub-agents

## Image attachments

With Codex or Claude selected, click the paperclip below the message input, paste a screenshot, or drop image files into the composer. Click a thumbnail to inspect the image at a larger size; Escape or Close returns to the chat. Use its remove button to discard an attachment before sending. You can send images with or without a text message.

PNG, JPEG, and WebP files are supported, with up to four images per message and 2 MiB per image. Original image bytes are preserved; the app does not resize or recompress them. A conversation can contain 8 MiB of image data. Images remain visible after reopening the conversation, are included on retries and later turns, and travel with workspace exports and relay sync. Update both computers to an image-capable app version. The existing 20 MB workspace limit still applies; an attachment that would exceed it stays in the draft with an explanation.

Codex receives structured `image` inputs with data URLs through its app-server stdin; Claude receives base64 image content blocks using `--input-format stream-json`. Each image is labelled with its original message position. No attachment paths are passed to the CLI, and image bytes are excluded from the text prompt, background titles, token estimates, and activity cards. See the [Codex app-server reference](https://learn.chatgpt.com/docs/app-server) and [Claude streaming image input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). Gemini's current [Antigravity stream input](https://www.antigravity.google/docs/cli/headless/) accepts text blocks only, so its paperclip is disabled with an explanation.

Tauri's native file-drop interception is disabled to let the WebView deliver file drops to the HTML composer. File contents stay inside the selected conversation and are delivered to its selected CLI/account through the existing transport. Provider-reported vision usage contributes to the usual context meter; the app does not estimate vision tokens from base64 length.

## Tools and activity

Claude and Codex chats can load the selected CLI profile's skills, search the web, and delegate work to sub-agents. Ask for these actions in the composer. Codex chat explicitly enables live web search and multi-agent tools. Claude loads its default built-in tools and configured project/profile resources. Gemini remains conversation-only.

Open **Model context → Skills** to inspect available resources. **Use in next message** inserts a skill request into the current draft and returns focus to the composer. Disabled skills cannot be selected. This action does not send a message or claim that a skill has loaded.

While a reply runs, progress messages and tool activity appear inline in order. When it finishes, the final answer appears above a collapsed summary showing tool calls, web searches, sub-agents, and command runs. Expand the summary to review all activity or filter by those categories. Web searches and command runs are subsets of recorded tool calls, including calls made by children; sub-agents are counted separately by identity. Opening a web page is a tool call rather than another search. Counts include failed and stopped attempts and never increase for repeated progress updates.

Cards show running, completed, failed, stopped, or unconfirmed outcomes. Each operation has a stable identity; repeated searches with the same query remain separate. Headers identify the target when supplied. Expand a card to see its details:

- Skill cards show an actual Claude Skill invocation or an observed direct read of a `SKILL.md` file. File reads do not establish that all instructions were followed. The context inspector remains an availability inventory rather than a reply's read history.
- Search cards show the query and provider-supplied HTTP(S) source links when available. Missing sources are stated explicitly; the UI does not manufacture links or turn a missing result into a successful search.
- Sub-agent cards show each child's name, reported state, task and result when supplied, plus attributed child tool activity. Child text and token usage do not overwrite the parent reply. Nested delegation retains the reported parent relationship.
- Read cards show the file path and available line ranges/counts. Glob and Grep cards identify the pattern, folder, filters, and reported matching file paths/counts. Tool search shows its query and returned tool names. Commands retain reported descriptions, structured file actions, working folders, and exit codes. File contents, arbitrary arguments, and raw command output are excluded. Older calls whose metadata was not recorded show an explicit explanation; their missing details cannot be reconstructed.

Completed activity remains in saved chats and workspace exports. Interrupted replies show stopped or unconfirmed outcomes for operations that never supplied a terminal event. Intermediate progress messages remain inside the expandable history and stay out of the next prompt's conversation replay. Plain activity blocks from older chats remain readable. Markdown response exports use the final answer.

## Implementation and limits

Codex chat uses the installed CLI's ephemeral **app-server** stdio protocol. The validated process working directory and selected CLI profile are unchanged; JSON requests and prompts travel on stdin. Restricted title generation still uses `exec`, and usage/context inventory queries remain separate. The app-server stream also exposes measured last-request context input and the resolved model. Only the parent thread's usage contributes to the reply's meter.

The installed Codex 0.153.4 `exec --json` stream omitted modern `subAgentActivity` events in a live probe. Its app-server stream supplied those events and the child messages directly. Ephemeral threads reject `thread/read` with `includeTurns`, so the adapter consumes live child notifications and never reads another session's files. Protocol shapes were checked against the installed CLI's generated TypeScript schema and the [Codex exec event definitions](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs).

Configured CLI hooks may prepend a command before a PowerShell skill-file read. In that case Codex can report an unknown command action. The fallback recognizes direct read statements after the hook, tracks quoting so echoed examples do not count as reads, and supports the observed `-Raw`/`-LiteralPath` form. A command can also read an ordinary file before a skill; the skill search continues past the ordinary read and retains that other target in the details. These cases have regression fixtures; hook scripts and skill bodies are never inspected by the activity decoder.

Claude tool inputs can arrive in fragments. Finishing the input block only updates metadata; a corresponding tool result or task notification establishes the outcome. Complete child messages carry their parent tool identity, as described in [Claude's streaming documentation](https://code.claude.com/docs/en/agent-sdk/streaming-output) and [sub-agent documentation](https://code.claude.com/docs/en/agent-sdk/subagents). Only selected metadata fields, search source links, and child results are forwarded. Skill bodies, command output, arbitrary arguments, account payloads, and configuration bodies are excluded.

The decoder retains up to 200 operations, 64 sub-agents, 64 progress messages, and 12 sources and metadata facts per operation. Reaching the operation/agent limit produces a visible notice, and updates to existing records continue. Text and inputs are bounded. Source links reject non-web schemes and embedded credentials. Result text is rendered as text, not provider HTML.

Activity records are an additive optional field inside workspace v3 activity blocks. The execution host checkpoints them, relay delivery retains the newest revision per operation, and same-run reconciliation merges progress independently of answer text. Both app installations and the relay should run the updated version to preserve this metadata and support the expanded event envelope.

Claude progress resets at each streamed message start and reconciles against the corresponding assistant message identity; its final result is separate. Its reported child-agent identity also keeps resumed child sessions from inflating the sub-agent count, while preserving each invocation's task and tools. Codex agent-message items retain their identities, with `final_answer` phase used for the final response and the completed turn providing a fallback for older phase-less events. A final message already present in the progress stream is shown once. This avoids concatenating commentary into the final answer or losing it when the provider replaces its accumulated text.

## Verification

- Rust regression tests cover streamed inputs, actual results, repeated IDs, safe source extraction, failed operations, legacy/current Codex delegation, child attribution, parent usage, bounded output, and restricted background requests.
- Frontend tests cover identity/revision updates, stale replay, saved metadata, prompt exclusion, same-run merging, and bounded relay delivery. Browser tests cover both rendered states, unsafe content, keyboard disclosure, skill selection, failure, cancellation, narrow layout, and reload. The two-host test uses a real HTTP relay with synthetic provider IPC.
- `scripts/capabilities-provider-probe.mjs` probes installed Claude/Codex CLIs with disposable fixture skills and independent child-read markers. It records schema shapes and marker assertions, never raw CLI output.
- `scripts/capabilities-native-smoke.mjs` runs through the actual native composer in `com.vinicius.agentstudio.capabilities-qa` on CDP port 9457. It asserts real skill/search/child-result events, verifies fixture values, checks saved history after reload, and captures native screenshots. Use `scripts/native-capabilities.tauri.json`, a separate Cargo target, and a separate WebView user-data directory. Never target the regular app's workspace.

Native reload checks mark the old document and wait for a new document, rendered History controls, and an enabled New conversation button. The button stays disabled until workspace startup has completed; clicking a conversation before that point can be undone by initialization. CDP's reload acknowledgement alone can also leave the previous DOM visible briefly and cause a false readiness check. The fixture test verifies results rather than relying on a fixed delay.

Real Windows provider runs and their latest results are recorded in `artifacts/capabilities-native-result.json`. Separate Linux CLI profiles, physical remote machines, and individual configured MCP integrations require their own runtime checks.
