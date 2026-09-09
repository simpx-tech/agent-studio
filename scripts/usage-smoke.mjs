// Opt-in native check: read subscription limits, then send small synthetic chats.
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
const marker = `Usage QA ${crypto.randomUUID()}`;
const cases = [
  { provider: 'codex', name: 'Codex', model: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { provider: 'claude', name: 'Claude', model: 'haiku', label: 'Haiku (latest)' },
  { provider: 'gemini', name: 'Gemini', model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
];
const results = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pick = async (label, name) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
const synthetic = (workspace) =>
  workspace.conversations.filter((c) => c.messages[0]?.blocks[0]?.text.startsWith(marker));
try {
  const limits = [];
  for (const item of cases) {
    const snapshot = await invoke('read_usage', {
      provider: item.provider,
      model: item.provider === 'claude' ? 'fable' : item.model,
      force: false,
    });
    expect(snapshot.windows.some((w) => w.windowMinutes === 10080 && w.usedPercent != null)).toBe(
      true,
    );
    if (item.provider === 'claude') {
      expect(snapshot.windows.some((w) => w.model === 'fable' && w.usedPercent != null)).toBe(true);
      expect(snapshot.context.model).toContain('fable');
      expect(snapshot.context.tokens).toBeGreaterThan(0);
    }
    limits.push({
      provider: item.provider,
      windows: snapshot.windows.map((w) => ({
        label: w.label,
        minutes: w.windowMinutes,
        reported: w.usedPercent != null,
        model: w.model,
      })),
      capacity: snapshot.context?.tokens,
    });
    console.log(`${item.name}: live account windows read without a model request.`);
  }
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick('Agent', 'Claude');
  await pick('Model', 'Fable (latest)');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-fable-weekly').getByRole('meter')).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({ path: 'artifacts/usage-fable-native.png' });
  await pick('Model', 'Sonnet (latest)');
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  for (const item of cases) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await pick('Agent', item.name);
    await pick('Model', item.label);
    if (item.provider !== 'claude') await pick('Reasoning', 'Low');
    await page
      .getByLabel('Message', { exact: true })
      .fill(`${marker} ${item.provider}. Reply only: The garden is ready.`);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      'data-status',
      'complete',
      { timeout: 90000 },
    );
    await expect
      .poll(
        async () =>
          synthetic(await invoke('load_workspace'))
            .find((c) => c.settings.provider === item.provider)
            ?.messages.at(-1)?.usage?.input,
        { timeout: 10000 },
      )
      .toBeGreaterThan(0);
    const chat = synthetic(await invoke('load_workspace')).find(
      (c) => c.settings.provider === item.provider,
    );
    const usage = chat.messages.at(-1).usage;
    const reportedTitle =
      usage.contextInput != null
        ? await page.evaluate((n) => `${n.toLocaleString()} input tokens`, usage.contextInput)
        : '';
    expect(usage.output).toBeGreaterThan(0);
    const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
    if (item.provider === 'claude') {
      expect(usage.contextInput).toBeGreaterThan(0);
      expect(usage.contextWindow).toBeGreaterThan(0);
      await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
        'title',
        reportedTitle,
      );
      expect(Number(await meter.getAttribute('aria-valuenow'))).toBeCloseTo(
        (usage.contextInput / usage.contextWindow) * 100,
        8,
      );
    } else {
      expect(usage.contextInput).toBeNull();
      await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
      await expect(meter).toHaveCount(0);
    }
    await expect(page.getByTestId('context-estimate')).toHaveCount(0);
    const priorReading = await page.getByTestId('reported-context').innerText();
    await page.getByLabel('Message', { exact: true }).fill('Additional draft words. '.repeat(100));
    await expect(page.getByTestId('context-estimate')).toHaveCount(0);
    expect(await page.getByTestId('reported-context').innerText()).toBe(priorReading);
    await page.getByLabel('Message', { exact: true }).fill('');
    await expect
      .poll(
        async () =>
          synthetic(await invoke('load_workspace')).find((c) => c.id === chat.id)?.titleStatus,
        { timeout: 40000 },
      )
      .not.toBe('pending');
    const saved = synthetic(await invoke('load_workspace')).find((c) => c.id === chat.id);
    results.push({
      provider: item.provider,
      model: item.model,
      input: usage.input,
      output: usage.output,
      cachedInput: usage.cachedInput,
      contextInput: usage.contextInput,
      contextWindow: usage.contextWindow,
      hasEstimate: chat.messages.at(-1).promptTokensEstimate > 0,
    });
    await page.screenshot({ path: `artifacts/context-${item.provider}-native.png` });
    await page.reload();
    await page.getByRole('button', { name: saved.title, exact: true }).click();
    await page.locator('.context-chip').click();
    expect(usage.input).not.toBeNull();
    expect(
      synthetic(await invoke('load_workspace'))
        .find((c) => c.id === chat.id)
        .messages.at(-1).usage,
    ).toEqual(usage);
    if (item.provider === 'claude') {
      await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
        'title',
        reportedTitle,
      );
      expect(Number(await meter.getAttribute('aria-valuenow'))).toBeCloseTo(
        (usage.contextInput / usage.contextWindow) * 100,
        8,
      );
    }
    console.log(
      `${item.name}: token totals, measured-context availability, separate draft estimate, and reload persistence verified.`,
    );
  }
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/context-smoke.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), limits, results, fableConditional: true, errors },
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
  for (const chat of synthetic(await invoke('load_workspace'))) {
    if (chat.titleStatus === 'pending') await invoke('cancel_title', { conversationId: chat.id });
  }
  await expect
    .poll(
      async () =>
        synthetic(await invoke('load_workspace')).some((c) => c.titleStatus === 'pending'),
      { timeout: 15000 },
    )
    .toBe(false);
  const saved = await invoke('load_workspace');
  saved.conversations = saved.conversations.filter(
    (c) => !synthetic(saved).some((s) => s.id === c.id),
  );
  saved.preferences = before.preferences;
  await invoke('save_workspace', { workspace: saved });
  await page.reload();
  const after = await invoke('load_workspace');
  expect(after.conversations).toEqual(before.conversations);
  expect(after.preferences).toEqual(before.preferences);
  await browser.close();
}
console.log('Usage smoke passed; original chats and preferences preserved.');
