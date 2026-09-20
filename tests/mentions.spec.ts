import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.beforeEach(async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
});

test('file and app selection is draft-only and native identities survive settings, send and history', async ({
  page,
}) => {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Review @src');
  await expect(page.getByRole('option', { name: 'src/my file.ts', exact: true })).toBeVisible();
  await input.press('Tab');
  await expect(input).toHaveValue('Review @"src/my file.ts" ');
  await expect(page.locator('.message')).toHaveCount(0);
  await input.pressSequentially('with $demo');
  await expect(page.getByRole('option', { name: '$demo-app', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('Review @"src/my file.ts" with $demo-app ');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(input).toHaveValue('Review @"src/my file.ts" with $demo-app ');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  const mentions = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages.at(-1).mentions,
  );
  expect(mentions.map((m: any) => m.path)).toEqual([
    'C:\\Projects\\studio/src/my file.ts',
    'app://demo',
  ]);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Done' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.locator('.message:not(.user)')).toContainText('Done');
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.message.user')).toContainText('$demo-app');
});

test('editing a selected token drops its identity and selecting in the middle preserves surrounding text', async ({
  page,
}) => {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Review @src and keep this');
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(11, 11);
    el.dispatchEvent(new Event('select'));
  });
  await expect(page.getByRole('option', { name: 'src/other.ts', exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'src/other.ts', exact: true }).click();
  await expect(input).toHaveValue('Review @src/other.ts and keep this');
  await input.fill('Review @src/changed.ts and keep this');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages.at(-1).mentions,
    ),
  ).toBeUndefined();
});

test('Claude inserts literal quoted paths, never native Codex mention metadata', async ({
  page,
}) => {
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Read @src');
  await expect(page.getByRole('option', { name: 'src/my file.ts', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('Read @"src/my file.ts" ');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  const message = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages.at(-1),
  );
  expect(message.text).toBe('Read @"src/my file.ts"');
  expect(message.mentions).toBeUndefined();
});

test('late discovery is discarded after switching agent and errors preserve the draft', async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).holdMentions = true;
  });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('$demo');
  await expect
    .poll(() => page.evaluate(() => (window as any).pendingMentions?.length ?? 0))
    .toBe(1);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  await page.evaluate(() => {
    (window as any).holdMentions = false;
    (window as any).pendingMentions[0].resolve();
  });
  await expect(page.getByRole('option', { name: '$demo-app', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).failMentions = true;
  });
  await input.fill('Read @src');
  await expect(page.getByRole('listbox', { name: /Files/ })).toContainText('unavailable');
  await input.press('Enter');
  await expect(input).toHaveValue('Read @src');
  await expect(page.locator('.message')).toHaveCount(0);
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: /Files/ })).toHaveCount(0);
});

test('typing an app name filters one pending catalog query', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).holdMentions = true;
  });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('$');
  await expect
    .poll(() => page.evaluate(() => (window as any).mentionCalls?.length ?? 0))
    .toBe(1);
  await input.pressSequentially('demo', { delay: 300 });
  expect(await page.evaluate(() => (window as any).mentionCalls.length)).toBe(1);
  await page.evaluate(() => {
    (window as any).holdMentions = false;
    (window as any).pendingMentions[0].resolve();
  });
  await expect(page.getByRole('option', { name: '$demo-app', exact: true })).toBeVisible();
  await input.press('Tab');
  await expect(input).toHaveValue('$demo-app ');
});

test('mentions survive queue restoration and the mobile picker fits the viewport', async ({
  page,
}) => {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Start');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('Then @src');
  const list = page.getByRole('listbox', { name: /Files/ });
  await expect(page.getByRole('option', { name: 'src/my file.ts', exact: true })).toBeVisible();
  const bounds = (await list.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/mentions-mobile.png' });
  await page.getByRole('option', { name: 'src/my file.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.evaluate(() => (window as any).finishCapabilities('cancelled'));
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(input).toHaveValue('Then @"src/my file.ts"');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages.at(-1).mentions
          ?.length,
    ),
  ).toBe(1);
});

test('selected app identity cannot cross an agent change and keyboard caret movement opens the picker', async ({
  page,
}) => {
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Use $demo next');
  await input.press('Home');
  for (let i = 0; i < 9; i++) await input.press('ArrowRight');
  await expect(page.getByRole('option', { name: '$demo-app', exact: true })).toBeVisible();
  await input.press('Tab');
  await expect(input).toHaveValue('Use $demo-app next');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /Claude/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('mention selection changed');
  await expect(input).toHaveValue('Use $demo-app next');
  await expect(page.locator('.message')).toHaveCount(0);
});
