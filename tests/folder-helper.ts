import { expect, type Page } from '@playwright/test';

export async function chooseTestFolder(page: Page) {
  if (!(await page.evaluate(() => (window as any).isTauri))) return;
  if (
    !(await page.getByRole('combobox', { name: 'Folder', exact: true }).textContent())?.includes(
      'Browse folders',
    )
  )
    return;
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
}
