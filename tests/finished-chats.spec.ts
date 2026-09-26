import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const row = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });
const dot = (page: Page, title: string) => row(page, title).locator('.conversation-finished');
const heldRuns = (page: Page) =>
  page.evaluate(() =>
    Object.entries((window as any).capabilityRuns ?? {}).map(([runId, run]: [string, any]) => ({
      runId,
      conversationId: run.conversationId as string,
    })),
  );
const finish = (page: Page, runId: string, status = 'complete') =>
  page.evaluate(
    ({ runId, status }) => (window as any).capabilityRuns[runId].finish(status),
    { runId, status },
  );

test('a chat that finishes out of sight keeps a green dot until it is opened', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('First task');
  await send.click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [first] = await heldRuns(page);

  // A second conversation takes the reader's attention while the first one replies.
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await composer.fill('Second task');
  await send.click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(2);
  const second = (await heldRuns(page)).find((run) => run.runId !== first.runId)!;

  await finish(page, first.runId);
  await expect(dot(page, 'First task')).toBeVisible();
  // A small green circle in the row's gutter, drawn in the theme's own success color.
  const mark = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--success)';
    document.body.append(probe);
    const success = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(document.querySelector('.conversation-finished')!);
    return {
      width: parseFloat(style.width),
      height: parseFloat(style.height),
      background: style.backgroundColor,
      success,
    };
  });
  expect(mark.width).toBe(mark.height);
  expect(mark.width).toBeLessThan(10);
  expect(mark.background).toBe(mark.success);

  // The chat being read is never marked, however its own reply ends.
  await finish(page, second.runId, 'cancelled');
  await expect(dot(page, 'Second task')).toHaveCount(0);
  await expect(dot(page, 'First task')).toBeVisible();
  await expect(page.getByRole('button', { name: 'First task, new reply' })).toBeVisible();

  // Opening the chat reads it; other chats keep their own marks.
  await row(page, 'First task').click();
  await expect(dot(page, 'First task')).toHaveCount(0);
  await expect(page.locator('.conversation-finished')).toHaveCount(0);
});

test('a reply finishing behind Settings marks its chat, and returning to it clears the mark', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Release checklist');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page).then((runs) => runs.length)).toBe(1);
  const [reply] = await heldRuns(page);

  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  await finish(page, reply.runId);
  await expect(dot(page, 'Release checklist')).toBeVisible();

  await settings.click();
  await expect(dot(page, 'Release checklist')).toHaveCount(0);

  // Marks belong to this session: a restored workspace is read history, however it ended.
  await page.reload();
  await expect(page.getByRole('tab', { name: /^History/ })).toBeVisible();
  await expect(page.locator('.conversation-finished')).toHaveCount(0);
});
