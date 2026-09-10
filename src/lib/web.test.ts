import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  let server = createRelay({ token, directory, webDirectory, now: () => time });
  // Each request owns its socket: a restart must not reuse a dead pooled socket.
  server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
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
  const restart = async (key = token) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createRelay({ token: key, directory, webDirectory, now: () => time });
    server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(url).port), '127.0.0.1', resolve),
    );
  };
  return { url, actor, token, directory, pair, restart, advance: (ms: number) => (time += ms) };
}
it('serves only public build files and keeps API authentication and cross-origin boundaries', async () => {
  const f = await fixture();
  expect((await fetch(f.url)).status).toBe(200);
  for (const path of [
    '/.secret.json',
    '/workspace.json',
    '/browser-sessions.json',
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

it('keeps paired devices across restarts, renews active sessions, and persists disconnects', async () => {
  const f = await fixture();
  const response = await f.pair();
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const headers = { cookie, 'x-environment-id': f.actor };
  const file = join(f.directory, 'browser-sessions.json');
  const stored = readFileSync(file, 'utf8');
  expect(stored).not.toContain(f.token);
  expect(stored).not.toContain(cookie.split('=')[1]);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  const hash = JSON.parse(stored).sessions[0][0];
  expect(
    (
      await fetch(f.url + '/v1/state', {
        headers: { ...headers, cookie: `agent_studio_session=${hash}` },
      })
    ).status,
  ).toBe(401);
  await f.restart();
  expect((await fetch(f.url + '/v1/state', { headers })).status).toBe(200);
  f.advance(6 * 24 * 60 * 60 * 1000);
  const renewed = await fetch(f.url + '/v1/browser-session', { headers });
  expect(renewed.status).toBe(200);
  expect(renewed.headers.get('set-cookie')).toContain('Max-Age=604800');
  await f.restart();
  f.advance(6 * 24 * 60 * 60 * 1000);
  expect((await fetch(f.url + '/v1/state', { headers })).status).toBe(200);
  expect(
    (
      await fetch(f.url + '/v1/browser-session', {
        method: 'DELETE',
        headers: { ...headers, origin: f.url },
      })
    ).status,
  ).toBe(200);
  await f.restart();
  expect((await fetch(f.url + '/v1/state', { headers })).status).toBe(401);
});

it('revokes persisted sessions when the pairing key changes, including when the old key returns', async () => {
  const f = await fixture();
  const response = await f.pair();
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  await f.restart('replacement-synthetic-pairing-key-12345');
  expect((await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).status).toBe(401);
  await f.restart();
  expect((await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).status).toBe(401);
});

it('preserves unreadable session data and fails startup instead of silently losing pairing', async () => {
  const f = await fixture();
  const file = join(f.directory, 'browser-sessions.json');
  writeFileSync(file, 'unreadable session data');
  expect(() => createRelay({ token: f.token, directory: f.directory })).toThrow(
    'Browser session data is unreadable',
  );
  expect(readFileSync(file, 'utf8')).toBe('unreadable session data');
});

it('retains a session when persisting a disconnect fails', async () => {
  const f = await fixture();
  const response = await f.pair();
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  mkdirSync(join(f.directory, 'browser-sessions.json.tmp'));
  const result = await fetch(f.url + '/v1/browser-session', {
    method: 'DELETE',
    headers: { cookie, origin: f.url },
  });
  expect(result.status).toBe(503);
  expect(result.headers.get('set-cookie')).toBeNull();
  const failedPair = await f.pair();
  expect(failedPair.status).toBe(503);
  expect(failedPair.headers.get('set-cookie')).toBeNull();
  expect((await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).status).toBe(200);
});

it('retains Secure cookies on renewal after restart and expires inactive persisted sessions', async () => {
  const f = await fixture();
  const response = await f.pair(f.url.replace('http:', 'https:'));
  expect(response.headers.get('set-cookie')).toContain('; Secure');
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  await f.restart();
  f.advance(2 * 24 * 60 * 60 * 1000);
  const renewed = await fetch(f.url + '/v1/browser-session', { headers: { cookie } });
  expect(renewed.headers.get('set-cookie')).toContain(
    'HttpOnly; SameSite=Strict; Max-Age=604800; Secure',
  );
  expect(
    (await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).headers.get('set-cookie'),
  ).toBeNull();
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  await f.restart();
  expect((await fetch(f.url + '/v1/browser-session', { headers: { cookie } })).status).toBe(401);
});
