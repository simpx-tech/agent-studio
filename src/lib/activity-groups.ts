import {
  activityDisplayStatus,
  toolDisplayStatus,
  type ActivityDisplayStatus,
  type ToolActivity,
} from './activity';
import type { ContentBlock, Message } from './domain';
import { filePathKey, relativeFilePath } from './file-changes';
import type { ReasoningBlock } from './reasoning';
import {
  connectedTool,
  primaryCommand,
  toolVisual,
  type ToolIconKey,
  type ToolVisual,
} from './tool-presentation';

type CommentEntry = Omit<Extract<ContentBlock, { type: 'activity' }>, 'tool'> & {
  tool?: ToolActivity;
};
type ActivityEntry = CommentEntry | ReasoningBlock;
/** A reply's saved blocks, or activity arranged like them, such as a sub-agent's conversation. */
export type ActivitySource = ContentBlock | CommentEntry;
type ActivityGroup =
  | { kind: 'tools'; key: string; tools: ToolActivity[] }
  | { kind: 'comment'; key: string; entry: CommentEntry }
  | { kind: 'reasoning'; key: string; block: ReasoningBlock };

const lifecycleNotes = ['Starting the provider CLI', 'Connected to Claude'];
const toolNotes = /^(Using |Running command|Editing files|Searching the web|Using connected tool)/;
// Replies saved before 2026-09-29 kept at most 200 calls and ended their activity with a record
// standing for the calls that were never recorded. It reads as a note, not as a call.
export const activityLimitNote =
  'Calls after the first 200 were not recorded: earlier versions kept only 200 per reply.';

/** Reasoning, progress comments and tool calls in their recorded order. */
export function activityEntries(
  blocks: ActivitySource[],
  tools: ToolActivity[],
  finalText: string,
): ActivityEntry[] {
  const source: ActivityEntry[] = blocks.length
    ? blocks.filter((b) => b.type !== 'markdown')
    : tools.map((tool) => ({ type: 'activity' as const, text: tool.name, tool }));
  const reasoning = new Set<string>();
  return source
    .filter((b) => {
      if (b.type === 'reasoning') {
        // Older Claude replies saved each streamed thinking block again from its snapshot,
        // numbered within the same message ("message:index").
        const key = `${b.id.replace(/:\d+$/, '')}\n${b.text}`;
        if (reasoning.has(key)) return false;
        reasoning.add(key);
        return true;
      }
      if (b.progress && b.text.trim() === finalText.trim()) return false;
      if (b.tool || b.progress) return true;
      return !lifecycleNotes.includes(b.text.trim()) && (!tools.length || !toolNotes.test(b.text));
    })
    .map((b) =>
      b.type === 'activity' && b.tool?.id === 'activity-limit'
        ? { type: 'activity' as const, text: activityLimitNote, order: b.order }
        : b,
    );
}

/** Consecutive tool calls share a group; reasoning and comments remain chronological boundaries. */
export function groupActivityEntries(entries: ActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.type === 'reasoning') {
      groups.push({ kind: 'reasoning', key: `reasoning:${entry.id}`, block: entry });
    } else if (entry.tool) {
      const previous = groups.at(-1);
      if (previous?.kind === 'tools') previous.tools.push(entry.tool);
      else groups.push({ kind: 'tools', key: `tools:${entry.tool.id}`, tools: [entry.tool] });
    } else {
      groups.push({
        kind: 'comment',
        key: entry.progress ? `progress:${entry.progress.id}` : `note:${index}`,
        entry,
      });
    }
  }
  return groups;
}

// The icon of each kind of action when its calls differ in detail.
const kindIcons: Record<keyof typeof phrases, ToolIconKey> = {
  hook: 'hook',
  hookContext: 'hook',
  read: 'file',
  edit: 'edit',
  files: 'findFiles',
  command: 'terminal',
  search: 'web',
  browse: 'page',
  agent: 'agent',
  background: 'background',
  backgroundAgent: 'agent',
  message: 'message',
  directory: 'directory',
  skill: 'skill',
  image: 'image',
  tool: 'tool',
};

/**
 * A group's icon: the specific icon its first kind of action shares, such as Git for a run
 * of git commands, or that kind's general icon when its calls differ.
 */
export function groupIcon(tools: ToolActivity[]): ToolIconKey {
  const first = tools[0];
  if (!first) return 'tool';
  const kind = action(first);
  if (kind === 'background' || kind === 'backgroundAgent') return kindIcons[kind];
  const icons = new Set(
    tools.filter((tool) => action(tool) === kind).map((tool) => toolVisual(tool).icon),
  );
  return icons.size === 1 ? [...icons][0] : kindIcons[kind];
}

// Use only reported operation/category/name metadata, never infer actions from output or paths.
function action(tool: ToolActivity): keyof typeof phrases {
  if (tool.category === 'hook') return tool.operation === 'hookContext' ? 'hookContext' : 'hook';
  // Launches that returned while their work continued, shown running in Background work.
  if (tool.background) return 'background';
  if (tool.category === 'agent' && tool.agents.length && tool.agents.every((a) => a.background))
    return 'backgroundAgent';
  if (tool.operation === 'viewImage') return 'image';
  if (tool.operation === 'read' || ['Read', 'Read file', 'Read skill file'].includes(tool.name))
    return 'read';
  if (
    tool.operation === 'edit' ||
    ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Edit files'].includes(tool.name)
  )
    return 'edit';
  if (
    ['glob', 'grep'].includes(tool.operation ?? '') ||
    ['Glob', 'Grep', 'List files', 'Find files', 'Search files', 'Search file contents'].includes(
      tool.name,
    )
  )
    return 'files';
  if (
    tool.commandRun ||
    tool.operation === 'command' ||
    ['Run command', 'Bash'].includes(tool.name)
  )
    return 'command';
  if (tool.category === 'search') return tool.name === 'Open web page' ? 'browse' : 'search';
  if (tool.category === 'agent') return 'agent';
  if (tool.operation === 'sendMessage') return 'message';
  if (tool.operation === 'listAgents') return 'directory';
  if (tool.category === 'skill') return 'skill';
  if (['View image', 'view_image'].includes(tool.name)) return 'image';
  return 'tool';
}

// Singular and plural nouns, then the past, running and noun forms; # becomes the counted noun.
const phrases = {
  hook: ['hook', 'hooks', 'ran #', 'running #', '#'],
  hookContext: [
    'hook',
    'hooks',
    'received context from #',
    'receiving context from #',
    'context from #',
  ],
  read: ['file', 'files', 'read #', 'reading #', 'reads of #'],
  edit: ['file', 'files', 'edited #', 'editing #', 'edits to #'],
  files: ['file search', 'file searches', 'ran #', 'running #', '#'],
  command: ['command', 'commands', 'ran #', 'running #', '#'],
  search: ['web search', 'web searches', 'ran #', 'running #', '#'],
  browse: ['web page', 'web pages', 'opened #', 'opening #', '#'],
  agent: ['sub-agent', 'sub-agents', 'worked with #', 'working with #', '#'],
  // A background launch has started even while other calls in its group still run.
  background: ['background task', 'background tasks', 'started #', 'started #', '#'],
  backgroundAgent: ['background sub-agent', 'background sub-agents', 'started #', 'started #', '#'],
  message: ['agent message', 'agent messages', 'sent #', 'sending #', '#'],
  directory: ['agent list', 'agent lists', 'checked #', 'checking #', '#'],
  skill: ['skill', 'skills', 'used #', 'using #', '#'],
  image: ['image', 'images', 'viewed #', 'viewing #', '#'],
  tool: ['tool', 'tools', 'used #', 'using #', '#'],
} as const;

// A file counts once however often it was read or edited, and a resumed sub-agent counts once.
// Every other call counts once.
function count(kind: keyof typeof phrases, tools: ToolActivity[]) {
  if (kind === 'agent' || kind === 'backgroundAgent')
    return new Set(
      tools.flatMap((tool) =>
        tool.agents.length ? tool.agents.map((agent) => agent.agentId ?? agent.id) : [tool.id],
      ),
    ).size;
  if (kind !== 'read' && kind !== 'edit') return tools.length;
  const files = new Set<string>();
  let unnamed = 0;
  for (const tool of tools) {
    // Codex file changes and combined skill reads report their other paths as facts.
    const paths = [
      tool.path,
      ...(tool.facts ?? [])
        .filter((fact) => fact.label === 'Files' || fact.label === 'Also read')
        .flatMap((fact) => fact.value.split('\n')),
    ].filter((path): path is string => !!path?.trim());
    for (const path of paths) files.add(filePathKey(path.trim()));
    if (!paths.length) unnamed++;
  }
  return files.size + unnamed;
}

// A state among a sub-agent's own calls and how many share it. `own` states are its calls' and
// run in the background with a background sub-agent; the others belong to sub-agents one of its
// calls holds.
type CallState = {
  status: ToolActivity['status'];
  background?: boolean;
  own: boolean;
  count: number;
};
type AgentStates = { length: number; states: Map<string, Map<string, CallState>> };
const agentStates = new WeakMap<ToolActivity[], AgentStates>();
/**
 * The distinct states of each sub-agent's own calls in a reply's list of calls, found once per
 * list, so that every group of a reply with thousands of calls summarizes its sub-agents' work
 * without reading all of their calls again.
 */
function callStatesByAgent(tools: ToolActivity[]) {
  let index = agentStates.get(tools);
  if (index?.length !== tools.length) {
    const states = new Map<string, Map<string, CallState>>();
    for (const tool of tools) {
      if (!tool.parentId) continue;
      let own = states.get(tool.parentId);
      if (!own) states.set(tool.parentId, (own = new Map()));
      // A call that holds sub-agents only summarizes them.
      for (const state of tool.agents.length
        ? tool.agents.map((a) => ({ status: a.status, background: a.background, own: false }))
        : [{ status: tool.status, background: tool.background, own: true }]) {
        const key = `${state.status} ${!!state.background} ${state.own}`;
        const seen = own.get(key);
        if (seen) seen.count++;
        else own.set(key, { ...state, count: 1 });
      }
    }
    agentStates.set(tools, (index = { length: tools.length, states }));
  }
  return index.states;
}

const issues = ['error', 'blocked', 'cancelled', 'unknown'] as const;
type Issue = (typeof issues)[number];

/** How many of a group's sub-agent calls failed, stopped or have an unconfirmed outcome. */
export function childIssueLabel({ status, count }: { status: Issue; count: number }) {
  const outcome = {
    error: 'failed',
    blocked: 'blocked',
    cancelled: 'stopped',
    unknown: 'unconfirmed',
  };
  return `${count} ${count === 1 ? 'call' : 'calls'} ${outcome[status]}`;
}

export function activityGroupSummary(
  tools: ToolActivity[],
  replyStatus: Message['status'],
  allTools: ToolActivity[] = tools,
) {
  const kinds = new Map<keyof typeof phrases, ToolActivity[]>();
  for (const tool of tools) {
    const kind = action(tool);
    const calls = kinds.get(kind);
    if (calls) calls.push(tool);
    else kinds.set(kind, [tool]);
  }
  const children = new Set(tools.flatMap((tool) => tool.agents.map((agent) => agent.id)));
  // A background sub-agent's own calls run in the background with it.
  const background = new Set(
    tools.flatMap((tool) => tool.agents.filter((a) => a.background).map((a) => a.id)),
  );
  const statuses = tools
    .flatMap((tool) => [
      // A sub-agent group's own status only summarizes its agents.
      ...(tool.agents.length ? [] : [tool]),
      ...tool.agents,
    ])
    .map((item) => activityDisplayStatus(item, replyStatus));
  // A sub-agent's own calls keep their outcomes apart: one that carried on past a failed
  // command shows how many of its calls failed, never that it failed itself.
  const childStates = callStatesByAgent(allTools);
  const childCalls = [...children].flatMap((id) =>
    [...(childStates.get(id)?.values() ?? [])].map((state) => ({
      status: activityDisplayStatus(
        {
          status: state.status,
          background: state.background || (state.own && background.has(id)),
        },
        replyStatus,
      ),
      count: state.count,
    })),
  );
  const running = statuses.includes('running') || childCalls.some((c) => c.status === 'running');
  const issue = issues.find((status) => statuses.includes(status));
  const childIssue = issue ? undefined : issues.find((s) => childCalls.some((c) => c.status === s));
  // Nouns avoid claiming success for failed, stopped, or unconfirmed operations.
  const tense = issue ? 2 : running ? 1 : 0;
  const descriptions = [...kinds].map(([kind, calls]) => {
    const [one, many, ...forms] = phrases[kind];
    const total = count(kind, calls);
    return forms[tense].replace('#', `${total} ${total === 1 ? one : many}`);
  });
  const text =
    descriptions.length > 2
      ? `${descriptions.slice(0, -1).join(', ')}, and ${descriptions.at(-1)}`
      : descriptions.join(' and ');
  return {
    label: text.charAt(0).toUpperCase() + text.slice(1),
    icon: [...kinds.keys()][0] ?? 'tool',
    running,
    issue,
    childIssue: childIssue && {
      status: childIssue,
      count: childCalls.reduce((sum, c) => sum + (c.status === childIssue ? c.count : 0), 0),
    },
  };
}

/** A running reply's group of calls: its summary of folded calls, then rows of their own. */
export type LiveGroupItem =
  | { kind: 'summary'; key: string; tools: ToolActivity[] }
  | { kind: 'call'; key: string; tool: ToolActivity }
  | { kind: 'more'; key: string; count: number };

/**
 * Calls a running reply has folded into their groups, the identity of each summary, and each
 * group's latest items with the calls they came from.
 */
export type LiveMemory = {
  folded: Set<string>;
  summaries: Map<string, string>;
  items: Map<string, { calls: string; items: LiveGroupItem[] }>;
};
export const liveMemory = (): LiveMemory => ({
  folded: new Set(),
  summaries: new Map(),
  items: new Map(),
});

/**
 * The items of a running reply's group of calls. Each running call keeps a row of its own, and
 * so does the latest call of the reply's last group until the agent starts another call or
 * moves on. A row the reader `opened` stays until they close it. Every other call folds into
 * the group's summary and stays there. The summary takes over the row of the first call it
 * folded, which turns into the summary in place.
 *
 * A group whose calls did not change gets its previous items back, so the page does not measure
 * its rows again for every update of the reply.
 */
export function liveGroupItems(
  groupKey: string,
  tools: ToolActivity[],
  last: boolean,
  replyStatus: Message['status'],
  memory: LiveMemory,
  opened: { has(id: string): boolean } = new Set(),
  limit = 6,
): LiveGroupItem[] {
  const calls = [
    `${replyStatus} ${last} ${limit}`,
    ...tools.map((tool) => `${tool.id} ${tool.revision} ${opened.has(tool.id)}`),
  ].join('\n');
  const previous = memory.items.get(groupKey);
  if (previous?.calls === calls) return previous.items;
  const running = (tool: ToolActivity) => toolDisplayStatus(tool, replyStatus) === 'running';
  const latest = tools.at(-1);
  const current = (tool: ToolActivity) =>
    !memory.folded.has(tool.id) &&
    ((last && tool === latest) || opened.has(tool.id));
  const folded = tools.filter(
    (tool) => memory.folded.has(tool.id) || (!running(tool) && !current(tool)),
  );
  for (const tool of folded) memory.folded.add(tool.id);
  let summary = memory.summaries.get(groupKey);
  if (!summary && folded.length) memory.summaries.set(groupKey, (summary = folded[0].id));
  // A folded call runs again when a later sub-agent joins its record; it gets a row as well,
  // which stays while the reader has it open.
  const rows = tools.filter((tool) => running(tool) || current(tool) || opened.has(tool.id));
  const items: LiveGroupItem[] = [];
  if (folded.length) items.push({ kind: 'summary', key: `call:${summary}`, tools: folded });
  if (rows.length > limit)
    items.push({ kind: 'more', key: `more:${groupKey}`, count: rows.length - limit });
  for (const tool of rows.slice(-limit))
    items.push({
      kind: 'call',
      key: `${tool.id === summary ? 'again' : 'call'}:${tool.id}`,
      tool,
    });
  memory.items.set(groupKey, { calls, items });
  return items;
}

/** What a live row says a call is doing or did: a verb for its state and what it acts on. */
export type LiveAction = {
  icon: ToolIconKey;
  verb: string;
  target?: string;
  /** The target is a command, path or pattern. */
  code?: boolean;
  /** The whole target, for hover. */
  hint?: string;
};
// Running, done, and unfinished forms. An unfinished call failed, stopped or has an unconfirmed
// outcome, and its form names it without claiming it happened.
type Forms = readonly [string, string, string];
const liveForms: Record<keyof typeof phrases, Forms> = {
  hook: ['Running', 'Ran', ''],
  hookContext: ['Receiving hook context', 'Received hook context', 'Hook context'],
  read: ['Reading', 'Read', 'Read of'],
  edit: ['Editing', 'Edited', 'Edit to'],
  files: ['Searching for', 'Searched for', 'Search for'],
  command: ['Running', 'Ran', 'Command'],
  search: ['Searching the web for', 'Searched the web for', 'Web search for'],
  browse: ['Opening', 'Opened', 'Web page'],
  agent: ['Working with', 'Worked with', 'Sub-agent'],
  background: ['Starting in the background', 'Started in the background', 'Background task'],
  backgroundAgent: [
    'Starting in the background',
    'Started in the background',
    'Background sub-agent',
  ],
  message: ['Messaging', 'Messaged', 'Message to'],
  directory: ['Listing agents', 'Listed agents', 'Agent list'],
  skill: ['Using skill', 'Used skill', 'Skill'],
  image: ['Viewing', 'Viewed', 'Image'],
  tool: ['Using', 'Used', ''],
};
const namedForms: Record<string, Forms> = {
  Write: ['Writing', 'Wrote', 'Write to'],
  'Find files': ['Finding files matching', 'Found files matching', 'File search for'],
  'List files': ['Listing', 'Listed', 'Listing of'],
  EnterPlanMode: ['Entering plan mode', 'Entered plan mode', 'Plan mode'],
  ExitPlanMode: ['Presenting the plan', 'Presented the plan', 'Plan'],
};
const iconForms: Partial<Record<ToolIconKey, Forms>> = {
  monitor: ['Watching', 'Watched', 'Watch'],
  plan: ['Updating the plan', 'Updated the plan', 'Plan update'],
  question: ['Waiting for your answer', 'Received your answer', 'Question'],
  chart: ['Drawing a visual', 'Drew a visual', 'Visual'],
  waitTasks: [
    'Waiting for background tasks',
    'Waited for background tasks',
    'Wait for background tasks',
  ],
  workflow: ['Running workflow', 'Ran workflow', 'Workflow'],
  toolSearch: ['Searching tools for', 'Searched tools for', 'Tool search for'],
};

/** A call's live row, from its reported metadata only. */
export function liveAction(
  tool: ToolActivity,
  status: ActivityDisplayStatus,
  options: { folder?: string; newFile?: boolean } = {},
): LiveAction {
  const visual = toolVisual(tool, options);
  const kind = action(tool);
  const forms =
    kind === 'background' || kind === 'backgroundAgent'
      ? liveForms[kind]
      : (namedForms[tool.name] ??
        (visual.icon === 'newFile' ? namedForms.Write : undefined) ??
        (kind === 'tool' || visual.icon === 'monitor' ? iconForms[visual.icon] : undefined) ??
        liveForms[kind]);
  const form =
    status === 'running' ? 0 : ['complete', 'background', 'left'].includes(status) ? 1 : 2;
  return {
    icon: visual.icon,
    verb: forms[form],
    ...liveTarget(tool, kind, visual, options.folder),
  };
}

function liveTarget(
  tool: ToolActivity,
  kind: keyof typeof phrases,
  visual: ToolVisual,
  folder?: string,
): Pick<LiveAction, 'target' | 'code' | 'hint'> {
  switch (kind) {
    case 'command':
    case 'background': {
      if (!tool.command) return { target: tool.detail };
      const { line, more } = primaryCommand(tool.command);
      return { target: line + (more ? ' …' : ''), code: true, hint: tool.command };
    }
    case 'read':
    case 'edit':
    case 'image':
      return { target: visual.detail, code: true, hint: visual.hint };
    case 'files':
      return tool.query
        ? { target: tool.query, code: true, hint: visual.hint }
        : { target: tool.path && relativeFilePath(tool.path, folder), code: true, hint: tool.path };
    case 'search':
      return { target: tool.query };
    case 'browse':
      return { target: visual.detail, hint: visual.detail };
    case 'agent':
    case 'backgroundAgent': {
      const running = tool.agents.filter((agent) => agent.status === 'running');
      return {
        target: (running.length ? running : tool.agents).map((agent) => agent.name).join(', '),
      };
    }
    case 'message':
      return { target: tool.detail };
    case 'skill':
      return { target: tool.name.startsWith('Skill: ') ? tool.name.slice(7) : undefined };
    case 'hook':
      return { target: tool.name };
    case 'hookContext':
      return { target: visual.detail, code: true };
    case 'tool': {
      const connected = connectedTool(tool);
      if (connected) return { target: connected.name, hint: connected.server };
      if (visual.icon === 'workflow') return { target: tool.detail };
      if (visual.icon === 'toolSearch') return { target: tool.query };
      return iconForms[visual.icon] || namedForms[tool.name] ? {} : { target: visual.title };
    }
    default:
      return {};
  }
}
