# Sharing one VPS with separate users

One Agent Studio relay can host your workspace and up to 100 additional private workspaces at the same HTTPS address. Create a different workspace key for each person. Their chats, computers, environments, account labels, jobs, presence, browser sessions, and notifications stay within that workspace. Devices using the same key intentionally share that person's workspace.

Your existing `AGENT_STUDIO_RELAY_TOKEN`, root workspace files, and relay instance identity remain the owner's workspace. An upgrade does not copy your data into new workspaces. Do not give your owner key to someone who should have a separate workspace.

## Create access

Run the administration command on the server as the relay service user, with the same `AGENT_STUDIO_RELAY_DATA` directory as the running relay. Administration is local to the server; there is no public user-management API.

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

For a local relay, `npm run relay:users -- create "Alex"` uses `AGENT_STUDIO_RELAY_DATA`, defaulting to `.relay-data`. The command returns the workspace ID and a newly generated private key. Save that key in your password manager and send it privately to its intended user with the HTTPS address. Only create and rotate commands display keys; listing cannot recover them.

The recipient installs Agent Studio on their computer, signs in to their own provider CLIs in **Connections**, and uses **Set up sync** with the shared server address and their private workspace key. They can pair phones and additional computers with the same key. New workspaces start empty. The VPS serves the PWA and relay; agents continue to execute on that person's paired computers. This does not provision Linux users, hosted agent processes, or provider subscriptions on the VPS.

## Manage access

Use the same command prefix above with these arguments:

```sh
node relay/manage.ts list
node relay/manage.ts rotate WORKSPACE_ID
node relay/manage.ts disable WORKSPACE_ID
```

`list` shows additional workspace IDs, names, creation times, and enabled status without keys or chats. `rotate` replaces one person's key, revokes their old sessions and push subscriptions, and re-enables a disabled workspace. `disable` denies that workspace access and revokes its sessions. Both preserve saved chats and leave other people connected. Changes take effect without restarting the relay. Re-pair retained devices after rotation. Already delivered notifications and work already executing on a disconnected computer cannot be recalled; the host retains its local results.

The existing owner key remains managed through `AGENT_STUDIO_RELAY_TOKEN`. Changing it requires the existing service maintenance process and revokes owner sessions only.

## Device privacy

The PWA verifies its session before showing saved server conversations. Browser caches and sync checkpoints belong to the authenticated workspace. Disconnecting or switching accounts clears the visible conversation and draft, and stale tabs cannot sync using another workspace's cookie. A fresh unauthenticated launch does not show cached chats; an already authenticated open tab can retain its current workspace during a temporary network outage. Use separate browser profiles when different people share a computer: local browser caches are not encrypted against someone with access to that browser profile.

A desktop installation binds to its first paired workspace, including its server origin and instance identity. Disconnecting removes saved authentication but retains this binding and local conversations. Another person's key is rejected before replacing the saved pairing. Use a separate OS user or isolated Agent Studio installation for another person; a CLI account profile alone does not separate desktop chat data. When moving servers, restore the existing data and identity instead of pairing an existing installation to an empty replacement.

## Storage and backups

Keep the entire relay data directory private and persistent. `workspaces.json` stores workspace metadata, pairing-key hashes, and private session secrets. Each additional workspace has its own `workspaces/WORKSPACE_ID/` directory containing `workspace.json`, `browser-sessions.json`, and `web-push.json`. The owner's files keep their original paths. Back up this complete directory and protect the owner's environment key separately. Never publish these files or copy them into the public frontend build. Run only one relay process per data directory.

The relay enforces separation between users of the app. The VPS administrator can still read server files and backups; chats are not end-to-end encrypted. Everyone with a person's workspace key is a trusted member of that workspace and can use its paired execution hosts. Per-device roles and quotas are not provided.
