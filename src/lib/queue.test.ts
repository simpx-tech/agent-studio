import { describe, expect, it } from 'vitest';
import {
  enqueueMessage,
  maxQueuedMessages,
  queuedPreview,
  restoreToDraft,
  type QueuedMessage,
} from './queue';
import type { ChatImage } from './images';

const image = (name: string): ChatImage => ({
  id: crypto.randomUUID(),
  name,
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
});

describe('message queue', () => {
  it('queues trimmed text, images, and skills in order up to the limit', () => {
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
    while (queue.length < maxQueuedMessages)
      queue = enqueueMessage(queue, { text: `m${queue.length}`, images: [] }).queue;
    const full = enqueueMessage(queue, { text: 'one more', images: [] });
    expect(full.error).toMatch(/Up to 8 messages/);
    expect(full.queue).toBe(queue);
  });

  it('returns queued messages to the draft ahead of the current text and caps images', () => {
    const queue = [
      enqueueMessage([], { text: 'earlier', images: [image('1.png'), image('2.png')] }).queue[0],
      enqueueMessage([], { text: 'later', images: [image('3.png')] }).queue[0],
    ];
    const restored = restoreToDraft(queue, '  typing now ', [image('4.png'), image('5.png')], 4);
    expect(restored.draft).toBe('earlier\n\nlater\n\ntyping now');
    expect(restored.images.map((i) => i.name)).toEqual(['1.png', '2.png', '3.png', '4.png']);
    expect(restored.droppedImages).toBe(1);
    expect(restoreToDraft([], '', [], 4)).toEqual({ draft: '', images: [], droppedImages: 0 });
    expect(restoreToDraft(queue, '', [], 4).draft).toBe('earlier\n\nlater');
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
