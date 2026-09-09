// Isolated native QA only. Enumerates owned fixture folders and sends one small Codex prompt.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9432');
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes('1420'));
  if (!page) throw new Error('Start the isolated folder QA app first.');
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  if ((await invoke('plugin:app|identifier')) !== 'com.vinicius.agentstudio.locations-qa')
    throw new Error('Wrong native QA identity.');
  const before = await invoke('load_workspace');
  if (
    before.conversations.some((c) =>
      c.messages.some(
        (m) => m.role === 'user' && !m.blocks.every((b) => b.text.startsWith('Folder QA:')),
      ),
    )
  )
    throw new Error('QA workspace contains unrelated messages.');
  const identity = await invoke('get_installation');
  const root = resolve('artifacts/native-location-workspaces');
  const project = join(root, "Project 'quoted' $(literal)");
  await mkdir(join(project, 'child folder'), { recursive: true });
  // Rename only the isolated QA computer label, keeping paths out of provider messages.
  before.fleet.computers.find((c) => c.id === identity.computerId).name = 'Desktop QA';
  before.conversations = [];
  before.preferences.recentLocations = [];
  await invoke('save_workspace', { workspace: before });
  await page.reload();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByLabel('Folder path', { exact: true }).fill(project);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('button', { name: 'child folder', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/folder-picker-native.png' });
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'GPT-5.6-Sol', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reasoning', exact: true }).click();
  await page.getByRole('option', { name: 'Low', exact: true }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill('Folder QA: Reply with exactly: folder routing verified');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('message').last()).toContainText('folder routing verified');
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(
    page.locator('#conversation-panel-history').locator('.conversation-item'),
  ).toHaveCount(1);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('#conversation-panel-history').locator('.conversation-item').click();
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Restore conversation', exact: true }).click();
  await page.screenshot({ path: 'artifacts/folder-conversation-native.png' });
  const saved = await invoke('load_workspace');
  const conversation = saved.conversations[0];
  expect(conversation.location.path).toBe(project);
  const wsl = saved.fleet.environments.find(
    (e) => e.platform === 'wsl' && e.discoveredOn === identity.id,
  );
  let wslFolders = 'No WSL environment available';
  if (wsl) {
    const path = "/tmp/agent-studio-folder-qa/Project 'quoted' $(literal)";
    execFileSync(
      'wsl.exe',
      ['--distribution', wsl.distribution, '--exec', 'mkdir', '-p', '--', `${path}/child folder`],
      { windowsHide: true },
    );
    const listing = await invoke('list_folders', { environmentId: wsl.id, path });
    expect(listing.path).toBe(path);
    expect(listing.entries.some((entry) => entry.name === 'child folder')).toBe(true);
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
    await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
    await page.getByRole('combobox', { name: 'Folder environment', exact: true }).click();
    await page.getByRole('option', { name: wsl.name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByLabel('Folder path', { exact: true }).fill(path);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.getByRole('button', { name: 'child folder', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Gemini', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Agent', exact: true }).press('Escape');
    await page.screenshot({ path: 'artifacts/folder-wsl-native.png' });
    const mismatch = await page.evaluate(
      async ({ conversation, wsl }) => {
        try {
          await window.__TAURI_INTERNALS__.invoke('run_agent', {
            request: {
              runId: crypto.randomUUID(),
              agent: conversation.settings,
              location: { ...conversation.location, environmentId: wsl.id, path: '/tmp' },
              messages: [{ role: 'user', text: 'This mismatched request must never launch.' }],
            },
            connectionId: conversation.settings.connectionId,
            onEvent: '__CHANNEL__:999999',
          });
          return 'Unexpected success';
        } catch (e) {
          return String(e);
        }
      },
      { conversation, wsl },
    );
    expect(mismatch).toContain('does not belong');
    wslFolders =
      'Native WSL listing, literal paths, scoped CLI choices, and cross-environment rejection passed';
  }
  expect(errors).toEqual([]);
  const result = {
    checkedAt: new Date().toISOString(),
    nativeWindowsFolders: true,
    literalPaths: true,
    realCodexReply: true,
    archiveRestorePersistence: true,
    wslFolders,
    rendererErrors: errors,
    permissionMode: 'Conversation only; no tools or project writes enabled',
  };
  await writeFile('artifacts/locations-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
