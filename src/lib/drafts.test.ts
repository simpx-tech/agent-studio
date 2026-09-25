import { describe, expect, it } from 'vitest';
import {
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
  savedScratch,
  scratchIdOf,
  scratchTitle,
  type Draft,
  type DraftChange,
  type SavedDraft,
  type SavedScratch,
} from './drafts';
import type { ChatImage } from './images';
import { locationKey } from './locations';
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
const place: SavedScratch = {
  computerId: location.computerId,
  location,
  settings: {
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'high',
    instructions: 'Answer briefly.',
    connectionId: '55555555-5555-4555-8555-555555555555',
  },
  createdAt: 5,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('composer drafts', () => {
  it('keys chats and scratch chats separately and names scratch chats by their first line', () => {
    const id = crypto.randomUUID();
    expect(draftKey.chat(id)).toBe(`chat:${id}`);
    expect(draftKey.scratch(id)).toBe(`scratch:${id}`);
    expect(scratchIdOf(draftKey.scratch(id))).toBe(id);
    expect(scratchIdOf(draftKey.chat(id))).toBeUndefined();
    expect(hasDraft(draft(''))).toBe(false);
    expect(hasDraft(draft(' '))).toBe(true);
    expect(hasDraft(draft('', { images: [image('only.png')] }))).toBe(true);
    expect(scratchTitle(draft('\n  Plan the release  \nThen ship it'))).toBe('Plan the release');
    expect(scratchTitle(draft('x'.repeat(200)))).toHaveLength(120);
    expect(scratchTitle(draft(' \n', { images: [image('only.png')] }))).toBe('Image conversation');
    expect(scratchTitle(draft(''))).toBe('');
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
    // A scratch chat's draft also records its computer, folder and settings; a chat's never does.
    const id = crypto.randomUUID();
    expect(savedDraft(draftKey.scratch(id), draft('Idea'), place)).toEqual({
      key: `scratch:${id}`,
      text: 'Idea',
      scratch: place,
      updatedAt: 1000,
    });
    expect(savedDraft('chat:a', draft('Plain'), place)).toEqual(saved('chat:a', 'Plain', 1000));
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
        {
          key: 'scratch:e',
          text: 'Keeps its place',
          scratch: { ...place, settings: { provider: 'future' } },
          updatedAt: 2,
        },
        { key: 'scratch:f', text: 'Keeps its text', scratch: { computerId: 5 }, updatedAt: 2 },
      ],
    });
    expect([...drafts.keys()]).toEqual(['chat:a', 'chat:b', 'scratch:e', 'scratch:f']);
    expect(drafts.get('chat:a')?.text).toBe('Newer');
    expect(drafts.get('chat:b')).toEqual(saved('chat:b', 'Keeps its text', 2));
    const { settings: _settings, ...placed } = place;
    expect(drafts.get('scratch:e')?.scratch).toEqual(placed);
    expect(drafts.get('scratch:f')).toEqual(saved('scratch:f', 'Keeps its text', 2));
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

  it('restores scratch chats and turns earlier per-folder drafts into scratch chats in place', () => {
    const id = crypto.randomUUID();
    expect(savedScratch({ ...saved(draftKey.scratch(id), 'Idea', 9), scratch: place })).toEqual({
      id,
      ...place,
    });
    // Without its saved place, a scratch chat still keeps its text.
    expect(savedScratch(saved(draftKey.scratch(id), 'Idea', 9))).toEqual({
      id,
      computerId: '',
      createdAt: 9,
    });
    expect(savedScratch(saved('scratch:not-an-id', 'Idea', 9))).toBeUndefined();
    expect(savedScratch(saved('chat:a', 'A reply', 9))).toBeUndefined();
    // Earlier releases keyed one new-chat draft by folder, with `locationKey`, or by computer.
    const legacy = (key: string) => savedScratch(saved(key, 'Earlier idea', 7));
    const folder = legacy(`folder:${locationKey(location)}`);
    expect(folder).toEqual({
      id: expect.stringMatching(uuid),
      computerId: location.computerId,
      location,
      createdAt: 7,
    });
    expect(legacy(`folder:${locationKey(location)}`)?.id).not.toBe(folder?.id);
    const wsl = {
      ...location,
      environmentId: '33333333-3333-4333-8333-333333333333',
      executionEnvironmentId: location.environmentId,
      path: '/home/test/studio',
    };
    expect(legacy(`folder:${locationKey(wsl)}`)?.location).toEqual(wsl);
    const standalone = { ...location, path: '' };
    expect(legacy(`folder:${locationKey(standalone)}`)?.location).toEqual(standalone);
    expect(legacy(`computer:${location.computerId}`)).toEqual({
      id: expect.stringMatching(uuid),
      computerId: location.computerId,
      createdAt: 7,
    });
    expect(legacy('folder:not/a/location')).toBeUndefined();
  });

  it('compares drafts by content and image identity', () => {
    const [one, two, three] = ['1', '2', '3'].map((n) => image(`${n}.png`));
    const value = draft('Text', { images: [one, two], mentions: [file], mentionScope: 'scope' });
    expect(sameDraft(value, { ...value, images: [...value.images] })).toBe(true);
    expect(sameDraft(value, { ...value, text: 'changed' })).toBe(false);
    expect(sameDraft(value, { ...value, images: [one, three] })).toBe(false);
    expect(sameDraft(value, { ...value, mentions: [app] })).toBe(false);
  });
});
