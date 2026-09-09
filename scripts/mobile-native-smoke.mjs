// Opt-in real-provider smoke. Start npm run tauri dev with native-mobile.tauri.json,
// isolated CARGO_TARGET_DIR/WEBVIEW2_USER_DATA_FOLDER and CDP 9447 first.
// The loopback relay remains running after success for inspection.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';

await mkdir('artifacts/mobile-native', { recursive: true });
const data = await mkdtemp(join(tmpdir(), 'studio-mobile-relay-'));
const folder = await mkdtemp(join(tmpdir(), 'studio-mobile-project-'));
const token = crypto.randomUUID() + crypto.randomUUID();
const server = createRelay({ token, directory: data, webDirectory: resolve('build') });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const nativeBrowser = await chromium.connectOverCDP('http://127.0.0.1:9447');
const native = nativeBrowser
  .contexts()[0]
  .pages()
  .find((p) => /localhost:1420|127\.0\.0\.1:1420/.test(p.url()));
if (!native) throw new Error('The isolated native mobile QA app has not rendered.');
const invoke = (command, args = {}) =>
  native.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
await expect(native.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
const installation = await invoke('get_installation');
const initial = await invoke('load_workspace');
if (initial?.conversations?.length)
  throw new Error(
    'Use a fresh isolated mobile QA identity; refusing to alter existing conversations.',
  );
await native.getByRole('button', { name: 'Connections', exact: true }).click();
await expect
  .poll(async () => (await invoke('load_workspace'))?.fleet.connections.length ?? 0, {
    timeout: 60_000,
  })
  .toBeGreaterThan(0);
await native.getByRole('button', { name: 'Set up sync', exact: true }).click();
await native.getByLabel('Relay URL', { exact: true }).fill(url);
await native.getByLabel('Relay pairing key', { exact: true }).fill(token);
await native.getByRole('button', { name: 'Pair & sync', exact: true }).click();
await expect(native.getByText(/^Synced /)).toBeVisible({ timeout: 30_000 });
const workspace = await invoke('load_workspace');
const computer = workspace.fleet.computers.find((c) => c.id === installation.computerId);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const phone = await context.newPage();
const errors = [];
phone.on('pageerror', (error) => errors.push(error.message));
const results = [];
try {
  await phone.goto(url);
  await phone.getByRole('button', { name: 'Set up', exact: true }).click();
  await phone.getByRole('button', { name: 'Set up sync', exact: true }).click();
  await phone.getByLabel('Relay pairing key').fill(token);
  await phone.getByRole('button', { name: 'Pair & sync' }).click();
  await expect(phone.getByRole('dialog')).toHaveCount(0);
  for (const provider of ['codex', 'claude']) {
    const account = workspace.fleet.accounts.find(
      (a) =>
        a.provider === provider &&
        workspace.fleet.connections.some(
          (c) =>
            c.accountId === a.id && c.environmentId === installation.id && c.profile === 'existing',
        ),
    );
    const connection = workspace.fleet.connections.find(
      (c) => c.accountId === account?.id && c.environmentId === installation.id,
    );
    if (!connection) {
      results.push({ provider, verified: false, reason: 'No existing connection.' });
      continue;
    }
    const status = await invoke('detect_connection', { provider, connectionId: connection.id });
    if (!status.installed || status.auth !== 'ready') {
      results.push({ provider, verified: false, reason: 'Provider requires sign-in.' });
      continue;
    }
    await phone.getByRole('button', { name: 'Open conversations' }).click();
    await phone.getByRole('button', { name: 'New conversation', exact: true }).click();
    await phone.getByRole('combobox', { name: 'Computer', exact: true }).click();
    await phone.getByRole('option', { name: computer.name, exact: true }).click();
    await phone.getByRole('combobox', { name: 'Folder', exact: true }).click();
    await phone.getByRole('option', { name: 'Browse folders…', exact: true }).click();
    await expect(phone.getByRole('button', { name: 'Use this folder' })).toBeEnabled({
      timeout: 30_000,
    });
    await phone.getByLabel('Folder path').fill(folder);
    await phone.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(phone.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
    await phone.getByRole('button', { name: 'Use this folder' }).click();
    await expect(phone.getByRole('dialog')).toHaveCount(0);
    await phone.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await phone.getByRole('option', { name: provider === 'codex' ? /^Codex/ : /^Claude/ }).click();
    const catalog = await invoke('list_models', { provider, connectionId: connection.id });
    const preferred = catalog[provider].find(
      (m) => m.id === (provider === 'codex' ? 'gpt-5.6-luna' : 'haiku'),
    );
    if (preferred) {
      await phone.getByRole('combobox', { name: 'Model', exact: true }).click();
      await phone.getByRole('option', { name: preferred.name, exact: true }).click();
    }
    const marker = `PWA_${provider.toUpperCase()}_${crypto.randomUUID().slice(0, 8)}`;
    await phone
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`Reply with only ${marker}. Do not use any tools.`);
    await expect(phone.getByRole('button', { name: 'Send message' })).toBeEnabled({
      timeout: 30_000,
    });
    await phone.getByRole('button', { name: 'Send message' }).click();
    await expect(phone.locator('.message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 120_000,
    });
    await expect(phone.locator('.message').last()).toContainText(marker);
    await phone.screenshot({ path: `artifacts/mobile-native/${provider}-phone.png` });
    await expect
      .poll(
        async () =>
          (await invoke('load_workspace')).conversations.some((c) =>
            c.messages.some(
              (m) =>
                m.role === 'assistant' &&
                m.status === 'complete' &&
                m.blocks.some((b) => b.type === 'markdown' && b.text.includes(marker)),
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    results.push({
      provider,
      verified: true,
      model: preferred?.id ?? 'default',
      hostCheckpoint: true,
    });
  }
  expect(results.some((result) => result.verified)).toBe(true);
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/mobile-native/result.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        results,
        errors,
        physicalPhone: false,
        publicHttpsDeployment: false,
      },
      null,
      2,
    ),
  );
  await browser.close();
  console.log(JSON.stringify({ results, relay: url, native: 'Isolated QA app remains open.' }));
} catch (error) {
  await phone.screenshot({ path: 'artifacts/mobile-native/failure.png' });
  await writeFile('artifacts/mobile-native/failure.txt', String(error));
  await browser.close();
  server.closeAllConnections();
  server.close();
  throw error;
}
