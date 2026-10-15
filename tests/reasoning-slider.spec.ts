import { expect, test, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import {
  reasoningLevels as names,
  reasoningPicker as picker,
  reasoningSlider as slider,
} from './reasoning-helper';

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
const popover = (page: Page) => page.locator('.picker-popover:popover-open');
const chosen = (page: Page) => page.locator('.slider-names > .chosen');
async function expectReasoning(page: Page, name: string) {
  await expect(slider(page)).toHaveAttribute('aria-valuetext', name);
  await expect(chosen(page)).toHaveText(name);
  await expect(picker(page)).toHaveText(name);
}
// Where a stop lies on the track: the thumb's center rests on it.
async function stopPoint(page: Page, stop: number) {
  const box = (await page.locator('.slider-track').boundingBox())!;
  const count = await names(page).count();
  const thumb = await page
    .locator('.choice-slider')
    .evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue('--thumb')));
  return {
    x: box.x + thumb / 2 + ((box.width - thumb) * stop) / (count - 1),
    y: box.y + box.height / 2,
  };
}
async function thumbCenter(page: Page) {
  const box = (await page.locator('.slider-thumb').boundingBox())!;
  return box.x + box.width / 2;
}
const settled = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
async function claude(page: Page, model = 'Opus', levels?: string[]) {
  await mockDesktop(page);
  if (levels)
    await page.addInitScript((levels) => {
      localStorage.setItem(
        'test-claude-models',
        JSON.stringify([
          { id: '', name: 'CLI default', reasoningLevels: [], defaultReasoning: '' },
          { id: 'opus', name: 'Opus', reasoningLevels: levels, defaultReasoning: '' },
        ]),
      );
    }, levels);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', model);
}

test('the Reasoning picker opens a slider over the model levels @webkit', async ({ page }) => {
  await claude(page);
  await expect(picker(page)).toHaveText('Medium');
  await expect(slider(page)).toHaveCount(0);

  // The slider opens with focus, and each step is chosen at once.
  await picker(page).click();
  await expect(slider(page)).toBeFocused();
  await expect(names(page)).toHaveText(['Default', 'Low', 'Medium', 'High', 'Max']);
  await expectReasoning(page, 'Medium');
  await page.keyboard.press('ArrowRight');
  await expectReasoning(page, 'High');
  await page.keyboard.press('Home');
  await expectReasoning(page, 'Default');
  await page.keyboard.press('End');
  await expectReasoning(page, 'Max');
  await page
    .locator('.chat-toolbar')
    .screenshot({ path: 'artifacts/reasoning-slider-toolbar.png' });
  await page.keyboard.press('Escape');
  await expect(slider(page)).toHaveCount(0);
  await expect(picker(page)).toBeFocused();
  await expect(picker(page)).toHaveText('Max');

  // From the keyboard, Enter opens it and closes it again.
  await page.keyboard.press('Enter');
  await expect(slider(page)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expectReasoning(page, 'High');
  await page.keyboard.press('Enter');
  await expect(slider(page)).toHaveCount(0);
  await expect(picker(page)).toBeFocused();

  // A click on a name or along the track chooses that stop and keeps the slider open.
  await picker(page).click();
  await names(page).filter({ hasText: /^Low$/ }).click();
  await expectReasoning(page, 'Low');
  let point = await stopPoint(page, 3);
  await page.mouse.click(point.x, point.y + 2);
  await expectReasoning(page, 'High');
  await expect(slider(page)).toBeFocused();

  // A drag holds the thumb under the pointer, then settles on the nearest stop.
  point = await stopPoint(page, 3);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const end = await stopPoint(page, 4);
  const between = point.x + (end.x - point.x) * 0.4;
  await page.mouse.move(between, point.y, { steps: 4 });
  expect(Math.abs((await thumbCenter(page)) - between)).toBeLessThan(1.5);
  await expectReasoning(page, 'High');
  await page.mouse.move(end.x + 40, point.y, { steps: 4 });
  await expectReasoning(page, 'Max');
  await page.mouse.up();
  await settled(page);
  expect(Math.abs((await thumbCenter(page)) - end.x)).toBeLessThan(1);
  await popover(page).screenshot({ path: 'artifacts/reasoning-slider-open.png' });

  // The trigger closes it, and so does a click elsewhere.
  await picker(page).click();
  await expect(slider(page)).toHaveCount(0);
  await expect(picker(page)).toBeFocused();
  await picker(page).click();
  await expect(slider(page)).toBeVisible();
  await page.getByLabel('Message', { exact: true }).click();
  await expect(slider(page)).toHaveCount(0);

  await page.getByLabel('Message', { exact: true }).fill('Think hard');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ provider: 'claude', model: 'opus', reasoning: 'max' });
});

test('the thumb and fill glide between stops and follow a drag at once', async ({ page }) => {
  await claude(page);
  await picker(page).click();
  await expect(slider(page)).toBeFocused();
  const runner = page.locator('.slider-runner');
  const fill = page.locator('.slider-fill');
  const glides = (locator: typeof runner) =>
    locator.evaluate((element) =>
      element
        .getAnimations()
        .filter((a) => (a as CSSTransition).transitionProperty === 'transform')
        .map((a) => a.playState),
    );
  await page.keyboard.press('End');
  expect(await glides(runner)).toEqual(['running']);
  expect(await glides(fill)).toEqual(['running']);
  await settled(page);
  expect(await glides(runner)).toEqual([]);

  // A dragged thumb moves with the pointer, without a glide behind it.
  const start = await stopPoint(page, 4);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 30, start.y, { steps: 3 });
  expect(await glides(runner)).toEqual([]);
  await page.mouse.up();
  expect(await glides(runner)).toEqual(['running']);
  await settled(page);

  // Reduced motion moves it at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Home');
  await expectReasoning(page, 'Default');
  expect(await glides(runner)).toEqual([]);
});

test('/reasoning opens the slider and keeps the draft', async ({ page }) => {
  await claude(page);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/reasoning keep this draft');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(slider(page)).toBeFocused();
  await expect(input).toHaveValue('keep this draft');
  await page.keyboard.press('End');
  await expectReasoning(page, 'Max');
  await expect(page.locator('.message')).toHaveCount(0);
});

test('seven levels keep their names apart in light @webkit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agent-studio.theme', 'light'));
  await claude(page, 'Opus', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  await picker(page).click();
  await expect(names(page)).toHaveText([
    'Default',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
    'Ultra',
  ]);
  await expectApart(page);
  await popover(page).screenshot({ path: 'artifacts/reasoning-slider-light.png' });
});

// Every name sits inside the popover without touching its neighbors.
async function expectApart(page: Page) {
  const panel = (await popover(page).boundingBox())!;
  const boxes = await names(page).evaluateAll((spans) =>
    spans.map((span) => {
      const { left, right } = span.getBoundingClientRect();
      return { left, right };
    }),
  );
  expect(boxes[0].left).toBeGreaterThanOrEqual(panel.x);
  expect(boxes.at(-1)!.right).toBeLessThanOrEqual(panel.x + panel.width);
  for (let i = 1; i < boxes.length; i++)
    expect(boxes[i].left - boxes[i - 1].right).toBeGreaterThanOrEqual(4);
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a tap or a finger along the track chooses a stop @webkit', async ({ page }) => {
    await claude(page, 'Opus', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    await picker(page).scrollIntoViewIfNeeded();
    await picker(page).tap();
    await expect(slider(page)).toBeVisible();
    await expectApart(page);
    let point = await stopPoint(page, 3);
    await page.touchscreen.tap(point.x, point.y);
    await expectReasoning(page, 'High');
    const name = (await names(page).nth(1).boundingBox())!;
    await page.touchscreen.tap(name.x + name.width / 2, name.y + name.height / 2);
    await expectReasoning(page, 'Low');
    await page.screenshot({ path: 'artifacts/reasoning-slider-phone.png' });

    // A finger dragged along the track takes the stops it passes.
    const finger = async (type: string, stop: number) => {
      point = await stopPoint(page, stop);
      await page.locator('.slider-area').dispatchEvent(type, {
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: point.x,
        clientY: point.y,
        bubbles: true,
      });
    };
    await finger('pointerdown', 0);
    await expectReasoning(page, 'Default');
    await finger('pointermove', 2);
    await expectReasoning(page, 'Medium');
    await finger('pointermove', 6);
    await expectReasoning(page, 'Ultra');
    await finger('pointerup', 6);
    await expect(slider(page)).toBeVisible();
  });
});
