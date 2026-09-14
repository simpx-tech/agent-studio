import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('credits appear in chat and Connections and retain readings on refresh failure', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const state = window as any;
    const invoke = state.__TAURI_INTERNALS__.invoke;
    state.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command === 'read_usage')
        result.credits =
          args.provider === 'claude'
            ? {
                kind: 'claude',
                enabled: true,
                used: 12.5,
                limit: 100,
                currency: 'USD',
                usedPercent: 12.5,
              }
            : args.provider === 'codex'
              ? {
                  kind: 'codex',
                  balance: 4322.4487,
                  hasCredits: true,
                  unlimited: false,
                  resetCredits: 2,
                }
              : null;
      return result;
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await expect(page.locator('.usage-strip')).not.toContainText('Credits');
  await page.locator('.context-chip').click();
  const card = page.locator('#usage-details').getByRole('region', { name: 'Credits', exact: true });
  await expect(card).toContainText(/USD\s12.50 spent/);
  await expect(card).toContainText(/USD\s87.50/);
  await expect(card).toContainText('not a credit balance');
  await page.keyboard.press('Escape');
  await expect(page.locator('#usage-details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const claude = page.getByRole('region', { name: 'Usage for Claude CLI login', exact: true });
  const codex = page.getByRole('region', { name: 'Usage for Codex CLI login', exact: true });
  await expect(claude.getByRole('region', { name: 'Credits', exact: true })).toContainText(
    /USD\s12.50 spent/,
  );
  await expect(codex.getByRole('region', { name: 'Credits', exact: true })).toContainText(
    '4,322.44 credits',
  );
  await expect(codex).toContainText('Usage resets available');
  await page.evaluate(() => localStorage.setItem('test-usage-error', 'yes'));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(codex).toContainText('Usage refresh failed');
  await expect(codex.getByRole('region', { name: 'Credits', exact: true })).toContainText(
    'Last reported',
  );
  await expect(codex).toContainText('4,322.44 credits');
  await page.setViewportSize({ width: 390, height: 844 });
  await claude.getByRole('region', { name: 'Credits', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/credits-connections-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: /Show Weekly usage details/ }).click();
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: 'artifacts/credits-chat-mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.screenshot({ path: 'artifacts/credits-chat-desktop.png' });
});
