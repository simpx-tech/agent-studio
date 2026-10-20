import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// As in Linear, the sidebar lies on the window's own surface and everything beside it, the
// window's title included, is one card inset from the window's edges. A docked side panel is a
// pane of that card behind a line, the invisible handle that resizes it.

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
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .evaluate(
      (element, property) => getComputedStyle(element).getPropertyValue(property),
      property,
    );

test('everything beside the sidebar is one card, and a docked panel resizes from its line @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  // The sidebar has no edge of its own; the card holds the title and the chat.
  expect(await style(page, '.sidebar', 'border-right-width')).toBe('0px');
  expect(await style(page, '.main-area', 'border-top-left-radius')).not.toBe('0px');
  await expect(page.locator('.main-area > .topbar')).toBeVisible();
  const [shell, card] = await Promise.all([
    page.locator('.app-shell').boundingBox(),
    page.locator('.main-area').boundingBox(),
  ]);
  expect(card!.y).toBeGreaterThan(shell!.y);
  expect(card!.x + card!.width).toBeLessThan(shell!.x + shell!.width);
  // The chat itself is no card within it, its toolbar's line dividing it from the conversation.
  expect(await style(page, '.chat-layout', 'border-top-left-radius')).toBe('0px');
  expect(await style(page, '.chat-toolbar', 'border-bottom-width')).toBe('1px');
  // A docked side panel is a pane behind a line; the handle on the line resizes it.
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
  expect(await style(page, 'dialog.docked', 'border-top-left-radius')).toBe('0px');
  expect(await style(page, 'dialog.docked', 'border-left-width')).toBe('1px');
  const gap = page.getByRole('separator', { name: 'Resize artifact panel', exact: true });
  const [chat, handle, side] = await Promise.all([
    page.locator('.chat-layout').boundingBox(),
    gap.boundingBox(),
    panel.boundingBox(),
  ]);
  expect(Math.abs(handle!.x + handle!.width / 2 - side!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(chat!.x + chat!.width - side!.x)).toBeLessThanOrEqual(1);
  // Invisible until a keyboard focuses it.
  expect(
    await gap.evaluate((element) => getComputedStyle(element, '::after').backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)');
  await gap.focus();
  await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeGreaterThan(side!.width + 5);
  // A pointer takes it a few pixels either side of the line.
  const line = (await panel.boundingBox())!.x;
  await page.mouse.move(line - 3, side!.y + 200);
  await page.mouse.down();
  await page.mouse.move(line - 63, side!.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await panel.boundingBox())!.width)
    .toBeGreaterThan(side!.width + 50);
});

test('Settings and Connections fill the same card, below the window title @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  for (const [view, button] of [
    ['Settings', '.settings-button'],
    ['Connections', '.connections-button'],
  ]) {
    await page.locator(button).click();
    const card = page.locator('.main-area');
    await expect(card.getByRole('heading', { name: view, level: 1 })).toBeVisible();
    await expect(card.locator('.topbar')).toContainText(view);
    expect(await style(page, '.main-area', 'border-top-left-radius')).not.toBe('0px');
  }
});
