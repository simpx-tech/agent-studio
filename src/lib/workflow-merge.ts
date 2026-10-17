import { jsonEqual } from './json-equal.ts';
import { KEPT_ALERTS, type WorkflowRun } from './workflow-model.ts';

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
