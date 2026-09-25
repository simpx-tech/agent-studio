import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const history = (page: Page) => page.locator('#conversation-panel-history');
const historyTab = (page: Page) => page.getByRole('tab', { name: /^History/ });
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));

// Starts the app again as a new process that began at `startedAt`.
async function startApp(page: Page, startedAt: number) {
  await page.evaluate(
    (session) => localStorage.setItem('test-app-session', JSON.stringify(session)),
    { id: crypto.randomUUID(), startedAt },
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
}
async function send(page: Page, text: string) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
}
// Each History heading with its folders' chats, in the listed order.
const sections = (page: Page) =>
  history(page)
    .locator('.conversation-session')
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.querySelector('.session-group-toggle')!.textContent!.trim(),
        [...node.querySelectorAll('.conversation-item')].map((item) => item.textContent!.trim()),
      ]),
    );
// The heading the app gives a start of the app, or a day before sessions were recorded.
const heading = (page: Page, time: number, day = false) =>
  page.evaluate(
    ([time, day]) => {
      const date = new Date(time);
      const today = new Date();
      const name =
        date.toDateString() === today.toDateString()
          ? 'Today'
          : date.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()
            ? 'Yesterday'
            : date.toLocaleDateString([], { weekday: 'long' });
      return day
        ? name
        : `${name}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    },
    [time, day] as const,
  );

test('History groups chats by the app session they were last used in', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const morning = Date.now() - 2 * 3_600_000;
  await startApp(page, morning);
  await send(page, 'Morning plan');
  await send(page, 'Morning review');
  // A chat last used days ago, before this app recorded its starts.
  const old = Date.now() - 3 * 86_400_000;
  await page.evaluate((old) => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const source = workspace.conversations[0];
    workspace.conversations.push({
      ...source,
      id: crypto.randomUUID(),
      title: 'Older chat',
      archived: true,
      createdAt: new Date(old).toISOString(),
      updatedAt: new Date(old).toISOString(),
      messages: source.messages.map((message: object) => ({
        ...message,
        id: crypto.randomUUID(),
        createdAt: new Date(old).toISOString(),
      })),
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  }, old);
  // Starting the app again moves the morning's chats to History under their session.
  const afternoon = Date.now();
  await startApp(page, afternoon);
  await send(page, 'Afternoon chat');
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await historyTab(page).click();
  expect(await sections(page)).toEqual([
    [await heading(page, afternoon), ['Afternoon chat']],
    [await heading(page, morning), ['Morning review', 'Morning plan']],
    [await heading(page, old, true), ['Older chat']],
  ]);
  await expect(history(page).locator('.session-group-toggle').first()).toHaveAttribute(
    'title',
    /^App session started .+ on Desktop$/,
  );
  await expect(history(page).locator('.session-group-toggle').last()).toHaveAttribute(
    'title',
    /before app sessions were recorded$/,
  );
  // Folders stay under each session, with their New conversation action.
  await expect(
    history(page).locator('.conversation-session').nth(1).locator('.folder-group-toggle'),
  ).toHaveText('studio');
  await expect(
    history(page).getByRole('button', { name: 'New conversation in studio on Desktop' }),
  ).toHaveCount(3);
  await expect(history(page).locator('.computer-group-toggle')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/history-sessions.png', animations: 'disabled' });
  // The first start, which had no chats, was dropped; a reload keeps the same session.
  const sessions = (await saved(page)).appSessions;
  expect(sessions.map((s: { startedAt: string }) => Date.parse(s.startedAt))).toEqual([
    morning,
    afternoon,
  ]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  expect((await saved(page)).appSessions).toEqual(sessions);
  // A chat continued in this session moves to it.
  await historyTab(page).click();
  await history(page).getByRole('button', { name: 'Morning review', exact: true }).click();
  await input(page).fill('One more thing');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await historyTab(page).click();
  expect(await sections(page)).toEqual([
    [await heading(page, afternoon), ['Morning review', 'Afternoon chat']],
    [await heading(page, morning), ['Morning plan']],
    [await heading(page, old, true), ['Older chat']],
  ]);
  // Sessions collapse, and search keeps the sessions of its matches.
  const current = history(page).locator('.session-group-toggle').first();
  await current.click();
  await expect(current).toHaveAttribute('aria-expanded', 'false');
  await expect(
    history(page).getByRole('button', { name: 'Afternoon chat', exact: true }),
  ).toHaveCount(0);
  await current.click();
  await page.getByLabel('Search conversations').fill('morning');
  expect(await sections(page)).toEqual([
    [await heading(page, afternoon), ['Morning review']],
    [await heading(page, morning), ['Morning plan']],
  ]);
});

test('History sessions fit a phone drawer', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await startApp(page, Date.now() - 3_600_000);
  await send(page, 'A chat with a long title that should truncate within the phone drawer');
  await startApp(page, Date.now());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await historyTab(page).click();
  const toggle = history(page).locator('.session-group-toggle');
  await expect(toggle).toHaveCount(1);
  const [drawer, box] = await Promise.all([
    page.getByRole('dialog', { name: 'Conversations' }).boundingBox(),
    toggle.boundingBox(),
  ]);
  expect(box!.x + box!.width).toBeLessThanOrEqual(drawer!.x + drawer!.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/history-sessions-phone.png', animations: 'disabled' });
});
