# Mobile PWA

The initial VPS deployment is live at [studio.72.61.63.95.sslip.io](https://studio.72.61.63.95.sslip.io). See [production operations and pairing](DEPLOYMENT.md) for service paths, SSH access, updates, and verification boundaries.

The same Agent Studio frontend runs as an installable web app. Its server serves both the public app build and the authenticated relay API on one origin. Your phone can select a computer and folder, start chats, change the next reply’s model/reasoning, send image attachments, read progress and history, inspect context/usage, and stop remote replies. The computer running each CLI must keep Agent Studio open and paired.

The phone shell follows both the height and vertical offset of the visible viewport while the keyboard is open. After dismissal it returns to the CSS dynamic viewport, clears stale offsets, and restores the home-indicator inset. The keyboard does not need that bottom inset. Focus transitions are checked through their animation, and pinch zoom stays under browser control. Message updates scroll only the conversation pane. These choices account for the distinction between the [layout and visual viewports](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).

Shared dropdowns open next to their trigger, shift inside the visible screen, and open upward when there is more room above. The browser top layer keeps them outside the horizontally scrolling settings row and dialog clipping. Scrolling a dropdown does not scroll the surrounding page or toolbar.

## Hosting

The existing Docker setup builds the frontend in a separate stage and includes it in the relay image:

```sh
export AGENT_STUDIO_RELAY_TOKEN="your-private-random-key-at-least-32-characters"
docker compose -f relay/compose.yml up -d --build
```

Use a random pairing key stored in your secret manager. Put Caddy or another HTTPS proxy in front of port 4317; `relay/Caddyfile.example` proxies both the PWA and API. Preserve the original Host header. Serve at the domain root, with no path prefix. Compose binds the port to loopback and keeps relay data in a persistent volume. No hosting account or deployed server is required to build the artifact.

For local development, use Node 24+, `npm ci`, `npm run build`, then `npm run relay` with the same environment variables. The relay defaults to `127.0.0.1:4317`, public files in `build/`, and state in `.relay-data/`. `AGENT_STUDIO_WEB_DIR` can name another dedicated public build directory. Rebuild and restart the server to publish an update. Never point the public directory at source, app data, or relay data.

## Phone setup

1. Pair each desktop host with the server in **Connections → Set up sync**. Sign in to its provider CLIs there.
2. Open the server’s HTTPS address on the phone. Choose **Set up → Set up sync** and enter its pairing key. The browser uses the current server address.
3. Use the conversation menu to start a chat. Choose the execution computer, browse its folders, and select its agent account. Swipe the settings row to reach Model and Reasoning. The ellipsis opens additional conversation actions.
4. Use **Install app** when offered. In Safari on iPhone, use **Share → Add to Home Screen**. Android browsers offer **Install app** or **Add to Home screen**. Enter inserts a newline on phone layouts; tap the send arrow to submit.

Installability requires HTTPS (loopback is allowed for development). See [MDN’s installation guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable). The shell cache uses [SvelteKit’s service worker support](https://svelte.dev/docs/kit/service-workers); desktop Tauri windows never register it.

## Pairing, storage, and reconnecting

The browser exchanges the pairing key for an HttpOnly, SameSite=Strict session cookie, Secure on HTTPS. It expires after seven days; disconnecting removes it, and restarting the server invalidates all browser sessions. The key is never stored in localStorage, sessionStorage, exports, or the service worker cache. Native clients retain their existing in-memory bearer authentication. Anyone holding a valid key or browser session is a trusted workspace member; this is a single-user server, not a multi-user permission system.

The phone retains conversation data and sync checkpoints in browser localStorage, separately from desktop data. Storage failures remain visible, and browser storage limits may be lower than the server’s 20 MB workspace limit. Disconnecting leaves this local history available. Clear site data to remove it on a shared phone. Provider credentials never leave the execution host.

The service worker caches only the public app shell. API responses, authentication, and chat payloads are never cached there. Offline, the shell and saved history remain readable; commands are not queued or replayed. Reconnecting refreshes server state. A suspended/closed phone does not stop the desktop agent; its host retains checkpoints. If the relay restarts during a reply, check the host’s retained result before retrying. Browser notification delivery, unattended host daemons, and waking sleeping computers are not implemented.

New app versions activate after existing tabs close, avoiding a forced reload during a reply. Reload/reopen after an update to use it. For verification evidence and remaining physical-device/deployment boundaries, see [VERIFICATION.md](VERIFICATION.md).
