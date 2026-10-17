import { jsonEqual } from './json-equal.ts';
import {
  KEPT_ALERTS,
  freshKey,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
} from './workflow-model.ts';

/**
 * You and an agent edit one workflow at the same time: your editor saves what you changed, the
 * agent saves through workflow_save. A save that lost to a newer revision is merged over it:
 * each field, step and connection takes the side that changed it since `base`, the copy the
 * losing save started from; a step both changed takes each of its fields the same way, and yours
 * wins where both changed the same one. A step either side deleted stays deleted, and a step you
 * added under a key the other side took meanwhile gets a key of its own.
 */
export function mergeDefinition(
  base: WorkflowDefinition,
  mine: WorkflowDefinition,
  theirs: WorkflowDefinition,
): WorkflowDefinition {
  const merged: Record<string, unknown> = { ...theirs };
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]) as Set<
    keyof WorkflowDefinition
  >;
  for (const key of keys) {
    if (key === 'graph') continue;
    merged[key] = pick(base[key], mine[key], theirs[key]);
  }
  const nodes = mergeItems(base.graph.nodes, mine.graph.nodes, theirs.graph.nodes, (n) => n.id, mergeNode);
  // A step you added keeps its own key when the other side gave that key to another step.
  const used = new Set<string>();
  const theirIds = new Set(theirs.graph.nodes.map((n) => n.id));
  for (const node of nodes.filter((n) => theirIds.has(n.id))) used.add(node.key);
  for (const node of nodes.filter((n) => !theirIds.has(n.id))) {
    if (used.has(node.key)) node.key = freshKey(node.type, used);
    used.add(node.key);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = mergeItems(
    base.graph.edges,
    mine.graph.edges,
    theirs.graph.edges,
    (e) => e.id,
    (b, m, t) => pickObject(b, m, t),
  ).filter((e) => ids.has(e.source) && ids.has(e.target));
  merged.graph = { nodes, edges };
  return merged as WorkflowDefinition;
}

/** The side that changed a value since `base`; yours when both did. */
function pick<T>(base: T, mine: T, theirs: T): T {
  if (jsonEqual(mine, base)) return theirs;
  return mine;
}
function pickObject<T extends object>(base: T | undefined, mine: T, theirs: T): T {
  if (!base) return mine;
  const result: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  for (const key of keys)
    result[key] = pick(
      (base as Record<string, unknown>)[key],
      (mine as Record<string, unknown>)[key],
      (theirs as Record<string, unknown>)[key],
    );
  return result as T;
}
function mergeNode(base: WorkflowNode | undefined, mine: WorkflowNode, theirs: WorkflowNode) {
  const node = pickObject(base, mine, theirs);
  // Settings merge key by key too, so an agent's prompt and your retries both stay.
  if (base)
    node.config = pickObject(
      base.config as Record<string, unknown>,
      mine.config as Record<string, unknown>,
      theirs.config as Record<string, unknown>,
    );
  return node;
}
function mergeItems<T>(
  base: T[],
  mine: T[],
  theirs: T[],
  id: (item: T) => string,
  merge: (base: T | undefined, mine: T, theirs: T) => T,
): T[] {
  const before = new Map(base.map((item) => [id(item), item]));
  const ours = new Map(mine.map((item) => [id(item), item]));
  const result: T[] = [];
  for (const item of theirs) {
    const key = id(item);
    const old = before.get(key);
    const own = ours.get(key);
    // Deleted on our side: gone, whatever the other side did.
    if (old && !own) continue;
    result.push(own ? merge(old, own, item) : item);
  }
  const theirIds = new Set(theirs.map(id));
  for (const item of mine) {
    const key = id(item);
    // Kept above, or deleted on their side.
    if (theirIds.has(key) || before.has(key)) continue;
    result.push(item);
  }
  return result;
}

/**
 * Two writers of one run, the computer driving it and anyone answering, commanding or writing a
 * note, compare-and-set the same document. When one write loses, its changes are merged over the
 * newer copy: lists by id, each item by its own revision, so progress, answers, commands and
 * notes never overwrite each other. `base` is the copy the losing write started from.
 */
export function mergeRun(base: WorkflowRun, mine: WorkflowRun, theirs: WorkflowRun): WorkflowRun {
  const merged: Record<string, unknown> = { ...theirs };
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]) as Set<keyof WorkflowRun>;
  for (const key of keys) {
    const b = base[key],
      m = mine[key],
      t = theirs[key];
    if (jsonEqual(m, t) || jsonEqual(m, b)) {
      merged[key] = t;
      continue;
    }
    if (jsonEqual(t, b)) {
      merged[key] = m;
      continue;
    }
    switch (key) {
      case 'commands':
        merged[key] = union(mine.commands, theirs.commands, (c) => c.id);
        break;
      case 'handled':
        merged[key] = [...new Set([...theirs.handled, ...mine.handled])];
        break;
      case 'questions':
        merged[key] = byRevision(mine.questions, theirs.questions, (q) => q.id);
        break;
      case 'notes':
        merged[key] = byRevision(mine.notes, theirs.notes, (n) => n.id);
        break;
      case 'activations':
        merged[key] = byRevision(mine.activations, theirs.activations, (a) => a.id);
        break;
      case 'tasks':
        merged[key] = byRevision(mine.tasks, theirs.tasks, (t) => t.id);
        break;
      case 'agents':
        merged[key] = byRevision(mine.agents, theirs.agents, (a) => a.conversationId);
        break;
      case 'children':
        merged[key] = byRevision(mine.children, theirs.children, (c) => c.runId);
        break;
      case 'alerts':
        merged[key] = union(mine.alerts, theirs.alerts, (a) => a.id)
          .sort((a, b) => a.at.localeCompare(b.at))
          .slice(-KEPT_ALERTS);
        break;
      case 'sessions':
        merged[key] = byLatest(
          mine.sessions,
          theirs.sessions,
          (s) => s.conversationId,
          (s) => (s.endedAt ? 1 : 0) + s.turns / 1e9,
        );
        break;
      case 'timers':
        merged[key] = byLatest(
          mine.timers,
          theirs.timers,
          (t) => t.id,
          (t) => (t.status === 'pending' ? 0 : 1),
        );
        break;
      case 'inbox': {
        // Items delivered on one side are gone from it; an item only one side added stays.
        const removed = new Set(
          base.inbox
            .filter(
              (i) =>
                !mine.inbox.some((m) => m.id === i.id) || !theirs.inbox.some((t) => t.id === i.id),
            )
            .map((i) => i.id),
        );
        merged[key] = union(mine.inbox, theirs.inbox, (i) => i.id).filter(
          (i) => !removed.has(i.id),
        );
        break;
      }
      case 'status':
        merged[key] = laterStatus(mine, theirs);
        break;
      default:
        // A field both sides changed in their own way: the newer copy keeps its value, unless
        // only one side ended the run.
        merged[key] = t;
    }
  }
  const result = merged as WorkflowRun;
  if (result.status !== 'running' && result.status !== 'paused' && !result.endedAt)
    result.endedAt = mine.endedAt ?? theirs.endedAt;
  return result;
}

function union<T>(mine: T[], theirs: T[], id: (item: T) => string): T[] {
  const seen = new Set(theirs.map(id));
  return [...theirs, ...mine.filter((item) => !seen.has(id(item)))];
}
function byRevision<T extends { revision: number }>(
  mine: T[],
  theirs: T[],
  id: (item: T) => string,
): T[] {
  return byLatest(mine, theirs, id, (item) => item.revision);
}
function byLatest<T>(
  mine: T[],
  theirs: T[],
  id: (item: T) => string,
  rank: (item: T) => number,
): T[] {
  const result = [...theirs];
  const at = new Map(result.map((item, index) => [id(item), index]));
  for (const item of mine) {
    const index = at.get(id(item));
    if (index === undefined) {
      at.set(id(item), result.length);
      result.push(item);
    } else if (rank(item) > rank(result[index])) result[index] = item;
  }
  return result;
}
/** An ended run stays ended; a stop wins over a pause, and either over running on. */
function laterStatus(mine: WorkflowRun, theirs: WorkflowRun): WorkflowRun['status'] {
  const rank = { running: 0, paused: 1, failed: 2, completed: 2, stopped: 3 } as const;
  return rank[mine.status] > rank[theirs.status] ? mine.status : theirs.status;
}
