import { z } from 'zod';

export const toolOutputImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const dimension = z.number().int().min(1).max(100_000).optional();
/**
 * A tool call's result as the computer that ran it keeps it. Text is bounded there
 * (256 KB of output and 64 KB of errors, as UTF-8), images to eight of at most 5 MB.
 */
export const toolOutputSchema = z.object({
  version: z.number().int().positive(),
  toolId: z.string().min(1).max(240),
  stdout: z.string().max(300_000).default(''),
  stderr: z.string().max(80_000).default(''),
  truncated: z.boolean().default(false),
  exitCode: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  startLine: z.number().int().nonnegative().max(100_000_000).optional(),
  images: z
    .array(
      z.object({
        mediaType: z.enum(toolOutputImageTypes),
        data: z
          .string()
          .min(4)
          .max(7_000_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        width: dimension,
        height: dimension,
      }),
    )
    .max(8)
    .default([]),
  imagesOmitted: z.number().int().nonnegative().max(1000).default(0),
  omitted: z.boolean().default(false),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;
export type ToolOutputImage = ToolOutput['images'][number];

export const toolOutputImageUrl = (image: ToolOutputImage) =>
  `data:${image.mediaType};base64,${image.data}`;

type Load = (runId: string, toolId: string, connectionId?: string) => Promise<ToolOutput>;
/**
 * Results a window already fetched, newest last. Bounded by count and by the size of their
 * text and images, so opening many screenshots cannot hold all of them in memory.
 */
export function createToolOutputCache(load: Load, limits = { entries: 48, bytes: 48_000_000 }) {
  const entries = new Map<string, { promise: Promise<ToolOutput>; bytes: number }>();
  const size = (output: ToolOutput) =>
    (output.stdout.length + output.stderr.length) * 2 +
    output.images.reduce((sum, image) => sum + image.data.length * 2, 0);
  function trim() {
    let total = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of entries) {
      if (entries.size <= limits.entries && total <= limits.bytes) break;
      entries.delete(key);
      total -= entry.bytes;
    }
  }
  return {
    get(runId: string, toolId: string, connectionId?: string): Promise<ToolOutput> {
      const key = `${runId}\n${toolId}`;
      const cached = entries.get(key);
      if (cached) {
        // Most recently used entries are evicted last.
        entries.delete(key);
        entries.set(key, cached);
        return cached.promise;
      }
      const entry = { promise: load(runId, toolId, connectionId), bytes: 0 };
      entries.set(key, entry);
      entry.promise.then(
        (output) => {
          entry.bytes = size(output);
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
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
