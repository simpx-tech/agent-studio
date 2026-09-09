// Opt-in packaged-app check; uses a few small requests on the signed-in CLI accounts.
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9428');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://tauri.localhost/'));
if (!page) throw new Error('Packaged app not found');
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const before = await invoke('load_workspace');
const marker = `Title QA ${crypto.randomUUID()}`;
const errors = [];
const results = [];
page.on('pageerror', (error) => errors.push(error.message));
const pick = async (label, name) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
const findChat = (workspace) =>
  workspace.conversations.find((c) => c.messages[0]?.blocks[0]?.text.startsWith(marker));
try {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick('Agent', 'Codex');
  await pick('Model', 'GPT-5.6-Sol');
  await pick('Reasoning', 'Low');
  await page
    .getByLabel('Message', { exact: true })
    .fill(
      `${marker}. Help me plan a small balcony herb garden. For now reply only: We can grow basil.`,
    );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-status',
    'complete',
    { timeout: 90000 },
  );
  await expect
    .poll(async () => findChat(await invoke('load_workspace'))?.titleStatus, { timeout: 40000 })
    .not.toBe('pending');
  const chat = findChat(await invoke('load_workspace'));
  expect(chat.titleStatus).toBe('generated');
  expect(chat.titleSource).toEqual({ provider: 'codex', model: 'gpt-5.6-luna' });
  expect(chat.title).toMatch(/garden|herb|balcony|basil/i);
  expect(chat.settings).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning: 'low',
  });
  expect(chat.messages.at(-1).settings).toEqual(chat.settings);
  const expectedPreferences = (await invoke('load_workspace')).preferences;
  await page.screenshot({ path: 'artifacts/titles-native.png' });
  results.push({
    provider: 'codex',
    model: chat.titleSource.model,
    title: chat.title,
    chatResponse: 'complete',
  });
  console.log('Codex: title generated with Luna while the chat used Sol; saved settings verified.');
  await page.reload();
  await page.getByRole('button', { name: chat.title, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6-Sol',
  );
  expect((await invoke('load_workspace')).preferences).toEqual(expectedPreferences);
  for (const [provider, model] of [
    ['claude', 'haiku'],
    ['gemini', 'gemini-3.8-flash'],
  ]) {
    const result = await invoke('generate_title', {
      conversationId: crypto.randomUUID(),
      provider,
      firstMessage: 'Quero planejar uma horta de ervas na varanda do meu apartamento.',
    });
    expect(result).toMatchObject({ provider, model });
    expect(result.title).toMatch(/horta|erva|varanda/i);
    results.push(result);
    console.log(`${provider}: generated a concise Portuguese title with ${model}.`);
  }
  expect(errors).toEqual([]);
} finally {
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  if (await stop.count()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 15000 });
  }
  const saved = await invoke('load_workspace');
  const synthetic = findChat(saved);
  if (synthetic?.titleStatus === 'pending') {
    await invoke('cancel_title', { conversationId: synthetic.id });
    await expect
      .poll(async () => findChat(await invoke('load_workspace'))?.titleStatus, { timeout: 10000 })
      .not.toBe('pending');
  }
  const latest = await invoke('load_workspace');
  latest.conversations = latest.conversations.filter((c) => c.id !== synthetic?.id);
  latest.preferences = before.preferences;
  await invoke('save_workspace', { workspace: latest });
  await page.reload();
  const after = await invoke('load_workspace');
  expect(after.conversations).toEqual(before.conversations);
  expect(after.preferences).toEqual(before.preferences);
  expect(after.legacyAgents).toEqual(before.legacyAgents);
  await browser.close();
}
await writeFile(
  'artifacts/titles-smoke.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      results,
      persistedAfterReload: true,
      chatSettingsUnchanged: true,
      originalChatsUnchanged: true,
      originalPreferencesRestored: true,
      errors,
    },
    null,
    2,
  ),
);
console.log('Automatic titles passed for all three providers; synthetic chat removed.');
