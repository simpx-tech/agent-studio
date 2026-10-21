import { describe, expect, it } from 'vitest';
import {
  mergePublishedArtifacts,
  publishedArtifactSchema,
  publishedArtifactsSchema,
  publishedHistory,
  type PublishedArtifact,
} from './published-artifacts';
import { applyRunEvent, retainRunEvent, savesAtOnce, type ToolActivity } from './activity';
import { activityGroupSummary, liveAction } from './activity-groups';
import {
  historyFor,
  messageSchema,
  type Conversation,
  type Message,
  type RunEvent,
} from './domain';
import { toolVisual } from './tool-presentation';

const id = '61f14ff2-c402-429d-ad1b-42de9c796ca9';
const card = (revision: number, title = 'Quarterly report'): PublishedArtifact => ({
  id,
  revision,
  url: 'https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax',
  title,
});
const reply = (): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: new Date().toISOString(),
  blocks: [],
  runId: crypto.randomUUID(),
});
const call = (extra: Partial<ToolActivity>): ToolActivity => ({
  id: 'claude:publish',
  name: 'Artifact',
  revision: 1,
  category: 'tool',
  status: 'complete',
  sources: [],
  agents: [],
  ...extra,
});

describe('claude.ai artifacts a Claude reply publishes', () => {
  it('keeps only claude.ai links with an id and a one-line title', () => {
    expect(publishedArtifactSchema.safeParse(card(1)).success).toBe(true);
    expect(
      publishedArtifactSchema.safeParse({
        ...card(1),
        url: `https://claude.ai/code/artifact/${id}`,
      }).success,
    ).toBe(true);
    for (const bad of [
      { url: 'https://example.com/artifact/D6UUK2MDNtEQ65Mn61b3ax' },
      { url: 'https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3a0' },
      { url: 'javascript:alert(1)' },
      { id: 'report' },
      { revision: 0 },
      { title: 'Two\nlines' },
      { title: ' ' },
    ])
      expect(publishedArtifactSchema.safeParse({ ...card(1), ...bad }).success, `${bad}`).toBe(
        false,
      );
    expect(publishedArtifactsSchema.safeParse([card(1), card(2)]).success).toBe(false);
  });

  it('shows each artifact at its latest revision, where it was first published', () => {
    const other = { ...card(1, 'Roadmap'), id: crypto.randomUUID() };
    const merged = mergePublishedArtifacts([card(2), other], [card(1, 'Old'), card(3, 'New')]);
    expect(merged.map((item) => [item.title, item.revision])).toEqual([
      ['New', 3],
      ['Roadmap', 1],
    ]);
  });

  it('records the event on the reply, saves it at once and keeps it for other devices', () => {
    const message = reply();
    const event: RunEvent = { kind: 'publishedartifact', publishedArtifact: card(1), open: true };
    applyRunEvent(message, event);
    applyRunEvent(message, { kind: 'publishedartifact', publishedArtifact: card(2, 'Renamed') });
    // A malformed record changes nothing.
    applyRunEvent(message, {
      kind: 'publishedartifact',
      publishedArtifact: { ...card(3), url: 'https://example.com/x' },
    });
    expect(message.publishedArtifacts).toEqual([card(2, 'Renamed')]);
    expect(messageSchema.safeParse(message).success).toBe(true);
    expect(savesAtOnce(event)).toBe(true);
    // A user message keeps none.
    const user = { ...reply(), role: 'user' as const };
    applyRunEvent(user, event);
    expect(user.publishedArtifacts).toBeUndefined();
    // A relay job keeps each artifact's latest event.
    const events: RunEvent[] = [];
    retainRunEvent(events, event);
    retainRunEvent(events, { kind: 'publishedartifact', publishedArtifact: card(2) });
    retainRunEvent(events, { kind: 'publishedartifact', publishedArtifact: card(1) });
    expect(events.map((e) => e.publishedArtifact?.revision)).toEqual([2]);
  });

  it('tells a new session where the earlier reply published', () => {
    const user: Message = {
      ...reply(),
      role: 'user',
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Publish it' }],
    };
    const done: Message = {
      ...reply(),
      status: 'complete',
      blocks: [{ type: 'markdown', text: 'Published.' }],
      publishedArtifacts: [card(1)],
    };
    const conversation = { messages: [user, done] } as Conversation;
    expect(historyFor(conversation)[1].text).toBe(`Published.${publishedHistory([card(1)])}`);
    expect(publishedHistory([card(1)])).toBe(
      '\n\n[Artifact on claude.ai: Quarterly report — https://claude.ai/artifact/D6UUK2MDNtEQ65Mn61b3ax]',
    );
    // A stopped reply's artifacts are not replayed as part of an answer it never gave.
    const stopped = { ...done, status: 'cancelled' as const };
    expect(historyFor({ messages: [user, stopped] } as Conversation)).toHaveLength(1);
  });

  it('names each call of the Artifact tools by its action and artifact', () => {
    const publish = call({ operation: 'artifact:publish', detail: 'Quarterly report' });
    expect(toolVisual(publish)).toMatchObject({
      icon: 'artifact',
      title: 'Publish artifact',
      detail: 'Quarterly report',
    });
    expect(liveAction(publish, 'running')).toMatchObject({
      verb: 'Publishing',
      target: 'Quarterly report',
    });
    expect(liveAction(publish, 'complete').verb).toBe('Published');
    const open = call({ operation: 'artifact:open', detail: 'Quarterly report' });
    expect(toolVisual(open).title).toBe('Open artifact');
    expect(liveAction(open, 'complete')).toMatchObject({
      verb: 'Opened',
      target: 'Quarterly report',
    });
    const reply = call({ name: 'ArtifactComments', operation: 'artifact:reply', detail: 'Plan' });
    expect(liveAction(reply, 'running')).toMatchObject({
      verb: 'Replying to a comment on',
      target: 'Plan',
    });
    expect(toolVisual(call({ name: 'ArtifactData', operation: 'artifact:other' })).title).toBe(
      'Artifact data',
    );
    // A listing has no artifact to name.
    const listed = liveAction(call({ operation: 'artifact:list' }), 'complete');
    expect(listed.verb).toBe('Listed artifacts');
    expect(listed.target).toBeUndefined();
  });

  it('counts an artifact once however often it was published', () => {
    const link = { label: 'Link', value: card(1).url };
    const first = call({
      operation: 'artifact:publish',
      detail: 'Quarterly report',
      facts: [link],
    });
    const again = { ...first, id: 'claude:again' };
    const other = call({ id: 'claude:other', operation: 'artifact:publish', detail: 'Roadmap' });
    const list = call({ id: 'claude:list', operation: 'artifact:list' });
    expect(activityGroupSummary([first, again, other, list], 'complete').label).toBe(
      'Published 2 artifacts and used 1 tool',
    );
  });
});
