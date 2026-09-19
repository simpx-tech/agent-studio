import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

async function finish(page: Page, compact = false) {
  await page.evaluate((compact) => {
    const w = window as any;
    if (compact)
      w.emitCapability({
        kind: 'compaction',
        compaction: {
          id: 'c1',
          revision: 2,
          status: 'complete',
          trigger: 'manual',
          preTokens: 90000,
          postTokens: 6000,
        },
      });
    w.emitCapability({ kind: 'text', text: compact ? 'Context compacted.' : 'Ready' });
    w.finishCapabilities('complete');
  }, compact);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
}
test('manual compaction preserves the draft, shows progress, and survives reload on desktop and mobile', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Remember this');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await finish(page);
  await input.fill('Keep my draft');
  await page.getByRole('button', { name: /Show context usage details/ }).click();
  await page.getByRole('button', { name: 'Compact context', exact: true }).click();
  await expect(input).toHaveValue('Keep my draft');
  await expect(page.locator('.message').last()).toContainText('Compacting context');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.compact).toBe(true);
  expect(request.messages.at(-1).text).toBe('/compact');
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'compaction',
      compaction: { id: 'c1', revision: 1, status: 'running', trigger: 'manual' },
    }),
  );
  await expect(page.getByLabel('Context compaction')).toContainText('Compacting context');
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeDisabled();
  await finish(page, true);
  await expect(page.getByLabel('Context compaction')).toContainText(
    '90,000 tokens before → 6,000 after',
  );
  await page.screenshot({ path: 'artifacts/compaction/browser-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/compaction/browser-mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.getByLabel('Context compaction')).toContainText('Context compacted');
  await page.screenshot({ path: 'artifacts/compaction/browser-history.png' });
});

test('Claude sizing and slash compaction preserve arguments, while unsupported and busy requests keep drafts', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/compact');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('/compact');
  await expect(page.getByRole('alert')).toContainText('idle Claude or Codex');
  await input.fill('Start');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await finish(page);
  await page.getByRole('button', { name: /Show context usage details/ }).click();
  await page.getByRole('combobox', { name: 'Claude auto-compaction window' }).click();
  await page.getByRole('option', { name: 'Custom size…', exact: true }).click();
  await page.getByLabel('Auto-compaction tokens').fill('99999');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await page.getByLabel('Auto-compaction tokens').fill('150000');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Close usage details' }).click();
  await input.fill('/compact Preserve the lighthouse code');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.compact).toBe(true);
  expect(request.agent.autoCompactTokens).toBe(150000);
  expect(request.messages.at(-1).text).toBe('/compact Preserve the lighthouse code');
  await input.fill('/compact');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(input).toHaveValue('/compact');
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'compaction',
      compaction: { id: 'c1', revision: 1, status: 'running', trigger: 'manual' },
    }),
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByLabel('Context compaction')).toContainText('Compaction was not confirmed');
});
