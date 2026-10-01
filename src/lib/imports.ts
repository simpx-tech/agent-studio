import { z } from 'zod';
import { applyRunEvent } from './activity';
import {
  conversationSchema,
  locationSchema,
  reasoningSchema,
  type ChatSettings,
  type Conversation,
  type Message,
  type ProviderId,
  type RunEvent,
} from './domain';
import { connectionLabel, type Fleet } from './fleet';
import { storedImageSchema } from './images';
import { formatModelName } from './replies';

/**
 * Chats the Claude Code and Codex CLIs saved on this computer, imported as conversations. The
 * desktop host lists each session store (a separate account profile, or an environment's default
 * CLI directory, which the terminal and the desktop apps share) and reads a chosen session whole;
 * its first reply in Agent Studio forks that session, so the model keeps its native context.
 */
export const importProviders = ['claude', 'codex'] as const;
export type ImportProvider = (typeof importProviders)[number];

export const importSourceSchema = z.object({
  id: z.string().max(200),
  provider: z.enum(importProviders),
  environmentId: z.string().uuid(),
  connectionId: z.string().uuid().optional(),
});
export type ImportSource = z.infer<typeof importSourceSchema>;

export const importOrigins = ['desktop', 'cli', 'sdk', 'ide', 'exec', 'studio', 'other'] as const;
export type ImportOrigin = (typeof importOrigins)[number];

export const importableChatSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{32}$/),
  // Shared by copies of one session in several stores.
  session: z.string().regex(/^[0-9a-f]{32}$/),
  title: z.string().max(400),
  preview: z.string().max(2000).optional(),
  path: z.string().max(4096),
  createdAt: z.string().max(64).optional(),
  updatedAt: z.string().max(64).optional(),
  model: z.string().max(200).optional(),
  origin: z.enum(importOrigins),
  archived: z.boolean().optional(),
  bytes: z.number().int().nonnegative().optional(),
  location: locationSchema.optional(),
  connectionId: z.string().uuid().optional(),
  unavailable: z.string().max(5000).optional(),
  conversationId: z.string().uuid().optional(),
  imported: z.boolean().optional(),
});
export type ImportableChat = z.infer<typeof importableChatSchema>;

export const sourceChatsSchema = z.object({
  source: z.string().max(200),
  chats: z.array(importableChatSchema),
  truncated: z.boolean().optional(),
});
export type SourceChats = z.infer<typeof sourceChatsSchema>;

const importedMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().optional(),
  images: z.array(storedImageSchema).optional(),
  runId: z.string().uuid().optional(),
  status: z.enum(['complete', 'error', 'cancelled']),
  error: z.string().optional(),
  createdAt: z.string().max(64),
  durationMs: z.number().nonnegative().optional(),
  model: z.string().max(100).optional(),
  reasoning: reasoningSchema.optional(),
  // Each event is checked where it is applied, as a live reply's are.
  events: z.array(z.object({ kind: z.string() }).passthrough()).optional(),
});
export const importedChatSchema = z.object({
  title: z.string().max(400),
  provider: z.enum(importProviders),
  model: z.string().max(100),
  reasoning: reasoningSchema,
  location: locationSchema.optional(),
  connectionId: z.string().uuid().optional(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  messages: z.array(importedMessageSchema),
  notes: z.array(z.string().max(1000)).optional(),
});
export type ImportedChat = z.infer<typeof importedChatSchema>;

/** Where each kind of session came from, as a person would name the app. */
export function originName(provider: ImportProvider, origin: ImportOrigin): string {
  const app = provider === 'claude' ? 'Claude' : 'Codex';
  return {
    desktop: `${app} app`,
    cli: 'Terminal',
    sdk: 'Another app',
    ide: 'Editor',
    exec: provider === 'codex' ? 'codex exec' : 'Script',
    studio: 'Agent Studio',
    other: provider === 'claude' ? 'Claude Code' : 'Codex',
  }[origin];
}

/**
 * The alias the Model picker offers for a Claude model a transcript reported, so a chat that
 * continues here picks its line's current model as new chats do. Other IDs stay as they are.
 */
export function pickerModel(provider: ProviderId, model: string): string {
  if (provider !== 'claude') return model;
  return /^claude-(opus|sonnet|fable|haiku)-\d/.exec(model)?.[1] ?? model;
}

// The app's own timestamps, whatever form a transcript used.
function iso(time: string): string {
  const ms = Date.parse(time);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function shortTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim() || 'Imported chat';
  if (text.length <= 100) return text;
  return text.slice(0, 99).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/**
 * A conversation holding an imported chat: each prompt with its images, and each reply built
 * from the events the host decoded, as a live reply is. It opens in History; sending a message
 * moves it to Active like any History chat.
 */
export function importedConversation(chat: ImportedChat, id: string, fleet: Fleet): Conversation {
  const model = pickerModel(chat.provider, chat.model);
  const settings: ChatSettings = {
    ...(chat.connectionId ? { connectionId: chat.connectionId } : {}),
    provider: chat.provider,
    model,
    reasoning: model === 'haiku' ? '' : chat.reasoning,
    instructions: '',
  };
  const executionLabel = chat.connectionId ? connectionLabel(fleet, chat.connectionId) : undefined;
  const messages = chat.messages.map((imported): Message => {
    if (imported.role === 'user')
      return {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'markdown', text: imported.text ?? '' }],
        ...(imported.images?.length ? { images: imported.images } : {}),
        status: 'complete',
        createdAt: iso(imported.createdAt),
      };
    const ran = imported.model ?? chat.model;
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      settings: {
        ...settings,
        model: pickerModel(chat.provider, ran),
        reasoning: imported.reasoning ?? settings.reasoning,
      },
      modelName: formatModelName(ran),
      ...(executionLabel ? { executionLabel } : {}),
      ...(imported.runId ? { runId: imported.runId } : {}),
      blocks: [],
      status: imported.status,
      createdAt: iso(imported.createdAt),
      ...(imported.durationMs != null ? { durationMs: imported.durationMs } : {}),
      ...(imported.error ? { error: imported.error } : {}),
    };
    for (const event of imported.events ?? []) applyRunEvent(message, event as RunEvent);
    return message;
  });
  return conversationSchema.parse({
    id,
    title: shortTitle(chat.title),
    titleStatus: 'generated',
    settings,
    ...(chat.location ? { location: chat.location } : {}),
    archived: true,
    createdAt: iso(chat.createdAt),
    updatedAt: iso(chat.updatedAt),
    messages,
  });
}

/** Chats matching a search across their titles, first prompts and folders. */
export function matchesSearch(chat: ImportableChat, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${chat.title}\n${chat.preview ?? ''}\n${chat.path}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** Newest first, by the time a session was last used. */
export function byRecency(a: ImportableChat, b: ImportableChat): number {
  return (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0);
}

/**
 * Whether `a` is a newer copy of the session `b` holds: used later, or as recently and longer.
 * The Claude app's copy of a chat it ran in WSL can lag behind the transcript the distribution
 * keeps by records that carry no time.
 */
export function newerCopy(a: ImportableChat, b: ImportableChat): boolean {
  const order = byRecency(a, b);
  return order < 0 || (order === 0 && (a.bytes ?? 0) > (b.bytes ?? 0));
}
