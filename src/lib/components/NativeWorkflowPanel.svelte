<script lang="ts">
  import { GitBranch, ChevronDown, Check, LoaderCircle, Circle } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  let { message, compact = false }: { message: Message; compact?: boolean } = $props();
  function label(status: string) {
    if (['running', 'pending', 'paused'].includes(status) && message.status !== 'running')
      return message.status === 'cancelled' ? 'Stopped' : 'Unconfirmed';
    return (
      (
        {
          pending: 'Pending',
          running: 'Running',
          paused: 'Paused',
          complete: 'Complete',
          error: 'Failed',
          cancelled: 'Stopped',
          unknown: 'Unknown',
        } as Record<string, string>
      )[status] ?? 'Unknown'
    );
  }
</script>

{#each message.nativeWorkflows?.runs ?? [] as run (run.id)}
  <details class="native-workflow-panel" class:compact open={message.status === 'running'}>
    <summary
      ><GitBranch size={16} /><strong>{run.name || 'Claude workflow'}</strong><span
        >{label(run.status)}</span
      ><ChevronDown size={14} /></summary
    >
    <div class="workflow-body">
      <div class="workflow-meta">
        <span>Native Claude workflow</span><span
          >{run.agents.filter((a) => a.status === 'complete').length}/{run.agents.length} agents complete</span
        >
        {#if run.tokens !== null}<span>{run.tokens.toLocaleString()} tokens</span>{/if}
        {#if run.durationMs !== null}<span>{(run.durationMs / 1000).toFixed(1)}s</span>{/if}
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
                  {#if agent.tokens !== null}<span>{agent.tokens.toLocaleString()} tokens</span
                    >{/if}
                  {#if agent.durationMs !== null}<span>{(agent.durationMs / 1000).toFixed(1)}s</span
                    >{/if}
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
            Ask Claude to save this script as a project or personal workflow to run it again by
            name.
          </p>
        </details>{/if}
    </div>
  </details>
{/each}
{#if message.nativeWorkflows?.limited}<p class="muted">
    Only the first 16 native workflow runs are shown.
  </p>{/if}

<style>
  .native-workflow-panel {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    margin: 10px 0;
    overflow: hidden;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px;
    cursor: pointer;
    font-size: 12px;
    list-style: none;
  }
  summary strong {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  summary > span {
    color: var(--muted);
    font-size: 11px;
  }
  .workflow-body {
    padding: 0 14px 12px;
    max-height: 300px;
    overflow: auto;
  }
  .workflow-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    font-size: 11px;
    color: var(--muted);
  }
  p {
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  h3 {
    font-size: 12px;
    margin: 16px 0 6px;
  }
  .workflow-agent > summary {
    padding: 8px 0;
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
    color: var(--muted);
  }
  code {
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .compact {
    margin: 0 0 10px;
  }
  @media (max-width: 600px) {
    .workflow-body {
      max-height: 200px;
    }
    summary {
      padding: 10px;
    }
  }
</style>
