/// <reference lib="webworker" />
import { signInPwa } from './pwa-helper';
import { test, expect } from '@playwright/test';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('the foreground PWA chat stays quiet, other chats notify, and leaving the app restores alerts', async ({
  page,
  context,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-foreground-push-'));
  const token = 'synthetic-foreground-notification-key';
  const deliveries: { kind: string; conversationId?: string }[] = [];
  const server = createRelay({
    directory,
    token,
    webDirectory: resolve('build'),
    pushSender: async (_subscription, payload) => {
      deliveries.push(JSON.parse(payload));
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() };
  const id = crypto.randomUUID(),
    otherId = crypto.randomUUID();
  const workspace = emptyShared();
  workspace.conversations = [id, otherId].map((id, index) => ({
    id,
    title: index ? 'Other chat' : 'Viewed chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: { provider: 'claude', model: 'test', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        runId: crypto.randomUUID(),
        status: 'running',
        createdAt: new Date().toISOString(),
        blocks: [{ type: 'markdown', text: 'Working' }],
      },
    ],
  }));
  const update = async (mutate: (value: typeof workspace) => void) => {
    const state = await (await fetch(url + '/v1/state', { headers })).json();
    mutate(state.workspace);
    const result = await fetch(url + '/v1/state', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: state.revision, workspace: state.workspace }),
    });
    expect(result.status).toBe(200);
  };
  let viewed: string | null | undefined;
  let browserHeaders: Record<string, string> = {};
  page.on('response', async (response) => {
    if (response.url() === url + '/v1/notification-view' && response.status() === 200) {
      viewed = response.request().postDataJSON().conversationId;
      const requestHeaders = response.request().headers();
      browserHeaders = {
        origin: url,
        'x-environment-id': requestHeaders['x-environment-id'],
        'x-workspace-id': requestHeaders['x-workspace-id'],
      };
    }
  });
  try {
    await update((state) => {
      state.conversations = workspace.conversations;
    });
    await page.goto(url + '/#conversation=' + id);
    await signInPwa(page, token);
    const key = createECDH('prime256v1');
    key.generateKeys();
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/foreground-fixture',
      keys: {
        p256dh: key.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    };
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeVisible();
    await page.bringToFront();
    await composer.fill('Preserve my draft');
    await expect.poll(() => viewed).toBe(id);
    expect(
      (
        await context.request.put(url + '/v1/push', { headers: browserHeaders, data: subscription })
      ).status(),
    ).toBe(200);
    await update((state) => {
      state.conversations[0].messages[0].status = 'complete';
    });
    await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
    await expect(page.locator('.pending-chat-count')).toHaveText('1');
    expect(deliveries).toEqual([]);
    await update((state) => {
      state.conversations[1].messages[0].status = 'complete';
    });
    await expect.poll(() => deliveries.length).toBe(1);
    expect(deliveries[0]).toMatchObject({ kind: 'complete', conversationId: otherId });
    await expect(composer).toHaveValue('Preserve my draft');

    await page.screenshot({ path: testInfo.outputPath('foreground-chat.png') });
    // Leave the actual page; pagehide must clear its lease without waiting for expiry.
    await page.goto('about:blank');
    await update((state) => {
      const message = state.conversations[0].messages[0];
      message.id = crypto.randomUUID();
      message.runId = crypto.randomUUID();
      message.status = 'error';
    });
    await expect.poll(() => deliveries.length).toBe(2);
    expect(deliveries[1]).toMatchObject({ kind: 'error', conversationId: id });
    expect(deliveries).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mobile opts in, receives a real worker push without an app page, opens its chat, and disables delivery', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-notifications-browser-'));
  const token = 'synthetic-push-browser-test-pairing-key';
  const deliveries: { kind: string; conversationId?: string; pendingCount?: number }[] = [];
  const server = createRelay({
    directory,
    token,
    webDirectory: resolve('build'),
    pushSender: async (_subscription, payload) => {
      deliveries.push(JSON.parse(payload));
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const key = createECDH('prime256v1');
  key.generateKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-browser-test',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  try {
    await context.grantPermissions(['notifications'], { origin: url });
    // Push-service enrollment is controlled for repeatability. The compiled
    // service worker, Push event, Notification API and relay remain real.
    await page.addInitScript((value) => {
      if (!['http:', 'https:'].includes(location.protocol)) return;
      let subscribed = localStorage.getItem('qa-push-subscribed') === 'yes';
      const make = () => ({
        endpoint: value.endpoint,
        options: {},
        toJSON: () => value,
        unsubscribe: async () => {
          subscribed = false;
          localStorage.removeItem('qa-push-subscribed');
          return true;
        },
      });
      PushManager.prototype.getSubscription = async () =>
        subscribed ? (make() as unknown as PushSubscription) : null;
      PushManager.prototype.subscribe = async () => {
        subscribed = true;
        localStorage.setItem('qa-push-subscribed', 'yes');
        return make() as unknown as PushSubscription;
      };
    }, subscription);
    const cdp = await context.newCDPSession(page);
    let registrationId = '';
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      registrationId =
        registrations.find((r) => r.scopeURL === url + '/' && !r.isDeleted)?.registrationId ??
        registrationId;
    });
    await cdp.send('ServiceWorker.enable');
    await page.goto(url);
    await signInPwa(page, token);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    await expect.poll(() => registrationId).not.toBe('');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
    await expect(page.getByText('Enabled on this device', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Send test notification' }).click();
    await expect.poll(() => deliveries.length).toBe(1);
    expect(deliveries[0].kind).toBe('test');
    await page.screenshot({
      path: testInfo.outputPath('mobile-notifications.png'),
      fullPage: true,
    });
    const actor = crypto.randomUUID();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-environment-id': actor,
      'content-type': 'application/json',
    };
    const state = await (await fetch(url + '/v1/state', { headers })).json();
    const workspace = emptyShared();
    const id = crypto.randomUUID();
    workspace.conversations.push({
      id,
      title: 'Notification test chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: { provider: 'claude', model: 'test', reasoning: '', instructions: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          runId: crypto.randomUUID(),
          status: 'running',
          createdAt: new Date().toISOString(),
          blocks: [{ type: 'markdown', text: 'The requested work is complete.' }],
        },
      ],
    });
    const other = structuredClone(workspace.conversations[0]);
    other.id = crypto.randomUUID();
    other.title = 'Another notification chat';
    other.messages = [];
    workspace.conversations.push(other);
    await fetch(url + '/v1/state', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: state.revision, workspace }),
    });
    // No Agent Studio window remains open during delivery.
    await page.goto('about:blank');
    const current = await (await fetch(url + '/v1/state', { headers })).json();
    current.workspace.conversations[0].messages[0].status = 'complete';
    await fetch(url + '/v1/state', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: current.revision, workspace: current.workspace }),
    });
    await expect.poll(() => deliveries.length).toBe(2);
    expect(deliveries[1].pendingCount).toBe(2);
    const worker = context.serviceWorkers().find((w) => w.url() === url + '/service-worker.js')!;
    await worker.evaluate(() => {
      const nav = navigator as any;
      const set = nav.setAppBadge?.bind(nav);
      nav.setAppBadge = async (count: number) => {
        (self as any).qaBadgeCount = count;
        await set?.(count);
      };
      const clear = nav.clearAppBadge?.bind(nav);
      nav.clearAppBadge = async () => {
        (self as any).qaBadgeCount = 0;
        await clear?.();
      };
    });
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: url,
      registrationId,
      data: JSON.stringify({ ...deliveries[1], tag: 'qa-finished' }),
    });
    await expect.poll(() => worker.evaluate(() => (self as any).qaBadgeCount)).toBe(2);
    // Zero is an explicit clear; repeated deliveries never increment the count.
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: url,
      registrationId,
      data: JSON.stringify({ kind: 'test', tag: 'qa-zero-badge', pendingCount: 0 }),
    });
    await expect.poll(() => worker.evaluate(() => (self as any).qaBadgeCount)).toBe(0);
    await expect
      .poll(async () =>
        worker.evaluate(async () => {
          const worker = self as unknown as ServiceWorkerGlobalScope;
          return (await worker.registration.getNotifications()).map((n) => n.title);
        }),
      )
      .toContain('Reply ready');
    // Cold-start deep link waits for workspace restoration and opens the reply.
    await page.goto(`${url}/#conversation=${id}`);
    await expect(page.getByText('The requested work is complete.', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: /Message/ }).first();
    await composer.fill('Keep this draft');
    await worker.evaluate(async (id) => {
      const worker = self as unknown as ServiceWorkerGlobalScope;
      for (const client of await worker.clients.matchAll({ type: 'window' }))
        client.postMessage({
          type: 'studio-notification-open',
          hash: `#conversation=${id}`,
        });
    }, id);
    await expect(composer).toHaveValue('Keep this draft');
    await worker.evaluate(async (id) => {
      for (const client of await (self as unknown as ServiceWorkerGlobalScope).clients.matchAll({
        type: 'window',
      }))
        client.postMessage({ type: 'studio-notification-open', hash: `#conversation=${id}` });
    }, other.id);
    // The notification opens its chat; the unsent draft stays with its own chat.
    await expect(page.getByText('Another notification chat', { exact: true }).last()).toBeVisible();
    await expect(composer).toHaveValue('');
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Notification test chat', exact: true }).click();
    await expect(composer).toHaveValue('Keep this draft');
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Enabled on this device', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable notifications', exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Off on this device', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await worker.evaluate(async () => {
      for (const n of await (
        self as unknown as ServiceWorkerGlobalScope
      ).registration.getNotifications())
        n.close();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
