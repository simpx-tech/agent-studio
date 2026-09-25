import { z } from 'zod';
import { chatSettingsSchema, locationSchema, type ChatLocation, type ChatSettings } from './domain';
import type { ChatImage } from './images';
import { hasMention, maxMentions, mentionSchema, retainMentions, type Mention } from './mentions';

/**
 * Unsent composer content for one conversation, or for one scratch chat. Drafts belong to this
 * device: they are saved in its local storage only, never added to the workspace, exported, or
 * relayed. Attached images stay with a draft while the app is open but are not saved.
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

/**
 * A new conversation before its first message is sent. Every new chat opens its own scratch
 * chat, so a folder can hold several. Its text is the draft under `scratch:<id>`, saved with the
 * computer, folder and chat settings chosen for it: account connection IDs, never credentials.
 */
export type ScratchChat = {
  id: string;
  computerId: string;
  location?: ChatLocation;
  settings?: ChatSettings;
  createdAt: number;
};
export type SavedScratch = Omit<ScratchChat, 'id'>;

export const draftKey = {
  chat: (conversationId: string) => `chat:${conversationId}`,
  scratch: (scratchId: string) => `scratch:${scratchId}`,
};
export const scratchIdOf = (key: string) =>
  key.startsWith('scratch:') ? key.slice('scratch:'.length) : undefined;

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

/** A scratch chat's name in the sidebar: the first line of its text. */
export function scratchTitle(content: Pick<DraftContent, 'text' | 'images'>) {
  const line = content.text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : content.images.length ? 'Image conversation' : '';
}

export const maxSavedDrafts = 100;
export const maxSavedDraftText = 300_000;
export const maxSavedDraftBytes = 2_000_000;
const maxStaleMentions = 64;

const savedScratchSchema = z.object({
  computerId: z.string().max(100),
  location: locationSchema.optional(),
  settings: chatSettingsSchema.optional(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const savedDraftSchema = z.object({
  key: z
    .string()
    .max(5000)
    // `folder:` and `computer:` are the new-chat drafts of earlier releases.
    .regex(/^(?:chat|scratch|folder|computer):/),
  text: z.string().min(1).max(maxSavedDraftText),
  mentions: z.array(mentionSchema).min(1).max(maxMentions).optional(),
  staleMentions: z.array(z.string().min(1).max(4100)).min(1).max(maxStaleMentions).optional(),
  mentionScope: z.string().min(1).max(10_000).optional(),
  scratch: savedScratchSchema.optional(),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;
export type SavedDrafts = { version: 1; drafts: SavedDraft[] };
/** A draft set or cleared in this window, applied over the copy saved on this device. */
export type DraftChange = { at: number; draft?: SavedDraft };

function parseScratch(value: unknown): SavedScratch | undefined {
  const parsed = savedScratchSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Settings another release cannot read must not move the scratch chat out of its folder.
  const { settings: _settings, ...place } = (value ?? {}) as Record<string, unknown>;
  const placed = savedScratchSchema.safeParse(place);
  return placed.success ? placed.data : undefined;
}

function parseSavedDraft(value: unknown): SavedDraft | undefined {
  const parsed = savedDraftSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Unreadable mention metadata or settings must not discard the text itself.
  const { key, text, updatedAt, scratch } = (value ?? {}) as Record<string, unknown>;
  const textOnly = savedDraftSchema.safeParse({
    key,
    text,
    updatedAt,
    scratch: parseScratch(scratch),
  });
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

/**
 * The scratch chat a saved draft belongs to. Earlier releases kept one new-chat draft per folder
 * or Standalone location (`folder:`) and per computer without one (`computer:`); each becomes a
 * scratch chat in the same place, under a new id.
 */
export function savedScratch(saved: SavedDraft): ScratchChat | undefined {
  const id = scratchIdOf(saved.key);
  if (id !== undefined)
    return z.string().uuid().safeParse(id).success
      ? { computerId: '', createdAt: saved.updatedAt, ...saved.scratch, id }
      : undefined;
  if (saved.key.startsWith('computer:'))
    return {
      id: crypto.randomUUID(),
      computerId: saved.key.slice('computer:'.length).slice(0, 100),
      createdAt: saved.updatedAt,
    };
  if (!saved.key.startsWith('folder:')) return;
  // The key is `locationKey()`: computer, execution environment and folder environment IDs,
  // then the path, which may itself contain slashes.
  const [computerId, executionId, environmentId, ...path] = saved.key
    .slice('folder:'.length)
    .split('/');
  const location = locationSchema.safeParse({
    computerId,
    environmentId,
    ...(executionId !== environmentId ? { executionEnvironmentId: executionId } : {}),
    path: path.join('/'),
  });
  return location.success
    ? {
        id: crypto.randomUUID(),
        computerId: location.data.computerId,
        location: location.data,
        createdAt: saved.updatedAt,
      }
    : undefined;
}

/** The saved form of a draft: its text and mention identity, without images. */
export function savedDraft(
  key: string,
  draft?: Draft,
  scratch?: SavedScratch,
): SavedDraft | undefined {
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
    ...(scratch && scratchIdOf(key) !== undefined ? { scratch } : {}),
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
