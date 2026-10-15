import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server';
import { mockAppCalls } from './desktop-helper';

// A conflict copy an earlier release made kept its reply running, while the run went on in the
// original chat. This computer runs that chat's account but holds no run for the reply, so nothing
// ended it: Stop changed nothing, steering said the reply had ended, and a queued message waited
// for good (2026-10-15). The computer now ends such a reply, here and on every device.
const token = 'synthetic-abandoned-replies-relay-key';
const here = {
  id: '11111111-1111-4111-8111-111111111111',
  computerId: '22222222-2222-4222-8222-222222222222',
  name: 'Desktop',
  platform: 'windows' as const,
};
// The device that made the copy, which only syncs.
const phone = '99999999-9999-4999-8999-999999999999';
const ended = 'This response is no longer running.';

function stuckWorkspace() {
  const at = '2026-10-15T14:15:42.204Z';
  const account = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Claude',
    provider: 'claude',
    purpose: 'personal',
  };
  const connection = {
    id: '66666666-6666-4666-8666-666666666666',
    environmentId: here.id,
    accountId: account.id,
    profile: 'existing',
  };
  const settings = {
    provider: 'claude',
    model: 'opus',
    reasoning: 'high',
    instructions: '',
    connectionId: connection.id,
  };
  const chat = (n: number, title: string) => ({
    id: `88888888-8888-4888-8888-${n.toString(16).padStart(12, '0')}`,
    location: { computerId: here.computerId, environmentId: here.id, path: '' },
    settings,
    title,
    titleStatus: 'fallback',
    createdAt: at,
    updatedAt: at,
    messages: [
      {
        id: `77777777-7777-4777-8777-${(n * 2).toString(16).padStart(12, '0')}`,
        role: 'user',
        blocks: [{ type: 'markdown', text: 'Increase the memory and install Chunky' }],
        status: 'complete',
        createdAt: at,
      },
      {
        id: `77777777-7777-4777-8777-${(n * 2 + 1).toString(16).padStart(12, '0')}`,
        role: 'assistant',
        runId: `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`,
        blocks: [{ type: 'markdown', text: `Configuring Chunky ${n}.` }],
        status: 'running',
        createdAt: at,
        settings,
        modelName: 'Opus',
      },
    ],
  });
  return {
    version: 3,
    fleet: {
      computers: [{ id: here.computerId, name: here.name }],
      environments: [
        { id: here.id, computerId: here.computerId, name: here.name, platform: here.platform },
      ],
      accounts: [account],
      connections: [connection],
    },
    preferences: {
      lastProvider: 'claude',
      connectionByProvider: { claude: connection.id },
      modelByProvider: { claude: 'opus' },
      reasoningByProvider: { claude: { opus: 'high' } },
    },
    conversations: [
      chat(1, 'Install Chunky (conflict copy)'),
      chat(2, 'Implement multiplayer (conflict copy)'),
    ],
  };
}

async function pairedHost(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-abandoned-'));
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const request = (environment: string, method: string, path: string, body?: unknown) =>
    fetch(`${origin}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': environment,
        'content-type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  const [copied, stopped] = stuckWorkspace().conversations;
  const seeded = await request(phone, 'PUT', 'v1/state', {
    revision: 0,
    workspace: (({ preferences: _, ...shared }) => shared)({
      ...stuckWorkspace(),
      conversations: [stopped],
    }),
  });
  expect(seeded.status).toBe(200);
  await page.exposeFunction('relayBridge', async (method: string, path: string, body?: unknown) => {
    const response = await request(here.id, method, path, body);
    return { status: response.status, body: await response.json() };
  });
  // The chats reach this computer through the relay, as the copies another device made did.
  await page.exposeFunction('savedWorkspace', () => ({ ...stuckWorkspace(), conversations: [] }));
  await mockAppCalls(page);
  await page.addInitScript(
    ({ here, origin }) => {
      if (window.top !== window) return;
      const w = window as any;
      w.isTauri = true;
      w.cancelled = [];
      let sync: unknown = null;
      const status = (id: string) => ({
        id,
        installed: true,
        auth: 'ready',
        version: 'Synthetic CLI',
        detail: 'Verified fixture',
        location: 'Windows',
      });
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback: () => 0,
        unregisterCallback() {},
        async invoke(command: string, args: any) {
          args = w.studioCallArguments(command, args);
          switch (command) {
            case 'get_installation':
              return here;
            case 'load_workspace':
              return w.saved ?? w.savedWorkspace();
            case 'save_workspace':
              w.saved = JSON.parse(JSON.stringify(args.workspace));
              return;
            case 'save_workspace_patch': {
              const kept = new Map((w.saved?.conversations ?? []).map((c: any) => [c.id, c]));
              const sent = new Map(args.upsert.map((c: any) => [c.id, c]));
              const conversations = args.order.map((id: string) => sent.get(id) ?? kept.get(id));
              if (conversations.some((c: unknown) => !c))
                throw new Error('The whole workspace is needed to save this change.');
              w.saved = JSON.parse(JSON.stringify({ ...args.index, conversations }));
              return;
            }
            case 'load_sync_state':
              return sync;
            case 'save_sync_state':
              sync = w.studioCheckpoint(sync, args);
              w.synced = true;
              return;
            case 'relay_resume':
              return origin;
            case 'relay_request':
              return w.relayBridge(args.method, args.path, args.body);
            // This computer holds no run for these replies, as for any it no longer runs.
            case 'cancel_run':
              w.cancelled.push(args.runId);
              return;
            case 'desktop_notification_settings':
              return { enabled: false, sound: false };
            case 'plugin:window|is_maximized':
              return false;
            case 'plugin:event|listen':
              return 0;
            case 'live_account_updates':
            case 'background_work':
              return [];
            case 'discover_wsl':
              return { distributions: [], warning: null };
            case 'inspect_environment_clis':
              return [{ id: 'claude', path: 'C:\\CLIs\\claude.exe' }];
            case 'detect_providers':
              return [status('claude')];
            case 'detect_connection':
            case 'detect_environment_login':
              return status(args.provider);
            case 'list_models': {
              const model = (id: string, name: string) => ({
                id,
                name,
                reasoningLevels: ['low', 'medium', 'high'],
                defaultReasoning: 'medium',
              });
              return {
                claude: [model('', 'CLI default'), model('opus', 'Opus')],
                codex: [model('', 'CLI default')],
                gemini: [model('', 'CLI default')],
              };
            }
          }
        },
      };
    },
    { here, origin },
  );
  const reply = async (title: string) => {
    const response = await request(phone, 'GET', 'v1/state');
    const state = (await response.json()) as {
      workspace: { conversations: { title: string; messages: any[] }[] };
    };
    return state.workspace.conversations.find((c) => c.title === title)!.messages[1];
  };
  return {
    reply,
    /** The phone publishes the other copy, as a sync of it would. */
    async publish() {
      const response = await request(phone, 'GET', 'v1/state/revision');
      const { revision } = (await response.json()) as { revision: number };
      const sent = await request(phone, 'POST', 'v1/state/patch', { revision, upsert: [copied] });
      expect(sent.status).toBe(200);
    },
    async close() {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const chat = (page: Page, title: string) =>
  page.locator('.conversation-item').filter({ hasText: title });

test('this computer ends a reply it runs without its run, and Stop ends one at once', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = await pairedHost(page);
  try {
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => !!(window as any).synced), { timeout: 20_000 })
      .toBe(true);
    // A reply this computer holds no run for ends as soon as its Stop is pressed.
    await chat(page, 'Implement multiplayer').click();
    await expect(page.getByText('Configuring Chunky 2.', { exact: true })).toBeVisible();
    const stop = page.getByRole('button', { name: 'Stop response' });
    await stop.click();
    await expect(page.getByText(ended, { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(stop).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).cancelled)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
    ]);
    await expect
      .poll(() => relay.reply('Implement multiplayer (conflict copy)'), { timeout: 15_000 })
      .toMatchObject({ status: 'cancelled', error: ended });

    // The other copy arrives, its reply waiting, and a message is queued after it.
    await relay.publish();
    await chat(page, 'Install Chunky').click();
    await expect(page.getByText('Configuring Chunky 1.', { exact: true })).toBeVisible();
    await expect(stop).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Are you doing something? I see the plan is 2/4');
    await composer.press('Enter');
    await expect(page.getByText('After this reply')).toBeVisible();
    await expect(composer).toHaveValue('');
    // Another device's request can wait a poll for this computer, so one check alone ends nothing.
    await page.waitForTimeout(12_000);
    await expect(stop).toBeVisible();

    // A check 20 seconds after the first ends it, without anyone stopping it.
    await expect(page.getByText(ended, { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(stop).toHaveCount(0);
    await expect(page.getByText('Configuring Chunky 1.', { exact: true })).toBeVisible();
    // The queued message comes back to the composer, to send again.
    await expect(page.getByText('After this reply')).toHaveCount(0);
    await expect(composer).toHaveValue('Are you doing something? I see the plan is 2/4');
    await expect
      .poll(() => relay.reply('Install Chunky (conflict copy)'), { timeout: 15_000 })
      .toMatchObject({ status: 'cancelled', error: ended });
    expect(await page.evaluate(() => (window as any).cancelled)).toHaveLength(1);
  } finally {
    await relay.close();
  }
});
