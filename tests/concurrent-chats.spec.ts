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
const finish = (page: Page, runId: string, status: string, text?: string) =>
  page.evaluate(
    ({ runId, status, text }) => {
      const run = (window as any).capabilityRuns[runId];
      if (text) run.emit({ kind: 'text', text });
      run.finish(status);
    },
    { runId, status, text },
  );
const runCount = (page: Page) => page.evaluate(() => localStorage.getItem('test-run-count'));
// Start a reply that stays open, then queue a follow-up for it.
async function queueDuringReply(page: Page, first: string, follow: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(first);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await composer.fill(follow);
  await page.getByRole('button', { name: 'Queue message' }).click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toBeVisible();
}

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
  await expect(chat(page, 'First task').locator('.conversation-running')).toBeVisible();
  await expect(chat(page, 'Second task').locator('.conversation-running')).toBeVisible();
  // The open chat is marked by a bar, never a dot, beside its running spinner.
  const mark = await chat(page, 'Second task').evaluate((row) => {
    const style = getComputedStyle(row, '::before');
    return { width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  expect(mark.height).toBeGreaterThan(mark.width * 3);
  await page.screenshot({ path: 'artifacts/concurrent-chats-browser.png' });

  // Stopping the open conversation leaves the other reply running.
  await stop.click();
  await expect(send).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).cancelCalls.map((call: any) => call.runId)),
  ).toEqual([second.runId]);
  await expect(chat(page, 'Second task').locator('.conversation-running')).toHaveCount(0);
  await expect(chat(page, 'First task').locator('.conversation-running')).toBeVisible();

  await chat(page, 'First task').click();
  await expect(stop).toBeVisible();
  await finish(page, first.runId, 'complete', 'First answer');
  await expect(page.getByText('First answer')).toBeVisible();
  await expect(send).toBeVisible();
  await expect(chat(page, 'First task').locator('.conversation-running')).toHaveCount(0);
});

test('a chat that is not open sends its queued message when its own reply completes', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await queueDuringReply(page, 'Long task', 'Follow-up for the long task');

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await composer.fill('Quick question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const [long, quick] = await heldRuns(page);
  await finish(page, quick.runId, 'complete', 'Quick answer');
  await expect(page.getByText('Quick answer')).toBeVisible();
  // The other conversation's reply is still running, so its queued message keeps waiting.
  expect(await runCount(page)).toBe('2');

  // Its reply completes while this chat stays open with an unsent draft.
  await composer.fill('Unsent draft');
  await finish(page, long.runId, 'complete', 'Long answer');
  await expect.poll(() => runCount(page)).toBe('3');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!)),
  ).toMatchObject({
    conversationId: long.conversationId,
    messages: expect.arrayContaining([
      expect.objectContaining({ text: 'Follow-up for the long task' }),
    ]),
  });
  await expect(composer).toHaveValue('Unsent draft');
  await expect(page.getByText('Quick answer')).toBeVisible();
  await expect(chat(page, 'Long task').locator('.conversation-running')).toBeVisible();

  await chat(page, 'Long task').click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(page.getByText('Long answer')).toBeVisible();
  await expect(page.getByText('Follow-up for the long task', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
});

test('a stopped reply in a chat that is not open keeps its queue until the chat is opened', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await queueDuringReply(page, 'Task to stop', 'Queued after the stop');
  const [reply] = await heldRuns(page);

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await finish(page, reply.runId, 'cancelled');
  await expect(chat(page, 'Task to stop').locator('.conversation-running')).toHaveCount(0);
  expect(await runCount(page)).toBe('1');

  await chat(page, 'Task to stop').click();
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Queued after the stop',
  );
  expect(await runCount(page)).toBe('1');
});
