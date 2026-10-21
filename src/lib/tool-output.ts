import { z } from 'zod';

export const toolOutputImageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const dimension = z.number().int().min(1).optional();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * One stream of a result as the computer that ran it returns it: whole. Computers before
 * 2026-10-10 returned only the beginning and end of a long one, with `complete` false.
 */
const textSchema = z.object({
  text: z.string(),
  bytes: size,
  complete: z.boolean(),
});
/** A tool call's result as its computer keeps it. Images are read one at a time. */
export const toolOutputSchema = z.object({
  version: z.number().int().positive(),
  toolId: z.string().min(1),
  exitCode: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  startLine: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  truncated: z.boolean(),
  stdout: textSchema,
  stderr: textSchema,
  images: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      mediaType: z.enum(toolOutputImageTypes),
      bytes: size,
      width: dimension,
      height: dimension,
    }),
  ),
  imagesOmitted: z.number().int().nonnegative(),
  command: z.string().optional(),
  input: z.string().optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;
export type ToolOutputImageInfo = ToolOutput['images'][number];
/**
 * One base64 string, checked without a group repeated per four characters: on a file of
 * several megabytes that overflows the regular expression engine. A length one past a
 * multiple of four cannot be decoded.
 */
const base64 = z
  .string()
  .min(4)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((data) => data.length % 4 !== 1);
export const toolOutputImageSchema = z.object({
  mediaType: z.enum(toolOutputImageTypes),
  data: base64,
  bytes: size,
  width: dimension,
  height: dimension,
});
export type ToolOutputImage = z.infer<typeof toolOutputImageSchema>;

/** Tables a reply can show: CSV and TSV files and workbooks, every worksheet of them. */
export const toolOutputTableTypes = [
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
] as const;
/** Documents a reply can show, rendered. */
export const toolOutputDocumentTypes = ['text/markdown'] as const;
/** Videos a reply can show, played. A QuickTime movie plays as the MP4 it is built like. */
export const toolOutputVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime'] as const;
/** The name each of those formats goes by, as a card names its file. */
export const otherFormats: Record<
  | (typeof toolOutputTableTypes)[number]
  | (typeof toolOutputDocumentTypes)[number]
  | (typeof toolOutputVideoTypes)[number],
  string
> = {
  'text/csv': 'CSV',
  'text/tab-separated-values': 'TSV',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel.sheet.macroEnabled.12': 'XLSM',
  'text/markdown': 'Markdown',
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'MOV',
};
const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Rows of one sheet of a kept table, with every sheet's name and size, parsed where it is kept. */
export const tablePageSchema = z.object({
  sheets: z.array(
    z.object({
      name: z.string(),
      rows: position,
      columns: position,
      /** The row and column of the sheet's first cell, as its workbook numbers them from 1. */
      firstRow: z.number().int().positive(),
      firstColumn: z.number().int().positive(),
    }),
  ),
  sheet: position,
  /**
   * The longest cell of each column of the sheet, in characters, which sizes its columns from the
   * first page. Computers before them send none.
   */
  lengths: z.array(position).optional(),
  start: position,
  rows: z.array(z.array(z.string())),
});
export type TablePage = z.infer<typeof tablePageSchema>;
/** A kept document's text: whole, or its beginning, as a card in the chat asks. */
export const documentTextSchema = z.object({
  text: z.string(),
  bytes: size,
  complete: z.boolean(),
});
export type DocumentText = z.infer<typeof documentTextSchema>;
/** A kept table, document or video, whole, as another device reads it. */
export const toolOutputFileSchema = z.object({
  mediaType: z.enum([...toolOutputTableTypes, ...toolOutputDocumentTypes, ...toolOutputVideoTypes]),
  data: z.union([z.literal(''), base64]),
  bytes: size,
});
export type ToolOutputFile = z.infer<typeof toolOutputFileSchema>;

/** The 3D formats a reply can show, named by the media type its record keeps. */
export const toolOutputModelTypes = [
  'model/gltf-binary',
  'model/gltf+json',
  'model/obj',
  'model/stl',
  'model/fbx',
] as const;
export type ToolOutputModelType = (typeof toolOutputModelTypes)[number];
export const modelFormats = {
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'model/obj': 'obj',
  'model/stl': 'stl',
  'model/fbx': 'fbx',
} as const satisfies Record<ToolOutputModelType, string>;
const modelFormat = z.enum(['glb', 'gltf', 'obj', 'stl', 'fbx']);
export const toolOutputModelSchema = z.object({
  format: modelFormat,
  data: base64,
  bytes: size,
});
export type ToolOutputModel = z.infer<typeof toolOutputModelSchema>;
/**
 * Views of a model, a turn apart, starting where the viewer's camera starts: what another device
 * shows when it cannot read the model itself whole through the relay.
 */
export const modelViewCount = 8;
/**
 * The version of the views a window renders; views kept by an earlier one are drawn again. 2 draws
 * a textured FBX in its painted colours.
 */
export const modelViewsRenderer = 2;
/** A model's views as another device receives them. */
export const modelViewsSchema = z.object({
  views: z.array(toolOutputImageSchema).length(modelViewCount),
});
export type ModelViews = z.infer<typeof modelViewsSchema>;
/** What the computer keeping a model holds of its views, and what rendering them needs. */
export const keptModelViewsSchema = z.object({
  format: modelFormat,
  bytes: size,
  renderer: z.number().int().nonnegative().optional(),
  views: z.array(toolOutputImageSchema).max(modelViewCount),
});
/**
 * Model bytes for a loader, from a model read through the relay. Decoding it a character at a
 * time held the page for a long frame, so the engine decodes it: natively where it can,
 * otherwise through a data: URL fetched away from the page.
 */
export async function modelBytes(model: ToolOutputModel): Promise<ArrayBuffer> {
  return base64Bytes(model.data);
}
/** Bytes a relay read carries as base64, decoded by the engine as `modelBytes` explains. */
export async function base64Bytes(data: string): Promise<ArrayBuffer> {
  const native = Uint8Array as unknown as { fromBase64?(data: string): Uint8Array };
  if (typeof native.fromBase64 === 'function') return native.fromBase64(data).buffer as ArrayBuffer;
  const response = await fetch(`data:application/octet-stream;base64,${data}`);
  return response.arrayBuffer();
}

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
  const entries = new Map<string, { promise: Promise<T>; bytes: number; value?: T }>();
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
      const entry: { promise: Promise<T>; bytes: number; value?: T } = {
        promise: load(),
        bytes: 0,
      };
      entries.set(key, entry);
      entry.promise.then(
        (value) => {
          entry.value = value;
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
    /** What was read for `key`, once it has arrived, so a view can show it at once. */
    peek(key: string): T | undefined {
      return entries.get(key)?.value;
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

/** An image's dimensions and size, as its thumbnail and the viewer name them. */
export function imageLabel(info: ToolOutputImageInfo): string {
  return [
    info.width && info.height ? `${info.width} × ${info.height}` : '',
    formatBytes(info.bytes),
  ]
    .filter(Boolean)
    .join(' · ');
}
