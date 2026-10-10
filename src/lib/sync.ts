import {
  workspaceSchema,
  messageText,
  interruptedReplyError,
  type Conversation,
  type Message,
  type Workspace,
} from './domain.ts';
import { z } from 'zod';
import { emptyFleet } from './fleet.ts';
import { mergeActivityBlocks } from './activity.ts';
import { mergeVisualizations } from './visualizations.ts';
import { mergeSentFiles } from './sent-files.ts';
import { mergeScreenCards } from './screens.ts';
import { mergeQuestions } from './questions.ts';
import { mergeElicitations } from './elicitations.ts';
import { mergeSteering } from './steering.ts';
import { mergeCompactions } from './compaction.ts';
import { mergeProposedPlans } from './proposed-plans.ts';
import { latestFileChanges } from './file-changes.ts';
import { latestAccountUsage, latestTokenUsage } from './spend.ts';
import { latestUsageLimit } from './usage-limits.ts';
import { mergeClaudeInstructions } from './claude-instructions.ts';
import { mergeAppSessions } from './app-sessions.ts';
import { mergeFolderIcons, sameFolderIcons } from './folder-icons.ts';

export type SharedWorkspace = Pick<
  Workspace,
  | 'fleet'
  | 'conversations'
  | 'workflows'
  | 'inputTemplates'
  | 'claudeInstructions'
  | 'appSessions'
  | 'folderIcons'
>;
export const sharedSchema = workspaceSchema.pick({
  fleet: true,
  conversations: true,
  workflows: true,
  inputTemplates: true,
  claudeInstructions: true,
  appSessions: true,
  folderIcons: true,
});
/** One conversation as replicated, so a sync can validate and compare it by itself. */
export const sharedChatSchema = sharedSchema.shape.conversations.element;
/** The replicated fields other than the conversations, which move together. */
export const sharedMetaSchema = sharedSchema.omit({ conversations: true });
export type SharedMeta = z.infer<typeof sharedMetaSchema>;
export const sharedMeta = (workspace: Workspace | SharedWorkspace): SharedMeta =>
  sharedMetaSchema.parse(workspace);
export const metaOf = (workspace: SharedWorkspace): SharedMeta => {
  const { conversations, ...meta } = workspace;
  return meta;
};
export type MergeOptions = {
  /**
   * Reports whether this device is the execution host of the run that produced `message`
   * and no longer executes it. Only then may a locally recorded restart interruption outrank
   * a running checkpoint from the relay; any other device's restart keeps following the run.
   */
  deadRun?: (conversation: Conversation, message: Message) => boolean;
};
export const emptyShared = (): SharedWorkspace => ({ fleet: emptyFleet(), conversations: [] });
/**
 * Gives an object another copy's fields while keeping the object itself, since views and running
 * replies hold on to live conversations. A field the copy no longer has is removed: `Object.assign`
 * alone kept a removed Undo rewind, which the device then published back to every other one.
 */
export function replaceFields<T extends object>(target: T, source: T): T {
  for (const key of Object.keys(target))
    if (!(key in source)) delete (target as Record<string, unknown>)[key];
  return Object.assign(target, source);
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Whether two shared workspaces hold the same data. Lists compare by item id: this device
 * adds new chats at the front, while a merge keeps its base order and appends them. App sessions
 * and folder icons compare only when `a`, the relay's copy, holds them: an older relay drops
 * them, and this device keeps its own.
 */
export function sameShared(a: SharedWorkspace, b: SharedWorkspace): boolean {
  const byId = <T extends { id: string }>(items: T[] = []) =>
    [...items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const same = <T extends { id: string }>(x?: T[], y?: T[]) => equal(byId(x), byId(y));
  return (
    same(a.conversations, b.conversations) &&
    same(a.fleet.computers, b.fleet.computers) &&
    same(a.fleet.environments, b.fleet.environments) &&
    same(a.fleet.accounts, b.fleet.accounts) &&
    same(a.fleet.connections, b.fleet.connections) &&
    same(a.workflows, b.workflows) &&
    same(a.inputTemplates, b.inputTemplates) &&
    a.claudeInstructions === b.claudeInstructions &&
    (!a.appSessions || same(a.appSessions, b.appSessions)) &&
    (!a.folderIcons || sameFolderIcons(a.folderIcons, b.folderIcons))
  );
}

// Questions are revisioned run history, not deletable conversation settings.
// Older relays/clients can omit them even from a successful save response.
function retainQuestions(selected: Conversation, other?: Conversation): Conversation {
  if (
    !other ||
    selected.settings.provider !== other.settings.provider ||
    selected.settings.connectionId !== other.settings.connectionId ||
    !equal(selected.location, other.location)
  )
    return selected;
  return {
    ...selected,
    messages: selected.messages.map((message) => {
      const previous = other.messages.find((m) => m.id === message.id);
      if (
        message.role !== 'assistant' ||
        previous?.role !== 'assistant' ||
        !message.runId ||
        message.runId !== previous.runId ||
        !equal(message.settings, previous.settings) ||
        (!previous.blocks.some((b) => b.type === 'reasoning') &&
          !previous.questions?.length &&
          !previous.elicitations?.length &&
          !previous.steering?.length &&
          !previous.compactions?.length &&
          !previous.proposedPlans?.length &&
          !previous.fileChanges &&
          !previous.filesUndone &&
          !previous.accountUsage &&
          !previous.usageLimit &&
          previous.usage?.revision == null)
      )
        return message;
      return {
        ...message,
        ...(message.proposedPlans || previous.proposedPlans
          ? { proposedPlans: mergeProposedPlans(message.proposedPlans, previous.proposedPlans) }
          : {}),
        ...(message.compactions || previous.compactions
          ? { compactions: mergeCompactions(message.compactions, previous.compactions) }
          : {}),
        ...(message.filesUndone || previous.filesUndone ? { filesUndone: true } : {}),
        blocks: mergeActivityBlocks(
          message.blocks,
          previous.blocks.filter((b) => b.type === 'reasoning'),
        ),
        ...(message.usage || previous.usage
          ? { usage: latestTokenUsage(message.usage, previous.usage) }
          : {}),
        ...(message.accountUsage || previous.accountUsage
          ? { accountUsage: latestAccountUsage(message.accountUsage, previous.accountUsage) }
          : {}),
        ...(message.questions || previous.questions
          ? { questions: mergeQuestions(message.questions, previous.questions) }
          : {}),
        ...(message.elicitations || previous.elicitations
          ? { elicitations: mergeElicitations(message.elicitations, previous.elicitations) }
          : {}),
        ...(message.steering || previous.steering
          ? { steering: mergeSteering(message.steering, previous.steering) }
          : {}),
        ...(message.fileChanges || previous.fileChanges
          ? { fileChanges: latestFileChanges(message.fileChanges, previous.fileChanges) }
          : {}),
        ...(message.usageLimit || previous.usageLimit
          ? { usageLimit: latestUsageLimit(message.usageLimit, previous.usageLimit) }
          : {}),
      };
    }),
  };
}

const rank = { running: 0, cancelled: 1, error: 2, complete: 3 };
// A restarted device only saw its own copy stop; any other copy of the run knows better.
const interrupted = (message: Message) => message.error === interruptedReplyError;
const score = (message: Message) => (interrupted(message) ? -1 : rank[message.status]);
/**
 * The later of two copies of one reply, `left` this device's and `right` the relay's. Only the
 * computer running a reply writes it, so its copies differ in time, never in content. Its answer
 * is not one growing text: the text written before a call becomes a progress comment and the
 * answer starts again. So the status decides first, then the blocks and the usage revision the
 * reply recorded, then an answer extending the other; otherwise the relay's copy, which the
 * running computer publishes, is the later one. Requiring one answer to extend the other made a
 * conflict copy of a chat whenever a phone held its reply from an earlier step.
 */
function laterReply(left: Message, right: Message): Message {
  for (const difference of [
    score(left) - score(right),
    left.blocks.length - right.blocks.length,
    (left.usage?.revision ?? -1) - (right.usage?.revision ?? -1),
  ])
    if (difference) return difference > 0 ? left : right;
  return messageText(left).startsWith(messageText(right)) ? left : right;
}

function sameRun(
  left: Conversation,
  right: Conversation,
  base?: Conversation,
  options?: MergeOptions,
): Conversation | undefined {
  let settings = left.settings;
  let archived = left.archived;
  if (
    (left.historyRevision ?? 0) !== (right.historyRevision ?? 0) ||
    !equal(left.rewind, right.rewind) ||
    left.settings.provider !== right.settings.provider ||
    !equal(left.location, right.location)
  )
    return;
  if (!!left.archived !== !!right.archived) {
    // Opening an app session can archive a chat while its owning host publishes a reply.
    // Keep the one-sided archive/restore change together with that response checkpoint.
    if (base && !!left.archived === !!base.archived) archived = right.archived;
    else if (!base || !!right.archived !== !!base.archived) return;
  }
  if (!equal(left.settings, right.settings)) {
    // A response checkpoint and a one-sided edit for the next request, such as the account
    // switched to after a usage limit, are independent. Conflicting settings edits still
    // produce the existing conflict copy.
    if (base && equal(left.settings, base.settings)) settings = right.settings;
    else if (!base || !equal(right.settings, base.settings)) return;
  }
  const messages = [];
  let sharedRun = false;
  for (let i = 0; i < Math.max(left.messages.length, right.messages.length); i++) {
    const a = left.messages[i],
      b = right.messages[i];
    if (!a || !b) {
      messages.push(a ?? b);
      continue;
    }
    if (a.id !== b.id) return;
    if (a.runId && a.runId === b.runId) sharedRun = true;
    if (equal(a, b)) {
      messages.push(a);
      continue;
    }
    if (!a.runId || a.runId !== b.runId) return;
    if (!equal(a.settings, b.settings)) return;
    const chosen = laterReply(a, b);
    const other = chosen === a ? b : a;
    // Unless the execution host itself restarted without this run: keep the newest checkpoint
    // content, but nothing will finish it, so its interruption outranks the stale running copy.
    const selected =
      chosen.status === 'running' && interrupted(a) && options?.deadRun?.(left, a)
        ? { ...chosen, status: 'cancelled' as const, error: interruptedReplyError }
        : chosen;
    messages.push({
      ...selected,
      ...(a.filesUndone || b.filesUndone ? { filesUndone: true } : {}),
      ...(a.proposedPlans || b.proposedPlans
        ? { proposedPlans: mergeProposedPlans(a.proposedPlans, b.proposedPlans) }
        : {}),
      ...(a.compactions || b.compactions
        ? { compactions: mergeCompactions(a.compactions, b.compactions) }
        : {}),
      ...(a.usage || b.usage ? { usage: latestTokenUsage(selected.usage, other.usage) } : {}),
      ...(a.accountUsage || b.accountUsage
        ? { accountUsage: latestAccountUsage(a.accountUsage, b.accountUsage) }
        : {}),
      blocks: mergeActivityBlocks(selected.blocks, other.blocks),
      ...(a.fileChanges || b.fileChanges
        ? { fileChanges: latestFileChanges(a.fileChanges, b.fileChanges) }
        : {}),
      ...(a.usageLimit || b.usageLimit
        ? { usageLimit: latestUsageLimit(a.usageLimit, b.usageLimit) }
        : {}),
      ...(a.questions || b.questions
        ? { questions: mergeQuestions(a.questions, b.questions) }
        : {}),
      ...(a.elicitations || b.elicitations
        ? { elicitations: mergeElicitations(a.elicitations, b.elicitations) }
        : {}),
      ...(a.steering || b.steering ? { steering: mergeSteering(a.steering, b.steering) } : {}),
      plan: (a.plan?.revision ?? -1) >= (b.plan?.revision ?? -1) ? a.plan : b.plan,
      ...(a.visualizations || b.visualizations
        ? { visualizations: mergeVisualizations(a.visualizations, b.visualizations) }
        : {}),
      ...(a.sentFiles || b.sentFiles
        ? { sentFiles: mergeSentFiles(a.sentFiles, b.sentFiles) }
        : {}),
      ...(a.screens || b.screens ? { screens: mergeScreenCards(a.screens, b.screens) } : {}),
      workflow:
        (a.workflow?.revision ?? -1) >= (b.workflow?.revision ?? -1) ? a.workflow : b.workflow,
      nativeWorkflows:
        (a.nativeWorkflows?.revision ?? -1) >= (b.nativeWorkflows?.revision ?? -1)
          ? a.nativeWorkflows
          : b.nativeWorkflows,
      ...(a.durationMs != null || b.durationMs != null
        ? { durationMs: Math.max(a.durationMs ?? 0, b.durationMs ?? 0) }
        : {}),
    });
  }
  if (!sharedRun) return;
  const title =
    left.titleStatus === 'generated' ? left : right.titleStatus === 'generated' ? right : left;
  return {
    ...left,
    archived,
    settings,
    title: title.title,
    titleStatus: title.titleStatus,
    titleSource: title.titleSource,
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
    messages,
  };
}
export function sharedWorkspace(workspace: Workspace): SharedWorkspace {
  return sharedSchema.parse(workspace);
}

/**
 * Whether `after` is `before` with only its replies further along: the same messages in the same
 * order, the user's unchanged, and the chat itself the same apart from when it was updated. A
 * merge reconciles such copies by itself. Any other change (a message added or removed, a rewind,
 * an archive, settings, a title, a new chat) has to reach the sync checkpoint at once, because
 * after a reload a saved copy the checkpoint lags behind looks edited on that device.
 */
export function onlyRepliesMoved(before: Conversation | undefined, after: Conversation): boolean {
  if (!before || before.messages.length !== after.messages.length) return false;
  for (let i = 0; i < before.messages.length; i++) {
    const a = before.messages[i],
      b = after.messages[i];
    if (a.id !== b.id || a.role !== b.role || (a.role !== 'assistant' && !equal(a, b)))
      return false;
  }
  return equal(
    { ...after, updatedAt: before.updatedAt, messages: [] },
    { ...before, messages: [] },
  );
}

// A stopped host can publish its last checkpoint after another device deletes
// the chat. Only background reply/title updates yield to that deletion; retain
// conflict copies for new messages or deliberate settings/location/title edits.
function backgroundUpdate(before: Conversation, updated: Conversation): boolean {
  const metadata = { ...updated, updatedAt: before.updatedAt, messages: before.messages };
  if (
    before.titleStatus === 'pending' &&
    ((updated.titleStatus === 'generated' && updated.titleSource) ||
      (updated.titleStatus === 'fallback' && updated.title === before.title))
  ) {
    metadata.title = before.title;
    metadata.titleStatus = before.titleStatus;
    metadata.titleSource = before.titleSource;
  }
  if (!equal(metadata, before) || before.messages.length !== updated.messages.length) return false;
  if (equal(before.messages, updated.messages)) return true;
  return (
    !!sameRun(before, updated, before) &&
    before.messages.every(
      (message, index) =>
        equal(message, updated.messages[index]) ||
        (message.status === 'running' &&
          !!message.runId &&
          message.id === updated.messages[index].id),
    )
  );
}

// Preferences and credentials are not replicated. Retain divergent chat edits as a copy;
// stop on metadata conflicts instead of silently changing execution routing.
export function mergeShared(
  base: SharedWorkspace,
  local: SharedWorkspace,
  remote: SharedWorkspace,
  options?: MergeOptions,
): SharedWorkspace {
  const merge = <T extends { id: string }>(
    old: T[],
    ours: T[],
    theirs: T[],
    chats: boolean | 'named' = false,
  ): T[] => {
    const b = new Map(old.map((v) => [v.id, v])),
      l = new Map(ours.map((v) => [v.id, v])),
      r = new Map(theirs.map((v) => [v.id, v]));
    const result: T[] = [];
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const before = b.get(id),
        left = l.get(id),
        right = r.get(id);
      if (equal(left, right) || equal(before, right)) {
        if (left)
          result.push(
            chats === true
              ? (retainQuestions(
                  left as unknown as Conversation,
                  right as unknown as Conversation,
                ) as unknown as T)
              : left,
          );
      } else if (equal(before, left)) {
        if (right)
          result.push(
            chats === true
              ? (retainQuestions(
                  right as unknown as Conversation,
                  left as unknown as Conversation,
                ) as unknown as T)
              : right,
          );
      } else if (chats) {
        if (chats === 'named') {
          if (right) result.push(right);
          if (left)
            result.push({
              ...left,
              id: crypto.randomUUID(),
              name: `${(left as T & { name: string }).name} (conflict copy)`,
            });
          continue;
        }
        if (
          before &&
          (!left || !right) &&
          backgroundUpdate(
            before as unknown as Conversation,
            (left ?? right) as unknown as Conversation,
          )
        )
          continue;
        if (left && right) {
          const a = left as unknown as Conversation,
            b = right as unknown as Conversation;
          if ((a.historyRevision ?? 0) !== (b.historyRevision ?? 0)) {
            // Rewind and file Undo replace the history: an older copy yields unless it holds
            // deliberate edits. Its one-sided archive change still applies, as for replies.
            const newer = (a.historyRevision ?? 0) > (b.historyRevision ?? 0) ? a : b;
            const older = newer === a ? b : a;
            const original = before as unknown as Conversation | undefined;
            const archivedOlder =
              !!original &&
              !!older.archived !== !!original.archived &&
              !!newer.archived === !!original.archived;
            result.push(
              (archivedOlder ? { ...newer, archived: older.archived } : newer) as unknown as T,
            );
            if (
              !original ||
              !backgroundUpdate(original, { ...older, archived: original.archived })
            ) {
              result.push({
                ...older,
                id: crypto.randomUUID(),
                title: `${older.title} (conflict copy)`,
                titleStatus: 'fallback',
              } as unknown as T);
            }
            continue;
          }
          const response = sameRun(
            left as unknown as Conversation,
            right as unknown as Conversation,
            before as unknown as Conversation | undefined,
            options,
          );
          if (response) {
            result.push(response as unknown as T);
            continue;
          }
        }
        if (right) result.push(right);
        if (left)
          result.push({
            ...left,
            id: crypto.randomUUID(),
            title: `${(left as T & { title: string }).title} (conflict copy)`,
            titleStatus: 'fallback',
          });
      } else
        throw new Error(
          'Computer or account settings changed on both devices. Export this workspace before resolving the conflicting settings.',
        );
    }
    return result;
  };
  return {
    fleet: {
      computers: merge(base.fleet.computers, local.fleet.computers, remote.fleet.computers),
      environments: merge(
        base.fleet.environments,
        local.fleet.environments,
        remote.fleet.environments,
      ),
      accounts: merge(base.fleet.accounts, local.fleet.accounts, remote.fleet.accounts),
      connections: merge(base.fleet.connections, local.fleet.connections, remote.fleet.connections),
    },
    conversations: merge(base.conversations, local.conversations, remote.conversations, true),
    ...(local.workflows || remote.workflows || base.workflows
      ? {
          workflows: merge(
            base.workflows ?? [],
            local.workflows ?? [],
            remote.workflows ?? [],
            'named',
          ),
        }
      : {}),
    ...(local.inputTemplates || remote.inputTemplates || base.inputTemplates
      ? {
          inputTemplates: merge(
            base.inputTemplates ?? [],
            local.inputTemplates ?? [],
            remote.inputTemplates ?? [],
            'named',
          ),
        }
      : {}),
    ...claudeInstructionsField(
      mergeClaudeInstructions(
        base.claudeInstructions,
        local.claudeInstructions,
        remote.claudeInstructions,
      ),
    ),
    ...appSessionsField(mergeAppSessions(base.appSessions, local.appSessions, remote.appSessions)),
    ...folderIconsField(mergeFolderIcons(base.folderIcons, local.folderIcons, remote.folderIcons)),
  };
}
// An absent value follows the default text, so it stays absent rather than undefined.
const claudeInstructionsField = (value: string | undefined) =>
  value === undefined ? {} : { claudeInstructions: value };
const appSessionsField = (value: SharedWorkspace['appSessions']) =>
  value === undefined ? {} : { appSessions: value };
const folderIconsField = (value: SharedWorkspace['folderIcons']) =>
  value === undefined ? {} : { folderIcons: value };
export type Presence = {
  accountUpdates?: import('./live-usage').AccountUpdate[];
  environmentId: string;
  seenAt: number;
  online: boolean;
  connections: {
    connectionId: string;
    installed: boolean;
    auth: string;
    detail: string;
    version: string | null;
  }[];
  running: string[];
};
export type RelayJob = {
  id: string;
  source: string;
  target: string;
  method:
    | 'run'
    | 'usage'
    | 'account'
    | 'models'
    | 'title'
    | 'folderIcon'
    | 'folders'
    | 'context'
    | 'mentions'
    | 'nativeInstructions'
    | 'toolOutput'
    | 'toolOutputImage'
    | 'toolOutputModel'
    | 'toolOutputModelViews'
    | 'mcp'
    | 'plugins'
    | 'undoFiles'
    | 'answer'
    | 'elicitation'
    | 'steer'
    | 'release'
    | 'screens';
  args: Record<string, unknown>;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  events: unknown[];
  result?: unknown;
  error?: string;
  cancel: boolean;
};
