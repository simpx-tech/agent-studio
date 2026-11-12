<script lang="ts" module>
  /** The width of a bar's column, which holds its label, value and pace arrow on one line. */
  export const quotaColumn = 154;
  /** The gap between columns, as `.quota-bars` draws it. */
  const quotaGap = 12;
  /** The room bars in `columns` columns take. */
  export const quotaBarsWidth = (columns: number) =>
    Math.max(0, columns * quotaColumn + (columns - 1) * quotaGap);
</script>

<script lang="ts">
  import type { ProviderId } from '$lib/domain';
  import { clock } from '$lib/clock';
  import { quotaPace } from '$lib/pace';
  import {
    isStale,
    limitSlot,
    percentage,
    resetLabel,
    visibleLimits,
    type LimitSlot,
    type UsageSnapshot,
  } from '$lib/usage';
  import PaceIndicator from './PaceIndicator.svelte';

  // An account's 5-hour and weekly limits as the compact bars below the composer draw them,
  // for a list of accounts such as the Agent picker: only those its reading reports, waiting as
  // Checking… while its first reading loads, in the places its last reading here filled. They
  // sit in one row, each kind of limit in its column of the list (`columns`), so the accounts
  // line up.
  let {
    provider,
    snapshot,
    loading = false,
    failed = false,
    expected,
    columns,
  }: {
    provider: ProviderId;
    snapshot?: UsageSnapshot;
    loading?: boolean;
    /** No current reading can be had, so what is shown was only the last reported. */
    failed?: boolean;
    /** The kinds of limit the account's bars showed after its last reading on this device. */
    expected?: readonly LimitSlot[];
    /** The kinds of limit the list shows, in its columns' order; without them, the account's
     * own fill the row. */
    columns?: readonly LimitSlot[];
  } = $props();
  const limits = $derived.by(() => {
    const now = clock.now;
    // A reading that failed leaves none waiting while it is tried again.
    return visibleLimits(
      snapshot,
      { provider, model: '', reasoning: '', instructions: '' },
      loading && !failed,
      expected,
    ).map((window) => {
      const pace = quotaPace(window, snapshot, now, failed);
      const stale = !!snapshot && (failed || isStale(snapshot, window, now));
      return {
        ...window,
        slot: limitSlot(window),
        pace,
        // A limit without a share used only waits for the account's first reading.
        value: window.usedPercent == null ? 'Checking…' : `${percentage(window.usedPercent)} used`,
        title:
          window.usedPercent == null
            ? undefined
            : `${stale ? 'Last reported. ' : ''}${resetLabel(window.resetsAt, now)}. ${pace.label}.${pace.advice ? ` ${pace.advice}` : ''}`,
      };
    });
  });
  const slots = $derived(columns ?? limits.map((window) => window.slot));
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  // Without a limit to show it draws nothing, so the option keeps no room for one.
</script>

{#if limits.length}
  <span class="quota-bars" style:--columns={slots.length} style:--column={`${quotaColumn}px`}>
    {#each limits as window (window.id)}
      <span
        class="quota-bar"
        class:weekly={window.slot === 'weekly'}
        class:usage-warning={window.pace.tone === 'watch' || window.pace.tone === 'danger'}
        data-slot={window.slot}
        style:grid-column={slots.indexOf(window.slot) + 1 || undefined}
        title={window.title}
      >
        <span class="usage-bar-heading"
          ><span class="quota-label">{window.label}</span><span class="usage-bar-value"
            ><strong>{window.value}</strong>{#if window.pace.state !== 'unknown'}<PaceIndicator
                label={window.pace.label}
                tone={window.pace.tone}
                direction={window.pace.state === 'below'
                  ? 'down'
                  : window.pace.state === 'on-track'
                    ? 'right'
                    : 'up'}
                description={`${window.pace.detail} ${window.pace.advice}`}
              />{/if}</span
          ></span
        >
        <span
          class="usage-meter compact-meter"
          class:unmeasured={window.usedPercent == null}
          class:over-guide={window.pace.expectedPercent != null &&
            window.usedPercent != null &&
            window.usedPercent > window.pace.expectedPercent}
          aria-hidden="true"
        >
          {#if window.usedPercent != null}<i
              class={`quota-fill tone-${window.pace.tone}`}
              style:width={`${clamp(window.usedPercent)}%`}
            ></i>{/if}
          {#if window.pace.expectedPercent != null}<span
              class="recommended-fill"
              style:width={`${clamp(window.pace.expectedPercent)}%`}
            ></span>{/if}
        </span>
      </span>
    {/each}
  </span>
{/if}

<style>
  /* One row, never more: columns as wide as a bar's line needs, narrower only when the list
     itself is, where the label gives way first. */
  .quota-bars {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(0, var(--column)));
    gap: 12px;
    font-size: var(--text-xs);
    font-weight: 400;
  }
  .quota-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 5px;
    min-width: 0;
  }
  .quota-bar .usage-bar-heading {
    min-width: 0;
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .quota-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
  }
  .quota-bar .usage-bar-value {
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
  .quota-bar strong {
    color: var(--text-secondary);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .quota-bar.usage-warning strong {
    color: var(--warning);
  }
</style>
