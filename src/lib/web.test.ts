import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRelay } from '../../relay/server.ts';
const cleanups: (() => Promise<void>)[] = [];
it('loads the production relay with plain Node TypeScript resolution', () => {
  expect(() =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./relay/server.ts')"],
      { cwd: process.cwd(), stdio: 'pipe' },
    ),
  ).not.toThrow();
});
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'studio-web-'));
  const webDirectory = join(directory, 'public');
  mkdirSync(webDirectory);
  writeFileSync(join(webDirectory, 'index.html'), '<html>Agent Studio</html>');
  writeFileSync(join(webDirectory, '.secret.json'), 'private');
  let time = Date.now();
  const token = 'synthetic-pairing-key-for-browser-tests';
  const server = createRelay({ token, directory, webDirectory, now: () => time });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const actor = crypto.randomUUID();
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const pair = (origin = url) =>
    fetch(`${url}/v1/browser-session`, {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, environmentId: actor }),
    });
  return { url, actor, pair, advance: (ms: number) => (time += ms) };
}
it('serves only public build files and keeps API authentication and cross-origin boundaries', async () => {
  const f = await fixture();
  expect((await fetch(f.url)).status).toBe(200);
  for (const path of [
    '/.secret.json',
    '/workspace.json',
    '/../workspace.json',
    '/src/lib/domain.ts',
    '/unknown',
  ])
    expect((await fetch(f.url + path)).status).toBe(404);
  expect((await fetch(f.url + '/v1/state')).status).toBe(401);
  expect((await f.pair('https://another-site.example')).status).toBe(403);
  const paired = await f.pair();
  expect(paired.status).toBe(200);
  expect(paired.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-environment-id': f.actor };
  expect((await fetch(f.url + '/v1/state', { headers })).status).toBe(200);
  expect(
    (
      await fetch(f.url + '/v1/state', {
        headers: { ...headers, 'x-environment-id': crypto.randomUUID() },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(f.url + '/v1/state', { method: 'PUT', headers })).status).toBe(401);
  expect(
    (await fetch(f.url + '/v1/state', { headers: { ...headers, 'sec-fetch-site': 'cross-site' } }))
      .status,
  ).toBe(401);
  expect((await fetch(f.url + '/v1/jobs', { headers })).status).toBe(403);
  expect(
    (
      await fetch(f.url + '/v1/heartbeat', {
        method: 'POST',
        headers: { ...headers, origin: f.url },
        body: JSON.stringify({
          environmentId: f.actor,
          connections: [],
          running: [crypto.randomUUID()],
        }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(f.url + '/v1/browser-session', {
        method: 'DELETE',
        headers: { cookie, origin: f.url },
      })
    ).status,
  ).toBe(200);
  expect((await fetch(f.url + '/v1/state', { headers })).status).toBe(401);
});
it('expires browser sessions and rate limits pairing attempts', async () => {
  const f = await fixture();
  const response = await f.pair();
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  expect((await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).status).toBe(401);
  for (let i = 0; i < 10; i++) expect((await f.pair()).status).toBe(200);
  expect((await f.pair()).status).toBe(429);
});
