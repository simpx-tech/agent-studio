import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { seedAndPairPwa } from './pwa-helper';

// A chat's parked CLI process stays until the user closes the chat: moving it to History or
// deleting it. Time, other chats and another computer's startup close nothing.

const desktopId = '11111111-1111-4111-8111-111111111111';

// Records each conversation this computer is asked to release, in order.
async function recordReleases(page: Page) {
  await page.addInitScript(() => {
    const w = window as any,
      native = w.__TAURI_INTERNALS__,
      invoke = native.invoke;
    w.released = [];
    native.invoke = async (command: string, args: any) => {
      if (command === 'release_conversation') {
        w.released.push(args.conversationId);
        return;
      }
      return invoke(command, args);
    };
  });
}
const released = (page: Page) => page.evaluate(() => (window as any).released as string[]);
const chatId = (page: Page, title: string) =>
  page.evaluate(
    (title) =>
      JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
        (c: any) => c.title === title,
      )?.id as string,
    title,
  );
const heldRuns = (page: Page) =>
  page.evaluate(() => Object.keys((window as any).capabilityRuns ?? {}).length);

// Sends a message in a new chat and completes its reply, which parks its process.
async function reply(page: Page, text: string, first = false) {
  const before = await heldRuns(page);
  if (!first) await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => heldRuns(page)).toBe(before + 1);
  await page.evaluate(() => {
    const run = (Object.values((window as any).capabilityRuns) as any[]).at(-1);
    run.emit({ kind: 'text', text: 'Done.' });
    run.finish('complete');
  });
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
}

test('moving a chat to History or deleting it releases its process, and nothing else does', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await recordReleases(page);
  await page.goto('/');
  await reply(page, 'Chat closed from its row', true);
  await reply(page, 'Chat closed from its toolbar');
  await reply(page, 'Chat to delete');
  await reply(page, 'Chat left open');
  expect(await released(page)).toEqual([]);

  const row = (await chatId(page, 'Chat closed from its row'))!;
  await page.getByRole('button', { name: 'Chat closed from its row', exact: true }).hover();
  await page
    .getByRole('button', { name: 'Move Chat closed from its row to history', exact: true })
    .click();
  await expect.poll(() => released(page)).toEqual([row]);

  const toolbar = (await chatId(page, 'Chat closed from its toolbar'))!;
  await page.getByRole('button', { name: 'Chat closed from its toolbar', exact: true }).click();
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect.poll(() => released(page)).toEqual([row, toolbar]);

  const deleted = (await chatId(page, 'Chat to delete'))!;
  await page
    .getByRole('button', { name: 'Chat to delete', exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await expect.poll(() => released(page)).toEqual([row, toolbar, deleted]);

  // Starting the app again moves saved chats to History without closing anything.
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(page.getByRole('button', { name: 'Chat left open', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await released(page)).toEqual([]);
});

test('a chat deleted on another device releases its process here, but a History move from sync does not', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-parked-relay-'));
  const token = 'synthetic-parked-process-relay-token';
  const relay = createRelay({ token, directory });
  await new Promise<void>((done) => relay.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const device = crypto.randomUUID();
  const call = async (method: string, path: string, body?: unknown, environment = device) => {
    const response = await fetch(`${url}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': environment,
        'content-type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await page.exposeFunction('relayBridge', (method: string, path: string, body?: unknown) =>
    call(method, path, body, desktopId),
  );
  try {
    await mockDesktop(page, 'capabilities');
    await recordReleases(page);
    await page.addInitScript((url) => {
      const w = window as any,
        native = w.__TAURI_INTERNALS__,
        invoke = native.invoke;
      let sync: unknown = null;
      native.invoke = async (command: string, args: any) => {
        if (command === 'relay_resume') return url;
        if (command === 'relay_request') return w.relayBridge(args.method, args.path, args.body);
        if (command === 'load_sync_state') return sync;
        if (command === 'save_sync_state') {
          sync = args.value;
          return;
        }
        return invoke(command, args);
      };
    }, url);
    await page.goto('/');
    await reply(page, 'Chat deleted elsewhere', true);
    await reply(page, 'Chat archived elsewhere');
    const deleted = (await chatId(page, 'Chat deleted elsewhere'))!;
    const archived = (await chatId(page, 'Chat archived elsewhere'))!;
    const ids = async () =>
      (await call('GET', 'v1/state')).body.workspace.conversations.map((c: any) => c.id).sort();
    await expect.poll(ids, { timeout: 15_000 }).toEqual([deleted, archived].sort());

    // Another device deletes one chat and moves the other to History, as its startup would.
    const state = (await call('GET', 'v1/state')).body;
    state.workspace.conversations = state.workspace.conversations
      .filter((c: any) => c.id !== deleted)
      .map((c: any) => ({ ...c, archived: true }));
    const changed = await call('PUT', 'v1/state', {
      revision: state.revision,
      workspace: state.workspace,
    });
    expect(changed.status).toBe(200);
    await expect(
      page.getByRole('button', { name: 'Chat deleted elsewhere', exact: true }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => released(page)).toEqual([deleted]);
    await page.getByRole('tab', { name: /^History/ }).click();
    await expect(
      page.getByRole('button', { name: 'Chat archived elsewhere', exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);
    expect(await released(page)).toEqual([deleted]);
  } finally {
    relay.closeAllConnections();
    await new Promise<void>((done) => relay.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the Viewer asks the computer running a chat to release it when moved to History', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-release-pwa-'));
  const token = 'synthetic-release-relay-fixture-token';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID(),
    conversationId = crypto.randomUUID(),
    now = new Date().toISOString();
  const workspace = initialWorkspace();
  workspace.fleet = {
    computers: [{ id: computer, name: 'Release host' }],
    environments: [{ id: host, computerId: computer, name: 'Windows', platform: 'windows' }],
    accounts: [{ id: account, name: 'Release account', provider: 'claude', purpose: 'personal' }],
    connections: [{ id: connection, environmentId: host, accountId: account, profile: 'existing' }],
  };
  workspace.conversations.push({
    id: conversationId,
    title: 'Remote chat',
    createdAt: now,
    updatedAt: now,
    location: { computerId: computer, environmentId: host, path: 'C:\\Release fixture' },
    settings: {
      provider: 'claude',
      model: '',
      reasoning: '',
      instructions: '',
      connectionId: connection,
    },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        runId: crypto.randomUUID(),
        blocks: [{ type: 'markdown', text: 'A monitor keeps watching.' }],
      },
    ],
  });
  const received: any[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': host,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  let busy = false;
  const worker = async () => {
    if (busy) return;
    busy = true;
    try {
      await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [] });
      for (const job of await call('GET', 'jobs')) {
        received.push(job);
        await call('PUT', `jobs/${job.id}`, {
          status: 'complete',
          events: [],
          result: job.method === 'models' ? { claude: [] } : null,
        });
      }
    } finally {
      busy = false;
    }
  };
  let workerError: unknown;
  const timer = setInterval(() => {
    void worker().catch((e) => (workerError = e));
  }, 200);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [] });
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Move Remote chat to history', exact: true }).click();
    await expect.poll(() => received.filter((job) => job.method === 'release').length).toBe(1);
    const job = received.find((job) => job.method === 'release');
    expect(job.target).toBe(host);
    expect(job.args).toEqual({ conversationId, connectionId: connection });
    expect(received.filter((job) => job.method === 'run')).toHaveLength(0);
    expect(workerError).toBeUndefined();
  } finally {
    clearInterval(timer);
    while (busy) await new Promise((done) => setTimeout(done, 10));
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
