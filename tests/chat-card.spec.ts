import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// As in Linear, the sidebar lies on the window's own surface, and so does the window's title,
// above the cards of what is shown. An ordinary chat is a card, a line between its toolbar and its
// conversation. Docked side panels are cards beside it, and the gap between them is the
// invisible handle that resizes the panel.

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

test('the whole chat is a card below its title, and the gap beside a side panel resizes it @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  // The toolbar and the conversation share the card, the toolbar's line between them.
  expect(await radius(page, '.chat-layout')).not.toBe('0px');
  expect(await radius(page, '.chat-toolbar')).toBe('0px');
  const divider = await page.locator('.chat-toolbar').evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: style.borderBottomWidth, color: style.borderBottomColor };
  });
  expect(divider.width).toBe('1px');
  expect(divider.color).not.toBe('rgba(0, 0, 0, 0)');
  // The window's title stays above the card.
  const [title, card] = await Promise.all([
    page.locator('.topbar').boundingBox(),
    page.locator('.chat-layout').boundingBox(),
  ]);
  expect(card!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  // The sidebar and the title lie on the window's surface, outside every card.
  expect(
    await page
      .locator('.sidebar')
      .evaluate((element) => getComputedStyle(element).borderRightWidth),
  ).toBe('0px');
  expect(await radius(page, '.main-area')).toBe('0px');
  expect(title!.y).toBe(0);
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
  expect(await radius(page, 'dialog.docked')).not.toBe('0px');
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

test('Settings and Connections sit in the same card, below the window title @webkit', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  for (const view of ['Settings', 'Connections']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const card = page.locator('.page-card');
    await expect(card.getByRole('heading', { name: view, level: 1 })).toBeVisible();
    expect(await radius(page, '.page-card')).not.toBe('0px');
    const [title, box] = await Promise.all([
      page.locator('.topbar').boundingBox(),
      card.boundingBox(),
    ]);
    expect(box!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  }
});
