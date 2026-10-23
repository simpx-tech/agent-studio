import { z } from 'zod';
import {
  toolOutputAudioTypes,
  toolOutputDocumentTypes,
  toolOutputImageTypes,
  toolOutputModelTypes,
  toolOutputTableTypes,
  toolOutputVideoTypes,
  type ToolOutputImageInfo,
} from './tool-output.ts';

/** A caption or a label: one line of text, as the host keeps it. */
const oneLine = z
  .string()
  .min(1)
  .refine((s) => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s));

/** Files one call showed, kept as metadata; their bytes live on the computer that ran it. */
export const sentFileSchema = z.object({
  /** This file's place among the call's images, its models, or its other files, from 0. */
  index: z.number().int().nonnegative(),
  name: z.string().min(1),
  /**
   * Any media type: a kind of file a later release adds reaches this one in `laterSentFiles`, and
   * shows as a file it cannot open. The fields that earlier releases read take their kinds alone.
   */
  mediaType: z.string().regex(/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/i),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** What a comparison calls this file, such as Before. */
  label: oneLine.optional(),
});
export type SentFile = z.infer<typeof sentFileSchema>;
/**
 * What a shown file is, which decides how the reply shows it: `unknown` is a kind a later release
 * added, which this one cannot open.
 */
export type FileKind = 'image' | 'model' | 'table' | 'document' | 'video' | 'audio' | 'unknown';
const kinds = new Map<string, FileKind>([
  ...toolOutputImageTypes.map((type) => [type, 'image'] as const),
  ...toolOutputModelTypes.map((type) => [type, 'model'] as const),
  ...toolOutputTableTypes.map((type) => [type, 'table'] as const),
  ...toolOutputDocumentTypes.map((type) => [type, 'document'] as const),
  ...toolOutputVideoTypes.map((type) => [type, 'video'] as const),
  ...toolOutputAudioTypes.map((type) => [type, 'audio'] as const),
]);
export const fileKind = (file: SentFile): FileKind => kinds.get(file.mediaType) ?? 'unknown';
/** A 3D model opens in the reply's 3D viewer. */
export const isModel = (file: SentFile): boolean => fileKind(file) === 'model';
/**
 * Images, models and the call's other files (tables, documents, videos and audio) are each
 * numbered from 0 in the call's kept result. A kind a later release added is numbered as that
 * release does, which this one cannot tell.
 */
const numbering = (file: SentFile) => {
  const kind = fileKind(file);
  return kind === 'image' || kind === 'model' || kind === 'unknown' ? kind : 'other';
};
/** A shown image as the result reader describes one, so both read the same way. */
export const imageInfo = (file: SentFile): ToolOutputImageInfo => ({
  index: file.index,
  mediaType: file.mediaType as ToolOutputImageInfo['mediaType'],
  bytes: file.bytes,
  width: file.width,
  height: file.height,
});

/** A group that shows one image alone, which joins single images placed right beside it. */
export const loneImage = (group: SentFiles) =>
  group.files.length === 1 && fileKind(group.files[0]) === 'image';

/** A shown file with the group, and so the call, it came in. */
export type ShownFile = { group: SentFiles; file: SentFile };
/** Files in order: consecutive images side by side in a gallery, every other file alone. */
export type FileRun =
  { kind: 'images'; items: ShownFile[] } | { kind: Exclude<FileKind, 'image'>; item: ShownFile };
export function fileRuns(groups: SentFiles[]): FileRun[] {
  const runs: FileRun[] = [];
  for (const group of groups)
    for (const file of group.files) {
      const last = runs.at(-1);
      const kind = fileKind(file);
      if (kind !== 'image') runs.push({ kind, item: { group, file } });
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
    .regex(/^[a-zA-Z0-9_-]+$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runId: z.string().uuid(),
  toolId: z.string().min(1),
  caption: oneLine.optional(),
  files: z
    .array(sentFileSchema)
    .min(1)
    // Images, models and other files are numbered within their own kind, each from zero.
    .refine((files) => {
      const known = files.filter((file) => numbering(file) !== 'unknown');
      return new Set(known.map((file) => `${numbering(file)}:${file.index}`)).size === known.length;
    }),
  /**
   * Shown side by side for comparison (compare_files), each pane turned, panned and zoomed on
   * its own or with the others. A release that does not know it shows the files as a group.
   */
  compare: z.boolean().optional(),
});
export type SentFiles = z.infer<typeof sentFilesSchema>;

const isPicture = (kind: FileKind) => kind === 'image' || kind === 'model';
/** A comparison shows its images and models side by side, which needs two of them. */
export const isComparison = (group: SentFiles) =>
  !!group.compare &&
  group.files.length > 1 &&
  group.files.every((file) => isPicture(fileKind(file)));

/** The name a comparison shows for one of its files: its label, else its file name. */
export const paneLabel = (file: SentFile) => file.label ?? file.name;

/** The fields of a reply that keep the groups of files it showed, from the oldest. */
export const filesFields = ['sentFiles', 'extraSentFiles', 'laterSentFiles'] as const;
export type FilesField = (typeof filesFields)[number];
/** The kinds before audio, which `extraSentFiles` holds: releases since then read it. */
const extraKinds = new Set<FileKind>(['image', 'model', 'table', 'document', 'video']);
/**
 * The field that keeps a group: the oldest that every release reading it can read. Releases before
 * tables, documents and videos validate a reply's `sentFiles` with images and models alone, and
 * releases before audio its `extraSentFiles` with those three as well; each refuses the whole
 * conversation over another kind, and drops a field it does not know. `laterSentFiles` takes every
 * kind, those a later release adds included, so a release meets them there and shows each as a
 * file it cannot open.
 */
export function filesField(group: SentFiles): FilesField {
  const kinds = group.files.map(fileKind);
  if (kinds.every(isPicture)) return 'sentFiles';
  if (kinds.every((kind) => extraKinds.has(kind))) return 'extraSentFiles';
  return 'laterSentFiles';
}

const uniqueIds = (groups: SentFiles[]) => new Set(groups.map((g) => g.id)).size === groups.length;
/** A reply's `sentFiles`: groups of images and models, which every release reads. */
export const sentFileGroupsSchema = z
  .array(sentFilesSchema.refine((group) => filesField(group) === 'sentFiles'))
  .refine(uniqueIds);
/** A reply's `extraSentFiles`: groups that show a table, a document or a video. */
export const extraSentFileGroupsSchema = z
  .array(sentFilesSchema.refine((group) => filesField(group) !== 'laterSentFiles'))
  .refine(uniqueIds);
/** A reply's `laterSentFiles`: groups that show audio, or a kind a later release adds. */
export const laterSentFileGroupsSchema = z.array(sentFilesSchema).refine(uniqueIds);

export function mergeSentFiles(left: SentFiles[] = [], right: SentFiles[] = []) {
  const result = [...left];
  for (const group of right) {
    const index = result.findIndex((g) => g.id === group.id);
    if (index >= 0 && result[index].revision >= group.revision) continue;
    const next = [...result];
    if (index >= 0) next[index] = group;
    else next.push(group);
    if (laterSentFileGroupsSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}

/** Where a reply keeps the groups of files it showed. */
export type FilesHolder = Partial<Record<FilesField, SentFiles[]>>;
/** Every group a reply showed, from all its fields, each once, at its latest revision. */
export function messageFiles(message: FilesHolder): SentFiles[] {
  const { sentFiles = [], extraSentFiles, laterSentFiles } = message;
  if (!extraSentFiles?.length && !laterSentFiles?.length) return sentFiles;
  const groups = [...sentFiles];
  for (const group of [...(extraSentFiles ?? []), ...(laterSentFiles ?? [])]) {
    const index = groups.findIndex((g) => g.id === group.id);
    if (index < 0) groups.push(group);
    else if (group.revision > groups[index].revision) groups[index] = group;
  }
  return groups;
}
/**
 * Adds a group to the reply, or a later revision of one, in the field that suits it: a group sent
 * again under its id with another kind of file moves between them.
 */
export function placeSentFiles(message: FilesHolder, group: SentFiles) {
  if (messageFiles(message).some((g) => g.id === group.id && g.revision >= group.revision)) return;
  const into = filesField(group);
  for (const field of filesFields)
    if (field !== into && message[field]?.some((g) => g.id === group.id))
      message[field] = message[field].filter((g) => g.id !== group.id);
  message[into] = mergeSentFiles(message[into], [group]);
}
/**
 * Two copies of a reply's groups merged: each group by id at its later revision, in the field that
 * suits it. A field either copy had stays, so the merge changes nothing in a reply without files.
 */
export function mergeMessageFiles(a: FilesHolder, b: FilesHolder): FilesHolder {
  const groups = mergeSentFiles(messageFiles(a), messageFiles(b));
  const merged: FilesHolder = {};
  for (const field of filesFields) {
    const kept = groups.filter((group) => filesField(group) === field);
    if (a[field] || b[field] || kept.length) merged[field] = kept;
  }
  return merged;
}
