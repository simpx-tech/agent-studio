import { workspaceSchema, messageText, type Conversation, type Workspace } from './domain.ts';
import { emptyFleet } from './fleet.ts';
import { mergeActivityBlocks } from './activity.ts';
import { mergeVisualizations } from './visualizations.ts';
import { mergeQuestions } from './questions.ts';

export type SharedWorkspace = Pick<
  Workspace,
  'fleet' | 'conversations' | 'workflows' | 'inputTemplates'
>;
export const sharedSchema = workspaceSchema.pick({
  fleet: true,
  conversations: true,
  workflows: true,
  inputTemplates: true,
});
export const emptyShared = (): SharedWorkspace => ({ fleet: emptyFleet(), conversations: [] });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
        !previous.questions?.length
      )
        return message;
      return { ...message, questions: mergeQuestions(message.questions, previous.questions) };
    }),
  };
}

function sameRun(
  left: Conversation,
  right: Conversation,
  base?: Conversation,
): Conversation | undefined {
  let settings = left.settings;
  let archived = left.archived;
  if (
    left.settings.provider !== right.settings.provider ||
    left.settings.connectionId !== right.settings.connectionId ||
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
    // A response checkpoint and a one-sided edit for the next request are independent.
    // Conflicting settings edits still produce the existing conflict copy.
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
    const at = messageText(a),
      bt = messageText(b);
    if (!at.startsWith(bt) && !bt.startsWith(at)) return;
    const rank = { running: 0, cancelled: 1, error: 2, complete: 3 };
    const score = (message: typeof a) =>
      message.error === 'This response was interrupted when the app closed.'
        ? -1
        : rank[message.status];
    const selected =
      score(a) > score(b) ? a : score(b) > score(a) ? b : at.length >= bt.length ? a : b;
    messages.push({
      ...selected,
      blocks: mergeActivityBlocks(selected.blocks, selected === a ? b.blocks : a.blocks),
      ...(a.questions || b.questions
        ? { questions: mergeQuestions(a.questions, b.questions) }
        : {}),
      plan: (a.plan?.revision ?? -1) >= (b.plan?.revision ?? -1) ? a.plan : b.plan,
      ...(a.visualizations || b.visualizations
        ? { visualizations: mergeVisualizations(a.visualizations, b.visualizations) }
        : {}),
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
              name: `${(left as T & { name: string }).name.slice(0, 60)} (conflict copy)`,
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
          const response = sameRun(
            left as unknown as Conversation,
            right as unknown as Conversation,
            before as unknown as Conversation | undefined,
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
            title: `${(left as T & { title: string }).title.slice(0, 70)} (conflict copy)`,
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
  };
}
export type Presence = {
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
    'run' | 'usage' | 'models' | 'title' | 'folders' | 'context' | 'nativeInstructions' | 'answer';
  args: Record<string, unknown>;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  events: unknown[];
  result?: unknown;
  error?: string;
  cancel: boolean;
};
