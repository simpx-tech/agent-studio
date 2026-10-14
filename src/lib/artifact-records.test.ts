import { describe, expect, it } from 'vitest';
import {
  artifactRecordSchema,
  artifactRecordsSchema,
  mergeArtifactRecords,
  type ArtifactRecord,
} from './artifact-records';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  historyFor,
  messageSchema,
  type Conversation,
  type Message,
  type RunEvent,
} from './domain';
import { recordArtifact } from './artifacts';
import { replyContent } from './markdown';

const page = (id: string, revision: number, source = '<h1>Q3</h1>'): ArtifactRecord => ({
  id,
  revision,
  title: `Report ${id}`,
  language: 'html',
  source,
});
const reply = (): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: new Date().toISOString(),
  blocks: [],
  runId: crypto.randomUUID(),
});

describe('artifact pages a reply shows with show_artifact', () => {
  it('validates records as visualizations are, with their language', () => {
    expect(artifactRecordSchema.safeParse(page('report', 1)).success).toBe(true);
    expect(artifactRecordSchema.safeParse({ ...page('report', 1), language: 'js' }).success).toBe(
      false,
    );
    expect(artifactRecordSchema.safeParse({ ...page('a b', 1) }).success).toBe(false);
    expect(artifactRecordSchema.safeParse({ ...page('report', 0) }).success).toBe(false);
    expect(
      artifactRecordSchema.safeParse({ ...page('report', 1), title: 'two\nlines' }).success,
    ).toBe(false);
    expect(artifactRecordSchema.safeParse({ ...page('report', 1), source: ' ' }).success).toBe(
      false,
    );
    // A page of any size.
    expect(artifactRecordSchema.safeParse(page('big', 1, 'x'.repeat(3_000_000))).success).toBe(
      true,
    );
    expect(artifactRecordsSchema.safeParse([page('a', 1), page('a', 2)]).success).toBe(false);
    expect(messageSchema.safeParse({ ...reply(), artifacts: [page('a', 1)] }).success).toBe(true);
  });

  it('keeps each page at its latest revision, in the order they were first shown', () => {
    const merged = mergeArtifactRecords(
      [page('a', 1), page('b', 2)],
      [page('b', 1, 'old'), page('a', 3, 'new'), page('c', 1)],
    );
    expect(merged.map((a) => [a.id, a.revision])).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
    expect(merged[0].source).toBe('new');
    expect(
      mergeArtifactRecords([page('a', 1)], [{ ...page('b', 1), language: 'js' } as never]),
    ).toEqual([page('a', 1)]);
  });

  it('records each revision a reply shows and replays finished pages as earlier context', () => {
    const message = reply();
    const before = message.artifacts;
    applyRunEvent(message, { kind: 'artifact', artifact: page('report', 1) });
    applyRunEvent(message, { kind: 'artifact', artifact: page('report', 2, '<h1>v2</h1>') });
    applyRunEvent(message, { kind: 'artifact', artifact: page('report', 1, 'stale') });
    expect(message.artifacts).toEqual([page('report', 2, '<h1>v2</h1>')]);
    // Replaced, never edited in place (src/lib/chat-snapshots.ts).
    expect(message.artifacts).not.toBe(before);
    const user: Message = { ...reply(), role: 'user' };
    applyRunEvent(user, { kind: 'artifact', artifact: page('report', 1) });
    expect(user.artifacts).toBeUndefined();
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: 'Report',
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
      messages: [{ ...message, status: 'complete' }],
    };
    expect(historyFor(conversation)[0].artifacts).toEqual(message.artifacts);
    expect(historyFor({ ...conversation, messages: [message] })).toEqual([]);
  });

  it('keeps the latest revision of each page in a remote run job', () => {
    const events: RunEvent[] = [];
    retainRunEvent(events, { kind: 'artifact', artifact: page('a', 1) });
    retainRunEvent(events, { kind: 'artifact', artifact: page('b', 1) });
    retainRunEvent(events, { kind: 'artifact', artifact: page('a', 2) });
    retainRunEvent(events, { kind: 'artifact', artifact: page('a', 1) });
    retainRunEvent(events, { kind: 'artifact', artifact: { ...page('c', 1), source: '' } });
    expect(events.map((e) => [e.artifact?.id, e.artifact?.revision])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
  });

  // Prose needs a DOM to sanitize; tests/artifact-cards.spec.ts covers a marker between
  // paragraphs in the real reply.
  it('places each page at its own marker, once, and keeps an unmarked page in the reply', () => {
    const records = [page('a', 1), page('b', 1)];
    const ids = (text: string) =>
      replyContent(text, [], [], false, records).parts.map((part) =>
        part.type === 'artifact' ? part.artifact.id : part.type,
      );
    expect(ids('<!-- artifact:b -->')).toEqual(['b', 'a']);
    expect(ids('<!-- artifact:b -->\n\n<!-- artifact:b -->\n\n<!-- artifact:a -->')).toEqual([
      'b',
      'a',
    ]);
    expect(ids('<!-- artifact:missing -->')).toEqual(['a', 'b']);
    expect(recordArtifact('m', page('a', 3))).toEqual({
      id: 'm:artifact:a',
      title: 'Report a',
      language: 'html',
      source: '<h1>Q3</h1>',
      revision: 3,
    });
  });
});
