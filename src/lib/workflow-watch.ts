import { z } from 'zod';
import { valueAt } from './workflow-templates';
import { runActive, type Overlap, type WorkflowSummary } from './workflow-model';

/**
 * Watch triggers and overlapping runs (docs/WORKFLOWS.md). A Watch trigger runs a command every
 * so often on the computer that runs its workflow's triggered runs, reads the list of items it
 * prints and starts a run for each item that is new or changed since the last look. What it saw,
 * the runs each trigger started and the events waiting for an earlier run to end are kept on
 * that computer (`TriggerMemory`, app data `workflows/triggers.json`), so a restart compares
 * with what it saw before and changes made while it was off still start runs.
 */

/** One item of a Watch trigger's list: its id, what tells that it changed, and the item. */
export type WatchItem = { id: string; version: string; item: unknown };

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const pathOf = (path: string) => (path.trim() ? path.trim().split('.') : []);
/** A value as an id: text and numbers, as written. */
const idOf = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
/** A value as text that only changes when the value does: objects with their keys sorted. */
export function stableText(value: unknown): string {
  if (typeof value === 'string') return value;
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((key) => [key, sorted((v as Record<string, unknown>)[key])]),
          )
        : v;
  return JSON.stringify(sorted(value)) ?? '';
}

/**
 * The items a command printed: a JSON list, the one list inside a JSON object, or one JSON value
 * a line. Each needs an id at `idPath`; its version is the value at `versionPath`, or the whole
 * item. An id listed twice counts once, as first listed.
 */
export function watchItems(
  stdout: string,
  idPath: string,
  versionPath: string,
): { items: WatchItem[]; problem?: string } {
  const text = stdout.trim();
  if (!text) return { items: [] };
  let list: unknown[] | undefined;
  const whole = parse(text);
  if (Array.isArray(whole)) list = whole;
  else if (whole && typeof whole === 'object') {
    const lists = Object.values(whole).filter(Array.isArray);
    if (lists.length === 1) list = lists[0];
  }
  if (!list && whole === undefined) {
    const values = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map(parse);
    if (values.every((value) => value !== undefined)) list = values;
  }
  if (!list) return { items: [], problem: 'Its output is not a JSON list.' };
  const items: WatchItem[] = [];
  const ids = new Set<string>();
  let missing = 0;
  for (const item of list) {
    const id = idOf(valueAt(item, pathOf(idPath)));
    if (!id) {
      missing++;
      continue;
    }
    if (ids.has(id)) continue;
    ids.add(id);
    const version = versionPath.trim() ? valueAt(item, pathOf(versionPath)) : item;
    items.push({ id, version: stableText(version ?? ''), item });
  }
  return {
    items,
    ...(missing
      ? { problem: `${missing} ${missing === 1 ? 'item has' : 'items have'} no ${idPath || 'id'}.` }
      : {}),
  };
}

/**
 * What changed since the last look, `seen` (undefined the first time): items that are new or
 * whose version differs, each with the version it had before (empty for a new one). The first
 * look starts runs only for a trigger told to start them for items already listed.
 */
export function watchChanges(
  seen: Record<string, string> | undefined,
  items: WatchItem[],
  initial: boolean,
): (WatchItem & { previous: string })[] {
  if (!seen) return initial ? items.map((item) => ({ ...item, previous: '' })) : [];
  return items
    .filter((item) => seen[item.id] !== item.version)
    .map((item) => ({ ...item, previous: seen[item.id] ?? '' }));
}

/** The settings of a Watch trigger that make it watch anew when they change. */
export const watchSignature = (watch: {
  location?: { environmentId: string; path: string };
  shell: string;
  script: string;
  id: string;
  version: string;
}) =>
  stableText([
    watch.location?.environmentId ?? '',
    watch.location?.path ?? '',
    watch.shell,
    watch.script,
    watch.id,
    watch.version,
  ]);

const watchSchema = z.object({
  // The version of each item listed at the last look, by id, under the settings `signature`
  // names: what the next look compares with.
  seen: z.record(z.string(), z.string()).default({}),
  signature: z.string().default(''),
  // The last look, the settings it used, how many items it read and why it failed.
  checkedAt: z.string().optional(),
  lookedWith: z.string().optional(),
  items: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type WatchState = z.infer<typeof watchSchema>;
const startedSchema = z.object({ runId: z.string(), at: z.string() });
/** An event waiting for the run its trigger started before to end. */
const queuedSchema = z.object({
  // `<workflow>:<trigger step>:<item>`, the runs that go one at a time.
  track: z.string(),
  definitionId: z.string(),
  nodeId: z.string(),
  runId: z.string(),
  trigger: z.object({
    kind: z.string(),
    text: z.string().optional(),
    payload: z.unknown().optional(),
    key: z.string().optional(),
    previous: z.string().optional(),
  }),
  actor: z.record(z.string(), z.unknown()),
  slot: z.object({ scheduleId: z.string(), at: z.string() }).optional(),
  at: z.string(),
});
export type QueuedEvent = z.infer<typeof queuedSchema>;
const memorySchema = z.object({
  version: z.literal(1),
  // By `<workflow>:<trigger step>`.
  watches: z.record(z.string(), watchSchema).default({}),
  // The run each trigger, and item, started last, by track.
  runs: z.record(z.string(), startedSchema).default({}),
  queue: z.array(queuedSchema).default([]),
});
type Memory = z.infer<typeof memorySchema>;

/** The runs of one trigger, or of one item of a Watch trigger, that go one at a time. */
export const trackOf = (definitionId: string, nodeId: string, item = '') =>
  `${definitionId}:${nodeId}:${item}`;

/**
 * Whether a run a trigger started last still goes on: by its summary, or, before the store lists
 * it, for the two minutes after it was started.
 */
export function stillGoing(
  started: { runId: string; at: string } | undefined,
  summary: (id: string) => WorkflowSummary | undefined,
  now: number,
): boolean {
  if (!started) return false;
  const listed = summary(started.runId);
  if (listed) return runActive(listed.status);
  const at = Date.parse(started.at);
  return Number.isFinite(at) && now - at < 120_000;
}

/** What an overlapping event does: start its run, wait for the earlier one, or start none. */
export function overlapVerdict(
  overlap: Overlap,
  going: boolean,
  waiting: boolean,
): 'start' | 'queue' | 'skip' {
  if (overlap === 'parallel') return 'start';
  // Events already waiting keep their order.
  if (overlap === 'queue') return going || waiting ? 'queue' : 'start';
  return going ? 'skip' : 'start';
}

/** What this computer keeps of its triggers, written through `files` after each change. */
export class TriggerMemory {
  state: Memory = { version: 1, watches: {}, runs: {}, queue: [] };
  private loading: Promise<void> | undefined;
  private writing: Promise<void> | undefined;
  private again = false;
  constructor(
    private files: {
      read(name: string): Promise<string | undefined>;
      write(name: string, text: string): Promise<void>;
    },
    private name = 'triggers.json',
  ) {}
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const text = await this.files.read(this.name);
        const saved = text ? memorySchema.safeParse(JSON.parse(text)) : undefined;
        if (saved?.success) this.state = saved.data;
      } catch {
        // Unreadable memory starts afresh: watches look again as when they began.
      }
    })();
    return this.loading;
  }
  /** Writes the memory once the write before ended, and again for changes made meanwhile. */
  save(): Promise<void> {
    if (this.writing) {
      this.again = true;
      return this.writing;
    }
    this.writing = (async () => {
      do {
        this.again = false;
        await this.files.write(this.name, JSON.stringify(this.state)).catch(() => {});
      } while (this.again);
    })().finally(() => (this.writing = undefined));
    return this.writing;
  }
}
