/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const name = `agent-studio-shell-${version}`;
const assets = new Set([...build, ...files, '/']);
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
