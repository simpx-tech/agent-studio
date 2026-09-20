import { visibleActivityStatus, type ToolActivity } from './activity';
import type { ContentBlock, Message } from './domain';

type ActivityEntry = Omit<Extract<ContentBlock, { type: 'activity' }>, 'tool'> & {
  tool?: ToolActivity;
};
type ActivityGroup =
  | { kind: 'tools'; key: string; tools: ToolActivity[] }
  | { kind: 'comment'; key: string; entry: ActivityEntry };

/** Consecutive tool calls share a group; comments remain chronological boundaries. */
export function groupActivityEntries(entries: ActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.tool) {
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
  if (['sendMessage', 'listAgents'].includes(tool.operation ?? '')) return 'agent';
  if (tool.category === 'skill') return 'skill';
  if (['View image', 'view_image'].includes(tool.name)) return 'image';
  return 'tool';
}

const phrases = {
  hook: ['ran hooks', 'running hooks', 'hooks'],
  hookContext: ['received hook context', 'receiving hook context', 'hook context'],
  read: ['read files', 'reading files', 'file reads'],
  edit: ['edited files', 'editing files', 'file edits'],
  files: ['searched files', 'searching files', 'file searches'],
  command: ['ran commands', 'running commands', 'commands'],
  search: ['searched the web', 'searching the web', 'web searches'],
  browse: ['opened web pages', 'opening web pages', 'web pages'],
  agent: ['worked with sub-agents', 'working with sub-agents', 'sub-agent work'],
  skill: ['used skills', 'using skills', 'skill calls'],
  image: ['viewed images', 'viewing images', 'image views'],
  tool: ['used tools', 'using tools', 'tool calls'],
};

export function activityGroupSummary(
  tools: ToolActivity[],
  replyStatus: Message['status'],
  allTools: ToolActivity[] = tools,
) {
  const actions = [...new Set(tools.map(action))];
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
  const descriptions = actions.map((kind) => phrases[kind][tense]);
  const text =
    descriptions.length > 2
      ? `${descriptions.slice(0, 2).join(', ')}, and more`
      : descriptions.join(' and ');
  return {
    label: text.charAt(0).toUpperCase() + text.slice(1),
    icon: actions[0] ?? 'tool',
    running,
    issue,
  };
}
