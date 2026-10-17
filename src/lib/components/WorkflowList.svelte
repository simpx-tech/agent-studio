<script lang="ts">
  import {
    CircleCheck,
    CirclePause,
    CircleStop,
    CircleX,
    LoaderCircle,
    MessageCircleQuestionMark,
    Target,
    Workflow,
  } from '@lucide/svelte';
  import type { WorkflowClient } from '$lib/workflow-client.svelte';
  import { triggerLabels, type TriggerKind, type WorkflowSummary } from '$lib/workflow-model';
  import { scheduleLabel } from '$lib/workflow-schedule';
  let {
    client,
    query,
    selected,
    open,
  }: {
    client: WorkflowClient;
    query: string;
    selected?: string;
    open: (id: string) => void;
  } = $props();
  const matches = (summary: WorkflowSummary) =>
    !query.trim() || summary.title.toLowerCase().includes(query.trim().toLowerCase());
  const all = $derived([...client.summaries.values()].filter(matches));
  const runs = $derived(all.filter((s) => s.kind === 'run'));
  const active = $derived(
    runs
      .filter((s) => s.status === 'running' || s.status === 'paused')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
  const finished = $derived(
    runs
      .filter((s) => s.status !== 'running' && s.status !== 'paused')
      .sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt)),
  );
  const definitions = $derived(
    all.filter((s) => s.kind === 'definition').sort((a, b) => a.title.localeCompare(b.title)),
  );
  const statusNames: Record<string, string> = {
    running: 'Running',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
  };
  const when = (at?: string) => {
    if (!at) return '';
    const date = new Date(at);
    return new Date().toDateString() === date.toDateString()
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
</script>

{#snippet row(summary: WorkflowSummary, detail: string)}
  <button
    class="workflow-row"
    class:current={summary.id === selected}
    aria-current={summary.id === selected ? 'page' : undefined}
    title={summary.title}
    onclick={() => open(summary.id)}
  >
    <span class="row-icon">
      {#if summary.kind === 'definition'}<Workflow size={14} aria-hidden="true" />
      {:else if summary.questions}<MessageCircleQuestionMark
          size={14}
          class="attention"
          aria-hidden="true"
        />
      {:else if summary.status === 'running'}<LoaderCircle
          size={14}
          class="spinning live"
          aria-hidden="true"
        />
      {:else if summary.status === 'paused'}<CirclePause size={14} aria-hidden="true" />
      {:else if summary.status === 'completed'}<CircleCheck
          size={14}
          class="done"
          aria-hidden="true"
        />
      {:else if summary.status === 'failed'}<CircleX size={14} class="failed" aria-hidden="true" />
      {:else}<CircleStop size={14} aria-hidden="true" />{/if}
    </span>
    <span class="row-text">
      <span class="row-title"
        >{#if summary.mode === 'dynamic'}<Target
            size={11}
            aria-label="Mission"
          />{/if}{summary.title}</span
      >
      {#if detail}<span class="row-detail">{detail}</span>{/if}
    </span>
  </button>
{/snippet}

<div class="workflow-list">
  {#if client.mode === 'unavailable'}
    <p class="workflow-empty">Update the relay to use workflows here.</p>
  {:else}
    {#if active.length}
      <h2>In progress</h2>
      {#each active as summary (summary.id)}{@render row(
          summary,
          summary.questions
            ? `Waiting for you${summary.detail && summary.detail !== 'Waiting for your answer' ? ` · ${summary.detail}` : ''}`
            : summary.detail || statusNames[summary.status ?? ''] || '',
        )}{/each}
    {/if}
    <h2>Workflows</h2>
    {#each definitions as summary (summary.id)}{@render row(
        summary,
        [
          `${summary.steps} step${summary.steps === 1 ? '' : 's'}`,
          ...summary.schedules.map((s) => scheduleLabel(s as never)),
          ...summary.triggers.map((t) => triggerLabels[t.kind as TriggerKind] ?? t.kind),
        ].join(' · '),
      )}{:else}<p class="workflow-empty">No workflows.</p>{/each}
    {#if finished.length}
      <h2>Finished</h2>
      {#each finished as summary (summary.id)}{@render row(
          summary,
          `${statusNames[summary.status ?? ''] ?? ''} · ${when(summary.endedAt ?? summary.updatedAt)}`,
        )}{/each}
    {/if}
  {/if}
</div>

<style>
  .workflow-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px 12px;
  }
  h2 {
    margin: 10px 8px 4px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .workflow-row {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 9px;
    width: 100%;
    min-height: 40px;
    padding: 5px 8px;
    border-radius: var(--radius-md);
    text-align: left;
    color: var(--text-secondary);
  }
  .workflow-row:hover {
    background: var(--hover);
  }
  .workflow-row.current {
    background: var(--selected);
    color: var(--text);
  }
  .workflow-row.current::before {
    content: '';
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 2px;
    background: var(--accent-strong);
  }
  .row-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .row-icon :global(.live) {
    color: var(--accent-text);
  }
  .row-icon :global(.attention) {
    color: var(--warning);
  }
  .row-icon :global(.done) {
    color: var(--success);
  }
  .row-icon :global(.failed) {
    color: var(--danger);
  }
  .row-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row-title,
  .row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-title {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
  }
  .row-detail {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .workflow-empty {
    margin: 4px 8px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
