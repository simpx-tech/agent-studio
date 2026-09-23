import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialWorkspace } from '../src/lib/domain';
import { createRelay } from '../relay/server';
import { mockDesktop } from './desktop-helper';
import { seedAndPairPwa } from './pwa-helper';

const ready = {
  currentVersion: '0.2.0',
  phase: 'ready',
  version: '0.3.0',
  notes: '- Automatic updates\n- Faster sync',
  downloaded: 100,
  total: 100,
  checkedAt: 1790000000000,
  repliesRunning: false,
};

async function openDesktop(page: Page, status?: object) {
  await mockDesktop(page);
  if (status)
    await page.addInitScript((value) => {
      if (!localStorage.getItem('test-app-update')) localStorage.setItem('test-app-update', value);
    }, JSON.stringify(status));
  await page.goto('/');
}

async function setUpdate(page: Page, status: object) {
  await page.evaluate(
    (value) => localStorage.setItem('test-app-update', JSON.stringify(value)),
    status,
  );
}

async function recordCommands(page: Page) {
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    (window as any).commands = [];
    internals.invoke = (command: string, ...rest: unknown[]) => {
      (window as any).commands.push(command);
      return invoke(command, ...rest);
    };
  });
  return () => page.evaluate(() => (window as any).commands as string[]);
}

test('a downloaded update waits for local replies, then saves before restarting from the sidebar', async ({
  page,
}) => {
  await openDesktop(page, { ...ready, repliesRunning: true });
  const restart = page
    .locator('.sidebar-tools')
    .getByRole('button', { name: 'Restart to update', exact: true });
  await expect(restart).toBeDisabled();
  await expect(restart).toHaveAttribute(
    'title',
    'Restart after replies running on this computer finish.',
  );
  // Status refreshes while an update waits, without a native event.
  await setUpdate(page, ready);
  await expect(restart).toBeEnabled({ timeout: 10000 });
  await expect(restart).toHaveAttribute(
    'title',
    'Version 0.3.0 is ready. Restart Agent Studio to finish updating.',
  );
  const commands = await recordCommands(page);
  await restart.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('test-app-update-installed')))
    .toBe('true');
  const order = (await commands()).filter((command) =>
    ['save_workspace', 'install_app_update'].includes(command),
  );
  expect(order.slice(-2)).toEqual(['save_workspace', 'install_app_update']);
});

test('a refused restart keeps the app open and explains why', async ({ page }) => {
  await openDesktop(page, ready);
  await page.evaluate(() =>
    localStorage.setItem(
      'test-app-update-error',
      'Wait for running replies to finish, then restart to update.',
    ),
  );
  await page
    .locator('.sidebar-tools')
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Wait for running replies' }),
  ).toContainText('Wait for running replies to finish, then restart to update.');
  expect(await page.evaluate(() => localStorage.getItem('test-app-update-installed'))).toBeNull();
});

test('Settings shows the version, checks on request, and explains update states', async ({
  page,
}) => {
  await openDesktop(page);
  await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'App updates', exact: true });
  await expect(section.getByText('Current version 0.2.0', { exact: true })).toBeVisible();
  await expect(section.getByRole('status')).toContainText('Agent Studio is up to date.');
  const commands = await recordCommands(page);
  await section.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect.poll(commands).toContain('check_app_update');

  await setUpdate(page, {
    currentVersion: '0.2.0',
    phase: 'failed',
    message: 'Could not reach GitHub to check for updates. Agent Studio will try again later.',
    repliesRunning: false,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Could not reach GitHub to check for updates. Agent Studio will try again later.',
  );
  await expect(section.getByRole('button', { name: 'Check for updates' })).toBeEnabled();

  await setUpdate(page, {
    currentVersion: '0.2.0',
    phase: 'unavailable',
    message: 'Updates are off in development builds.',
    repliesRunning: false,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(section.getByRole('status')).toHaveText('Updates are off in development builds.');
  await expect(section.getByRole('button')).toHaveCount(0);

  await setUpdate(page, ready);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(section.getByRole('status')).toHaveText(
    'Version 0.3.0 is ready. Restart Agent Studio to finish updating.',
  );
  await section.getByText('What’s new in 0.3.0', { exact: true }).click();
  await expect(section.getByText('- Faster sync')).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem('test-app-update-error', 'The update could not be installed.'),
  );
  await section.getByRole('button', { name: 'Restart to update', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText('The update could not be installed.');
});

test('the web viewer has no desktop update controls', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-updates-web-'));
  const token = 'synthetic-updates-workspace-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await seedAndPairPwa(page, url, token, initialWorkspace());
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'App updates' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
