import { expect, it } from 'vitest';
import {
  fileKind,
  fileRuns,
  galleryRows,
  imageAspect,
  imageInfo,
  isComparison,
  isModel,
  mergeSentFiles,
  messageFiles,
  paneLabel,
  sentFileGroupsSchema,
  sentFilesSchema,
  type SentFiles,
} from './sent-files';
import { modelBytes, modelFormats } from './tool-output';
import { applyRunEvent, retainRunEvent } from './activity';
import { replyContent } from './markdown';
import { restoreMessage } from './light-chats';
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
  // Any number of groups and files, with names, captions and dimensions of any size.
  expect(
    sentFileGroupsSchema.safeParse(
      Array.from({ length: 13 }, (_, i) => ({ ...group, id: `g${i}` })),
    ).success,
  ).toBe(true);
  const files = Array.from({ length: 20 }, (_, index) => ({
    index: index * 10,
    name: `${'n'.repeat(200)}.png`,
    mediaType: 'image/png' as const,
    bytes: 1,
    width: 200_000,
    height: 200_000,
  }));
  const large = {
    ...group,
    id: 'g'.repeat(100),
    toolId: 't'.repeat(300),
    caption: 'c'.repeat(400),
  };
  expect(sentFilesSchema.parse({ ...large, files })).toEqual({ ...large, files });
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
  const { parts } = replyContent('<!-- files:renders -->', [], [group]);
  expect(parts.map((p) => p.type)).toEqual(['files']);
  expect(parts[0].type === 'files' && parts[0].groups.map((g) => g.id)).toEqual(['renders']);
  expect(
    replyContent('<!-- files:renders -->\n\n<!-- files:renders -->', [], [group]).parts,
  ).toHaveLength(1);
  expect(replyContent('', [], [group]).parts.map((p) => p.type)).toEqual(['files']);
  expect(replyContent('<!-- files:missing -->', [], []).parts).toEqual([]);
  expect(replyContent('<!-- visualize:renders -->', [], [group]).parts.map((p) => p.type)).toEqual([
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
  const ids = ({ parts }: ReturnType<typeof replyContent>) =>
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
  expect(replyContent('', [], [a, b]).parts[0].key).toBe(replyContent('', [], [a]).parts[0].key);
});

const comparison: SentFiles = {
  ...group,
  id: 'before-after',
  compare: true,
  caption: 'Upscaled twice',
  files: [
    { ...image(0, 512, 512), label: 'Before' },
    { ...image(1, 1024, 1024), label: 'After' },
  ],
};

it('keeps a comparison and its labels through storage, sync and later revisions', () => {
  expect(sentFilesSchema.parse(comparison)).toEqual(comparison);
  expect(isComparison(comparison)).toBe(true);
  // A single file, or a group sent by send_files, is not compared.
  expect(isComparison({ ...comparison, files: [comparison.files[0]] })).toBe(false);
  expect(isComparison(group)).toBe(false);
  expect(paneLabel(comparison.files[0])).toBe('Before');
  expect(paneLabel(image(0))).toBe('shot-0.png');
  // Labels are one line, as the host keeps them.
  const labelled = (label: string) => ({
    ...comparison,
    files: [{ ...image(0), label }, image(1)],
  });
  expect(sentFilesSchema.safeParse(labelled('Before\nafter')).success).toBe(false);
  expect(sentFilesSchema.safeParse(labelled('  ')).success).toBe(false);
  expect(sentFilesSchema.safeParse(labelled('L'.repeat(500))).success).toBe(true);

  const message = reply();
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: comparison });
  expect(message.sentFiles).toEqual([comparison]);
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Upscale',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  });
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
  expect(restored.conversations[0].messages[0].sentFiles).toEqual([comparison]);
  // A later revision under the same id replaces it, comparison or not, on either side.
  const base = sharedWorkspace(workspace),
    local = structuredClone(base),
    remote = structuredClone(base);
  const plain = { ...group, id: comparison.id, revision: 2 };
  remote.conversations[0].messages[0].sentFiles = [plain];
  const merged = mergeShared(base, local, remote).conversations[0].messages[0].sentFiles!;
  expect(merged).toEqual([plain]);
  expect(mergeSentFiles([plain], [{ ...comparison, revision: 3 }])[0].compare).toBe(true);
});

it('places a comparison at its marker on its own, never in a gallery', () => {
  const a = shown('a', [image(0)]);
  const b = shown('b', [image(0)]);
  const ids = ({ parts }: ReturnType<typeof replyContent>) =>
    parts.map((part) => (part.type === 'files' ? part.groups.map((g) => g.id) : part.type));
  expect(
    ids(
      replyContent(
        '<!-- files:a -->\n\n<!-- files:before-after -->\n\n<!-- files:b -->',
        [],
        [a, comparison, b],
      ),
    ),
  ).toEqual([['a'], ['before-after'], ['b']]);
  // A comparison of single images placed one after another still stands alone.
  const pair = { ...comparison, files: [image(0), image(1)] };
  expect(ids(replyContent('', [], [a, pair]))).toEqual([['a'], ['before-after']]);
});

const table = { index: 0, name: 'sales.csv', mediaType: 'text/csv' as const, bytes: 40 };
const notes = { index: 1, name: 'notes.md', mediaType: 'text/markdown' as const, bytes: 90 };
const clip = {
  index: 2,
  name: 'clip.mp4',
  mediaType: 'video/mp4' as const,
  bytes: 4000,
  width: 1920,
  height: 1080,
};
/** What releases before tables, documents and videos accept in a reply's sentFiles. */
const earlierReleaseReads = (groups: SentFiles[] = []) =>
  groups.every((g) => g.files.every((f) => /^(image|model)\//.test(f.mediaType)));

it('keeps groups with a table, a document or a video where earlier releases never meet them', () => {
  const message = reply();
  const mixed = { ...group, id: 'mixed', files: [group.files[0], table, notes, clip] };
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: group });
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: mixed });
  expect(message.sentFiles?.map((g) => g.id)).toEqual(['renders']);
  expect(message.extraSentFiles?.map((g) => g.id)).toEqual(['mixed']);
  expect(earlierReleaseReads(message.sentFiles)).toBe(true);
  expect(messageFiles(message).map((g) => g.id)).toEqual(['renders', 'mixed']);
  // The other files are numbered apart from the images, each kind from 0.
  expect(sentFilesSchema.safeParse({ ...group, files: [group.files[0], table] }).success).toBe(
    true,
  );
  expect(
    sentFilesSchema.safeParse({ ...group, files: [table, { ...notes, index: 0 }] }).success,
  ).toBe(false);
  // The reply's own field for images and models refuses the others; theirs takes them.
  expect(messageSchema.safeParse({ ...reply(), sentFiles: [mixed] }).success).toBe(false);
  expect(messageSchema.safeParse({ ...reply(), extraSentFiles: [mixed] }).success).toBe(true);
  expect(
    messageSchema.safeParse({ ...reply(), runId: crypto.randomUUID(), extraSentFiles: [mixed] })
      .success,
  ).toBe(false);
  // Saved and restored, both fields stay as they were.
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Report',
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  });
  const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
  expect(restored.conversations[0].messages[0].extraSentFiles).toEqual([mixed]);
  // Sent again under its id with images alone, the group moves to the field every release reads.
  applyRunEvent(message, {
    kind: 'sentfiles',
    sentFiles: { ...mixed, revision: 2, files: [group.files[0]] },
  });
  expect(message.sentFiles?.map((g) => `${g.id}:${g.revision}`)).toEqual(['renders:1', 'mixed:2']);
  expect(message.extraSentFiles).toEqual([]);
  // An older revision arriving late changes nothing, in either field.
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: mixed });
  expect(messageFiles(message).map((g) => `${g.id}:${g.revision}`)).toEqual([
    'renders:1',
    'mixed:2',
  ]);
});

it('merges both fields of a reply, and an earlier release dropping one deletes nothing', () => {
  const message = reply();
  const report = { ...group, id: 'report', files: [table] };
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: group });
  applyRunEvent(message, { kind: 'sentfiles', sentFiles: report });
  const workspace = initialWorkspace();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Report',
    settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    messages: [message],
  });
  const base = sharedWorkspace(workspace),
    local = structuredClone(base),
    remote = structuredClone(base);
  // A device on an earlier release saves the reply without the field it does not know, which the
  // relay puts back as it puts back the work a light upload leaves out.
  const stripped = structuredClone(remote.conversations[0].messages[0]);
  delete stripped.extraSentFiles;
  expect(restoreMessage(stripped, base.conversations[0].messages[0]).extraSentFiles).toEqual([
    report,
  ]);
  // Edited on both sides, a reply merges its groups from both copies, wherever each was kept.
  delete remote.conversations[0].messages[0].extraSentFiles;
  remote.conversations[0].messages[0].blocks = [{ type: 'markdown', text: 'Edited elsewhere' }];
  applyRunEvent(local.conversations[0].messages[0], {
    kind: 'sentfiles',
    sentFiles: { ...report, id: 'clip', files: [clip] },
  });
  const merged = mergeShared(base, local, remote).conversations[0].messages[0];
  expect(merged.extraSentFiles?.map((g) => g.id)).toEqual(['report', 'clip']);
  expect(merged.sentFiles?.map((g) => g.id)).toEqual(['renders']);
  // A later revision on one side moves the group across, whichever field it left.
  const moved = { ...report, revision: 2, files: [group.files[0]] };
  remote.conversations[0].messages[0].sentFiles = [group, moved];
  const again = mergeShared(base, local, remote).conversations[0].messages[0];
  expect(again.sentFiles?.map((g) => `${g.id}:${g.revision}`)).toEqual(['renders:1', 'report:2']);
  expect(again.extraSentFiles?.map((g) => g.id)).toEqual(['clip']);
});

it('gives each table, document and video a place of its own, and never compares them', () => {
  const runs = fileRuns([shown('mixed', [image(0), table, image(1), notes, clip])]);
  expect(runs.map((run) => (run.kind === 'images' ? run.items.length : run.kind))).toEqual([
    1,
    'table',
    1,
    'document',
    'video',
  ]);
  expect(fileKind(clip)).toBe('video');
  expect(isComparison({ ...comparison, files: [comparison.files[0], table] })).toBe(false);
});
