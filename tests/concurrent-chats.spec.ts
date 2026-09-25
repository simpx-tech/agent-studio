import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// Replies the mock CLI holds open, in the order they started.
const heldRuns = (page: Page) =>
  page.evaluate(() =>
    Object.entries((window as any).capabilityRuns ?? {}).map(([runId, run]: [string, any]) => ({
      runId,
      conversationId: run.conversationId as string,
    })),
  );
const chat = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });

test('replies in different conversations run side by side and stop independently', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const stop = page.getByRole('button', { name: 'Stop response' });
  await composer.fill('First task');
  await send.click();
  await expect(stop).toBeVisible();

  // A new conversation can be set up and sent while the first one still replies.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeEnabled();
  await expect(page.getByText(/responding in another conversation/)).toHaveCount(0);
  await composer.fill('Second task');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const [first, second] = await heldRuns(page);
  expect(first.conversationId).not.toBe(second.conversationId);
  await expect(stop).toBeVisible();
  await expect(chat(page, 'First task').locator('.pulse-dot')).toBeVisible();
  await expect(chat(page, 'Second task').locator('.pulse-dot')).toBeVisible();
  await page.screenshot({ path: 'artifacts/concurrent-chats-browser.png' });

  // Stopping the open conversation leaves the other reply running.
  await stop.click();
  await expect(send).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).cancelCalls.map((call: any) => call.runId)),
  ).toEqual([second.runId]);
  await expect(chat(page, 'Second task').locator('.pulse-dot')).toHaveCount(0);
  await expect(chat(page, 'First task').locator('.pulse-dot')).toBeVisible();

  await chat(page, 'First task').click();
  await expect(stop).toBeVisible();
  await page.evaluate((runId) => {
    const run = (window as any).capabilityRuns[runId];
    run.emit({ kind: 'text', text: 'First answer' });
    run.finish('complete');
  }, first.runId);
  await expect(page.getByText('First answer')).toBeVisible();
  await expect(send).toBeVisible();
  await expect(chat(page, 'First task').locator('.pulse-dot')).toHaveCount(0);
});

test('a queued message waits only for its own conversation', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Long task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await composer.fill('Follow-up for the long task');
  await page.getByRole('button', { name: 'Queue message' }).click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toBeVisible();

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await composer.fill('Quick question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const [long, quick] = await heldRuns(page);
  await page.evaluate((runId) => {
    const run = (window as any).capabilityRuns[runId];
    run.emit({ kind: 'text', text: 'Quick answer' });
    run.finish('complete');
  }, quick.runId);
  await expect(page.getByText('Quick answer')).toBeVisible();
  // The other conversation's reply is still running, so its queued message stays queued.
  expect(await page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');

  await chat(page, 'Long task').click();
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await expect(queue.getByText('Follow-up for the long task')).toBeVisible();
  await page.evaluate((runId) => {
    const run = (window as any).capabilityRuns[runId];
    run.emit({ kind: 'text', text: 'Long answer' });
    run.finish('complete');
  }, long.runId);
  await expect(page.getByText('Long answer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('3');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!)),
  ).toMatchObject({
    conversationId: long.conversationId,
    messages: expect.arrayContaining([
      expect.objectContaining({ text: 'Follow-up for the long task' }),
    ]),
  });
  await expect(queue).toHaveCount(0);
});
