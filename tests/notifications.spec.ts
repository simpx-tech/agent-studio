/// <reference lib="webworker" />
import { test, expect } from '@playwright/test';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('mobile opts in, receives a real worker push without an app page, opens its chat, and disables delivery', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-notifications-browser-'));
  const token = 'synthetic-push-browser-test-pairing-key';
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
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
    await page.getByLabel('Relay pairing key').fill(token);
    await page.getByRole('button', { name: 'Pair & sync' }).click();
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
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: url,
      registrationId,
      data: JSON.stringify({ ...deliveries[1], tag: 'qa-finished' }),
    });
    const worker = context.serviceWorkers().find((w) => w.url() === url + '/service-worker.js')!;
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
    await expect(page.getByText(/Your draft is preserved; finish it/)).toBeVisible();
    await expect(composer).toHaveValue('Keep this draft');
    await composer.fill('');
    await expect(page.getByText('Another notification chat', { exact: true }).last()).toBeVisible();
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(page.getByText('Enabled on this device', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Disable notifications', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable notifications', exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
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
