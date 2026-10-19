import { describe, expect, it } from 'vitest';
import { readDefinition } from './workflow-model';
import { generalCall, type StoreAccess } from './workflow-tools';
import type { WorkflowHost } from './workflow-engine';

// The general workflow tools as an agent calls them (docs/WORKFLOWS.md), on a store in memory.
function setup() {
  let now = Date.parse('2026-10-19T12:00:00Z');
  const docs = new Map<string, { body: unknown; revision: number; kind: string }>();
  const store: StoreAccess = {
    summaries: () => [],
    read: async (id) => {
      const doc = docs.get(id);
      return doc && { ...structuredClone(doc), events: [] };
    },
    put: async (id, kind, expected, body) => {
      const current = docs.get(id);
      if ((current?.revision ?? null) !== expected) return { ok: false, current: null };
      const revision = (current?.revision ?? 0) + 1;
      docs.set(id, { body: structuredClone(body), revision, kind });
      return { ok: true, revision, doc: { id, revision }, seq: revision };
    },
  };
  const host = {
    now: () => now,
    self: () => ({ environmentId: crypto.randomUUID(), server: false }),
  } as unknown as WorkflowHost;
  const caller = { conversationId: crypto.randomUUID(), title: 'Builder' };
  return {
    advance: (ms: number) => (now += ms),
    call: (tool: 'workflow_save' | 'workflow_read', input: unknown) =>
      generalCall(store, host, tool, input, caller).then((text) => JSON.parse(text)),
    schedules: (id: string) =>
      (
        readDefinition(docs.get(id)!.body)!.graph.nodes.find((n) => n.key === 'daily')!.config as {
          schedules: { id: string; since?: string }[];
        }
      ).schedules,
  };
}

describe('workflow_save', () => {
  it('runs a schedule an agent adds from when it saved it, and keeps that time', async () => {
    const t = setup();
    const saved = new Date('2026-10-19T12:00:00Z').toISOString();
    // Daily at 08:00: today's slot has passed, and must not start a run at once.
    const first = await t.call('workflow_save', {
      name: 'Daily',
      nodes: [
        {
          key: 'daily',
          type: 'start',
          config: { trigger: 'schedule', schedules: [{ id: 's1', every: 'days', at: '08:00' }] },
        },
        { key: 'finish', type: 'end' },
      ],
      edges: [{ source: 'daily', target: 'finish' }],
    });
    expect(t.schedules(first.id).map((s) => s.since)).toEqual([saved]);
    // Saved again an hour later without its time, the schedule keeps it; a new one takes the new
    // time.
    t.advance(3_600_000);
    const read = await t.call('workflow_read', { id: first.id });
    const nodes = read.nodes.map((n: { key: string; config: { schedules?: unknown[] } }) =>
      n.key === 'daily'
        ? {
            ...n,
            config: {
              ...n.config,
              schedules: [
                { id: 's1', every: 'days', at: '08:00' },
                { id: 's2', every: 'hours', interval: 2 },
              ],
            },
          }
        : n,
    );
    await t.call('workflow_save', {
      id: first.id,
      revision: read.revision,
      name: 'Daily',
      nodes,
      edges: read.edges,
    });
    expect(t.schedules(first.id).map((s) => s.since)).toEqual([
      saved,
      new Date('2026-10-19T13:00:00Z').toISOString(),
    ]);
  });
});
