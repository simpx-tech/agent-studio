# Recorded native instructions

Open **Model context → Native prompt** in a conversation. The tab reads instructions from that conversation's existing native session. Opening or refreshing it never sends a model request, resumes a session, changes prompt settings, or runs tools.

- Claude Code: displays the latest parent `prompt_snapshot` attachment's `systemPrompt` sections, preserving each section's exact text. Version and capture time come from that record. Older CLIs or sessions without prompt recording show an explicit unavailable state.
- Codex: displays `session_meta.base_instructions.text` and unique text-only developer messages from the same native session, in recorded order. Base instructions are labelled as the session-start record. Developer messages may belong to earlier turns; model changes and compaction can change later input.
- Agent Studio additions: separately displays the current build's app guidance from the same generator used for chat. It is user context, and is not presented as the recorded wording of an older conversation. User-supplied conversation instructions remain in their existing disclosure. Claude chat instructions from Settings are appended to Claude's system prompt, so a recorded Claude snapshot already contains the text in use when it was captured; the disclosure notes this instead of repeating the current setting.

This view does not represent the entire model request. Tool definitions, project guidance, conversation history, dynamically loaded context, and provider-side additions can be separate. It describes the CLI session Agent Studio used, not every instruction a separate provider desktop application might add.

## Routing and retention

`read_native_instructions` accepts the portable conversation ID, provider, and connection. Native code requires the conversation to exist in the currently saved workspace, checks its pinned provider/connection, derives its folder from saved state, and verifies the same binding scope used for execution. A new chat has no record until its first native request. Legacy/imported chats may lack a binding on the selected host.

The selected profile determines storage, including isolated profiles and Windows-managed WSL. Only exact bound session filenames are considered within that profile's session storage. No native ID or filesystem path is accepted from renderer/relay input. Missing, mismatched, ambiguous, malformed, or oversized records fail explicitly without falling back to another session.

Reads are bounded to 30,000 directory entries, 64 MiB of a session file, 32 MiB per JSONL record (including structured image inputs), 512 KiB per instruction section/message, 40 displayed blocks, and 1 MiB of displayed instruction text. A final incomplete JSONL write is ignored until refresh. Complete malformed records fail rather than presenting a partial prompt. Prompt text renders as escaped plain text.

The tab holds prompt text only while mounted. It is excluded from the source/skill catalog cache, saved workspace, exports, history, and checkpoints. Closing the tab/modal or changing its conversation/account clears it; a read error clears the previous result. Viewer requests route to the owning desktop through authenticated workspace jobs; job results remain transient relay memory and expire under the existing job retention policy. Both the execution host and relay must support the `nativeInstructions` method.

## Verification

Parser tests cover exact text, latest parent snapshot selection, developer-message deduplication, exclusion of user/tool/schema data, scope matching, corrupt/oversized records, missing snapshots, duplicate files, and incomplete writes. Browser checks cover on-demand reads, inert HTML, draft preservation, late results, read failures, large prompts at desktop/mobile sizes, and persistence exclusion. Relay tests cover typed request routing, rejecting arbitrary paths, and transient result retention.

On Windows, `scripts/native-instructions-smoke.mjs` checks the isolated sessions QA app against its existing real-provider records. It verified Claude Code 2.1.267 (15 sections, 27,779 characters) and Codex 0.153.4 (base plus unique developer messages, 11 blocks, 98,067 characters): native IPC and rendered modal text matched the stored records exactly, transcript and binding bytes remained unchanged, and incorrect conversation/provider requests were rejected. The script stores only counts/hashes in its report, with local screenshots for visual review. Live WSL, macOS/Linux, isolated account profiles, and a deployed Viewer remain separate validation boundaries; their shared scope/routing behavior has automated coverage.
