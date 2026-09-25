import { z } from 'zod';

export const toolOutputImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const dimension = z.number().int().min(1).max(100_000).optional();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * One stream of a result as the computer that ran it returns it: whole, or its beginning
 * and end when the stream is larger than the requested view (512 KB, or 8 MB in full).
 */
const textSchema = z.object({
  text: z.string().max(9_000_000),
  bytes: size,
  complete: z.boolean(),
});
/** A tool call's result as its computer keeps it. Images are read one at a time. */
export const toolOutputSchema = z.object({
  version: z.number().int().positive(),
  toolId: z.string().min(1).max(240),
  exitCode: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  startLine: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  truncated: z.boolean(),
  stdout: textSchema,
  stderr: textSchema,
  images: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        mediaType: z.enum(toolOutputImageTypes),
        bytes: size,
        width: dimension,
        height: dimension,
      }),
    )
    .max(100_000),
  imagesOmitted: z.number().int().nonnegative(),
  command: z.string().optional(),
  input: z.string().optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;
export type ToolOutputImageInfo = ToolOutput['images'][number];
export const toolOutputImageSchema = z.object({
  mediaType: z.enum(toolOutputImageTypes),
  data: z
    .string()
    .min(4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  bytes: size,
  width: dimension,
  height: dimension,
});
export type ToolOutputImage = z.infer<typeof toolOutputImageSchema>;

export const toolOutputImageUrl = (image: ToolOutputImage) =>
  `data:${image.mediaType};base64,${image.data}`;

/**
 * Promises of what a window already fetched, newest last, bounded by count and by the size
 * of their text or image data, so opening many long results cannot hold all of them.
 */
export function createFetchCache<T>(
  size: (value: T) => number,
  limits = { entries: 48, bytes: 48_000_000 },
) {
  const entries = new Map<string, { promise: Promise<T>; bytes: number }>();
  function trim() {
    let total = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of entries) {
      if (entries.size <= limits.entries && total <= limits.bytes) break;
      entries.delete(key);
      total -= entry.bytes;
    }
  }
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached) {
        // Most recently used entries are evicted last.
        entries.delete(key);
        entries.set(key, cached);
        return cached.promise;
      }
      const entry = { promise: load(), bytes: 0 };
      entries.set(key, entry);
      entry.promise.then(
        (value) => {
          entry.bytes = size(value);
          trim();
        },
        // A failure is never cached: Retry asks the computer again.
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      trim();
      return entry.promise;
    },
    clear() {
      entries.clear();
    },
  };
}
export const outputSize = (output: ToolOutput) =>
  (output.stdout.text.length + output.stderr.text.length) * 2;
export const imageSize = (image: ToolOutputImage) => image.data.length * 2;

/** Lines of text for display, without the final line ending. */
export function outputLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\n$/, '').split('\n');
}

/** A byte count as B, KB or MB with one decimal where useful. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}
