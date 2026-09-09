// Opt-in packaged-app check. Sends one small synthetic conversation through all three providers.
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { restoreWorkspace } from '../src/lib/domain.ts';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9428');
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().startsWith('http://tauri.localhost/'));
if (!page) throw new Error('Packaged app not found');
const load = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_workspace', {}));
const beforeRaw = await load();
const before = restoreWorkspace(beforeRaw);
const marker = `Chat settings QA ${crypto.randomUUID()}`;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const results = [];
const pick = async (label, name) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const appData = join(process.env.LOCALAPPDATA, 'com.vinicius.agentstudio');
const oldBytes = beforeRaw.version === 1 ? await readFile(join(appData, 'workspace.json')) : null;
try {
  await expect(page.getByRole('button', { name: 'Your agents' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Chat with Codex', exact: true }).click();
  const cases = [
    {
      provider: 'Codex',
      id: 'codex',
      model: 'GPT-5.6-Sol',
      modelId: 'gpt-5.6-sol',
      reasoning: 'Low',
      effort: 'low',
    },
    {
      provider: 'Claude',
      id: 'claude',
      model: 'Sonnet (latest)',
      modelId: 'sonnet',
      reasoning: 'Low',
      effort: 'low',
    },
    {
      provider: 'Gemini',
      id: 'gemini',
      model: 'Gemini 3.8 Flash',
      modelId: 'gemini-3.8-flash',
      reasoning: 'High',
      effort: 'high',
    },
  ];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    await pick('Agent', item.provider);
    await pick('Model', item.model);
    await pick('Reasoning', item.reasoning);
    await page
      .getByLabel('Message', { exact: true })
      .fill(
        index === 0
          ? `${marker}. Remember the word maple. Reply only with Noted.`
          : 'What word did I ask you to remember? Reply only with that word.',
      );
    await page.getByRole('button', { name: 'Send message' }).click();
    const answer = page.locator('[data-testid="message"]').last();
    await expect(answer).not.toHaveAttribute('data-status', 'running', { timeout: 120000 });
    await expect(answer).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.prose').last()).toContainText(index === 0 ? /Noted/i : /maple/i);
    await expect
      .poll(async () => {
        const workspace = await load();
        const chat = workspace.conversations.find((c) =>
          c.messages[0]?.blocks[0]?.text.startsWith(marker),
        );
        return chat?.messages.at(-1)?.status;
      })
      .toBe('complete');
    const saved = (await load()).conversations.find((c) =>
      c.messages[0]?.blocks[0]?.text.startsWith(marker),
    );
    expect(saved.settings).toMatchObject({
      provider: item.id,
      model: item.modelId,
      reasoning: item.effort,
    });
    expect(saved.messages.at(-1).settings).toMatchObject(saved.settings);
    results.push({
      provider: item.id,
      model: item.modelId,
      reasoning: item.effort,
      reply: 'complete',
    });
    console.log(
      `${item.provider}: explicit model and reasoning accepted; response and saved configuration verified.`,
    );
  }
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'Codex',
    'You',
    'Claude',
    'You',
    'Gemini',
  ]);
  await page.screenshot({ path: 'artifacts/chat-settings-native.png' });
  await pick('Agent', 'Codex');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6-Sol',
  );
  await expect(page.getByRole('combobox', { name: 'Reasoning', exact: true })).toContainText('Low');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6-Sol',
  );
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Codex');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6-Sol',
  );
  await expect(page.getByRole('combobox', { name: 'Reasoning', exact: true })).toContainText('Low');
  if (oldBytes)
    expect(digest(await readFile(join(appData, 'workspace-v1-backup.json')))).toBe(
      digest(oldBytes),
    );
  expect(errors).toEqual([]);
} finally {
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  if (await stop.count()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 15000 });
  }
  const saved = await load();
  saved.conversations = saved.conversations.filter(
    (c) => !c.messages[0]?.blocks[0]?.text.startsWith(marker),
  );
  saved.preferences = before.preferences;
  await page.evaluate(
    (workspace) => window.__TAURI_INTERNALS__.invoke('save_workspace', { workspace }),
    saved,
  );
  await page.reload();
  const after = await load();
  expect(after.conversations).toEqual(before.conversations);
  expect(after.preferences).toEqual(before.preferences);
  expect(after.legacyAgents).toEqual(before.legacyAgents);
  await browser.close();
}
await writeFile(
  'artifacts/chat-settings-smoke.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      results,
      rememberedAcrossProviders: true,
      rememberedAfterReload: true,
      historicalAttribution: true,
      originalChatsUnchanged: true,
      originalPreferencesRestored: true,
      v1BackupVerified: !!oldBytes,
      errors,
    },
    null,
    2,
  ),
);
console.log(
  'Per-chat settings, cross-provider history, persistence, and migration passed. Synthetic chat removed.',
);
