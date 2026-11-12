<script lang="ts">
  import type { ProviderId } from '$lib/domain';
  import { clock } from '$lib/clock';
  import { poolUsage, type PoolLimit, type PoolReading } from '$lib/account-balance';
  import { percentage } from '$lib/usage';
  import PaceIndicator from './PaceIndicator.svelte';

  // What the accounts balanced on a computer used together, drawn as the bars below the composer
  // draw one account's: each limit they report, the average share used against the average of
  // their even-use guides, with its pace.
  let {
    provider,
    readings,
    columns = false,
  }: {
    provider: ProviderId;
    readings: PoolReading[];
    /** Lays the limits side by side, as Connections lays out each account's, while they fit. */
    columns?: boolean;
  } = $props();
  const limits = $derived(poolUsage(provider, readings, clock.now));
  const accounts = (limit: PoolLimit) =>
    limit.unread
      ? `${limit.counted} of ${limit.counted + limit.unread} accounts`
      : `${limit.counted} ${limit.counted === 1 ? 'account' : 'accounts'}`;
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
</script>

{#if limits.length}
  <div class="pool-usage" class:columns>
    <div class="pool-limits">
      {#each limits as limit (limit.id)}
        <div
          class="pool-limit"
          class:usage-warning={limit.pace.tone === 'watch' || limit.pace.tone === 'danger'}
          title={limit.usedPercent == null || limit.expectedPercent == null
            ? undefined
            : `Average of ${accounts(limit)}: ${percentage(limit.usedPercent)} used, recommended ${percentage(limit.expectedPercent)}. ${limit.pace.label}.`}
        >
          <span class="usage-bar-heading"
            ><span class="pool-label">{limit.label}</span><span class="usage-bar-value"
              ><strong
                >{limit.usedPercent == null
                  ? 'Checking…'
                  : `${percentage(limit.usedPercent)} used`}</strong
              >{#if limit.pace.state !== 'unknown'}<PaceIndicator
                  label={limit.pace.label}
                  tone={limit.pace.tone}
                  direction={limit.pace.state === 'below'
                    ? 'down'
                    : limit.pace.state === 'on-track'
                      ? 'right'
                      : 'up'}
                  description={`${limit.pace.detail} ${limit.pace.advice}`}
                />{/if}</span
            ></span
          >
          <span
            class="usage-meter compact-meter"
            class:unmeasured={limit.usedPercent == null}
            class:over-guide={limit.expectedPercent != null &&
              limit.usedPercent != null &&
              limit.usedPercent > limit.expectedPercent}
            role="progressbar"
            aria-label={`${limit.label} limit used`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={limit.usedPercent == null ? undefined : clamp(limit.usedPercent)}
            aria-valuetext={limit.usedPercent == null || limit.expectedPercent == null
              ? 'Checking usage'
              : `${percentage(limit.usedPercent)} used, recommended ${percentage(limit.expectedPercent)}, average of ${accounts(limit)}`}
          >
            {#if limit.usedPercent != null}<i
                class={`quota-fill tone-${limit.pace.tone}`}
                style:width={`${clamp(limit.usedPercent)}%`}
              ></i>{/if}
            {#if limit.expectedPercent != null}<span
                class="recommended-fill"
                style:width={`${clamp(limit.expectedPercent)}%`}
              ></span>{/if}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .pool-usage {
    justify-self: stretch;
    min-width: 0;
    font-size: var(--text-xs);
  }
  .pool-usage:not(.columns) {
    padding-bottom: 11px;
    border-bottom: 1px solid var(--border);
  }
  .pool-limits {
    display: grid;
    gap: 10px;
  }
  /* Side by side, two to a row, as Connections shows each account's limits below. */
  .columns {
    container-type: inline-size;
  }
  .columns .pool-limits {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px 28px;
  }
  @container (max-width: 450px) {
    .columns .pool-limits {
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
  }
  .columns .pool-limit {
    gap: 8px;
  }
  .columns .pool-label {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .columns .pool-limit strong {
    color: var(--text);
    font-size: var(--text-sm);
  }
  .pool-limit {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .pool-limit .usage-bar-heading {
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .pool-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
  }
  .pool-limit .usage-bar-value {
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
  .pool-limit strong {
    color: var(--text-secondary);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .pool-limit.usage-warning strong {
    color: var(--warning);
  }
</style>
