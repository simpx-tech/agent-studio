import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `Draft line ${i + 1}`).join('\n');

async function open(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
}
const measure = (page: Page) =>
  page.getByLabel('Message', { exact: true }).evaluate((input) => {
    const form = input.closest('form')!;
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
    return {
      input: input.getBoundingClientRect().height,
      content: input.scrollHeight,
      form: form.getBoundingClientRect().height,
      // Draft lines that fit without scrolling, after the 2px top padding.
      lines: (input.clientHeight - 2) / lineHeight,
    };
  });

for (const mobile of [false, true])
  test(`the composer grows with the draft, then scrolls ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    const input = page.getByLabel('Message', { exact: true });
    await expect(input).toBeVisible();
    // Three lines at rest, with or without a short draft.
    const rest = await measure(page);
    expect(rest.lines).toBeCloseTo(3, 1);
    await input.fill('A short draft');
    expect((await measure(page)).input).toBe(rest.input);

    await input.fill(lines(4));
    await expect.poll(async () => (await measure(page)).lines).toBeCloseTo(4, 1);
    const four = await measure(page);
    expect(four.content - four.input).toBeLessThanOrEqual(1);

    await input.fill(lines(80));
    if (mobile) {
      // Phones stop at four lines, leaving the conversation visible above the keyboard.
      await expect.poll(async () => (await measure(page)).input).toBe(four.input);
    } else {
      // Desktop stops when the whole composer box reaches half the window.
      await expect
        .poll(async () => Math.abs((await measure(page)).form - 900 / 2))
        .toBeLessThanOrEqual(1);
    }
    const full = await measure(page);
    expect(full.content).toBeGreaterThan(full.input + 200);
    // The field scrolls to keep the last line, where the caret is, in view.
    expect(
      await input.evaluate(
        (el) =>
          (el.scrollHeight - el.scrollTop - el.clientHeight) /
          parseFloat(getComputedStyle(el).lineHeight),
      ),
    ).toBeLessThan(0.5);
    await page.screenshot({
      path: `artifacts/composer-growth-${mobile ? 'mobile' : 'desktop'}.png`,
    });

    // Usage details open over the conversation that remains, below the toolbar.
    await page.locator('.context-chip').click();
    const details = page.locator('.usage-details');
    await expect(details).toBeVisible();
    await details.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const bounds = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        return { top, bottom };
      });
    const [panel, chat, composer] = await Promise.all([
      bounds('.usage-details'),
      bounds('.chat-scroll'),
      bounds('.composer-area'),
    ]);
    expect(panel.top).toBeGreaterThanOrEqual(chat.top);
    expect(panel.bottom).toBeLessThanOrEqual(composer.top);
    // A trial click fails when the panel would intercept the toolbar's pointer events.
    await page.getByRole('combobox', { name: 'Model', exact: true }).click({ trial: true });
    await page.screenshot({
      path: `artifacts/composer-growth-usage-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await page.getByRole('button', { name: 'Close usage details', exact: true }).click();
    await expect(details).toHaveCount(0);

    await input.fill('');
    await expect.poll(async () => (await measure(page)).input).toBe(rest.input);
  });

test('a growing draft keeps a followed conversation at its end', async ({ page }) => {
  await open(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('First message in the conversation');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({
      kind: 'text',
      text: 'Answer paragraph.\n\n'.repeat(59) + 'Last answer paragraph.',
    });
    w.finishCapabilities('complete');
  });
  await expect(page.locator('[data-testid="message"]').last()).toHaveAttribute(
    'data-status',
    'complete',
  );
  const scroll = page.locator('.chat-scroll');
  const position = () =>
    scroll.evaluate((el) => ({
      top: el.scrollTop,
      below: el.scrollHeight - el.scrollTop - el.clientHeight,
      height: el.clientHeight,
    }));
  await expect.poll(async () => (await position()).below).toBeLessThan(2);
  const following = await position();

  // Typing a long reply shortens the chat from below without hiding its end.
  await input.fill(lines(40));
  await expect.poll(async () => (await position()).height).toBeLessThan(following.height - 250);
  expect((await position()).below).toBeLessThan(2);
  await expect(scroll.getByText('Last answer paragraph.', { exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.screenshot({ path: 'artifacts/composer-growth-following.png' });

  // Deleting the draft returns the chat to its height, still at the end.
  await input.fill('');
  await expect.poll(async () => (await position()).height).toBe(following.height);
  expect((await position()).below).toBeLessThan(2);

  // A reading position above the end stays put while the draft grows.
  await scroll.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await position()).below).toBeGreaterThan(200);
  const reading = await position();
  await input.fill(lines(40));
  await expect.poll(async () => (await position()).height).toBeLessThan(reading.height - 250);
  expect(Math.abs((await position()).top - reading.top)).toBeLessThan(1);
  await expect(input).toHaveValue(lines(40));
});
