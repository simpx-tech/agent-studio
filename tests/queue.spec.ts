import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const runCount = (page: import('@playwright/test').Page) =>
  page.evaluate(() => localStorage.getItem('test-run-count'));
const lastUserText = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('test-last-request') ?? '{}').messages?.at(-1)?.text as
        string | undefined,
  );

test('messages typed during a reply queue in order and send after it completes', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('First request');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(input).toHaveAttribute('placeholder', /after this reply/);
  await input.fill('Follow-up while running');
  await page.getByRole('button', { name: 'Queue message' }).click();
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('Follow-up while running')).toBeVisible();
  await expect(queue.getByText('After this reply')).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('Second follow-up');
  await input.press('Enter');
  await expect(queue.getByRole('listitem')).toHaveCount(2);
  expect(await runCount(page)).toBe('1');
  await page.screenshot({ path: 'artifacts/queued-messages-browser.png' });
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'First answer' });
    (window as any).finishCapabilities('complete');
  });
  await expect.poll(() => runCount(page)).toBe('2');
  expect(await lastUserText(page)).toBe('Follow-up while running');
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('First answer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  // Stopping returns the remaining queued message to the composer instead of sending it.
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(queue).toHaveCount(0);
  await expect(input).toHaveValue('Second follow-up');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  expect(await runCount(page)).toBe('2');
});

test('a queued message can be returned to the composer and merges with the draft', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Start');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await input.fill('Queued text');
  await input.press('Enter');
  await input.fill('Draft in progress');
  await page.getByRole('button', { name: 'Return queued message to the composer' }).click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(input).toHaveValue('Queued text\n\nDraft in progress');
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Done' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(input).toHaveValue('Queued text\n\nDraft in progress');
  expect(await runCount(page)).toBe('1');
});
