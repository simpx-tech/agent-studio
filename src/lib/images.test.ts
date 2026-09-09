import { describe, expect, it } from 'vitest';
import { imageSchema, imageByteLength, maxImageBytes, checkImageBudget } from './images';
import { historyFor, initialWorkspace, restoreWorkspace, settingsFor } from './domain';
import { sharedWorkspace, sharedSchema, mergeShared } from './sync';
import { estimatePromptTokens } from './usage';

const image = {
  id: crypto.randomUUID(),
  name: 'fixture.png',
  mediaType: 'image/png' as const,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
};
describe('portable image attachments', () => {
  it('retains an image-only message through saved history, relay checkpoints, and prompt replay', () => {
    const workspace = initialWorkspace();
    const now = new Date().toISOString();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      settings: settingsFor(workspace.preferences),
      title: 'Image',
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [],
          images: [image],
          status: 'complete',
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          blocks: [],
          status: 'running',
          runId: crypto.randomUUID(),
          createdAt: now,
        },
      ],
    });
    const base = sharedWorkspace(workspace);
    const local = structuredClone(base);
    local.conversations[0].archived = true;
    const remote = structuredClone(base);
    remote.conversations[0].messages[1].blocks = [{ type: 'markdown', text: 'Seen' }];
    remote.conversations[0].messages[1].status = 'complete';
    const merged = sharedSchema.parse(mergeShared(base, local, remote));
    const restored = restoreWorkspace(JSON.parse(JSON.stringify({ ...workspace, ...merged })));
    expect(restored.conversations[0].archived).toBe(true);
    expect(historyFor(restored.conversations[0])).toEqual([
      { role: 'user', text: '', images: [image] },
      { role: 'assistant', text: 'Seen' },
    ]);
    expect(
      estimatePromptTokens(workspace.conversations[0].settings, [
        { role: 'user', text: '', images: [image] },
      ]),
    ).toBe(estimatePromptTokens(workspace.conversations[0].settings, [{ role: 'user', text: '' }]));
  });
  it('rejects URLs, SVGs, mismatched headers, invalid encoding and oversized images without throwing from safeParse', () => {
    expect(imageSchema.safeParse(image).success).toBe(true);
    for (const patch of [
      { mediaType: 'image/svg+xml' },
      { mediaType: 'image/jpeg' },
      { data: 'https://example.com/image.png' },
      { data: '%%%=' },
      { data: '' },
      { data: 'iVBORw0KGgoA' + 'AAAA'.repeat(Math.ceil(maxImageBytes / 3)) },
    ])
      expect(imageSchema.safeParse({ ...image, ...patch }).success).toBe(false);
    expect(imageByteLength(image)).toBe(Buffer.from(image.data, 'base64').length);
  });
  it('bounds replayed image bytes across turns', () => {
    const large = { ...image, data: Buffer.alloc(maxImageBytes).toString('base64') };
    expect(() =>
      checkImageBudget([{ images: [large, large] }, { images: [large, large] }]),
    ).not.toThrow();
    expect(() =>
      checkImageBudget([{ images: [large, large] }, { images: [large, large, image] }]),
    ).toThrow('8 MB');
  });
});
