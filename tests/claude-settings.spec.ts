import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('Claude thinking budget validates, preserves the draft, and applies to saved next-reply settings', async ({
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
  const budget = page.getByLabel('Thinking token budget', { exact: true });
  const save = page.getByRole('button', { name: 'Save instructions', exact: true });
  await input.fill('Keep my draft');
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await budget.fill('100');
  await expect(save).toBeDisabled();
  await budget.fill('4096');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await expect(budget).toHaveValue('');
  await budget.fill('4096');
  await page.setViewportSize({ width: 390, height: 844 });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await page.screenshot({ path: 'artifacts/claude-settings/editor-mobile.png' });
  await save.click();
  await expect(input).toHaveValue('Keep my draft');
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-last-request')!).agent.maxThinkingTokens,
    ),
  ).toBe(4096);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Ready' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  for (const value of ['0', '']) {
    await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
    await expect(budget).toHaveValue(value === '0' ? '4096' : '0');
    await budget.fill(value);
    await save.click();
    await input.fill('Next');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('test-last-request')!).agent.maxThinkingTokens,
      ),
    ).toBe(value === '0' ? 0 : undefined);
    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Ready' });
      (window as any).finishCapabilities('complete');
    });
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  }
});
