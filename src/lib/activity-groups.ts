import { visibleActivityStatus, type ToolActivity } from './activity';
import type { ContentBlock, Message } from './domain';
import { filePathKey } from './file-changes';
import type { ReasoningBlock } from './reasoning';

type CommentEntry = Omit<Extract<ContentBlock, { type: 'activity' }>, 'tool'> & {
  tool?: ToolActivity;
};
type ActivityEntry = CommentEntry | ReasoningBlock;
type ActivityGroup =
  | { kind: 'tools'; key: string; tools: ToolActivity[] }
  | { kind: 'comment'; key: string; entry: CommentEntry }
  | { kind: 'reasoning'; key: string; block: ReasoningBlock };

const lifecycleNotes = ['Starting the provider CLI', 'Connected to Claude'];
const toolNotes = /^(Using |Running command|Editing files|Searching the web|Using connected tool)/;

/** Reasoning, progress comments and tool calls in their recorded order. */
export function activityEntries(
  blocks: ContentBlock[],
  tools: ToolActivity[],
  finalText: string,
): ActivityEntry[] {
  const source: ActivityEntry[] = blocks.length
    ? blocks.filter((b) => b.type !== 'markdown')
    : tools.map((tool) => ({ type: 'activity' as const, text: tool.name, tool }));
  const reasoning = new Set<string>();
  return source.filter((b) => {
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
  });
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

// Use only reported operation/category/name metadata, never infer actions from output or paths.
function action(tool: ToolActivity): keyof typeof phrases {
  if (tool.id === 'activity-limit') return 'limit';
  if (tool.category === 'hook') return tool.operation === 'hookContext' ? 'hookContext' : 'hook';
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
  message: ['agent message', 'agent messages', 'sent #', 'sending #', '#'],
  directory: ['agent list', 'agent lists', 'checked #', 'checking #', '#'],
  skill: ['skill', 'skills', 'used #', 'using #', '#'],
  image: ['image', 'images', 'viewed #', 'viewing #', '#'],
  tool: ['tool', 'tools', 'used #', 'using #', '#'],
  // The activity limit notice stands for calls that were never recorded, so none can be counted.
  limit: ['', '', 'later calls not shown', 'later calls not shown', 'later calls not shown'],
} as const;

// A file counts once however often it was read or edited, and a resumed sub-agent counts once.
// Every other call counts once.
function count(kind: keyof typeof phrases, tools: ToolActivity[]) {
  if (kind === 'agent')
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

export function activityGroupSummary(
  tools: ToolActivity[],
  replyStatus: Message['status'],
  allTools: ToolActivity[] = tools,
) {
  const kinds = new Map<keyof typeof phrases, ToolActivity[]>();
  for (const tool of tools) {
    const kind = action(tool);
    kinds.set(kind, [...(kinds.get(kind) ?? []), tool]);
  }
  const children = new Set(tools.flatMap((tool) => tool.agents.map((agent) => agent.id)));
  const statuses = [
    ...tools,
    ...allTools.filter((tool) => tool.parentId && children.has(tool.parentId)),
  ]
    .flatMap((tool) => [tool.status, ...tool.agents.map((a) => a.status)])
    .map((status) => visibleActivityStatus(status, replyStatus));
  const running = statuses.includes('running');
  const issue = (['error', 'blocked', 'cancelled', 'unknown'] as const).find((status) =>
    statuses.includes(status),
  );
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
  };
}
