import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

// Adds a separate Claude profile in Connections, stays there, and returns its connection id.
async function addAccount(page: Page, name: string) {
  // The Connections button leaves Connections when it is already open.
  if (!(await page.getByRole('heading', { name: 'Connections', exact: true }).isVisible()))
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

test('Open sign-in waits for no account check, and says why when it cannot open', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  const card = page.locator('.fleet-account').filter({ hasText: 'Second Claude' });
  const button = card.getByRole('button', { name: 'Open sign-in', exact: true });
  const refresh = page.getByRole('button', { name: 'Refresh connections', exact: true });

  // While its check has not answered, the account can already be signed in to.
  await page.addInitScript(() => ((window as any).holdCli = ['detect_connection']));
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(card).toContainText('Checking…');
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute('title');
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as any).signInCalls)).toEqual([second]);
  await page.evaluate(() => {
    const state = window as any;
    state.holdCli = [];
    for (const request of state.pendingCli.splice(0)) request.resolve();
  });
  await expect(page.locator('.notice[role="status"]')).toContainText(
    "Claude · Second Claude is connected. You're ready to chat.",
  );

  // A check that fails says so instead of asking for the CLI, and keeps sign-in available.
  await page.evaluate(
    (id) => localStorage.setItem(`test-check-error-${id}`, 'Cannot read connection registry'),
    second,
  );
  await refresh.click();
  await expect(card).toContainText('Could not check this account');
  await expect(card).toContainText('Cannot read connection registry');
  await expect(card).not.toContainText('Install the CLI');
  await expect(card.locator('.usage-note')).toContainText(
    'Refresh Connections to check this account and read its usage.',
  );
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(() => page.evaluate(() => (window as any).signInCalls))
    .toEqual([second, second]);

  // Only a check that finds no CLI keeps sign-in closed, and the button says why.
  await page.evaluate((id) => {
    localStorage.removeItem(`test-check-error-${id}`);
    localStorage.setItem(`test-cli-missing-${id}`, 'yes');
  }, second);
  await refresh.click();
  await expect(card).toContainText('Install the CLI');
  await expect(card).toContainText(
    'claude CLI was not found. Install it, then refresh Connections.',
  );
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute(
    'title',
    'Install the Claude CLI on this computer, then refresh Connections to sign in.',
  );
  await page.screenshot({ path: 'artifacts/account-sign-in-missing-cli.png' });
  await page.evaluate((id) => localStorage.removeItem(`test-cli-missing-${id}`), second);
  await refresh.click();
  await expect(card).not.toContainText('Install the CLI');
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute('title');
});

test('the composer reads an account whose check failed as unverified, not as missing', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude · Second Claude');
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);

  await page.evaluate(
    (id) => localStorage.setItem(`test-check-error-${id}`, 'Cannot read connection registry'),
    second,
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.locator('.fleet-account').filter({ hasText: 'Second Claude' })).toContainText(
    'Could not check this account',
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const hint = page.locator('.setup-hint');
  await expect(hint).toContainText(
    "We couldn't verify your Claude connection. Open Connections to check it before sending.",
  );
  await expect(hint).not.toContainText('needs to be set up');
});

test('sign-ins open side by side, and each is followed until its account connects', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const second = await addAccount(page, 'Second Claude');
  const third = await addAccount(page, 'Third Claude');
  await page.evaluate(
    (ids) => {
      for (const id of ids) localStorage.setItem(`test-auth-connection-${id}`, 'login');
    },
    [second, third],
  );
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  const rows = [second, third].map((id) => page.locator(`[data-connection="${id}"]`));
  for (const row of rows) await expect(row).toContainText('Sign-in needed');

  // A console still opening holds back no other account's sign-in.
  await page.evaluate(() => ((window as any).holdSignIn = true));
  const buttons = rows.map((row) => row.locator('.sign-in'));
  await buttons[0].click();
  await expect(buttons[0]).toHaveText('Opening sign-in…');
  await expect(buttons[0]).toBeDisabled();
  await expect(buttons[1]).toHaveText('Open sign-in');
  await expect(buttons[1]).toBeEnabled();
  await buttons[1].click();
  await expect(buttons[1]).toHaveText('Opening sign-in…');
  await page.evaluate(() => {
    const state = window as any;
    state.holdSignIn = false;
    for (const release of state.heldSignIns.splice(0)) release();
  });
  for (const button of buttons) await expect(button).toHaveText('Open sign-in');
  expect((await page.evaluate(() => (window as any).signInCalls)).slice(-2)).toEqual([
    second,
    third,
  ]);

  // Both consoles finish, and each account is followed until it reports ready.
  await signIn(page, second);
  await signIn(page, third);
  for (const row of rows) await expect(row).not.toContainText('Sign-in needed', { timeout: 8000 });
});
