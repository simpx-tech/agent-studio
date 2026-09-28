import { z } from 'zod';
import {
  toolOutputImageTypes,
  toolOutputModelTypes,
  type ToolOutputImageInfo,
} from './tool-output.ts';

/** Files one call showed, kept as metadata; their bytes live on the computer that ran it. */
export const sentFileSchema = z.object({
  /** This file's place among the call's images, or among its models. */
  index: z.number().int().nonnegative().max(64),
  name: z.string().min(1).max(120),
  mediaType: z.enum([...toolOutputImageTypes, ...toolOutputModelTypes]),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
});
export type SentFile = z.infer<typeof sentFileSchema>;
/** A 3D model opens in the reply's viewer; every other shown file is an image. */
export const isModel = (file: SentFile): boolean => file.mediaType.startsWith('model/');
/** A shown image as the result reader describes one, so both read the same way. */
export const imageInfo = (file: SentFile): ToolOutputImageInfo => ({
  index: file.index,
  mediaType: file.mediaType as ToolOutputImageInfo['mediaType'],
  bytes: file.bytes,
  width: file.width,
  height: file.height,
});

/** A group that shows one image alone, which joins single images placed right beside it. */
export const loneImage = (group: SentFiles) => group.files.length === 1 && !isModel(group.files[0]);

/** A shown file with the group, and so the call, it came in. */
export type ShownFile = { group: SentFiles; file: SentFile };
/** Files in order: consecutive images side by side in a gallery, each model alone. */
export type FileRun = { kind: 'images'; items: ShownFile[] } | { kind: 'model'; item: ShownFile };
export function fileRuns(groups: SentFiles[]): FileRun[] {
  const runs: FileRun[] = [];
  for (const group of groups)
    for (const file of group.files) {
      const last = runs.at(-1);
      if (isModel(file)) runs.push({ kind: 'model', item: { group, file } });
      else if (last?.kind === 'images') last.items.push({ group, file });
      else runs.push({ kind: 'images', items: [{ group, file }] });
    }
  return runs;
}

/**
 * A gallery image's width over its height. One whose size was not reported takes a common
 * shape, and extreme strips are drawn whole inside a less extreme tile.
 */
export function imageAspect(file: SentFile): number {
  const aspect = file.width && file.height ? file.width / file.height : 4 / 3;
  return Math.min(4, Math.max(0.3, aspect));
}

/**
 * Splits a gallery into rows that each fill its width at one height, choosing among every
 * split the one whose rows come closest to `target`, a row's width over its height. Widths
 * never enter: a row's height follows the gallery's width, so the rows need no measuring and
 * nothing moves as the images load. Returns the images' indexes, row by row.
 */
export function galleryRows(aspects: number[], target = 4): number[][] {
  // The best split of the first `end` images, found from the best splits of fewer: its last
  // row starts at `from`, and each row adds how far its height strays from the target's.
  const best = [{ cost: 0, from: 0 }];
  for (let end = 1; end <= aspects.length; end++) {
    best[end] = { cost: Infinity, from: 0 };
    let aspect = 0;
    for (let from = end - 1; from >= 0; from--) {
      aspect += aspects[from];
      const cost = best[from].cost + (target / aspect - 1) ** 2;
      // Of two equal splits, the one with fewer images in its earlier rows wins.
      if (cost <= best[end].cost + 1e-9) best[end] = { cost, from };
    }
  }
  const rows: number[][] = [];
  for (let end = aspects.length; end > 0; end = best[end].from)
    rows.unshift(Array.from({ length: end - best[end].from }, (_, i) => best[end].from + i));
  return rows;
}

export const sentFilesSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runId: z.string().uuid(),
  toolId: z.string().min(1).max(240),
  caption: z
    .string()
    .min(1)
    .max(300)
    .refine((s) => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s))
    .optional(),
  files: z
    .array(sentFileSchema)
    .min(1)
    .max(8)
    // Images and models are numbered within their own kind, so both start at zero.
    .refine(
      (files) =>
        new Set(files.map((file) => `${isModel(file) ? 'model' : 'image'}:${file.index}`)).size ===
        files.length,
    ),
});
export type SentFiles = z.infer<typeof sentFilesSchema>;

export const sentFileGroupsSchema = z
  .array(sentFilesSchema)
  .max(12)
  .refine((groups) => new Set(groups.map((g) => g.id)).size === groups.length);

export function mergeSentFiles(left: SentFiles[] = [], right: SentFiles[] = []) {
  const result = [...left];
  for (const group of right) {
    const index = result.findIndex((g) => g.id === group.id);
    if (index >= 0 && result[index].revision >= group.revision) continue;
    const next = [...result];
    if (index >= 0) next[index] = group;
    else next.push(group);
    if (sentFileGroupsSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}
