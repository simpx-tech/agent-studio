import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// Adds a separate Claude profile in Connections, stays there, and returns its connection id.
async function addAccount(page: Page, name: string) {
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return page.evaluate((name) => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === name);
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  }, name);
}

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

// The mock CLI renews a login when its usage is read. An expired one fails to renew, answers
// without limits and reports the account signed out from then on, as Claude Code does.
const expire = (page: Page, id: string) =>
  page.evaluate((id) => localStorage.setItem(`test-usage-expired-${id}`, 'yes'), id);
const signIn = (page: Page, id: string) =>
  page.evaluate((id) => {
    localStorage.removeItem(`test-usage-expired-${id}`);
    localStorage.removeItem(`test-auth-connection-${id}`);
  }, id);

test('the Agent picker shows an account whose login lapsed, and choosing it opens Connections at it', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await pick(page, 'Agent', 'Claude · Claude CLI login');
  const message = page.getByLabel('Message', { exact: true });
  await message.fill('Keep this draft');

  // Opening the picker reads the listed accounts' usage, which finds the lapsed login.
  await expire(page, second);
  await agent.click();
  const lapsed = page.getByRole('option', {
    name: 'Claude · Second Claude, Sign-in needed',
    exact: true,
  });
  await expect(lapsed).toBeVisible();
  await expect(lapsed.locator('.option-detail')).toHaveText('Sign-in needed');
  await expect(lapsed).toHaveAttribute(
    'title',
    'Choosing this account opens Connections to sign in to it',
  );
  await expect(
    page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true }),
  ).toContainText('Anthropic');
  await page.screenshot({ path: 'artifacts/account-sign-in-picker.png' });
  await lapsed.click();

  // Choosing it opens Connections at that account, with its sign-in focused.
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  const card = page.locator('.fleet-account').filter({ hasText: 'Second Claude' });
  await expect(card).toHaveClass(/highlighted/);
  await expect(page.locator('.fleet-account.highlighted')).toHaveCount(1);
  await expect(card).toBeInViewport();
  await expect(card.locator('.connection-hint.attention')).toHaveText('Sign-in needed');
  const button = card.getByRole('button', { name: 'Open sign-in', exact: true });
  await expect(button).toBeFocused();
  await page.screenshot({ path: 'artifacts/account-sign-in-connections.png' });

  // The chat kept its draft and took the account, which it asks to be signed in first.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(message).toHaveValue('Keep this draft');
  await expect(agent).toHaveText(/Claude · Second Claude/);
  await expect(page.locator('.setup-hint')).toContainText(
    'Sign in to Claude · Second Claude before sending a message.',
  );
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open Connections', exact: true }).click();
  await expect(card).toHaveClass(/highlighted/);
  await expect(button).toBeFocused();
  await button.click();
  expect(await page.evaluate(() => localStorage.getItem('test-sign-in-connection'))).toBe(second);

  // Once the account reports ready it is no longer marked, and the message can go.
  await signIn(page, second);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.notice[role="status"]')).toContainText('Claude is connected');
  await expect(card).not.toHaveClass(/highlighted/);
  await expect(card).not.toContainText('Sign-in needed');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.setup-hint')).toHaveCount(0);
  await expect(message).toHaveValue('Keep this draft');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();

  // Returning to Connections another way marks nothing.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.fleet-account.highlighted')).toHaveCount(0);
});

test('the composer names the selected account whose login lapsed and opens Connections at it', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude · Second Claude');
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();

  // Its next usage reading, on returning to the window, finds the login expired.
  await expire(page, second);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.setup-hint')).toContainText(
    'Sign in to Claude · Second Claude before sending a message.',
  );
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.getByRole('button', { name: 'Open Connections', exact: true }).click();
  const card = page.locator('.fleet-account').filter({ hasText: 'Second Claude' });
  await expect(card).toHaveClass(/highlighted/);
  await expect(card.getByRole('button', { name: 'Open sign-in', exact: true })).toBeFocused();
});

test('accounts can be signed in to while replies run in other chats', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  await page.evaluate((id) => localStorage.setItem(`test-auth-connection-${id}`, 'login'), second);
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  const card = page.locator('.fleet-account').filter({ hasText: 'Second Claude' });
  await expect(card).toContainText('Sign-in needed');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep working');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();

  // No reply holds sign-in back, on any account.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const buttons = page.getByRole('button', { name: 'Open sign-in', exact: true });
  await expect(buttons.first()).toBeVisible();
  for (const button of await buttons.all()) await expect(button).toBeEnabled();
  await card.getByRole('button', { name: 'Open sign-in', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('test-sign-in-connection'))).toBe(second);

  // The console finishes while the reply runs, and the account is followed until it is ready.
  await signIn(page, second);
  await expect(page.locator('.notice[role="status"]')).toContainText('Claude is connected', {
    timeout: 8000,
  });
  await expect(card).not.toContainText('Sign-in needed');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
});
