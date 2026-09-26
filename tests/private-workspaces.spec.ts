import { signInPwa } from './pwa-helper';
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { createWorkspace } from '../relay/workspaces';
import { emptyShared } from '../src/lib/sync';
import { initialWorkspace } from '../src/lib/domain';

async function hostedWorkspaces(duplicateIds = false) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-private-browser-'));
  const ownerToken = 'synthetic-private-browser-owner-key';
  const server = createRelay({ token: ownerToken, directory, webDirectory: resolve('build') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sharedIds = {
    host: crypto.randomUUID(),
    computer: crypto.randomUUID(),
    account: crypto.randomUUID(),
    connection: crypto.randomUUID(),
    conversation: crypto.randomUUID(),
  };
  const users = ['Alice', 'Bob'].map((name) => ({
    name,
    ...createWorkspace({ directory, name: `${name} workspace` }),
    host: crypto.randomUUID(),
    computer: crypto.randomUUID(),
    account: crypto.randomUUID(),
    connection: crypto.randomUUID(),
    conversation: crypto.randomUUID(),
    ...(duplicateIds ? sharedIds : {}),
  }));
  async function call(token: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': users[0].host,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  for (const user of users) {
    const shared = emptyShared();
    shared.fleet.computers.push({ id: user.computer, name: `${user.name} private computer` });
    shared.fleet.environments.push({
      id: user.host,
      computerId: user.computer,
      name: `${user.name} Linux environment`,
      platform: 'linux',
    });
    shared.fleet.accounts.push({
      id: user.account,
      name: `${user.name} subscription`,
      provider: 'codex',
      purpose: 'personal',
    });
    shared.fleet.connections.push({
      id: user.connection,
      environmentId: user.host,
      accountId: user.account,
      profile: 'existing',
    });
    shared.conversations.push({
      id: user.conversation,
      title: `${user.name} confidential chat`,
      archived: true,
      settings: {
        connectionId: user.connection,
        provider: 'codex',
        model: '',
        reasoning: '',
        instructions: `${user.name} private instructions`,
      },
      location: {
        computerId: user.computer,
        environmentId: user.host,
        path: `/home/${user.name}/private`,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          status: 'complete',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'markdown', text: `${user.name} private answer in this workspace.` }],
        },
      ],
    });
    await call(user.token, 'PUT', 'state', { revision: 0, workspace: shared });
  }
  return {
    url,
    server,
    users,
    ownerToken,
    call,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const pair = signInPwa;

test('Viewer forks persist only in their authenticated workspace and retain offline host routing', async ({ page }) => {
  const f = await hostedWorkspaces();
  const [alice, bob] = f.users;
  try {
    const source = (await f.call(alice.token, 'GET', 'state')).workspace.conversations[0];
    await page.goto(f.url);
    await pair(page, alice.token);
    await openPrivateChat(page, alice.name);
    await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
    await expect(page.locator('.page-title')).toHaveText(`${source.title} (fork)`);
    await expect.poll(async () => (await f.call(alice.token, 'GET', 'state')).workspace.conversations.length).toBe(2);
    const chats = (await f.call(alice.token, 'GET', 'state')).workspace.conversations;
    const fork = chats.find((c: { id: string }) => c.id !== source.id);
    expect(fork.location).toEqual(source.location);
    expect(fork.settings).toEqual(source.settings);
    expect(fork.messages[0].blocks).toEqual(source.messages[0].blocks);
    expect(chats.find((c: { id: string }) => c.id === source.id)).toEqual(source);
    expect((await f.call(bob.token, 'GET', 'state')).workspace.conversations).toHaveLength(1);
    expect((await f.call(f.ownerToken, 'GET', 'state')).workspace.conversations).toHaveLength(0);
    await page.reload();
    await page.getByRole('tab', { name: /^Active/ }).click();
    await page.getByRole('button', { name: fork.title, exact: true }).click();
    await expect(page.getByText('Alice private answer in this workspace.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  } finally {
    await f.close();
  }
});

test('Viewer drafts stay in this browser for their workspace and leave with sign out', async ({
  page,
}) => {
  const f = await hostedWorkspaces();
  const [alice] = f.users;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const stored = () => page.evaluate(() => JSON.stringify({ ...localStorage }));
  try {
    await page.goto(f.url);
    await pair(page, alice.token);
    await openPrivateChat(page, alice.name);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Alice unsent reply');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(message).toHaveValue('');
    await openPrivateChat(page, alice.name);
    await expect(message).toHaveValue('Alice unsent reply');
    await expect.poll(stored).toContain('Alice unsent reply');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await message.fill('Alice scratch idea');
    await expect.poll(stored).toContain('Alice scratch idea');
    await page.reload();
    // The Viewer continues the scratch chat edited last, and keeps each chat's own draft.
    await expect(message).toHaveValue('Alice scratch idea');
    await expect(
      page.getByRole('button', { name: 'Unsent draft: Alice scratch idea', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await openPrivateChat(page, alice.name);
    await expect(message).toHaveValue('Alice unsent reply');
    // Drafts never reach the server's copy of the workspace.
    expect(JSON.stringify(await f.call(alice.token, 'GET', 'state'))).not.toContain(
      'unsent reply',
    );
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByText('Sync settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(await stored()).not.toContain('unsent reply');
    expect(await stored()).not.toContain('scratch idea');
    await pair(page, alice.token);
    await expect(page.locator('.scratch-item')).toHaveCount(0);
    await openPrivateChat(page, alice.name);
    await expect(message).toHaveValue('');
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('workspace login gates startup, authentication, restoration, and expired sessions', async ({
  page,
  context,
}, testInfo) => {
  const f = await hostedWorkspaces();
  const [alice] = f.users;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release!: () => void;
  let reached!: () => void;
  let hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let blockedPath = '/v1/browser-session';
  // Pause at the real server: WebKit service-worker fetches can bypass
  // Playwright routing after the first authenticated navigation.
  const handleRequest = f.server.listeners('request')[0];
  f.server.removeAllListeners('request');
  f.server.on('request', (request, response) => {
    if (request.url === blockedPath && request.method === 'GET') {
      reached();
      void hold.then(() => handleRequest.call(f.server, request, response));
    } else handleRequest.call(f.server, request, response);
  });
  const locked = async () => {
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connections', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Alice');
  };
  try {
    await page.goto(f.url);
    await pending;
    await locked();
    await expect(page.getByRole('status')).toContainText('Checking your workspace session');
    await page.keyboard.press('Control+n');
    await locked();
    blockedPath = '';
    release();
    await expect(page.getByLabel('Workspace key', { exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(
        Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: async () => {
            document.documentElement.dataset.installPrompted = 'true';
          },
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        }),
      );
    });
    for (const viewport of [
      { width: 1380, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 480 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`workspace-login-${viewport.width}.png`) });
    }
    await page.setViewportSize({ width: 1380, height: 900 });
    blockedPath = '/v1/state';
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await page.getByLabel('Workspace key', { exact: true }).fill(alice.token);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await pending;
    await locked();
    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    blockedPath = '';
    release();
    await openPrivateChat(page, alice.name);

    await page.getByRole('button', { name: 'Install app', exact: true }).click();
    await page.getByRole('button', { name: 'Install Viewer', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-install-prompted', 'true');

    blockedPath = '/v1/browser-session';
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await page.reload();
    await pending;
    await locked();
    blockedPath = '';
    release();
    await openPrivateChat(page, alice.name);
    await context.clearCookies();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible({
      timeout: 10000,
    });
    await locked();
    await expect(page.getByRole('alert')).toContainText('session ended');
    expect(errors).toEqual([]);
  } finally {
    blockedPath = '';
    release();
    await f.close();
  }
});

async function openPrivateChat(page: Page, name: string) {
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: `${name} confidential chat`, exact: true }).click();
  await expect(
    page.getByText(`${name} private answer in this workspace.`, { exact: true }),
  ).toBeVisible();
}

test('two people use one PWA origin with independent chats and computer/account setups', async ({
  browser,
}, testInfo) => {
  const f = await hostedWorkspaces();
  const contexts = await Promise.all(
    f.users.map(() => browser.newContext({ viewport: { width: 1380, height: 900 } })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const errors: string[] = [];
  try {
    for (const [index, page] of pages.entries()) {
      const user = f.users[index];
      const other = f.users[1 - index];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(f.url);
      await pair(page, user.token);
      await openPrivateChat(page, user.name);
      await expect(page.locator('body')).not.toContainText(other.name);
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: `${user.name} private computer`, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(`${user.name} subscription`, { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(other.name);
      await page.screenshot({
        path: testInfo.outputPath(`${user.name.toLowerCase()}-private-connections.png`),
      });
      const storage = await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      );
      expect(storage).not.toContain(user.token);
      expect(storage).not.toContain(other.name);
      await page.reload();
      await openPrivateChat(page, user.name);
      await expect(page.locator('body')).not.toContainText(other.name);
      await page.screenshot({
        path: testInfo.outputPath(`${user.name.toLowerCase()}-private-chat.png`),
      });
    }
    expect((await f.call(f.ownerToken, 'GET', 'state')).workspace.conversations).toEqual([]);
    for (const user of f.users) {
      const saved = await f.call(user.token, 'GET', 'state');
      expect(saved.workspace.conversations.map((chat: { title: string }) => chat.title)).toEqual([
        `${user.name} confidential chat`,
      ]);
    }
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await f.close();
  }
});

test('a changed HttpOnly cookie cannot expose a new workspace to a stale tab even when resource IDs are identical', async ({
  page,
  context,
}, testInfo) => {
  const f = await hostedWorkspaces(true);
  const [alice, bob] = f.users;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    expect(alice.connection).toBe(bob.connection);
    expect(alice.conversation).toBe(bob.conversation);
    await page.goto(f.url);
    await pair(page, alice.token);
    await openPrivateChat(page, alice.name);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Alice draft must not enter Bob workspace');
    const installationId = await page.evaluate(
      () => JSON.parse(localStorage.getItem('agent-studio.installation')!).id,
    );
    const mismatch = page.waitForResponse(
      (response) =>
        ['/v1/state', '/v1/state/revision', '/v1/state/manifest'].includes(
          new URL(response.url()).pathname,
        ) &&
        response.status() === 409,
    );
    // APIRequestContext shares this browser's actual HttpOnly cookie jar. No
    // localStorage event or app callback warns the old tab about this change.
    const switched = await context.request.post(`${f.url}/v1/browser-session`, {
      headers: { origin: f.url },
      data: { token: bob.token, environmentId: installationId },
    });
    expect(switched.status()).toBe(200);
    expect((await switched.json()).workspaceId).toBe(bob.workspace.id);
    const rejected = await mismatch;
    expect(rejected.request().headers()['x-workspace-id']).toBe(alice.workspace.id);
    expect((await rejected.json()).code).toBe('workspace_changed');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Alice');
    await expect(page.locator('body')).not.toContainText('Bob');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    await page.reload();
    await openPrivateChat(page, bob.name);
    await expect(page.locator('body')).not.toContainText('Alice');
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('Alice');
    const saved = await f.call(bob.token, 'GET', 'state');
    expect(saved.workspace.conversations).toHaveLength(1);
    expect(saved.workspace.conversations[0].id).toBe(alice.conversation);
    expect(JSON.stringify(saved)).not.toContain('Alice');
    await page.screenshot({ path: testInfo.outputPath('stale-cookie-reloaded-bob.png') });
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a failed pending chat deletion cannot resurrect the old workspace after its cookie changes', async ({
  page,
  context,
}, testInfo) => {
  const f = await hostedWorkspaces(true);
  const [alice, bob] = f.users;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const cancelling = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const initial = await f.call(alice.token, 'GET', 'state');
    const runId = crypto.randomUUID();
    initial.workspace.conversations[0].messages[0].status = 'running';
    initial.workspace.conversations[0].messages[0].runId = runId;
    await f.call(alice.token, 'PUT', 'state', {
      revision: initial.revision,
      workspace: initial.workspace,
    });
    const handleRequest = f.server.listeners('request')[0];
    f.server.removeAllListeners('request');
    f.server.on('request', (request, response) => {
      if (request.url === `/v1/jobs/${runId}/cancel`) {
        reached();
        void hold.then(() => {
          response.writeHead(401, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ error: 'Workspace access was revoked.' }));
        });
      } else handleRequest.call(f.server, request, response);
    });
    await page.goto(f.url);
    await pair(page, alice.token);
    await openPrivateChat(page, alice.name);
    await page
      .getByRole('button', { name: 'Alice confidential chat', exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete conversation', exact: true })
      .click();
    await cancelling;
    const installationId = await page.evaluate(
      () => JSON.parse(localStorage.getItem('agent-studio.installation')!).id,
    );
    const mismatch = page.waitForResponse(
      (response) =>
        ['/v1/state', '/v1/state/revision', '/v1/state/manifest'].includes(
          new URL(response.url()).pathname,
        ) &&
        response.status() === 409,
    );
    const switched = await context.request.post(`${f.url}/v1/browser-session`, {
      headers: { origin: f.url },
      data: { token: bob.token, environmentId: installationId },
    });
    expect(switched.status()).toBe(200);
    await mismatch;
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const rejectedCancellation = page.waitForResponse((response) =>
      response.url().endsWith(`/v1/jobs/${runId}/cancel`),
    );
    release();
    await rejectedCancellation;
    // A browser task boundary lets the rejected fetch's catch/finally finish.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await expect(page.locator('body')).not.toContainText('Alice');
    await expect(page.getByRole('tab', { name: /^History/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^Active/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('Alice');
    await page.screenshot({
      path: testInfo.outputPath('revoked-delete-keeps-old-workspace-empty.png'),
    });
    await page.reload();
    await openPrivateChat(page, bob.name);
    await expect(page.locator('body')).not.toContainText('Alice');
    const saved = await f.call(bob.token, 'GET', 'state');
    expect(saved.workspace.conversations).toHaveLength(1);
    expect(saved.workspace.conversations[0].id).toBe(alice.conversation);
    expect(saved.workspace.conversations[0].title).toBe('Bob confidential chat');
    expect(JSON.stringify(saved)).not.toContain('Alice');
    expect(errors).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});

test('switching the shared browser session clears stale tabs, drafts, and cached chats before another workspace can sync', async ({
  page,
  context,
}, testInfo) => {
  const f = await hostedWorkspaces();
  const [alice, bob] = f.users;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let second: Page | undefined;
  try {
    // An unauthenticated page must not render an old unscoped browser cache.
    const legacy = initialWorkspace();
    legacy.conversations = (await f.call(alice.token, 'GET', 'state')).workspace.conversations;
    await page.addInitScript(
      ({ legacy, url }) => {
        if (!sessionStorage.getItem('seeded-private-test')) {
          localStorage.setItem('agent-studio.browser.v1', JSON.stringify(legacy));
          localStorage.setItem(
            'agent-studio.browser-sync',
            JSON.stringify({ url, instanceId: 'old-owner-instance', base: legacy }),
          );
          sessionStorage.setItem('seeded-private-test', 'yes');
        }
      },
      { legacy, url: f.url },
    );
    await page.goto(f.url);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Alice');
    await pair(page, alice.token);
    await openPrivateChat(page, alice.name);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Alice unsent private draft');
    second = await context.newPage();
    second.on('pageerror', (error) => errors.push(error.message));
    await second.goto(f.url);
    await openPrivateChat(second, alice.name);
    await second.getByRole('button', { name: 'Connections', exact: true }).click();
    await second.getByText('Sync settings', { exact: true }).click();
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Alice');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    await pair(second, bob.token);
    await openPrivateChat(second, bob.name);
    await expect(second.locator('body')).not.toContainText('Alice');
    await expect(page.locator('body')).not.toContainText('Bob');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(
      await second.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain('Alice');
    await page.reload();
    await openPrivateChat(page, bob.name);
    await expect(page.locator('body')).not.toContainText('Alice');
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('shared-browser-switched-to-bob.png') });
    const saved = await f.call(bob.token, 'GET', 'state');
    expect(JSON.stringify(saved)).not.toContain('Alice');
    expect(saved.workspace.conversations).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await second?.close();
    await f.close();
  }
});
