import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const input = (page: Page) => page.getByLabel('Message', { exact: true });
const row = (page: Page, title: string) => page.locator('.conversation-item', { hasText: title });
// Opens a chat from its sidebar row with the keyboard, which leaves focus on the row in every
// engine: WebKit does not focus a button it clicks.
async function choose(page: Page, title: string) {
  await row(page, title).focus();
  await page.keyboard.press('Enter');
}
const fence = (title: string, paragraphs = 0) =>
  [
    ...Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} of the counter notes.`),
    `\`\`\`html ${title}\n<!doctype html><title>${title}</title><button onclick="this.textContent=Number(this.textContent)+1">0</button>\n\`\`\``,
  ].join('\n\n');
const subagents = {
  kind: 'tool',
  tool: {
    id: 'claude:agents',
    name: 'Sub-agents',
    category: 'agent',
    revision: 1,
    status: 'complete',
    sources: [],
    agents: [
      {
        id: 'reader',
        name: 'Explore the auth flow',
        status: 'complete',
        task: 'Find where sessions are created.',
        result: 'Sessions live in **session.ts**.',
      },
    ],
  },
};

// Sends a message in the open chat, whose reply reports these events and completes.
async function reply(page: Page, text: string, events: unknown[]) {
  const runs = await page.evaluate(() => Object.keys((window as any).capabilityRuns ?? {}).length);
  await input(page).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(
    (runs) => Object.keys((window as any).capabilityRuns ?? {}).length > runs,
    runs,
  );
  await page.evaluate((events) => {
    for (const event of events) (window as any).emitCapability(event);
    (window as any).finishCapabilities('complete');
  }, events);
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
}
// Opens a chat as clicking its desktop notification does, wherever focus is.
async function notificationClick(page: Page, title: string) {
  await page.evaluate((title) => {
    const chat = JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
      (c: { title: string }) => c.title === title,
    );
    (window as any).emitTauriEvent('studio-notification-open', chat.id);
  }, title);
}
async function openSubagent(page: Page) {
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').first().click();
  await page.locator('.subagent-row').first().click();
}
const focusedWithin = (panel: ReturnType<Page['getByRole']>) =>
  panel.evaluate((element) => element.contains(document.activeElement));
// The paragraph at the top of the conversation's view, and how far the chat is scrolled.
const reading = (page: Page) =>
  page.locator('.chat-scroll').evaluate((scroll) => {
    const box = scroll.getBoundingClientRect();
    const paragraph = [...scroll.querySelectorAll('.prose p')].find(
      (p) => p.getBoundingClientRect().bottom > box.top + 1,
    );
    return { paragraph: paragraph?.textContent, top: Math.round(scroll.scrollTop) };
  });

test('each chat keeps its own side panel while other chats are shown @webkit', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await reply(page, 'Build the counter', [{ kind: 'text', text: fence('Counter', 60) }]);
  await page.getByRole('button', { name: 'Open Counter in side panel', exact: true }).click();
  const counter = page.getByRole('dialog', { name: 'Counter', exact: true });
  const preview = page.frameLocator('iframe[title="Counter preview"]').getByRole('button');
  await expect(counter).toHaveClass(/docked/);
  await expect(preview).toHaveText('0');

  // A new chat has no panel of its own.
  await page.getByRole('button', { name: 'New conversation', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-workspace')).not.toHaveClass(/has-side-panel/);
  await reply(page, 'Explore the auth code', [subagents, { kind: 'text', text: 'Done.' }]);
  await openSubagent(page);
  const reader = page.getByRole('dialog', { name: 'Explore the auth flow' });
  await expect(reader).toHaveClass(/docked/);

  // Each chat shows its own panel again, docked beside it, and focus stays on the chat chosen.
  await choose(page, 'Build the counter');
  await expect(reader).toHaveCount(0);
  await expect(counter).toHaveClass(/docked/);
  expect(await counter.evaluate((element) => element.matches(':modal'))).toBe(false);
  await expect(preview).toHaveText('0');
  await expect(page.locator('.chat-workspace')).toHaveClass(/has-side-panel/);
  await expect(row(page, 'Build the counter')).toBeFocused();
  expect(await focusedWithin(counter)).toBe(false);
  await choose(page, 'Explore the auth code');
  await expect(counter).toHaveCount(0);
  await expect(reader).toHaveClass(/docked/);
  await expect(reader.getByRole('region', { name: 'Result' })).toHaveText(
    'Sessions live in session.ts.',
  );
  await expect(row(page, 'Explore the auth code')).toBeFocused();
  expect(await focusedWithin(reader)).toBe(false);

  // Closing a panel closes it for its chat alone, and focus returns to where it was.
  await reader.getByRole('button', { name: 'Close sub-agent' }).click();
  await expect(reader).toHaveCount(0);
  await expect(row(page, 'Explore the auth code')).toBeFocused();
  await choose(page, 'Build the counter');
  await expect(counter).toHaveClass(/docked/);
  await choose(page, 'Explore the auth code');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.chat-workspace')).not.toHaveClass(/has-side-panel/);

  // Settings leaves the panel with its chat, which comes back at the paragraph being read.
  await choose(page, 'Build the counter');
  await expect(counter).toHaveClass(/docked/);
  await page.locator('.chat-scroll').evaluate((scroll) => (scroll.scrollTop = 600));
  await expect.poll(async () => (await reading(page)).top).toBe(600);
  const place = await reading(page);
  expect(place.paragraph).toMatch(/^Paragraph \d+ of the counter notes\.$/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(counter).toHaveClass(/docked/);
  await expect.poll(async () => (await reading(page)).paragraph).toBe(place.paragraph);
  expect(Math.abs((await reading(page)).top - place.top)).toBeLessThanOrEqual(1);

  // An artifact in the modal belongs to the moment: it closes when its chat is left.
  await counter.getByRole('button', { name: 'Open in modal', exact: true }).click();
  expect(await counter.evaluate((element) => element.matches(':modal'))).toBe(true);
  await notificationClick(page, 'Explore the auth code');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, 'Explore the auth code')).toHaveAttribute('aria-current', 'page');
  await choose(page, 'Build the counter');
  await expect(page.getByRole('button', { name: 'Open Counter in side panel' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a drawer returns with its chat on a phone, where it takes focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await reply(page, 'Say hello', [{ kind: 'text', text: 'Hello.' }]);
  await page.keyboard.press('Control+n');
  await reply(page, 'Explore the auth code', [subagents, { kind: 'text', text: 'Done.' }]);
  await openSubagent(page);
  const reader = page.getByRole('dialog', { name: 'Explore the auth flow' });
  expect(await reader.evaluate((element) => element.matches(':modal'))).toBe(true);

  // Another chat opens over the drawer from its notification, and the drawer returns with its own.
  await notificationClick(page, 'Say hello');
  await expect(reader).toHaveCount(0);
  await expect(page.getByText('Hello.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
  await row(page, 'Explore the auth code').click();
  await expect(reader).toBeVisible();
  expect(await reader.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(reader.getByRole('button', { name: 'Close sub-agent' })).toBeFocused();
  await reader.getByRole('button', { name: 'Close sub-agent' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(input(page)).toBeVisible();
});
