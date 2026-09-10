import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { browserSessions, publicFiles, servePublic } from './web.ts';
import { sharedSchema, emptyShared, type Presence, type RelayJob } from '../src/lib/sync.ts';

const uuid = z.string().uuid();
const jobInput = z.object({
  id: uuid,
  source: uuid,
  target: uuid,
  method: z.enum(['run', 'usage', 'models', 'title', 'folders', 'context']),
  args: z.record(z.string(), z.unknown()),
});
const presenceInput = z.object({
  environmentId: uuid,
  connections: z
    .array(
      z.object({
        connectionId: uuid,
        installed: z.boolean(),
        auth: z.enum(['ready', 'login', 'unknown']),
        detail: z.string().max(1000),
        version: z.string().max(100).nullable(),
      }),
    )
    .max(100),
  running: z.array(uuid).max(100),
});
const diskSchema = z.object({
  instanceId: uuid,
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  workspace: sharedSchema,
});
const terminal = (status: string) => ['complete', 'error', 'cancelled'].includes(status);
export function createRelay({
  token,
  directory,
  webDirectory,
  now = Date.now,
}: {
  token: string;
  directory: string;
  webDirectory?: string;
  now?: () => number;
}) {
  if (token.length < 32)
    throw new Error('AGENT_STUDIO_RELAY_TOKEN must have at least 32 characters.');
  const files = publicFiles(webDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sessions = browserSessions(token, now, directory);
  const file = join(directory, 'workspace.json');
  let state: z.infer<typeof diskSchema> = {
    instanceId: crypto.randomUUID(),
    version: 1 as const,
    revision: 0,
    workspace: emptyShared(),
  };
  try {
    state = diskSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Relay data is unreadable; preserved without overwriting.');
  }
  const peers = new Map<string, Presence>();
  const jobs = new Map<string, RelayJob & { created: number; updated: number }>();
  const save = (next: typeof state) => {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 20_000_000)
      throw new Error('Workspace exceeds the 20 MB relay limit.');
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o600 });
    const fd = openSync(temporary, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    state = next;
  };
  const expire = () => {
    for (const [id, job] of jobs) {
      if (
        !terminal(job.status) &&
        (now() - job.updated > 45_000 || now() - job.created > 360_000)
      ) {
        job.status = 'error';
        job.error =
          'The execution environment disconnected or the request expired. It will not be replayed automatically.';
        job.updated = now();
      }
      if (terminal(job.status) && now() - job.updated > 600_000) jobs.delete(id);
    }
  };
  async function body(req: IncomingMessage) {
    let length = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 20_000_000) throw new Error('Request exceeds the 20 MB limit.');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.url?.split('?')[0] === '/v1/browser-session') {
      try {
        await sessions.handle(req, res);
      } catch {
        send(503, { error: 'Browser session storage is unavailable. Please try again shortly.' });
      }
      return;
    }
    try {
      if (servePublic(req, res, files)) return;
    } catch {
      if (!res.headersSent)
        send(503, { error: 'The app build is unavailable. Restart the server after rebuilding.' });
      else res.end();
      return;
    }
    // Pairing key holders are trusted workspace members. No CORS or request logging.
    const supplied = Buffer.from(req.headers.authorization ?? ''),
      expected = Buffer.from(`Bearer ${token}`);
    const browserActor = sessions.actor(req);
    const bearer = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!bearer && !browserActor) {
      send(401, { error: 'Relay pairing key rejected.' });
      return;
    }
    const actor = req.headers['x-environment-id'];
    if (!bearer && actor !== browserActor) {
      send(403, { error: 'Device identity mismatch. Pair this device again.' });
      return;
    }
    if (!uuid.safeParse(actor).success) {
      send(400, { error: 'A valid environment identity is required.' });
      return;
    }
    expire();
    try {
      const url = new URL(req.url ?? '/', 'http://relay.local');
      if (url.pathname === '/v1/state' && req.method === 'GET') {
        send(200, state);
        return;
      }
      if (url.pathname === '/v1/state' && req.method === 'PUT') {
        const value = z
          .object({ revision: z.number().int().nonnegative(), workspace: sharedSchema })
          .parse(await body(req));
        if (value.revision !== state.revision) {
          send(409, state);
          return;
        }
        save({
          instanceId: state.instanceId,
          version: 1,
          revision: state.revision + 1,
          workspace: value.workspace,
        });
        send(200, state);
        return;
      }
      if (url.pathname === '/v1/heartbeat' && req.method === 'POST') {
        const value = presenceInput.parse(await body(req));
        if (!bearer && (value.connections.length || value.running.length)) {
          send(403, { error: 'Browser devices cannot execute agent jobs.' });
          return;
        }
        if (value.environmentId !== actor) {
          send(403, { error: 'Environment identity mismatch.' });
          return;
        }
        peers.set(value.environmentId, { ...value, seenAt: now(), online: true });
        for (const job of jobs.values())
          if (job.target === actor && job.status === 'running' && value.running.includes(job.id))
            job.updated = now();
        send(
          200,
          [...peers.values()].map((p) => ({ ...p, online: now() - p.seenAt < 15_000 })),
        );
        return;
      }
      if (url.pathname === '/v1/jobs' && req.method === 'POST') {
        const value = jobInput.parse(await body(req));
        if (value.source !== actor) {
          send(403, { error: 'Source identity mismatch.' });
          return;
        }
        const existing = jobs.get(value.id);
        if (existing) {
          if (
            existing.source !== actor ||
            existing.target !== value.target ||
            existing.method !== value.method ||
            JSON.stringify(existing.args) !== JSON.stringify(value.args)
          ) {
            send(409, { error: 'Request id already belongs to another operation.' });
            return;
          }
          send(200, existing);
          return;
        }
        if (!peers.has(value.target) || now() - peers.get(value.target)!.seenAt >= 15_000) {
          send(409, {
            code: 'host_offline',
            error:
              'That environment is offline. Open Agent Studio there and connect it to the relay.',
          });
          return;
        }
        if (jobs.size >= 500) {
          send(429, { error: 'Relay is busy. Try again later.' });
          return;
        }
        const job = {
          ...value,
          status: 'queued' as const,
          events: [],
          cancel: false,
          created: now(),
          updated: now(),
        };
        jobs.set(job.id, job);
        send(200, job);
        return;
      }
      if (url.pathname === '/v1/jobs' && req.method === 'GET') {
        if (!bearer) {
          send(403, { error: 'Browser devices cannot claim agent jobs.' });
          return;
        }
        // Claim once. Lost claims expire; retries never execute them again.
        const work = [...jobs.values()].filter((j) => j.target === actor && j.status === 'queued');
        for (const job of work) {
          job.status = 'running';
          job.updated = now();
        }
        send(200, work);
        return;
      }
      const match = url.pathname.match(/^\/v1\/jobs\/([a-f0-9-]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) {
          send(404, {
            error:
              'Request is no longer available. The relay may have restarted; check the executing device before retrying.',
          });
          return;
        }
        if (actor !== job.source && actor !== job.target && req.method !== 'GET' && !match[2]) {
          send(403, { error: 'Request belongs to another environment.' });
          return;
        }
        if (match[2] && req.method === 'POST') {
          job.cancel = true;
          if (job.status === 'queued') job.status = 'cancelled';
          send(200, job);
          return;
        }
        if (req.method === 'GET') {
          send(200, job);
          return;
        }
        if (req.method === 'PUT' && actor === job.target && !terminal(job.status)) {
          const update = z
            .object({
              status: z.enum(['running', 'complete', 'cancelled', 'error']),
              events: z.array(z.unknown()).max(384),
              result: z.unknown().optional(),
              error: z.string().max(4000).optional(),
            })
            .parse(await body(req));
          Object.assign(job, update, { updated: now() });
          send(200, job);
          return;
        }
      }
      send(404, { error: 'Unknown relay operation.' });
    } catch (e) {
      send(400, {
        error:
          e instanceof z.ZodError
            ? 'Invalid relay payload.'
            : e instanceof SyntaxError
              ? 'Invalid JSON.'
              : e instanceof Error
                ? e.message
                : 'Relay operation failed.',
      });
    }
  });
}
