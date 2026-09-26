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
