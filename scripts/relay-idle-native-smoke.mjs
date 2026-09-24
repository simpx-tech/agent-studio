// Relay polls stay idle while nothing changes. Run `npm run build`, then build the isolated
// app with `npx tauri build --debug --no-bundle --config scripts/native-relay-idle.tauri.json`
// (a scratch CARGO_TARGET_DIR while another copy runs), launch it with
// `npm run start:windows -- -Executable <exe>` and run this script. It pairs the app with an
// in-process relay, counts the app's relay requests and saved files while idle, syncs one change
// from each side, and disconnects. No provider prompts are sent.
import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';

const identifier = 'com.vinicius.agentstudio.relay-idle-qa';
const output = resolve('artifacts/relay-idle-native');
await mkdir(output, { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'studio-relay-idle-'));
const token = crypto.randomUUID() + crypto.randomUUID();
const server = createRelay({ token, directory: data });
const requests = [];
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  const path = new URL(req.url, 'http://relay').pathname;
  requests.push({ actor: req.headers['x-environment-id'], request: `${req.method} ${path}` });
  handler.call(server, req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
// Another device, for changes that arrive through the relay.
const other = crypto.randomUUID();
const relay = async (method, body) => {
  const response = await fetch(`${url}/v1/state`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-environment-id': other,
      'content-type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:19694');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://tauri.localhost'));
if (!page) throw new Error('Launch the QA app first.');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const invoke = (command) =>
  page.evaluate((command) => window.__TAURI_INTERNALS__.invoke(command), command);
expect(await invoke('plugin:app|identifier')).toBe(identifier);
const installation = (await invoke('get_installation')).id;
const files = ['workspace.json', 'sync-state.json'];
const modified = () =>
  Promise.all(
    files.map(async (f) => (await stat(join(process.env.LOCALAPPDATA, identifier, f))).mtimeMs),
  );
await page.evaluate(() => {
  window.longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.longTasks.push(Math.round(entry.duration));
  }).observe({ type: 'longtask' });
});
// Counts this app's relay requests, rewritten files and long tasks over an idle period.
async function idle(ms) {
  const before = await modified();
  requests.length = 0;
  await page.evaluate(() => (window.longTasks = []));
  await page.waitForTimeout(ms);
  const after = await modified();
  const counts = {};
  for (const { actor, request } of requests)
    if (actor === installation) counts[request] = (counts[request] ?? 0) + 1;
  return {
    requests: counts,
    rewritten: files.filter((_, i) => after[i] !== before[i]),
    longTasks: await page.evaluate(() => window.longTasks),
  };
}
function expectSettled(period) {
  expect(period.requests['GET /v1/state']).toBeUndefined();
  expect(period.requests['PUT /v1/state']).toBeUndefined();
  expect(period.requests['GET /v1/state/revision']).toBeGreaterThanOrEqual(4);
  expect(period.rewritten).toEqual([]);
}

// Each run creates a new relay workspace, and an installation keeps its first binding.
if (existsSync(join(process.env.LOCALAPPDATA, identifier, 'relay-workspace.json')))
  throw new Error('Start the QA app from a fresh data folder.');
await page.getByRole('button', { name: 'Connections', exact: true }).click();
await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
await page.getByLabel('Relay URL', { exact: true }).fill(url);
await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 60_000 });
await expect
  .poll(() =>
    requests.some(({ actor, request }) => actor === installation && request === 'PUT /v1/state'),
  )
  .toBe(true);
await page.getByRole('button', { name: 'Connections', exact: true }).click();
const size = (await stat(join(process.env.LOCALAPPDATA, identifier, 'workspace.json'))).size;
await page.waitForTimeout(8000);
const paired = await idle(15_000);
console.log('paired', JSON.stringify(paired));
expectSettled(paired);

// A change on this device reaches the relay once, then polls settle again.
const local = `Relay idle QA from this device ${Date.now()}`;
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.getByRole('textbox', { name: 'Claude chat instructions' }).fill(local);
await page.getByRole('button', { name: 'Save Claude instructions', exact: true }).click();
await expect(page.getByText('Saved for the next Claude reply.')).toBeVisible();
await expect
  .poll(async () => (await relay('GET')).workspace.claudeInstructions, { timeout: 20_000 })
  .toBe(local);
await page.waitForTimeout(6000);
const afterLocal = await idle(12_000);
console.log('after a local change', JSON.stringify(afterLocal));
expectSettled(afterLocal);

// Another device's change arrives, is applied and saved once, and polls settle again.
const state = await relay('GET');
const remote = `Relay idle QA from another device ${Date.now()}`;
await relay('PUT', {
  revision: state.revision,
  workspace: { ...state.workspace, claudeInstructions: remote },
});
await expect
  .poll(async () => (await invoke('load_workspace')).claudeInstructions, { timeout: 20_000 })
  .toBe(remote);
await page.waitForTimeout(6000);
const afterRemote = await idle(12_000);
console.log('after a remote change', JSON.stringify(afterRemote));
expectSettled(afterRemote);

await page.getByRole('button', { name: 'Connections', exact: true }).click();
await page.getByText('Sync settings', { exact: true }).click();
await page.getByRole('button', { name: 'Disconnect relay', exact: true }).click();
await expect(page.locator('.relay-state')).toContainText('Local only');
expect(errors).toEqual([]);
const result = {
  completedAt: new Date().toISOString(),
  workspaceBytes: size,
  paired,
  afterLocal,
  afterRemote,
  rendererErrors: errors,
};
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
await browser.close();
server.closeAllConnections();
await new Promise((r) => server.close(() => r()));
await rm(data, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
console.log('PASS: settled relay polls only check the revision and rewrite no files.');
