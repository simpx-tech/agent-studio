import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// A separate Claude account shares this computer's Claude directory (`linking.rs`): its folders
// link without any permission, while settings.json and CLAUDE.md wait for Windows to allow their
// links once. Connections says so, and Allow asks Windows again after a decline.
test('Connections asks Windows once to share settings and instructions with the Claude app', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('test-share-pending', '1');
    localStorage.setItem('test-share-declined', '1');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill('Second Claude');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const id = await page.evaluate(() => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === 'Second Claude');
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  });
  await page.evaluate((id) => (window as any).finishSignIn(id, 'connected'), id);
  const row = page.locator(`[data-connection="${id}"]`);
  await expect(row).toContainText('Windows asks once before this account shares settings.json');

  // Declined, the files stay the account's own, and Allow can ask again.
  const allow = row.getByRole('button', { name: 'Allow', exact: true });
  await allow.click();
  await expect(row.getByRole('alert')).toContainText("Windows' permission was declined");
  await expect(row).toContainText('Windows asks once before this account shares settings.json');

  // Allowed, the note goes with the next check.
  await page.evaluate(() => localStorage.removeItem('test-share-declined'));
  await allow.click();
  await expect(row).not.toContainText('Windows asks once');
  await expect(row.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).shareCalls)).toBe(2);
});
