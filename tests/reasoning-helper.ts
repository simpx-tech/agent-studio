import { expect, type Page } from '@playwright/test';

export const reasoningSlider = (page: Page) =>
  page.getByRole('slider', { name: 'Reasoning', exact: true });

/** The Reasoning slider's level names, one per stop in order. */
export const reasoningLevels = (page: Page) =>
  page.locator('.reasoning-setting .slider-value > span');

export async function expectReasoning(page: Page, name: string) {
  await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', name);
}

/** Steps the Reasoning slider to a level with the arrow keys. */
export async function chooseReasoning(page: Page, name: string) {
  const slider = reasoningSlider(page);
  await expect(slider).toBeEnabled();
  const names = await reasoningLevels(page).allTextContents();
  const target = names.indexOf(name);
  if (target < 0) throw new Error(`Reasoning has no ${name} level: ${names.join(', ')}`);
  const from = Number(await slider.inputValue());
  for (let at = from; at !== target; at += Math.sign(target - from))
    await slider.press(target > from ? 'ArrowRight' : 'ArrowLeft');
  await expectReasoning(page, name);
}
