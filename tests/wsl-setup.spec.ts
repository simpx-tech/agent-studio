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

test('installs a CLI missing in WSL, then adds the Desktop accounts there to sign in once', async ({
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
  await expect(claude).toContainText('Install Claude in WSL · Ubuntu to run chats in its folders');
  await page.evaluate(() => ((window as any).holdInstall = true));
  await claude.getByRole('button', { name: 'Install Claude', exact: true }).click();
  await expect(claude.getByRole('button', { name: 'Installing…' })).toBeDisabled();
  await page.evaluate(() => (window as any).releaseInstall());
  await expect(claude.locator('.installation-status')).toHaveText('Installed');
  await expect(claude.getByRole('button', { name: 'Install Claude', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).installCalls)).toEqual([
    { provider: 'claude', environmentId: ubuntu },
  ]);

  // The Desktop's Claude login is not in Ubuntu yet: one step adds it under the same name.
  const add = claude.getByRole('button', { name: /^Add .+ here$/ });
  await expect(add).toBeVisible();
  await page.screenshot({ path: 'artifacts/wsl-setup-connections.png', animations: 'disabled' });
  await add.click();
  await expect(add).toHaveCount(0);
  await expect(claude.getByText('Sign in as me@example.com', { exact: false })).toBeVisible();
  const workspace = await saved(page);
  const provider = (accountId: string) =>
    workspace.fleet.accounts.find((a: any) => a.id === accountId)?.provider;
  const desktopClaude = workspace.fleet.connections.find(
    (c: any) => c.environmentId === windows && provider(c.accountId) === 'claude',
  );
  const added = workspace.fleet.connections.find(
    (c: any) => c.environmentId === ubuntu && c.accountId === desktopClaude.accountId,
  );
  expect(added).toMatchObject({ profile: 'isolated' });
  // Sign-in opens for that profile in Ubuntu, never by copying the Desktop's login.
  const row = claude.locator(`[data-connection="${added.id}"]`);
  await expect(row).toContainText('Sign-in needed');
  await row.getByRole('button', { name: 'Open sign-in' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).signInCalls)).toEqual([added.id]);
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
