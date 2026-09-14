import { describe, expect, it } from 'vitest';
import {
  fileChangesSchema,
  summarizeFileChanges,
  type FilePatch,
  type DiffHunk,
  type FileChanges,
} from './file-changes';
import { applyRunEvent, retainRunEvent } from './activity';
import { historyFor, initialWorkspace, restoreWorkspace, type Message } from './domain';
import { emptyShared, mergeShared } from './sync';

const hunk = (oldStart: number, newStart: number, before: string[], after: string[]): DiffHunk => ({
  oldStart,
  newStart,
  oldLines: before.length,
  newLines: after.length,
  lines: [...before.map((s) => '-' + s), ...after.map((s) => '+' + s)],
});
const patch = (before: string, after: string, path = 'src/app.ts'): FilePatch => ({
  path,
  kind: 'modified',
  hunks: [hunk(1, 1, [before], [after])],
});
const snapshot = (files: FilePatch[], revision = 1): FileChanges => ({
  revision,
  limited: false,
  edits: [{ id: 'edit', files }],
});
const reply = (files: FilePatch[]): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'complete',
  createdAt: '2026-09-14',
  blocks: [{ type: 'markdown', text: 'Done.' }],
  fileChanges: snapshot(files),
});

describe('recorded file changes', () => {
  it('retains confirmed legacy filenames without inventing diffs or hiding an earlier gap', () => {
    const old = reply([]);
    delete old.fileChanges;
    old.blocks.push({
      type: 'activity',
      text: 'Edit',
      tool: {
        id: 'old',
        revision: 1,
        category: 'tool',
        name: 'Edit',
        operation: 'edit',
        status: 'complete',
        path: 'src/app.ts',
        facts: [],
        sources: [],
        agents: [],
      },
    });
    expect(summarizeFileChanges([old]).files[0]).toMatchObject({
      path: 'src/app.ts',
      unavailable: expect.any(String),
    });
    expect(
      summarizeFileChanges([old, reply([patch('middle', 'final')])]).files[0].hunks,
    ).toBeUndefined();
    if (old.blocks[1].type === 'activity') old.blocks[1].tool!.status = 'error';
    expect(summarizeFileChanges([old]).files).toHaveLength(0);
  });
  it('reconstructs the final file across many overlapping inserts, replacements and deletions', () => {
    let random = 73;
    const pick = (n: number) => (random = (random * 1664525 + 1013904223) >>> 0) % n;
    for (let trial = 0; trial < 80; trial++) {
      const original = ['zero', 'one', 'two', 'three', 'four', 'five'];
      const current = [...original];
      const messages: Message[] = [];
      for (let step = 0; step < 12; step++) {
        const index = pick(current.length + 1),
          count = pick(Math.min(3, current.length - index) + 1);
        const after = Array.from(
          { length: pick(4) },
          () => ['zero', 'one', 'new', 'changed'][pick(4)],
        );
        const before = current.splice(index, count, ...after);
        messages.push(
          reply([
            {
              path: 'random.txt',
              kind: 'modified',
              hunks: [hunk(index + (count ? 1 : 0), index + (after.length ? 1 : 0), before, after)],
            },
          ]),
        );
      }
      const file = summarizeFileChanges(messages).files[0];
      expect(file?.unavailable).toBeUndefined();
      const reconstructed = [...original];
      let offset = 0;
      for (const h of file?.hunks ?? []) {
        const index = (h.oldLines ? h.oldStart - 1 : h.oldStart) + offset;
        reconstructed.splice(
          index,
          h.oldLines,
          ...h.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
        );
        offset += h.newLines - h.oldLines;
      }
      expect(reconstructed).toEqual(current);
    }
  });
  it('shows each response and the final chat state without summing repeated edits', () => {
    const a = reply([patch('first', 'middle')]),
      b = reply([patch('middle', 'final')]);
    expect(summarizeFileChanges([b]).files[0].hunks?.[0].lines).toEqual(['-middle', '+final']);
    const all = summarizeFileChanges([a, b]);
    expect(all.files).toHaveLength(1);
    expect(all.files[0]).toMatchObject({
      added: 1,
      removed: 1,
      hunks: [{ lines: ['-first', '+final'] }],
    });
    expect(summarizeFileChanges([a, b, reply([patch('final', 'first')])]).files).toEqual([]);
  });
  it('keeps line coordinates after insertions and untouched gaps', () => {
    const a = reply([{ path: 'a', kind: 'modified', hunks: [hunk(1, 2, [], ['inserted'])] }]);
    const b = reply([{ path: 'a', kind: 'modified', hunks: [hunk(4, 4, ['third'], ['updated'])] }]);
    const result = summarizeFileChanges([a, b]).files[0];
    expect(result.hunks).toEqual([
      hunk(1, 2, [], ['inserted']),
      hunk(3, 4, ['third'], ['updated']),
    ]);
  });
  it('validates context and composes multiple hunks from a single edit', () => {
    const initial: FilePatch = {
      path: 'a',
      kind: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [' context', '-old', '+one', '+two'],
        },
        hunk(5, 6, ['five'], ['changed']),
      ],
    };
    const next: FilePatch = {
      path: 'a',
      kind: 'modified',
      hunks: [hunk(2, 2, ['one', 'two'], ['old'])],
    };
    expect(summarizeFileChanges([reply([initial]), reply([next])]).files[0].hunks).toEqual([
      hunk(5, 5, ['five'], ['changed']),
    ]);
  });
  it('handles creates, deletes, renames, empty files and later recreation', () => {
    const create: FilePatch = {
      path: 'new.ts',
      kind: 'added',
      hunks: [hunk(0, 1, [], ['created'])],
    };
    const rename: FilePatch = {
      path: 'renamed.ts',
      previousPath: 'new.ts',
      kind: 'renamed',
      hunks: [],
    };
    expect(summarizeFileChanges([reply([create, rename])]).files[0]).toMatchObject({
      path: 'renamed.ts',
      kind: 'added',
      added: 1,
    });
    const remove: FilePatch = {
      path: 'renamed.ts',
      kind: 'deleted',
      hunks: [hunk(1, 0, ['created'], [])],
    };
    expect(summarizeFileChanges([reply([create, rename]), reply([remove])]).files).toEqual([]);
    const deleted: FilePatch = { path: 'a', kind: 'deleted', hunks: [hunk(1, 0, ['old'], [])] };
    const recreated: FilePatch = { path: 'a', kind: 'added', hunks: [hunk(0, 1, [], ['new'])] };
    expect(summarizeFileChanges([reply([deleted]), reply([recreated])]).files[0]).toMatchObject({
      kind: 'modified',
      added: 1,
      removed: 1,
    });
    expect(
      summarizeFileChanges([reply([{ path: 'empty', kind: 'added', hunks: [] }])]).files[0],
    ).toMatchObject({ kind: 'added', added: 0 });
  });
  it('never invents a continuous diff after an external edit, missing source or excessive span', () => {
    const discontinuous = summarizeFileChanges([
      reply([patch('a', 'b')]),
      reply([patch('external', 'c')]),
    ]);
    expect(discontinuous.files[0].unavailable).toContain('continuous');
    expect(discontinuous.files[0].hunks).toBeUndefined();
    expect(
      summarizeFileChanges([reply([{ path: 'binary.png', kind: 'modified' }])]).files[0].added,
    ).toBeUndefined();
    expect(
      summarizeFileChanges([
        reply([{ path: 'large', kind: 'modified', hunks: [hunk(200_000, 200_000, ['a'], ['b'])] }]),
      ]).files[0].unavailable,
    ).toBeTruthy();
  });
  it('distinguishes unrecorded history and successful zero changes and preserves non-newline source', () => {
    const old = reply([]);
    delete old.fileChanges;
    expect(summarizeFileChanges([old]).recorded).toBe(false);
    expect(summarizeFileChanges([reply([])]).recorded).toBe(true);
    const noNewline = patch('a', 'b');
    noNewline.hunks![0].lines = [
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
    ];
    expect(summarizeFileChanges([reply([noNewline])]).files[0].hunks?.[0].lines).toEqual(
      noNewline.hunks![0].lines,
    );
  });
  it('deduplicates revised events through live application, relay retention and restored workspace without prompt replay', () => {
    const message = reply([]);
    delete message.fileChanges;
    const old = snapshot([patch('a', 'b')]),
      next = snapshot([patch('a', 'c')], 2);
    const events: Parameters<typeof retainRunEvent>[0] = [];
    for (const fileChanges of [old, next, old, next]) {
      const event = { kind: 'filechanges' as const, fileChanges };
      applyRunEvent(message, event);
      retainRunEvent(events, event);
    }
    expect(events).toHaveLength(1);
    expect(message.fileChanges).toEqual(next);
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Changes',
      createdAt: 'now',
      updatedAt: 'now',
      settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
      messages: [message],
    });
    expect(
      restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0].messages[0]
        .fileChanges,
    ).toEqual(next);
    expect(JSON.stringify(historyFor(workspace.conversations[0]))).not.toContain('fileChanges');
    const base = emptyShared();
    base.conversations = workspace.conversations;
    const local = structuredClone(base),
      remote = structuredClone(base);
    delete remote.conversations[0].messages[0].fileChanges;
    remote.conversations[0].title = 'Renamed';
    expect(mergeShared(base, local, remote).conversations[0].messages[0].fileChanges).toEqual(next);
    remote.conversations[0].messages[0].runId = crypto.randomUUID();
    expect(
      mergeShared(base, local, remote).conversations[0].messages[0].fileChanges,
    ).toBeUndefined();
  });
  it('rejects malformed hunks, duplicate IDs and oversized source', () => {
    const data = snapshot([patch('a', 'b')]);
    expect(fileChangesSchema.safeParse(data).success).toBe(true);
    data.edits[0].files[0].hunks![0].oldLines = 5;
    expect(fileChangesSchema.safeParse(data).success).toBe(false);
    expect(
      fileChangesSchema.safeParse({
        ...snapshot([]),
        edits: [
          { id: 'a', files: [] },
          { id: 'a', files: [] },
        ],
      }).success,
    ).toBe(false);
  });
});
