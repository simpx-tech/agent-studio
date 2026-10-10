import { describe, expect, it } from 'vitest';
import {
  enqueueMessage,
  queuedPreview,
  restoreToDraft,
  sameProcess,
  takeOverTarget,
  type QueuedMessage,
} from './queue';
import type { DraftImage } from './images';
import type { ChatSettings, Conversation, Message } from './domain';

// An attached image, whose bytes stay in memory until its message is sent.
const image = (name: string): DraftImage => ({
  id: crypto.randomUUID(),
  name,
  mediaType: 'image/png',
  hash: 'a'.repeat(64),
  bytes: 8,
  blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]),
});

describe('message queue', () => {
  it('queues trimmed text, images, and skills in order, however many', () => {
    let queue: QueuedMessage[] = [];
    const first = enqueueMessage(queue, { text: '  first  ', images: [] });
    expect(first.error).toBeUndefined();
    queue = first.queue;
    const second = enqueueMessage(queue, {
      text: '/review',
      images: [image('a.png')],
      skills: [{ name: 'review', path: '/skills/review/SKILL.md' }],
    });
    queue = second.queue;
    expect(queue.map((m) => m.text)).toEqual(['first', '/review']);
    expect(queue[1].skills).toEqual([{ name: 'review', path: '/skills/review/SKILL.md' }]);
    expect(queue[0].skills).toBeUndefined();
    expect(queue[0].id).not.toBe(queue[1].id);
    expect(enqueueMessage(queue, { text: '   ', images: [] }).error).toMatch(/Enter a message/);
    expect(enqueueMessage(queue, { text: '', images: [image('only.png')] }).error).toBeUndefined();
    while (queue.length < 30)
      queue = enqueueMessage(queue, { text: `m${queue.length}`, images: [] }).queue;
    const more = enqueueMessage(queue, { text: 'one more', images: [] });
    expect(more.error).toBeUndefined();
    expect(more.queue).toHaveLength(31);
  });

  it('returns queued messages to the draft ahead of the current text, with every image', () => {
    const queue = [
      enqueueMessage([], { text: 'earlier', images: [image('1.png'), image('2.png')] }).queue[0],
      enqueueMessage([], { text: 'later', images: [image('3.png')] }).queue[0],
    ];
    const restored = restoreToDraft(queue, '  typing now ', [image('4.png'), image('5.png')]);
    expect(restored.draft).toBe('earlier\n\nlater\n\ntyping now');
    expect(restored.images.map((i) => i.name)).toEqual([
      '1.png',
      '2.png',
      '3.png',
      '4.png',
      '5.png',
    ]);
    expect(restoreToDraft([], '', [])).toEqual({ draft: '', images: [] });
    expect(restoreToDraft(queue, '', []).draft).toBe('earlier\n\nlater');
  });

  it('previews queued messages on one line with image counts', () => {
    const long = enqueueMessage([], { text: `a\n\n${'b'.repeat(200)}`, images: [] }).queue[0];
    const preview = queuedPreview(long, 40);
    expect(preview).toHaveLength(40);
    expect(preview.startsWith('a b')).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    const images = enqueueMessage([], { text: '', images: [image('x.png')] }).queue[0];
    expect(queuedPreview(images)).toBe('Image message (1 image)');
    const both = enqueueMessage([], { text: 'look', images: [image('x.png'), image('y.png')] })
      .queue[0];
    expect(queuedPreview(both)).toBe('look (2 images)');
  });
});

describe('taking over a reply that waits for background work', () => {
  const settings: ChatSettings = {
    provider: 'claude',
    model: 'opus',
    reasoning: 'high',
    instructions: '',
    connectionId: crypto.randomUUID(),
  };
  const conversation = (reply: Partial<Message> = {}): Conversation => ({
    id: crypto.randomUUID(),
    settings: { ...settings },
    title: 'Plan',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'markdown', text: 'Plan it' }],
        status: 'complete',
        createdAt: '2026-09-29T00:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        runId: crypto.randomUUID(),
        settings: { ...settings },
        blocks: [{ type: 'markdown', text: 'Waiting for the agents' }],
        status: 'running',
        createdAt: '2026-09-29T00:00:01.000Z',
        backgroundWait: 2,
        ...reply,
      },
    ],
  });

  it('names the running Claude reply only while its turn waits for background work', () => {
    const waiting = conversation();
    const run = waiting.messages[1].runId!;
    expect(takeOverTarget(waiting)).toEqual({ reply: waiting.messages[1], wait: 2 });
    for (const reply of [
      { backgroundWait: undefined },
      { status: 'complete' as const },
      { compact: true },
      { runId: undefined },
      { settings: { ...settings, provider: 'codex' as const } },
    ])
      expect(takeOverTarget(conversation(reply))).toBeUndefined();
    // A reply that refused a message in this idle stretch takes the next one in a later one.
    const refused = { [run]: 2 };
    expect(takeOverTarget(waiting, refused)).toBeUndefined();
    waiting.messages[1].backgroundWait = 3;
    expect(takeOverTarget(waiting, refused)?.wait).toBe(3);
    // What the window heard from the reply's own events comes before the synced field.
    expect(takeOverTarget(waiting, {}, { [run]: 5 })?.wait).toBe(5);
    expect(takeOverTarget(waiting, {}, { [run]: null })).toBeUndefined();
    delete waiting.messages[1].backgroundWait;
    expect(takeOverTarget(waiting, {}, { [run]: 4 })?.wait).toBe(4);
  });

  it('keeps the process only for the same account and launch settings', () => {
    expect(sameProcess(settings, { ...settings, model: 'sonnet', maxThinkingTokens: 4096 })).toBe(
      true,
    );
    expect(sameProcess(settings, { ...settings, instructions: 'Be brief.' })).toBe(true);
    for (const change of [
      { connectionId: crypto.randomUUID() },
      { reasoning: 'low' as const },
      { planMode: true },
      { fastMode: true },
      { fallbackModel: 'sonnet' },
      { outputSchema: '{"type":"object"}' },
      { autoCompactTokens: 200_000 },
    ])
      expect(sameProcess(settings, { ...settings, ...change })).toBe(false);
    const moved = conversation();
    moved.settings.reasoning = 'low';
    expect(takeOverTarget(moved)).toBeUndefined();
  });
});
