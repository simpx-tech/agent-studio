import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import { iconLinks, iconType, publicAddress, siteIcons, siteOrigin } from '../../relay/icons.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]);
const HTML = '<!DOCTYPE html><html><body>Not found</body></html>';

type Reply = { status?: number; body?: Uint8Array | string | null; location?: string };

/** A fake web: each address answers once with what the test gives it. */
function web(pages: Record<string, Reply>, addresses: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetcher = (async (url: URL | string) => {
    const address = String(url);
    asked.push(address);
    const reply = pages[address];
    if (!reply) return new Response(null, { status: 404 });
    if (reply.location)
      return new Response(null, {
        status: reply.status ?? 302,
        headers: { location: reply.location },
      });
    return new Response((reply.body ?? null) as BodyInit | null, { status: reply.status ?? 200 });
  }) as typeof fetch;
  const resolve = (async (hostname: string) => [
    {
      address: addresses[hostname] ?? '93.184.216.34',
      family: addresses[hostname]?.includes(':') ? 6 : 4,
    },
  ]) as never;
  return { asked, fetcher, resolve };
}

describe('site icons on the relay', () => {
  it('keeps only the origin of an address a browser would open as a page', () => {
    expect(siteOrigin('https://en.wikipedia.org/wiki/Special:Random?a=1#top')).toBe(
      'https://en.wikipedia.org',
    );
    expect(siteOrigin('http://localhost:5173/app')).toBe('http://localhost:5173');
    expect(siteOrigin('https://user:secret@example.com/x')).toBe('https://example.com');
    expect(siteOrigin('HTTPS://Example.COM:443/x')).toBe('https://example.com');
    for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'no', ''])
      expect(siteOrigin(value), value).toBeNull();
  });

  it('names an icon by its bytes and refuses a page served instead', () => {
    expect(iconType(ICO)).toBe('image/x-icon');
    expect(iconType(PNG)).toBe('image/png');
    expect(iconType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(iconType(Buffer.from('RIFF1234WEBPVP8 '))).toBe('image/webp');
    expect(iconType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(iconType(Buffer.from("  <svg xmlns='x'/>"))).toBe('image/svg+xml');
    expect(iconType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe('image/svg+xml');
    expect(iconType(Buffer.from(HTML))).toBeNull();
    expect(iconType(new Uint8Array())).toBeNull();
  });

  it('reads the icons a page declares, in order', () => {
    expect(
      iconLinks(
        '<head><link rel="stylesheet" href="/app.css">' +
          '<link rel="mask-icon" href="/pinned.svg">' +
          "<link REL='Shortcut Icon' HREF='/Icons/Site.ico?v=2'>" +
          '<link rel="icon" type="image/png" href=/small.png sizes="16x16">' +
          '<link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">' +
          '<link rel="icon" href="/fourth.png"></head>' +
          '<body><link rel="icon" href="/body.png"></body>',
      ),
    ).toEqual(['/Icons/Site.ico?v=2', '/small.png', 'https://cdn.example.com/touch.png']);
    expect(
      iconLinks('<link rel=icon href="/i.png?a=1&amp;b=2"><link rel=icon href="data:,">'),
    ).toEqual(['/i.png?a=1&b=2']);
    expect(iconLinks('<link rel="icon">')).toEqual([]);
  });

  it('refuses its own network and keeps public addresses', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::'])
      expect(publicAddress(address, address.includes(':') ? 6 : 4), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.9.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ])
      expect(publicAddress(address, 4), address).toBe(false);
    for (const address of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1'])
      expect(publicAddress(address, 6), address).toBe(false);
  });

  it('reads the usual address first, then the icons a page declares', async () => {
    const declared = web({
      'https://site.example/favicon.ico': { status: 404 },
      'https://site.example/': { body: '<head><link rel="icon" href="/brand/icon.png"></head>' },
      'https://site.example/brand/icon.png': { body: PNG },
    });
    const icons = siteIcons(declared);
    expect(await icons.icon('https://site.example')).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
    expect(declared.asked).toEqual([
      'https://site.example/favicon.ico',
      'https://site.example/',
      'https://site.example/brand/icon.png',
    ]);
    const usual = web({ 'https://site.example/favicon.ico': { body: ICO } });
    expect(await siteIcons(usual).icon('https://site.example')).toContain(
      'data:image/x-icon;base64,',
    );
    expect(usual.asked).toEqual(['https://site.example/favicon.ico']);
  });

  it('never returns a page as an icon and never reads a private address', async () => {
    const page = web({
      'https://site.example/favicon.ico': { body: HTML },
      'https://site.example/': { body: HTML },
    });
    expect(await siteIcons(page).icon('https://site.example')).toBeNull();
    const redirected = web(
      {
        'https://site.example/favicon.ico': { location: 'http://router.local/admin.png' },
        'https://site.example/': { status: 500 },
        'http://router.local/admin.png': { body: PNG },
      },
      { 'router.local': '192.168.1.1' },
    );
    expect(await siteIcons(redirected).icon('https://site.example')).toBeNull();
    expect(redirected.asked).not.toContain('http://router.local/admin.png');
    const internal = web(
      { 'http://metadata/favicon.ico': { body: PNG } },
      { metadata: '169.254.169.254' },
    );
    expect(await siteIcons(internal).icon('http://metadata')).toBeNull();
    expect(internal.asked).toEqual([]);
  });

  it('refuses an oversized icon and reads only the beginning of a page', async () => {
    const huge = new Uint8Array(300 * 1024);
    huge.set(PNG);
    const long = '<head>' + ' '.repeat(300 * 1024) + '<link rel="icon" href="/late.png"></head>';
    const site = web({
      'https://site.example/favicon.ico': { body: huge },
      'https://site.example/': { body: long },
      'https://site.example/late.png': { body: PNG },
    });
    expect(await siteIcons(site).icon('https://site.example')).toBeNull();
    expect(site.asked).not.toContain('https://site.example/late.png');
  });

  it('keeps one reading per site, shares a read in flight and makes room for new ones', async () => {
    let time = 1_000_000;
    const site = web({ 'https://site.example/favicon.ico': { body: PNG } });
    const icons = siteIcons({ ...site, now: () => time });
    const [first, second] = await Promise.all([
      icons.icon('https://site.example'),
      icons.icon('https://site.example'),
    ]);
    expect(first).toBe(second);
    await icons.icon('https://site.example');
    expect(site.asked).toEqual(['https://site.example/favicon.ico']);
    // A site without an icon is asked again long before a found icon is read again.
    const missing = web({});
    const absent = siteIcons({ ...missing, now: () => time });
    expect(await absent.icon('https://none.example')).toBeNull();
    time += 31 * 60 * 1000;
    expect(await absent.icon('https://none.example')).toBeNull();
    expect(missing.asked.length).toBe(4);
    time += 12 * 60 * 60 * 1000;
    await icons.icon('https://site.example');
    expect(site.asked.length).toBe(2);
    // Large icons make room the same way, long before their count would.
    const large = Buffer.concat([PNG, Buffer.alloc(200 * 1024)]);
    const many = web(
      Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          `https://large${index}.example/favicon.ico`,
          { body: large },
        ]),
      ),
    );
    const kept = siteIcons({ ...many, now: () => time++ });
    for (let index = 0; index < 60; index++) await kept.icon(`https://large${index}.example`);
    await kept.icon('https://large0.example');
    expect(many.asked).toContain('https://large0.example/favicon.ico');
    expect(many.asked.filter((url) => url.includes('large0.')).length).toBe(2);
  });
});

describe('the relay icon route', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0)) await close();
  });

  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'studio-site-icons-'));
    const token = 'synthetic-site-icon-relay-pairing-key';
    const site = web({ 'https://site.example/favicon.ico': { body: PNG } });
    const server = createRelay({ token, directory, icons: siteIcons(site) });
    server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const actor = crypto.randomUUID();
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    const paired = await fetch(`${url}/v1/browser-session`, {
      method: 'POST',
      headers: { origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, environmentId: actor }),
    });
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    return { url, site, headers: { cookie, 'x-environment-id': actor } };
  }

  it('answers a paired browser with the icon and refuses anyone else', async () => {
    const f = await fixture();
    const icon = (origin: string, headers: Record<string, string> = f.headers) =>
      fetch(`${f.url}/v1/icon/${encodeURIComponent(origin)}`, { headers });
    const found = await icon('https://site.example/wiki/Page?a=1');
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      icon: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    });
    // Only the origin reaches the site, never the page a reply linked to.
    expect(f.site.asked).toEqual(['https://site.example/favicon.ico']);
    expect(found.headers.get('cache-control')).toBe('private, max-age=3600');
    expect((await icon('https://none.example')).status).toBe(200);
    expect(await (await icon('https://none.example')).json()).toEqual({ icon: null });
    for (const value of ['file:///etc/passwd', 'not a url', '%E0%A4%A'])
      expect((await icon(value)).status, value).toBe(400);
    // Reading an icon requires the browser's own session on this workspace.
    expect((await icon('https://site.example', {})).status).toBe(401);
    expect(
      (
        await icon('https://site.example', {
          ...f.headers,
          'x-environment-id': crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
  });
});
