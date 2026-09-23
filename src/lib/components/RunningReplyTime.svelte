<script lang="ts">
  import { Clock3 } from '@lucide/svelte';

  let { createdAt }: { createdAt: string } = $props();
  let now = $state(Date.now());
  const started = $derived(Date.parse(createdAt));
  const elapsed = $derived(Math.max(0, Math.floor((now - started) / 1000)));
  const hours = $derived(Math.floor(elapsed / 3600));
  const minutes = $derived(Math.floor((elapsed % 3600) / 60));
  const seconds = $derived(elapsed % 60);

  $effect(() => {
    if (!Number.isFinite(started)) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
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
  .running-reply-time {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 12px;
    padding: 4px 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
