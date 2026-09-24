<script lang="ts">
  import { ChevronDown, Layers, LoaderCircle } from '@lucide/svelte';
  import { toolElapsed } from '$lib/activity';
  import type { BackgroundRun } from '$lib/background-work';
  import { revealedDisclosures } from '$lib/disclosures';
  let { runs }: { runs: BackgroundRun[] } = $props();
  const kinds = { command: 'Command', monitor: 'Monitor', agent: 'Sub-agent' };
  // A one-line summary in its reply; the list renders when first expanded.
  const disclosures = revealedDisclosures();
  let open = $state(false);
  let now = $state(Date.now());
  // Host lists arrive when work starts or ends; advance their times in between.
  $effect(() => {
    if (!open || !runs.some((run) => run.since != null)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = (run: BackgroundRun) =>
    run.elapsedMs == null
      ? undefined
      : run.elapsedMs + (run.since == null ? 0 : Math.max(0, now - run.since));
</script>

{#if runs.length}
  <details class="background-work" bind:open ontoggle={disclosures.opened('runs')}>
    <summary onclick={disclosures.reveal('runs')}
      ><Layers size={16} aria-hidden="true" /><strong>Background work</strong><span
        >{runs.length} running</span
      ><ChevronDown size={14} aria-hidden="true" /></summary
    >
    {#if disclosures.has('runs')}
      <ul aria-label="Running in the background">
        {#each runs as run (run.id)}
          {@const time = elapsed(run)}
          <li>
            <LoaderCircle size={14} class="spinning" aria-hidden="true" />
            <span class="run-label" title={run.label}>{run.label}</span>
            <small
              >{kinds[run.kind]}{#if time != null}<span
                  title="Elapsed time recorded on the execution computer">{toolElapsed(time)}</span
                >{/if}</small
            >
          </li>
        {/each}
      </ul>
    {/if}
  </details>
{/if}

<style>
  .background-work {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    margin: 0;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
