# Plan mode

Choose **Plan** or **Build** from **Mode** beside the composer. Claude and Codex support this choice; Gemini does not. The choice is saved per conversation, captured with each reply, and applies when the next message is sent. It cannot change during a reply. Build keeps the existing full-access execution behavior. Changing the mode preserves the draft, attachments, selected computer, folder, and account.

## Claude

Plan launches the selected CLI/profile with `--permission-mode plan` and `--allow-dangerously-skip-permissions`. Build retains `--dangerously-skip-permissions`. Both add session-only ask rules for `EnterPlanMode` and `ExitPlanMode` through the existing fixed `--settings` override, alongside the TODO-tool setting. They do not write permission rules into the user's profile or project.

**Enter plan mode** and **Decline** answer a native entry request. When Claude calls `ExitPlanMode`, the app displays the complete plan from that request. **Approve and implement** allows that invocation and returns the native session to `bypassPermissions`; **Keep planning** denies the transition. No selection, default, restored receipt, or proposed-plan display sends approval. An approved exit applies within that reply; the saved Mode choice still applies to the next message. Native permission-mode status updates the parked process identity, so a later reply cannot accidentally reuse a process in a different mode.

Plan approval uses the authenticated question response channel with a strict Approve/Decline contract. The host matches the parent tool ID, exact input, run, connection, and current session before exposing a decision. It preserves the provider's input and supplies only an application-owned, session-scoped `setMode` permission update. Child, duplicate, foreign, withdrawn, stopped, and expired calls cannot be approved. Stop, completion, process loss, and renderer reload close pending requests. Write operations that reach the permission handler are denied while planning; ordinary native read-only behavior and the CLI's own plan-file handling remain available.

Plan text is bounded to 24 KB and must be present in the native request. Missing or oversized plans fail explicitly; the app never reads `planFilePath` or grants permission from suggested shell patterns. Saved receipts contain the plan, decision and revision, with no raw native request, filesystem path metadata, or permission-rule body. Historical decisions are labelled as context for that reply when bootstrapping a fresh session.

## Codex

`turn/start.collaborationMode` selects `plan` or `default`, retaining the selected model and reasoning and using the provider's built-in mode instructions. CLI defaults use the model reported by the loaded thread. The configured full-access sandbox and granular approval policy stay intact; native collaboration instructions control planning.

`plan` items and `item/plan/delta` appear as **Proposed plan** documents. They are separate from `turn/plan/updated` and `studio_update_plan`, which continue to update the TODO/progress list. Only the active parent thread and turn can supply a proposal. The `item/completed` text replaces streamed text authoritatively, including an empty replacement. Duplicate completion and late deltas cannot reopen it. Up to eight plans and 64,000 Unicode characters per plan are retained; an oversized plan is explicitly labelled partial. Stopped or failed drafts show that completion was not confirmed.

A completed proposal is a valid reply even without a final agent message. Earlier commentary stays in Work history. Plans survive save, export, fork, relay checkpoints and stale-client reconciliation by identity/revision; complete, untruncated plans can bootstrap earlier conversation context without implying approval. To implement a Codex proposal, select Build and send the implementation request. Receiving a proposal never starts implementation automatically.

## Verification

`tests/plan-mode.spec.ts` exercises mode selection, separate TODO/proposal rendering, explicit entry/exit decisions, delivery failures, draft retention, inert Markdown, mobile controls, Stop and reload. Unit and real HTTP relay tests cover revision replacement, history/export and stale sync, provider/run isolation, metadata bounds, exact permission responses, rejected free-text approval, cancelled delivery and host routing.

`scripts/plan-mode-cli-probe.mjs` probes the installed Claude protocol in a disposable working folder. `scripts/plan-mode-native-smoke.mjs` requires the isolated `scripts/native-plan-mode.tauri.json` application (frontend port 1448, CDP 9538), a separate Cargo target and the guarded Windows launcher described in [WINDOWS-STARTUP.md](WINDOWS-STARTUP.md). It rejects another app identity or a non-QA workspace before making changes.

Live Windows checks on 2026-09-20 passed with Sonnet and GPT-5.6-Sol: Claude entered planning from Build, also started directly in Plan, waited for explicit implementation approval, then created the test file while preserving an unsent draft. Codex produced a native proposal with no project edits and implemented it only in a subsequent Build reply. All three retained their plans after renderer reload. Reports and inspected screenshots are in `artifacts/plan-mode/`. WSL, macOS/Linux, separate login profiles, physical phones and a live paired Viewer were not exercised; shared routing and responsive browser behavior have automated coverage.

Protocol references: [Claude permission modes](https://code.claude.com/docs/en/agent-sdk/permissions) and [Codex App Server](https://developers.openai.com/ja-JP/docs/app-server).
