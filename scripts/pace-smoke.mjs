// Opt-in native QA: live Claude quotas and three small Haiku replies, then restore the workspace.
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9428');
await expect
  .poll(
    () =>
      browser
        .contexts()[0]
        ?.pages()
        .some((p) => p.url().startsWith('http://tauri.localhost/')),
    { timeout: 15000 },
  )
  .toBe(true);
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
const marker = `Pace QA ${crypto.randomUUID()}`;
const synthetic = (workspace) =>
  workspace.conversations.filter((c) => c.messages[0]?.blocks[0]?.text.startsWith(marker));
const pick = async (label, name) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick('Agent', 'Claude');
  await pick('Model', 'Fable (latest)');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-fable-weekly').getByRole('meter')).toBeVisible({
    timeout: 30000,
  });
  const snapshot = await invoke('read_usage', { provider: 'claude', model: 'fable', force: false });
  const labels = [];
  for (const window of snapshot.windows) {
    const reset =
      typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : Date.parse(window.resetsAt);
    const expected =
      ((snapshot.checkedAt * 1000 - (reset - window.windowMinutes * 60000)) /
        (window.windowMinutes * 60000)) *
      100;
    const label =
      window.usedPercent >= 100
        ? 'Limit reached'
        : window.usedPercent - expected > 5
          ? 'Ahead of pace'
          : window.usedPercent - expected < -5
            ? 'Below pace'
            : 'On track';
    const card = page.getByTestId(`limit-${window.label.toLowerCase().replaceAll(' ', '-')}`);
    await expect(
      card.getByTestId('quota-pace').getByRole('img', { name: label, exact: true }),
    ).toBeVisible();
    labels.push({ window: window.label, label });
  }
  await page.screenshot({ path: 'artifacts/pace-quotas-native.png' });
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick('Model', 'Haiku (latest)');
  const readings = [];
  for (let turn = 0; turn < 3; turn++) {
    await page
      .getByLabel('Message', { exact: true })
      .fill(`${marker} turn ${turn + 1}. Reply only: Ready.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 90000,
    });
    await expect
      .poll(
        async () =>
          synthetic(await invoke('load_workspace'))[0]?.messages.at(-1)?.usage?.contextInput,
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    const chat = synthetic(await invoke('load_workspace'))[0];
    const usage = chat.messages.at(-1).usage;
    readings.push(usage.contextInput);
    const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
    expect(Number(await meter.getAttribute('aria-valuenow'))).toBeCloseTo(
      (usage.contextInput / usage.contextWindow) * 100,
      8,
    );
    await expect(page.getByTestId('context-pace').getByRole('img')).toBeVisible();
  }
  const growth =
    readings[2] >= readings[1] && readings[1] >= readings[0]
      ? (readings[2] - readings[0]) / 2
      : null;
  const readingBefore = await page.getByTestId('reported-context').innerText();
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page
    .getByLabel('Message', { exact: true })
    .fill('A larger draft for the next request. '.repeat(100));
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  expect(await page.getByTestId('reported-context').innerText()).toBe(readingBefore);
  await page.getByLabel('Message', { exact: true }).fill('');
  await expect
    .poll(async () => synthetic(await invoke('load_workspace'))[0]?.titleStatus, { timeout: 40000 })
    .not.toBe('pending');
  const saved = synthetic(await invoke('load_workspace'))[0];
  await page.screenshot({ path: 'artifacts/pace-context-native.png' });
  await page.reload();
  await page.getByRole('button', { name: saved.title, exact: true }).click();
  await page.locator('.context-chip').click();
  expect(await page.getByTestId('reported-context').innerText()).toBe(readingBefore);
  expect(synthetic(await invoke('load_workspace'))[0].messages).toEqual(saved.messages);
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/pace-smoke.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        quotaLabels: labels,
        readings,
        growthPerExchange: growth,
        draftIndependent: true,
        persisted: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  if (await stop.count()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 15000 });
  }
  for (const chat of synthetic(await invoke('load_workspace')))
    if (chat.titleStatus === 'pending') await invoke('cancel_title', { conversationId: chat.id });
  await expect
    .poll(
      async () =>
        synthetic(await invoke('load_workspace')).some((c) => c.titleStatus === 'pending'),
      { timeout: 15000 },
    )
    .toBe(false);
  const saved = await invoke('load_workspace');
  const ids = new Set(synthetic(saved).map((c) => c.id));
  saved.conversations = saved.conversations.filter((c) => !ids.has(c.id));
  saved.preferences = before.preferences;
  await invoke('save_workspace', { workspace: saved });
  await page.reload();
  expect(await invoke('load_workspace')).toEqual(before);
  await browser.close();
}
console.log('Native pace checks passed; original workspace preserved.');
