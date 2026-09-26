import { expect, it } from 'vitest';
import { mergeSentFiles, sentFileGroupsSchema, sentFilesSchema, type SentFiles } from './sent-files';
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
  expect(parts[0].type === 'files' && parts[0].files.id).toBe('renders');
  expect(replyContent('<!-- files:renders -->\n\n<!-- files:renders -->', [], [group])).toHaveLength(
    1,
  );
  expect(replyContent('', [], [group]).map((p) => p.type)).toEqual(['files']);
  expect(replyContent('<!-- files:missing -->', [], [])).toEqual([]);
  expect(replyContent('<!-- visualize:renders -->', [], [group]).map((p) => p.type)).toEqual([
    'files',
  ]);
});
