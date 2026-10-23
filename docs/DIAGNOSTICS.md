# Freezes and crashes

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

## What happened on 2026-10-11

Two replies in different chats, running for 44 and 57 minutes, failed at the same moment, 17:41:31,
with **This conversation is already responding. Stop it or wait for it to finish.** while their
CLIs worked on. Images attached in that window afterwards failed with **The images could not be
kept: Send the image bytes**. Restarting the app cleared both.

- Only a second `run_agent` call for a conversation whose reply is still registered gets the
  first message, and only an image body other than raw bytes gets the second.
- Tauri's IPC script (`ipc-protocol.js`) posts each call with `fetch` to `http://ipc.localhost`.
  When a fetch fails, it logs *IPC custom protocol failed, Tauri will now use the postMessage
  interface instead*, sends the same call again through `postMessage`, with the same callbacks,
  and keeps using `postMessage` until the page reloads. `postMessage` carries only JSON: a
  `Uint8Array` body arrives as an array of numbers, and raw answers come back as one.
- Both replies' `run_agent` calls stay open for the whole reply. They failed together, and their
  second copies were refused as second replies. That refusal answered the page's original calls,
  so the page marked both replies failed, though they were still running.
- Windows logged a new `msedgewebview2.exe` process 0.25 seconds before (Application-Experience
  event 500), and nothing else at that moment: no crash, power, network or GPU event. A scratch
  app on the same Tauri 2.11.5 and WebView2 154 showed the cause: ending its WebView2 network
  service process sent every pending call again through `postMessage` 1 ms after WebView2
  started a new one, while ending the GPU process or the storage service changed nothing. Why
  the network service ended that day was not recorded; the `webviewProcess` report below now
  keeps it.

## Calls the window sends twice

- The page names every call with a fresh `studio-call` header (`invoke` in
  `src/lib/window-answers.ts`). Tauri sends a call's second copy with the same options, so the
  name survives the move to `postMessage`.
- A command that acts takes a `calls::Call` and runs its work through `call.once`
  (`src-tauri/src/calls.rs`). The first arrival runs the work, and a copy waits for its answer
  and returns the same one. Answers are kept ten minutes, and names a day: a copy after that is
  refused rather than run again. Replies, file Undo, question answers, MCP forms, steering,
  sign-ins and their codes, titles, folder icons, console runs, screen actions, CLI installs and
  update checks, plugin, MCP and account management, Claude file sharing, exports and artifact
  downloads run once. Reads, saves, imports and desktop alerts, which their tag deduplicates, end
  the same when repeated.
- `run_agent` keeps the copy's handle on the window's channel until the reply answers, because
  Tauri ends a channel in the page when a handle on it goes.
- `store_chat_image` takes the image bytes raw or as the array of numbers `postMessage` carries.
  The page reads `read_chat_image` and `read_tool_output_model_file` answers either way
  (`answerBytes`).
- The page records the move as an `ipcFallback` report, with the failure and the calls then
  waiting. The app records each WebView2 process that fails (`ProcessFailed`) as a
  `webviewProcess` report, with its kind, reason, exit code and description, such as
  *Network Service*.

## What happened on 2026-10-20

The app (v0.11.0, running for eight hours) closed at 17:35:15 in the middle of a reply, which
showed **This response was interrupted when the app closed.** once the app started again.

- Windows logged exception 0xc0000409 (`FAST_FAIL_FATAL_APP_EXIT`) in `agent-studio.exe` and
  kept a minidump in `%LOCALAPPDATA%\CrashDumps`. The crashed thread, of the blocking pool, was
  in Rust's handler for a refused allocation, which prints `memory allocation of 268435456 bytes
  failed` and aborts. Its caller encoded the workspace for a save: `serde_json::to_vec` growing
  its buffer to 256 MiB for the 175 MB file.
- Windows had run out of commit. The dump's system counters show 87.24 GB promised of an
  87.68 GB limit: 61 GB of memory and a page file Windows was still growing, since the limit had
  been 86.68 GB 27 seconds earlier, in the dump of an Explorer crash. RustDesk, another Rust
  program, ended with the same exception a second after the app. The app held 1.9 GB itself; the
  dumps do not name what held the rest.
- A save of one conversation cost the app far more memory than the file. The host kept its last
  write as a `serde_json::Value` tree (820 MB for a 167 MB workspace), copied every unchanged
  conversation of it into the next tree (another 800 MB and 0.6 seconds in a release build), and
  encoded the whole file into one buffer of up to twice its size, every few seconds while a reply
  ran.

What the app does now:

- **A refused allocation waits for memory.** On Windows the app's allocator
  (`src-tauri/src/memory.rs`, installed by `main.rs`) asks again after pauses growing from 5 ms
  to a second, for up to a minute, while Windows grows its page file or another program lets
  memory go, and only then lets the refusal stand. A request larger than all the memory Windows
  can promise fails at once. Each wait is kept as a `memoryWait` report once it ends.
- **Saves no longer take memory in proportion to the workspace.** The host keeps the
  conversations of its last write as their JSON text (`StorageState.saved` in `lib.rs`), moves
  them into the next file rather than copying them, and writes the file straight to disk, as it
  does the sync checkpoint (`src-tauri/src/sync_state.rs`). A conversation the page sent is
  checked as a whole parse would check it (`readable`: read as raw JSON, text lets a lone
  surrogate escape through, which the next start of the app would refuse) and written as it
  came. The file is the same, byte for byte.

## What happened on 2026-10-23

The window (v1.0.0) went empty at 12:00:44, showing only its background colour, and stayed so
until the app was quit and started again at 12:39:56. The three replies running then went on
unseen (175 of their calls ended in those 39 minutes) and were saved as **This response was
interrupted when the app closed.** when the app quit.

- Windows had run out of commit again. Volume Shadow Copy could not get paged memory at 12:00:36
  and 12:00:43, a test program another chat was running (`bluevox_render`, a debug build of a
  renderer's tests) had reached 17.3 GB of private memory when it crashed in Direct3D's shader
  compiler at 12:00:43, and the GPU driver reset at 12:00:47 (`LiveKernelEvent` 141).
- WebView2's browser process, which draws the page and owns WebView2's other processes, ended at
  12:00:44 with `0x80000003`, a deliberate crash. Its own crash report
  (`EBWebView\Crashpad\reports`) gives the reason as a crash key,
  `SharedMemoryRegionCreationFailure = create-file-mapping|1455`: Windows refused it shared memory
  with `ERROR_COMMITMENT_LIMIT`. The report's counters show 71.7 GB promised of a 79.2 GB limit
  and 4.3 GB of memory free once it was written.
- The app itself ran on, and its allocator never had to wait. It kept the failure as a
  `webviewProcess` report (`browserProcessExited`, `unexpected`) and the page's silence a minute
  later as `windowSilent` with a dump. But WebView2 closes a webview for good when its browser
  process ends, and nothing made another, so the window showed its own background. The page's
  warning, **Agent Studio stopped answering this window.**, belonged to the page that was gone.

What the app does now:

- **The window comes back by itself** (`src-tauri/src/window_recovery.rs`). When WebView2's
  browser process ends, the app builds the main window again from its configuration, in the same
  process. The new window starts hidden, takes the old one's place (`GetWindowPlacement`,
  `SetWindowPlacement`) and is maximized, shown, minimized and focused as the old one was through
  the window's own calls, so that it knows how it shows; a window hidden in the tray stays hidden.
  The app stays running while no window exists, unless it is quitting, installing an update or
  Windows is ending. The taskbar count, the process watch and the browser-key guard attach to the
  new window (`prepare`). The replies are detached from the page that ended (`Runs::reloaded`),
  so the new page follows them as after a reload (`reply_feed.rs`), with every event they
  reported meanwhile.
- **A page whose renderer ended loads again.** WebView2 shows its own error page then, in place
  of the whole window, title bar included.
- Repairs run one at a time and skip a failure an earlier window reported. The first waits a
  second, for the ended processes to go, and one that follows a failure within five minutes waits
  twice as long as the last, up to a minute. A window that cannot be built yet, as when WebView2
  cannot start while memory is short, is tried again with the same pauses. None gives up. GPU,
  utility and frame processes, which WebView2 starts again by itself, and a renderer that stopped
  answering, which may answer again, are only reported.

## Reports and dumps

Each freeze writes `diagnostics/<UTC time>-<kind>.json`:

| Kind             | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `windowThread`   | A task posted to the window thread waited 10 seconds.                             |
| `windowSilent`   | A shown page stopped calling for 60 seconds while the window thread answered.     |
| `windowQueue`    | Tasks could not be posted to the window thread three times in a row.              |
| `windowCalls`    | The page's list of calls it waited on, from its own check.                        |
| `ipcFallback`    | Tauri moved the page's calls to `postMessage`: the failure, the calls sent again. |
| `webviewProcess` | A WebView2 process failed: its kind, reason, exit code, description and repair.   |
| `memoryWait`     | Allocations waited for memory: how many, the longest wait, the largest request.   |

Reports hold the time, how long the app had waited, the app version and process id, whether the
page last said it was shown, the dump's file name or why none was saved, and
`recoveredAfterMs` once the freeze ended. A `memoryWait` report's `memory` also gives the waits
that ended still refused and the memory Windows had promised, and could promise, when the latest
began. A `webviewProcess` report whose failure left the window empty names its `repair`
(`window` or `page`), keeps why the latest attempt failed in `error`, and has `recoveredAfterMs`
once the window or page is back. Only the minidump holds memory: thread stacks, handles
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
  of waiting calls; each call's name in a header that survives JSON, the fallback noticed once
  with the calls then waiting, and bytes answered raw or as numbers.
- `src-tauri/src/calls.rs` tests: a copy that arrives while the work runs, or after it ended, gets
  its answer (errors too) without running it again, work dropped unanswered tells its copies,
  answers are kept ten minutes and names a day, and only plain short names count.
  `chat_images` tests take image bytes raw or as numbers and refuse anything else, and
  `watchdog.rs` tests write `ipcFallback` and `webviewProcess` reports. A `lib.rs` test keeps
  the `run_agent` future under 16 KB: one of 182 KB overflowed the window thread's stack in a
  debug build as a reply started.
- `scripts/ipc-replay-native-smoke.mjs` drives an isolated build of
  `scripts/native-ipc-replay.tauri.json` (CDP 19831) with a real Codex or Claude reply in a
  disposable folder. Ten seconds into the reply it fails the reply's `run_agent` fetch, or with
  `IPC_REPLAY_QA_KILL=network` ends the app's WebView2 network service. The reply then finishes
  as one reply, the `ipcFallback` report lists `run_agent` among the calls sent again (and the
  `webviewProcess` report names the Network Service), and an image stores and reads back whole
  through `postMessage`. On 2026-10-11 both ways passed with Codex. The same driver on the build
  before this change failed the reply with **This conversation is already responding**, and
  storing an image after the move failed with **Send the image bytes**.
- `src-tauri/src/memory.rs` tests: a refused allocation is asked again until granted, the refusal
  stands once its patience runs out, every wait since the last report is counted, a request past
  all the memory Windows can promise never waits, and blocks are the system allocator's. A
  scratch program compiled with `memory.rs` inside a job object limited to 512 MB recreated the
  crash: holding 400 MB, a 256 MiB request ended it with `memory allocation of 268435456 bytes
  failed`; with the app's allocator the request waited 2.4 seconds, until a thread let the 400 MB
  go, and the program went on with one wait reported. `watchdog.rs` writes the `memoryWait`
  report.
- `lib.rs` `workspace_patch_tests`: a whole workspace is written byte for byte as `serde_json`
  wrote it, conversations stay the text they came as through later patches, a refused patch keeps
  the last write, a failed write leaves the next patch nothing to fill in, a version 2 file is
  backed up once, and the check of a sent conversation refuses exactly what a `Value` parse
  refuses. On a copy of the 175 MB workspace a whole save and three saves of its largest
  conversation (9.8 MB) wrote the file `serde_json` would; in a debug build the saves took
  0.3 seconds each, against 5.9 seconds for the copy and encoding they replace.
- `src-tauri/src/window_recovery.rs` tests: only an ended browser process or page renderer needs
  a repair, pauses double while failures keep coming and start over after five quiet minutes, and
  the new window shows as the old one did (one hidden in the tray stays hidden, a maximized one is
  maximized before it shows and a minimized one minimized after). `badges.rs` tests: a window
  built again gets the count on its own taskbar button. `watchdog.rs` tests write the `repair`.
- `scripts/webview-recovery-native-smoke.mjs` drives an isolated build of
  `scripts/native-webview-recovery.tauri.json` (CDP 19891) with a real Codex reply running
  `Start-Sleep -Seconds 30` in a disposable folder, in a maximized window. Ending the app's
  WebView2 browser process brings the window back maximized, drawn by a new browser process of the
  same app process; the reply, still running and its chat in Active, ends in the new page with its
  answer and calls, and the window restores to its earlier place and size. Ending the page's
  renderer then loads the page again. Each failure leaves a `webviewProcess` report with its
  repair and `recoveredAfterMs`. On 2026-10-23 it passed: the window was back 1.8 seconds after
  its browser process ended (1,423 ms in the report) and the page 2.4 seconds after its renderer
  ended (2,005 ms).
- `tests/window-answers.spec.ts`: the banner appears and clears and the stall is recorded; a reply
  starts while its save goes unanswered and the save warning clears; Close closes while the draft
  save goes unanswered.
- A native check app built around `watchdog.rs`, whose synchronous command held its window thread
  for 25 seconds, produced a `windowThread` report after 10 seconds, a 1.1 MB dump whose thread 0
  stack walked to `KERNELBASE.dll!WaitForSingleObjectEx` under that command, and
  `recoveredAfterMs` once the thread returned.
