import { describe, expect, it } from 'vitest';
import {
  combineDrafts,
  draftKey,
  hasDraft,
  maxSavedDraftBytes,
  maxSavedDrafts,
  maxSavedDraftText,
  mergeSavedDrafts,
  readSavedDrafts,
  restoredDraft,
  sameDraft,
  savedDraft,
  savedDraftsFile,
  type Draft,
  type DraftChange,
  type SavedDraft,
} from './drafts';
import type { ChatImage } from './images';
import type { Mention } from './mentions';

const image = (name: string): ChatImage => ({
  id: crypto.randomUUID(),
  name,
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
});
const file: Mention = {
  kind: 'file',
  name: 'src/app.ts',
  path: 'C:\\Projects\\studio\\src\\app.ts',
  token: '@src/app.ts',
};
const app: Mention = { kind: 'app', name: 'Demo App', path: 'app://demo', token: '$demo-app' };
const draft = (text: string, extra: Partial<Draft> = {}): Draft => ({
  text,
  images: [],
  mentions: [],
  staleMentions: [],
  mentionScope: '',
  updatedAt: 1000,
  ...extra,
});
const saved = (key: string, text: string, updatedAt: number): SavedDraft => ({
  key,
  text,
  updatedAt,
});
const location = {
  computerId: '22222222-2222-4222-8222-222222222222',
  environmentId: '11111111-1111-4111-8111-111111111111',
  path: 'C:\\Projects\\studio',
};

describe('composer drafts', () => {
  it('keys chats, folders, Standalone locations, and computers separately', () => {
    const id = crypto.randomUUID();
    expect(draftKey.chat(id)).toBe(`chat:${id}`);
    const folder = draftKey.folder(location);
    const standalone = draftKey.folder({ ...location, path: '' });
    expect(folder).toMatch(/^folder:/);
    expect(folder).toContain('C:\\Projects\\studio');
    expect(standalone).not.toBe(folder);
    expect(
      draftKey.folder({ ...location, computerId: '44444444-4444-4444-8444-444444444444' }),
    ).not.toBe(folder);
    expect(
      draftKey.folder({
        ...location,
        executionEnvironmentId: '33333333-3333-4333-8333-333333333333',
      }),
    ).not.toBe(folder);
    expect(draftKey.computer(location.computerId)).toBe(`computer:${location.computerId}`);
    expect(hasDraft(draft(''))).toBe(false);
    expect(hasDraft(draft(' '))).toBe(true);
    expect(hasDraft(draft('', { images: [image('only.png')] }))).toBe(true);
  });

  it('saves text and current mention identity without images', () => {
    const value = draft(`Review ${file.token} with ${app.token}`, {
      images: [image('screen.png')],
      mentions: [file, app, { ...file, token: '@gone.ts', name: 'gone.ts' }],
      staleMentions: ['$old-app', '$old-app', '@removed.ts'],
      mentionScope: 'scope',
    });
    value.text += ' and $old-app';
    expect(savedDraft('chat:a', value)).toEqual({
      key: 'chat:a',
      text: value.text,
      mentions: [file, app],
      staleMentions: ['$old-app'],
      mentionScope: 'scope',
      updatedAt: 1000,
    });
    expect(savedDraft('chat:a', draft('Plain', { mentionScope: 'scope' }))).toEqual(
      saved('chat:a', 'Plain', 1000),
    );
    expect(savedDraft('chat:a', draft('', { images: [image('only.png')] }))).toBeUndefined();
    expect(savedDraft('chat:a', undefined)).toBeUndefined();
    expect(savedDraft('chat:a', draft('x'.repeat(maxSavedDraftText + 1)))).toBeUndefined();
    expect(savedDraft('other:a', draft('Unknown key'))).toBeUndefined();
  });

  it('reads saved drafts leniently and restores them without images', () => {
    expect(readSavedDrafts(null).size).toBe(0);
    expect(readSavedDrafts({ version: 2, drafts: [saved('chat:a', 'Later format', 1)] }).size).toBe(
      0,
    );
    const drafts = readSavedDrafts({
      version: 1,
      drafts: [
        saved('chat:a', 'Older', 1),
        saved('chat:a', 'Newer', 5),
        saved('chat:a', 'Stale copy', 3),
        { key: 'chat:b', text: 'Keeps its text', mentions: [{ kind: 'file' }], updatedAt: 2 },
        { key: 'chat:c', text: '', updatedAt: 2 },
        { key: 'unknown:d', text: 'Wrong key', updatedAt: 2 },
        'not a draft',
      ],
    });
    expect([...drafts.keys()]).toEqual(['chat:a', 'chat:b']);
    expect(drafts.get('chat:a')?.text).toBe('Newer');
    expect(drafts.get('chat:b')).toEqual(saved('chat:b', 'Keeps its text', 2));
    const withMentions = savedDraft(
      'chat:m',
      draft(file.token, { mentions: [file], mentionScope: 'scope' }),
    )!;
    expect(
      restoredDraft(readSavedDrafts({ version: 1, drafts: [withMentions] }).get('chat:m')!),
    ).toEqual(draft(file.token, { mentions: [file], mentionScope: 'scope' }));
  });

  it('keeps the newest drafts within the count and size limits', () => {
    const many = Array.from({ length: maxSavedDrafts + 5 }, (_, i) =>
      saved(`chat:${i}`, `Draft ${i}`, i),
    );
    const kept = savedDraftsFile(many).drafts;
    expect(kept).toHaveLength(maxSavedDrafts);
    expect(kept[0].key).toBe(`chat:${maxSavedDrafts + 4}`);
    expect(kept.some((d) => d.key === 'chat:0')).toBe(false);
    const large = saved('chat:large', 'x'.repeat(maxSavedDraftBytes), 10);
    const result = savedDraftsFile([large, saved('chat:small', 'Still saved', 1)]).drafts;
    expect(result.map((d) => d.key)).toEqual(['chat:small']);
  });

  it('merges this window’s changes without dropping or replacing newer saves elsewhere', () => {
    const stored = new Map<string, SavedDraft>([
      ['chat:other-tab', saved('chat:other-tab', 'Typed in another tab', 50)],
      ['chat:sent', saved('chat:sent', 'Sent from here', 10)],
      ['chat:edited-later', saved('chat:edited-later', 'Newer elsewhere', 90)],
      ['chat:cleared-later', saved('chat:cleared-later', 'Retyped elsewhere', 90)],
    ]);
    const changes = new Map<string, DraftChange>([
      ['chat:new', { at: 60, draft: saved('chat:new', 'New here', 60) }],
      ['chat:sent', { at: 70 }],
      ['chat:edited-later', { at: 80, draft: saved('chat:edited-later', 'Older here', 80) }],
      ['chat:cleared-later', { at: 80 }],
    ]);
    const merged = mergeSavedDrafts(stored, changes);
    expect(Object.fromEntries(merged.drafts.map((d) => [d.key, d.text]))).toEqual({
      'chat:other-tab': 'Typed in another tab',
      'chat:new': 'New here',
      'chat:edited-later': 'Newer elsewhere',
      'chat:cleared-later': 'Retyped elsewhere',
    });
    expect(merged.version).toBe(1);
    expect(merged.drafts.map((d) => d.updatedAt)).toEqual([90, 90, 60, 50]);
  });

  it('carries composer content into an existing draft without losing either', () => {
    const [one, two, three, four] = ['1', '2', '3', '4'].map((n) => image(`${n}.png`));
    const existing = draft('Saved for this folder\n', {
      images: [one, two],
      mentions: [file],
      mentionScope: 'folder',
    });
    const carried = draft('  Typed before switching', {
      images: [two, three, four],
      mentions: [app],
      staleMentions: ['$old'],
      mentionScope: 'other',
    });
    const { draft: combined, droppedImages } = combineDrafts(existing, carried, 3);
    expect(combined.text).toBe('Saved for this folder\n\nTyped before switching');
    expect(combined.images).toEqual([one, two, three]);
    expect(droppedImages).toBe(1);
    expect(combined.mentions).toEqual([]);
    expect(combined.staleMentions).toEqual([file.token, '$old', app.token]);
    expect(combined.mentionScope).toBe('');
    expect(combineDrafts(draft('Same'), draft(' Same '), 4).draft.text).toBe('Same');
    expect(combineDrafts(undefined, carried, 4)).toEqual({ draft: carried, droppedImages: 0 });
    expect(combineDrafts(draft(''), carried, 4)).toEqual({ draft: carried, droppedImages: 0 });
    expect(combineDrafts(existing, draft(''), 4)).toEqual({ draft: existing, droppedImages: 0 });
    expect(sameDraft(combined, { ...combined, images: [...combined.images] })).toBe(true);
    expect(sameDraft(combined, { ...combined, text: 'changed' })).toBe(false);
    expect(sameDraft(combined, { ...combined, images: [one, two, four] })).toBe(false);
  });
});
