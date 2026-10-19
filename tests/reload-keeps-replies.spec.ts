import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// A reload of the window used to stop every running reply and move every chat to History, as an
// app start does (2026-10-19). The app now runs replies on through a reload, and the reloaded
// window follows each one again (src-tauri/src/reply_feed.rs).

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace') ?? 'null'));

/** Reloads the window as the app reloads it: the same app session, with these replies live. */
async function reloadWindow(page: Page, live: unknown[]) {
  await page.evaluate((live) => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const session = workspace.appSessions.at(-1);
    localStorage.setItem(
      'test-app-session',
      JSON.stringify({ id: session.id, startedAt: Date.parse(session.startedAt), reloaded: true }),
    );
    localStorage.setItem('test-live-runs', JSON.stringify(live));
  }, live);
  await page.reload();
}

test('a reload of the window keeps its replies running and its chats where they were', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Update the tracking screen');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() =>
    (window as any).emitCapability({ kind: 'text', text: 'Saving the updated screen now' }),
  );
  await expect(page.locator('.message:not(.user)')).toContainText('Saving the updated screen now');
  await expect
    .poll(async () => (await saved(page))?.conversations[0]?.messages.at(-1)?.runId)
    .toBeTruthy();
  const chat = (await saved(page)).conversations[0];
  const runId = chat.messages.at(-1).runId;

  // The app ran the reply on: the reloaded window hears it again from its start.
  await reloadWindow(page, [
    {
      runId,
      conversationId: chat.id,
      events: [
        { kind: 'activity', text: 'Connected' },
        { kind: 'text', text: 'Saving the updated screen now' },
        {
          kind: 'progress',
          id: 'checks',
          revision: 0,
          text: 'The week now starts on Monday.',
        },
      ],
    },
  ]);
  await expect(page.getByRole('tab', { name: /^Active/ })).toContainText('1');
  await page.locator('.conversation-item').first().click();
  const reply = page.locator('.message:not(.user)').last();
  await expect(reply).toContainText('Saving the updated screen now');
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(reply).not.toContainText('interrupted');
  expect(await page.evaluate(() => (window as any).followed)).toEqual([runId]);

  // What it does next arrives as it happens, and its end ends it as any reply ends.
  await page.evaluate(
    ({ runId }) => {
      (window as any).emitFollowed(runId, {
        kind: 'text',
        text: 'The screen now shows the current week, starting on Monday.',
      });
      (window as any).endFollowed(runId, 'complete');
    },
    { runId },
  );
  await expect(reply).toContainText('The screen now shows the current week, starting on Monday.');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect
    .poll(async () => (await saved(page)).conversations[0].messages.at(-1))
    .toMatchObject({ status: 'complete', runId });
  const last = (await saved(page)).conversations[0];
  expect(last.archived).toBeFalsy();
  expect(last.messages.at(-1).error).toBeUndefined();
});

test('a reload interrupts only the replies whose run ended with the old window', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Write the report');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await expect
    .poll(async () => (await saved(page))?.conversations[0]?.messages.at(-1)?.runId)
    .toBeTruthy();
  const chat = (await saved(page)).conversations[0];

  // Nothing runs it any more, and a run no chat holds as running is stopped and let go.
  const stray = crypto.randomUUID();
  await reloadWindow(page, [{ runId: stray, end: 'cancelled' }]);
  await expect(page.getByRole('tab', { name: /^Active/ })).toContainText('1');
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.message:not(.user)').last()).toContainText(
    'This response was interrupted when the app closed.',
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).cancelCalls?.map((c: any) => c.runId)))
    .toEqual([stray]);
  await expect.poll(() => page.evaluate(() => (window as any).followed)).toEqual([stray]);
  expect((await saved(page)).conversations[0].id).toBe(chat.id);
});

test('an app start still begins with an empty Active list', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Plan the release');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await expect
    .poll(async () => (await saved(page))?.conversations[0]?.messages.at(-1)?.runId)
    .toBeTruthy();
  // Each page load of the mock is a new start of the app unless a test pins its session.
  await page.reload();
  await expect(page.getByRole('tab', { name: /^Active/ })).toContainText('0');
  await expect.poll(async () => (await saved(page)).conversations[0].archived).toBe(true);
});
