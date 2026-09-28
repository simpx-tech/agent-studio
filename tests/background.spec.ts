import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

async function openSettings(page: Page, behavior?: object) {
  await mockDesktop(page);
  if (behavior)
    await page.addInitScript((value) => {
      if (!localStorage.getItem('test-window-behavior'))
        localStorage.setItem('test-window-behavior', value);
    }, JSON.stringify(behavior));
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('region', { name: 'Background', exact: true });
}

test('closing the window keeps Agent Studio in the tray until turned off on this computer', async ({
  page,
}) => {
  const section = await openSettings(page);
  const keep = section.getByRole('checkbox', {
    name: 'Keep running in the system tray when the window closes',
  });
  await expect(keep).toBeChecked();
  await expect(section.getByRole('status')).toHaveText(
    'Closing the window keeps Agent Studio in the system tray. Click its icon to open the window again, or right-click it and choose Quit Agent Studio.',
  );
  await keep.uncheck();
  await expect(section.getByRole('status')).toHaveText(
    'Closing the window quits Agent Studio and stops its replies.',
  );
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-window-behavior')!)),
  ).toMatchObject({ closeToTray: false });
  // The choice belongs to this computer and outlives the window.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(keep).not.toBeChecked();
  await keep.check();
  await expect(keep).toBeChecked();
  await expect(section.getByRole('status')).toContainText('keeps Agent Studio in the system tray');

  // A choice that could not be saved leaves the switch as it was.
  await page.evaluate(() =>
    localStorage.setItem('test-window-behavior-error', 'Cannot save the tray setting'),
  );
  await keep.click();
  await expect(section.getByRole('alert')).toHaveText('Cannot save the tray setting');
  await expect(keep).toBeChecked();
  await expect(section.getByRole('status')).toContainText('keeps Agent Studio in the system tray');
});

test('a computer without a tray explains that closing quits, and macOS names the menu bar', async ({
  page,
}) => {
  const reason =
    'This computer has no AppIndicator library for a tray icon, so closing the window quits Agent Studio. Install libayatana-appindicator3 to keep it running.';
  const section = await openSettings(page, {
    closeToTray: true,
    area: 'tray',
    clickOpens: false,
    unavailable: reason,
  });
  const keep = section.getByRole('checkbox', {
    name: 'Keep running in the system tray when the window closes',
  });
  await expect(keep).toBeDisabled();
  await expect(keep).not.toBeChecked();
  await expect(section.getByRole('status')).toHaveText(reason);

  await page.evaluate(() =>
    localStorage.setItem(
      'test-window-behavior',
      JSON.stringify({ closeToTray: true, area: 'menuBar', clickOpens: false }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    section.getByRole('checkbox', { name: 'Keep running in the menu bar when the window closes' }),
  ).toBeChecked();
  await expect(section.getByRole('status')).toContainText(
    'Open the window from the Dock or the menu bar icon',
  );
});
