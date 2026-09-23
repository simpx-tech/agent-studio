<script lang="ts">
  import type { ProviderId } from '$lib/domain';
  import { creditReading, type UsageSnapshot } from '$lib/usage';
  let {
    provider,
    snapshot,
    loading = false,
    stale = false,
  }: {
    provider: ProviderId;
    snapshot?: UsageSnapshot;
    loading?: boolean;
    stale?: boolean;
  } = $props();
  const reading = $derived(creditReading(provider, snapshot));
</script>

{#if reading}
  <section class="credit-usage" aria-label="Credits">
    <div class="credit-heading">
      <span>Credits</span>{#if stale && snapshot}<small>Last reported</small>{/if}
    </div>
    <strong>{loading && !snapshot ? 'Checking…' : reading.value}</strong>
    <dl>
      {#each reading.rows as row}
        <div>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      {/each}
    </dl>
    <p>{reading.detail}</p>
  </section>
{/if}

<style>
  .credit-usage {
    min-width: 0;
    font-size: var(--text-xs);
  }
  .credit-heading,
  dl > div {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .credit-heading {
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 6px;
  }
  strong {
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 6px 28px;
    margin: 10px 0 0;
  }
  dt,
  p {
    color: var(--text-muted);
  }
  small {
    color: var(--warning);
  }
  dd {
    margin: 0;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 10px 0 0;
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
  }
</style>
