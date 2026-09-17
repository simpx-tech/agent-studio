# Sharing one VPS with separate users

One Agent Studio relay can host your workspace and up to 100 additional private workspaces at the same HTTPS address. Create a different workspace key for each person. Their chats, computers, environments, account labels, jobs, presence, browser sessions, and notifications stay within that workspace. Devices using the same key intentionally share that person's workspace.

Your existing `AGENT_STUDIO_RELAY_TOKEN`, root workspace files, and relay instance identity remain the owner's workspace. An upgrade does not copy your data into new workspaces. Do not give your owner key to someone who should have a separate workspace.

## Choose an admin workspace

There is exactly one enabled **Admin** workspace. Your existing owner workspace starts as Admin; new workspaces start as **Member**. Roles live in the private server registry and cannot be changed by editing a chat export or browser cache.

Open **Settings → Workspace administration** in the paired admin workspace. You can create member workspaces, rename them, transfer administration, issue replacement keys, and disable member access. The admin list contains names, roles, IDs, and access status; it does not load other people's chats or computers. Members do not get these controls or the workspace list.

To use a specific workspace as your administration workspace, first create it as a member and save its key. Verify that you can open it using a separate browser profile or desktop installation. From the current admin workspace, choose **Manage → Role → Administrator**, then confirm **Transfer administration**. The target becomes the only admin and the previous admin becomes a member in the same server operation. The previous admin's management controls close immediately. You cannot demote or disable the only admin without transferring its role, or transfer administration to a disabled workspace. Creating an admin directly is rejected so the new key can be saved before access is transferred.

All devices paired with an admin workspace share its authority. Only grant this role to people you trust to control access: an admin can issue another workspace a replacement key and use that key to access it. Ordinary chat, computer, job, and notification requests still operate only within the currently authenticated workspace.

## Create access in Settings

Choose **Create workspace** and enter a name. The new workspace starts empty as a member. Copy the displayed private key and save it in your password manager before closing the dialog; it is shown only once and cannot be recovered from the list. Send it privately to its intended user with the server's HTTPS address.

The recipient installs Agent Studio on their computer, signs in to their own provider CLIs in **Connections**, and uses **Set up sync** with the shared server address and their private workspace key. They can pair phones and additional computers with the same key. The VPS serves the PWA and relay; agents continue to execute on that person's paired computers. This does not provision Linux users, hosted agent processes, or provider subscriptions on the VPS.

## Manage access

Use a workspace's management dialog to rename it or change its role. Key rotation replaces its key, revokes old sessions and push subscriptions, and re-enables a disabled workspace. Disabling denies access and revokes sessions. These actions preserve saved chats and leave other workspaces connected. Changes take effect without restarting the relay. Re-pair retained devices after rotation.

The current admin workspace cannot rotate or disable itself from the app. Transfer administration first, or use the local CLI to rotate its key; the CLI also rejects disabling the only admin. The original owner key remains managed through `AGENT_STUDIO_RELAY_TOKEN` and the service maintenance process, and its access cannot be disabled in the app. Its name can be changed and its admin role can be transferred. Already delivered notifications and work executing on a disconnected computer cannot be recalled; the host retains its local results.

Admin controls refresh while Settings is visible and on focus. If access changes during a request, the server checks the current role and session before applying it. Switching or disconnecting the workspace clears the admin list and any newly issued key from the UI. Keys are never saved in workspace exports, browser storage, or conversation history.

## Server commands and recovery

The local CLI remains available for provisioning and recovery. Run it as the relay service user with the same `AGENT_STUDIO_RELAY_DATA` directory as the running relay.

For Docker Compose, from the repository root:

```sh
docker compose -f relay/compose.yml exec relay node relay/manage.ts create "Alex"
```

For this VPS's systemd installation:

```sh
sudo -u agent-studio env AGENT_STUDIO_RELAY_DATA=/var/lib/agent-studio \
  /opt/agent-studio/runtimes/node-v24.20.0-linux-x64/bin/node \
  /opt/agent-studio/current/relay/manage.ts create "Alex"
```

For a local relay, `npm run relay:users -- create "Alex"` uses `AGENT_STUDIO_RELAY_DATA`, defaulting to `.relay-data`. Only create and rotate commands print private keys; do not capture their output in shared logs.

Use the same command prefix above with these arguments:

```sh
node relay/manage.ts list
node relay/manage.ts rotate WORKSPACE_ID
node relay/manage.ts disable WORKSPACE_ID
node relay/manage.ts role WORKSPACE_ID admin
node relay/manage.ts role WORKSPACE_ID member
node relay/manage.ts role owner admin
```

`list` shows workspace metadata without keys or chats. `role WORKSPACE_ID admin` transfers the only admin role to that enabled workspace, including through the CLI. `role owner admin` transfers it back to the owner for recovery. Every other workspace becomes a member. Role changes and disabling preserve exactly one enabled admin. Owner key rotation requires updating the environment key and restarting the service; it revokes owner sessions only.

## Device privacy

The web/PWA starts on **Sign in to your workspace**. Enter the private workspace key issued by the administrator; no workspace list or separate username is needed. The key is hidden by default; use the eye button to show or hide it while entering it. Submitting hides the key again. The chat and management interface appears only after the server verifies the session and workspace. Returning sessions restore automatically. **Connections → Sync settings → Sign out** returns to the login page, as do expired or revoked sessions and workspace changes in another tab.

The PWA verifies its session before showing saved server conversations. Browser caches and sync checkpoints belong to the authenticated workspace. Disconnecting or switching accounts clears the visible conversation and draft, and stale tabs cannot sync using another workspace's cookie. A fresh unauthenticated launch does not show cached chats; an already authenticated open tab can retain its current workspace during a temporary network outage. Use separate browser profiles when different people share a computer: local browser caches are not encrypted against someone with access to that browser profile.

A desktop installation binds to its first paired workspace, including its server origin and instance identity. Disconnecting removes saved authentication but retains this binding and local conversations. Another person's key is rejected before replacing the saved pairing. Use a separate OS user or isolated Agent Studio installation for another person; a CLI account profile alone does not separate desktop chat data. When moving servers, restore the existing data and identity instead of pairing an existing installation to an empty replacement.

## Storage and backups

Keep the entire relay data directory private and persistent. Version 2 of `workspaces.json` stores workspace metadata and roles, pairing-key hashes, and private session secrets, enforcing exactly one enabled admin. On startup, a version 1 registry is upgraded under the administration lock: retain the owner if it was admin; otherwise retain the oldest enabled admin (workspace ID breaks timestamp ties). All others become members, including disabled admins. Keys, sessions, names, and chat files are preserved. Registries with no enabled admin or invalid version 2 roles fail closed and are preserved. Each additional workspace has its own `workspaces/WORKSPACE_ID/` directory containing `workspace.json`, `browser-sessions.json`, and `web-push.json`. The owner's files keep their original paths. Back up this complete directory and protect the owner's environment key separately. Never publish these files or copy them into the public frontend build. Run only one relay process per data directory.

Older relay releases cannot read the version 2 registry. A rollback across this upgrade requires restoring the private registry from the pre-upgrade backup while the service is stopped; never replace chat or session files with older copies as a side effect.

The relay enforces separation between users of the app. The VPS administrator can still read server files and backups; chats are not end-to-end encrypted. Everyone with a person's workspace key is a trusted member of that workspace and can use its paired execution hosts. Per-device roles and quotas are not provided.
