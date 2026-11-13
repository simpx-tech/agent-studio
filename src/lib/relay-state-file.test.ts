// The relay's saved state, written and read a conversation at a time (scripts/vps/state-file.ts): a
// text holds at most 536,870,888 characters, which the owner's 465 MB file was days from on
// 2026-11-13.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readState, scanState, writeState } from '../../scripts/vps/state-file';

const folder = mkdtempSync(join(tmpdir(), 'relay-state-file-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
let files = 0;
const file = (text?: string) => {
  const path = join(folder, `state-${files++}.json`);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};

// Text a scanner could trip over: brackets, quotes and backslashes in strings, characters of two,
// three and four bytes, and the words it looks for where they mean nothing.
const awkward = [
  'plain',
  '}{][",:',
  'a "quoted" \\ backslash \\" and \\\\',
  'ends with a backslash \\',
  'é “curly” 😀 日本語',
  '"conversations":[{"id":"not one"}]',
  '\u0000\u001f\n\t',
];
const chat = (n: number) => ({
  id: `chat-${n}`,
  title: awkward[n % awkward.length],
  workspace: { conversations: [{ id: 'nested, and no conversation of the workspace' }] },
  messages: awkward.map((text, index) => ({
    id: `${n}-${index}`,
    blocks: [{ type: 'markdown', text }, []],
    conversations: [1, [2, { three: '}' }]],
    status: index % 2 ? 'running' : 'complete',
  })),
  empty: {},
  list: [],
  number: -1.5e-7,
  none: null,
  yes: true,
});
const state = (chats: number) => ({
  instanceId: 'relay',
  version: 2,
  revision: 7,
  workspace: {
    fleet: { computers: [{ name: '"conversations":[' }], conversations: ['of the fleet'] },
    conversations: Array.from({ length: chats }, (_, n) => chat(n)),
    workflows: [],
    claudeInstructions: awkward.join(' '),
  },
  chatRevisions: { 'chat-0': 7, conversations: 1 },
  metaRevision: 3,
});

describe('the relay’s state file', () => {
  it('is written a conversation at a time as the JSON it always was', () => {
    for (const chats of [0, 1, 5]) {
      const path = file();
      writeState(path, state(chats));
      // An earlier release reads it as one text.
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(state(chats));
      expect(readState(path)).toEqual(state(chats));
    }
    // A workspace of nothing but conversations, and a state of nothing but its workspace.
    const bare = { workspace: { conversations: [chat(1)] } };
    const path = file();
    writeState(path, bare);
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(bare));
    expect(readState(path)).toEqual(bare);
  });

  it('reads what earlier releases wrote, however it is laid out and wherever a read ends', () => {
    const value = state(4);
    const layouts = [
      // One line, the workspace in the middle and its conversations before its other fields.
      JSON.stringify(value),
      JSON.stringify(value, null, 2),
      JSON.stringify(value, null, '\t').replace(/\n/g, '\r\n'),
      ` \n${JSON.stringify(value)}\n `,
    ];
    for (const text of layouts) {
      const path = file(text);
      // Reads that end inside a character, an escape, a field's name and between conversations.
      for (const bytes of [1, 2, 3, 5, 7, 64, 1 << 16])
        expect(readState(path, bytes), `${bytes} bytes a read`).toEqual(value);
    }
  });

  it('hands each conversation over as it is read, for a reader that keeps none', () => {
    const value = state(6);
    const path = file(JSON.stringify(value));
    const seen: string[] = [];
    let running = 0;
    const rest = scanState(
      path,
      (conversation) => {
        const read = conversation as ReturnType<typeof chat>;
        seen.push(read.id);
        running += read.messages.filter((message) => message.status === 'running').length;
      },
      11,
    );
    expect(seen).toEqual(value.workspace.conversations.map((c) => c.id));
    expect(running).toBe(6 * Math.floor(awkward.length / 2));
    expect(rest).toEqual({ ...value, workspace: { ...value.workspace, conversations: [] } });
  });

  it('parses a document whose conversations are not where the relay writes them', () => {
    for (const value of [
      { version: 1 },
      { workspace: [] },
      { workspace: { fleet: {} } },
      { workspace: { conversations: {} } },
      { conversations: [chat(0)], workspace: { nested: { conversations: [chat(1)] } } },
      [{ workspace: { conversations: [chat(0)] } }],
      'workspace',
      null,
    ]) {
      const path = file(JSON.stringify(value));
      const taken: unknown[] = [];
      expect(readState(path, 5)).toEqual(value);
      expect(scanState(path, (c) => void taken.push(c), 5)).toEqual(value);
      expect(taken).toEqual([]);
    }
    // Two lists in that place are refused rather than joined.
    const twice = '{"workspace":{"conversations":[{"id":"a"}],"conversations":[{"id":"b"}]}}';
    expect(() => readState(file(twice), 4)).toThrow(SyntaxError);
    const again = '{"workspace":{"conversations":[]},"workspace":{"conversations":[{"id":"b"}]}}';
    expect(() => readState(file(again), 4)).toThrow(SyntaxError);
  });

  it('refuses what is not a whole JSON document', () => {
    const text = JSON.stringify(state(2));
    for (const broken of [
      '',
      '{',
      text.slice(0, -1),
      text.slice(0, text.indexOf('"messages"')),
      `${text}}`,
      '{"workspace":{"conversations":[1]}}',
      '{"workspace":{"conversations":["a"]}}',
      '{"workspace":{"conversations":[[]]}}',
      '{"workspace":{"conversations":[{"id":}]}}',
      'not json',
    ])
      for (const bytes of [3, 1 << 16])
        expect(() => readState(file(broken), bytes), broken.slice(0, 40)).toThrow(SyntaxError);
    // A missing file is the caller's to tell from an unreadable one.
    expect(() => readState(join(folder, 'missing.json'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('reads and writes conversations far larger than a read', () => {
    const large = state(3);
    large.workspace.conversations[1].title = 'é😀"\\'.repeat(400_000);
    const path = file();
    writeState(path, large);
    expect(readState(path, 1 << 16)).toEqual(large);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(large);
  });
});
