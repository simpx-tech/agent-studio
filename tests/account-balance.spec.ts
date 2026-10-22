import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

type Usage = { '5-hour'?: number | null; Weekly?: number | null };

// Each account reports the usage a test gives it, read again whenever the app asks.
async function prepare(page: Page) {
  await mockDesktop(page);
  await page.addInitScript(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      const own = JSON.parse(
        localStorage.getItem(`test-usage-percent-${args?.connectionId}`) ?? 'null',
      );
      if (command === 'read_usage' && own)
        for (const window of result.windows)
          if (window.label in own) window.usedPercent = own[window.label];
      return result;
    };
  });
  await page.goto('/');
}

// Adds a separate profile in Connections, stays there, and returns its connection id.
async function addAccount(page: Page, provider: 'Claude' | 'Codex', name: string) {
  // The Connections button leaves Connections when it is already open.
  if (!(await page.getByRole('heading', { name: 'Connections', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await dialog.getByRole('combobox', { name: 'Account provider' }).click();
  await page.getByRole('option', { name: provider, exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Adding opens its sign-in; an account still to sign in to takes no chats.
  const id = await connectionOf(page, name);
  const row = page
    .locator('.fleet-account')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(row).toContainText('Sign-in needed');
  await page.evaluate((id) => (window as any).finishSignIn(id, 'connected'), id);
  await expect(row).not.toContainText('Sign-in needed');
  return id;
}
const connectionOf = (page: Page, name: string) =>
  page.evaluate((name) => {
    const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
    const account = fleet.accounts.find((a: { name: string }) => a.name === name);
    return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id)
      .id as string;
  }, name);
const setUsage = (page: Page, connection: string, usage: Usage) =>
  page.evaluate(
    ([connection, usage]) => localStorage.setItem(`test-usage-percent-${connection}`, usage),
    [connection, JSON.stringify(usage)],
  );
// How often an account's usage was read.
const readings = (page: Page, connection: string) =>
  page.evaluate(
    (connection) =>
      JSON.parse(localStorage.getItem('test-usage-requests') ?? '[]').filter(
        (request: { connectionId: string }) => request.connectionId === connection,
      ).length,
    connection,
  );
// Returning to the window reads usage again; resolves once `connection` was read after it.
async function returnToWindow(page: Page, connection: string) {
  const before = await readings(page, connection);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => readings(page, connection)).toBeGreaterThan(before);
}

const agent = (page: Page) => page.getByRole('combobox', { name: 'Agent', exact: true });
const message = (page: Page) => page.getByLabel('Message', { exact: true });
const newChat = (page: Page) =>
  page.getByRole('button', { name: 'New conversation', exact: true }).click();
async function pick(page: Page, name: string) {
  await agent(page).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function send(page: Page, text: string) {
  await message(page).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
}
async function balance(page: Page, enabled = true) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const option = page.getByRole('checkbox', { name: 'Start on the least used account' });
  await option.setChecked(enabled);
  await expect(option).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).preferences);
const accountOf = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      JSON.parse(localStorage.getItem('test-workspace')!).fleet.accounts.find(
        (a: { name: string }) => a.name === name,
      ).id as string,
    name,
  );
// The accounts Settings lists under the option, each with whether new chats may start on it.
const accounts = (page: Page) => page.getByRole('group', { name: 'Accounts new chats start on' });
async function include(page: Page, name: string, included: boolean) {
  const option = accounts(page).getByRole('checkbox', { name, exact: true });
  await option.setChecked(included);
  await expect(option).toBeEnabled();
}
// Runs `act` in Settings and returns to the chat.
async function inSettings(page: Page, act: () => Promise<void>) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await act();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

// Two Claude accounts with the usage given, in a folder, with Claude as the agent of new chats.
async function twoClaudeAccounts(page: Page, login: Usage, second: Usage) {
  await prepare(page);
  const ids = {
    second: await addAccount(page, 'Claude', 'Second Claude'),
    login: await connectionOf(page, 'Claude CLI login'),
  };
  await setUsage(page, ids.login, login);
  await setUsage(page, ids.second, second);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Claude · Claude CLI login');
  return ids;
}

test('new chats start on the least used account once Settings turns that on', async ({ page }) => {
  const ids = await twoClaudeAccounts(
    page,
    { '5-hour': 20, Weekly: 80 },
    { '5-hour': 60, Weekly: 10 },
  );
  // Off unless turned on: a new chat starts with the account last chosen.
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  expect((await saved(page)).balanceAccounts).toBeUndefined();

  // The new chat that is open follows the option at once: with room on both 5-hour limits, the
  // weekly ones decide.
  await balance(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  await expect(agent(page)).toHaveAttribute('title', /^Account chosen by usage\. /);
  await expect.poll(async () => (await saved(page)).balanceAccounts).toBe(true);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  // Its welcome names the account it starts on.
  await expect(page.locator('.welcome-account')).toBeVisible();
  await expect(page.getByText('A conversation with Claude · Second Claude')).toBeVisible();

  // Each new chat reads the accounts again, so it follows what they used meanwhile: nearly out
  // of its 5-hour limit, an account gives way to one with room.
  await setUsage(page, ids.second, { '5-hour': 90, Weekly: 10 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);

  // The option is kept on this device, and the chat a start of the app opens follows it too,
  // whichever account was chosen last.
  await setUsage(page, ids.second, { '5-hour': 5, Weekly: 80 });
  await page.reload();
  await expect(agent(page)).toBeEnabled();
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  expect((await saved(page)).connectionByProvider.claude).toBe(ids.login);

  // Turned off, new chats start with the account last chosen again.
  await balance(page, false);
  await expect.poll(async () => (await saved(page)).balanceAccounts).toBeUndefined();
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await expect(agent(page)).not.toHaveAttribute('title', /chosen by usage/);
});

test('an account chosen by hand stays, and a draft keeps the account it was written under', async ({
  page,
}) => {
  const ids = await twoClaudeAccounts(
    page,
    { '5-hour': 20, Weekly: 80 },
    { '5-hour': 60, Weekly: 10 },
  );
  await balance(page);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // Choosing an account for the chat is the user's call, whatever the accounts used.
  await pick(page, 'Claude · Claude CLI login');
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await returnToWindow(page, ids.login);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await expect(agent(page)).not.toHaveAttribute('title', /chosen by usage/);

  // The next new chat is balanced again.
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // An account does not change under a draft, even once another has far more room.
  await message(page).fill('A draft written under the second account');
  await setUsage(page, ids.second, { '5-hour': 95, Weekly: 10 });
  await returnToWindow(page, ids.second);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  // Empty again, the new chat moves to the account with room.
  await message(page).fill('');
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);

  // Chat on an account's row in Connections names that account.
  await setUsage(page, ids.second, { '5-hour': 1, Weekly: 1 });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page
    .locator('.fleet-account')
    .filter({ has: page.getByRole('heading', { name: 'Claude CLI login', exact: true }) })
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await returnToWindow(page, ids.login);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
});

test('level accounts take turns, then their 5-hour limits decide', async ({ page }) => {
  const ids = await twoClaudeAccounts(
    page,
    { '5-hour': 30, Weekly: 50 },
    { '5-hour': 30, Weekly: 53 },
  );
  await balance(page);
  // Three weekly points apart is level, and neither account has answered: the first one listed.
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await send(page, 'First chat');
  // Then the account that answered longest ago, here the one that never did.
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  await send(page, 'Second chat');
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  const requests = await page.evaluate(() => localStorage.getItem('test-last-request'));
  expect(JSON.parse(requests!).agent.connectionId).toBe(ids.second);

  // Between level accounts the 5-hour limit decides before whose turn it is.
  await setUsage(page, ids.login, { '5-hour': 40, Weekly: 50 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // `/new` goes on with the same agent, on the account balancing chooses: the one that used the
  // least of its weekly limit, though more of its 5-hour one.
  await setUsage(page, ids.login, { '5-hour': 60, Weekly: 20 });
  await setUsage(page, ids.second, { '5-hour': 10, Weekly: 50 });
  await message(page).fill('/new Another idea');
  await message(page).press('Enter');
  await expect(message(page)).toHaveValue('Another idea');
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  // The account it was typed under was balancing's choice, not one of the user's to remember.
  await balance(page, false);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  expect((await saved(page)).connectionByProvider.claude).toBe(ids.login);
});

test('an account without room or to sign in to is left out', async ({ page }) => {
  const ids = await twoClaudeAccounts(
    page,
    { '5-hour': 99, Weekly: 10 },
    { '5-hour': 100, Weekly: 10 },
  );
  await balance(page);
  // A limit used up, and a weekly one whatever the 5-hour limit says.
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await setUsage(page, ids.second, { '5-hour': 0, Weekly: 100 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  // Nearly out of its 5-hour limit, an account comes after one with room, whatever their weeks.
  await setUsage(page, ids.second, { '5-hour': 0, Weekly: 99 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // An account that needs signing in cannot answer, however little it used.
  await page.evaluate(
    (id) => localStorage.setItem(`test-auth-connection-${id}`, 'login'),
    ids.second,
  );
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(
    page
      .locator('.fleet-account')
      .filter({ has: page.getByRole('heading', { name: 'Second Claude', exact: true }) }),
  ).toContainText('Sign-in needed');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
});

test('accounts without a 5-hour limit are balanced by their weekly one', async ({ page }) => {
  await prepare(page);
  const second = await addAccount(page, 'Codex', 'Second Codex');
  const login = await connectionOf(page, 'Codex CLI login');
  // Codex as this app reads most accounts: a weekly limit and no 5-hour one.
  await setUsage(page, login, { '5-hour': null, Weekly: 70 });
  await setUsage(page, second, { '5-hour': null, Weekly: 20 });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await balance(page);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Codex · Second Codex/);
  await setUsage(page, login, { '5-hour': null, Weekly: 5 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Codex · Codex CLI login/);

  // Where they report a 5-hour limit, the weekly one decides until an account is nearly out of
  // the 5-hour limit.
  await setUsage(page, login, { '5-hour': 85, Weekly: 5 });
  await setUsage(page, second, { '5-hour': 10, Weekly: 90 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Codex · Second Codex/);
  await setUsage(page, login, { '5-hour': 50, Weekly: 5 });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Codex · Codex CLI login/);
});

test('an account left out in Settings takes new chats only when chosen', async ({ page }) => {
  await prepare(page);
  const second = await addAccount(page, 'Claude', 'Second Claude');
  const third = await addAccount(page, 'Claude', 'Third Claude');
  const login = await connectionOf(page, 'Claude CLI login');
  await setUsage(page, login, { '5-hour': 60, Weekly: 10 });
  await setUsage(page, second, { '5-hour': 5, Weekly: 10 });
  await setUsage(page, third, { '5-hour': 30, Weekly: 10 });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  await pick(page, 'Claude · Claude CLI login');

  // There is nothing to leave out while new chats start with the account last chosen.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(accounts(page)).toHaveCount(0);
  const option = page.getByRole('checkbox', { name: 'Start on the least used account' });
  await option.setChecked(true);
  await expect(option).toBeEnabled();
  // Turned on, it lists the accounts it chooses between: those of an agent with several of
  // them on a computer, so neither the one Codex account nor the Gemini login.
  await expect(accounts(page).locator('label')).toHaveText([
    'Claude · Claude CLI login',
    'Claude · Second Claude',
    'Claude · Third Claude',
  ]);
  for (const box of await accounts(page).getByRole('checkbox').all())
    await expect(box).toBeChecked();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // Left out, the least used account gives the open new chat to the next one.
  await inSettings(page, () => include(page, 'Claude · Second Claude', false));
  await expect(agent(page)).toHaveText(/Claude · Third Claude/);
  expect((await saved(page)).balanceExcluded).toEqual([await accountOf(page, 'Second Claude')]);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Third Claude/);
  await expect(agent(page)).toHaveAttribute('title', /^Account chosen by usage\. /);

  // It still answers a chat it is chosen for, and only that one.
  await pick(page, 'Claude · Second Claude');
  await returnToWindow(page, second);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Third Claude/);

  // A restart keeps it out, though it is now the account last chosen.
  await page.reload();
  await expect(agent(page)).toBeEnabled();
  await expect(agent(page)).toHaveText(/Claude · Third Claude/);
  expect((await saved(page)).connectionByProvider.claude).toBe(second);

  // Taking part again, it is the least used account once more.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    accounts(page).getByRole('checkbox', { name: 'Claude · Second Claude', exact: true }),
  ).not.toBeChecked();
  await include(page, 'Claude · Second Claude', true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(async () => (await saved(page)).balanceExcluded).toBeUndefined();
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);

  // With one account left new chats start there, and with none on the account last chosen.
  await inSettings(page, async () => {
    await include(page, 'Claude · Second Claude', false);
    await include(page, 'Claude · Third Claude', false);
  });
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Claude CLI login/);
  await inSettings(page, () => include(page, 'Claude · Claude CLI login', false));
  await newChat(page);
  await expect(agent(page)).toHaveText(/Claude · Second Claude/);
  await expect(agent(page)).not.toHaveAttribute('title', /chosen by usage/);

  // Two accounts of an agent under one name are told apart by their computers.
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const laptop = { id: crypto.randomUUID(), name: 'Laptop' };
    const environment = {
      id: crypto.randomUUID(),
      computerId: laptop.id,
      name: 'Windows',
      platform: 'windows',
    };
    const added = ['Claude CLI login', 'Laptop Claude'].map((name) => ({
      id: crypto.randomUUID(),
      name,
      provider: 'claude',
      purpose: 'personal',
    }));
    workspace.fleet.computers.push(laptop);
    workspace.fleet.environments.push(environment);
    workspace.fleet.accounts.push(...added);
    workspace.fleet.connections.push(
      ...added.map((account) => ({
        id: crypto.randomUUID(),
        environmentId: environment.id,
        accountId: account.id,
        profile: 'existing',
      })),
    );
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await expect(agent(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(accounts(page).locator('label')).toHaveText([
    'Claude · Claude CLI login Desktop',
    'Claude · Second Claude',
    'Claude · Third Claude',
    'Claude · Claude CLI login Laptop',
    'Claude · Laptop Claude',
  ]);
  await expect(
    accounts(page).getByRole('checkbox', { name: 'Claude · Claude CLI login Laptop', exact: true }),
  ).toBeChecked();
  await page
    .locator('section[aria-labelledby="new-chats-heading"]')
    .screenshot({ path: 'artifacts/balance-accounts.png' });

  // Turned off, the list goes, and the accounts left out are kept for the next time.
  await option.setChecked(false);
  await expect(accounts(page)).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).balanceAccounts).toBeUndefined();
  expect((await saved(page)).balanceExcluded).toHaveLength(3);
});
