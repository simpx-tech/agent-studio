# Computers, accounts, and synchronization

Agent Studio runs once on each computer. The Windows app also launches Codex and Claude inside its WSL distributions, so WSL does not need another app, GUI, or relay pairing. A self-hosted relay connects different computers and forwards their progress and results.

## Choosing where a conversation belongs

Start **New conversation**, choose **Computer**, and then choose **Folder**. **Browse folders…** lists directories on that computer; select Windows or a WSL distribution in the folder dialog. You can navigate subfolders, go to a parent/home directory, or enter an absolute path. Recent folders are remembered. Another computer must have its app connected to the relay to browse its folders.

The selected folder pins the project and its owning computer. For a WSL folder, existing Codex/Claude connections use the Windows installation and login first. If that CLI is missing on Windows, they use the CLI in the selected WSL distribution. Windows accesses the same project through its Windows/UNC path; the saved folder keeps its Linux path. A separate WSL account profile stays in WSL so it retains its own login. Local choices can be configured while availability checks finish; sending requires detected availability. Computer, Folder, Agent, Model, and Reasoning share one toolbar. If a provider has multiple account connections, choose the account within **Agent**. Hover the folder to see its full path. A saved choice that is no longer available remains labelled unavailable and cannot send. In a new draft, selecting a different computer clears the folder selection before sending is allowed; reselecting the current computer preserves it.

After the first message creates the conversation, **Computer**, **Folder**, and **Agent** (including the account connection) are fixed. They remain locked when reopening or restoring the conversation. Start a new conversation to choose a different computer, folder, or agent. **Model**, **Reasoning**, and chat instructions can still change between replies; earlier replies keep their original settings.

The sidebar has **Active** and **History** tabs with conversation counts, each grouped by computer and folder. Use **Move to history** in the chat toolbar to archive a conversation, and **Restore conversation** to continue it. Archiving preserves messages and settings and syncs across paired computers. Older conversations without a folder remain under **No folder**.

Click **+** beside a sidebar folder to start a new conversation with its computer, environment, and folder already selected. This also works from History or a collapsed folder. It opens a blank Active draft and focuses the message box, using compatible CLIs and your remembered model/reasoning preferences. Existing conversations remain unchanged. Offline computers stay selected but cannot send until connected. The folder must still exist when the provider starts.

Folder selection organizes chats, determines their CLI environment, and sets the provider process’s working directory on the owning computer. An unavailable folder blocks the response instead of falling back to app data. Conversation tool restrictions remain in place: selecting a project does not enable file inspection tools, commands, or project edits. Generated agent definitions and deny hooks stay in app data; legacy conversations without a selected folder and title generation continue using the app runtime.

Computer labels provide context; folder groups expand and collapse, and the open conversation is highlighted. Moving a conversation to History or restoring it reveals its destination tab and folder. Switching tabs leaves the open conversation in place. Search filters both tabs and updates their counts. Use Left/Right, Home, or End while a tab is focused to switch tabs.

## Desktop + MacBook setup

| Computer | Environment | Connections |
| --- | --- | --- |
| Desktop | Windows | Codex and the Claude accounts you want available here |
| Desktop | WSL | Codex and the Claude accounts you want available in WSL |
| MacBook | macOS | Codex and the Claude accounts you want available on the Mac |

1. Open **Connections** on Windows. **Your computers** is the main list. Each computer contains its environments, Codex/Claude/Gemini CLI setup, and accounts connected on that computer. A shared account appears within each computer where it is connected, showing only that computer's environments. Installed WSL distributions appear automatically under the desktop. Inventory refreshes at startup, on Refresh/focus, and every 15 seconds while this page is visible.
2. Run Agent Studio on the desktop and MacBook. Use the settings icon on this computer's card to rename it. Advanced environment grouping lives in the same dialog. Windows manages its WSL distributions directly. Use **Set up sync** to pair the desktop and MacBook to the same relay; WSL does not need a separate pairing.
3. Use **Add account** on the computer's card to create labels such as **Claude personal 1**, **Claude personal 2**, **Claude work**, and **Codex personal**. The dialog shows its target computer and offers only its locally managed environments. For an unnamed detected login, **Name this account** preselects its provider, environment, and existing login. Personal/Work labels organize accounts; they do not assert which identity the CLI authenticated.
4. Select **Windows** or **WSL · Ubuntu** in **Connection environment** in the account dialog. For an account already in the list, use **Manage account → Connect on another environment** to reuse its label. Each environment's connection retains its own login profile. One account connected on two environments still appears once in the list.
5. For the current CLI login, choose **Use the existing CLI login**. For additional Claude/Codex accounts, choose **Separate login for this account**, then **Open sign-in**. Existing connections expose sign-in and disconnect controls under **Manage account**; connections needing sign-in show that action directly. Sign-in follows the selected CLI: Windows first for existing WSL connections, or Linux for a separate WSL profile and the fallback. Linux credentials stay inside that distribution. Installation commands and current CLI settings are under **CLI setup** in each provider group.
6. Use **Chat** on a connection, or choose its account in the conversation’s **Agent** picker after choosing a computer and folder. Replies retain their original account/location label. Offline connections never fall back to another account.

The same account on several environments still has one provider-controlled allowance. Usage, model discovery, automatic titles, and chat follow the selected connection.

Both login methods use the same installed CLI:

| Method | Login and settings | When to use it |
| --- | --- | --- |
| **Use the existing CLI login** | Shares the current CLI login and configuration. WSL connections try Windows first, then the selected distribution if the Windows CLI is missing. Signing out or switching the CLI's account also changes this connection. | The personal or work account you already use in your terminal. |
| **Separate login for this account** | Creates a separate configuration directory for this connection. It starts without a login and needs its own sign-in. It keeps that login and settings independent of the default CLI and other profiles. | Your second personal account or a work account you want to keep separate. |

For example, reuse your existing personal Claude login, then add separate profiles for your second personal Claude account and work Claude account. Profiles do not create subscriptions or extra allowance. Sign in separately on Windows, WSL, and macOS; the relay shares account labels and chat data, never CLI credentials. Gemini/Antigravity currently supports the existing login only.

Remote computer cards display their shared account connections and online/offline status. You can chat through an online host or edit shared account labels here; creating CLI profiles and completing sign-in currently happen on the owning computer. **Manage account → Connect on this computer** reuses a remote account label on the computer you are using. Labels without connections remain under **Accounts without a computer**, where they can be connected again or removed.

**WSL running** describes the distribution's operating-system state; **Managed here** means the Windows app launches its connections. Account cards report whether the chosen Windows or Linux CLI is installed and signed in. Discovery errors retain inventory and show state as unavailable. Missing distributions are marked **Not detected in Windows**. Remote computers use the Windows host's heartbeat to reach WSL connections; WSL does not need its own heartbeat.

Automatic mode and existing WSL connections use the installed Windows CLI first. If it is missing, an existing WSL connection falls back only to its selected distribution. Separate account profiles stay in their own environment. Authentication, quota, or response failures never trigger an automatic replay or switch to another login. Native Windows profiles and separate WSL profiles remain independent.

Using a WSL folder with Windows Claude/Codex does not require installing that CLI again in WSL. The Linux fallback and separate WSL profiles require a Linux CLI, Bash, and `setsid` (standard Ubuntu tooling). The bridge checks common user installation paths and the default nvm Node installation, and rejects Windows CLI shims inside WSL. Inventory listing does not start distributions; opening a WSL folder or using a WSL CLI can start its distribution. Antigravity/Gemini continues to use its native CLI.

WSL discovery uses Microsoft's [`wsl --list --quiet` and `--list --running --quiet` commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands). Every management dropdown uses the same accessible design-system picker as conversations, with keyboard navigation and search.

## Local relay

Requires Node.js 24+. From the repository root, install with `npm ci`, then supply a private random pairing key through the environment. PowerShell example:

```powershell
$env:AGENT_STUDIO_RELAY_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:AGENT_STUDIO_RELAY_DATA = Join-Path $PWD '.relay-data'
npm run relay
```

Keep the key in your password manager and paste its value into **Relay pairing key** on each app. The server does not print it. On the server computer, use `http://127.0.0.1:4317`. Pairing shares this workspace's chats and account labels with the relay and other paired devices. Browser preview does not pair or execute CLIs.

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
