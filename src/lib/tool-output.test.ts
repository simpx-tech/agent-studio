import { describe, expect, it, vi } from 'vitest';
import {
  createFetchCache,
  formatBytes,
  outputLines,
  outputSize,
  toolOutputImageSchema,
  toolOutputSchema,
  type ToolOutput,
} from './tool-output';

const text = (value: string, complete = true) => ({
  text: value,
  bytes: value.length,
  complete,
});
const output = (fields: Partial<ToolOutput> = {}): ToolOutput =>
  toolOutputSchema.parse({
    version: 2,
    toolId: 'claude:t',
    truncated: false,
    stdout: text('ok\n'),
    stderr: text(''),
    images: [],
    imagesOmitted: 0,
    ...fields,
  });

describe('tool output', () => {
  it('accepts complete and previewed results with image descriptions', () => {
    expect(output({ stdout: text('head\n[… 1.2 MB not shown …]\ntail\n', false) }).stdout).toEqual(
      expect.objectContaining({ complete: false }),
    );
    const image = { index: 0, mediaType: 'image/png', bytes: 8, width: 4, height: 3 };
    expect(output({ images: [image as never], command: 'npm test' }).images).toHaveLength(1);
    for (const invalid of [
      { images: [{ ...image, mediaType: 'image/svg+xml' }] },
      { images: [{ ...image, index: -1 }] },
      { stdout: { text: 'x', bytes: -1, complete: true } },
      { stdout: 'plain text' },
      { toolId: '' },
    ])
      expect(
        toolOutputSchema.safeParse({ ...output(), ...invalid }).success,
        JSON.stringify(invalid),
      ).toBe(false);
    const data = { mediaType: 'image/webp', data: 'UklGRg==', bytes: 4 };
    expect(toolOutputImageSchema.safeParse(data).success).toBe(true);
    for (const invalid of [
      { ...data, data: 'javascript:alert(1)' },
      { ...data, mediaType: 'text/html' },
    ])
      expect(toolOutputImageSchema.safeParse(invalid).success).toBe(false);
  });

  it('caches fetches, retries failures and stays within its bounds', async () => {
    const load = vi.fn(async (key: string) => {
      if (key === 'fail') throw new Error('Host offline');
      return output({ stdout: text(key) });
    });
    const cache = createFetchCache(outputSize, { entries: 2, bytes: 1_000_000 });
    const get = (key: string) => cache.get(key, () => load(key));
    expect((await get('a')).stdout.text).toBe('a');
    expect((await get('a')).stdout.text).toBe('a');
    expect(load).toHaveBeenCalledTimes(1);
    await expect(get('fail')).rejects.toThrow('Host offline');
    await expect(get('fail')).rejects.toThrow('Host offline');
    expect(load).toHaveBeenCalledTimes(3);
    await get('b');
    await get('c');
    // The least recently used entry left when a third arrived.
    await get('a');
    expect(load).toHaveBeenCalledTimes(6);
    // Two results of 10 bytes each do not fit in 15.
    const small = createFetchCache(outputSize, { entries: 10, bytes: 15 });
    const smallGet = (key: string) => small.get(key, () => load(key));
    await smallGet('xxxxx');
    await smallGet('yyyyy');
    await smallGet('xxxxx');
    expect(load).toHaveBeenCalledTimes(9);
  });

  it('splits lines and formats sizes for the output header', () => {
    expect(outputLines('')).toEqual([]);
    expect(outputLines('a\nb\n')).toEqual(['a', 'b']);
    expect(outputLines('a\n\n')).toEqual(['a', '']);
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(300 * 1024)).toBe('300 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
