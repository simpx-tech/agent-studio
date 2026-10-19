import { describe, expect, it } from 'vitest';
import { EVENTS_PER_FILE, memoryFiles, workflowStore } from './workflow-store';

const id = () => crypto.randomUUID();
const run = (title: string, extra: Record<string, unknown> = {}) => ({
  mode: 'static',
  title,
  status: 'running',
  agents: [],
  ...extra,
});

describe('workflow store', () => {
  it('writes documents with compare-and-set and reports what changed', async () => {
    let clock = 1_000;
    const store = workflowStore(memoryFiles(), () => clock);
    const a = id();
    const first = await store.put({ id: a, kind: 'run', expected: null, body: run('First') });
    expect(first).toMatchObject({ ok: true, revision: 1, doc: { id: a, revision: 1 } });
    // A second create of the same id is refused with the current document.
    const again = await store.put({ id: a, kind: 'run', expected: null, body: run('Again') });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.current?.body.title).toBe('First');
    // So is a write over a revision that moved on.
    await store.put({ id: a, kind: 'run', expected: 1, body: run('Second') });
    const stale = await store.put({ id: a, kind: 'run', expected: 1, body: run('Stale') });
    expect(!stale.ok && stale.current?.revision).toBe(2);
    const b = id();
    clock = 2_000;
    await store.put({ id: b, kind: 'definition', expected: null, body: { name: 'Daily report' } });
    const all = await store.list();
    expect(all.revision).toBe(3);
    expect(all.docs.map((d) => d.title).sort()).toEqual(['Daily report', 'Second']);
    const since = await store.list(2);
    expect(since.docs.map((d) => d.id)).toEqual([b]);
    expect(since.now).toBe(2_000);
    // A removal needs the current revision and is reported once.
    expect((await store.remove(b, 0)).ok).toBe(false);
    expect((await store.remove(b, 1)).ok).toBe(true);
    const after = await store.list(3);
    expect(after.removed).toEqual([b]);
    expect(after.docs).toEqual([]);
    // A removed id stays removed, as a schedule's slot run does when it is deleted.
    const revived = await store.put({ id: b, kind: 'definition', expected: null, body: {} });
    expect(revived).toEqual({ ok: false, current: null });
    expect((await store.list(0)).docs.map((d) => d.id)).toEqual([a]);
  });

  it('keeps each run history in order across files and reads it from any entry', async () => {
    const files = memoryFiles();
    const store = workflowStore(files);
    const a = id();
    const events = Array.from({ length: EVENTS_PER_FILE + 5 }, (_, i) => ({
      kind: 'node',
      text: `e${i + 1}`,
    }));
    await store.put({
      id: a,
      kind: 'run',
      expected: null,
      body: run('History'),
      events: events.slice(0, 600),
    });
    await store.put({
      id: a,
      kind: 'run',
      expected: 1,
      body: run('History'),
      events: events.slice(600),
    });
    const read = await store.read([a], { [a]: 995 });
    expect(read.docs[0].seq).toBe(EVENTS_PER_FILE + 5);
    expect(read.events[a].map((e) => e.text)).toEqual(events.slice(995).map((e) => e.text));
    expect(read.events[a].map((e) => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 996 + i));
    expect([...files.files.keys()].filter((n) => n.startsWith('events-')).length).toBe(2);
  });

  it('ignores history a write left behind without committing its document', async () => {
    const files = memoryFiles();
    const store = workflowStore(files);
    const a = id();
    await store.put({
      id: a,
      kind: 'run',
      expected: null,
      body: run('Crash'),
      events: [{ kind: 'x', text: 'kept' }],
    });
    // A crashed write appended an entry but never wrote the document.
    const name = `events-${a}-0.json`;
    const list = JSON.parse(files.files.get(name)!);
    list.push({ seq: 2, at: 'now', kind: 'x', text: 'lost' });
    files.files.set(name, JSON.stringify(list));
    const reopened = workflowStore(files);
    expect((await reopened.read([a], { [a]: 0 })).events[a].map((e) => e.text)).toEqual(['kept']);
    await reopened.put({
      id: a,
      kind: 'run',
      expected: 1,
      body: run('Crash'),
      events: [{ kind: 'x', text: 'next' }],
    });
    expect((await reopened.read([a], { [a]: 0 })).events[a].map((e) => e.text)).toEqual([
      'kept',
      'next',
    ]);
  });

  it('reloads documents, removals and leases from its files', async () => {
    const files = memoryFiles();
    const store = workflowStore(files, () => 5_000);
    const a = id();
    const b = id();
    await store.put({ id: a, kind: 'run', expected: null, body: run('Kept') });
    await store.put({ id: b, kind: 'run', expected: null, body: run('Gone') });
    await store.remove(b, 1);
    await store.lease(a, 'desktop', 60_000);
    const reopened = workflowStore(files, () => 6_000);
    const listed = await reopened.list();
    expect(listed.revision).toBe(store.revision());
    expect(listed.docs.map((d) => d.title)).toEqual(['Kept']);
    expect(listed.removed).toEqual([b]);
    expect(listed.leases[a]).toEqual({ holder: 'desktop', expiresAt: 65_000 });
  });

  it('grants a lease to one computer at a time until it lapses', async () => {
    let clock = 0;
    const store = workflowStore(memoryFiles(), () => clock);
    const a = id();
    await store.put({ id: a, kind: 'run', expected: null, body: run('Lease') });
    const before = store.revision();
    expect((await store.lease(a, 'pc', 60_000)).granted).toBe(true);
    // A new driver moves the store's revision; renewing does not.
    expect(store.revision()).toBe(before + 1);
    clock = 10_000;
    expect((await store.lease(a, 'vps', 60_000)).granted).toBe(false);
    expect((await store.lease(a, 'pc', 60_000)).lease?.expiresAt).toBe(70_000);
    expect(store.revision()).toBe(before + 1);
    clock = 70_000;
    const taken = await store.lease(a, 'vps', 60_000);
    expect(taken).toMatchObject({ granted: true, lease: { holder: 'vps' } });
    // The former driver's release cannot drop another's lease.
    await store.lease(a, 'pc', 60_000, true);
    expect((await store.list()).leases[a].holder).toBe('vps');
    await store.lease(a, 'vps', 60_000, true);
    expect((await store.list()).leases[a]).toBeUndefined();
  });

  it('summarizes runs with the chats they keep out of chat lists', async () => {
    const store = workflowStore(memoryFiles());
    const a = id();
    const hidden = id();
    const listed = id();
    const older = id();
    await store.put({
      id: a,
      kind: 'run',
      expected: null,
      body: run('Mission', {
        mode: 'dynamic',
        agents: [
          { conversationId: hidden, status: 'running' },
          { conversationId: listed, external: true, status: 'done' },
          // Runs before 2026-10-19 marked chats a step or orchestrator asked to list: the run's.
          { conversationId: older, listed: true, status: 'done' },
        ],
        questions: [{ status: 'pending' }, { status: 'answered' }],
        driver: { preferred: id(), elsewhere: false },
      }),
    });
    const [summary] = (await store.list()).docs;
    expect(summary).toMatchObject({
      mode: 'dynamic',
      status: 'running',
      questions: 1,
      running: 1,
      conversations: [hidden, older],
      listed: [listed],
      elsewhere: false,
    });
    expect([...store.workflowChats()]).toEqual([hidden, older]);
    // A workflow's assistant is one of its chats, but no run's.
    const assistant = id();
    await store.put({
      id: id(),
      kind: 'definition',
      expected: null,
      body: { name: 'Writer', assistant: { conversationId: assistant } },
    });
    expect([...store.workflowChats()].sort()).toEqual([hidden, older, assistant].sort());
    expect([...store.runChats()]).toEqual([hidden, older]);
  });

  it('runs one operation at a time', async () => {
    const store = workflowStore(memoryFiles());
    const a = id();
    await store.put({ id: a, kind: 'run', expected: null, body: run('Race') });
    const results = await Promise.all([
      store.put({ id: a, kind: 'run', expected: 1, body: run('One') }),
      store.put({ id: a, kind: 'run', expected: 1, body: run('Two') }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
