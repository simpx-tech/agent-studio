import { expect, test, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { reasoningLevels as stops, reasoningSlider as slider } from './reasoning-helper';

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
const control = (page: Page) => page.locator('.reasoning-setting .choice-slider');
// The name shown beside the track.
const shown = (page: Page) => control(page).locator('.slider-value > .shown');
// Where a stop lies on the track: the thumb's center rests on it.
async function stopPoint(page: Page, stop: number) {
  const box = (await slider(page).boundingBox())!;
  const count = await stops(page).count();
  const thumb = await control(page).evaluate((element) =>
    parseFloat(getComputedStyle(element).getPropertyValue('--thumb')),
  );
  return {
    x: box.x + thumb / 2 + ((box.width - thumb) * stop) / (count - 1),
    y: box.y + box.height / 2,
  };
}
async function expectReasoning(page: Page, name: string) {
  await expect(slider(page)).toHaveAttribute('aria-valuetext', name);
  await expect(shown(page)).toHaveText(name);
}
async function claudeOpus(page: Page) {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Opus');
}

test('reasoning is a slider over the model levels, by keyboard and pointer @webkit', async ({
  page,
}) => {
  await claudeOpus(page);
  await expect(stops(page)).toHaveText(['Default', 'Low', 'Medium', 'High', 'Max']);
  await expect(slider(page)).toBeEnabled();
  await expect(slider(page)).toHaveAttribute('max', '4');
  await page.screenshot({ path: 'artifacts/reasoning-slider-toolbar.png' });

  // The keyboard steps through the levels.
  await slider(page).press('Home');
  await expectReasoning(page, 'Default');
  const width = (await control(page).boundingBox())!.width;
  await slider(page).press('End');
  await expectReasoning(page, 'Max');
  await slider(page).press('ArrowLeft');
  await expectReasoning(page, 'High');
  // The control keeps its width whichever name it shows.
  expect((await control(page).boundingBox())!.width).toBe(width);

  // A click on a stop chooses it, and a drag follows the pointer to the stop it ends on.
  let point = await stopPoint(page, 1);
  await page.mouse.click(point.x, point.y);
  await expectReasoning(page, 'Low');
  await page.mouse.down();
  point = await stopPoint(page, 4);
  await page.mouse.move(point.x + 30, point.y, { steps: 6 });
  await page.mouse.up();
  await expectReasoning(page, 'Max');
  await page.locator('.chat-toolbar').screenshot({ path: 'artifacts/reasoning-slider-max.png' });

  // Another model has its own levels, and each model keeps the level chosen for it.
  await pick(page, 'Model', 'Sonnet');
  await expect(stops(page)).toHaveText(['Default', 'Low', 'Medium', 'High']);
  await slider(page).press('End');
  await expectReasoning(page, 'High');
  await pick(page, 'Model', 'Opus');
  await expectReasoning(page, 'Max');

  await page.getByLabel('Message', { exact: true }).fill('Think hard');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ provider: 'claude', model: 'opus', reasoning: 'max' });
  // An existing chat keeps it, and it still changes for the next message.
  await expectReasoning(page, 'Max');
  await slider(page).press('ArrowLeft');
  await expectReasoning(page, 'High');
  await page.getByLabel('Message', { exact: true }).fill('A little less');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await expect(page.locator('.reply-switch')).toHaveText('Switched to High reasoning');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ model: 'opus', reasoning: 'high' });
});

test('/reasoning moves focus to the slider and keeps the draft', async ({ page }) => {
  await claudeOpus(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/reasoning keep this draft');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(slider(page)).toBeFocused();
  await expect(input).toHaveValue('keep this draft');
  await page.keyboard.press('End');
  await expectReasoning(page, 'Max');
  await expect(page.locator('.message')).toHaveCount(0);
});

test('the slider fits the toolbar in narrow windows and in light @webkit', async ({ page }) => {
  await claudeOpus(page);
  await slider(page).press('End');
  const row = () =>
    page
      .locator('.chat-configuration')
      .locator('[role="combobox"], .choice-slider')
      .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().top));
  for (const width of [1380, 1100, 880]) {
    await page.setViewportSize({ width, height: 720 });
    expect(new Set(await row()).size).toBe(1);
    // The whole slider shows, its name included.
    const configuration = (await page.locator('.chat-configuration').boundingBox())!;
    const box = (await control(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(configuration.x + configuration.width + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page
      .locator('.chat-toolbar')
      .screenshot({ path: `artifacts/reasoning-slider-${width}.png` });
  }
  await page.evaluate(() => localStorage.setItem('agent-studio.theme', 'light'));
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.setViewportSize({ width: 1380, height: 720 });
  await expectReasoning(page, 'Max');
  await page.locator('.chat-toolbar').screenshot({ path: 'artifacts/reasoning-slider-light.png' });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a tap anywhere on the track chooses that stop @webkit', async ({ page }) => {
    await claudeOpus(page);
    await slider(page).scrollIntoViewIfNeeded();
    const box = (await control(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await slider(page).press('Home');
    await expectReasoning(page, 'Default');
    let point = await stopPoint(page, 3);
    await page.touchscreen.tap(point.x, point.y);
    await expectReasoning(page, 'High');
    point = await stopPoint(page, 1);
    await page.touchscreen.tap(point.x, point.y);
    await expectReasoning(page, 'Low');
    await page.screenshot({ path: 'artifacts/reasoning-slider-phone.png' });

    // iOS moves a range input only from its thumb, so the page follows a finger itself. These
    // events reach only the page: the input does nothing with untrusted ones.
    const finger = async (type: string, stop: number, buttons = 1) => {
      const at = await stopPoint(page, stop);
      await slider(page).dispatchEvent(type, {
        pointerType: 'touch',
        isPrimary: true,
        buttons,
        clientX: at.x,
        clientY: at.y,
        bubbles: true,
      });
    };
    await finger('pointerdown', 0);
    await expectReasoning(page, 'Default');
    await finger('pointermove', 2);
    await expectReasoning(page, 'Medium');
    await finger('pointermove', 4);
    await expectReasoning(page, 'Max');
    // A pen held above the screen moves nothing.
    await finger('pointermove', 1, 0);
    await expectReasoning(page, 'Max');
  });
});
