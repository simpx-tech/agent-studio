import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageStore, storeInlineImages } from '../../relay/images';
import {
  imageHashes,
  imageSchema,
  imageByteLength,
  referenceInline,
} from './images';
import {
  historyFor,
  initialWorkspace,
  messageSchema,
  restoreWorkspace,
  settingsFor,
} from './domain';
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
  it('rejects URLs, SVGs, mismatched headers and invalid encoding without throwing from safeParse', () => {
    expect(imageSchema.safeParse(image).success).toBe(true);
    for (const patch of [
      { mediaType: 'image/svg+xml' },
      { mediaType: 'image/jpeg' },
      { data: 'https://example.com/image.png' },
      { data: '%%%=' },
      { data: '' },
    ])
      expect(imageSchema.safeParse({ ...image, ...patch }).success).toBe(false);
    expect(imageByteLength(image)).toBe(Buffer.from(image.data, 'base64').length);
  });
  it('accepts images of any size, and any number of them in one message', () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    const large = { ...image, data: bytes.toString('base64') };
    expect(imageSchema.safeParse(large).success).toBe(true);
    const message = (images: unknown[]) => ({
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [],
      images,
      status: 'complete',
      createdAt: new Date().toISOString(),
    });
    expect(messageSchema.safeParse(message(Array(40).fill(image))).success).toBe(true);
    expect(messageSchema.safeParse(message([large, large])).success).toBe(true);
  });
});

describe('image store references', () => {
  const bytes = Buffer.from(image.data, 'base64');
  const stored = {
    id: image.id,
    name: image.name,
    mediaType: image.mediaType,
    hash: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  it('keeps a reference, and the same one wherever an inline image is turned into it', async () => {
    expect(imageSchema.parse(stored)).toEqual(stored);
    for (const patch of [{ hash: 'A'.repeat(64) }, { hash: 'a'.repeat(63) }, { bytes: 0 }])
      expect(imageSchema.safeParse({ ...stored, ...patch }).success).toBe(false);
    // A browser and the relay each turn the same inline image into exactly this record, so
    // their copies of a message never conflict.
    expect((await referenceInline(image)).image).toEqual(stored);
    const conversations = [{ messages: [{ images: [structuredClone(image)] as unknown[] }] }];
    const directory = mkdtempSync(join(tmpdir(), 'studio-images-'));
    try {
      storeInlineImages(conversations, imageStore(directory));
      expect(conversations[0].messages[0].images).toEqual([stored]);
      expect(JSON.stringify(conversations[0].messages[0].images[0])).toBe(JSON.stringify(stored));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('carries references, not bytes, through history and names them for publishing', () => {
    const now = new Date().toISOString();
    const message = (images: unknown[]) =>
      messageSchema.parse({
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [],
        images,
        status: 'complete',
        createdAt: now,
      });
    const conversation = {
      messages: [message([stored])],
      rewind: { removed: [message([{ ...stored, hash: 'b'.repeat(64) }]), message([image])] },
    };
    expect(imageHashes(conversation)).toEqual([stored.hash, 'b'.repeat(64)]);
    expect(JSON.stringify(conversation.messages[0])).not.toContain(image.data.slice(0, 20));
  });
});
