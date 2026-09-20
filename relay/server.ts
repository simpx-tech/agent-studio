import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { sessionStore } from './sessions.ts';
import { workspaceRegistry, WorkspaceAdminError, type RelayWorkspace } from './workspaces.ts';
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
import { serveDownloads } from './downloads.ts';
import { sharedSchema, emptyShared, type Presence, type RelayJob } from '../src/lib/sync.ts';
import { runTimeoutMs } from '../src/lib/workflows.ts';
import { pushService, type PushSender } from './push.ts';
import { pendingChatCount } from '../src/lib/notifications.ts';
import { answerSchema } from '../src/lib/questions.ts';
import { elicitationInputSchema } from '../src/lib/elicitations.ts';
import { steeringInputSchema } from '../src/lib/steering.ts';
import { mcpRequestSchema } from '../src/lib/mcp.ts';
import { pluginRequestSchema } from '../src/lib/plugins.ts';

const uuid = z.string().uuid();
const jobInput = z
  .object({
    id: uuid,
    source: uuid,
    target: uuid,
    method: z.enum([
      'run',
      'usage',
      'models',
      'title',
      'folders',
      'context',
      'nativeInstructions',
      'mcp',
      'plugins',
      'answer',
      'elicitation',
      'steer',
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .superRefine((job, ctx) => {
    if (job.method === 'plugins' && !pluginRequestSchema.safeParse(job.args).success)
      ctx.addIssue({ code: 'custom', message: 'Invalid plugin management request' });
    if (
      job.method === 'elicitation' &&
      !z
        .object({ runId: uuid, connectionId: uuid, input: elicitationInputSchema })
        .strict()
        .safeParse(job.args).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid MCP input request' });
    if (job.method === 'mcp' && !mcpRequestSchema.safeParse(job.args).success)
      ctx.addIssue({ code: 'custom', message: 'Invalid MCP management request' });
    if (
      job.method === 'steer' &&
      !z
        .object({ runId: uuid, connectionId: uuid, input: steeringInputSchema })
        .strict()
        .safeParse(job.args).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid steering request' });
    if (
      job.method === 'nativeInstructions' &&
      !z
        .object({
          conversationId: uuid,
          provider: z.enum(['claude', 'codex', 'gemini']),
          connectionId: uuid,
        })
        .strict()
        .safeParse(job.args).success
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid native instruction request' });
    }
    if (
      job.method === 'answer' &&
      !z
        .object({ runId: uuid, connectionId: uuid, answer: answerSchema })
        .strict()
        .safeParse(job.args).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid question response' });
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
  downloadsDirectory,
  now = Date.now,
  pushSender,
}: {
  token: string;
  directory: string;
  webDirectory?: string;
  downloadsDirectory?: string;
  now?: () => number;
  pushSender?: PushSender;
}) {
  if (token.length < 32)
    throw new Error('AGENT_STUDIO_RELAY_TOKEN must have at least 32 characters.');
  const files = publicFiles(webDirectory);
  const registry = workspaceRegistry(directory, token);
  const contexts = new Map<string, ReturnType<typeof createContext>>();
  function createContext(workspace: RelayWorkspace) {
    const { directory, secret: token } = workspace;
    let retired = false;
    const active = () => {
      try {
        return !retired && registry.active(workspace);
      } catch {
        return false;
      }
    };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sessions = sessionStore(directory, token, now);
    const push = pushService({
      directory,
      token,
      now,
      active,
      sessionActive: (identity) => active() && sessions.active(identity),
      send: pushSender,
      pendingCount: () =>
        pendingChatCount(
          state.workspace.conversations,
          new Map(
            [...jobs.values()]
              .filter((job) => job.method === 'run')
              .map((job) => [job.id, job.status]),
          ),
        ),
    });
    const file = join(directory, 'workspace.json');
    let state: z.infer<typeof diskSchema> = {
      instanceId: crypto.randomUUID(),
      version: 1 as const,
      revision: 0,
      workspace: emptyShared(),
    };
    let fresh = false;
    try {
      state = diskSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Relay data is unreadable; preserved without overwriting.');
      fresh = true;
    }
    const peers = new Map<string, Presence>();
    const jobs = new Map<string, RelayJob & { created: number; updated: number }>();
    const jobBytes = new Map<string, number>();
    const reserveJob = (job: RelayJob) => {
      const bytes = Buffer.byteLength(JSON.stringify(job));
      const total = [...jobBytes.values()].reduce((sum, size) => sum + size, 0);
      if (total - (jobBytes.get(job.id) ?? 0) + bytes > 40_000_000) return false;
      jobBytes.set(job.id, bytes);
      return true;
    };
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
    // A paired but empty relay must retain its identity before the first workspace edit.
    if (fresh) save(state);
    const expire = () => {
      for (const [id, job] of jobs) {
        if (
          !terminal(job.status) &&
          (now() - job.updated > 45_000 ||
            now() - job.created >
              (job.method === 'plugins'
                ? 660_000
                : runTimeoutMs(
                    job.method === 'run'
                      ? (job.args.request as { agent?: { provider?: unknown } })?.agent?.provider
                      : undefined,
                  )))
        ) {
          job.status = 'error';
          job.error =
            'The execution environment disconnected or the request expired. It will not be replayed automatically.';
          job.updated = now();
          push.jobUpdated(job);
        }
        if (terminal(job.status) && now() - job.updated > 600_000) {
          jobs.delete(id);
          jobBytes.delete(id);
        }
      }
      for (const [id, peer] of peers)
        if (now() - peer.seenAt > 24 * 60 * 60 * 1000) peers.delete(id);
    };
    async function body(
      req: IncomingMessage,
      authorized: () => boolean,
      limit = 20_000_000,
      allowEmpty = false,
    ) {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > limit) throw new Error('Request exceeds its size limit.');
        chunks.push(chunk);
      }
      if (!authorized()) throw new Error('Workspace access was revoked. Pair this device again.');
      if (allowEmpty && length === 0) return {};
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    async function handle(
      req: IncomingMessage,
      res: ServerResponse,
      bearer: boolean,
      browserActor: string | undefined,
      sessionIdentity: string | undefined,
    ) {
      const send = (code: number, data: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };
      const actor = req.headers['x-environment-id'];
      const authorized = () =>
        active() && (bearer || (!!sessionIdentity && sessions.active(sessionIdentity)));
      if (!authorized()) {
        send(401, { error: 'Workspace access was revoked. Pair this device again.' });
        return;
      }
      expire();
      try {
        const url = new URL(req.url ?? '/', 'http://relay.local');
        if (
          url.pathname === '/v1/workspace-admin' ||
          url.pathname.startsWith('/v1/workspace-admin/')
        ) {
          try {
            if (url.search)
              throw new WorkspaceAdminError(
                400,
                'invalid_admin_payload',
                'Workspace administration does not accept query parameters.',
              );
            const capability = registry.administration(workspace);
            if (url.pathname === '/v1/workspace-admin' && req.method === 'GET') {
              send(200, capability);
              return;
            }
            if (capability.role !== 'admin')
              throw new WorkspaceAdminError(
                403,
                'admin_required',
                'An administrator role is required to manage workspaces.',
              );
            if (url.pathname === '/v1/workspace-admin/workspaces' && req.method === 'POST') {
              const input = await body(req, authorized, 4096);
              send(201, registry.adminCreate(workspace, authorized, input, now));
              return;
            }
            const match = url.pathname.match(
              /^\/v1\/workspace-admin\/workspaces\/(owner|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(?:\/(rotate|disable))?$/,
            );
            if (!match) {
              send(404, { error: 'Unknown workspace administration operation.' });
              return;
            }
            if (!match[2] && req.method === 'PUT') {
              const input = await body(req, authorized, 4096);
              send(200, registry.adminEdit(workspace, authorized, match[1], input));
              return;
            }
            if (match[2] && req.method === 'POST') {
              z.object({})
                .strict()
                .parse(await body(req, authorized, 4096, true));
              send(
                200,
                match[2] === 'rotate'
                  ? registry.adminRotate(workspace, authorized, match[1])
                  : registry.adminDisable(workspace, authorized, match[1]),
              );
              return;
            }
            send(405, { error: 'Method not allowed.' });
          } catch (error) {
            if (!authorized())
              send(401, {
                code: 'workspace_revoked',
                error: 'Workspace access was revoked. Pair this device again.',
              });
            else if (error instanceof WorkspaceAdminError)
              send(error.status, { code: error.code, error: error.message });
            else if (
              error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              (error instanceof Error && error.message === 'Request exceeds its size limit.')
            )
              send(400, {
                code: 'invalid_admin_payload',
                error: 'Invalid workspace administration request.',
              });
            else
              send(503, {
                error: 'Workspace administration storage is unavailable. Please try again shortly.',
              });
          }
          return;
        }
        if (url.pathname === '/v1/notification-view' && req.method === 'POST') {
          const value = z
            .object({
              viewId: uuid,
              revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              conversationId: uuid.nullable(),
            })
            .strict()
            .parse(await body(req, authorized, 1024));
          push.view(
            `${sessionIdentity ?? actor}:${value.viewId}`,
            value.revision,
            value.conversationId,
            sessionIdentity,
          );
          send(200, { ok: true });
          return;
        }
        if (url.pathname === '/v1/push' || url.pathname === '/v1/push/test') {
          if (!browserActor || actor !== browserActor) {
            send(403, { error: 'Manage notifications from the paired browser on this device.' });
            return;
          }
          const session = sessionIdentity!;
          try {
            if (url.pathname === '/v1/push/test' && req.method === 'POST') {
              push.test(session);
              send(202, { queued: true });
            } else if (url.pathname === '/v1/push' && req.method === 'GET') {
              send(200, push.status(session));
            } else if (url.pathname === '/v1/push' && req.method === 'PUT') {
              push.subscribe(
                session,
                browserActor,
                await body(req, authorized, 8192),
                req.headers.origin!,
              );
              send(200, push.status(session));
            } else if (url.pathname === '/v1/push' && req.method === 'DELETE') {
              push.unsubscribe(session);
              send(200, { enabled: false });
            } else send(405, { error: 'Method not allowed.' });
          } catch (error) {
            if (!authorized()) throw error;
            send(400, {
              error:
                error instanceof z.ZodError
                  ? 'Invalid push subscription.'
                  : error instanceof Error &&
                      /^(Enable notifications|Wait 30 seconds|Notification device limit)/.test(
                        error.message,
                      )
                    ? error.message
                    : 'Notification settings could not be saved. Please try again.',
            });
          }
          return;
        }
        if (url.pathname === '/v1/state' && req.method === 'GET') {
          send(200, { ...state, workspaceId: workspace.id });
          return;
        }
        if (url.pathname === '/v1/state' && req.method === 'PUT') {
          const value = z
            .object({ revision: z.number().int().nonnegative(), workspace: sharedSchema })
            .parse(await body(req, authorized));
          if (value.revision !== state.revision) {
            send(409, { ...state, workspaceId: workspace.id });
            return;
          }
          const previous = state.workspace;
          save({
            instanceId: state.instanceId,
            version: 1,
            revision: state.revision + 1,
            workspace: value.workspace,
          });
          push.changed(previous, state.workspace);
          send(200, { ...state, workspaceId: workspace.id });
          return;
        }
        if (url.pathname === '/v1/heartbeat' && req.method === 'POST') {
          const value = presenceInput.parse(await body(req, authorized, 128_000));
          if (!bearer && (value.connections.length || value.running.length)) {
            send(403, { error: 'Browser devices cannot execute agent jobs.' });
            return;
          }
          if (value.environmentId !== actor) {
            send(403, { error: 'Environment identity mismatch.' });
            return;
          }
          if (!peers.has(value.environmentId) && peers.size >= 1000) {
            send(429, { error: 'Workspace device limit reached. Try again later.' });
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
          const value = jobInput.parse(await body(req, authorized));
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
          if (!reserveJob(job)) {
            send(429, { error: 'Workspace request storage is busy. Try again later.' });
            return;
          }
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
          const work = [...jobs.values()].filter(
            (j) => j.target === actor && j.status === 'queued',
          );
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
            push.jobUpdated(job);
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
                events: z.array(z.unknown()).max(448),
                result: z.unknown().optional(),
                error: z.string().max(4000).optional(),
              })
              .parse(await body(req, authorized));
            const next = { ...job, ...update, updated: now() };
            if (!reserveJob(next)) {
              send(429, { error: 'Workspace request storage is busy. Try again later.' });
              return;
            }
            Object.assign(job, next);
            push.jobUpdated(job);
            send(200, job);
            return;
          }
        }
        send(404, { error: 'Unknown relay operation.' });
      } catch (e) {
        if (!authorized()) {
          send(401, { error: 'Workspace access was revoked. Pair this device again.' });
          return;
        }
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
    }
    return {
      workspace,
      sessions,
      push,
      expire,
      handle,
      active,
      retire: () => {
        retired = true;
      },
    };
  }
  function context(workspace: RelayWorkspace) {
    const previous = contexts.get(workspace.id);
    if (previous?.workspace.secret === workspace.secret) return previous;
    previous?.retire();
    const next = createContext(workspace);
    contexts.set(workspace.id, next);
    return next;
  }
  // Preserve owner data and fail startup on unreadable existing data.
  context(registry.owner);
  // Restore independent retry queues even before a user's browser reconnects.
  // A damaged user's files remain unavailable without preventing other users
  // from connecting; their next request reports the storage failure.
  for (const workspace of registry.list()) {
    try {
      context(workspace);
    } catch {
      /* Preserve unreadable private data. */
    }
  }
  const sessions = browserSessions(registry, (workspace) => context(workspace).sessions, now);
  const server = createServer(async (req, res) => {
    const send = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.url?.split('?')[0] === '/v1/browser-session') {
        await sessions.handle(req, res);
        return;
      }
      if (serveDownloads(req, res, downloadsDirectory) || servePublic(req, res, files)) return;
      // A supplied bearer must authenticate on its own; an invalid key never
      // borrows the browser cookie's authority. Conflicting credentials reject.
      const authorization = req.headers.authorization;
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      const bearerWorkspace = authorization === undefined ? undefined : registry.authenticate(key);
      if (authorization !== undefined && !bearerWorkspace) {
        send(401, { error: 'Relay pairing key rejected.' });
        return;
      }
      const browser = sessions.authenticated(req);
      if (bearerWorkspace && browser && bearerWorkspace.id !== browser.workspace.id) {
        send(403, { error: 'Conflicting workspace credentials.' });
        return;
      }
      const workspace = bearerWorkspace ?? browser?.workspace;
      if (!workspace) {
        send(401, { error: 'Relay pairing key rejected.' });
        return;
      }
      if (!sessions.matches(req, workspace, !!bearerWorkspace)) {
        send(409, {
          code: 'workspace_changed',
          error: 'This browser is now paired with a different workspace. Reload to continue.',
        });
        return;
      }
      const actor = req.headers['x-environment-id'];
      const browserActor = browser?.session.actor;
      if (!bearerWorkspace && actor !== browserActor) {
        send(403, { error: 'Device identity mismatch. Pair this device again.' });
        return;
      }
      if (!uuid.safeParse(actor).success) {
        send(400, { error: 'A valid environment identity is required.' });
        return;
      }
      await context(workspace).handle(
        req,
        res,
        !!bearerWorkspace,
        browserActor,
        browser?.sessions.identity(browser.id),
      );
    } catch {
      if (!res.headersSent)
        send(503, { error: 'Relay storage is unavailable. Please try again shortly.' });
      else res.end();
    }
  });
  let pushTimer: ReturnType<typeof setInterval>;
  const drain = () => {
    for (const [id, current] of contexts) {
      if (!current.active()) {
        current.retire();
        contexts.delete(id);
        continue;
      }
      current.expire();
      void current.push.drain();
    }
  };
  server.on('listening', () => {
    drain();
    pushTimer = setInterval(drain, 10_000);
    pushTimer.unref();
  });
  server.on('close', () => {
    clearInterval(pushTimer);
    for (const current of contexts.values()) current.retire();
  });
  return server;
}
