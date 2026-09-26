// The icon a linked site serves for itself, read here so a paired browser can mark links
// without loading anything from the sites a reply names: its window may load images from this
// origin alone. Only an origin goes out and bounded image data comes back; no workspace, chat
// or session data takes part, and readings stay in this process's memory.
import { lookup } from 'node:dns/promises';

/** A mark is one line high; larger downloads are never worth a link's icon. */
const MAX_ICON = 256 * 1024;
/** Only the beginning of a page is read, and only to find the icons it declares. */
const MAX_PAGE = 256 * 1024;
const KEEP_FOUND = 12 * 60 * 60 * 1000;
const KEEP_MISSING = 30 * 60 * 1000;
/** Readings kept at once, by count and by size, oldest first. */
const KEEP_ORIGINS = 500;
const KEEP_BYTES = 8 * 1024 * 1024;
const MAX_DECLARED = 3;
const MAX_REDIRECTS = 3;
const TIMEOUT = 8000;
const AGENT = 'AgentStudio';

/** The scheme, host and port of a link, without its path, query or credentials. */
export function siteOrigin(value: string): string | null {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin && url.origin !== 'null' ? url.origin : null;
}

/** The image type named by an icon's first bytes, so a page served instead is never one. */
export function iconType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0, 0, 1, 0)) return 'image/x-icon';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)
  )
    return 'image/webp';
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))
    ? 'image/svg+xml'
    : null;
}

/** The icon addresses a page declares, in document order. */
export function iconLinks(page: string): string[] {
  const found: string[] = [];
  for (const [tag] of page.split('</head>')[0].matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, 'rel');
    if (!rel?.split(/\s+/).some((word) => /^(icon|apple-touch-icon)$/i.test(word))) continue;
    const href = attribute(tag, 'href')?.trim().replace(/&amp;/g, '&');
    if (href && !href.startsWith('data:')) found.push(href);
    if (found.length === MAX_DECLARED) break;
  }
  return found;
}

function attribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i').exec(tag)?.[1];
  return value?.replace(/^(["'])(.*)\1$/s, '$2');
}

/** Private, loopback and link-local addresses: this server never reads its own network. */
export function publicAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
    const [a, b] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const value = address.toLowerCase().split('%')[0];
  if (value.startsWith('::ffff:')) return publicAddress(value.slice(7), 4);
  return !(
    value === '::' ||
    value === '::1' ||
    /^f[cd]/.test(value) ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('ff')
  );
}

export type SiteIcons = ReturnType<typeof siteIcons>;

export function siteIcons({
  now = Date.now,
  fetcher = fetch,
  resolve = lookup,
}: {
  now?: () => number;
  fetcher?: typeof fetch;
  resolve?: typeof lookup;
} = {}) {
  const readings = new Map<string, { icon: string | null; read: number }>();
  const reading = new Map<string, Promise<string | null>>();

  async function reachable(hostname: string) {
    try {
      const addresses = await resolve(hostname.replace(/^\[|\]$/g, ''), { all: true });
      return (
        addresses.length > 0 &&
        addresses.every(({ address, family }) => publicAddress(address, family))
      );
    } catch {
      return false;
    }
  }

  /** A response from a site, following its redirects only to addresses worth reading. */
  async function get(target: URL, accept: string) {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      if (!(await reachable(target.hostname))) return null;
      const response = await fetcher(target, {
        headers: { accept, 'user-agent': AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT),
      }).catch(() => null);
      if (!response) return null;
      const location =
        response.status >= 300 && response.status < 400 && response.headers.get('location');
      if (!location) return response.ok ? response : discard(response);
      discard(response);
      let next;
      try {
        next = new URL(location, target);
      } catch {
        return null;
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
      target = next;
    }
    return null;
  }

  function discard(response: Response) {
    void response.body?.cancel().catch(() => {});
    return null;
  }

  /** At most `limit` bytes. A `complete` read refuses an oversized file; a page keeps its head. */
  async function read(response: Response, limit: number, complete: boolean) {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > limit) {
          if (!complete) {
            chunks.push(value.subarray(0, limit - size));
            size = limit;
          }
          await reader.cancel();
          return complete ? null : Buffer.concat(chunks, size);
        }
        chunks.push(value);
        size += value.length;
      }
    } catch {
      return null;
    }
    return size ? Buffer.concat(chunks, size) : null;
  }

  async function image(url: URL) {
    const response = await get(url, 'image/*');
    const bytes = response && (await read(response, MAX_ICON, true));
    const kind = bytes && iconType(bytes);
    return kind ? `data:${kind};base64,${bytes.toString('base64')}` : null;
  }

  async function fetchIcon(origin: string) {
    const site = new URL(origin);
    const usual = await image(new URL('/favicon.ico', site));
    if (usual) return usual;
    const page = await get(site, 'text/html');
    const html = page && (await read(page, MAX_PAGE, false));
    if (!html) return null;
    for (const href of iconLinks(html.toString('utf8'))) {
      let url;
      try {
        url = new URL(href, site);
      } catch {
        continue;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const declared = await image(url);
      if (declared) return declared;
    }
    return null;
  }

  function remember(origin: string, icon: string | null) {
    readings.set(origin, { icon, read: now() });
    let bytes = 0;
    for (const reading of readings.values()) bytes += reading.icon?.length ?? 0;
    while (readings.size > KEEP_ORIGINS || bytes > KEEP_BYTES) {
      let oldest: [string, number] | undefined;
      for (const [key, reading] of readings)
        if (key !== origin && (!oldest || reading.read < oldest[1])) oldest = [key, reading.read];
      if (!oldest) break;
      bytes -= readings.get(oldest[0])?.icon?.length ?? 0;
      readings.delete(oldest[0]);
    }
  }

  return {
    /** The icon `origin` serves for itself as a data URL, or null when it serves none. */
    async icon(origin: string): Promise<string | null> {
      const kept = readings.get(origin);
      if (kept && now() - kept.read < (kept.icon ? KEEP_FOUND : KEEP_MISSING)) return kept.icon;
      const started = reading.get(origin);
      if (started) return started;
      const request = fetchIcon(origin)
        .catch(() => null)
        .then((icon) => {
          remember(origin, icon);
          reading.delete(origin);
          return icon;
        });
      reading.set(origin, request);
      return request;
    },
  };
}
