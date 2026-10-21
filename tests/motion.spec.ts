import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// The motion principle in docs/DESIGN-SYSTEM.md: what was just written fades in, what a chat
// already holds shows at once, compact buttons give while pressed, and reduced motion stops all
// of it, pseudo-elements included.

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const replies = (page: Page) => page.locator('.message:not(.user)');
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
const read = {
  kind: 'tool',
  tool: {
    id: 'one',
    name: 'Read',
    category: 'tool',
    revision: 1,
    status: 'complete',
    sources: [],
    agents: [],
    operation: 'read',
    path: '/fixture/one.ts',
  },
};

async function send(page: Page, text: string) {
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
}
async function finish(page: Page, count: number) {
  await emit(page, read);
  await emit(page, { kind: 'text', text: 'Done.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(replies(page).and(page.locator('[data-status="complete"]'))).toHaveCount(count);
}

test('what was just written fades in, and a chat opened again shows at once @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await send(page, 'Read a file');
  // The message and the reply it starts fade in where the chat glides to them.
  await expect(page.locator('.message.entering')).toHaveCount(2);
  await expect(page.locator('.message.entering').first()).toHaveCSS('animation-name', 'fade-in');
  // A steer the reply takes fades in with its part of the reply.
  await input(page).fill('Also read two');
  await page.getByRole('button', { name: 'Steer now' }).click();
  await expect(page.locator('.steer-message')).toHaveClass(/entering/);
  await finish(page, 1);

  // Saved a minute ago, the chat opens after a restart without replaying its messages.
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const [chat] = workspace.conversations;
    const earlier = Date.now() - 60_000;
    for (const message of chat.messages) message.createdAt = new Date(earlier).toISOString();
    for (const message of chat.messages)
      for (const place of message.steeringPlaces ?? []) place.at = new Date(earlier).toISOString();
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('#conversation-panel-history .conversation-item').first().click();
  await expect(page.getByTestId('message')).toHaveCount(2);
  await expect(page.locator('.steer-message')).toHaveCount(1);
  await expect(page.locator('.entering')).toHaveCount(0);

  // A message sent there fades in with its reply; the earlier ones stay as they were.
  await send(page, 'One more');
  await expect(page.getByTestId('message')).toHaveCount(4);
  await expect(page.locator('.message.entering')).toHaveCount(2);
  await expect(page.getByTestId('message').first()).not.toHaveClass(/entering/);
  await finish(page, 2);
});

test('compact buttons give while pressed, and rows stay still @webkit', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await send(page, 'Read a file');
  await finish(page, 1);
  const scale = (locator: ReturnType<Page['locator']>) =>
    locator.evaluate((el) => getComputedStyle(el).scale);
  // The pointer leaves before it lifts, so nothing is clicked.
  async function press(locator: ReturnType<Page['locator']>) {
    const box = (await locator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  async function lift() {
    await page.mouse.move(700, 450);
    await page.mouse.up();
  }
  const context = page.getByRole('button', { name: 'Model context' });
  await press(context);
  await expect.poll(() => scale(context)).toBe('0.93');
  await lift();
  await expect.poll(() => scale(context)).toBe('none');
  const row = page.locator('.conversation-list .conversation-item').first();
  await press(row);
  await page.waitForTimeout(200);
  expect(await scale(row)).toBe('none');
  await lift();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await press(context);
  await page.waitForTimeout(200);
  expect(await scale(context)).toBe('none');
  await lift();
});

test('nothing animates under reduced motion @webkit', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const still = async (step: string) =>
    expect(await page.evaluate(() => document.getAnimations().length), step).toBe(0);
  await expect(page.locator('.chat-empty')).toBeVisible();
  await still('welcome');
  await send(page, 'Read a file');
  await still('send');
  await finish(page, 1);
  await page.getByRole('button', { name: 'Reply usage and cost' }).click();
  await still('footer panel');
  const history = page.locator('summary[aria-label="Work history"]');
  await history.click();
  await still('work history');
  // Document animations leave out a disclosure's content box, so read its style instead.
  expect(
    await history.evaluate(
      (summary) => getComputedStyle(summary.parentElement!, '::details-content').animationName,
    ),
  ).toBe('none');
  await page.locator('.conversation-list .conversation-item').first().click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await still('context menu');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /History/ }).click();
  await still('sidebar tab');
  await page.getByRole('button', { name: 'Settings' }).click();
  await still('settings');
  // The theme changes at once, without a crossing.
  await page.getByRole('radio', { name: 'Light' }).click();
  expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
  await still('theme');
});
