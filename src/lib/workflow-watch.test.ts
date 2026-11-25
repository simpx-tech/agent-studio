import { describe, expect, it } from 'vitest';
import { memoryFiles } from './workflow-store';
import {
  TriggerMemory,
  overlapVerdict,
  stableText,
  stillGoing,
  trackOf,
  watchChanges,
  watchItems,
  watchSignature,
} from './workflow-watch';
import type { WorkflowSummary } from './workflow-model';

describe('a Watch trigger’s items', () => {
  it('are read from a JSON list, the one list of an object, or one JSON value a line', () => {
    const list = '[{"id":"a","v":1},{"id":"b","v":2}]';
    expect(watchItems(list, 'id', 'v').items).toEqual([
      { id: 'a', version: '1', item: { id: 'a', v: 1 } },
      { id: 'b', version: '2', item: { id: 'b', v: 2 } },
    ]);
    expect(watchItems('{"items":[{"id":"a"}],"total":1}', 'id', '').items.map((i) => i.id)).toEqual(
      ['a'],
    );
    expect(watchItems('{"id":"a","v":1}\n\n{"id":"b","v":2}\n', 'id', 'v').items).toHaveLength(2);
    expect(watchItems('', 'id', '')).toEqual({ items: [] });
    expect(watchItems('not json', 'id', '').problem).toBe('Its output is not a JSON list.');
  });

  it('name each item by its id, once, and tell its changes by its version', () => {
    const read = watchItems(
      JSON.stringify([
        { pr: { url: 'u1' }, head: 'h1' },
        { pr: { url: 'u1' }, head: 'h2' },
        { head: 'none' },
        { pr: { url: 7 }, head: { b: 2, a: 1 } },
      ]),
      'pr.url',
      'head',
    );
    expect(read.items.map(({ id, version }) => ({ id, version }))).toEqual([
      { id: 'u1', version: 'h1' },
      { id: '7', version: '{"a":1,"b":2}' },
    ]);
    expect(read.problem).toBe('1 item has no pr.url.');
    // A version is the whole item when no path names it, whatever the order of its keys.
    expect(watchItems('[{"id":"a","x":1,"y":2}]', 'id', '').items[0].version).toBe(
      watchItems('[{"y":2,"id":"a","x":1}]', 'id', '').items[0].version,
    );
    expect(stableText({ b: [{ d: 1, c: 2 }], a: 'x' })).toBe('{"a":"x","b":[{"c":2,"d":1}]}');
  });

  it('change when new or of another version, and the first look starts nothing unless asked', () => {
    const items = watchItems('[{"id":"a","v":1},{"id":"b","v":2},{"id":"c","v":3}]', 'id', 'v')
      .items;
    expect(watchChanges(undefined, items, false)).toEqual([]);
    expect(watchChanges(undefined, items, true).map((c) => [c.id, c.previous])).toEqual([
      ['a', ''],
      ['b', ''],
      ['c', ''],
    ]);
    expect(
      watchChanges({ a: '1', b: '1' }, items, false).map((c) => [c.id, c.previous, c.version]),
    ).toEqual([
      ['b', '1', '2'],
      ['c', '', '3'],
    ]);
  });

  it('watch anew when the command or what names an item changes', () => {
    const base = { shell: 'bash', script: 'gh pr list', id: 'url', version: '' };
    expect(watchSignature(base)).toBe(watchSignature({ ...base }));
    expect(watchSignature(base)).not.toBe(watchSignature({ ...base, script: 'gh pr list -L 5' }));
    expect(watchSignature(base)).not.toBe(watchSignature({ ...base, id: 'number' }));
    expect(watchSignature(base)).not.toBe(
      watchSignature({ ...base, location: { environmentId: 'e', path: '/repo' } }),
    );
  });
});

describe('overlapping runs', () => {
  const summary = (status: string) => ({ status }) as unknown as WorkflowSummary;
  it('start, wait or skip while a run of the same trigger and item goes on', () => {
    expect(overlapVerdict('parallel', true, true)).toBe('start');
    expect(overlapVerdict('skip', true, false)).toBe('skip');
    expect(overlapVerdict('skip', false, false)).toBe('start');
    expect(overlapVerdict('queue', true, false)).toBe('queue');
    // Waiting events keep their order.
    expect(overlapVerdict('queue', false, true)).toBe('queue');
    expect(overlapVerdict('queue', false, false)).toBe('start');
    expect(trackOf('w', 'n')).toBe('w:n:');
    expect(trackOf('w', 'n', 'pr/1')).toBe('w:n:pr/1');
  });

  it('read a run as going by its summary, or for two minutes before the store lists it', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const started = { runId: 'r', at: '2026-11-25T11:59:30Z' };
    expect(stillGoing(undefined, () => undefined, now)).toBe(false);
    expect(stillGoing(started, () => summary('running'), now)).toBe(true);
    expect(stillGoing(started, () => summary('paused'), now)).toBe(true);
    expect(stillGoing(started, () => summary('completed'), now)).toBe(false);
    expect(stillGoing(started, () => undefined, now)).toBe(true);
    expect(stillGoing(started, () => undefined, now + 120_000)).toBe(false);
  });
});

describe('what a computer keeps of its triggers', () => {
  it('survives a restart, and starts afresh from an unreadable file', async () => {
    const files = memoryFiles();
    const memory = new TriggerMemory(files);
    await memory.load();
    memory.state.watches['w:n'] = { seen: { a: '1' }, signature: 's', checkedAt: 'now' };
    memory.state.runs['w:n:a'] = { runId: 'r', at: 'now' };
    void memory.save();
    await memory.save();
    const again = new TriggerMemory(files);
    await again.load();
    expect(again.state.watches['w:n'].seen).toEqual({ a: '1' });
    expect(again.state.runs['w:n:a'].runId).toBe('r');
    files.files.set('triggers.json', '{not json');
    const fresh = new TriggerMemory(files);
    await fresh.load();
    expect(fresh.state).toEqual({ version: 1, watches: {}, runs: {}, queue: [] });
  });
});
