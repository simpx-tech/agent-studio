import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import {
  applyAppBadge,
  closeNotifications,
  notificationContent,
  readSince,
  staleAlerts,
} from './notifications';

it('notification clicks focus and message an existing app without navigating its draft, or open a safe cold-start URL', async () => {
  const listeners: Record<string, (event: any) => void> = {};
  const client = {
    url: 'https://studio.example.com/',
    postMessage: vi.fn(),
    focus: vi.fn(async () => {}),
  };
  const clients = { matchAll: vi.fn(async () => [client]), openWindow: vi.fn(async () => {}) };
  const worker = {
    addEventListener: (name: string, callback: (event: any) => void) =>
      (listeners[name] = callback),
    location: { origin: 'https://studio.example.com' },
    clients,
  };
  const source = readFileSync('src/service-worker.ts', 'utf8').replace(/^import [^;]*;\r?$/gm, '');
  runInNewContext(stripTypeScriptTypes(source), {
    self: worker,
    build: [],
    files: [],
    version: 'fixture',
    notificationContent,
    URL,
  });
  const id = crypto.randomUUID();
  const close = vi.fn();
  let completion: Promise<unknown> | undefined;
  const click = async (conversationId: string) => {
    listeners.notificationclick({
      notification: { close, data: { conversationId } },
      waitUntil: (value: Promise<unknown>) => (completion = value),
    });
    await completion;
  };
  await click(id);
  expect(client.postMessage).toHaveBeenCalledWith({
    type: 'studio-notification-open',
    hash: `#conversation=${id}`,
  });
  expect(client.focus).toHaveBeenCalledOnce();
  expect(clients.openWindow).not.toHaveBeenCalled();
  clients.matchAll.mockResolvedValue([]);
  await click(id);
  expect(clients.openWindow).toHaveBeenLastCalledWith(`/#conversation=${id}`);
  await click('https://evil.example.com/');
  expect(clients.openWindow).toHaveBeenLastCalledWith('/');
  expect(close).toHaveBeenCalledTimes(3);
});

it('a push shows its alert first, then closes the older alert of its reply and alerts of chats read since', async () => {
  const listeners: Record<string, (event: any) => void> = {};
  // iOS keeps every alert of a tag beside the others instead of replacing the older one.
  type Alert = { title: string; body: string; tag: string; data: any; close: () => void };
  const shown: Alert[] = [];
  const show = (title: string, options: { body: string; tag: string; data: unknown }) => {
    const alert: Alert = {
      title,
      body: options.body,
      tag: options.tag,
      data: options.data,
      close: () => void shown.splice(shown.indexOf(alert), 1),
    };
    shown.push(alert);
  };
  const registration = {
    showNotification: vi.fn(async (title: string, options: any) => show(title, options)),
    getNotifications: vi.fn(async () => [...shown]),
  };
  const worker = {
    addEventListener: (name: string, callback: (event: any) => void) =>
      (listeners[name] = callback),
    location: { origin: 'https://studio.example.com' },
    registration,
    navigator: {},
  };
  const source = readFileSync('src/service-worker.ts', 'utf8').replace(/^import [^;]*;\r?$/gm, '');
  runInNewContext(stripTypeScriptTypes(source), {
    self: worker,
    build: [],
    files: [],
    version: 'fixture',
    applyAppBadge,
    closeNotifications,
    notificationContent,
    readSince,
    staleAlerts,
    URL,
  });
  const push = async (payload?: unknown) => {
    let completion: Promise<unknown> | undefined;
    listeners.push({
      data: payload === undefined ? null : { json: () => payload },
      waitUntil: (value: Promise<unknown>) => (completion = value),
    });
    await completion;
  };
  const visible = () => shown.map((alert) => alert.body);
  const read = crypto.randomUUID();
  const other = crypto.randomUUID();
  const alert = (conversationId: string, tag: string, body: string, sentAt: number) => ({
    kind: 'complete',
    conversationId,
    tag,
    title: 'Chat',
    body,
    sentAt,
  });
  await push(alert(read, 'studio-first', 'First reply', 1_000));
  await push({ ...alert(other, 'studio-second', 'Question: Ship it?', 2_000), kind: 'attention' });
  // The reply that asked ends: its alert replaces the question instead of joining it.
  await push(alert(other, 'studio-second', 'Shipped.', 3_000));
  expect(visible()).toEqual(['First reply', 'Shipped.']);
  expect(shown[1].data).toMatchObject({ conversationId: other, sentAt: 3_000 });
  // The first chat was read on a computer at 1500, after its alert and before the next one.
  await push({ ...alert(read, 'studio-third', 'Third reply', 4_000), close: [[read, 1_500]] });
  expect(visible()).toEqual(['Shipped.', 'Third reply']);
  // A reading older than an alert leaves it, and malformed entries close nothing.
  await push({
    ...alert(other, 'studio-fourth', 'Fourth reply', 5_000),
    close: [[other, 2_500], ['not-a-chat', 9_999], [read], 'nonsense'],
  });
  expect(visible()).toEqual(['Shipped.', 'Third reply', 'Fourth reply']);
  // An alert the previous worker showed carries no stamp, so any reading of its chat covers it.
  show('Chat', { body: 'Unstamped', tag: 'studio-old', data: { conversationId: other } });
  await push({ kind: 'test', tag: 'studio-test', close: [[other, 2_500]] });
  expect(visible()).toEqual([
    'Shipped.',
    'Third reply',
    'Fourth reply',
    'Agent Studio can notify you when work finishes or needs your attention.',
  ]);
  // A push without a payload still shows its generic alert.
  await push();
  expect(visible().at(-1)).toBe('Your agent finished its reply.');
  expect(registration.showNotification).toHaveBeenCalledTimes(7);
});
