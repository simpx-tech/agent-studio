import { z } from 'zod';
import type { ChatLocation } from './domain';
import type { ChatImage } from './images';
import { locationKey } from './locations';
import { hasMention, maxMentions, mentionSchema, retainMentions, type Mention } from './mentions';

/**
 * Unsent composer content for one conversation, or for a new conversation in one folder,
 * Standalone location, or computer. Drafts belong to this device: they are saved in its local
 * storage only, never added to the workspace, exported, or relayed. Attached images stay with a
 * draft while the app is open but are not saved.
 */
export type Draft = {
  text: string;
  images: ChatImage[];
  mentions: Mention[];
  staleMentions: string[];
  mentionScope: string;
  updatedAt: number;
};
export type DraftContent = Omit<Draft, 'updatedAt'>;

export const draftKey = {
  chat: (conversationId: string) => `chat:${conversationId}`,
  folder: (location: ChatLocation) => `folder:${locationKey(location)}`,
  computer: (computerId: string) => `computer:${computerId}`,
};

export const hasDraft = (draft?: Pick<Draft, 'text' | 'images'>) =>
  !!draft && (draft.text !== '' || draft.images.length > 0);

export function sameDraft(a: DraftContent, b: DraftContent) {
  return (
    a.text === b.text &&
    a.mentionScope === b.mentionScope &&
    a.images.length === b.images.length &&
    a.images.every((image, index) => image.id === b.images[index].id) &&
    JSON.stringify(a.mentions) === JSON.stringify(b.mentions) &&
    JSON.stringify(a.staleMentions) === JSON.stringify(b.staleMentions)
  );
}

export const maxSavedDrafts = 100;
export const maxSavedDraftText = 300_000;
export const maxSavedDraftBytes = 2_000_000;
const maxStaleMentions = 64;

const savedDraftSchema = z.object({
  key: z
    .string()
    .max(5000)
    .regex(/^(?:chat|folder|computer):/),
  text: z.string().min(1).max(maxSavedDraftText),
  mentions: z.array(mentionSchema).min(1).max(maxMentions).optional(),
  staleMentions: z.array(z.string().min(1).max(4100)).min(1).max(maxStaleMentions).optional(),
  mentionScope: z.string().min(1).max(10_000).optional(),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;
export type SavedDrafts = { version: 1; drafts: SavedDraft[] };
/** A draft set or cleared in this window, applied over the copy saved on this device. */
export type DraftChange = { at: number; draft?: SavedDraft };

function parseSavedDraft(value: unknown): SavedDraft | undefined {
  const parsed = savedDraftSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Unreadable mention metadata must not discard the text itself.
  const { key, text, updatedAt } = (value ?? {}) as Record<string, unknown>;
  const textOnly = savedDraftSchema.safeParse({ key, text, updatedAt });
  return textOnly.success ? textOnly.data : undefined;
}

/** Reads a saved copy leniently: damaged entries are skipped, and the newest entry per key wins. */
export function readSavedDrafts(value: unknown): Map<string, SavedDraft> {
  const drafts = new Map<string, SavedDraft>();
  const file = z.object({ version: z.literal(1), drafts: z.array(z.unknown()) }).safeParse(value);
  if (!file.success) return drafts;
  for (const entry of file.data.drafts.slice(0, maxSavedDrafts * 4)) {
    const draft = parseSavedDraft(entry);
    if (draft && (drafts.get(draft.key)?.updatedAt ?? -1) < draft.updatedAt)
      drafts.set(draft.key, draft);
  }
  return drafts;
}

export function restoredDraft(saved: SavedDraft): Draft {
  return {
    text: saved.text,
    images: [],
    mentions: saved.mentions ?? [],
    staleMentions: saved.staleMentions ?? [],
    mentionScope: saved.mentionScope ?? '',
    updatedAt: saved.updatedAt,
  };
}

/** The saved form of a draft: its text and mention identity, without images. */
export function savedDraft(key: string, draft?: Draft): SavedDraft | undefined {
  if (!draft?.text || draft.text.length > maxSavedDraftText) return;
  const mentions = retainMentions(draft.text, draft.mentions).slice(0, maxMentions);
  const staleMentions = [...new Set(draft.staleMentions)]
    .filter((token) => hasMention(draft.text, token))
    .slice(0, maxStaleMentions);
  return parseSavedDraft({
    key,
    text: draft.text,
    ...(mentions.length ? { mentions } : {}),
    ...(staleMentions.length ? { staleMentions } : {}),
    ...(mentions.length && draft.mentionScope ? { mentionScope: draft.mentionScope } : {}),
    updatedAt: draft.updatedAt,
  });
}

/** Keeps the most recently edited drafts within the saved count and size limits. */
export function savedDraftsFile(drafts: Iterable<SavedDraft>): SavedDrafts {
  const encoder = new TextEncoder();
  const kept: SavedDraft[] = [];
  let bytes = 0;
  for (const draft of [...drafts].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (kept.length >= maxSavedDrafts) break;
    const size = encoder.encode(JSON.stringify(draft)).length + 1;
    if (bytes + size > maxSavedDraftBytes) continue;
    bytes += size;
    kept.push(draft);
  }
  return { version: 1, drafts: kept };
}

/**
 * Applies this window's changes over the saved copy. Drafts saved by another window stay, and a
 * newer save for the same chat is not replaced by an older change.
 */
export function mergeSavedDrafts(
  saved: Map<string, SavedDraft>,
  changes: Map<string, DraftChange>,
): SavedDrafts {
  const next = new Map(saved);
  for (const [key, change] of changes) {
    if ((next.get(key)?.updatedAt ?? -1) > change.at) continue;
    if (change.draft) next.set(key, change.draft);
    else next.delete(key);
  }
  return savedDraftsFile(next.values());
}

/**
 * Carries composer content into a draft that may already exist, keeping the saved text first.
 * When both have content, their mentions must be chosen again, as after any other folder change.
 */
export function combineDrafts(
  existing: DraftContent | undefined,
  carried: DraftContent,
  maxImages: number,
): { draft: DraftContent; droppedImages: number } {
  if (!existing || !hasDraft(existing)) return { draft: carried, droppedImages: 0 };
  if (!hasDraft(carried)) return { draft: existing, droppedImages: 0 };
  const texts = [...new Set([existing.text.trim(), carried.text.trim()])].filter(Boolean);
  const images = [
    ...existing.images,
    ...carried.images.filter((image) => !existing.images.some((i) => i.id === image.id)),
  ];
  const kept = images.slice(0, Math.max(0, maxImages));
  return {
    draft: {
      text: texts.join('\n\n'),
      images: kept,
      mentions: [],
      staleMentions: [
        ...new Set(
          [existing, carried].flatMap((d) => [
            ...d.staleMentions,
            ...d.mentions.map((m) => m.token),
          ]),
        ),
      ],
      mentionScope: '',
    },
    droppedImages: images.length - kept.length,
  };
}
