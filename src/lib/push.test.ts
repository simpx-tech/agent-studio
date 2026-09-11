import { afterEach, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { pushService, validPushEndpoint } from '../../relay/push';
import { createRelay } from '../../relay/server';
import { emptyShared } from './sync';
import type { Message } from './domain';
import { notificationConversation, requestsAttention } from './notifications';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function subscription() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-push-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let time = Date.now();
  const send = vi.fn(async (_subscription: webpush.PushSubscription, _payload: string) => {});
  let pending = 0;
  const active = new Set(['session']);
  const args = {
    directory,
    token: 'synthetic-notification-pairing-key',
    now: () => time,
    sessionActive: (id: string) => active.has(id),
    send,
    pendingCount: () => pending,
  };
  let service = pushService(args);
  const device = subscription();
  service.subscribe('session', crypto.randomUUID(), device, 'https://studio.example.com');
  return {
    get service() {
      return service;
    },
    send,
    active,
    device,
    directory,
    restart: (token = args.token) => (service = pushService({ ...args, token })),
    advance: (ms: number) => (time += ms),
    pending: (count: number) => (pending = count),
  };
}
it('sends the exact current pending count and refreshes it on retries instead of incrementing alerts', async () => {
  const f = fixture();
  f.pending(7);
  f.send.mockRejectedValueOnce({ statusCode: 503 });
  f.service.changed(emptyShared(), workspace('complete'));
  await vi.waitFor(() => expect(f.service.status('session').deliveryFailed).toBe(true));
  expect(JSON.parse(f.send.mock.calls[0][1]).pendingCount).toBe(7);
  f.pending(0);
  f.restart();
  f.advance(10_001);
  await f.service.drain();
  expect(JSON.parse(f.send.mock.calls[1][1]).pendingCount).toBe(0);
});
function workspace(status: Message['status'] = 'running') {
  const value = emptyShared();
  value.conversations.push({
    id: crypto.randomUUID(),
    title: 'Secret project name',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        role: 'assistant',
        status,
        createdAt: new Date().toISOString(),
        blocks: [{ type: 'markdown', text: 'Private reply content?' }],
      },
    ],
  });
  return value;
}
it('notifies once for a finished local reply, never replays history, and persists identity/dedup across restart', async () => {
  const f = fixture();
  const running = workspace(),
    done = structuredClone(running);
  done.conversations[0].messages[0].status = 'complete';
  f.service.changed(emptyShared(), running);
  expect(f.send).not.toHaveBeenCalled();
  f.service.changed(running, done);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  const serialized = JSON.stringify(f.send.mock.calls);
  expect(serialized).not.toContain('Private reply');
  expect(serialized).not.toContain('Secret project');
  const before = f.service.status('session').publicKey;
  f.restart();
  expect(f.service.status('session').publicKey).toBe(before);
  f.service.changed(running, done);
  f.service.changed(done, done);
  const history = workspace('complete');
  history.conversations[0].messages[0].createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
  f.service.changed(emptyShared(), history);
  await f.service.drain();
  expect(f.send).toHaveBeenCalledTimes(1);
  const data = readFileSync(join(f.directory, 'web-push.json'), 'utf8');
  expect(data).not.toContain('Private reply');
  expect(data).not.toContain('synthetic-notification-pairing-key');
});
it('recognizes only explicit parent question tools and deduplicates job and workspace notifications', async () => {
  const f = fixture(),
    running = workspace();
  const question = structuredClone(running);
  const message = question.conversations[0].messages[0];
  message.blocks.push({
    type: 'activity',
    text: 'AskUserQuestion',
    tool: {
      id: 'question-1',
      revision: 1,
      category: 'tool',
      name: 'AskUserQuestion',
      status: 'running',
      facts: [],
      sources: [],
      agents: [],
    },
  });
  expect(requestsAttention(running.conversations[0].messages[0])).toBe(false);
  f.service.changed(running, question);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  f.service.jobUpdated({
    id: message.runId!,
    source: crypto.randomUUID(),
    target: crypto.randomUUID(),
    method: 'run',
    status: 'running',
    cancel: false,
    args: { request: { runId: message.runId, conversationId: question.conversations[0].id } },
    events: [
      { kind: 'tool', tool: message.blocks[1].type === 'activity' ? message.blocks[1].tool : null },
    ],
  });
  await f.service.drain();
  expect(f.send).toHaveBeenCalledTimes(1);
  const child = structuredClone(message);
  if (child.blocks[1].type === 'activity') child.blocks[1].tool!.parentId = 'child';
  expect(requestsAttention(child)).toBe(false);
  const done = structuredClone(question);
  done.conversations[0].messages[0].status = 'complete';
  f.service.changed(question, done);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
});
it('retries transient delivery after restart, removes expired endpoints, and revokes on session expiry or key rotation', async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce({ statusCode: 503 });
  f.service.changed(emptyShared(), workspace('error'));
  await vi.waitFor(() => expect(f.service.status('session').deliveryFailed).toBe(true));
  f.restart();
  f.advance(10_001);
  await f.service.drain();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.service.status('session').deliveryFailed).toBe(false);
  f.send.mockRejectedValueOnce({ statusCode: 410 });
  f.service.test('session');
  await vi.waitFor(() => expect(f.service.status('session').enabled).toBe(false));
  f.service.subscribe('session', crypto.randomUUID(), f.device, 'https://studio.example.com');
  f.active.clear();
  f.service.changed(emptyShared(), workspace('cancelled'));
  await f.service.drain();
  expect(f.send).toHaveBeenCalledTimes(3);
  f.active.add('session');
  f.service.subscribe('session', crypto.randomUUID(), f.device, 'https://studio.example.com');
  f.restart('a-new-synthetic-pairing-key-for-rotation');
  expect(f.service.status('session').enabled).toBe(false);
});
it('encrypts a standard Web Push request with generated durable VAPID keys', () => {
  const f = fixture();
  const data = JSON.parse(readFileSync(join(f.directory, 'web-push.json'), 'utf8'));
  const request = webpush.generateRequestDetails(f.device, '{"kind":"test"}', {
    TTL: 60,
    vapidDetails: { subject: 'https://studio.example.com', ...data.keys },
  });
  expect(request.headers['Content-Encoding']).toBe('aes128gcm');
  expect(request.body?.toString()).not.toContain('"kind":"test"');
  expect(request.headers.Authorization).toMatch(/^vapid /);
});
it('an in-flight expired endpoint cannot revoke a browser subscription renewed during delivery', async () => {
  const f = fixture();
  let rejectOld: (error: unknown) => void = () => {};
  f.send.mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => (rejectOld = reject)),
  );
  f.service.changed(emptyShared(), workspace('complete'));
  expect(f.send).toHaveBeenCalledTimes(1);
  f.service.subscribe('session', crypto.randomUUID(), subscription(), 'https://studio.example.com');
  rejectOld({ statusCode: 410 });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  expect(f.service.status('session').enabled).toBe(true);
});
it('only permits known HTTPS push services and strict in-app conversation links', () => {
  for (const url of [
    'http://fcm.googleapis.com/send',
    'https://127.0.0.1/push',
    'https://fcm.googleapis.com.evil.test/send',
    'https://fcm.googleapis.com:444/send',
    'https://user@fcm.googleapis.com/send',
    'https://evil.test/push',
  ])
    expect(validPushEndpoint(url), url).toBe(false);
  expect(validPushEndpoint('https://web.push.apple.com/QABC')).toBe(true);
  const id = crypto.randomUUID();
  expect(notificationConversation(`#conversation=${id}`)).toBe(id);
  expect(notificationConversation('#conversation=https://evil.test')).toBeUndefined();
});
it('authenticates real HTTP subscription management per browser session and disconnect revokes delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-push-http-'));
  const token = 'synthetic-notification-pairing-key';
  const send = vi.fn(async () => {});
  const server = createRelay({ directory, token, pushSender: send });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const actor = crypto.randomUUID();
  expect((await fetch(url + '/v1/push')).status).toBe(401);
  const pair = await fetch(url + '/v1/browser-session', {
    method: 'POST',
    headers: { origin: url },
    body: JSON.stringify({ token, environmentId: actor }),
  });
  const headers = {
    cookie: pair.headers.get('set-cookie')!.split(';')[0],
    origin: url,
    'x-environment-id': actor,
  };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  expect((await call('PUT', '/v1/push', subscription())).status).toBe(200);
  expect((await (await call('GET', '/v1/push')).json()).enabled).toBe(true);
  expect(
    (
      await fetch(url + '/v1/push', {
        method: 'DELETE',
        headers: { ...headers, origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(401);
  expect(
    (await call('PUT', '/v1/push', { ...subscription(), endpoint: 'https://127.0.0.1' })).status,
  ).toBe(400);
  expect((await call('POST', '/v1/push/test')).status).toBe(202);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect((await call('POST', '/v1/push/test')).status).toBe(400);
  await call('DELETE', '/v1/push');
  expect((await (await call('GET', '/v1/push')).json()).enabled).toBe(false);
  await call('PUT', '/v1/push', subscription());
  await call('DELETE', '/v1/browser-session');
  const result = await fetch(url + '/v1/state', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'x-environment-id': actor },
    body: JSON.stringify({ revision: 0, workspace: workspace('complete') }),
  });
  expect(result.status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
});
