# Freezes between the window and the app

The desktop app is two halves: the page, which draws the window's contents and runs in WebView2,
and the native app, which runs replies, saves the workspace and owns the window itself. The page
reaches the native app only through calls that the app's window thread receives. When that thread
or that path stops, the page still draws and takes typing, but nothing it asks for happens.

## What happened on 2026-10-08

In a v0.7.0 session that ran from 09:00 to 13:54, every call from the page stopped being answered
at about 11:12 and never recovered:

- The last save of `workspace.json` held both running replies as they were at 11:12:10–11:12:14;
  the replies' own CLIs and the native side kept working until the app was ended at 13:54 (tool
  results were still written at 13:54:08).
- The page's relay heartbeats (`POST /v1/notification-view`, every 5 seconds) stopped reaching
  the relay at the same time.
- Messages sent afterwards stayed at Responding: a reply saved its message before starting its
  CLI, and that save never returned. Close saved drafts first and never closed. Dragging,
  Minimize and Maximize are calls too.
- No error was shown, Windows never marked the window Not Responding, and Windows logged no hang
  or crash for the app.

The session left no record of the window thread itself, so what held the calls cannot be
recovered. Ruled out by experiment on the same Tauri and WebView2 versions: a limit on pending
calls (1,024 pending calls left new ones unaffected), large payloads (64 MB arrived in under a
second), and Tauri's fallback to `postMessage` after a failed call (it keeps working). The machine
also ran out of ephemeral TCP and UDP ports during that session (`Tcpip` events 4231 and 4266),
as it had on most days since 2026-09-26 without a freeze. The changes below remove what could
hold the window thread, keep one unanswered call from stopping replies and Close, show a freeze at
once, and record the next one.

## What the app does now

- **No command runs on the window thread.** Every `#[tauri::command]` is `async`
  (`src/lib/performance-guards.test.ts` enforces it). Synchronous commands ran inside WebView2's
  request handler, so any wait in one held every later call. The taskbar overlay, which waits for
  Explorer through `ITaskbarList3`, is set by a thread of its own that keeps only the newest
  count (`src-tauri/src/badges.rs`).
- **The page checks that the app answers.** Every 5 seconds the page calls `window_heartbeat`,
  saying whether it is shown (`src/lib/window-answers.ts`). A check left unanswered for four
  checks in a row while the page is shown shows **Agent Studio stopped answering this window.**
  with **Reload window**. Hidden pages and a computer waking from sleep do not count.
- **One unanswered call no longer stops the rest.** A reply waits at most 10 seconds for its
  message's save, then starts. Close waits at most 2 seconds for the draft save. A save left
  unanswered for 30 seconds shows **Changes are not being saved.**
- **The app records freezes** (`src-tauri/src/watchdog.rs`). A thread posts a task to the window
  thread every second. If the task waits 10 seconds, or if a shown page stops calling for
  60 seconds while the window thread answers, or if posting fails three times, the app writes a
  report to app data `diagnostics/` and saves a minidump of every thread beside it. The report is
  completed with the time the freeze ended. Time the computer slept counts for nothing.
- **The page records what it waited on.** When it finds the app not answering, the page keeps the
  calls still waiting, with how long each has waited, in its own storage, and hands them to the
  app as a `windowCalls` report once the app answers again or the window next opens
  (`record_window_stall`). A running reply's `run_agent` call stays open for its whole reply, so
  it is listed with its age in any record taken while it runs.

## Reports and dumps

Each freeze writes `diagnostics/<UTC time>-<kind>.json`:

| Kind           | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `windowThread` | A task posted to the window thread waited 10 seconds.                         |
| `windowSilent` | A shown page stopped calling for 60 seconds while the window thread answered. |
| `windowQueue`  | Tasks could not be posted to the window thread three times in a row.          |
| `windowCalls`  | The page's list of calls it waited on, from its own check.                    |

Reports hold the time, how long the app had waited, the app version and process id, whether the
page last said it was shown, the dump's file name or why none was saved, and
`recoveredAfterMs` once the freeze ended. Only the minidump holds memory: thread stacks, handles
and module lists, no heap. The app keeps the newest 30 reports and 3 dumps. Nothing in
`diagnostics/` is synced, exported or sent anywhere.

A process cannot safely dump itself while it is stuck, so the watch starts the app's own program
as a helper, `agent-studio.exe --write-minidump <process id> <name>`, which exits before
anything else of the app starts. The helper dumps only a process running its own program, into
its own app data `diagnostics/` folder, under a name made of letters, digits and dashes.

To read a dump, install `minidump-stackwalk` (`cargo install minidump-stackwalk`) and walk it
with Mozilla's converted Windows symbols:

```sh
minidump-stackwalk --symbols-url https://symbols.mozilla.org/ --symbols-cache <cache folder> <dump>
```

Thread 0 is the window thread. Release builds carry no symbols of their own, so the app's frames
show as `agent-studio.exe + offset`; the Windows and WebView2 frames around them name the call the
thread waits in.

## Verification

- `src-tauri/src/badges.rs` tests: the overlay waits for its window, callers return while a
  taskbar call waits, only the newest count follows, and a failed count is set again. The opt-in
  `cargo test --lib overlay_reaches_the_taskbar -- --ignored` shows a window and sets its overlay
  through Explorer from another thread.
- `scripts/window-answers-native-smoke.mjs` drives an isolated build of
  `scripts/native-answers.tauri.json` (CDP 19761): the badge calls return, a shown and then a
  minimized window that answers write no report in 150 seconds, a page's record arrives as a
  `windowCalls` report while a malformed one is refused, and the app's own `--write-minidump`
  dumps the running app but refuses another program, a path as a name and missing arguments.
- `src-tauri/src/watchdog.rs` tests: a shown page is reported silent once and heard again, hidden
  pages and sleep owe no calls, reports keep the newest files, stall records accept only bounded
  command names, and the dump helper refuses other programs and names while writing a real dump.
- `src/lib/window-answers.test.ts`: when a stall begins and ends, hidden checks, and the record
  of waiting calls.
- `tests/window-answers.spec.ts`: the banner appears and clears and the stall is recorded; a reply
  starts while its save goes unanswered and the save warning clears; Close closes while the draft
  save goes unanswered.
- A native check app built around `watchdog.rs`, whose synchronous command held its window thread
  for 25 seconds, produced a `windowThread` report after 10 seconds, a 1.1 MB dump whose thread 0
  stack walked to `KERNELBASE.dll!WaitForSingleObjectEx` under that command, and
  `recoveredAfterMs` once the thread returned.
