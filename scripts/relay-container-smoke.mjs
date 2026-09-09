// Run inside the built image, e.g. pipe this script to docker run --rm -i
// agent-studio-mobile-qa:local node --input-type=module.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('hex');
process.env.AGENT_STUDIO_RELAY_TOKEN = token;
await import('./relay/start.ts');
const url = 'http://127.0.0.1:4317';
const html = await fetch(url);
assert.equal(html.status, 200);
assert.match(await html.text(), /manifest.webmanifest/);
const manifest = await (await fetch(url + '/manifest.webmanifest')).json();
assert.equal(manifest.display, 'standalone');
for (const icon of manifest.icons) {
  const response = await fetch(url + icon.src);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
}
assert.equal((await fetch(url + '/service-worker.js')).status, 200);
assert.equal((await fetch(url + '/v1/state')).status, 401);
assert.equal((await fetch(url + '/workspace.json')).status, 404);
assert.equal((await fetch(url + '/src/lib/domain.ts')).status, 404);
const actor = crypto.randomUUID();
const session = await fetch(url + '/v1/browser-session', {
  method: 'POST',
  headers: { origin: url, 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, environmentId: actor }),
});
assert.equal(session.status, 200);
const cookie = session.headers.get('set-cookie').split(';')[0];
assert.equal(
  (await fetch(url + '/v1/state', { headers: { cookie, 'x-environment-id': actor } })).status,
  200,
);
console.log('Container PWA, manifest, icons, worker, pairing and API boundaries passed.');
process.exit(0);
