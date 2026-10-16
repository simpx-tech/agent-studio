import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const request = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));

async function chooseAgent(page: Page, name: RegExp) {
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).first().click();
}

async function chooseModel(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('Fast mode beside the composer and fallback settings preserve drafts, validate, and survive replies and reload', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await chooseAgent(page, /Claude/);
  const input = page.getByLabel('Message', { exact: true });
  const fast = page.getByRole('button', { name: 'Fast mode', exact: true });
  const editor = page.getByRole('button', { name: 'Chat instructions', exact: true });
  const fallback = page.getByLabel('Fallback models', { exact: true });
  const save = page.getByRole('button', { name: 'Save instructions', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const hint = page.locator('.next-reply-settings');
  const finish = async () => {
    await page.evaluate(() => {
      (window as any).emitCapability({ kind: 'text', text: 'Ready' });
      (window as any).finishCapabilities('complete');
    });
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  };
  await input.fill('Keep this draft');
  // Only the models whose catalog entry offers Fast mode show it; the chat keeps its choice.
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await expect(fast).toHaveAttribute('title', 'Fast mode · Faster replies at a higher cost');
  await fast.click();
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('Keep this draft');
  await chooseModel(page, 'Sonnet');
  await expect(fast).toHaveCount(0);
  await chooseModel(page, 'Opus');
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await editor.click();
  await expect(page.getByRole('combobox', { name: 'Fast mode' })).toHaveCount(0);
  await fallback.fill('sonnet,haiku');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editor.click();
  await expect(fallback).toHaveValue('');
  for (const invalid of ['sonnet,', 'sonnet,sonnet', '--flag']) {
    await fallback.fill(invalid);
    await expect(save).toBeDisabled();
  }
  // However many models the chain names.
  await fallback.fill('opus,sonnet,haiku,claude-sonnet-4-5');
  await expect(save).toBeEnabled();
  await fallback.fill(' sonnet, haiku ');
  await save.click();
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.locator('.message')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/claude-fast-fallback/desktop.png' });
  await send.click();
  expect((await request(page)).agent).toMatchObject({
    fastMode: true,
    fallbackModel: 'sonnet,haiku',
  });
  // While the reply runs, Fast mode changes for the next message, by the toggle or `/fast`.
  await fast.click();
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await expect(hint).toHaveText('Next message: Opus · Medium reasoning · Standard speed');
  await input.fill('/fast on');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await expect(hint).toHaveCount(0);
  await expect(page.locator('.queued-message')).toHaveCount(0);
  await input.fill('/fast');
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toBeVisible();
  await input.press('Tab');
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await expect(input).toHaveValue('');
  await finish();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fast).toBeVisible();
  await page.screenshot({ path: 'artifacts/claude-fast-fallback/mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  // The shortcut edits only the next reply's preference: nothing is sent or restored.
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await input.fill('/fast on');
  await send.click();
  await expect(input).toHaveValue('');
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
  await fast.click();
  await editor.click();
  await expect(fallback).toHaveValue('sonnet,haiku');
  await fallback.fill('');
  await save.click();
  await input.fill('Second reply');
  await send.click();
  expect((await request(page)).agent.fastMode).toBe(false);
  expect((await request(page)).agent.fallbackModel).toBeUndefined();
  await finish();
  await expect(page.locator('.reply-switch')).toHaveText(['Switched to Standard speed']);
  await fast.click();
  await input.fill('Third reply');
  await send.click();
  expect((await request(page)).agent.fastMode).toBe(true);
  await finish();
  await expect(page.locator('.reply-switch').last()).toHaveText('Switched to Fast mode');
  await input.fill('/fast default');
  await send.click();
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  await input.fill('/fast invalid');
  await send.click();
  await expect(input).toHaveValue('/fast invalid');
  await expect(page.getByRole('alert')).toContainText('Use /fast');
  await expect(page.locator('.message')).toHaveCount(6);
  await input.fill('Fourth reply');
  await send.click();
  expect((await request(page)).agent.fastMode).toBeUndefined();
  await finish();
});

test('Codex Fast mode follows the model, and its shortcut keeps the rest of the draft', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  const fast = page.getByRole('button', { name: 'Fast mode', exact: true });
  await chooseAgent(page, /Gemini/);
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  await expect(fast).toHaveCount(0);
  await input.fill('/fast');
  await expect(page.getByRole('option', { name: '/compact', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toHaveCount(0);
  await input.fill('');
  await chooseAgent(page, /Codex/);
  await expect(fast).toHaveAttribute('title', 'Fast mode · 2x speed, increased usage');
  await chooseModel(page, 'GPT-5.6 Sol');
  await expect(fast).toHaveCount(0);
  await input.fill('/fast on');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'This model has no Fast mode.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await chooseModel(page, 'GPT-6 Astra');
  await expect(fast).toHaveAttribute('aria-pressed', 'false');
  // Fallback models and the thinking budget stay Claude's.
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await expect(page.getByLabel('Fallback models')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.fill('/fast keep this draft');
  await input.press('Home');
  await input.press('ArrowRight');
  await expect(page.getByRole('option', { name: '/fast', exact: true })).toBeVisible();
  await page.getByRole('option', { name: '/fast', exact: true }).click();
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('keep this draft');
  await expect(page.locator('.message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  expect((await request(page)).agent).toMatchObject({ provider: 'codex', fastMode: true });
});

test('Fast mode says when Claude reports the account cannot use it', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => localStorage.setItem('test-fast-blocked', 'extra_usage_disabled'));
  await page.goto('/');
  await chooseTestFolder(page);
  await chooseAgent(page, /Claude/);
  const fast = page.getByRole('button', { name: 'Fast mode', exact: true });
  await expect(fast).toHaveAttribute('title', 'Fast mode requires usage credits');
  await fast.click();
  // The choice stays the user's; the CLI decides at the reply.
  await expect(fast).toHaveAttribute('aria-pressed', 'true');
  await expect(fast).toHaveClass(/blocked/);
  await page.screenshot({ path: 'artifacts/claude-fast-fallback/blocked.png' });
});
