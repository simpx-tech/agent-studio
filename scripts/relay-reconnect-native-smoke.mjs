// Start the isolated app with npm run tauri dev -- --no-watch --config
// scripts/native-relay.tauri.json, Vite on 1435, and WebView2 CDP on 9473.
// Set AGENT_STUDIO_NATIVE_EXE to that QA executable. No provider prompts are sent.
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';

const identifier = 'com.vinicius.agentstudio.relay-reconnect-qa';
const executable = process.env.AGENT_STUDIO_NATIVE_EXE;
if (!executable || !process.env.WEBVIEW2_USER_DATA_FOLDER?.includes(identifier))
  throw new Error('Supply the QA executable and isolated WebView profile.');
const output = resolve('artifacts/relay-reconnect-native');
await mkdir(output, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'studio-relay-reconnect-'));
const token = crypto.randomUUID() + crypto.randomUUID();
const server = createRelay({ token, directory: data, webDirectory: resolve('build') });
let unavailable = false;
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (unavailable && req.url === '/v1/state') {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{}');
  } else handler.call(server, req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [];
let nativeBrowser, native;
async function attach() {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch('http://127.0.0.1:9473/json/version')).ok;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  nativeBrowser = await chromium.connectOverCDP('http://127.0.0.1:9473');
  await expect
    .poll(
      () =>
        nativeBrowser
          .contexts()[0]
          ?.pages()
          .find((p) => p.url().startsWith('http://127.0.0.1:1435'))
          ?.url(),
      { timeout: 30_000 },
    )
    .toBeTruthy();
  native = nativeBrowser
    .contexts()[0]
    .pages()
    .find((p) => p.url().startsWith('http://127.0.0.1:1435'));
  native.on('pageerror', (e) => errors.push(e.message));
  const config = await native.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'),
  );
  expect(config).toBe(identifier);
  await native.getByRole('button', { name: 'Connections', exact: true }).click();
}
async function closeNative() {
  await native.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          await fetch('http://127.0.0.1:9473/json/version');
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}
async function reopen() {
  spawn(executable, [], {
    cwd: dirname(executable),
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  await attach();
}
await attach();
const invoke = (command) =>
  native.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
const initial = await invoke('load_workspace');
if (initial?.conversations?.length) throw new Error('Refusing QA over existing conversations.');
await expect(native.getByRole('button', { name: 'Set up sync', exact: true })).toBeVisible();
await native.getByRole('button', { name: 'Set up sync', exact: true }).click();
await native.getByLabel('Relay URL', { exact: true }).fill(url);
await native.getByLabel('Relay pairing key', { exact: true }).fill(token);
await native.getByRole('button', { name: 'Pair & sync', exact: true }).click();
await expect(native.getByText(/^Synced /)).toBeVisible({ timeout: 30_000 });
const identity = await invoke('get_installation');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const phone = await context.newPage();
phone.on('pageerror', (e) => errors.push(e.message));
await phone.goto(url);
await phone.getByRole('button', { name: 'Set up', exact: true }).click();
await phone.getByRole('button', { name: 'Set up sync', exact: true }).click();
await phone.getByLabel('Relay pairing key').fill(token);
await phone.getByRole('button', { name: 'Pair & sync' }).click();
await expect(phone.locator('.computer-state').first()).toHaveText('Online', { timeout: 30_000 });
const phoneInstallation = await phone.evaluate(() =>
  localStorage.getItem('agent-studio.installation'),
);
await closeNative();
await expect(phone.locator('.computer-state').first()).toHaveText('Offline', { timeout: 25_000 });
await phone.screenshot({ path: join(output, 'phone-host-closed.png') });
unavailable = true;
await reopen();
await expect(native.locator('.relay-state')).toContainText('Reconnecting', { timeout: 20_000 });
await native.screenshot({ path: join(output, 'desktop-retrying.png') });
unavailable = false;
await expect(native.getByText(/^Synced /)).toBeVisible({ timeout: 30_000 });
await expect(phone.locator('.computer-state').first()).toHaveText('Online', { timeout: 15_000 });
expect((await invoke('get_installation')).id).toBe(identity.id);
expect(await phone.evaluate(() => localStorage.getItem('agent-studio.installation'))).toBe(
  phoneInstallation,
);
await phone.screenshot({ path: join(output, 'phone-host-returned.png') });
await native.screenshot({ path: join(output, 'desktop-restored.png') });
for (const filename of ['workspace.json', 'sync-state.json', 'installation.json']) {
  const text = await readFile(join(process.env.LOCALAPPDATA, identifier, filename), 'utf8');
  expect(text.includes(token)).toBe(false);
}
expect(
  (await native.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(
    token,
  ),
).toBe(false);
expect(
  (await phone.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(
    token,
  ),
).toBe(false);
await native.getByText('Sync settings', { exact: true }).click();
await native.getByRole('button', { name: 'Disconnect relay', exact: true }).click();
await expect(native.locator('.relay-state')).toContainText('Local only');
await closeNative();
await reopen();
await expect(native.getByRole('button', { name: 'Set up sync', exact: true })).toBeVisible();
expect(await invoke('relay_resume')).toBeNull();
expect(errors).toEqual([]);
await writeFile(
  join(output, 'result.json'),
  JSON.stringify(
    {
      completedAt: new Date().toISOString(),
      nativeRestart: true,
      startupOutageRecovery: true,
      phoneUpdatedWithoutReload: true,
      nativeAndBrowserIdentitiesPreserved: true,
      noKeyInWorkspaceOrRendererStorage: true,
      disconnectSurvivesRestart: true,
      rendererErrors: errors,
      relay: url,
    },
    null,
    2,
  ),
);
await browser.close();
await nativeBrowser.close();
console.log(
  `PASS: native restart, outage recovery, automatic PWA status, and durable disconnect. Relay remains available at ${url}`,
);
