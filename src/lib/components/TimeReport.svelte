<script lang="ts">
  import { ChartNoAxesGantt } from '@lucide/svelte';
  import { formatReplyTime } from '$lib/replies';
  import {
    hasTimeDetails,
    requestsText,
    timeKindHints,
    timeShare,
    type TimeReport,
  } from '$lib/time-report';
  import TimeMakeup from './TimeMakeup.svelte';
  let {
    report,
    open,
  }: {
    /** Where this reply's time went. */
    report: TimeReport;
    /** Opens the full report on this reply, with the whole chat's a tab away. */
    open?: () => void;
  } = $props();
  const total = $derived(
    [formatReplyTime(report.ms), report.requests ? requestsText(report) : '']
      .filter(Boolean)
      .join(' · '),
  );
</script>

<!-- What the reply waited on at a glance; steps, sub-agents and calls are in the full report. -->
<div class="time-report">
  <div class="report-toolbar">
    <span class="report-total">{total}</span>
    {#if open}<button type="button" class="report-open" onclick={open}
        ><ChartNoAxesGantt size={13} aria-hidden="true" />Open report</button
      >{/if}
  </div>
  <div class="report-body">
    {#if !hasTimeDetails(report)}<p class="empty">Not recorded for this response.</p>{/if}
    {#if report.parts.length}
      <ul class="parts" aria-label="Time by what the agent waited on">
        {#each report.parts as part (part.kind)}
          <li title={timeKindHints[part.kind]}>
            <span class="part-name">{part.name}</span>
            <TimeMakeup
              makeup={[{ family: part.family, name: part.name, ms: part.ms, share: 1 }]}
              scale={part.share}
            />
            <span class="part-time">{formatReplyTime(part.ms)}</span>
            <span class="part-share">{timeShare(part.share)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  /* As wide as the reply, like the footer's other panels, so their edges line up. */
  .time-report {
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    overflow: hidden;
  }
  .report-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 6px 8px 6px 12px;
    border-bottom: 1px solid var(--border);
  }
  .report-total {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .report-open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .report-open:hover {
    border-color: var(--border-hover);
  }
  .report-body {
    padding: 10px 12px 12px;
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  /* One grid for every row, so names, bars and numbers line up. */
  .parts {
    display: grid;
    grid-template-columns: auto minmax(32px, 1fr) auto auto;
    gap: 6px 12px;
    align-items: center;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .parts li {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
  }
  .part-name {
    color: var(--text);
  }
  .part-time,
  .part-share {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
  }
  .part-time {
    color: var(--text);
  }
  .part-share {
    min-width: 2.6em;
    color: var(--text-muted);
  }
</style>
