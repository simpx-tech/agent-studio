<script lang="ts">
  import { ChevronDown, Layers, LoaderCircle } from '@lucide/svelte';
  import { toolElapsed } from '$lib/activity';
  import { runningBackgroundWork } from '$lib/background-work';
  import type { Message } from '$lib/domain';
  let { message }: { message: Message } = $props();
  const runs = $derived(
    message.status === 'running'
      ? runningBackgroundWork(
          message.blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : [])),
        )
      : [],
  );
  const kinds = { command: 'Command', monitor: 'Monitor', agent: 'Sub-agent' };
</script>

{#if runs.length}
  <details class="background-work" open>
    <summary
      ><Layers size={16} aria-hidden="true" /><strong>Background work</strong><span
        >{runs.length} running</span
      ><ChevronDown size={14} aria-hidden="true" /></summary
    >
    <ul aria-label="Running in the background">
      {#each runs as run (run.id)}
        <li>
          <LoaderCircle size={14} class="spinning" aria-hidden="true" />
          <span class="run-label" title={run.label}>{run.label}</span>
          <small
            >{kinds[run.kind]}{#if run.elapsedMs != null}<span
                title="Elapsed time recorded on the execution computer"
                >{toolElapsed(run.elapsedMs)}</span
              >{/if}</small
          >
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .background-work {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    margin: 0 0 10px;
    overflow: hidden;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 40px;
    padding: 9px 12px;
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
  summary > :global(svg:first-child) {
    color: var(--accent-strong);
  }
  summary > :global(svg:last-child) {
    color: var(--text-faint);
    transition: transform var(--duration) var(--ease-out);
  }
  details[open] > summary > :global(svg:last-child) {
    transform: rotate(180deg);
  }
  summary strong {
    flex: 1;
    min-width: 0;
    font-weight: 600;
  }
  summary > span {
    color: var(--text-muted);
    white-space: nowrap;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  ul {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 4px 12px 12px;
    max-height: 180px;
    overflow: auto;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  li > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  .run-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    display: inline-flex;
    gap: 6px;
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  small > span::before {
    content: '·';
    margin-right: 6px;
  }
  @media (max-width: 600px) {
    summary {
      padding: 9px 10px;
    }
    ul {
      max-height: 120px;
      padding: 4px 10px 10px;
    }
  }
</style>
