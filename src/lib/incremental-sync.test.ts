import { expect, it } from 'vitest';
import type { Conversation } from './domain';
import { emptyShared, type SharedMeta } from './sync';
import {
  involvedChats,
  manifestSchema,
  mergeInvolved,
  nextBaselineChats,
  syncPlan,
} from './incremental-sync';

const chat = (id: string, title: string): Conversation => ({
  id,
  title,
  createdAt: '2026-09-26',
  updatedAt: '2026-09-26',
  settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
  messages: [],
});
const meta = (): SharedMeta => {
  const { conversations, ...rest } = emptyShared();
  return rest;
};
const manifest = (chats: Record<string, number>, revision = 5, metaRevision = 5) =>
  manifestSchema.parse({ instanceId: 'relay', revision, metaRevision, chats });

it('looks only at the conversations either side moved', () => {
  const baselineChats = { a: 5, b: 5, c: 5 };
  // b changed there, c was deleted there, and d is new there.
  const { involved, fetch, metaMoved } = involvedChats({
    manifest: manifest({ a: 5, b: 6, d: 6 }),
    baselineChats,
    baselineMetaRevision: 5,
    baselineIds: ['a', 'b', 'c'],
    localIds: ['a', 'b', 'c'],
    changedHere: new Set<string>(),
  });
  expect([...involved].sort()).toEqual(['b', 'c', 'd']);
  expect([...fetch].sort()).toEqual(['b', 'd']);
  expect(metaMoved).toBe(false);
});

it('adds what this device changed or deleted, and every chat when nothing is named', () => {
  const shared = {
    manifest: manifest({ a: 5, b: 5 }),
    baselineChats: { a: 5, b: 5 },
    baselineMetaRevision: 5,
    baselineIds: ['a', 'b'],
  };
  // A conversation changed here, and one deleted here is only visible against the baseline.
  expect(
    involvedChats({ ...shared, localIds: ['a'], changedHere: new Set(['a']) }).involved.sort(),
  ).toEqual(['a', 'b']);
  // A new conversation here is named and has no baseline entry.
  expect(
    involvedChats({
      ...shared,
      localIds: ['a', 'b', 'new'],
      changedHere: new Set(['new']),
    }).involved.sort(),
  ).toEqual(['new']);
  // Without names, every conversation on either side is examined.
  expect(
    involvedChats({ ...shared, localIds: ['a', 'c'], changedHere: undefined }).involved.sort(),
  ).toEqual(['a', 'b', 'c']);
  expect(
    involvedChats({ ...shared, localIds: ['a', 'b'], changedHere: new Set<string>() }).involved,
  ).toEqual([]);
  expect(
    involvedChats({
      ...shared,
      manifest: manifest({ a: 5, b: 5 }, 6, 6),
      localIds: ['a', 'b'],
      changedHere: new Set<string>(),
    }).metaMoved,
  ).toBe(true);
});

it('merges the involved conversations and leaves the others out of the result', () => {
  const involved = ['b'];
  const baseline = new Map([
    ['a', chat('a', 'Untouched')],
    ['b', chat('b', 'Before')],
  ]);
  const local = new Map([
    ['a', chat('a', 'Untouched')],
    ['b', { ...chat('b', 'Renamed here'), updatedAt: '2026-09-27' }],
  ]);
  const merged = mergeInvolved({
    involved,
    baseline,
    baselineMeta: meta(),
    localChat: (id) => local.get(id),
    localMeta: meta(),
    remoteChat: (id) => baseline.get(id),
    remoteMeta: meta(),
  });
  expect(merged.conversations.map((c) => c.id)).toEqual(['b']);
  expect(merged.conversations[0].title).toBe('Renamed here');
});

it('sends what the relay lacks, applies what this device lacks, and splits the deletions', () => {
  const involved = ['here', 'there', 'gone-here', 'gone-there'];
  const merged = {
    ...meta(),
    conversations: [chat('here', 'From here'), chat('there', 'From there')],
  };
  // The relay holds `there` and both deleted ones; this device holds `here` and `gone-here`.
  const remote = new Map([
    ['there', chat('there', 'From there')],
    ['gone-here', chat('gone-here', 'Deleted here')],
    ['gone-there', chat('gone-there', 'Deleted there')],
  ]);
  const local = new Map([
    ['here', chat('here', 'From here')],
    ['gone-here', chat('gone-here', 'Deleted here')],
  ]);
  const plan = syncPlan({
    involved,
    merged,
    manifest: manifest({ there: 5, 'gone-here': 5, 'gone-there': 5 }),
    localChat: (id) => local.get(id),
    localMeta: meta(),
    remoteChat: (id) => remote.get(id),
    remoteMeta: meta(),
  });
  expect(plan.send.map((c) => c.id)).toEqual(['here']);
  expect(plan.apply.map((c) => c.id)).toEqual(['there']);
  // Only conversations the relay still lists can be removed there, and only local ones here.
  expect(plan.remove.sort()).toEqual(['gone-here', 'gone-there']);
  expect(plan.forget).toEqual(['gone-here']);
  expect(plan.sendMeta).toBeUndefined();
  expect(plan.applyMeta).toBeUndefined();
});

it('sends and applies the replicated settings only when they differ', () => {
  const changed = { ...meta(), claudeInstructions: 'Run tests in the foreground' };
  const plan = syncPlan({
    involved: [],
    merged: { ...changed, conversations: [] },
    manifest: manifest({}),
    localChat: () => undefined,
    localMeta: changed,
    remoteChat: () => undefined,
    remoteMeta: meta(),
  });
  expect(plan.sendMeta).toEqual(changed);
  expect(plan.applyMeta).toBeUndefined();
});

it('keeps the baseline order, drops what went and appends what arrived', () => {
  const baseline = [chat('a', 'First'), chat('b', 'Second'), chat('c', 'Third')];
  const result = new Map([
    ['b', chat('b', 'Renamed')],
    ['new', chat('new', 'Added')],
  ]);
  // `c` was involved and is absent from the result, so it was deleted; `a` was never involved.
  expect(nextBaselineChats(baseline, ['b', 'c', 'new'], result).map((c) => c.title)).toEqual([
    'First',
    'Renamed',
    'Added',
  ]);
});
