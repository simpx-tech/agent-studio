import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { sessionStore } from './sessions.ts';
import { artifactPreviewHtml, artifactPreviewHeaders } from './artifact-preview.ts';

const cookieName = 'agent_studio_session';
const lifetime = 7 * 24 * 60 * 60 * 1000;
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Snapshot an allowlist at startup. Only the public build tree can be served,
// never relay data, source files, dotfiles, symlinks or arbitrary SPA paths.
export function publicFiles(directory?: string) {
  const files = new Map<string, string>();
  if (!directory) return files;
  const root = realpathSync(directory);
  function visit(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && mime[extname(path)])
        files.set('/' + relative(root, path).split(sep).join('/'), path);
    }
  }
  visit(root);
  if (!files.has('/index.html'))
    throw new Error('PWA build is missing index.html. Run npm run build.');
  files.set('/', resolve(root, 'index.html'));
  return files;
}

export function servePublic(req: IncomingMessage, res: ServerResponse, files: Map<string, string>) {
  if (req.url === '/artifact-preview' && ['GET', 'HEAD'].includes(req.method ?? '')) {
    res.writeHead(200, artifactPreviewHeaders);
    res.end(req.method === 'HEAD' ? undefined : artifactPreviewHtml);
    return true;
  }
  if (req.url?.startsWith('/v1/') || req.url === '/v1') return false;
  const path = (req.url ?? '/').split('?')[0];
  const file = files.get(path);
  if (!file || !['GET', 'HEAD'].includes(req.method ?? '')) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file)],
    'Content-Length': statSync(file).size,
    'Cache-Control': path.startsWith('/_app/immutable/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  return true;
}

export function browserSessions(token: string, now: () => number, directory: string) {
  const sessions = sessionStore(directory, token, now);
  const attempts = new Map<string, { count: number; expires: number }>();
  const validKey = (key: string) => {
    const supplied = Buffer.from(key),
      expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const sessionId = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + '='))
      ?.slice(cookieName.length + 1) ?? '';
  function sameOrigin(req: IncomingMessage) {
    try {
      const origin = new URL(req.headers.origin ?? '');
      return (
        origin.host === req.headers.host &&
        (origin.protocol === 'https:' ||
          (origin.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
      );
    } catch {
      return false;
    }
  }
  function actor(req: IncomingMessage) {
    const session = sessions.get(sessionId(req));
    if (!session || session.expires <= now()) return undefined;
    if (req.headers['sec-fetch-site'] === 'cross-site') return undefined;
    if (!['GET', 'HEAD'].includes(req.method ?? '') && !sameOrigin(req)) return undefined;
    return session.actor;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET') {
      const environmentId = actor(req);
      const id = sessionId(req);
      const session = sessions.get(id);
      // Keep actively used devices paired, with at most one durable renewal per day.
      if (environmentId && session && session.expires - now() <= lifetime - 24 * 60 * 60 * 1000) {
        sessions.replace(id, id, { ...session, expires: now() + lifetime });
        res.setHeader(
          'Set-Cookie',
          `${cookieName}=${id}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}${session.secure ? '; Secure' : ''}`,
        );
      }
      send(
        environmentId ? 200 : 401,
        environmentId ? { environmentId } : { error: 'Pair this device to connect.' },
      );
      return;
    }
    if (!sameOrigin(req)) {
      send(403, { error: 'Open the PWA on this server over HTTPS.' });
      return;
    }
    const secure = req.headers.origin?.startsWith('https:') ? '; Secure' : '';
    if (req.method === 'DELETE') {
      sessions.replace(sessionId(req));
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      );
      send(200, { disconnected: true });
      return;
    }
    if (req.method !== 'POST') {
      send(405, { error: 'Method not allowed.' });
      return;
    }
    for (const [id, value] of attempts) if (value.expires <= now()) attempts.delete(id);
    const address = req.socket.remoteAddress ?? 'unknown';
    const attempt = attempts.get(address) ?? { count: 0, expires: now() + 60_000 };
    if (attempt.count >= 10 || attempts.size >= 10_000 || sessions.size() >= 1000) {
      send(429, { error: 'Too many pairing attempts. Try again in a minute.' });
      return;
    }
    attempt.count++;
    attempts.set(address, attempt);
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) throw new Error('Invalid pairing request.');
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof value.token !== 'string' || !validKey(value.token)) {
        send(401, { error: 'Relay pairing key rejected.' });
        return;
      }
      if (
        typeof value.environmentId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.environmentId)
      ) {
        send(400, { error: 'A valid device identity is required.' });
        return;
      }
      const id = randomBytes(32).toString('hex');
      try {
        sessions.replace(sessionId(req), id, {
          actor: value.environmentId,
          expires: now() + lifetime,
          secure: !!secure,
        });
      } catch {
        send(503, { error: 'Browser session storage is unavailable. Please try again shortly.' });
        return;
      }
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=${id}; Path=/v1; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}${secure}`,
      );
      send(200, { environmentId: value.environmentId });
    } catch {
      send(400, { error: 'Invalid pairing request.' });
    }
  }
  return {
    actor,
    handle,
    identity: (req: IncomingMessage) => sessions.identity(sessionId(req)),
    active: sessions.active,
  };
}
