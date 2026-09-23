import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const context = Array.from({ length: 40 }, (_, i) => `Context line ${i + 1}`).join('\n');
const reasoning = (steps: number) =>
  Array.from({ length: steps }, (_, i) => `Reasoning step ${i + 1} compares an option.`).join(
    '\n\n',
  );

async function start(page: Page, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  // A long first message makes the conversation scroll above the reply.
  await page.getByLabel('Message', { exact: true }).fill(context);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
}
const emit = (page: Page, event: unknown) =>
  page.evaluate((e) => (window as any).emitCapability(e), event);
// A disclosure settles in the frame after its activation.
const frames = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
function measure(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const scroll = document.querySelector<HTMLElement>('.chat-scroll')!;
    const view = scroll.getBoundingClientRect();
    const bottom = view.top + scroll.clientTop + scroll.clientHeight;
    return {
      top: scroll.scrollTop,
      max: scroll.scrollHeight - scroll.clientHeight,
      space: document.querySelector<HTMLElement>('.chat-virtual-space')?.offsetHeight ?? 0,
      // Blank viewport below the conversation's real end.
      gap: bottom - document.querySelector('.message-column')!.getBoundingClientRect().bottom,
      target: document.querySelector(selector)!.getBoundingClientRect().top - view.top,
    };
  }, selector);
}
// Place a control a fixed distance below the top of the conversation viewport.
const place = (page: Page, selector: string, offset: number) =>
  page.locator('.chat-scroll').evaluate(
    (scroll, { selector, offset }) => {
      const target = scroll.querySelector(selector)!;
      scroll.scrollTop +=
        target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
    },
    { selector, offset },
  );

for (const mobile of [false, true])
  test(`collapsing near the end keeps the chat in place ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    await start(page, mobile);
    await emit(page, {
      kind: 'reasoning',
      id: 'r1',
      revision: 1,
      text: reasoning(40),
      truncated: false,
    });
    await emit(page, { kind: 'text', text: 'Final answer paragraph.\n\n'.repeat(2) });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
      'data-status',
      'complete',
    );
    await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
    const summary = '.reasoning-panel > summary';
    await page.locator(summary).click();
    await expect(page.locator('.reasoning-panel')).toHaveAttribute('open', '');
    await place(page, summary, 120);
    const before = await measure(page, summary);
    expect(Math.abs(before.target - 120)).toBeLessThan(1);
    expect(before.space).toBe(0);
    await page.locator(summary).click();
    await expect(page.locator('.reasoning-panel')).not.toHaveAttribute('open', '');
    await frames(page);
    await page.locator('.chat-scroll').screenshot({
      path: `artifacts/chat-virtual-space-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    // Without virtual space the shorter conversation pulls the summary down to its end.
    const held = await measure(page, summary);
    expect(Math.abs(held.target - before.target)).toBeLessThan(1);
    expect(Math.abs(held.top - before.top)).toBeLessThan(1);
    expect(held.space).toBeGreaterThan(150);
    expect(Math.abs(held.gap - held.space)).toBeLessThan(2);
    expect(held.max - held.top).toBeLessThan(1);

    // The space never lets the reader scroll further down.
    await page.locator('.chat-scroll').hover({ position: { x: 20, y: 20 } });
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
    expect(Math.abs((await measure(page, summary)).top - held.top)).toBeLessThan(1);

    // Scrolling up erases the space it moves away from.
    await page.locator('.chat-scroll').evaluate((scroll) => (scroll.scrollTop -= 60));
    await expect.poll(async () => (await measure(page, summary)).space).toBeLessThan(held.space);
    const up = await measure(page, summary);
    expect(Math.abs(held.top - up.top - 60)).toBeLessThan(1);
    expect(Math.abs(up.space - (held.space - 60))).toBeLessThan(2);
    expect(up.max - up.top).toBeLessThan(1);
    expect(Math.abs(up.target - held.target - 60)).toBeLessThan(1);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
    expect(Math.abs((await measure(page, summary)).top - up.top)).toBeLessThan(1);

    await page.mouse.wheel(0, -50000);
    await expect.poll(async () => (await measure(page, summary)).top).toBeLessThan(1);
    expect((await measure(page, summary)).space).toBe(0);
    await page.mouse.wheel(0, 50000);
    await expect
      .poll(async () => {
        const end = await measure(page, summary);
        return end.max - end.top;
      })
      .toBeLessThan(1);
    const end = await measure(page, summary);
    expect(end.space).toBe(0);
    expect(Math.abs(end.gap)).toBeLessThan(2);

    // Space held in one conversation never follows the reader into another.
    await page.locator(summary).click();
    await place(page, summary, 120);
    await page.locator(summary).click();
    await frames(page);
    expect((await measure(page, summary)).space).toBeGreaterThan(150);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
    await page.keyboard.press('Control+n');
    await expect(page.locator('.message-column.empty')).toBeVisible();
    await expect(page.locator('.chat-virtual-space')).toHaveJSProperty('offsetHeight', 0);
  });

test('expanding at the end of a running reply stops following it', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++)
      (window as any).emitCapability({
        kind: 'tool',
        tool: {
          id: `follow-tool-${i}`,
          revision: 1,
          category: 'tool',
          name: 'Run command',
          status: 'complete',
          detail: `Read project context ${i}`,
          sources: [],
          agents: [],
        },
      });
  });
  const summary = '.activity-group > summary';
  await expect(page.locator(summary)).toBeVisible();
  const atEnd = async () => {
    const end = await measure(page, summary);
    return end.max - end.top;
  };
  expect(await atEnd()).toBeLessThan(2);
  // Expanding and collapsing again returns to the end, where following continues.
  await page.locator(summary).click();
  await expect(page.locator('.tool-card')).toHaveCount(30);
  await frames(page);
  await page.locator(summary).click();
  await expect(page.locator('.activity-group')).not.toHaveAttribute('open', '');
  await frames(page);
  expect(await atEnd()).toBeLessThan(2);
  expect((await measure(page, summary)).space).toBe(0);
  await emit(page, { kind: 'progress', id: 'p0', revision: 1, text: 'Reading the config' });
  await expect(page.locator('.progress-message')).toHaveCount(1);
  await expect.poll(atEnd).toBeLessThan(2);

  const following = await measure(page, summary);
  await page.locator(summary).click();
  await expect(page.locator('.tool-card')).toHaveCount(30);
  await frames(page);
  const expanded = await measure(page, summary);
  expect(Math.abs(expanded.target - following.target)).toBeLessThan(1);
  expect(expanded.max - expanded.top).toBeGreaterThan(500);
  // A following chat would scroll to the end here and move the expanded group away.
  await emit(page, { kind: 'progress', id: 'p1', revision: 1, text: 'Checking one more file' });
  await expect(page.locator('.progress-message')).toHaveCount(2);
  await page.waitForTimeout(400);
  const after = await measure(page, summary);
  expect(Math.abs(after.top - expanded.top)).toBeLessThan(1);
  expect(Math.abs(after.target - expanded.target)).toBeLessThan(1);

  // Returning to the end resumes following.
  await page.locator('.chat-scroll').hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, 50000);
  await expect.poll(atEnd).toBeLessThan(2);
  await emit(page, { kind: 'text', text: 'Streaming answer paragraph.\n\n'.repeat(30) });
  await expect(page.locator('.message-content > .prose p')).toHaveCount(30);
  await expect.poll(atEnd).toBeLessThan(2);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
});

test('collapsing while following fills the space with new content before following', async ({
  page,
}) => {
  await start(page);
  await emit(page, {
    kind: 'reasoning',
    id: 'r1',
    revision: 1,
    text: reasoning(10),
    truncated: false,
  });
  const summary = '.reasoning-panel > summary';
  await page.locator(summary).click();
  await expect(page.locator('.reasoning-panel')).toHaveAttribute('open', '');
  // Expanding stopped following; return to the end to follow again.
  await page.locator('.chat-scroll').hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(0, 50000);
  await expect
    .poll(async () => {
      const end = await measure(page, summary);
      return end.max - end.top;
    })
    .toBeLessThan(2);
  const before = await measure(page, summary);
  expect(before.target).toBeGreaterThan(0);
  await page.locator(summary).click();
  await frames(page);
  const held = await measure(page, summary);
  expect(Math.abs(held.target - before.target)).toBeLessThan(1);
  expect(held.space).toBeGreaterThan(200);

  // A short answer appears in the held space without moving the chat.
  await emit(page, { kind: 'text', text: 'Short answer.' });
  await expect(page.locator('.message-content > .prose')).toHaveText('Short answer.');
  await page.waitForTimeout(300);
  const filling = await measure(page, summary);
  expect(Math.abs(filling.top - held.top)).toBeLessThan(1);
  expect(Math.abs(filling.target - held.target)).toBeLessThan(1);
  expect(filling.space).toBeLessThan(held.space - 10);
  expect(filling.space).toBeGreaterThan(0);
  expect(filling.max - filling.top).toBeLessThan(1);

  // Once new content fills the space, the chat follows it again.
  await emit(page, { kind: 'text', text: 'Longer streaming answer.\n\n'.repeat(40) });
  await expect(page.locator('.message-content > .prose p')).toHaveCount(40);
  await expect
    .poll(async () => {
      const end = await measure(page, summary);
      return end.max - end.top;
    })
    .toBeLessThan(2);
  expect((await measure(page, summary)).space).toBe(0);
  expect((await measure(page, summary)).top).toBeGreaterThan(held.top + 200);
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
});

test('show fewer files keeps visible content or the control in place', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({
      kind: 'filechanges',
      fileChanges: {
        revision: 1,
        limited: false,
        edits: [
          {
            id: 'edit-1',
            files: Array.from({ length: 30 }, (_, i) => ({
              path: `C:/Projects/studio/src/file-${String(i + 1).padStart(2, '0')}.ts`,
              kind: 'modified',
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ['-before', '+after'],
                },
              ],
            })),
          },
        ],
      },
    });
    w.emitCapability({ kind: 'text', text: 'Updated thirty files.' });
    w.finishCapabilities('complete');
  });
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  // A later exchange keeps the file list away from the end of the conversation.
  await page.getByLabel('Message', { exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
  await emit(page, { kind: 'text', text: 'Later answer paragraph.\n\n'.repeat(40) });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  await page
    .getByRole('button', { name: /Files edited/ })
    .first()
    .click();
  const first = '.changed-file:first-child > summary';
  const toggle = '.show-files';
  await place(page, first, 150);
  const shown = await measure(page, first);
  expect(Math.abs(shown.target - 150)).toBeLessThan(1);
  // Showing more keeps the files already in view where they are.
  await page.locator(toggle).click();
  await expect(page.locator('.changed-file')).toHaveCount(30);
  await frames(page);
  expect(Math.abs((await measure(page, first)).target - shown.target)).toBeLessThan(1);
  // Showing fewer while only later files are visible keeps the control under the pointer.
  await place(page, toggle, 350);
  const before = await measure(page, toggle);
  expect(Math.abs(before.target - 350)).toBeLessThan(1);
  await page.locator(toggle).click();
  await expect(page.locator('.changed-file')).toHaveCount(5);
  await frames(page);
  const after = await measure(page, toggle);
  expect(Math.abs(after.target - before.target)).toBeLessThan(1);
  expect(after.space).toBe(0);
  await expect(page.locator(toggle)).toBeInViewport();
});
