import { test, expect, type Page } from '@playwright/test';
import { chooseTestFolder } from './folder-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server';

async function host(page: Page, relay: string, token: string, name: string, platform: string) {
  const identity = { id: crypto.randomUUID(), computerId: crypto.randomUUID(), name, platform };
  await page.exposeFunction('relayBridge', async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${relay}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': identity.id,
        'content-type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  });
  await page.addInitScript(
    ({ identity }) => {
      const w = window as any;
      w.isTauri = true;
      let next = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      let finish: (() => void) | undefined;
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(fn: (value: unknown) => void) {
          const id = ++next;
          callbacks.set(id, fn);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: any) {
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:event|listen') return 0;
          if (command === 'plugin:event|unlisten') return;
          if (command === 'get_installation') return identity;
          if (command === 'read_context') {
            localStorage.setItem('fixture-context', JSON.stringify(args));
            return {
              provider: args.provider,
              model: args.model,
              checkedAt: Date.now(),
              execution: identity.name,
              folder: args.location.path,
              profile: '/profiles/selected',
              entries: [],
              notes: ['Inspected on the owning host.'],
              truncated: false,
            };
          }
          if (command === 'list_folders') {
            localStorage.setItem('fixture-folders', JSON.stringify(args));
            return {
              path:
                args.path ||
                (identity.platform === 'windows' && args.environmentId === identity.id
                  ? 'C:\\Projects\\studio'
                  : '/home/test/studio'),
              parent: null,
              entries: [],
              truncated: false,
            };
          }
          if (command === 'discover_wsl') {
            if (localStorage.getItem('fixture-wsl-error'))
              throw new Error('Synthetic WSL discovery failure');
            return JSON.parse(
              localStorage.getItem('fixture-wsl') ?? '{"distributions":[],"warning":null}',
            );
          }
          if (command === 'load_workspace')
            return JSON.parse(localStorage.getItem('fixture-workspace') ?? 'null');
          if (command === 'save_workspace') {
            localStorage.setItem('fixture-workspace', JSON.stringify(args.workspace));
            return;
          }
          if (command === 'load_sync_state')
            return JSON.parse(localStorage.getItem('fixture-sync') ?? 'null');
          if (command === 'save_sync_state') {
            localStorage.setItem('fixture-sync', JSON.stringify(args.value));
            return;
          }
          if (command === 'relay_connect' || command === 'relay_disconnect') return;
          if (command === 'relay_request') return w.relayBridge(args.method, args.path, args.body);
          const status = (id: string) => ({
            id,
            installed: true,
            auth: 'ready',
            version: 'Synthetic CLI',
            detail: 'Verified fixture',
          });
          if (command === 'detect_providers') return ['codex', 'claude', 'gemini'].map(status);
          if (command === 'detect_connection') return status(args.provider);
          if (command === 'list_models')
            return Object.fromEntries(
              ['codex', 'claude', 'gemini'].map((id) => [
                id,
                [{ id: '', name: 'CLI default', reasoningLevels: [], defaultReasoning: '' }],
              ]),
            );
          if (command === 'read_usage') {
            localStorage.setItem('fixture-usage', JSON.stringify(args));
            return {
              provider: args.provider,
              checkedAt: Date.now() / 1000,
              windows: [],
              context: null,
              detail: 'Fixture',
            };
          }
          if (command === 'generate_title') throw new Error('Synthetic title unavailable');
          if (command === 'cancel_title') return;
          if (command === 'sign_in') {
            localStorage.setItem('fixture-login', JSON.stringify(args));
            return;
          }
          if (command === 'cancel_run') {
            finish?.();
            return;
          }
          if (command === 'run_agent') {
            localStorage.setItem('fixture-run', JSON.stringify(args.request));
            localStorage.setItem('fixture-run-connection', args.connectionId ?? '');
            let index = 0;
            const emit = (message: unknown) =>
              callbacks.get(args.onEvent.id)?.({ message, index: index++ });
            emit({ kind: 'activity', text: `Running on ${identity.name}` });
            emit({
              kind: 'progress',
              id: 'inspection',
              revision: 1,
              text: 'Checking the remote sources.',
            });
            emit({ kind: 'text', text: `Response from ${identity.name}` });
            for (const id of ['search-one', 'search-two'])
              emit({
                kind: 'tool',
                tool: {
                  id,
                  revision: 1,
                  category: 'search',
                  name: 'Web search',
                  query: `Query ${id}`,
                  status: 'running',
                  sources: [],
                  agents: [],
                },
              });
            if (localStorage.getItem('fixture-slow')) {
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              return 'cancelled';
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            emit({
              kind: 'progress',
              id: 'inspection',
              revision: 2,
              text: 'Checked both remote sources.',
            });
            for (const id of ['search-one', 'search-two'])
              emit({
                kind: 'tool',
                tool: {
                  id,
                  revision: 2,
                  category: 'search',
                  name: 'Web search',
                  query: `Query ${id}`,
                  status: 'complete',
                  sources: [{ title: 'Fixture source', url: 'https://example.com' }],
                  agents: [],
                },
              });
            emit({ kind: 'text', text: `Response from ${identity.name}, completed.` });
            emit({ kind: 'usage', input: 2400, output: 50, costUsd: 0.012345 });
            return 'complete';
          }
          throw new Error(`Unexpected fixture command ${command}`);
        },
      };
    },
    { identity },
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  return identity;
}
test('each computer groups its accounts and locations with contextual settings', async ({
  page,
}) => {
  const distroId = crypto.randomUUID();
  await page.addInitScript(
    ({ distroId }) =>
      localStorage.setItem(
        'fixture-wsl',
        JSON.stringify({
          distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
          warning: null,
        }),
      ),
    { distroId },
  );
  await host(page, '', '', 'Desktop', 'windows');
  await expect(page.locator('.provider-group')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Claude', exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Computer name', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Account name', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Relay URL')).toHaveCount(0);
  await expect(page.locator('.provider-setup[open]')).toHaveCount(0);
  const claude = page.getByRole('article', { name: 'Claude connections', exact: true });
  await claude.getByRole('button', { name: 'Name this account' }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Connect an account');
  await expect(page.getByRole('combobox', { name: 'Account provider' })).toHaveText('Claude');
  await expect(page.getByRole('combobox', { name: 'Login profile' })).toHaveText(
    'Use the existing CLI login',
  );
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Personal 1');
  await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  const personal = claude.locator('.fleet-account').filter({ hasText: 'Personal 1' });
  await expect(personal).toHaveCount(1);
  await expect(claude.locator('.current-login')).toHaveCount(0);
  await personal.getByRole('button', { name: 'Manage account' }).click();
  await personal.getByRole('button', { name: 'Connect on another environment' }).click();
  await expect(page.getByRole('combobox', { name: 'Account to connect' })).toHaveText('Personal 1');
  await page.getByRole('combobox', { name: 'Connection environment' }).click();
  await page.getByRole('option', { name: 'WSL · Ubuntu', exact: true }).click();
  await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect(personal.locator('.account-connection')).toHaveCount(2);
  await personal.getByRole('button', { name: 'Manage account' }).click();
  for (const [name, purpose] of [
    ['Personal 2', 'Personal'],
    ['Company', 'Work'],
  ]) {
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    await page.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
    await page.getByRole('combobox', { name: 'Account purpose', exact: true }).click();
    await page.getByRole('option', { name: purpose, exact: true }).click();
    await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  }
  await expect(claude.locator('.fleet-account')).toHaveCount(3);
  await expect(claude.getByRole('heading', { name: 'Personal 1', exact: true })).toHaveCount(1);
  await expect(claude).toContainText('3 accounts');
  await page.screenshot({ path: 'artifacts/connections-organized-browser.png' });

  const manage = page.getByRole('button', { name: 'Manage computer Desktop', exact: true });
  await manage.click();
  await page.getByRole('textbox', { name: 'Computer name', exact: true }).fill('Discarded name');
  await page.getByRole('dialog').press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(manage).toBeFocused();
  await expect(page.locator('.fleet-computer')).toContainText('Desktop');
  await manage.click();
  await page.getByRole('textbox', { name: 'Computer name', exact: true }).fill('Home desktop');
  await page.getByRole('button', { name: 'Save computer', exact: true }).click();
  await expect(
    page
      .getByRole('article', { name: 'Home desktop computer', exact: true })
      .locator('.fleet-account')
      .filter({ hasText: 'Personal 1' }),
  ).toContainText('Windows');
  await expect(personal).toContainText('WSL · Ubuntu');
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home desktop', exact: true })).toBeVisible();
  await expect(claude.locator('.fleet-account')).toHaveCount(3);
  await page.setViewportSize({ width: 840, height: 640 });
  await expect(page.getByRole('button', { name: 'Add account', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/connections-organized-narrow.png' });
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const profile = page.getByRole('combobox', { name: 'Login profile' });
  await profile.click();
  await page.getByRole('option', { name: 'Use the existing CLI login' }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Duplicate CLI');
  await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already has');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(claude.locator('.fleet-account')).toHaveCount(3);
  await expect(page.locator('select')).toHaveCount(0);
});

test('computer cards keep local and remote accounts separate and explain both login methods', async ({
  page,
}) => {
  const identity = await host(page, '', '', 'Desktop', 'windows');
  await page.evaluate(
    ({ identity }) => {
      const workspace = JSON.parse(localStorage.getItem('fixture-workspace')!);
      const computer = crypto.randomUUID(),
        environment = crypto.randomUUID();
      const shared = crypto.randomUUID(),
        remote = crypto.randomUUID(),
        unused = crypto.randomUUID();
      workspace.fleet.computers.push({ id: computer, name: 'MacBook' });
      workspace.fleet.environments.push({
        id: environment,
        computerId: computer,
        name: 'macOS',
        platform: 'macos',
      });
      workspace.fleet.accounts.push(
        { id: shared, name: 'Personal', purpose: 'personal', provider: 'claude' },
        { id: remote, name: 'Company', purpose: 'work', provider: 'claude' },
        { id: unused, name: 'Unused', purpose: 'personal', provider: 'codex' },
      );
      workspace.fleet.connections.push(
        {
          id: crypto.randomUUID(),
          accountId: shared,
          environmentId: identity.id,
          profile: 'existing',
        },
        {
          id: crypto.randomUUID(),
          accountId: shared,
          environmentId: environment,
          profile: 'existing',
        },
        {
          id: crypto.randomUUID(),
          accountId: remote,
          environmentId: environment,
          profile: 'isolated',
        },
      );
      localStorage.setItem('fixture-workspace', JSON.stringify(workspace));
    },
    { identity },
  );
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const local = page.getByRole('article', { name: 'Desktop computer', exact: true });
  const remote = page.getByRole('article', { name: 'MacBook computer', exact: true });
  await expect(page.locator('.fleet-computer')).toHaveCount(2);
  await expect(local.locator('.provider-group')).toHaveCount(3);
  await expect(local.getByRole('heading', { name: 'Personal', exact: true })).toHaveCount(1);
  await expect(local.getByRole('heading', { name: 'Company', exact: true })).toHaveCount(0);
  await expect(remote.getByRole('heading', { name: 'Personal', exact: true })).toHaveCount(1);
  await expect(remote.getByRole('heading', { name: 'Company', exact: true })).toHaveCount(1);
  await expect(remote.locator('.computer-state')).toHaveText('Offline');
  await expect(remote.getByRole('button', { name: 'Open sign-in', exact: true })).toHaveCount(0);
  await expect(remote.getByRole('button', { name: 'Add account', exact: true })).toHaveCount(0);
  await expect(local.locator('.account-connection')).toContainText('Windows');
  await expect(remote.locator('.account-connection').first()).toContainText('macOS');
  await page.screenshot({
    path: 'artifacts/connections-computer-list-browser.png',
    fullPage: true,
  });

  await remote
    .locator('.fleet-account')
    .filter({ hasText: 'Personal' })
    .getByRole('button', { name: 'Manage account', exact: true })
    .click();
  await expect(page.getByRole('textbox', { name: 'Edit account name', exact: true })).toHaveCount(
    1,
  );
  await page
    .getByRole('textbox', { name: 'Edit account name', exact: true })
    .fill('Shared personal');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(local.getByRole('heading', { name: 'Shared personal', exact: true })).toBeVisible();
  await expect(remote.getByRole('heading', { name: 'Shared personal', exact: true })).toBeVisible();
  await remote
    .locator('.fleet-account')
    .filter({ hasText: 'Company' })
    .getByRole('button', { name: 'Manage account', exact: true })
    .click();
  await page.getByRole('button', { name: 'Connect on this computer', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Connect an account on Desktop');
  await expect(page.getByRole('combobox', { name: 'Account to connect' })).toHaveText('Company');
  const explanation = page.getByRole('note', { name: 'How this login works' });
  await expect(explanation).toContainText('same installed CLI');
  await expect(explanation).toContainText('without changing the account you use in your terminal');
  const profile = page.getByRole('combobox', { name: 'Login profile' });
  await profile.click();
  await page.getByRole('option', { name: 'Use the existing CLI login' }).click();
  await expect(explanation).toContainText(
    'Signing out or switching that CLI’s account also changes this connection',
  );
  await expect(explanation).toContainText('never provider logins');
  await page.getByRole('combobox', { name: 'Connection environment' }).click();
  await expect(page.getByRole('option', { name: 'macOS', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Connection environment' }).press('Escape');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('Accounts without a computer', { exact: false }).click();
  const unused = page.locator('.unassigned-accounts .fleet-account');
  await expect(unused).toContainText('Unused');
  await expect(unused).toContainText('Codex');
  await unused.getByRole('button', { name: 'Manage account', exact: true }).click();
  await unused.getByRole('button', { name: 'Remove account label' }).click();
  await expect(page.locator('.unassigned-accounts')).toHaveCount(0);
  await expect(local.locator('.fleet-account')).toHaveCount(1);
  await expect(remote.locator('.fleet-account')).toHaveCount(2);
});

test('Windows discovers WSL automatically and management forms use accessible design-system pickers', async ({
  page,
}) => {
  const ubuntu = crypto.randomUUID(),
    debian = crypto.randomUUID();
  await page.addInitScript(
    ({ ubuntu, debian }) => {
      if (!localStorage.getItem('fixture-wsl'))
        localStorage.setItem(
          'fixture-wsl',
          JSON.stringify({
            distributions: [
              { id: ubuntu, name: 'Ubuntu', running: true },
              { id: debian, name: 'Debian', running: false },
            ],
            warning: null,
          }),
        );
    },
    { ubuntu, debian },
  );
  await host(page, '', '', 'Desktop', 'windows');
  const ubuntuRow = page.locator('.environment-row').filter({ hasText: 'WSL · Ubuntu' });
  const debianRow = page.locator('.environment-row').filter({ hasText: 'WSL · Debian' });
  await expect(ubuntuRow).toContainText('Automatically detected');
  await expect(ubuntuRow).toContainText('WSL running');
  await expect(ubuntuRow).toContainText('Managed here');
  await expect(debianRow).toContainText('WSL stopped');
  await expect(page.locator('.fleet-computer')).toHaveCount(1);
  await expect(page.locator('select')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.locator('.environment-row')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/wsl-discovery-browser.png' });

  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const purpose = page.getByRole('combobox', { name: 'Account purpose', exact: true });
  await purpose.focus();
  await purpose.press('End');
  await purpose.press('Enter');
  await expect(purpose).toHaveText('Work');
  const provider = page.getByRole('combobox', { name: 'Account provider' });
  await provider.click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Codex work');
  const profile = page.getByRole('combobox', { name: 'Login profile' });
  await profile.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: 'artifacts/fleet-design-system-picker.png' });
  await page.getByRole('option', { name: 'Use the existing CLI login' }).click();
  await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Codex work' })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!));
  expect(saved.fleet.accounts[0]).toMatchObject({ provider: 'codex', purpose: 'work' });
  expect(saved.fleet.connections[0].profile).toBe('existing');
  await page.getByRole('button', { name: 'Manage account' }).click();
  await page.getByRole('combobox', { name: 'Edit account purpose' }).click();
  await page.getByRole('option', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Save account' }).click();
  await expect(page.locator('.fleet-account-heading')).toContainText('Personal');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByRole('combobox', { name: 'Account to connect' }).click();
  await page.getByRole('option', { name: 'Codex work', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Account provider' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Manage computer Desktop' }).click();
  await page.getByText('Advanced: group environments', { exact: true }).click();
  const group = page.getByRole('combobox', { name: 'Group this environment under' });
  await group.click();
  await group.press('Escape');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.evaluate(() => localStorage.setItem('fixture-wsl-error', 'yes'));
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic WSL discovery failure');
  await expect(ubuntuRow).toContainText('WSL state unavailable');
  await expect(page.locator('.environment-row')).toHaveCount(3);
  await page.evaluate(() => {
    localStorage.removeItem('fixture-wsl-error');
    const value = JSON.parse(localStorage.getItem('fixture-wsl')!);
    value.distributions[0].running = false;
    localStorage.setItem('fixture-wsl', JSON.stringify(value));
  });
  await page.getByRole('button', { name: 'Refresh connections', exact: true }).click();
  await expect(ubuntuRow).toContainText('WSL stopped');
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.locator('.environment-row')).toHaveCount(3);
  await expect(ubuntuRow).toContainText('WSL stopped');
  await expect(page.locator('select')).toHaveCount(0);
});

test('one Windows app signs in, runs, and stops a WSL account without pairing a relay', async ({
  page,
}) => {
  const distroId = crypto.randomUUID();
  await page.addInitScript(
    ({ distroId }) =>
      localStorage.setItem(
        'fixture-wsl',
        JSON.stringify({
          distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
          warning: null,
        }),
      ),
    { distroId },
  );
  const identity = await host(page, '', '', 'Desktop', 'windows');
  await expect(
    page.locator('.sidebar-tools').getByRole('button', { name: 'Connections', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Computers & accounts', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: 'Claude', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Your computers', exact: true })).toBeVisible();
  await expect(
    page.getByText('Open Agent Studio in Ubuntu and pair its relay to connect.'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  await page.getByRole('combobox', { name: 'Connection environment' }).click();
  await page.getByRole('option', { name: 'WSL · Ubuntu', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Claude in Ubuntu');
  await page.getByRole('button', { name: 'Connect account', exact: true }).click();
  const account = page.locator('.fleet-account').filter({ hasText: 'Claude in Ubuntu' });
  await expect(account).toContainText('Connected');
  await account.getByRole('button', { name: 'Manage account' }).click();
  await account.getByRole('button', { name: 'Open sign-in', exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-workspace')!));
  const connection = saved.fleet.connections[0];
  expect(connection.environmentId).toBe(distroId);
  expect(connection.environmentId).not.toBe(identity.id);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-login')!)),
  ).toMatchObject({ provider: 'claude', connectionId: connection.id });
  await account.getByRole('button', { name: 'Chat', exact: true }).click();
  await chooseTestFolder(page);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Run through Windows into Ubuntu');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  expect(await page.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
    connection.id,
  );
  await expect(page.getByTestId('message').last().locator('.message-execution')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0].messages.at(-1)
          .executionLabel,
    ),
  ).toContain('WSL · Ubuntu');
  await page.evaluate(() => localStorage.setItem('fixture-slow', 'yes'));
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Stop the Linux process');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toContainText('Response from Desktop');
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'cancelled');
});

test('a remote computer reaches a WSL account through the paired Windows host', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-wsl-relay-'));
  const token = 'synthetic-wsl-relay-key-for-browser-checks-123';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const windows = await a.newPage(),
      mac = await b.newPage();
    const distroId = crypto.randomUUID();
    await windows.addInitScript(
      ({ distroId }) =>
        localStorage.setItem(
          'fixture-wsl',
          JSON.stringify({
            distributions: [{ id: distroId, name: 'Ubuntu', running: true }],
            warning: null,
          }),
        ),
      { distroId },
    );
    await host(windows, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    await windows.getByRole('button', { name: 'Add account', exact: true }).click();
    await windows.getByRole('combobox', { name: 'Connection environment' }).click();
    await windows.getByRole('option', { name: 'WSL · Ubuntu', exact: true }).click();
    await windows
      .getByRole('textbox', { name: 'Account name', exact: true })
      .fill('Claude WSL shared');
    await windows.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(windows.locator('.fleet-account')).toContainText('Connected');
    for (const page of [windows, mac]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL').fill(url);
      await page.getByLabel('Relay pairing key').fill(token);
      await page.getByRole('button', { name: 'Pair & sync' }).click();
      await expect(page.locator('.fleet-relay .connection-badge')).toContainText('Paired', {
        timeout: 15_000,
      });
    }
    const account = mac.locator('.fleet-account').filter({ hasText: 'Claude WSL shared' });
    await expect(account).toContainText('Connected', { timeout: 15_000 });
    await account.getByRole('button', { name: 'Chat', exact: true }).click();
    await chooseTestFolder(mac);
    await mac
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Reach Ubuntu through Windows');
    await mac.getByRole('button', { name: 'Send message' }).click();
    await expect(mac.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 20_000,
    });
    await expect(mac.getByTestId('message').last()).toContainText('Response from Desktop');
    const saved = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-workspace')!),
    );
    const connection = saved.fleet.connections.find(
      (c: { environmentId: string }) => c.environmentId === distroId,
    );
    expect(await windows.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection.id,
    );
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
    const firstRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-run')!),
    );
    await mac.getByRole('button', { name: 'Model context', exact: true }).click();
    await expect(mac.getByRole('dialog')).toContainText('Inspected on the owning host.', {
      timeout: 20_000,
    });
    const contextRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-context')!),
    );
    expect(contextRequest.connectionId).toBe(connection.id);
    expect(contextRequest.location).toEqual(firstRequest.location);
    expect(await mac.evaluate(() => localStorage.getItem('fixture-context'))).toBeNull();
    await mac.getByRole('button', { name: 'Close model context' }).click();
    await mac.getByRole('button', { name: 'New conversation', exact: true }).click();
    await mac.getByRole('combobox', { name: 'Computer', exact: true }).click();
    await mac.getByRole('option', { name: 'MacBook', exact: true }).click();
    await mac.locator('#conversation-panel-active .folder-new-chat').click();
    await expect(mac.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
      'Desktop',
    );
    await expect(mac.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
      'title',
      firstRequest.location.path,
    );
    await expect(mac.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
    await mac
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Start another conversation in this remote folder');
    await mac.getByRole('button', { name: 'Send message' }).click();
    await expect(mac.getByTestId('message').last()).toHaveAttribute('data-status', 'complete', {
      timeout: 20_000,
    });
    const folderRequest = await windows.evaluate(() =>
      JSON.parse(localStorage.getItem('fixture-run')!),
    );
    expect(folderRequest.runId).not.toBe(firstRequest.runId);
    expect(folderRequest.location).toEqual(firstRequest.location);
    expect(await windows.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection.id,
    );
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two app environments pair, share accounts, route chats, retain progress and cancel on the owning host', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-e2e-'));
  const token = 'synthetic-relay-key-for-browser-checks-123456';
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    const desktop = await a.newPage(),
      mac = await b.newPage();
    await host(desktop, url, token, 'Desktop', 'windows');
    await host(mac, url, token, 'MacBook', 'macos');
    await mac.getByRole('button', { name: 'Add account', exact: true }).click();
    await mac.getByLabel('Account name', { exact: true }).fill('Claude personal 1');
    await mac.getByRole('button', { name: 'Connect account', exact: true }).click();
    await expect(mac.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    await mac.locator('.fleet-account').getByRole('button', { name: 'Manage account' }).click();
    await mac
      .locator('.fleet-account')
      .getByRole('button', { name: 'Open sign-in', exact: true })
      .click();
    const connection = await mac.evaluate(
      () => JSON.parse(localStorage.getItem('fixture-login')!).connectionId,
    );
    expect(connection).toBeTruthy();
    for (const page of [mac, desktop]) {
      await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
      await page.getByLabel('Relay URL', { exact: true }).fill(url);
      await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
      await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 15_000 });
    }
    await expect(desktop.getByRole('heading', { name: 'MacBook', exact: true })).toBeVisible();
    await expect(desktop.getByRole('heading', { name: 'Claude personal 1' })).toBeVisible();
    await desktop.getByRole('button', { name: 'Chat', exact: true }).click();
    await chooseTestFolder(desktop);
    await expect(desktop.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
      'MacBook',
    );
    await expect(desktop.getByRole('combobox', { name: 'Account and environment' })).toHaveCount(0);
    await desktop.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await desktop.getByRole('option', { name: 'Claude · Claude personal 1', exact: true }).click();
    await desktop
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Hello from another computer');
    await expect(desktop.getByRole('button', { name: 'Send message' })).toBeEnabled({
      timeout: 15_000,
    });
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(
      desktop.getByTestId('message').filter({ hasText: 'Response from MacBook, completed.' }),
    ).toHaveAttribute('data-status', 'complete', { timeout: 20_000 });
    expect(await desktop.evaluate(() => localStorage.getItem('fixture-run'))).toBeNull();
    await expect(desktop.locator('.activity-summary')).not.toHaveAttribute('open', '');
    await expect(desktop.getByLabel('Reply usage and cost')).toContainText(
      '$0.012345 estimated cost',
    );
    await desktop.getByLabel('Activity summary', { exact: true }).click();
    await expect(desktop.getByText('Checked both remote sources.', { exact: true })).toBeVisible();
    await expect(desktop.getByText('Checking the remote sources.', { exact: true })).toHaveCount(0);
    await expect(desktop.locator('[data-category="search"]')).toHaveCount(2);
    for (const card of await desktop.locator('[data-category="search"]').all())
      await expect(card).toContainText('Completed');
    await expect
      .poll(() =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!)
              .conversations[0]?.messages.at(-1)
              ?.blocks.filter(
                (b: any) => b.tool?.category === 'search' && b.tool.status === 'complete',
              ).length,
        ),
      )
      .toBe(2);
    expect(await mac.evaluate(() => localStorage.getItem('fixture-run-connection'))).toBe(
      connection,
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0]?.messages.at(-1)
              ?.status,
        ),
      )
      .toBe('complete');
    expect(
      await mac.evaluate(
        () =>
          JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0].messages.at(-1)
            .usage.costUsd,
      ),
    ).toBe(0.012345);
    await expect
      .poll(async () =>
        desktop.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await mac.evaluate(() => localStorage.setItem('fixture-slow', 'true'));
    await desktop.getByRole('textbox', { name: 'Message', exact: true }).fill('A response to stop');
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(desktop.getByTestId('message').last()).toContainText('Response from MacBook', {
      timeout: 20_000,
    });
    await desktop.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect(desktop.getByTestId('message').last()).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 15_000 },
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () =>
            JSON.parse(localStorage.getItem('fixture-workspace')!).conversations[0]?.messages.at(-1)
              ?.status,
        ),
      )
      .toBe('cancelled');
    await expect
      .poll(async () =>
        desktop.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await expect
      .poll(async () =>
        mac.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    await desktop.getByRole('button', { name: 'Connections', exact: true }).click();
    await desktop.screenshot({ path: 'artifacts/federation-management.png', fullPage: true });
    // The executing environment can manage an inbound response without an initiating UI run.
    await desktop
      .getByRole('button', { name: 'Hello from another computer', exact: true })
      .first()
      .click();
    await desktop
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Stop this one on the host');
    await desktop.getByRole('button', { name: 'Send message' }).click();
    await expect(desktop.getByTestId('message').last()).toContainText('Response from MacBook', {
      timeout: 20_000,
    });
    await mac
      .getByRole('button', { name: 'Hello from another computer', exact: true })
      .first()
      .click();
    await expect(mac.getByRole('combobox', { name: 'Agent', exact: true })).toBeDisabled();
    await mac.getByRole('button', { name: 'Stop response', exact: true }).click();
    await expect(desktop.getByTestId('message').last()).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 15_000 },
    );
    await expect
      .poll(async () =>
        mac.evaluate(
          () => JSON.parse(localStorage.getItem('fixture-workspace')!).conversations.length,
        ),
      )
      .toBe(1);
    expect(await desktop.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
  } finally {
    await a.close();
    await b.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
