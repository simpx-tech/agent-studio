// Isolated native QA only. --reply submits one small real Codex prompt via automatic routing.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9431');
let connectionId, accountId;
const page = browser.contexts()[0].pages()[0];
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
try {
  await page.goto('http://localhost:1420/');
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
  if ((await invoke('plugin:app|identifier')) !== 'com.vinicius.agentstudio.federation-qa')
    throw new Error('Refusing to modify a non-QA app');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const statuses = await invoke('detect_providers');
  const codex = statuses.find((s) => s.id === 'codex');
  expect(codex.installed).toBe(true);
  expect(codex.location).toBe('Windows');
  const discovery = await invoke('discover_wsl');
  const distro = discovery.distributions[0];
  if (!distro) throw new Error('This opt-in check requires a WSL distribution');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(
    page.locator('.environment-row').filter({ hasText: `WSL · ${distro.name}` }),
  ).toContainText('Managed here');
  const workspace = await invoke('load_workspace');
  accountId = crypto.randomUUID();
  connectionId = crypto.randomUUID();
  workspace.fleet.accounts.push({
    id: accountId,
    name: 'WSL bridge QA',
    provider: 'codex',
    purpose: 'personal',
  });
  workspace.fleet.connections.push({
    id: connectionId,
    accountId,
    environmentId: distro.id,
    profile: 'existing',
  });
  await invoke('save_workspace', { workspace });
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const linux = await invoke('detect_connection', { provider: 'codex', connectionId });
  if (linux.installed) expect(linux.location).toBe(`WSL · ${distro.name}`);
  else expect(linux.detail).toContain('CLI was not found');
  await expect(page.locator('.fleet-account').filter({ hasText: 'WSL bridge QA' })).toContainText(
    linux.installed ? 'WSL' : 'Check CLI setup',
  );
  await expect(page.getByRole('button', { name: 'Computers & accounts', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('select')).toHaveCount(0);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/connections-unified-native.png' });
  let realWindowsReply = false;
  if (process.argv.includes('--reply')) {
    expect(codex.auth).toBe('ready');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: 'Codex', exact: true }).click();
    await page.getByRole('combobox', { name: 'Account and environment' }).click();
    await page.getByRole('option', { name: 'Automatic · Windows first', exact: true }).click();
    await page.getByRole('combobox', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: /^CLI default/ }).click();
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Reply with exactly: windows bridge ready');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 90_000,
    });
    await expect(page.getByTestId('message').last()).toContainText('windows bridge ready');
    await expect(page.getByTestId('message').last()).toContainText('Windows · CLI login');
    realWindowsReply = true;
    await page.screenshot({ path: 'artifacts/windows-first-native-reply.png' });
  }
  expect(errors).toEqual([]);
  const result = {
    checkedAt: new Date().toISOString(),
    nativePreferred: codex.location,
    wslDistribution: distro.name,
    wslCodexInstalled: linux.installed,
    directWslDetection: true,
    unifiedConnections: true,
    realWindowsReply,
    rendererErrors: errors,
  };
  await writeFile('artifacts/wsl-bridge-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (connectionId && accountId) {
    const current = await invoke('load_workspace');
    current.fleet.connections = current.fleet.connections.filter((c) => c.id !== connectionId);
    current.fleet.accounts = current.fleet.accounts.filter((a) => a.id !== accountId);
    await invoke('save_workspace', { workspace: current });
    await page.reload();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
  }
  await browser.close();
}
