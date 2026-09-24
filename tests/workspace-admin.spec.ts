import { signInPwa } from './pwa-helper';
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { createWorkspace } from '../relay/workspaces';
import { emptyShared } from '../src/lib/sync';

async function hostedAdministration() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-admin-browser-'));
  const ownerToken = 'synthetic-admin-browser-owner-key';
  const server = createRelay({ token: ownerToken, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const member = createWorkspace({ directory, name: 'Existing member' });
  const actor = crypto.randomUUID();
  async function api(token: string, method = 'GET', path = 'workspace-admin', value?: unknown) {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-environment-id': actor,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  }
  const confidential = emptyShared();
  confidential.fleet.computers.push({ id: actor, name: 'Member confidential computer' });
  expect(
    (await api(member.token, 'PUT', 'state', { revision: 0, workspace: confidential })).status,
  ).toBe(200);
  return {
    url,
    ownerToken,
    member,
    api,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function pair(page: Page, token: string) {
  await signInPwa(page, token);
  if (await page.getByRole('button', { name: 'Open conversations' }).isVisible())
    await page.getByRole('button', { name: 'Open conversations' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

async function expectNoStoredKeys(page: Page, ...keys: string[]) {
  const clientStorage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  for (const key of keys) expect(clientStorage).not.toContain(key);
}

async function createForm(page: Page, name: string) {
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create workspace', exact: true });
  await form.getByLabel('Workspace name', { exact: true }).fill(name);
  await expect(form.getByRole('combobox', { name: 'Workspace role' })).toHaveCount(0);
  await expect(form).toContainText('New workspaces start as members');
  return form;
}

test('the sole administrator creates members and transfers administration atomically', async ({
  browser,
}, testInfo) => {
  const f = await hostedAdministration();
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  const errors: string[] = [];
  for (const page of [owner, guest]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await owner.goto(f.url);
    await pair(owner, f.ownerToken);
    await expect(
      owner.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toBeVisible();
    await expect(owner.locator('body')).not.toContainText('Member confidential computer');
    await owner.getByRole('button', { name: 'Manage workspace Owner', exact: true }).click();
    await expect(owner.getByRole('button', { name: 'Rotate key', exact: true })).toBeDisabled();
    await expect(
      owner.getByRole('button', { name: 'Disable workspace', exact: true }),
    ).toBeDisabled();
    await owner.getByRole('button', { name: 'Cancel', exact: true }).click();

    const form = await createForm(owner, 'Guest workspace');
    await form.getByRole('button', { name: 'Create workspace', exact: true }).click();
    const keyDialog = owner.getByRole('dialog', { name: 'Workspace key', exact: true });
    await expect(keyDialog).toBeVisible();
    const guestToken = await keyDialog
      .getByLabel('New workspace key', { exact: true })
      .inputValue();
    expect(guestToken.length).toBeGreaterThanOrEqual(32);
    await expectNoStoredKeys(owner, f.ownerToken, guestToken);
    expect((await f.api(guestToken, 'GET', 'state')).body.workspace).toEqual(emptyShared());
    await keyDialog.getByRole('button', { name: 'Done', exact: true }).click();
    const guestRow = owner.locator('.workspace-admin-row').filter({ hasText: 'Guest workspace' });
    await expect(guestRow).toContainText('Member');
    const guestId = await guestRow.getAttribute('data-workspace-id');
    expect(guestId).toBeTruthy();

    await guest.goto(f.url);
    const memberRead = guest.waitForResponse(
      (response) => response.url().endsWith('/v1/workspace-admin') && response.status() === 200,
    );
    await pair(guest, guestToken);
    expect((await (await memberRead).json()).role).toBe('member');
    await expect(
      guest.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Create workspace', exact: true })).toHaveCount(
      0,
    );
    await expect(guest.locator('body')).not.toContainText('Existing member');

    await owner
      .getByRole('button', { name: 'Manage workspace Guest workspace', exact: true })
      .click();
    await expect(owner.getByLabel('New workspace key', { exact: true })).toHaveCount(0);
    await owner.getByLabel('Workspace name', { exact: true }).fill('Guest administrator');
    await owner.getByRole('combobox', { name: 'Workspace role' }).click();
    await owner.getByRole('option', { name: /^Administrator/ }).click();
    await owner.getByRole('button', { name: 'Save changes', exact: true }).click();
    const confirm = owner.getByRole('dialog', { name: 'Transfer administration', exact: true });
    await expect(confirm).toContainText('manage other workspaces and issue keys');
    await expect(confirm).toContainText('Your current workspace will become a member');
    await confirm.getByRole('button', { name: 'Transfer administration', exact: true }).click();
    await expect(owner.getByRole('dialog')).toHaveCount(0);
    await expect(
      owner.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toHaveCount(0);
    await expect(
      owner.getByRole('status').filter({ hasText: 'Administration transferred' }),
    ).toBeVisible();
    expect((await f.api(guestToken)).body.role).toBe('admin');
    expect((await f.api(f.ownerToken)).body.role).toBe('member');
    expect(
      (await f.api(guestToken)).body.workspaces.filter((entry: any) => entry.role === 'admin'),
    ).toHaveLength(1);
    await guest.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      guest.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toBeVisible();
    await guest
      .getByRole('button', { name: 'Manage workspace Guest administrator', exact: true })
      .click();
    await expect(guest.getByRole('button', { name: 'Rotate key', exact: true })).toBeDisabled();
    await guest.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await f.api(f.ownerToken, 'GET', 'state')).body.workspace).toEqual(emptyShared());
    await expectNoStoredKeys(owner, f.ownerToken, guestToken);
    await expectNoStoredKeys(guest, f.ownerToken, guestToken);
    await guest.screenshot({
      path: testInfo.outputPath('workspace-administration-desktop.png'),
      fullPage: true,
    });
    await guest
      .getByRole('button', { name: 'Manage workspace Guest administrator', exact: true })
      .click();
    await expect(guest.getByRole('combobox', { name: 'Workspace role' })).toBeDisabled();
    expect(
      (
        await f.api(guestToken, 'PUT', `workspace-admin/workspaces/${guestId}`, {
          name: 'Guest administrator',
          role: 'member',
        })
      ).status,
    ).toBe(409);
    expect((await f.api(guestToken)).body.role).toBe('admin');
    await guest.getByRole('button', { name: 'Cancel', exact: true }).click();
    await guest.getByRole('button', { name: 'Manage workspace Owner', exact: true }).click();
    await guest.getByRole('combobox', { name: 'Workspace role' }).click();
    await guest.getByRole('option', { name: /^Administrator/ }).click();
    await guest.getByRole('button', { name: 'Save changes', exact: true }).click();
    await guest.getByRole('button', { name: 'Transfer administration', exact: true }).click();
    await expect(
      guest.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toHaveCount(0);
    await owner.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      owner.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toBeVisible();
    expect(
      (await f.api(f.ownerToken)).body.workspaces
        .filter((entry: any) => entry.role === 'admin')
        .map((entry: any) => entry.id),
    ).toEqual(['owner']);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([ownerContext.close(), guestContext.close()]);
    await f.close();
  }
});

test('phone administrators create members, rotate keys, and disable a workspace', async ({
  browser,
}, testInfo) => {
  const f = await hostedAdministration();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(f.url);
    await pair(page, f.ownerToken);
    const form = await createForm(page, 'Phone member');
    await form.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Workspace key', exact: true })).toBeVisible();
    const originalKey = await page.getByLabel('New workspace key', { exact: true }).inputValue();
    expect((await f.api(originalKey)).body.role).toBe('member');
    await expectNoStoredKeys(page, originalKey, f.ownerToken);
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    await page.getByRole('button', { name: 'Manage workspace Phone member', exact: true }).click();
    await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
    const rotation = page.getByRole('dialog', { name: 'Rotate workspace key', exact: true });
    await expect(rotation).toContainText('browser sessions will stop working');
    await rotation.getByRole('button', { name: 'Rotate key', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Workspace key', exact: true })).toBeVisible();
    const nextKey = await page.getByLabel('New workspace key', { exact: true }).inputValue();
    expect(nextKey).not.toBe(originalKey);
    expect((await f.api(originalKey)).status).toBe(401);
    expect((await f.api(nextKey)).status).toBe(200);
    await expectNoStoredKeys(page, originalKey, nextKey, f.ownerToken);
    await page.getByRole('button', { name: 'Done', exact: true }).click();

    await page.getByRole('button', { name: 'Manage workspace Phone member', exact: true }).click();
    await page.getByRole('button', { name: 'Disable workspace', exact: true }).click();
    const disabling = page.getByRole('dialog', { name: 'Disable workspace', exact: true });
    await expect(disabling).toContainText('Saved chats and settings are kept');
    await disabling.getByRole('button', { name: 'Disable workspace', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.locator('.workspace-admin-row').filter({ hasText: 'Phone member' }),
    ).toContainText('Disabled');
    expect((await f.api(nextKey)).status).toBe(401);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page
      .getByRole('heading', { name: 'Workspace administration', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('workspace-administration-mobile.png'),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await f.close();
  }
});

test('a delayed administrator response cannot reveal its key after this browser switches to a member', async ({
  page,
  context,
}) => {
  const f = await hostedAdministration();
  let release!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed!: () => void;
  const creationCommitted = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let issuedKey = '';
  try {
    await page.goto(f.url);
    await pair(page, f.ownerToken);
    await page.route('**/v1/workspace-admin/workspaces', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      issuedKey = (await response.json()).token;
      committed();
      await responseHeld;
      await route.fulfill({ response });
    });
    const form = await createForm(page, 'Delayed private key');
    await form.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await creationCommitted;
    const installationId = await page.evaluate(
      () => JSON.parse(localStorage.getItem('agent-studio.installation')!).id,
    );
    const mismatch = page.waitForResponse(
      (response) =>
        ['/v1/state', '/v1/state/revision'].includes(new URL(response.url()).pathname) &&
        response.status() === 409,
    );
    const switched = await context.request.post(`${f.url}/v1/browser-session`, {
      headers: { origin: f.url },
      data: { token: f.member.token, environmentId: installationId },
    });
    expect(switched.status()).toBe(200);
    await mismatch;
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const delivered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/workspace-admin/workspaces') && response.status() === 201,
    );
    release();
    await delivered;
    await expect(
      page.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('New workspace key', { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Delayed private key');
    await expectNoStoredKeys(page, issuedKey, f.ownerToken, f.member.token);
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Workspace administration', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('New workspace key', { exact: true })).toHaveCount(0);
    await expectNoStoredKeys(page, issuedKey, f.ownerToken, f.member.token);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await f.close();
  }
});

test('a temporary refresh outage after creation preserves the one-time key for recovery', async ({
  page,
}) => {
  const f = await hostedAdministration();
  let failNextRead = false;
  let failedReads = 0;
  try {
    await page.goto(f.url);
    await pair(page, f.ownerToken);
    await page.route('**/v1/workspace-admin', async (route) => {
      if (failNextRead) {
        failNextRead = false;
        ++failedReads;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary administration outage' }),
        });
      } else await route.continue();
    });
    const form = await createForm(page, 'Recoverable workspace');
    failNextRead = true;
    await form.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await expect.poll(() => failedReads).toBe(1);
    const keyDialog = page.getByRole('dialog', { name: 'Workspace key', exact: true });
    await expect(keyDialog).toBeVisible();
    const key = await keyDialog.getByLabel('New workspace key', { exact: true }).inputValue();
    expect(key.length).toBeGreaterThanOrEqual(32);
    expect((await f.api(key)).status).toBe(200);
    await expectNoStoredKeys(page, key, f.ownerToken);
    await expect(keyDialog.getByRole('alert')).toContainText('Refresh before making changes');
    const recovered = page.waitForResponse(
      (response) => response.url().endsWith('/v1/workspace-admin') && response.status() === 200,
    );
    await keyDialog
      .getByRole('button', { name: 'Check administrator access', exact: true })
      .click();
    await recovered;
    await expect(keyDialog.getByRole('alert')).toHaveCount(0);
    await expect(keyDialog.getByLabel('New workspace key', { exact: true })).toHaveValue(key);
    await keyDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(
      page.locator('.workspace-admin-row').filter({ hasText: 'Recoverable workspace' }),
    ).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await f.close();
  }
});
