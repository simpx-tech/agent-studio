import { z } from 'zod';
import type { Conversation } from './domain';
import {
  mergeShared,
  metaOf,
  sharedChatSchema,
  sharedMetaSchema,
  type MergeOptions,
  type SharedMeta,
  type SharedWorkspace,
} from './sync';

const count = z.number().int().nonnegative();
export const manifestSchema = z.object({
  instanceId: z.string().min(1),
  revision: count,
  metaRevision: count,
  /** Which revision last changed each conversation the relay holds. */
  chats: z.record(z.string(), count),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const chatsAnswerSchema = manifestSchema.extend({
  chats: z.array(sharedChatSchema),
  chatRevisions: z.record(z.string(), count),
});
export const metaAnswerSchema = manifestSchema.extend({ meta: sharedMetaSchema });

/** What a poll has to look at, given what each side reports. */
export function involvedChats({
  manifest,
  baselineChats,
  baselineMetaRevision,
  baselineIds,
  localIds,
  changedHere,
}: {
  manifest: Manifest;
  baselineChats: Record<string, number>;
  baselineMetaRevision: number;
  baselineIds: string[];
  localIds: string[];
  /** Conversations changed on this device, or `undefined` when every one must be considered. */
  changedHere: Set<string> | undefined;
}): { involved: string[]; fetch: string[]; metaMoved: boolean } {
  const involved = new Set<string>();
  // Whatever the relay changed, added or dropped since this device agreed with it.
  for (const [id, revision] of Object.entries(manifest.chats))
    if (baselineChats[id] !== revision) involved.add(id);
  for (const id of Object.keys(baselineChats)) if (!(id in manifest.chats)) involved.add(id);
  const fetch = [...involved].filter((id) => id in manifest.chats);
  // Whatever this device changed, added or deleted.
  if (changedHere === undefined) {
    for (const id of localIds) involved.add(id);
    for (const id of baselineIds) involved.add(id);
  } else {
    for (const id of changedHere) involved.add(id);
    const here = new Set(localIds);
    for (const id of baselineIds) if (!here.has(id)) involved.add(id);
  }
  return {
    involved: [...involved],
    fetch,
    metaMoved: manifest.metaRevision !== baselineMetaRevision,
  };
}

/**
 * Merges the conversations a poll is concerned with. `mergeShared` reads whole workspaces and
 * treats an absent conversation as a deletion, so all three sides are restricted to the same
 * ids: a conversation nobody touched is simply left alone.
 */
export function mergeInvolved({
  involved,
  baseline,
  baselineMeta,
  localChat,
  localMeta,
  remoteChat,
  remoteMeta,
  options,
}: {
  involved: string[];
  baseline: Map<string, Conversation>;
  baselineMeta: SharedMeta;
  localChat: (id: string) => Conversation | undefined;
  localMeta: SharedMeta;
  remoteChat: (id: string) => Conversation | undefined;
  remoteMeta: SharedMeta;
  options?: MergeOptions;
}): SharedWorkspace {
  const subset = (
    pick: (id: string) => Conversation | undefined,
    meta: SharedMeta,
  ): SharedWorkspace => ({
    ...meta,
    conversations: involved.map(pick).filter((c): c is Conversation => !!c),
  });
  return mergeShared(
    subset((id) => baseline.get(id), baselineMeta),
    subset(localChat, localMeta),
    subset(remoteChat, remoteMeta),
    options,
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What to send the relay, and what to apply here, after merging the involved conversations. */
export function syncPlan({
  involved,
  merged,
  manifest,
  localChat,
  localMeta,
  remoteChat,
  remoteMeta,
}: {
  involved: string[];
  merged: SharedWorkspace;
  manifest: Manifest;
  localChat: (id: string) => Conversation | undefined;
  localMeta: SharedMeta;
  remoteChat: (id: string) => Conversation | undefined;
  remoteMeta: SharedMeta;
}) {
  const mergedMeta = metaOf(merged);
  const result = new Map(merged.conversations.map((c) => [c.id, c]));
  const send: Conversation[] = [];
  const apply: Conversation[] = [];
  for (const [id, conversation] of result) {
    if (!same(remoteChat(id), conversation)) send.push(conversation);
    if (!same(localChat(id), conversation)) apply.push(conversation);
  }
  return {
    mergedMeta,
    result,
    send,
    apply,
    // Only the relay's own conversations can be removed there, and only this device's here.
    remove: involved.filter((id) => id in manifest.chats && !result.has(id)),
    forget: involved.filter((id) => !!localChat(id) && !result.has(id)),
    sendMeta: same(remoteMeta, mergedMeta) ? undefined : mergedMeta,
    applyMeta: same(localMeta, mergedMeta) ? undefined : mergedMeta,
  };
}

/** The baseline after a sync: the untouched conversations in place, the merged ones over them. */
export function nextBaselineChats(
  baseline: Conversation[],
  involved: string[],
  result: Map<string, Conversation>,
): Conversation[] {
  const touched = new Set(involved);
  const pending = new Map(result);
  const next: Conversation[] = [];
  for (const conversation of baseline) {
    if (!touched.has(conversation.id)) {
      next.push(conversation);
      continue;
    }
    const merged = pending.get(conversation.id);
    if (merged) next.push(merged);
    pending.delete(conversation.id);
  }
  for (const conversation of pending.values()) next.push(conversation);
  return next;
}
