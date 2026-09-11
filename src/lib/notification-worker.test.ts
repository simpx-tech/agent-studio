import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { notificationContent } from './notifications';

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
  const source = readFileSync('src/service-worker.ts', 'utf8').replace(/^import .*;\r?$/gm, '');
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
