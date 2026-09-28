<script lang="ts">
  import { Clock3 } from '@lucide/svelte';
  import { clock } from '$lib/clock';

  let { createdAt }: { createdAt: string } = $props();
  const started = $derived(Date.parse(createdAt));
  // The sidebar row of this chat counts from the same clock, so both show the same second.
  const elapsed = $derived(Math.max(0, Math.floor((clock.now - started) / 1000)));
  const hours = $derived(Math.floor(elapsed / 3600));
  const minutes = $derived(Math.floor((elapsed % 3600) / 60));
  const seconds = $derived(elapsed % 60);
</script>

<div
  class="running-reply-time"
  role="timer"
  aria-label="Current reply elapsed time"
  aria-live="off"
>
  <Clock3 size={13} aria-hidden="true" />
  <span>
    {#if Number.isFinite(started)}
      {hours ? `${hours}h ` : ''}{hours || minutes ? `${minutes}m ` : ''}{seconds}s elapsed
    {:else}
      Elapsed time unavailable
    {/if}
  </span>
</div>

<style>
  /* The first item of a running reply's footer row, aligned with its toggles. */
  .running-reply-time {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    padding: 3px 8px 3px 6px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
