import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

const windows = '11111111-1111-4111-8111-111111111111';
const ubuntu = '33333333-3333-4333-8333-333333333333';
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));

async function claudeOnUbuntu(page: Page) {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  return page
    .getByRole('article', { name: 'WSL · Ubuntu computer' })
    .getByRole('article', { name: 'Claude connections' });
}

test('installs a CLI missing in WSL, where the Desktop accounts join and sign in once', async ({
  page,
}) => {
  await mockDesktop(page, 'computer-routing');
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('test-account-claude', 'me@example.com');
    localStorage.setItem('test-auth-wsl-claude', 'login');
  });
  await page.goto('/');
  const claude = await claudeOnUbuntu(page);
  await expect(claude.locator('.installation-status')).toHaveText('Not installed');
  await page.evaluate(() => ((window as any).holdInstall = true));
  await claude.getByRole('button', { name: 'Install Claude', exact: true }).click();
  await expect(claude.getByRole('button', { name: 'Installing…' })).toBeDisabled();
  await page.evaluate(() => (window as any).releaseInstall());
  await expect(claude.locator('.installation-status')).toHaveText('Installed');
  await expect(claude.getByRole('button', { name: 'Install Claude', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).installCalls)).toEqual([
    { provider: 'claude', environmentId: ubuntu },
  ]);

  // The Desktop's Claude account joins Ubuntu by itself, under the same name, as a separate
  // profile that signs in once there through Claude Code's own login: the Windows login is never
  // lent to it.
  const workspace = await saved(page);
  const provider = (accountId: string) =>
    workspace.fleet.accounts.find((a: any) => a.id === accountId)?.provider;
  const desktopClaude = workspace.fleet.connections.find(
    (c: any) => c.environmentId === windows && provider(c.accountId) === 'claude',
  );
  const added = workspace.fleet.connections.filter(
    (c: any) => c.environmentId === ubuntu && provider(c.accountId) === 'claude',
  );
  // It is the only Claude account there: Ubuntu's own signed-out login does not join beside it.
  expect(added).toEqual([expect.objectContaining({ accountId: desktopClaude.accountId })]);
  expect(added[0]).toMatchObject({ profile: 'isolated' });
  const row = claude.locator(`[data-connection="${added[0].id}"]`);
  await expect(row).toContainText('Sign-in needed');
  await expect(claude.getByRole('button', { name: /^Add .+ here$/ })).toHaveCount(0);
  await row.getByRole('button', { name: 'Open sign-in' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).signInCalls))
    .toEqual([added[0].id]);
  const connected = (id: string) =>
    page.evaluate((id) => {
      localStorage.setItem(`test-auth-connection-${id}`, 'ready');
      (window as any).finishSignIn(id, 'connected');
    }, id);
  await connected(added[0].id);
  // Connected: no status or sign-in line under the account.
  await expect(row.locator('.connection-hint')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/wsl-setup-connections.png', animations: 'disabled' });

  // Removed there, it stays removed through later refreshes.
  await claude.getByRole('button', { name: 'Manage account' }).click();
  const management = page.getByRole('dialog', { name: 'Manage account', exact: true });
  await management.getByRole('button', { name: 'Disconnect account' }).click();
  await management.getByRole('button', { name: 'Remove connection' }).click();
  await expect(management).toHaveCount(0);
  await expect(claude.locator('.fleet-account')).toHaveCount(0);
  const refresh = page.getByRole('button', { name: 'Refresh connections', exact: true });
  const refreshed = async () => {
    await page.evaluate(() => ((window as any).holdCli = ['detect_connection']));
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await page.evaluate(() => {
      const state = window as any;
      state.holdCli = [];
      for (const request of (state.pendingCli ?? []).splice(0)) request.resolve();
    });
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  };
  await refreshed();
  await expect(claude.locator('.fleet-account')).toHaveCount(0);
  await expect(claude.getByRole('button', { name: 'Add account', exact: true })).toBeVisible();

  // Manage account on Desktop brings it back on request, and it signs in there again.
  await page
    .getByRole('article', { name: 'Desktop computer' })
    .getByRole('article', { name: 'Claude connections' })
    .getByRole('button', { name: 'Manage account' })
    .click();
  await management.getByRole('button', { name: 'Connect on WSL · Ubuntu', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const again = (await saved(page)).fleet.connections.find(
    (c: any) => c.environmentId === ubuntu && c.accountId === desktopClaude.accountId,
  );
  expect(again).toMatchObject({ profile: 'isolated' });
  await expect
    .poll(() => page.evaluate(() => (window as any).signInCalls))
    .toEqual([added[0].id, again.id]);
  await connected(again.id);
  const back = claude.locator(`[data-connection="${again.id}"]`);
  await expect(back.locator('.connection-hint')).toHaveCount(0);

  // Its login is its own: the Windows login signing out leaves Ubuntu's alone.
  await page.evaluate(
    (id) => localStorage.setItem(`test-auth-connection-${id}`, 'login'),
    desktopClaude.id,
  );
  await refreshed();
  await expect(back.locator('.connection-hint')).toHaveCount(0);
  await expect(back).not.toContainText('Sign-in needed');
});

test('an installer failure says why and can be tried again', async ({ page }) => {
  await mockDesktop(page, 'computer-routing');
  await page.addInitScript(() =>
    localStorage.setItem(
      'test-install-error',
      'curl is not installed in this distribution. Install it with its package manager, then try again.',
    ),
  );
  await page.goto('/');
  const claude = await claudeOnUbuntu(page);
  await claude.getByRole('button', { name: 'Install Claude', exact: true }).click();
  await expect(claude).toContainText('curl is not installed in this distribution.');
  await expect(claude.locator('.installation-status')).toHaveText('Not installed');
  await page.evaluate(() => localStorage.removeItem('test-install-error'));
  await claude.getByRole('button', { name: 'Install Claude', exact: true }).click();
  await expect(claude.locator('.installation-status')).toHaveText('Installed');
});
