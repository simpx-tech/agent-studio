# Computers, accounts, and synchronization

Agent Studio runs once on each computer. The Windows app also launches Codex and Claude inside its WSL distributions, so WSL does not need another app, GUI, or relay pairing. A self-hosted relay connects different computers and forwards their progress and results.

## Choosing where a conversation belongs

Start **New conversation**, choose **Computer**, and then choose **Folder**. Each managed WSL distribution appears as a separate computer. **Browse folders…** on Desktop offers Windows and its managed WSL folders; on a WSL computer it offers that distribution's folders. You can navigate subfolders, go to a parent/home directory, or enter an absolute path. Recent folders are remembered separately for each execution computer. Another physical computer must have its app connected to the relay to browse its folders.

The selected computer determines the CLI and account, independently of the folder. Desktop uses its Windows CLI even for a WSL folder; Windows accesses that project through its Windows/UNC path while the saved folder keeps its Linux path. Selecting **WSL · Ubuntu** uses only Ubuntu's Linux CLI and login. This applies to existing logins and separate profiles, without fallback when a CLI is missing or fails. Local choices can be configured while availability checks finish; sending requires detected availability. Computer, Folder, Agent, Model, and Reasoning share one toolbar. If a provider has multiple account connections, choose the account within **Agent**. Hover the folder to see its full path. A saved choice that is no longer available remains labelled unavailable and cannot send. In a new draft, selecting a different computer clears the folder selection before sending is allowed; reselecting the current computer preserves it.

After the first message creates the conversation, **Computer**, **Folder**, and **Agent** (including the account connection) are fixed. They remain locked when reopening or restoring the conversation. Start a new conversation to choose a different computer, folder, or agent. **Model**, **Reasoning**, and chat instructions can still change between replies; earlier replies keep their original settings.

The sidebar has **Active** and **History** tabs with conversation counts, each grouped by computer and folder. Use **Move to history** in the chat toolbar to archive a conversation, and **Restore conversation** to continue it. Archiving preserves messages and settings and syncs across paired computers. Older conversations without a folder remain under **No folder**.

Click **+** beside a sidebar folder to start a new conversation with its computer, environment, and folder already selected. This also works from History or a collapsed folder. It opens a blank Active draft and focuses the message box, using compatible CLIs and your remembered model/reasoning preferences. Existing conversations remain unchanged. Offline computers stay selected but cannot send until connected. The folder must still exist when the provider starts.

Folder selection organizes chats and sets the provider process's working directory; the computer selection determines the CLI environment. An unavailable folder blocks the response instead of falling back to app data. Claude and Codex use their configured tools and project guidance; Gemini retains its conversation-only restriction. Generated agent definitions and deny hooks stay in app data; legacy conversations without a selected folder and title generation continue using the app runtime.

Computer labels provide context; folder groups expand and collapse, and the open conversation is highlighted. Moving a conversation to History or restoring it reveals its destination tab and folder. Switching tabs leaves the open conversation in place. Search filters both tabs and updates their counts. Use Left/Right, Home, or End while a tab is focused to switch tabs.

## Desktop + MacBook setup

| Computer | Environment | Connections |
| --- | --- | --- |
| Desktop | Windows | Codex and the Claude accounts you want available here |
| WSL · Ubuntu | Ubuntu, managed by Desktop | Codex and the Claude accounts installed and signed in inside Ubuntu |
| MacBook | macOS | Codex and the Claude accounts you want available on the Mac |

1. Open **Connections** on Windows. **Your computers** is the main list. Each computer contains its environments, CLI installation inventory, and accounts connected on that computer. A shared account appears within each computer where it is connected, showing only that computer's environments. Installed WSL distributions appear automatically as separate computer cards. Inventory refreshes at startup, on Refresh/focus, and every 15 seconds while this page is visible. Missing CLIs show installation guidance; install inside the selected computer and refresh before connecting an account.
2. Run Agent Studio on the desktop and MacBook. Use the settings icon on this computer's card to rename it. Advanced environment grouping lives in the same dialog. Windows manages its WSL distributions directly. Use **Set up sync** to pair the desktop and MacBook to the same relay; WSL does not need a separate pairing.
3. Installed CLIs and their existing login connections appear automatically on each locally managed computer. Authentication is checked through the CLI. Use the account settings icon to give a detected login a different name; no setup or Personal/Work category is required.
4. Use **Add account** on the selected computer for an additional Claude or Codex login. Choose **Provider**, enter **Account name**, and click **Add account**. The computer is fixed and a separate login profile is created automatically using its installed CLI. The dialog shows **Creating account…**, then **Opening sign-in…** while it saves and opens the terminal. Complete sign-in there with the additional account; the app refreshes that connection in the background.
5. A terminal launch failure stays visible in the dialog. **Retry sign-in** reuses the saved connection. You can also use **Open sign-in** on its account row. On Windows, the terminal has its own interactive console and remains open if the command fails so the error is readable. Each row also shows **Chat** and a settings icon opening **Manage account** for renaming, profile information, and confirmed disconnection. Cancel or Escape discards unsaved name edits and returns focus to the card. Sign-in always uses the selected computer's CLI, and Linux credentials stay inside that distribution. Installation status sits beside the provider name; the CLI path stays on one line with the full path on hover.
6. Use **Chat** on a connection, or choose its account in the conversation’s **Agent** picker after choosing a computer and folder. Replies retain their original account/location label. Offline connections never fall back to another account.

The same account on several environments still has one provider-controlled allowance. Usage, model discovery, automatic titles, and chat follow the selected connection.

Provider CLIs appear in a vertical list inside each computer. Every account shows its **5-hour** and **Weekly** usage, reset times, pace arrows, and remaining hourly/daily budget. Additional limits reported for a specific model keep that model's label. Hover a reset for its exact time or a pace arrow for guidance. Chat context remains in the conversation because it belongs to a particular reply.

Codex's unreported 5-hour window is omitted; separately reported limits such as Spark's 5-hour quota remain visible. Below the guide, the secondary bar has a muted green background. When usage passes the guide, the guide becomes orange and the excess is red. The two colored segments share the same percentage scale, with no endpoint marker. This comparison is shared by Connections and chat.

Account readings load automatically when Connections opens and refresh on return to the app, every minute while visible, or through **Refresh connections**. Each reading uses that connection's CLI and login on its owning computer, including WSL and paired remote hosts. Signed-out, missing, or offline connections are not queried. **Not reported** differs from zero usage. Failed checks and offline computers retain the last reading with a visible notice and no current pace/budget recommendation. Loading and checked status stay beside each account; these snapshots are held only for the current app session. Usage checks queue behind the native process limit when several accounts refresh together.

Both login methods use the same installed CLI:

| Method | Login and settings | When to use it |
| --- | --- | --- |
| **Detected CLI login** | Shares the selected computer's current CLI login and configuration. Signing out or switching that CLI's account also changes this connection. | The account you already use in that computer's terminal. |
| **Additional account** | Creates a separate configuration directory for this connection. It starts without a login and needs its own sign-in. It keeps that login and settings independent of the default CLI and other profiles. | Another account you want to keep separate. |

For example, reuse your existing personal Claude login, then add separate profiles for your second personal Claude account and work Claude account. Profiles do not create subscriptions or extra allowance. Sign in separately on Windows, WSL, and macOS; the relay shares account labels and chat data, never CLI credentials. Gemini/Antigravity currently supports the existing login only.

Remote computer cards display their shared account connections and online/offline status. You can chat through an online host or edit shared account labels here; creating CLI profiles and completing sign-in currently happen on the owning computer. When an account has no connection on the current computer, **Manage account** offers **Connect on [computer name]** to reuse its label there. The action is hidden when already connected. Labels without connections remain under **Accounts without a computer**, where they can be connected again or removed through the same dialog.

**WSL running** in the computer header describes the distribution's operating-system state. The Windows app launches its connections; there is no nested environment card. Provider cards report installation state, with sign-in or connection problems shown when actionable. Discovery errors retain inventory and show state as unavailable. Missing distributions are marked **Not detected in Windows**. Remote computers use the Windows host's heartbeat to reach WSL connections; WSL does not need its own heartbeat.

All CLI operations, including detection, sign-in, model lists, usage, titles, context inspection, and chat, use the selected computer and connection. Missing CLIs and authentication, quota, or response failures never trigger a fallback, replay, or switch to another login. Windows and WSL profiles remain independent.

Selecting Desktop with a WSL folder does not require installing the agent CLI in WSL. Selecting a WSL computer requires a Linux Codex or Claude CLI, Bash, and `setsid` (standard Ubuntu tooling). The bridge checks common user installation paths and the default nvm Node installation, and rejects Windows CLI shims inside WSL. Listing distributions does not start them; inspecting their CLI installations, opening a WSL folder, or using a WSL CLI can start its distribution. Antigravity/Gemini continues to use its native CLI.

WSL discovery uses Microsoft's [`wsl --list --quiet` and `--list --running --quiet` commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands). Every management dropdown uses the same accessible design-system picker as conversations, with keyboard navigation and search.

## Local relay

Requires Node.js 24+. From the repository root, install with `npm ci`, then supply a private random pairing key through the environment. PowerShell example:

```powershell
$env:AGENT_STUDIO_RELAY_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:AGENT_STUDIO_RELAY_DATA = Join-Path $PWD '.relay-data'
npm run relay
```

Run `npm run build` before starting the relay. Keep the key in your password manager and paste its value into **Relay pairing key** on each app. The server does not print it. On the server computer, use `http://127.0.0.1:4317`. The server hosts the mobile PWA and API together; open its HTTPS address on a phone and pair in Connections. Pairing shares this workspace's chats and account labels with the relay and other paired devices. Browser clients control remote agents; execution and provider sign-in remain on the desktop hosts. See [mobile setup](MOBILE.md).

The default relay listens only on loopback. For another computer, use HTTPS or forward the relay port through an authenticated SSH tunnel and use the forwarded loopback URL. Remote plain HTTP is rejected; redirects are disabled so the pairing key cannot be forwarded to another origin.

The pairing key stays in native process memory. Pair again after reopening the app; the saved sync checkpoint retains offline changes and deletions. Provider logins remain persisted by their CLIs, independently of relay pairing.

## VPS deployment

The repository includes `relay/Dockerfile`, `relay/compose.yml`, and `relay/Caddyfile.example`. On the VPS, from the repository root:

```sh
export AGENT_STUDIO_RELAY_TOKEN="your-private-random-key-at-least-32-characters"
docker compose -f relay/compose.yml up -d --build
```

Use an actual random key from your secret manager. Configure your domain and TLS using the Caddy example, then pair clients to `https://your-relay-domain`. Compose publishes only `127.0.0.1:4317`; the HTTPS reverse proxy is the public entry point. The container runs as the Node user and stores data in the `relay-data` volume. Run one relay process per data directory.

To preserve relay identity during migration, stop the old relay and copy its `workspace.json` into the new data directory/volume before starting the new server. Pairing to a fresh relay can also merge local app data. Connected clients detect a replaced relay database and require re-pairing, preventing an empty replacement from silently deleting local chats.

Back up `workspace.json` and protect the pairing key separately. Anyone with that key is a trusted member of this single-user workspace and can read synced chats and request conversational runs on paired hosts. Work labels are organizational, not access-control boundaries. Use a separate app-data identity and relay for a separate trust boundary. The VPS stores readable chat data; end-to-end encryption and per-device revocation are not implemented. Rotate the shared key to revoke access and re-pair retained devices.

## Behavior and limits

- Workspace v3 migrates v1/v2. Native migration saves preserve `workspace-v1-backup.json` or `workspace-v2-backup.json`. Local `installation.json` and `sync-state.json` are excluded from exports. Only conversations and the computer/account registry are replicated; remembered UI choices remain local.
- Server revisions and three-way merges combine independent edits and propagate deletions. Concurrent divergent chat edits produce a named conflict copy. Copies of the same live response reconcile by run/message identity. Metadata conflicts pause sync; **Back up local data & use relay settings** exports the local workspace before adopting the relay registry.
- Hosts poll around every 2.5 seconds; progress forwards around every 700 ms. Presence expires after 15 seconds. This reports app availability, not whether a computer is powered on or can be awakened remotely.
- Requests target one connection/environment. Each app accepts one model response at a time; Windows and its managed WSL connections share that limit. Different computers work independently. Remote WSL requests target the Windows app while preserving the selected WSL connection ID. Requests are never automatically replayed or moved to another account.
- Stop requests reach the execution host's process cancellation. The WSL bridge terminates its Linux process group and Windows wrapper, using an owned job marker and process start time to avoid signalling a reused PID. It never terminates the whole distribution. The host saves response text/final status locally, retaining results if the source disconnects. Keep the execution app open; closing it cancels its CLI processes.
- Relay jobs and presence are transient. Restarting the relay discards in-flight job channels while durable workspace checkpoints survive. The host retains its locally saved output, but the initiating UI may report interruption. Inspect the host's conversation before retrying. Expired claims fail without automatic reassignment.
- Snapshots are limited to 20 MB; export/remove old conversations when necessary. Incremental transcript replication is future work.

This synchronizes **Agent Studio conversations**. It does not import existing Codex/Claude desktop or CLI history, sync repositories/files, migrate running CLI processes, provide unattended host daemons, or wake sleeping computers. Conversation-only tool restrictions remain in force.

## Profiles and references

Additional profiles live in native app data at `profiles/<provider>/<connection-id>`. Claude uses `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME` with file-based CLI credential storage. Profile scope covers sign-in, detection, models, usage, titles, and chat. Known API-key/OAuth-token and cloud-provider environment overrides are removed for isolated profiles. Existing-login connections preserve the CLI's current environment.

Managed WSL profiles live inside the distribution at `~/.local/share/<app-identifier>/profiles/<provider>/<connection-id>`. Its conversation runtime is an app-owned directory in the same Linux data root. Prompts travel over stdin; fixed scripts receive all other values as positional arguments. No Windows authentication directory is mounted or copied into a Linux profile.

The app never reads, copies, exports, or relays provider credential files. Removing a connection retains CLI files and historical reply labels. Sign in separately on each environment.

Primary references: [Codex state locations](https://learn.chatgpt.com/docs/config-file/config-advanced), [Claude environment variables](https://code.claude.com/docs/en/env-vars), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). See [verification](VERIFICATION.md) for tested boundaries. The WSL process bridge was exercised against Ubuntu; real Linux provider sign-ins, a physical MacBook, and a VPS deployment require their own verification.
