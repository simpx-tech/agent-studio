# Production VPS

Agent Studio was deployed on 2026-09-09 from application commit `12f2d6d`.

- Initial HTTPS endpoint: https://studio.72.61.63.95.sslip.io
- VPS: `72.61.63.95` / `srv1169603`, Debian 13.
- Windows SSH alias: `agent-studio-vps`. Use `ssh agent-studio-vps`; password authentication is not needed. The dedicated private key is in the local user's `.ssh` directory and must never be copied into this repository. Existing SSH identities were preserved.
- Release: `/opt/agent-studio/releases/12f2d6d`, selected by `/opt/agent-studio/current`.
- Runtime: `/opt/agent-studio/runtimes/node-v24.20.0-linux-x64`, downloaded from the official Node distribution and SHA-256 checked. No global Node or Docker installation was changed.
- Service: `/etc/systemd/system/agent-studio.service`, enabled on boot and running as the dedicated `agent-studio` system user. It listens on `127.0.0.1:4317`; memory is capped at 512 MiB and CPU at one core.
- Persistent workspace: `/var/lib/agent-studio`, owned by the service user with mode 0700.
- Pairing configuration: `/etc/agent-studio/relay.env`, root-only mode 0600. A copy of the pairing key is in the Windows user's protected `.ssh/agent-studio-vps-pairing-key.txt`. Neither secret is committed. Do not print secrets in command logs.
- HTTPS: the existing Caddy service imports `/etc/caddy/sites-enabled/agent-studio.caddy`. Caddy obtained a trusted Let's Encrypt certificate and manages renewal. The original Caddyfile backup path is recorded in `/etc/agent-studio/caddy-backup-path`.

## Connect a desktop and phone

Open **Connections → Set up sync** in the desktop app, enter the HTTPS endpoint and pairing key, and keep the desktop app open. Open the same endpoint on the phone and pair with that key. Provider sign-in stays on the desktop. Deploying the server does not automatically upload or switch an existing desktop workspace.

The IP-based hostname needs no user-managed DNS record. To use `studio.simpx.net`, point its A record at `72.61.63.95`, confirm public resolution, then add that hostname to the dedicated Caddy site, validate, and reload Caddy. Preserve the previous hostname during migration. Browser storage and sessions are scoped to the origin, so pair the new origin separately.

## Inspect and update

Read status with `systemctl status agent-studio` and logs with `journalctl -u agent-studio`. Do not print `relay.env`. The server only hosts the PWA and relay; it does not contain provider CLI credentials.

Build and test the final candidate before deployment. Create a new release directory, install dependencies using its lockfile, build the frontend, and run tests as an unprivileged user. Keep release files root-owned after building. Checksum source archives after transfer. Point `current` at the new release and restart only `agent-studio`. Keep the previous release for rollback. Never overwrite persistent data or generate a replacement pairing key as part of an ordinary update.

A restart preserves browser sessions when `/var/lib/agent-studio` and the pairing key are retained. Sessions are saved separately in `browser-sessions.json` with mode 0600 and keyed ID digests; keep it outside release directories and public assets. Pairing-key rotation invalidates these sessions. The first upgrade from the older memory-only implementation requires devices to pair once again; subsequent releases retain them. Unreadable session files fail startup without overwriting the file.

Transient relay jobs still do not survive a restart; check for active replies and coordinate maintenance before restarting. Durable workspace checkpoints survive. Back up `/var/lib/agent-studio/workspace.json`, `browser-sessions.json`, and the pairing configuration with restricted access, keeping pairing configuration separate. A scheduled/off-server backup is not configured by this deployment.

Validate a Caddy change before reloading with `caddy validate --config /etc/caddy/Caddyfile`. Use `systemctl reload caddy` rather than stopping it: the VPS also serves `deck.simpx.net`. The `deck-server`, `minecraft`, and `atm10sky` services belong to other workloads and must remain untouched.

## Verification

The VPS built the committed frontend and passed all 66 unit tests. Public HTTPS returned the app, manifest, icons, and service worker; HTTP redirected to HTTPS. Unauthenticated API calls returned 401 and private/source paths returned 404. A separate 390×844 browser verified login, Secure/HttpOnly/SameSite cookies, session restoration, logout, offline shell loading, and no renderer errors. Chromium reported no PWA installation errors. Existing service PIDs were unchanged and `deck.simpx.net` still returned HTTP 200.

Local evidence is in `artifacts/vps-deploy/public-result.json` and `public-mobile.png`. Physical iPhone/Android installation and a provider reply routed through this public VPS remain unverified; prior loopback native tests verified Codex and Claude execution. Browser installability checks need a dedicated persistent test profile: Playwright's default private context reports `in-incognito` even for a valid PWA. Normalize PowerShell-delivered shell scripts to LF before passing them to remote Bash.
