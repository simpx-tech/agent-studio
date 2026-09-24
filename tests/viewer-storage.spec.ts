import { signInPwa, viewerCache } from './pwa-helper';
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { browserScopeKey } from '../src/lib/browser-workspace';
import { initialWorkspace } from '../src/lib/domain';
import { emptyShared } from '../src/lib/sync';

async function hostedRelay() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-viewer-storage-'));
  const token = 'synthetic-viewer-storage-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function state(body?: unknown) {
    const response = await fetch(`${url}/v1/state`, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  }
  return {
    url,
    token,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function workspaceWith(...chats: { title: string; text: string }[]) {
  const shared = emptyShared();
  const [computer, environment, account, connection] = Array.from({ length: 4 }, () =>
    crypto.randomUUID(),
  );
  shared.fleet.computers.push({ id: computer, name: 'Storage test computer' });
  shared.fleet.environments.push({
    id: environment,
    computerId: computer,
    name: 'Storage test environment',
    platform: 'linux',
  });
  shared.fleet.accounts.push({
    id: account,
    name: 'Storage test account',
    provider: 'codex',
    purpose: 'personal',
  });
  shared.fleet.connections.push({
    id: connection,
    environmentId: environment,
    accountId: account,
    profile: 'existing',
  });
  for (const chat of chats)
    shared.conversations.push({
      id: crypto.randomUUID(),
      title: chat.title,
      archived: true,
      settings: {
        connectionId: connection,
        provider: 'codex',
        model: '',
        reasoning: '',
        instructions: '',
      },
      location: { computerId: computer, environmentId: environment, path: '/home/storage' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          status: 'complete',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'markdown', text: chat.text }],
        },
      ],
    });
  return shared;
}

async function expectHistoryChat(page: Page, title: string) {
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
}

const privateLocalStorage = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('agent-studio.private-workspace')),
  );

test('Viewer signs in to and restores a workspace larger than localStorage can hold', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = await hostedRelay();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    // Two copies (the chats and their sync checkpoint) exceed every browser's localStorage quota.
    await relay.state({
      revision: 0,
      workspace: workspaceWith({ title: 'Large archived chat', text: 'x'.repeat(5_500_000) }),
    });
    await page.goto(relay.url);
    await signInPwa(page, relay.token);
    await expectHistoryChat(page, 'Large archived chat');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    await expect
      .poll(async () =>
        Object.entries(await viewerCache(page)).map(([key, value]) => [
          key.endsWith(':sync') ? 'checkpoint' : 'workspace',
          value.length > 5_500_000,
        ]),
      )
      .toEqual(
        expect.arrayContaining([
          ['workspace', true],
          ['checkpoint', true],
        ]),
      );
    expect(await privateLocalStorage(page)).toEqual([]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toHaveCount(0);
    await expectHistoryChat(page, 'Large archived chat');
    await expect(page.locator('.error-banner')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await relay.close();
  }
});

test('Viewer moves a cache saved in localStorage by an earlier release into IndexedDB', async ({
  page,
}) => {
  const relay = await hostedRelay();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const server = workspaceWith({ title: 'Synced chat', text: 'Already on the server.' });
    await relay.state({ revision: 0, workspace: server });
    const { instanceId } = await relay.state();
    const local = structuredClone(server);
    local.conversations.push(
      workspaceWith({ title: 'Chat saved only in this browser', text: 'Not synced yet.' })
        .conversations[0],
    );
    const key = browserScopeKey({ url: relay.url, workspaceId: 'owner', instanceId });
    await page.goto(relay.url);
    await page.evaluate(
      ([key, saved, checkpoint]) => {
        localStorage.setItem(key, saved);
        localStorage.setItem(`${key}:sync`, checkpoint);
      },
      [
        key,
        JSON.stringify({ ...initialWorkspace(), ...local }),
        JSON.stringify({ url: relay.url, instanceId, base: server }),
      ],
    );
    await signInPwa(page, relay.token);
    // The unsynced chat proves the moved snapshot and checkpoint were merged with the server.
    await expectHistoryChat(page, 'Chat saved only in this browser');
    await expect
      .poll(async () =>
        (await relay.state()).workspace.conversations.map((c: { title: string }) => c.title),
      )
      .toContain('Chat saved only in this browser');
    expect(Object.keys(await viewerCache(page))).toEqual(
      expect.arrayContaining([key, `${key}:sync`]),
    );
    expect(await privateLocalStorage(page)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await relay.close();
  }
});
