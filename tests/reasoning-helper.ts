import { expect, type Page } from '@playwright/test';

export const reasoningPicker = (page: Page) =>
  page.getByRole('combobox', { name: 'Reasoning', exact: true });

/** The slider the Reasoning picker opens. */
export const reasoningSlider = (page: Page) =>
  page.getByRole('slider', { name: 'Reasoning', exact: true });

/** The open slider's level names, one per stop in order. */
export const reasoningLevels = (page: Page) => page.locator('.choice-slider .slider-names > span');

/** Opens the Reasoning slider, steps it to a level with the arrow keys and closes it. */
export async function chooseReasoning(page: Page, name: string) {
  const slider = reasoningSlider(page);
  if (!(await slider.count())) await reasoningPicker(page).click();
  await expect(slider).toBeFocused();
  const names = await reasoningLevels(page).allTextContents();
  const target = names.indexOf(name);
  if (target < 0) throw new Error(`Reasoning has no ${name} level: ${names.join(', ')}`);
  const from = Number(await slider.inputValue());
  for (let at = from; at !== target; at += Math.sign(target - from))
    await slider.press(target > from ? 'ArrowRight' : 'ArrowLeft');
  await expect(slider).toHaveAttribute('aria-valuetext', name);
  await slider.press('Escape');
  await expect(slider).toHaveCount(0);
  await expect(reasoningPicker(page)).toHaveText(name);
}
