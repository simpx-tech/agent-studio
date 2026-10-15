import { signInPwa, viewerCache } from './pwa-helper';
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared, type SharedWorkspace } from '../src/lib/sync';
import type { Conversation, Message } from '../src/lib/domain';

// A phone closes the Viewer at any moment and opens it later from what it saved. What it took in
// after its sync checkpoint must not count as edited there: merged with a rewind on the computer,
// or with a later step of a reply whose answer started over, it left a conflict copy of the chat.
function workspace() {
  const shared = emptyShared();
  const [computer, environment, account, connection] = Array.from({ length: 4 }, () =>
    crypto.randomUUID(),
  );
  shared.fleet.computers.push({ id: computer, name: 'Sync computer' });
  shared.fleet.environments.push({
    id: environment,
    computerId: computer,
    name: 'Sync environment',
    platform: 'windows',
  });
  shared.fleet.accounts.push({
    id: account,
    name: 'Sync account',
    provider: 'claude',
    purpose: 'personal',
  });
  shared.fleet.connections.push({
    id: connection,
    environmentId: environment,
    accountId: account,
    profile: 'isolated',
  });
  const settings = {
    connectionId: connection,
    provider: 'claude' as const,
    model: 'opus',
    reasoning: 'max' as const,
    instructions: '',
  };
  const now = new Date().toISOString();
  const user = (text: string): Message => ({
    id: crypto.randomUUID(),
    role: 'user',
    status: 'complete',
    createdAt: now,
    blocks: [{ type: 'markdown', text }],
  });
  const reply = (status: Message['status'], text: string): Message => ({
    id: crypto.randomUUID(),
    role: 'assistant',
    status,
    createdAt: now,
    runId: crypto.randomUUID(),
    settings,
    blocks: [{ type: 'markdown', text }],
  });
  const chat = (title: string, messages: Message[]): Conversation => ({
    id: crypto.randomUUID(),
    title,
    titleStatus: 'generated',
    settings,
    location: { computerId: computer, environmentId: environment, path: 'D:\\Projects\\Empire' },
    createdAt: now,
    updatedAt: now,
    messages,
  });
  shared.conversations.push(
    chat('Rewound on the computer', [user('Draw the palm'), reply('complete', 'The palm.')]),
    chat('Answer started over', [user('Run round 4'), reply('running', 'The fourth round')]),
  );
  return { shared, user, reply };
}

test('a reopened Viewer merges what the computer did meanwhile without a conflict copy', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-sync-conflicts-'));
  const token = 'synthetic-viewer-sync-conflicts-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The computer's side, which writes the relay's copy whole.
  const headers = {
    authorization: `Bearer ${token}`,
    'x-environment-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
  const read = async () => {
    const response = await fetch(`${url}/v1/state`, { headers });
    expect(response.status).toBe(200);
    return (await response.json()) as { revision: number; workspace: SharedWorkspace };
  };
  const elsewhere = async (change: (shared: SharedWorkspace) => void) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { revision, workspace: current } = await read();
      change(current);
      const response = await fetch(`${url}/v1/state`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ revision, workspace: current }),
      });
      if (response.status === 200) return;
      expect(response.status).toBe(409);
    }
    throw new Error('The relay kept refusing the computer’s write.');
  };
  const cached = async (text: string) =>
    expect.poll(async () => JSON.stringify(await viewerCache(page))).toContain(text);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const { shared, user, reply } = workspace();
    const response = await fetch(`${url}/v1/state`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: 0, workspace: shared }),
    });
    expect(response.status).toBe(200);
    const [rewound, restarted] = shared.conversations.map((c) => c.id);
    await page.goto(url);
    await signInPwa(page, token);
    await cached('The fourth round');
    const progress = (text: string) => (s: SharedWorkspace) => {
      const [, message] = s.conversations.find((c) => c.id === restarted)!.messages;
      message.blocks = [{ type: 'markdown', text }];
    };
    // The first change taken in after signing in writes the checkpoint, which is then written at
    // most once a minute for a reply's progress.
    await elsewhere(progress('The fourth round is running.'));
    await cached('The fourth round is running.');

    // The computer runs another turn in the first chat, and the second reply moves on.
    const continued = user('Continue from where you stopped');
    const failed = reply('running', 'Picking up');
    await elsewhere((s) =>
      s.conversations.find((c) => c.id === rewound)!.messages.push(continued, failed),
    );
    await cached('Picking up');
    await elsewhere(progress('The fourth round is running. Before starting it, I reorganised'));
    await cached('Before starting it');
    await elsewhere((s) => {
      const message = s.conversations.find((c) => c.id === rewound)!.messages[3];
      message.status = 'error';
      message.error = 'The CLI finished without a text response.';
    });
    await cached('The CLI finished without a text response.');

    // The phone closes the Viewer. Meanwhile the computer rewinds the failed turn and sends it
    // again, and the other reply writes its earlier text down as progress and answers anew.
    await page.goto('about:blank');
    const again = user('Continue from where you stopped');
    const retried = reply('running', 'A fresh agent is finishing the palm.');
    await elsewhere((s) => {
      const chat = s.conversations.find((c) => c.id === rewound)!;
      chat.messages = [...chat.messages.slice(0, 2), again, retried];
      chat.historyRevision = 1;
    });
    await elsewhere((s) => {
      const [, message] = s.conversations.find((c) => c.id === restarted)!.messages;
      message.status = 'complete';
      message.blocks = [
        {
          type: 'activity',
          text: 'The fourth round is running. Before starting it, I reorganised',
          order: 0,
          progress: { id: 'progress-1', revision: 0 },
        },
        { type: 'markdown', text: 'Round 4 is still running.' },
      ];
    });

    // Opened again, it takes both in and makes no copy of either chat.
    await page.goto(url);
    await expect(page.locator('.app-shell')).toBeVisible();
    await cached('A fresh agent is finishing the palm.');
    await cached('Round 4 is still running.');
    await page.waitForTimeout(6_000);
    const { workspace: after } = await read();
    expect(after.conversations.map((c) => c.title)).toEqual([
      'Rewound on the computer',
      'Answer started over',
    ]);
    const chat = after.conversations.find((c) => c.id === rewound)!;
    expect(chat.messages.map((m) => m.id)).toEqual([
      ...shared.conversations[0].messages.map((m) => m.id),
      again.id,
      retried.id,
    ]);
    const answer = after.conversations.find((c) => c.id === restarted)!.messages[1];
    expect(answer.status).toBe('complete');
    expect(answer.blocks.at(-1)).toEqual({ type: 'markdown', text: 'Round 4 is still running.' });
    await expect(page.getByText(/conflict copy/)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

// The Viewer saves what a sync took in, then the baseline that came with it. A phone that closed
// it between the two held chats its baseline lacked; reopened after the computer had finished such
// a chat's reply and moved it to History, it kept its copy as a "(conflict copy)" whose reply ran
// for good, beside the original (2026-10-15).
test('a reopened Viewer takes in a chat its baseline lacks without a conflict copy', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-sync-unbased-'));
  const token = 'synthetic-viewer-sync-unbased-owner-key';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-environment-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
  const read = async () => {
    const response = await fetch(`${url}/v1/state`, { headers });
    expect(response.status).toBe(200);
    return (await response.json()) as { revision: number; workspace: SharedWorkspace };
  };
  const elsewhere = async (change: (shared: SharedWorkspace) => void) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { revision, workspace: current } = await read();
      change(current);
      const response = await fetch(`${url}/v1/state`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ revision, workspace: current }),
      });
      if (response.status === 200) return;
      expect(response.status).toBe(409);
    }
    throw new Error('The relay kept refusing the computer’s write.');
  };
  const cached = async (text: string) =>
    expect.poll(async () => JSON.stringify(await viewerCache(page))).toContain(text);
  // Whether the Viewer's saved baseline holds the chat.
  const checkpointed = async (id: string) => {
    const entries = await viewerCache(page);
    const key = Object.keys(entries).find((k) => k.endsWith(':sync'));
    const checkpoint = key ? JSON.parse(entries[key]) : undefined;
    return !!checkpoint?.base.conversations.some((c: Conversation) => c.id === id);
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const { shared, user, reply } = workspace();
    const response = await fetch(`${url}/v1/state`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: 0, workspace: shared }),
    });
    expect(response.status).toBe(200);
    await page.goto(url);
    await signInPwa(page, token);
    await cached('The fourth round');

    // The computer starts a chat, which the phone takes in with its reply running.
    const chunky: Conversation = {
      ...structuredClone(shared.conversations[0]),
      id: crypto.randomUUID(),
      title: 'Install Chunky',
      messages: [user('Install Chunky'), reply('running', 'Configuring Chunky')],
    };
    await elsewhere((s) => s.conversations.push(chunky));
    await cached('Configuring Chunky');
    await expect.poll(() => checkpointed(chunky.id)).toBe(true);

    // The phone closes the Viewer with the chat saved but not the baseline that came with it.
    await page.goto(`${url}/manifest.webmanifest`);
    await page.evaluate(
      (id) =>
        new Promise<void>((done, fail) => {
          const opening = indexedDB.open('agent-studio');
          opening.onerror = () => fail(opening.error);
          opening.onsuccess = () => {
            const database = opening.result;
            const store = database
              .transaction('private-workspaces', 'readwrite')
              .objectStore('private-workspaces');
            const keys = store.getAllKeys();
            keys.onsuccess = () => {
              const key = keys.result.find((k) => String(k).endsWith(':sync'))!;
              const reading = store.get(key);
              reading.onsuccess = () => {
                const checkpoint = JSON.parse(reading.result);
                checkpoint.base.conversations = checkpoint.base.conversations.filter(
                  (c: { id: string }) => c.id !== id,
                );
                delete checkpoint.revisions?.chats[id];
                store.put(JSON.stringify(checkpoint), key);
              };
            };
            store.transaction.oncomplete = () => {
              database.close();
              done();
            };
            store.transaction.onerror = () => fail(store.transaction.error);
          };
        }),
      chunky.id,
    );
    expect(await checkpointed(chunky.id)).toBe(false);
    expect(JSON.stringify(await viewerCache(page))).toContain('Configuring Chunky');

    // Meanwhile the computer finishes the reply, answers another message and moves the chat to
    // History.
    await elsewhere((s) => {
      const chat = s.conversations.find((c) => c.id === chunky.id)!;
      chat.messages[1].status = 'complete';
      chat.messages[1].blocks = [{ type: 'markdown', text: 'Chunky is generating the continent.' }];
      chat.messages.push(user('Is it running?'), reply('complete', 'Yes, at 20 chunks a second.'));
      chat.archived = true;
    });

    // Opened again, it takes the finished chat in, in History, and makes no copy of it.
    await page.goto(url);
    await expect(page.locator('.app-shell')).toBeVisible();
    await cached('Yes, at 20 chunks a second.');
    await page.waitForTimeout(6_000);
    const { workspace: after } = await read();
    expect(after.conversations.map((c) => c.title)).toEqual([
      'Rewound on the computer',
      'Answer started over',
      'Install Chunky',
    ]);
    const chat = after.conversations.find((c) => c.id === chunky.id)!;
    expect(chat.archived).toBe(true);
    expect(chat.messages.map((m) => m.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    await expect(page.getByText(/conflict copy/)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
