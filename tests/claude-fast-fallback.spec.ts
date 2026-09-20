import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('Fast mode and fallback settings preserve drafts, validate, and survive replies and reload', async ({
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
  const editor = page.getByRole('button', { name: 'Chat instructions', exact: true });
  const fast = page.getByRole('combobox', { name: 'Fast mode', exact: true });
  const fallback = page.getByLabel('Fallback models', { exact: true });
  const save = page.getByRole('button', { name: 'Save instructions', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const request = () => page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  const finish = async () => {
    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Ready' });
      (window as any).finishCapabilities('complete');
    });
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  };
  await input.fill('Keep this draft');
  await editor.click();
  await expect(fast).toContainText('CLI default');
  await fast.click();
  await page.getByRole('option', { name: 'On', exact: true }).click();
  await fallback.fill('sonnet,haiku');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.click();
  await expect(fast).toContainText('CLI default');
  await expect(fallback).toHaveValue('');
  await fast.click();
  await page.getByRole('option', { name: 'On', exact: true }).click();
  for (const invalid of ['sonnet,', 'sonnet,sonnet', 'a,b,c,d', '--flag']) {
    await fallback.fill(invalid);
    await expect(save).toBeDisabled();
  }
  await fallback.fill(' sonnet, haiku ');
  await page.setViewportSize({ width: 390, height: 844 });
  await fast.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/claude-fast-fallback/mobile.png' });
  await save.click();
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.locator('.message')).toHaveCount(0);
  await send.click();
  expect((await request()).agent).toMatchObject({ fastMode: true, fallbackModel: 'sonnet,haiku' });
  await input.fill('/fast off');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Wait for the reply');
  await expect(input).toHaveValue('/fast off');
  await finish();
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await input.fill('/fast off');
  await send.click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  await editor.click();
  await expect(fast).toContainText('Off');
  await expect(fallback).toHaveValue('sonnet,haiku');
  await fallback.fill('');
  await save.click();
  await input.fill('Second reply');
  await send.click();
  expect((await request()).agent.fastMode).toBe(false);
  expect((await request()).agent.fallbackModel).toBeUndefined();
  await finish();
  await input.fill('/fast default');
  await send.click();
  await input.fill('/fast invalid');
  await send.click();
  await expect(input).toHaveValue('/fast invalid');
  await expect(page.getByRole('alert')).toContainText('Use /fast');
  await input.fill('/fast');
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toBeVisible();
  await input.press('Tab');
  await expect(fast).toBeFocused();
  await expect(fast).toContainText('CLI default');
  await page.screenshot({ path: 'artifacts/claude-fast-fallback/desktop.png' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(4);
});

test('Fast mode stays Claude-only and its shortcut preserves remaining draft text', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/fast');
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await expect(page.getByLabel('Fallback models')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  await input.fill('/fast keep this draft');
  await input.press('Home');
  await input.press('ArrowRight');
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toBeVisible();
  await page.getByRole('option', { name: '/fast', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Fast mode', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(input).toHaveValue('keep this draft');
  await expect(page.locator('.message')).toHaveCount(0);
});
