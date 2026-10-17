import { z } from 'zod';
import {
  docSchema,
  eventSchema,
  leaseSchema,
  summarize,
  type EventInput,
  type Lease,
  type WorkflowDoc,
  type WorkflowEvent,
  type WorkflowSummary,
} from './workflow-model.ts';

/**
 * The workflow store (docs/WORKFLOWS.md): definitions and runs as documents with revisions, an
 * append-only history per run, and the lease of the computer driving each run. The relay keeps
 * one per workspace (relay/workflows.ts) and a desktop without one keeps its own in app data, both
 * through this code over their own files.
 *
 * A document's file is the commit point of a write: history written past the `seq` it names, by a
 * write that never reached it, is ignored and later written over. The index holds what no
 * document can: the store's revision, removals and leases.
 */
export type StoreFiles = {
  read(name: string): Promise<string | undefined>;
  /** Replaces a file whole, atomically. */
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  names(): Promise<string[]>;
};

const count = z.number().int().nonnegative();
const indexSchema = z.object({
  version: z.literal(1),
  revision: count,
  removed: z.record(z.string(), count).default({}),
  leases: z.record(z.string(), leaseSchema).default({}),
});
type Index = z.infer<typeof indexSchema>;
/** A document as stored: the store revision of its last change, and its last history entry. */
const storedSchema = docSchema.extend({ changedAt: count, seq: count.default(0) });
type Stored = z.infer<typeof storedSchema>;

/** How many history entries one file of a run's history holds. */
export const EVENTS_PER_FILE = 1000;
const docName = (id: string) => `doc-${id}.json`;
const eventsName = (id: string, part: number) => `events-${id}-${part}.json`;
const validId = (id: string) => z.string().uuid().safeParse(id).success;

export type PutResult =
  | { ok: true; revision: number; doc: { id: string; revision: number }; seq: number }
  | { ok: false; current: WorkflowDoc | null };
export type ListResult = {
  revision: number;
  now: number;
  docs: WorkflowSummary[];
  removed: string[];
  leases: Record<string, Lease>;
};
export type ReadResult = {
  revision: number;
  now: number;
  docs: (WorkflowDoc & { seq: number })[];
  events: Record<string, WorkflowEvent[]>;
};
export type LeaseResult = { granted: boolean; lease: Lease | null; now: number; revision: number };

export class StoreConflict extends Error {}

export function workflowStore(files: StoreFiles, now: () => number = Date.now) {
  let index: Index = { version: 1, revision: 0, removed: {}, leases: {} };
  const summaries = new Map<string, WorkflowSummary & { changedAt: number }>();
  const meta = new Map<string, { revision: number; seq: number; changedAt: number }>();
  // One operation at a time: each reads what the one before wrote.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };
  const ready = serial(async () => {
    const saved = await files.read('index.json');
    if (saved) {
      const parsed = indexSchema.safeParse(JSON.parse(saved));
      if (!parsed.success) throw new Error('The workflow store index is unreadable.');
      index = parsed.data;
    }
    for (const name of await files.names()) {
      const id = name.match(/^doc-(.+)\.json$/)?.[1];
      if (!id || !validId(id)) continue;
      const stored = await readStored(id);
      if (!stored) continue;
      remember(stored);
      if (stored.changedAt > index.revision) index.revision = stored.changedAt;
    }
  });
  async function readStored(id: string): Promise<Stored | undefined> {
    const text = await files.read(docName(id));
    if (!text) return undefined;
    try {
      return storedSchema.parse(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  function remember(stored: Stored) {
    meta.set(stored.id, {
      revision: stored.revision,
      seq: stored.seq,
      changedAt: stored.changedAt,
    });
    summaries.set(stored.id, { ...summarize(stored), changedAt: stored.changedAt });
  }
  const saveIndex = () => files.write('index.json', JSON.stringify(index));
  async function readEvents(id: string, after: number, upTo: number): Promise<WorkflowEvent[]> {
    const events: WorkflowEvent[] = [];
    if (upTo <= after) return events;
    for (
      let part = Math.floor(after / EVENTS_PER_FILE);
      part <= Math.floor((upTo - 1) / EVENTS_PER_FILE);
      part++
    ) {
      const text = await files.read(eventsName(id, part));
      if (!text) continue;
      let list: unknown;
      try {
        list = JSON.parse(text);
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const event = eventSchema.safeParse(item).data;
        if (event && event.seq > after && event.seq <= upTo) events.push(event);
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
  }
  async function appendEvents(id: string, from: number, events: WorkflowEvent[]) {
    let part = -1;
    let list: WorkflowEvent[] = [];
    const flush = async () => {
      if (part >= 0) await files.write(eventsName(id, part), JSON.stringify(list));
    };
    for (const event of events) {
      const target = Math.floor((event.seq - 1) / EVENTS_PER_FILE);
      if (target !== part) {
        await flush();
        part = target;
        const text = await files.read(eventsName(id, part));
        let read: unknown = [];
        try {
          read = text ? JSON.parse(text) : [];
        } catch {
          read = [];
        }
        // Entries a write left behind without committing are written over.
        list = (Array.isArray(read) ? read : [])
          .map((item) => eventSchema.safeParse(item).data)
          .filter((e): e is WorkflowEvent => !!e && e.seq <= from);
      }
      list.push(event);
    }
    await flush();
  }

  return {
    ready,
    /** The store's revision: it moves with every change of a document or a run's driver. */
    revision: () => index.revision,
    /** The chats runs started, by run, for chat lists and counts that leave them out. */
    workflowChats(): Set<string> {
      const chats = new Set<string>();
      for (const summary of summaries.values())
        for (const id of summary.conversations) chats.add(id);
      return chats;
    },
    summaries: () => [...summaries.values()],
    /** What changed since `since`: summaries, removals and every current lease. */
    list: (since = 0): Promise<ListResult> =>
      serial(async () => {
        await ready;
        const at = now();
        for (const [id, lease] of Object.entries(index.leases))
          if (lease.expiresAt <= at - 24 * 60 * 60 * 1000) delete index.leases[id];
        return {
          revision: index.revision,
          now: at,
          docs: [...summaries.values()]
            .filter((s) => s.changedAt > since)
            .map(({ changedAt, ...summary }) => summary),
          removed: Object.entries(index.removed)
            .filter(([, revision]) => revision > since)
            .map(([id]) => id),
          leases: { ...index.leases },
        };
      }),
    /** Documents by id, with each run's history after the entry named in `events`. */
    read: (ids: string[], after: Record<string, number> = {}): Promise<ReadResult> =>
      serial(async () => {
        await ready;
        const docs: ReadResult['docs'] = [];
        const events: ReadResult['events'] = {};
        for (const id of [...new Set(ids)]) {
          if (!validId(id) || !meta.has(id)) continue;
          const stored = await readStored(id);
          if (!stored) continue;
          const { changedAt, ...doc } = stored;
          docs.push(doc);
          if (id in after) events[id] = await readEvents(id, after[id], stored.seq);
        }
        return { revision: index.revision, now: now(), docs, events };
      }),
    /**
     * Writes a document when `expected` is its current revision, or `null` for a new one, and
     * adds `events` to its history. Otherwise returns the current document.
     */
    put: (input: {
      id: string;
      kind: WorkflowDoc['kind'];
      expected: number | null;
      body: Record<string, unknown>;
      events?: EventInput[];
    }): Promise<PutResult> =>
      serial(async () => {
        await ready;
        if (!validId(input.id)) throw new StoreConflict('Invalid workflow id.');
        const known = meta.get(input.id);
        const current = known ? await readStored(input.id) : undefined;
        // A removed document stays removed: a schedule's slot names its run, and another
        // computer's late write of a deleted run must not bring it back.
        if (!current && index.removed[input.id] !== undefined) return { ok: false, current: null };
        if (
          (current?.revision ?? null) !== input.expected ||
          (current && current.kind !== input.kind)
        ) {
          if (!current) return { ok: false, current: null };
          const { changedAt, seq, ...doc } = current;
          return { ok: false, current: doc };
        }
        const at = now();
        const revision = index.revision + 1;
        const seq = current?.seq ?? 0;
        const events = (input.events ?? []).map((event, i) =>
          eventSchema.parse({
            ...event,
            seq: seq + i + 1,
            at: event.at ?? new Date(at).toISOString(),
          }),
        );
        if (events.length) await appendEvents(input.id, seq, events);
        const stored: Stored = {
          id: input.id,
          kind: input.kind,
          revision: (current?.revision ?? 0) + 1,
          updatedAt: new Date(at).toISOString(),
          body: input.body,
          changedAt: revision,
          seq: seq + events.length,
        };
        // The document's file commits the write.
        await files.write(docName(input.id), JSON.stringify(stored));
        index.revision = revision;
        delete index.removed[input.id];
        remember(stored);
        await saveIndex();
        return {
          ok: true,
          revision,
          doc: { id: input.id, revision: stored.revision },
          seq: stored.seq,
        };
      }),
    remove: (id: string, expected: number): Promise<PutResult> =>
      serial(async () => {
        await ready;
        const current = meta.has(id) ? await readStored(id) : undefined;
        if (!current) return { ok: false, current: null };
        if (current.revision !== expected) {
          const { changedAt, seq, ...doc } = current;
          return { ok: false, current: doc };
        }
        const revision = index.revision + 1;
        index.revision = revision;
        index.removed[id] = revision;
        delete index.leases[id];
        await saveIndex();
        await files.remove(docName(id));
        meta.delete(id);
        summaries.delete(id);
        for (
          let part = 0;
          part <= Math.floor(Math.max(0, current.seq - 1) / EVENTS_PER_FILE);
          part++
        )
          await files.remove(eventsName(id, part)).catch(() => {});
        return { ok: true, revision, doc: { id, revision: current.revision }, seq: current.seq };
      }),
    /**
     * Grants or renews the lease of the computer driving a run: when no one holds it, it lapsed,
     * or `holder` holds it already. `release` gives it up.
     */
    lease: (id: string, holder: string, ttlMs: number, release = false): Promise<LeaseResult> =>
      serial(async () => {
        await ready;
        if (!validId(id) || !holder) throw new StoreConflict('Invalid lease request.');
        const at = now();
        const current = index.leases[id];
        if (release) {
          if (current?.holder === holder) {
            delete index.leases[id];
            index.revision++;
            await saveIndex();
          }
          return {
            granted: false,
            lease: index.leases[id] ?? null,
            now: at,
            revision: index.revision,
          };
        }
        if (current && current.holder !== holder && current.expiresAt > at)
          return { granted: false, lease: current, now: at, revision: index.revision };
        const lease = { holder, expiresAt: at + Math.max(1000, ttlMs) };
        index.leases[id] = lease;
        // A new driver is news for everyone following the run; a renewal is not.
        if (current?.holder !== holder) index.revision++;
        await saveIndex();
        return { granted: true, lease, now: at, revision: index.revision };
      }),
  };
}
export type WorkflowStore = ReturnType<typeof workflowStore>;

/** Files kept in memory, for tests and for a desktop before its own files load. */
export function memoryFiles(initial: Record<string, string> = {}): StoreFiles & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: async (name) => files.get(name),
    write: async (name, text) => {
      files.set(name, text);
    },
    remove: async (name) => {
      files.delete(name);
    },
    names: async () => [...files.keys()],
  };
}
