import { describe, expect, it } from 'vitest';
import {
  fileToken,
  hasMention,
  mentionQuery,
  mentionSchema,
  mentionRequestSchema,
  retainMentions,
} from './mentions';
import { historyFor, initialWorkspace, restoreWorkspace } from './domain';
import { enqueueMessage } from './queue';

const file = {
  kind: 'file' as const,
  name: 'src/my file.ts',
  path: '/project/src/my file.ts',
  token: '@"src/my file.ts"',
};
const app = { kind: 'app' as const, name: 'Demo App', path: 'app://demo-id', token: '$demo-app' };
describe('composer mentions', () => {
  it('finds the token around the caret, including quoted paths, without matching emails or code', () => {
    expect(mentionQuery('Review @src/file.ts next', 11)).toEqual({
      kind: 'file',
      query: 'src',
      start: 7,
      end: 19,
    });
    expect(mentionQuery('Review @"my file.ts" next', 12)).toEqual({
      kind: 'file',
      query: 'my ',
      start: 7,
      end: 20,
    });
    expect(mentionQuery('Use $demo', 9)?.kind).toBe('app');
    for (const text of ['a@b', '`@src', '```\n@file', 'cost $1.00', 'Use @done next'])
      expect(mentionQuery(text, text.length)).toBeUndefined();
    expect(fileToken('src/my file.ts')).toBe(file.token);
  });
  it('drops deleted and renamed tokens, deduplicates identities and retains surrounding edits', () => {
    expect(retainMentions(`Read ${file.token} and ${app.token}.`, [file, app, file])).toEqual([
      file,
      app,
    ]);
    expect(retainMentions('$demo-app-other @"src/my file.ts.old"', [file, app])).toEqual([]);
    expect(hasMention('email$demo-app', app.token)).toBe(false);
    expect(hasMention('@src/file.ts.bak', '@src/file.ts')).toBe(false);
  });
  it('rejects malformed paths, unsafe app URLs, unknown kinds and foreign request fields', () => {
    expect(mentionSchema.safeParse(file).success).toBe(true);
    expect(mentionSchema.safeParse(app).success).toBe(true);
    for (const value of [
      { ...file, path: 'relative' },
      { ...file, name: 'bad\nname' },
      { ...app, path: 'https://app' },
      { ...app, path: 'app://x?secret=y' },
      { ...app, kind: 'tool' },
    ])
      expect(mentionSchema.safeParse(value).success).toBe(false);
    expect(mentionRequestSchema.safeParse({ provider: 'claude', kind: 'app' }).success).toBe(false);
  });
  it('preserves references through queue, save and portable history without catalog data', () => {
    const queued = enqueueMessage([], {
      text: file.token,
      images: [],
      mentions: [file],
      mentionConnectionId: 'connection',
    });
    expect(queued.queue[0].mentions).toEqual([file]);
    const workspace = initialWorkspace();
    const now = new Date().toISOString();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Mention',
      createdAt: now,
      updatedAt: now,
      settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          status: 'complete',
          createdAt: now,
          blocks: [{ type: 'markdown', text: file.token }],
          mentions: [file, app],
        },
      ],
    });
    expect(
      historyFor(restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0])[0]
        .mentions,
    ).toEqual([file, app]);
  });
});
