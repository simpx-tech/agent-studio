<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
  import { toolElapsed } from '$lib/activity';
  import type { BackgroundRun } from '$lib/background-work';
  // A reply's running background work, opened from the Background work toggle in its footer.
  let { runs, live = true }: { runs: BackgroundRun[]; live?: boolean } = $props();
  const kinds = { command: 'Command', monitor: 'Monitor', agent: 'Sub-agent' };
  let now = $state(Date.now());
  // Host lists arrive when work starts or ends; advance their times in between while shown.
  $effect(() => {
    if (!live || !runs.some((run) => run.since != null)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = (run: BackgroundRun) =>
    run.elapsedMs == null
      ? undefined
      : run.elapsedMs + (run.since == null ? 0 : Math.max(0, now - run.since));
</script>

<ul class="background-work" aria-label="Running in the background">
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

<style>
  ul {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
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
</style>
