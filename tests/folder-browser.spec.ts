import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const picker = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });

async function openBrowser(page: Page) {
  await picker(page, 'Folder').click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a folder' });
  await expect(dialog).toBeVisible();
  return {
    dialog,
    crumbs: dialog.getByRole('navigation', { name: 'Current folder' }),
    list: dialog.getByRole('list', { name: 'Folders' }),
    places: dialog.getByRole('complementary', { name: 'Quick access' }),
  };
}

test('folder browser offers breadcrumbs, places, filtering, hidden folders, and selection', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const { dialog, crumbs, list, places } = await openBrowser(page);
  await expect(crumbs).toContainText('studio');
  await expect(dialog.getByText('No subfolders. You can use this folder.')).toBeVisible();
  await expect(dialog.getByLabel('Filter folders', { exact: true })).toBeFocused();

  // Breadcrumb ancestors open directly; hidden folders stay out of the way by default.
  await crumbs.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(list.getByRole('button', { name: 'archive', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'studio', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'tools', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: '.cache', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('4 folders · 2 repositories · 1 hidden')).toBeVisible();
  await expect(list.getByRole('button', { name: 'studio', exact: true })).toHaveAttribute(
    'title',
    'C:\\Projects\\studio · Git repository',
  );
  await dialog.getByLabel('Show hidden', { exact: true }).check();
  await expect(list.getByRole('button', { name: '.cache', exact: true })).toBeVisible();
  await dialog.getByLabel('Show hidden', { exact: true }).uncheck();
  await expect(list.getByRole('button', { name: '.cache', exact: true })).toHaveCount(0);

  // Filtering narrows the list and Enter opens the first match.
  await dialog.getByLabel('Filter folders', { exact: true }).fill('too');
  await expect(list.getByRole('button', { name: 'tools', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'archive', exact: true })).toHaveCount(0);
  await dialog.getByLabel('Filter folders', { exact: true }).press('Enter');
  await expect(crumbs.getByText('tools')).toHaveAttribute('aria-current', 'location');
  await expect(dialog.getByLabel('Filter folders', { exact: true })).toHaveValue('');

  // A pasted absolute path becomes a jump action.
  await dialog.getByLabel('Filter folders', { exact: true }).fill('C:\\Projects\\studio');
  await expect(
    dialog.getByRole('button', { name: 'Open C:\\Projects\\studio', exact: true }),
  ).toBeVisible();
  await dialog.getByLabel('Filter folders', { exact: true }).press('Enter');
  await expect(crumbs.getByText('studio')).toHaveAttribute('aria-current', 'location');

  // Places: an unavailable drive reports its error without disabling the rest of the browser.
  await expect(places.getByRole('button', { name: 'Home', exact: true })).toHaveClass(/active/);
  await places.getByRole('button', { name: 'D:\\', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Drive not ready');
  await expect(dialog.getByRole('button', { name: 'Use this folder', exact: true })).toBeDisabled();
  await places.getByRole('button', { name: 'C:\\', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(list.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: '$RECYCLE.BIN', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Parent folder', exact: true })).toBeDisabled();
  await expect(places.getByRole('button', { name: 'C:\\', exact: true })).toHaveClass(/active/);
  await page.screenshot({ path: 'artifacts/folder-browser-desktop.png', animations: 'disabled' });

  // Rows only open folders; the footer action selects the open folder.
  await places.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(list.getByRole('button', { name: /^Use / })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Refresh folders', exact: true })).toHaveCount(0);
  await list.getByRole('button', { name: 'tools', exact: true }).click();
  await expect(crumbs.getByText('tools')).toHaveAttribute('aria-current', 'location');
  await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker(page, 'Folder')).toHaveAttribute('title', 'C:\\Projects\\tools');
  await expect(picker(page, 'Folder')).toHaveText('tools');

  // Reopening starts at the selected folder and lists it under Recent.
  const reopened = await openBrowser(page);
  await expect(reopened.crumbs.getByText('tools')).toHaveAttribute('aria-current', 'location');
  await expect(reopened.places.getByText('Recent')).toBeVisible();
  await expect(reopened.places.getByRole('button', { name: 'tools', exact: true })).toHaveClass(
    /active/,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker(page, 'Folder')).toHaveAttribute('title', 'C:\\Projects\\tools');
});

test('folder browser supports path editing, keyboard navigation, and a narrow layout', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const { dialog, crumbs, list, places } = await openBrowser(page);
  await dialog.getByRole('button', { name: 'Edit path', exact: true }).click();
  await expect(dialog.getByLabel('Folder path', { exact: true })).toHaveValue(
    'C:\\Projects\\studio',
  );
  await expect(dialog.getByLabel('Folder path', { exact: true })).toBeFocused();
  await dialog.getByLabel('Folder path', { exact: true }).fill('C:\\Projects');
  await dialog.getByLabel('Folder path', { exact: true }).press('Enter');
  await expect(list.getByRole('button', { name: 'archive', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Folder path', { exact: true })).toHaveCount(0);

  // Arrow keys move through rows, Enter opens, and Backspace returns to the parent.
  await dialog.getByLabel('Filter folders', { exact: true }).press('ArrowDown');
  await expect(list.getByRole('button', { name: 'archive', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('button', { name: 'studio', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(crumbs.getByText('studio')).toHaveAttribute('aria-current', 'location');
  await expect(dialog.getByLabel('Filter folders', { exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Parent folder', exact: true }).click();
  await expect(list.getByRole('button', { name: 'archive', exact: true })).toBeVisible();
  await dialog.getByLabel('Filter folders', { exact: true }).press('ArrowDown');
  await page.keyboard.press('Backspace');
  await expect(crumbs.getByText('C:\\')).toHaveAttribute('aria-current', 'location');
  await expect(list.getByRole('button', { name: 'Users', exact: true })).toBeVisible();
  await page.keyboard.press('Control+l');
  await expect(dialog.getByLabel('Folder path', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog.getByLabel('Folder path', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(1);

  // Narrow windows keep places reachable as a strip above the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(places.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Use this folder', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/folder-browser-mobile.png', animations: 'disabled' });
  await places.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(crumbs.getByText('studio')).toHaveAttribute('aria-current', 'location');
  await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker(page, 'Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
});
