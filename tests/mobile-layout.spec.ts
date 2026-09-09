import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function visualViewport(page: Page, height: number, offsetTop = 0, event = 'resize') {
  await page.evaluate(
    ({ height, offsetTop, event }) => {
      Object.assign(window.visualViewport!, { height, offsetTop });
      window.visualViewport!.dispatchEvent(new Event(event));
    },
    { height, offsetTop, event },
  );
}

test('composer follows keyboard resize and pan, then fills the standalone screen again', async ({
  page,
}, testInfo) => {
  // Desktop browser viewport resizing cannot reproduce iOS keyboard panning.
  // Supply the separate visual viewport signals while keeping the layout 844px high.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const composer = page.locator('.composer-area');
  await expect(input).toBeVisible();
  const bottom = async () => {
    const box = await composer.boundingBox();
    return Math.round(box!.y + box!.height);
  };
  await expect.poll(bottom).toBe(844);
  await input.focus();
  await visualViewport(page, 460, 150);
  await expect.poll(bottom).toBe(610);
  await input.pressSequentially('Typing with the keyboard open');
  await expect.poll(bottom).toBe(610);
  const inputBox = await input.boundingBox();
  expect(inputBox!.y).toBeGreaterThan(150);
  expect(inputBox!.y + inputBox!.height).toBeLessThan(610);
  await page.screenshot({ path: testInfo.outputPath('keyboard-resize-and-pan.png') });

  // Safari can pan without a resize, and dismissal can leave a small stale inset.
  await visualViewport(page, 460, 80, 'scroll');
  await expect.poll(bottom).toBe(540);
  await input.blur();
  await visualViewport(page, 800, 44);
  await expect.poll(bottom).toBe(844);
  await expect(input).toHaveValue('Typing with the keyboard open');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('keyboard-dismissed.png') });

  // Repeat focus/dismissal and handle a delayed geometry update without another resize event.
  await input.focus();
  await visualViewport(page, 460);
  await expect.poll(bottom).toBe(460);
  await input.blur();
  await page.evaluate(() => Object.assign(window.visualViewport!, { height: 844, offsetTop: 0 }));
  await expect.poll(bottom).toBe(844);
  await page.setViewportSize({ width: 390, height: 740 });
  await visualViewport(page, 740);
  await expect.poll(bottom).toBe(740);
});

test('mobile dropdowns stay beside their trigger and remain usable in a scrolled toolbar', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const computer = page.getByRole('combobox', { name: 'Computer', exact: true });
  await expect(computer).toBeEnabled();
  await computer.click();
  const panel = page.locator('.picker-popover:popover-open');
  await expect(panel).toBeVisible();
  let anchor = (await computer.boundingBox())!;
  let box = (await panel.boundingBox())!;
  expect(Math.abs(box.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await model.scrollIntoViewIfNeeded();
  await model.click();
  await expect(panel).toBeVisible();
  anchor = (await model.boundingBox())!;
  box = (await panel.boundingBox())!;
  expect(Math.abs(box.y - anchor.y - anchor.height - 6)).toBeLessThan(2);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  const toolbarScroll = await page
    .locator('.chat-configuration')
    .evaluate((node) => node.scrollLeft);
  await page.keyboard.press('End');
  expect(await page.locator('.chat-configuration').evaluate((node) => node.scrollLeft)).toBe(
    toolbarScroll,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('anchored-mobile-picker.png') });
  await page.getByRole('option').last().click();
  await expect(panel).toHaveCount(0);
  await expect(model).toBeFocused();
});
