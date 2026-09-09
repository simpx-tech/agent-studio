// Opt-in real provider check in the separate cwd-qa app. Restores its saved workspace.
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9433');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes('1420'));
if (!page) throw new Error('Start scripts/native-cwd.tauri.json first.');
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
let before;
const result = { checkedAt: new Date().toISOString(), providers: {}, errors: [] };
try {
  if ((await invoke('plugin:app|identifier')) !== 'com.vinicius.agentstudio.cwd-qa')
    throw new Error('Wrong native QA identity.');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
  before = await invoke('load_workspace');
  if (!before || before.conversations.length)
    throw new Error('Use an empty isolated cwd QA workspace.');
  page.on('pageerror', (e) => result.errors.push(e.message));
  const project = resolve('.');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByLabel('Folder path', { exact: true }).fill(project);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('button', { name: 'src-tauri', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'GPT-5.6-Sol', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reasoning', exact: true }).click();
  await page.getByRole('option', { name: 'Low', exact: true }).click();
  const prompt =
    'Working folder QA: Without running tools, reply with only the absolute working directory reported by your session environment. Do not infer it from earlier messages.';
  await page.getByLabel('Message', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const reply = page.getByTestId('message').last();
  await expect(reply).toHaveAttribute('data-status', 'complete', { timeout: 120_000 });
  await expect(reply).toContainText(project, { ignoreCase: true });
  await expect(reply).not.toContainText('chat-runtime');
  await page.screenshot({ path: 'artifacts/selected-cwd-native.png' });
  const saved = await invoke('load_workspace');
  const conversation = saved.conversations[0];
  expect(conversation.location.path).toBe(project);
  result.providers.codex = { status: 'complete', selectedDirectoryReported: true };
  // Use the real IPC channel without creating a second saved conversation.
  const run = (request, connectionId) =>
    page.evaluate(
      async ({ request, connectionId }) => {
        const events = [];
        const internal = window.__TAURI_INTERNALS__;
        const id = internal.transformCallback((event) => events.push(event.message));
        try {
          const status = await internal.invoke('run_agent', {
            request,
            connectionId,
            onEvent: `__CHANNEL__:${id}`,
          });
          return {
            status,
            text: events
              .filter((e) => e?.kind === 'text')
              .map((e) => e.text)
              .join(''),
          };
        } catch (error) {
          return { error: String(error) };
        } finally {
          internal.unregisterCallback(id);
        }
      },
      { request, connectionId },
    );
  const request = {
    runId: crypto.randomUUID(),
    location: {
      ...conversation.location,
      path: join(project, `missing-folder-${crypto.randomUUID()}`),
    },
    agent: conversation.settings,
    messages: [{ role: 'user', text: prompt }],
  };
  const missing = await run(request, conversation.settings.connectionId);
  expect(missing.error).toContain('selected folder is unavailable');
  result.missingFolderRejected = true;
  for (const provider of ['claude', 'gemini']) {
    const accountIds = saved.fleet.accounts.filter((a) => a.provider === provider).map((a) => a.id);
    const connection = saved.fleet.connections.find(
      (c) =>
        c.environmentId === conversation.location.environmentId && accountIds.includes(c.accountId),
    );
    if (!connection) {
      result.providers[provider] = { skipped: 'No existing connection' };
      continue;
    }
    const status = await invoke('detect_connection', { provider, connectionId: connection.id });
    if (!status.installed || status.auth !== 'ready') {
      result.providers[provider] = { skipped: 'Existing login not ready' };
      continue;
    }
    const response = await run(
      {
        runId: crypto.randomUUID(),
        location: conversation.location,
        agent: {
          provider,
          model: provider === 'claude' ? 'haiku' : 'gemini-3.8-flash',
          reasoning: 'low',
          instructions: '',
        },
        messages: [{ role: 'user', text: prompt }],
      },
      connection.id,
    );
    expect(response.error).toBeUndefined();
    expect(response.status).toBe('complete');
    result.providers[provider] = {
      status: response.status,
      selectedDirectoryReported: response.text
        .toLowerCase()
        .replaceAll('\\\\', '\\')
        .includes(project.toLowerCase()),
    };
    expect(result.providers[provider].selectedDirectoryReported).toBe(true);
  }
  expect(result.errors).toEqual([]);
} finally {
  if (before) {
    await invoke('save_workspace', { workspace: before });
    await page.reload();
    expect(await invoke('load_workspace')).toEqual(before);
    result.workspaceRestored = true;
  }
  result.finishedAt = new Date().toISOString();
  await writeFile('artifacts/selected-cwd-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
