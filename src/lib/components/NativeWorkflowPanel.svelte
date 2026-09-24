<script lang="ts">
  import { ChevronDown, Check, LoaderCircle, Circle } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import { formatReplyTime } from '$lib/replies';
  import { nativeWorkflowStatus, type NativeWorkflows } from '$lib/workflows';
  // One native workflow run's phases and agents, opened from its toggle in the reply footer.
  let { message, run }: { message: Message; run: NativeWorkflows['runs'][number] } = $props();
  const label = (status: string) => nativeWorkflowStatus(status, message.status);
</script>

<div class="native-workflow-panel">
  <div class="workflow-meta">
    <span>Native Claude workflow</span><span
      >{run.agents.filter((a) => a.status === 'complete').length}/{run.agents.length} agents complete</span
    >
    {#if run.tokens !== null}<span>{run.tokens.toLocaleString()} tokens</span>{/if}
    {#if run.durationMs !== null}<span>{formatReplyTime(run.durationMs)}</span>{/if}
  </div>
  {#if run.description}<p>{run.description}</p>{/if}
  {#each [...run.phases, ...(run.agents.some((a) => !run.phases.some((p) => p.index === a.phaseIndex)) ? [{ index: -1, title: 'Agents' }] : [])] as phase (phase.index)}
    <section aria-label={phase.title}>
      <h3>{phase.title}</h3>
      {#each run.agents.filter( (a) => (phase.index === -1 ? !run.phases.some((p) => p.index === a.phaseIndex) : a.phaseIndex === phase.index) ) as agent (agent.index)}
        <details class="workflow-agent">
          <summary>
            {#if label(agent.status) === 'Complete'}<Check
                size={14}
              />{:else if label(agent.status) === 'Running'}<LoaderCircle
                size={14}
                class="spinning"
              />{:else}<Circle size={14} />{/if}
            <strong>{agent.label || `Agent ${agent.index}`}</strong><span
              >{label(agent.status)}</span
            ><ChevronDown size={12} />
          </summary>
          <div class="agent-detail">
            <div class="workflow-meta">
              {#if agent.model}<span>{agent.model}</span>{/if}
              {#if agent.tokens !== null}<span>{agent.tokens.toLocaleString()} tokens</span>{/if}
              {#if agent.durationMs !== null}<span>{formatReplyTime(agent.durationMs)}</span>{/if}
            </div>
            {#if agent.result}<p class="agent-result">{agent.result}</p>{:else}<p class="muted">
                Claude has not reported a result preview for this agent.
              </p>{/if}
          </div>
        </details>
      {/each}
    </section>
  {/each}
  {#if !run.phases.length && !run.agents.length}<p class="muted">
      {message.status === 'running' && ['pending', 'running'].includes(run.status)
        ? 'Waiting for Claude’s phase and agent updates.'
        : 'Claude did not report phase or agent details.'}
    </p>{/if}
  {#if run.error}<p role="alert">{run.error}</p>{/if}
  {#if run.limited}<p class="muted">
      The display limit was reached. Claude may have additional phases or agents.
    </p>{/if}
  {#if run.scriptPath}<details class="script-location">
      <summary>Workflow script</summary><code>{run.scriptPath}</code>
      <p class="muted">
        Ask Claude to save this script as a project or personal workflow to run it again by name.
      </p>
    </details>{/if}
  {#if message.nativeWorkflows?.limited}<p class="muted">
      Only the first 16 native workflow runs are shown.
    </p>{/if}
</div>

<style>
  summary {
    display: flex;
    align-items: center;
    gap: 9px;
    cursor: pointer;
    font-size: var(--text-sm);
    list-style: none;
    transition: background-color var(--duration-fast) ease;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    background: var(--hover);
  }
  summary > :global(svg:last-child) {
    color: var(--text-faint);
  }
  summary strong {
    flex: 1;
    min-width: 0;
    font-weight: 600;
  }
  summary > span {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .workflow-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  p {
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
  }
  h3 {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    margin: 16px 0 4px;
  }
  .workflow-agent > summary {
    padding: 6px 8px;
    margin: 0 -8px;
    border-radius: var(--radius-md);
  }
  .workflow-agent > summary > :global(svg:first-child) {
    color: var(--text-muted);
  }
  .agent-detail {
    padding: 6px 22px;
  }
  .agent-result {
    white-space: pre-wrap;
  }
  .script-location {
    margin-top: 12px;
  }
  .script-location summary {
    padding: 4px 0;
    color: var(--text-muted);
  }
  code {
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
</style>
