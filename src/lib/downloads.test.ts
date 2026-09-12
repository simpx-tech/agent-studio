import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import { browserDevice, windowsInstallerName, windowsInstallerUrl } from './installation';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(configured = true) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-downloads-'));
  const downloadsDirectory = join(directory, 'packages');
  mkdirSync(downloadsDirectory);
  const server = createRelay({
    token: 'synthetic-installer-test-workspace-key',
    directory: join(directory, 'private'),
    downloadsDirectory: configured ? downloadsDirectory : undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { url, downloadsDirectory };
}
it('streams only the published installer without authentication or shell caching', async () => {
  const f = await fixture();
  const bytes = Buffer.from('MZ synthetic installer fixture');
  writeFileSync(join(f.downloadsDirectory, windowsInstallerName), bytes);
  writeFileSync(join(f.downloadsDirectory, 'workspace.json'), 'private fixture');
  const manifest = await fetch(f.url + '/downloads/manifest.json');
  expect(await manifest.json()).toEqual({ windows: true });
  expect(manifest.headers.get('cache-control')).toBe('no-store');
  const downloaded = await fetch(f.url + windowsInstallerUrl);
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(downloaded.headers.get('content-disposition')).toBe(
    `attachment; filename="${windowsInstallerName}"`,
  );
  expect(downloaded.headers.get('cache-control')).toBe('no-store');
  expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
  const head = await fetch(f.url + windowsInstallerUrl, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(bytes.length));
  expect(await head.text()).toBe('');
  for (const path of [
    '/downloads/workspace.json',
    '/downloads/../private/workspace.json',
    '/downloads/%2e%2e%2fprivate/workspace.json',
    '/downloads/other.exe',
  ])
    expect((await fetch(f.url + path)).status).toBe(404);
  expect((await fetch(f.url + windowsInstallerUrl, { method: 'POST' })).status).toBe(405);
  expect((await fetch(f.url + '/v1/state')).status).toBe(401);
});
it('does not advertise missing, empty or non-file installers', async () => {
  const f = await fixture();
  const available = async () => (await fetch(f.url + '/downloads/manifest.json')).json();
  expect(await available()).toEqual({ windows: false });
  expect((await fetch(f.url + windowsInstallerUrl)).status).toBe(404);
  writeFileSync(join(f.downloadsDirectory, windowsInstallerName), '');
  expect(await available()).toEqual({ windows: false });
  rmSync(join(f.downloadsDirectory, windowsInstallerName));
  mkdirSync(join(f.downloadsDirectory, windowsInstallerName));
  expect(await available()).toEqual({ windows: false });
  const unconfigured = await fixture(false);
  expect(await (await fetch(unconfigured.url + '/downloads/manifest.json')).json()).toEqual({
    windows: false,
  });
});
it('keeps desktop download choices off phones and iPads without hiding them on touch laptops', () => {
  expect(browserDevice('Mozilla Windows NT 10.0', 'Win32', 10)).toBe('windows');
  expect(browserDevice('Mozilla Macintosh Intel Mac OS X', 'MacIntel', 5)).toBe('mobile');
  expect(browserDevice('Mozilla iPhone Mobile Safari', 'iPhone', 5)).toBe('mobile');
  expect(browserDevice('Mozilla Linux Android 14', 'Linux', 5)).toBe('mobile');
  expect(browserDevice('Mozilla Macintosh Intel Mac OS X', 'MacIntel', 0)).toBe('desktop');
  expect(browserDevice('Mozilla X11 Linux x86_64', 'Linux', 0)).toBe('desktop');
});
