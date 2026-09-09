// Read-only model/usage UI check of the final packaged build; restores picker preferences.
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
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pick = async (label, name) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
};
try {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick('Agent', 'Claude');
  await pick('Model', 'Fable (latest)');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-fable-weekly').getByRole('meter')).toBeVisible({
    timeout: 30000,
  });
  const contextMeter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(contextMeter).toHaveCount(0);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page
    .getByLabel('Message', { exact: true })
    .fill('A draft about growing basil. '.repeat(100));
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(contextMeter).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('');
  await expect(page.locator('.usage-extra, .usage-totals')).toHaveCount(0);
  const arrows = page.locator('.usage-cards .pace-indicator');
  await expect(arrows).toHaveCount(3);
  for (const arrow of await arrows.all()) {
    await expect(arrow).toHaveAttribute(
      'aria-label',
      /Below pace|On track|Ahead of pace|Limit reached|Pace unavailable/,
    );
    await expect(arrow).toHaveText('');
    await expect(arrow.locator('svg')).toBeVisible();
  }
  await page.screenshot({ path: 'artifacts/usage-final-native.png' });
  await pick('Model', 'Sonnet (latest)');
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  await expect
    .poll(async () => (await invoke('load_workspace')).preferences.modelByProvider.claude)
    .toBe('sonnet');
  expect(errors).toEqual([]);
  await writeFile(
    'artifacts/usage-final-check.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        liveFableReading: true,
        draftDoesNotFabricateContext: true,
        fableConditional: true,
        estimatesAndDetailsRemoved: true,
        accessibleArrowIndicators: true,
        noModelRequests: true,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  // Confirm picker persistence before restoring only those preferences.
  await expect
    .poll(async () => (await invoke('load_workspace')).preferences.lastProvider)
    .toBe('claude');
  const saved = await invoke('load_workspace');
  expect(saved.conversations).toEqual(before.conversations);
  saved.preferences = before.preferences;
  await invoke('save_workspace', { workspace: saved });
  await page.reload();
  expect(await invoke('load_workspace')).toEqual(before);
  await browser.close();
}
console.log('Final package usage check passed; workspace unchanged and no model prompts sent.');
