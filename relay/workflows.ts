/**
 * The workspace's workflow store on the relay (docs/WORKFLOWS.md): definitions and runs that
 * every device of the workspace reads and writes, kept in the workspace's own data directory so
 * a run goes on while any one computer is off. The store itself is src/lib/workflow-store.ts.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { workflowStore, type StoreFiles, type WorkflowStore } from '../src/lib/workflow-store.ts';
import {
  deliveryRunId,
  nodeConfig,
  readDefinition,
  triggerOf,
} from '../src/lib/workflow-model.ts';

export function directoryFiles(root: string): StoreFiles {
  const path = (name: string) => {
    if (!/^[a-z]+(-[0-9a-f-]{36}(-\d+)?)?\.json$/.test(name)) throw new Error('Invalid name.');
    return join(root, name);
  };
  return {
    async read(name) {
      try {
        return readFileSync(path(name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(name, text) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const target = path(name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o600 });
        const fd = openSync(temporary, 'r+');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    async remove(name) {
      rmSync(path(name), { force: true });
    },
    async names() {
      try {
        return readdirSync(root).filter((name) => name.endsWith('.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

export const relayWorkflows = (directory: string, now: () => number): WorkflowStore =>
  workflowStore(directoryFiles(join(directory, 'workflows')), now);

const uuid = z.string().uuid();
const count = z.number().int().nonnegative();
const eventInput = z
  .object({
    kind: z.string().min(1),
    text: z.string(),
    at: z.string().optional(),
  })
  .loose();
const inputs = {
  list: z.object({ since: count.optional() }).strict(),
  read: z.object({ ids: z.array(uuid), events: z.record(uuid, count).optional() }).strict(),
  put: z
    .object({
      kind: z.enum(['definition', 'run']),
      expected: count.nullable(),
      body: z.record(z.string(), z.unknown()),
      events: z.array(eventInput).optional(),
    })
    .strict(),
  remove: z.object({ expected: count }).strict(),
  lease: z
    .object({
      holder: uuid,
      ttlMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60 * 1000),
      release: z.boolean().optional(),
    })
    .strict(),
};

/** An alert a run raised, which paired phones hear once. */
export type RunAlert = {
  id: string;
  kind: 'question' | 'notify' | 'completed' | 'failed';
  title: string;
  text: string;
  at: string;
};
const alertSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['question', 'notify', 'completed', 'failed']),
  title: z.string(),
  text: z.string(),
  at: z.string(),
});
/** The alerts of a run body raised in the last ten minutes, for a write that just arrived. */
export function recentAlerts(body: Record<string, unknown>, now: number): RunAlert[] {
  const list = Array.isArray(body.alerts) ? body.alerts : [];
  return list
    .map((alert) => alertSchema.safeParse(alert).data)
    .filter((alert): alert is RunAlert => {
      const at = alert ? Date.parse(alert.at) : NaN;
      return !!alert && Number.isFinite(at) && at > now - 600_000 && at < now + 60_000;
    });
}

/**
 * Answers `v1/workflows/…`, or returns false for any other path. `holder` names the device
 * asking, which may hold a lease only for itself and only as a desktop.
 */
export async function handleWorkflows({
  method,
  path,
  body,
  store,
  actor,
  desktop,
  send,
  written,
}: {
  method: string;
  path: string;
  body: () => Promise<unknown>;
  store: WorkflowStore;
  actor: string;
  desktop: boolean;
  send: (code: number, data: unknown) => void;
  written?: (id: string, kind: string, body: Record<string, unknown>) => void;
}): Promise<boolean> {
  if (path === '/v1/workflows/list' && method === 'POST') {
    const value = inputs.list.parse(await body());
    send(200, await store.list(value.since ?? 0));
    return true;
  }
  if (path === '/v1/workflows/read' && method === 'POST') {
    const value = inputs.read.parse(await body());
    send(200, await store.read(value.ids, value.events ?? {}));
    return true;
  }
  const match = path.match(/^\/v1\/workflows\/([0-9a-f-]{36})(?:\/(delete|lease))?$/);
  if (!match || !uuid.safeParse(match[1]).success) return false;
  const id = match[1];
  if (!match[2] && method === 'PUT') {
    const value = inputs.put.parse(await body());
    const result = await store.put({ id, ...value });
    if (result.ok) written?.(id, value.kind, value.body);
    send(result.ok ? 200 : 409, result);
    return true;
  }
  if (match[2] === 'delete' && method === 'POST') {
    const value = inputs.remove.parse(await body());
    const result = await store.remove(id, value.expected);
    send(result.ok ? 200 : 409, result);
    return true;
  }
  if (match[2] === 'lease' && method === 'POST') {
    const value = inputs.lease.parse(await body());
    // Only a desktop drives a run, and only in its own name.
    if (!desktop || value.holder !== actor) {
      send(403, { error: 'Only a desktop drives a workflow, in its own name.' });
      return true;
    }
    send(200, await store.lease(id, value.holder, value.ttlMs, value.release));
    return true;
  }
  return false;
}

/** A webhook's address: the workflow, its trigger step and the trigger's secret. */
export const hookPath =
  /^\/v1\/hooks\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{16,128})$/;

/**
 * The request headers a webhook's run receives as {{trigger.headers}}: what names the request's
 * event and delivery and what sent it, never a signature, a token, a cookie or the sender's
 * address.
 */
export function hookHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined) continue;
    const told =
      key === 'content-type' || key === 'user-agent' || key.startsWith('x-') || /event|delivery/.test(key);
    if (!told || /signature|token|secret|password|auth|cookie|api-?key|forwarded|real-ip/.test(key))
      continue;
    kept[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return kept;
}
/** Headers senders name a delivery by, which a delivery they send again repeats. */
const deliveryHeaders = [
  'x-github-delivery',
  'x-gitea-delivery',
  'x-gogs-delivery',
  'x-gitlab-event-uuid',
  'linear-delivery',
];
/** Whether a body carries the HMAC-SHA256 its sender signed it with, as GitHub and Gitea sign. */
function signedWith(secret: string, body: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  );
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Starts a run of the workflow whose webhook trigger a request names (docs/WORKFLOWS.md): the
 * stores of the workspaces are searched for it, the secret must match, and the run is recorded as
 * pending, for a computer that runs the workflow to build from the workflow and drive. `read`
 * reads the request's body only once it is known to be the webhook's. A trigger with a signing
 * secret takes only bodies signed with it, and a delivery its sender names (`X-GitHub-Delivery`)
 * starts one run however often it is sent.
 */
export async function startFromHook({
  stores,
  workflowId,
  nodeId,
  secret,
  read,
  headers = {},
  now,
}: {
  stores: WorkflowStore[];
  workflowId: string;
  nodeId: string;
  secret: string;
  read: () => Promise<string | Buffer>;
  headers?: Record<string, string | string[] | undefined>;
  now: () => number;
}): Promise<
  | { ok: true; runId: string; duplicate?: boolean }
  | { ok: false; code: number; error: string }
> {
  const missing = { ok: false as const, code: 404, error: 'No webhook has this address.' };
  for (const store of stores) {
    const doc = (await store.read([workflowId])).docs[0];
    if (!doc || doc.kind !== 'definition') continue;
    const definition = readDefinition(doc.body);
    const node = definition?.graph.nodes.find(
      (n) => n.id === nodeId && n.type === 'start' && triggerOf(n) === 'webhook',
    );
    const config = node ? nodeConfig(node, 'start').webhook : undefined;
    if (!definition || !node || !config || !sameSecret(config.secret, secret)) return missing;
    if (!definition.runsOn)
      return { ok: false, code: 409, error: 'This workflow has no computer to run on.' };
    const raw = await read();
    const bytes = typeof raw === 'string' ? Buffer.from(raw) : raw;
    const header = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    if (config.signing && !signedWith(config.signing, bytes, header('x-hub-signature-256')))
      return { ok: false, code: 401, error: 'The request is not signed with its secret.' };
    const text = bytes.toString('utf8');
    let payload: unknown = { body: text };
    try {
      if (text.trim()) payload = JSON.parse(text);
    } catch {
      // A form's payload field holds the JSON GitHub sends as a form; other text goes on as is.
      const form = /x-www-form-urlencoded/i.test(header('content-type') ?? '')
        ? new URLSearchParams(text).get('payload')
        : null;
      try {
        if (form) payload = JSON.parse(form);
      } catch {
        /* Text that is not JSON goes on as text. */
      }
    }
    const delivery = deliveryHeaders.map(header).find((value) => !!value?.trim())?.trim();
    const at = new Date(now()).toISOString();
    const runId = delivery ? await deliveryRunId(workflowId, nodeId, delivery) : randomUUID();
    const result = await store.put({
      id: runId,
      kind: 'run',
      expected: null,
      body: {
        mode: 'static',
        title: definition.name,
        status: 'running',
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        createdBy: { kind: 'trigger', nodeId, trigger: 'webhook' },
        driver: {
          preferred: definition.runsOn,
          elsewhere: definition.elsewhere,
          ...(definition.continueOn ? { continueOn: definition.continueOn } : {}),
        },
        definition: { id: workflowId, revision: doc.revision, name: definition.name },
        trigger: { nodeId, kind: 'webhook', text, payload, headers: hookHeaders(headers) },
        pending: true,
      },
      events: [{ kind: 'started', text: 'Started by its webhook' }],
    });
    // A delivery sent again has its run already, or had one since deleted.
    if (!result.ok && delivery) return { ok: true, runId, duplicate: true };
    if (!result.ok) return { ok: false, code: 409, error: 'The run could not be recorded.' };
    return { ok: true, runId };
  }
  return missing;
}
function sameSecret(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return expected.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}
