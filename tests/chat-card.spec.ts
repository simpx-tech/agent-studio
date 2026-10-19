import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// An ordinary chat shows one part as a card on the workspace, chosen in Settings → Appearance:
// its conversation (the default) or its toolbar. Docked side panels are cards beside it, and the
// gap between them is the invisible handle that resizes the panel.

const requests = (page: Page) =>
  page.evaluate(() => ((window as any).runRequests ?? []) as { runId: string }[]);
async function reply(page: Page, runId: string, text: string) {
  await page.evaluate(
    ({ runId, text }) => {
      const run = (window as any).capabilityRuns[runId];
      run.emit({ kind: 'text', text });
      run.finish('complete');
    },
    { runId, text },
  );
}
const radius = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => getComputedStyle(element).borderTopLeftRadius);

test('the conversation or the toolbar is the card, and the gap beside a side panel resizes it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  // At first the conversation is the card, below a toolbar on the workspace.
  expect(await radius(page, '.chat-body')).not.toBe('0px');
  expect(await radius(page, '.chat-toolbar')).toBe('0px');
  // Appearance chooses the toolbar instead, kept on this device.
  await page.getByRole('button', { name: 'Settings' }).click();
  const cards = page.getByRole('radiogroup', { name: 'Chat card' });
  await expect(cards.getByRole('radio', { name: 'Conversation' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await cards.getByRole('radio', { name: 'Toolbar' }).click();
  await expect(cards.getByRole('radio', { name: 'Toolbar' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The arrow keys move between them too.
  await page.keyboard.press('ArrowRight');
  await expect(cards.getByRole('radio', { name: 'Conversation' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cards.getByRole('radio', { name: 'Toolbar' })).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('agent-studio.chat-card'))).toBe('header');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  expect(await radius(page, '.chat-toolbar')).not.toBe('0px');
  expect(await radius(page, '.chat-body')).toBe('0px');
  // A docked side panel is a card beside the chat; the gap between them resizes it.
  await page.getByLabel('Message', { exact: true }).fill('Make me a page.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const fence = '`'.repeat(3);
  await reply(
    page,
    (await requests(page))[0].runId,
    `Here it is.\n\n${fence}html Demo page\n<!doctype html><html><body><h1>Hi</h1></body></html>\n${fence}`,
  );
  await page.getByRole('button', { name: 'Open Demo page in side panel' }).click();
  const panel = page.locator('dialog.docked');
  await expect(panel).toBeVisible();
  const gap = page.getByRole('separator', { name: 'Resize artifact panel', exact: true });
  const [chat, handle, side] = await Promise.all([
    page.locator('.chat-layout').boundingBox(),
    gap.boundingBox(),
    panel.boundingBox(),
  ]);
  expect(handle!.x).toBeGreaterThanOrEqual(chat!.x + chat!.width - 1);
  expect(handle!.x + handle!.width).toBeLessThanOrEqual(side!.x + 1);
  // Invisible until a keyboard focuses it.
  expect(
    await gap.evaluate((element) => getComputedStyle(element, '::after').backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)');
  await gap.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeGreaterThan(side!.width + 5);
  const moved = (await gap.boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 200);
  await page.mouse.down();
  await page.mouse.move(moved.x - 60, moved.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeGreaterThan(side!.width + 50);
});
