<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    CircleStop,
    CircleX,
    Hourglass,
    LoaderCircle,
    MessageCircleQuestionMark,
    MessageSquare,
  } from '@lucide/svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import type { CardData, CardStatus } from '$lib/workflow-view';
  let {
    data,
    selected = false,
  }: {
    data: CardData & { openChat?: (conversationId: string) => void; editable?: boolean };
    selected?: boolean;
  } = $props();
  // Steps flow downwards: what follows a step leaves from the bottom of its card, in its ports'
  // order, and its error port leaves from its side, shown once a connection leaves it, or while
  // the step is being edited.
  const outputs = $derived(data.ports.filter((p) => p.id !== 'error'));
  const failure = $derived(data.ports.some((p) => p.id === 'error'));
  const failureUsed = $derived(!!data.connected?.includes('error'));
  const labelled = $derived(outputs.some((p) => p.label));
</script>

{#snippet mark(status: CardStatus, size = 14)}
  {#if status === 'running'}<LoaderCircle {size} class="spinning" aria-hidden="true" />
  {:else if status === 'attention'}<MessageCircleQuestionMark {size} aria-hidden="true" />
  {:else if status === 'waiting' || status === 'queued'}<Hourglass {size} aria-hidden="true" />
  {:else if status === 'done'}<CircleCheck {size} aria-hidden="true" />
  {:else if status === 'failed'}<CircleX {size} aria-hidden="true" />
  {:else if status === 'stopped'}<CircleStop {size} aria-hidden="true" />
  {:else if status === 'planned'}<CircleDashed {size} aria-hidden="true" />{/if}
{/snippet}

<div
  class="workflow-card status-{data.status} kind-{data.kind}"
  class:selected
  class:editable={data.editable}
  class:issue={!!data.issue}
  title={data.issue ?? data.statusText}
>
  {#if data.input}<Handle type="target" position={Position.Top} class="workflow-handle" />{/if}
  <header>
    <span class="card-icon type-{data.type}"
      ><WorkflowIcon type={data.icon ?? data.type} size={14} /></span
    >
    <span class="card-title">{data.title}</span>
    {#if data.count}<span class="card-count">{data.count}</span>{/if}
    <span class="card-status" aria-label={data.statusText || undefined}
      >{@render mark(data.status)}</span
    >
  </header>
  {#if data.issue}<p class="card-issue"><CircleAlert size={12} aria-hidden="true" />{data.issue}</p>
  {:else if data.subtitle}<p class="card-subtitle">{data.subtitle}</p>{/if}
  {#if data.rows.length}
    <ul class="card-rows">
      {#each data.rows as row (row.id)}
        <li class="status-{row.status}">
          <span class="row-mark">{@render mark(row.status, 12)}</span>
          <span class="row-text"
            ><span class="row-label">{row.label}</span>{#if row.detail}<span class="row-detail"
                >{row.detail}</span
              >{/if}</span
          >
          {#if row.conversationId && data.openChat}<button
              class="row-open nodrag"
              type="button"
              title="Open chat"
              aria-label={`Open the chat of ${row.label}`}
              onclick={(event) => {
                event.stopPropagation();
                data.openChat?.(row.conversationId!);
              }}><MessageSquare size={13} /></button
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if data.conversationId && data.openChat && !data.rows.length}<button
      class="card-open nodrag"
      type="button"
      onclick={(event) => {
        event.stopPropagation();
        data.openChat?.(data.conversationId!);
      }}><MessageSquare size={13} aria-hidden="true" />Open chat</button
    >{/if}
  {#each outputs as port, index (port.id)}
    <Handle
      type="source"
      position={Position.Bottom}
      id={port.id}
      class="workflow-handle port-{port.id}"
      style={outputs.length > 1
        ? `left: ${((index + 1) / (outputs.length + 1)) * 100}%`
        : undefined}
    >
      {#if labelled && port.label}<span class="port-label">{port.label}</span>{/if}
    </Handle>
  {/each}
  {#if failure}<Handle
      type="source"
      position={Position.Right}
      id="error"
      class={`workflow-handle port-error${failureUsed ? '' : ' unused'}`}
      ><span class="port-label">Error</span></Handle
    >{/if}
</div>

<style>
  .workflow-card {
    position: relative;
    width: 248px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    color: var(--text);
    font-size: var(--text-sm);
    box-shadow: var(--shadow-sm);
    transition:
      border-color var(--duration-fast),
      box-shadow var(--duration-fast);
  }
  .workflow-card:hover {
    border-color: var(--border-hover);
  }
  .workflow-card.selected {
    border-color: var(--accent-border);
    box-shadow:
      0 0 0 1px var(--accent-border),
      var(--shadow-md);
  }
  .workflow-card.status-running {
    border-color: var(--accent-border);
  }
  .workflow-card.status-attention {
    border-color: var(--warning-border);
  }
  .workflow-card.status-failed,
  .workflow-card.issue {
    border-color: var(--danger-border);
  }
  .workflow-card.kind-orchestrator {
    background: color-mix(in srgb, var(--accent-soft) 40%, var(--surface-1));
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .card-icon {
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-secondary);
  }
  .card-icon.type-start,
  .card-icon.type-orchestrator {
    color: var(--accent-text);
    background: var(--accent-soft);
  }
  .card-icon.type-agent,
  .card-icon.type-screen,
  .card-icon.type-task {
    color: var(--info);
    background: var(--info-soft);
  }
  .card-icon.type-ask,
  .card-icon.type-confirm,
  .card-icon.type-notify {
    color: var(--warning);
    background: var(--warning-soft);
  }
  .card-title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-count {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .card-status {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .status-running > header .card-status,
  li.status-running .row-mark {
    color: var(--accent-text);
  }
  .status-attention > header .card-status,
  li.status-attention .row-mark {
    color: var(--warning);
  }
  .status-done > header .card-status,
  li.status-done .row-mark {
    color: var(--success);
  }
  .status-failed > header .card-status,
  li.status-failed .row-mark {
    color: var(--danger);
  }
  .card-subtitle,
  .card-issue {
    margin: 6px 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .card-issue {
    display: flex;
    gap: 5px;
    color: var(--danger);
  }
  .card-issue :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }
  .card-rows {
    list-style: none;
    margin: 8px 0 0;
    padding: 6px 0 0;
    border-top: 1px solid var(--border);
    display: grid;
    gap: 4px;
  }
  .card-rows li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: 26px;
  }
  .row-mark {
    display: inline-flex;
    flex-shrink: 0;
    width: 12px;
    color: var(--text-muted);
  }
  .row-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .row-label,
  .row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-label {
    font-size: var(--text-xs);
  }
  .row-detail {
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .row-open,
  .card-open {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .row-open {
    width: 24px;
    height: 24px;
    justify-content: center;
  }
  .card-open {
    margin-top: 8px;
    padding: 3px 6px;
    font-size: var(--text-xs);
  }
  .row-open:hover,
  .card-open:hover {
    background: var(--hover);
    color: var(--text);
  }
  :global(.workflow-handle) {
    width: 10px !important;
    height: 10px !important;
    border: 2px solid var(--surface-1) !important;
    background: var(--border-strong) !important;
  }
  :global(.workflow-handle.port-error) {
    background: var(--danger) !important;
  }
  :global(.workflow-handle.port-error.unused) {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-fast);
  }
  .workflow-card.editable:hover :global(.workflow-handle.port-error.unused),
  .workflow-card.editable.selected :global(.workflow-handle.port-error.unused) {
    opacity: 1;
    pointer-events: auto;
  }
  :global(.workflow-handle.port-true),
  :global(.workflow-handle.port-each) {
    background: var(--accent-strong) !important;
  }
  .port-label {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    padding: 0 4px;
    border-radius: var(--radius-xs);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    white-space: nowrap;
    pointer-events: none;
  }
  :global(.workflow-handle.port-error) .port-label {
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--danger);
  }
</style>
