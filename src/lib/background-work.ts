import type { ToolActivity } from './activity';

export type BackgroundRun = {
  id: string;
  kind: 'command' | 'monitor' | 'agent';
  label: string;
  elapsedMs?: number;
};

/**
 * Work the CLI moved to the background that still runs, in launch order: shell commands,
 * Monitor watches and sub-agents whose launch returned to the model while they kept going.
 * Only reported descriptions label them; commands themselves stay private.
 */
export function runningBackgroundWork(tools: ToolActivity[]): BackgroundRun[] {
  const runs: BackgroundRun[] = [];
  for (const tool of tools) {
    for (const agent of tool.agents)
      if (agent.background && agent.status === 'running')
        runs.push({ id: agent.id, kind: 'agent', label: agent.name });
    if (!tool.background || tool.status !== 'running') continue;
    const monitor = tool.operation === 'monitor';
    runs.push({
      id: tool.id,
      kind: monitor ? 'monitor' : 'command',
      label: tool.detail || (monitor ? 'Monitor' : 'Background command'),
      elapsedMs: tool.elapsedMs,
    });
  }
  return runs;
}
