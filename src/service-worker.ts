/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
import { applyAppBadge, notificationContent, type PushNotice } from './lib/notifications';

const worker = self as unknown as ServiceWorkerGlobalScope;
const name = `agent-studio-shell-${version}`;
const assets = new Set([...build, ...files, '/']);
worker.addEventListener('push', (event) => {
  // Every accepted push produces a visible notification, including in foreground
  // (required by Safari's userVisibleOnly contract). It shows the chat's title and a
  // line about its reply as plain text, or generic text when the relay sent none.
  let notice: PushNotice = { kind: 'complete', tag: 'studio-reply' };
  try {
    const value = event.data?.json();
    if (value && ['complete', 'attention', 'error', 'cancelled', 'test'].includes(value.kind)) {
      notice = { kind: value.kind, tag: String(value.tag ?? 'studio-reply').slice(0, 100) };
      if (typeof value.conversationId === 'string' && /^[a-f0-9-]{36}$/i.test(value.conversationId))
        notice.conversationId = value.conversationId;
      if (Number.isSafeInteger(value.pendingCount) && value.pendingCount >= 0)
        notice.pendingCount = value.pendingCount;
      if (typeof value.title === 'string') notice.title = value.title;
      if (typeof value.body === 'string') notice.body = value.body;
    }
  } catch {
    /* A payload-less push still needs a visible notification. */
  }
  const { title, body } = notificationContent(notice);
  event.waitUntil(
    Promise.all([
      worker.registration.showNotification(title, {
        body,
        tag: notice.tag,
        icon: '/icons/icon-192.png',
        data: { conversationId: notice.conversationId },
      }),
      notice.pendingCount === undefined
        ? Promise.resolve()
        : applyAppBadge(worker.navigator, notice.pendingCount).catch(() => {}),
    ]),
  );
});
worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.conversationId;
  const hash = typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id) ? `#conversation=${id}` : '';
  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients.find(
        (c) => new URL(c.url).origin === worker.location.origin && new URL(c.url).pathname === '/',
      ) as WindowClient | undefined;
      if (client) {
        // Message an existing page to preserve its draft instead of navigating it.
        client.postMessage({ type: 'studio-notification-open', hash });
        await client.focus();
      } else await worker.clients.openWindow('/' + hash);
    })(),
  );
});
worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(name).then((cache) => cache.addAll([...assets])));
  // Let an existing tab finish its reply before activating a newer app version.
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('agent-studio-shell-') && key !== name) await caches.delete(key);
      await worker.clients.claim();
    })(),
  );
});
worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only the public app shell. Never cache authenticated APIs, images attached
  // to chats, pairing requests, or queue/replay commands while offline.
  if (
    event.request.method !== 'GET' ||
    url.origin !== worker.location.origin ||
    url.search ||
    !assets.has(url.pathname) ||
    url.pathname.startsWith('/v1/')
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(name);
      return (await cache.match(url.pathname)) ?? fetch(event.request);
    })(),
  );
});
