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
    font-size: 11px;
  }
  .credit-heading,
  dl > div {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .credit-heading {
    color: var(--muted);
    margin-bottom: 8px;
  }
  strong {
    font-size: 14px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 6px 28px;
    margin: 12px 0 0;
  }
  dt,
  p,
  small {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  p {
    margin: 10px 0 0;
    font-size: 10px;
    line-height: 1.6;
  }
</style>
