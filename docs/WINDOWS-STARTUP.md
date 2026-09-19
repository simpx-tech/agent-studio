# Windows startup safeguards

Agent Studio's Windows workspace belongs to its normal per-user local app-data directory. Starting the application as a child of an MSIX program can redirect file operations into that program's private `LocalCache`, producing a different installation identity and duplicate default account connections. In this state saved accounts can appear offline even on the current computer. `GetCurrentPackageFullName` alone is insufficient: the reproduced child reported no package identity while its file handle resolved into Codex's private storage.

Before constructing Tauri, startup obtains the normal `FOLDERID_LocalAppData` path with `KF_FLAG_NO_PACKAGE_REDIRECTION`. It creates an empty, unique delete-on-close probe inside this application's data directory and compares its `GetFinalPathNameByHandleW` result with the intended path. The check tolerates Windows path case and extended-path prefixes. Redirection, an unreadable destination, or another unexpected physical destination blocks startup with an actionable native message. Existing installation, workspace, profile, native-session, and credential files are not opened or rewritten by the check. The probe is removed when its handle closes, including failures; a newly created empty directory may remain. Custom junctions that change the physical destination also fail this check and require an explicitly supported storage design rather than silently changing identity.

`agent-studio.exe --check-startup` runs just this check and exits with success or failure, without a WebView, account detection, or provider query. The normal GUI entry point performs the same check on every launch. Other platforms retain their existing startup behavior.

## Starting from a packaged development tool

Build the application first. For a development binary, keep its Vite server running with `npm run dev`. Then run:

```powershell
npm run start:windows
```

The repository launcher uses a unique one-shot Task Scheduler task, the current interactive user's normal token, and limited privileges. It checks the built executable before starting it, verifies that a window opens, and removes the task. It never installs a recurring task, copies credentials, changes identities, or stops existing app instances. An already running executable is reported without relaunching it. The launcher does not compile the app or start its frontend server.

```powershell
# Verify without opening the application.
npm run start:windows -- -CheckOnly

# Use an alternate build, including an isolated native QA identifier.
npm run start:windows -- -Executable "C:\path\to\agent-studio.exe"
```

Launch results contain only status, process ID, or a startup error under ignored `artifacts/startup/`. If launch completion is unconfirmed, inspect the existing process before retrying; do not stop every process named Agent Studio. Keep the canonical and any redirected data copies intact. Recovery must not rewrite installation IDs or remap chats to make the wrong storage copy appear local.

## Verification

Rust regression tests reject redirected and foreign destinations, preserve pre-existing files, remove probes, and fail on invalid storage. Native verification must exercise both a direct Codex child (blocked) and the unredirected launcher (accepted) against an isolated Tauri identifier. Confirm that the blocked run creates no installation/workspace and that the accepted run retains its identity across starts. Keep the user's real app and saved data untouched.

The isolated `scripts/native-startup.tauri.json` configuration uses port 1438. Start that worktree's frontend with `npm run dev -- --host 127.0.0.1 --port 1438 --strictPort`, set a separate `CARGO_TARGET_DIR`, and build/probe with `npm run tauri dev -- --config scripts/native-startup.tauri.json --no-watch -- -- --check-startup`. The second separator passes the argument through Cargo to the application. From a redirected Codex process, exit code 1 is the expected negative result. Use the launcher with the resulting executable for positive checks.

Native Windows verification on 2026-09-19 confirmed the direct CLI rejection and GUI explanation, no redirected installation/workspace, no leftover probe, successful safe launch, identical installation and workspace hashes after restart, reuse of the existing process, and removal of the temporary launch tasks. The test app also retrieved its selected Codex account's usage. The real workspace and installation hashes remained unchanged during this isolated verification.

Windows references: [known-folder redirection flags](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/ne-shlobj_core-known_folder_flag), [physical file paths](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew), and [MSIX file virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).
