import { describe, expect, it, vi } from 'vitest';
import {
  createToolOutputCache,
  formatBytes,
  outputLines,
  toolOutputSchema,
  type ToolOutput,
} from './tool-output';

const output = (fields: Partial<ToolOutput> = {}): ToolOutput =>
  toolOutputSchema.parse({ version: 1, toolId: 'claude:t', stdout: 'ok\n', ...fields });

describe('tool output', () => {
  it('accepts bounded host results and rejects unsafe images', () => {
    expect(output()).toMatchObject({ stderr: '', images: [], truncated: false, omitted: false });
    const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, width: 4, height: 3 };
    expect(output({ images: [image as never] }).images).toHaveLength(1);
    for (const invalid of [
      { images: [{ ...image, mediaType: 'image/svg+xml' }] },
      { images: [{ ...image, data: 'javascript:alert(1)' }] },
      { images: Array(9).fill(image) },
      { stdout: 'x'.repeat(300_001) },
      { toolId: '' },
    ])
      expect(
        toolOutputSchema.safeParse({ version: 1, toolId: 'claude:t', ...invalid }).success,
      ).toBe(false);
  });

  it('caches results per run and call, retries failures and stays bounded', async () => {
    const load = vi.fn(async (runId: string, toolId: string) => {
      if (toolId === 'fail') throw new Error('Host offline');
      return output({ toolId, stdout: `${runId}:${toolId}` });
    });
    const cache = createToolOutputCache(load, { entries: 2, bytes: 1_000_000 });
    expect((await cache.get('run', 'a')).stdout).toBe('run:a');
    expect((await cache.get('run', 'a')).stdout).toBe('run:a');
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.get('run', 'fail')).rejects.toThrow('Host offline');
    await expect(cache.get('run', 'fail')).rejects.toThrow('Host offline');
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('run', 'b');
    await cache.get('run', 'c');
    // The least recently used entry left when a third arrived.
    await cache.get('run', 'a');
    expect(load).toHaveBeenCalledTimes(6);
    // Two results of 10 bytes each do not fit in 15.
    const small = createToolOutputCache(load, { entries: 10, bytes: 15 });
    await small.get('run', 'x');
    await small.get('run', 'y');
    await small.get('run', 'x');
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
  });
});
