import { z } from 'zod';
import type { Message } from './domain';

const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s));
const lineCount = z.number().int().min(0).max(1_000_000);
export const diffHunkSchema = z
  .object({
    oldStart: lineCount,
    oldLines: lineCount,
    newStart: lineCount,
    newLines: lineCount,
    lines: z.array(z.string().max(64_000)).max(10_000),
  })
  .refine((h) => {
    let old = 0,
      next = 0;
    for (const [i, line] of h.lines.entries()) {
      if (line === '\\ No newline at end of file') {
        if (!i || !/^[ +\-]/.test(h.lines[i - 1])) return false;
      } else if (line.startsWith(' ')) {
        old++;
        next++;
      } else if (line.startsWith('-')) old++;
      else if (line.startsWith('+')) next++;
      else return false;
    }
    return old === h.oldLines && next === h.newLines;
  });
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export const filePatchSchema = z.object({
  path: pathSchema,
  previousPath: pathSchema.optional(),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed']),
  hunks: z.array(diffHunkSchema).max(200).optional(),
});
export type FilePatch = z.infer<typeof filePatchSchema>;
export const fileChangesSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    edits: z
      .array(z.object({ id: z.string().min(1).max(240), files: z.array(filePatchSchema).max(32) }))
      .max(100),
    limited: z.boolean(),
  })
  .refine(
    (s) =>
      new Set(s.edits.map((e) => e.id)).size === s.edits.length &&
      new TextEncoder().encode(JSON.stringify(s)).length <= 1_000_000,
  );
export type FileChanges = z.infer<typeof fileChangesSchema>;
export function latestFileChanges(a?: FileChanges, b?: FileChanges) {
  return (a?.revision ?? -1) >= (b?.revision ?? -1) ? a : b;
}

export type FileSummary = FilePatch & { added?: number; removed?: number; unavailable?: string };
export type ChangeSummary = { files: FileSummary[]; limited: boolean; recorded: boolean };

const displaySlashes = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
const absolutePath = (path: string) => path.startsWith('/') || /^[a-z]:\//i.test(path);
const windowsPath = (path: string) => /^[a-z]:\//i.test(path) || path.startsWith('//');

/** Prefer the selected project; otherwise use a shared directory only when
 * multiple absolute file paths establish it. Never guess a lone file's root. */
export function fileChangeBase(paths: string[], folder?: string): string | undefined {
  if (folder) return displaySlashes(folder).replace(/\/+$/, '');
  const unique = [...new Set(paths.map(displaySlashes))];
  if (unique.length < 2 || !unique.every(absolutePath)) return;
  const windows = windowsPath(unique[0]);
  if (unique.some((path) => windowsPath(path) !== windows)) return;
  const parts = unique[0].split('/').slice(0, -1);
  for (const path of unique.slice(1)) {
    const other = path.split('/').slice(0, -1);
    let i = 0;
    while (
      i < parts.length &&
      i < other.length &&
      (windows ? parts[i].toLowerCase() === other[i].toLowerCase() : parts[i] === other[i])
    )
      i++;
    parts.length = i;
  }
  // A filesystem root, drive, or UNC share alone does not establish useful context.
  if (parts.length < (unique[0].startsWith('//') ? 5 : 2)) return;
  return parts.join('/');
}

export function relativeFilePath(path: string, base?: string): string {
  const normalized = displaySlashes(path);
  const prefix = base === undefined ? undefined : displaySlashes(base).replace(/\/+$/, '') + '/';
  if (
    prefix &&
    (windowsPath(normalized)
      ? normalized.toLowerCase().startsWith(prefix.toLowerCase())
      : normalized.startsWith(prefix))
  )
    return normalized.slice(prefix.length);
  return normalized;
}

type Token = number | string;
const maxSpan = 100_000;
// Matches reported paths across separators, and Windows paths regardless of case.
export const filePathKey = (path: string) => {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
};

function hunkLines(h: DiffHunk) {
  const lines: { type: string; text: string }[] = [];
  for (const line of h.lines) {
    if (line === '\\ No newline at end of file')
      lines.at(-1)!.text = lines.at(-1)!.text.slice(0, -1);
    else lines.push({ type: line[0], text: line.slice(1) + '\n' });
  }
  return lines;
}
function encoded(type: string, text: string) {
  return text.endsWith('\n')
    ? [type + text.slice(0, -1)]
    : [type + text, '\\ No newline at end of file'];
}

/** Compose confirmed patches against a sparse original document. Unknown lines are
 * identity tokens, never invented source. A discontinuity fails closed. */
function combine(patches: FilePatch[], budget: { remaining: number }): FileSummary | undefined {
  const first = patches[0],
    last = patches.at(-1)!;
  let existed = first.kind !== 'added',
    exists = existed;
  let tokens: Token[] = [],
    originalLength = 0;
  const original = new Map<number, string>();
  const ensure = (length: number) => {
    if (length > maxSpan || (!existed && length > tokens.length)) throw new Error('span');
    const growth = Math.max(0, length - tokens.length);
    if (growth > budget.remaining) throw new Error('span');
    budget.remaining -= growth;
    while (tokens.length < length) tokens.push(originalLength++);
  };
  let unavailable = '';
  try {
    for (const patch of patches) {
      if (!patch.hunks) throw new Error('missing');
      if (patch.kind === 'added' && exists) throw new Error('overlap');
      if (patch.kind !== 'added' && !exists) throw new Error('overlap');
      let offset = 0,
        end = -1;
      for (const h of patch.hunks) {
        const oldIndex = h.oldLines ? h.oldStart - 1 : h.oldStart;
        const newIndex = h.newLines ? h.newStart - 1 : h.newStart;
        if (oldIndex < end || oldIndex < 0 || newIndex !== oldIndex + offset)
          throw new Error('order');
        end = oldIndex + h.oldLines;
        const start = oldIndex + offset;
        ensure(start + h.oldLines);
        let cursor = start;
        const replacement: Token[] = [];
        for (const line of hunkLines(h)) {
          if (line.type === '+') replacement.push(line.text);
          else {
            const token = tokens[cursor++];
            if (typeof token === 'number') {
              if (original.has(token) && original.get(token) !== line.text)
                throw new Error('overlap');
              original.set(token, line.text);
            } else if (token !== line.text) throw new Error('overlap');
            if (line.type === ' ') replacement.push(token);
          }
        }
        tokens.splice(start, h.oldLines, ...replacement);
        offset += h.newLines - h.oldLines;
        if (tokens.length > maxSpan) throw new Error('span');
      }
      exists = patch.kind !== 'deleted';
      if (!exists && tokens.length) throw new Error('incomplete deletion');
    }
  } catch (error) {
    unavailable =
      error instanceof Error && error.message === 'overlap'
        ? 'These edits do not form a continuous diff. Review the individual responses.'
        : 'A complete diff was not recorded for this file.';
  }
  const previousPath = first.previousPath ?? first.path;
  const renamed = filePathKey(previousPath) !== filePathKey(last.path);
  const kind = !existed ? 'added' : !exists ? 'deleted' : renamed ? 'renamed' : 'modified';
  const file: FileSummary = { path: last.path, kind, ...(renamed ? { previousPath } : {}) };
  if (unavailable) return { ...file, unavailable };
  if (!existed && !exists) return;

  const hunks: DiffHunk[] = [];
  let oldCursor = 0,
    newCursor = 0,
    inserted: string[] = [];
  const flush = (nextOriginal: number) => {
    const removed = Array.from({ length: nextOriginal - oldCursor }, (_, i) =>
      original.get(oldCursor + i),
    );
    if (removed.some((line) => line === undefined)) throw new Error('unknown');
    // Drop matching edges, including a complete reversion in a later response.
    let prefix = 0,
      suffix = 0;
    while (
      prefix < removed.length &&
      prefix < inserted.length &&
      removed[prefix] === inserted[prefix]
    )
      prefix++;
    while (
      suffix < removed.length - prefix &&
      suffix < inserted.length - prefix &&
      removed[removed.length - suffix - 1] === inserted[inserted.length - suffix - 1]
    )
      suffix++;
    const before = removed.slice(prefix, removed.length - suffix) as string[];
    const after = inserted.slice(prefix, inserted.length - suffix);
    if (before.length || after.length)
      hunks.push({
        oldStart: oldCursor + prefix + (before.length ? 1 : 0),
        oldLines: before.length,
        newStart: newCursor + prefix + (after.length ? 1 : 0),
        newLines: after.length,
        lines: [
          ...before.flatMap((s) => encoded('-', s)),
          ...after.flatMap((s) => encoded('+', s)),
        ],
      });
    newCursor += inserted.length;
    oldCursor = nextOriginal;
    inserted = [];
  };
  try {
    for (const token of tokens) {
      if (typeof token === 'string') inserted.push(token);
      else {
        flush(token);
        oldCursor++;
        newCursor++;
      }
    }
    flush(originalLength);
  } catch {
    return { ...file, unavailable: 'A complete diff was not recorded for this file.' };
  }
  if (!hunks.length && existed === exists && !renamed) return;
  return {
    ...file,
    hunks,
    added: hunks.reduce((n, h) => n + h.newLines, 0),
    removed: hunks.reduce((n, h) => n + h.oldLines, 0),
  };
}

export function summarizeFileChanges(
  messages: Pick<Message, 'role' | 'fileChanges' | 'blocks'>[],
): ChangeSummary {
  const chains = new Map<string, FilePatch[]>();
  let limited = false,
    recorded = false;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    recorded ||= !!message.fileChanges;
    limited ||= !!message.fileChanges?.limited;
    // Older saved replies can identify a successfully edited file but cannot
    // supply a baseline. Keep that gap visible in the combined chat diff too.
    const legacyFiles: FilePatch[] = message.fileChanges
      ? []
      : message.blocks.flatMap((block) => {
          if (
            block.type !== 'activity' ||
            block.tool?.operation !== 'edit' ||
            block.tool.status !== 'complete'
          )
            return [];
          const paths = [
            block.tool.path,
            ...(block.tool.facts
              ?.filter((f) => f.label === 'Files')
              .flatMap((f) => f.value.split('\n')) ?? []),
          ];
          return paths
            .filter((path): path is string => pathSchema.safeParse(path).success)
            .map((path) => ({ path, kind: 'modified' as const }));
        });
    for (const edit of message.fileChanges?.edits ?? [{ files: legacyFiles }])
      for (const file of edit.files) {
        const oldKey = filePathKey(file.previousPath ?? file.path),
          newKey = filePathKey(file.path);
        const chain = chains.get(oldKey) ?? [];
        if (oldKey !== newKey) chains.delete(oldKey);
        // An ambiguous rename must not overwrite another file's history.
        if (oldKey !== newKey && chains.has(newKey)) chain.push({ ...file, hunks: undefined });
        else chain.push(file);
        chains.set(newKey, chain);
      }
  }
  const budget = { remaining: 1_000_000 };
  limited ||= chains.size > 200;
  return {
    files: [...chains.values()]
      .slice(0, 200)
      .map((patches) => combine(patches, budget))
      .filter((f): f is FileSummary => !!f)
      .sort((a, b) => filePathKey(a.path).localeCompare(filePathKey(b.path))),
    limited,
    recorded,
  };
}

export function diffRows(hunk: DiffHunk) {
  let old = hunk.oldStart,
    next = hunk.newStart;
  return hunk.lines.map((line) => ({
    text: line,
    old: /^[ -]/.test(line) ? old++ : undefined,
    next: /^[ +]/.test(line) ? next++ : undefined,
  }));
}
