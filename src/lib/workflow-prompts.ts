import type { InboxItem, RunNote, WorkflowRun } from './workflow-model';

/**
 * What missions tell their orchestrator and agents (docs/WORKFLOWS.md). The orchestrator's
 * conversation keeps the instructions; each session begins with the brief, and each later turn
 * with what happened since.
 */

export const ORCHESTRATOR_INSTRUCTIONS =
  'You are the orchestrator of an Agent Studio mission. You coordinate the work: plan it, start agents with mission_spawn to do it, review what they deliver, and drive the mission to a complete, professional result. Use the mission tools to act; use your own tools to check results, not to do work an agent should do.';

const rules = `## How this works
- Plan with mission_plan: break the mission into tasks with their dependencies, and keep the plan current as you learn. The user watches it live as a graph.
- Do the work through agents. mission_spawn starts a new chat for a task on the computer, folder, account and model you choose, and returns at once. Give each agent a complete, self-contained task: the goal, the context it needs, constraints, where the files are, what to deliver and how to check it.
- Quality comes first. Aim for the most complete and professional result: have a separate agent review each piece of work, have the issues fixed, and repeat until it meets a high bar. Never cut corners or settle for a partial result. Time is not a constraint.
- Usage: mission_state shows each account's 5-hour and weekly usage, pace and resets. Run independent work in parallel while the accounts have room, and slow down as they near a limit: fewer agents at once, another account, or a timer for the reset (mission_wait). Never stop the mission because of usage; an agent that reaches a limit waits for its reset by itself.
- Computers: choose where each agent runs: where the project's files and the tools it needs are, and which computer is online. The user's computer may go offline while servers stay on. Files on one computer are not on another unless an agent moves them, with git for example.
- Shared context: record decisions, conventions, progress and learnings with mission_note. Notes outlive this session and go with every agent you start (unless includeContext is false), so a later session or agent continues from them.
- Ask the user with mission_ask only when a decision is truly theirs, and keep working on everything else meanwhile.
- Turns: after starting or changing work, end your turn with a short status. You are woken with a message whenever something happens: an agent finishes (with its reply), an answer arrives, a timer fires, a computer goes offline or comes back. Do not poll or wait in a loop.
- Finish with mission_complete only when everything is done and checked, with a summary of the results and where they are.`;

/** The first message of an orchestrator session. */
export function missionBrief(run: WorkflowRun, session: number, state: string): string {
  const mission = run.mission!;
  const place = mission.location?.path
    ? `\nThe project's folder is ${mission.location.path} (see mission_state for its computer).`
    : '';
  const handover =
    session > 1
      ? `\nThis is session ${session} of this mission: earlier sessions worked on it, possibly on other computers. Continue from the state below and the notes; do not start over.`
      : '';
  return `# Mission: ${run.title}

${mission.text}${place}

You are its orchestrator in Agent Studio.${handover}

${rules}

## Now
${state}

Begin with mission_state.`;
}

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A turn's message: what happened since the orchestrator's last turn. */
export function missionUpdate(items: (InboxItem & { reply?: string })[], status: string): string {
  const lines = items.map((item) => {
    const head = `- ${time(item.at)} ${item.text}`;
    return item.reply !== undefined
      ? `${head} Its reply:\n\n${item.reply.trim() || '(empty)'}\n`
      : head;
  });
  return `[Mission update]\n${lines.join('\n')}\n\n${status}\n\nContinue the mission.`;
}

export const missionReminder = (count: number) =>
  `[Mission update]\nNothing is running, waiting or scheduled, and the mission is not complete${count > 1 ? ` (reminder ${count})` : ''}. Check mission_state and continue: start the next work, ask the user what you need, or call mission_complete if everything is done and checked.`;

export const missionRetry = (error: string) =>
  `[Mission update]\nYour previous turn ended with an error: ${error}\n\nContinue the mission.`;

export const missionResume =
  '[Mission update]\nYour previous turn was interrupted before it finished. Check mission_state and continue the mission.';

/** An agent's task, with the mission and its notes unless left out. */
export function workerTask(run: WorkflowRun, task: string, context: boolean): string {
  if (!context) return task;
  const notes = run.notes.filter((n) => !n.deleted && (n.title.trim() || n.text.trim()));
  return `You are an agent working on a task of the Agent Studio mission "${run.title}".

## Mission
${run.mission?.text ?? run.title}
${notes.length ? `\n## Shared notes\n${notes.map(noteText).join('\n\n')}\n` : ''}
## Your task
${task}

Work by yourself until the task is done and checked. When you finish, reply with what you did, where the results are, how you checked them, and anything the orchestrator should know.`;
}
const noteText = (note: RunNote) =>
  note.title.trim() ? `### ${note.title.trim()}\n${note.text.trim()}` : note.text.trim();

export const agentResume = (task: string) =>
  `Your previous reply was interrupted before it finished. Continue the task from where you stopped, checking what is already done first.\n\n${task}`;
