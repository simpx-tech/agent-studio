import { expect, it } from 'vitest';
import {
  fileRuns,
  galleryRows,
  imageAspect,
  imageInfo,
  isModel,
  mergeSentFiles,
  sentFileGroupsSchema,
  sentFilesSchema,
  type SentFiles,
} from './sent-files';
import { modelBytes, modelFormats } from './tool-output';
import { applyRunEvent, retainRunEvent } from './activity';
import { replyContent } from './markdown';
import {
  historyFor,
  initialWorkspace,
  messageSchema,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { mergeShared, sharedWorkspace } from './sync';

const runId = crypto.randomUUID();
const group: SentFiles = {
  id: 'renders',
  revision: 1,
  runId,
  toolId: 'toolu_01',
  caption: 'Front and back',
  files: [
    { index: 0, name: 'front.png', mediaType: 'image/png', bytes: 2048, width: 512, height: 512 },
    { index: 1, name: 'back.png', mediaType: 'image/png', bytes: 1024 },
  ],
};
function reply(): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    createdAt: new Date().toISOString(),
    status: 'complete',
    runId,
    blocks: [{ type: 'markdown', text: 'Here are the renders.\n\n<!-- files:renders -->' }],
  };
}

it('keeps shown files with their reply through checkpoints, storage and a conflict merge', () => {
  const message = reply();
  const events: RunEvent[] = [];
  for (const sentFiles of [
    group,
    { ...group, id: 'chart' },
    { ...group, revision: 2, caption: 'Front, back and side' },
    group,
  ]) {
    const event: RunEvent = { kind: 'sentfiles', sentFiles };
    applyRunEvent(message, event);
    retainRunEvent(events, event);
  }
  expect(message.sentFiles).toHaveLength(2);
  expect(message.sentFiles?.[0].caption).toBe('Front, back and side');
  expect(events).toHaveLength(2);
  expect(events[0].sentFiles?.revision).toBe(2);
  // Files are recorded separately from tool activity, which the event leaves untouched.
  expect(message.blocks).toHaveLength(1);
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Renders',
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  });
  expect(
    restoreWorkspace(JSON.parse(JSON.stringify(workspace))).conversations[0].messages[0].sentFiles,
  ).toEqual(message.sentFiles);
  expect(historyFor(workspace.conversations[0])[0]).not.toHaveProperty('sentFiles');
  const base = sharedWorkspace(workspace),
    local = structuredClone(base),
    remote = structuredClone(base);
  local.conversations[0].messages[0].sentFiles = [{ ...group, revision: 3 }];
  remote.conversations[0].messages[0].sentFiles = [{ ...group, id: 'chart', revision: 2 }];
  const merged = mergeShared(base, local, remote);
  expect(merged.conversations[0].messages[0].sentFiles?.map((g) => g.revision)).toEqual([3, 2]);
});

it('rejects foreign runs, duplicates, unsupported types and user messages', () => {
  expect(sentFilesSchema.safeParse({ ...group, runId: 'not-a-run' }).success).toBe(false);
  expect(sentFilesSchema.safeParse({ ...group, files: [] }).success).toBe(false);
  expect(
    sentFilesSchema.safeParse({
      ...group,
      files: [{ index: 0, name: 'doc.pdf', mediaType: 'application/pdf', bytes: 10 }],
    }).success,
  ).toBe(false);
  expect(
    sentFilesSchema.safeParse({ ...group, files: [group.files[0], group.files[0]] }).success,
  ).toBe(false);
  expect(sentFileGroupsSchema.safeParse([group, group]).success).toBe(false);
  expect(
    sentFileGroupsSchema.safeParse(
      Array.from({ length: 13 }, (_, i) => ({ ...group, id: `g${i}` })),
    ).success,
  ).toBe(false);
  // A group belongs to the run that kept its images on the executing computer.
  const other = reply();
  applyRunEvent(other, { kind: 'sentfiles', sentFiles: { ...group, runId: crypto.randomUUID() } });
  expect(other.sentFiles).toBeUndefined();
  const user = reply();
  user.role = 'user';
  applyRunEvent(user, { kind: 'sentfiles', sentFiles: group });
  expect(user.sentFiles).toBeUndefined();
  expect(
    messageSchema.safeParse({ ...reply(), runId: crypto.randomUUID(), sentFiles: [group] }).success,
  ).toBe(false);
  expect(mergeSentFiles([group], [{ ...group, revision: 1, caption: 'Older' }])[0].caption).toBe(
    group.caption,
  );
});

// Prose parts need a DOM to sanitize; tests/sent-files.spec.ts covers a marker between
// paragraphs in the real reply.
it('places a group at its own marker, once, and keeps an unmarked group in the reply', () => {
  const parts = replyContent('<!-- files:renders -->', [], [group]);
  expect(parts.map((p) => p.type)).toEqual(['files']);
  expect(parts[0].type === 'files' && parts[0].groups.map((g) => g.id)).toEqual(['renders']);
  expect(
    replyContent('<!-- files:renders -->\n\n<!-- files:renders -->', [], [group]),
  ).toHaveLength(1);
  expect(replyContent('', [], [group]).map((p) => p.type)).toEqual(['files']);
  expect(replyContent('<!-- files:missing -->', [], [])).toEqual([]);
  expect(replyContent('<!-- visualize:renders -->', [], [group]).map((p) => p.type)).toEqual([
    'files',
  ]);
});

it('records a 3D model beside images and reads its bytes back', async () => {
  const model = {
    ...group,
    id: 'figure',
    files: [
      { index: 0, name: 'figure.glb', mediaType: 'model/gltf-binary' as const, bytes: 2048 },
      group.files[0],
    ],
  };
  expect(sentFilesSchema.safeParse(model).success).toBe(true);
  expect(model.files.map(isModel)).toEqual([true, false]);
  expect(imageInfo(group.files[0])).toEqual({
    index: 0,
    mediaType: 'image/png',
    bytes: 2048,
    width: 512,
    height: 512,
  });
  expect(modelFormats['model/gltf-binary']).toBe('glb');
  // Images and models are numbered within their own kind, so both start at zero.
  expect(mergeSentFiles([group], [model]).map((g) => g.id)).toEqual(['renders', 'figure']);
  const bytes = new Uint8Array(await modelBytes({ format: 'glb', data: 'Z2xURg==', bytes: 4 }));
  expect([...bytes]).toEqual([...new TextEncoder().encode('glTF')]);
});

const image = (index: number, width?: number, height?: number) => ({
  index,
  name: `shot-${index}.png`,
  mediaType: 'image/png' as const,
  bytes: 10,
  width,
  height,
});
const model = { index: 0, name: 'tree.glb', mediaType: 'model/gltf-binary' as const, bytes: 10 };
const shown = (id: string, files: SentFiles['files']): SentFiles => ({ ...group, id, files });

it('lays consecutive images side by side and gives each model a place of its own', () => {
  const runs = fileRuns([
    shown('renders', [image(0), image(1), model, image(2)]),
    shown('more', [image(0)]),
  ]);
  expect(runs.map((run) => (run.kind === 'images' ? run.items.length : 'model'))).toEqual([
    2,
    'model',
    2,
  ]);
  // Each file keeps the call it came in.
  const last = runs[2].kind === 'images' ? runs[2].items : [];
  expect(last.map(({ group, file }) => `${group.id}:${file.index}`)).toEqual([
    'renders:2',
    'more:0',
  ]);
  // A size that was not reported takes a common shape; extreme strips are bounded.
  expect(imageAspect(image(0))).toBeCloseTo(4 / 3);
  expect(imageAspect(image(0, 1440, 900))).toBe(1.6);
  expect(imageAspect(image(0, 10_000, 10))).toBe(4);
  expect(imageAspect(image(0, 10, 10_000))).toBe(0.3);
});

it('splits a gallery into balanced rows that need no measuring', () => {
  const screens = (count: number) => Array(count).fill(1.6);
  expect(galleryRows([])).toEqual([]);
  expect(galleryRows([1.6])).toEqual([[0]]);
  // Two or three screenshots share a row.
  expect(galleryRows(screens(2))).toEqual([[0, 1]]);
  expect(galleryRows(screens(3))).toEqual([[0, 1, 2]]);
  // More form rows of two or three, never a lone image at the end.
  expect(galleryRows(screens(4))).toEqual([
    [0, 1],
    [2, 3],
  ]);
  expect(galleryRows(screens(5))).toEqual([
    [0, 1],
    [2, 3, 4],
  ]);
  expect(galleryRows(screens(8)).map((row) => row.length)).toEqual([2, 3, 3]);
  // Portraits and panoramas of one render share a row by their shapes.
  expect(galleryRows([0.97, 2, 0.8, 1])).toEqual([[0, 1, 2, 3]]);
  expect(galleryRows([2.37, 1.5, 3.56, 3.56])).toEqual([[0, 1], [2], [3]]);
});

it('joins single images placed side by side into one gallery, and nothing else', () => {
  const a = shown('a', [image(0)]);
  const b = shown('b', [image(0)]);
  const c = shown('c', [image(0)]);
  const ids = (parts: ReturnType<typeof replyContent>) =>
    parts.map((part) => (part.type === 'files' ? part.groups.map((g) => g.id) : part.type));
  // Pictures sent one call at a time, their markers one after another.
  expect(ids(replyContent('<!-- files:a -->\n\n<!-- files:b -->', [], [a, b]))).toEqual([
    ['a', 'b'],
  ]);
  // Groups whose markers never arrived follow the prose together.
  expect(ids(replyContent('', [], [a, b, c]))).toEqual([['a', 'b', 'c']]);
  // A call that sent several files keeps its own gallery and caption, and a model its place.
  const several = shown('several', [image(0), image(1)]);
  const figure = shown('figure', [model]);
  expect(ids(replyContent('', [], [a, several, b, figure, c]))).toEqual([
    ['a'],
    ['several'],
    ['b'],
    ['figure'],
    ['c'],
  ]);
  // The joined part keeps its first group's key, so the gallery stays as more arrive.
  expect(replyContent('', [], [a, b])[0].key).toBe(replyContent('', [], [a])[0].key);
});
