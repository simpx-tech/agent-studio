<script lang="ts">
  import { Check, Copy } from '@lucide/svelte';
  import { recall } from '$lib/chat-recall';
  import { formatReplyTime } from '$lib/replies';
  import {
    hasTimeDetails,
    requestsText,
    timeKindHints,
    timeReportMarkdown,
    timeShare,
    type TimeReport,
    type TimedCall,
  } from '$lib/time-report';
  import ToolIcon from './ToolIcon.svelte';
  let {
    response,
    chat,
    id,
    title = 'Chat',
    scope,
  }: {
    /** Where this reply's time went, and the whole chat's, which is read only once shown. */
    response: TimeReport;
    chat: TimeReport;
    id: string;
    /** The chat's title, which heads a copied report. */
    title?: string;
    /** Names the report within its chat, which recalls its scope and lists as left. */
    scope?: string;
  } = $props();
  const remembered = recall(() => scope);
  let mode = $state<'response' | 'chat'>(remembered.get('mode') ?? 'response');
  let all = $state(remembered.get<Record<string, boolean>>('all') ?? {});
  $effect(() => {
    remembered.set('mode', mode);
    remembered.set('all', { ...all });
  });
  const selected = $derived(mode === 'response' ? response : chat);
  const lists = $derived(
    [
      { key: 'ran', name: 'Longest calls', calls: selected.ran },
      { key: 'written', name: 'Longest to write', calls: selected.written },
    ].filter((list) => list.calls.length),
  );
  const initialRows = 5;
  const total = $derived(
    [
      formatReplyTime(selected.ms),
      mode === 'chat' ? `${selected.replies} ${selected.replies === 1 ? 'reply' : 'replies'}` : '',
      selected.requests ? requestsText(selected) : '',
      mode === 'chat' && selected.missing ? `${selected.missing} without time` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    mode =
      event.key === 'Home'
        ? 'response'
        : event.key === 'End'
          ? 'chat'
          : mode === 'response'
            ? 'chat'
            : 'response';
    const group = (event.target as HTMLElement).closest('[role="tablist"]');
    (group?.querySelector(`[data-mode="${mode}"]`) as HTMLElement)?.focus();
  }
  let copied = $state<'done' | 'failed' | ''>('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        timeReportMarkdown(selected, {
          title,
          scope: mode === 'response' ? 'This response' : 'Whole chat',
        }),
      );
      copied = 'done';
    } catch {
      copied = 'failed';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = ''), 1500);
  }
  const callTitle = (call: TimedCall) =>
    call.hint ?? [call.title, call.detail].filter(Boolean).join(' ');
</script>

<div class="time-report">
  <div class="report-toolbar">
    <div class="report-tabs" role="tablist" aria-label="Time report scope">
      <button
        role="tab"
        onkeydown={tabKey}
        id={`${id}-response-tab`}
        aria-controls={`${id}-report`}
        aria-selected={mode === 'response'}
        tabindex={mode === 'response' ? 0 : -1}
        data-mode="response"
        onclick={() => (mode = 'response')}>This response</button
      >
      <button
        role="tab"
        onkeydown={tabKey}
        id={`${id}-chat-tab`}
        aria-controls={`${id}-report`}
        aria-selected={mode === 'chat'}
        tabindex={mode === 'chat' ? 0 : -1}
        data-mode="chat"
        onclick={() => (mode = 'chat')}>Whole chat</button
      >
    </div>
    <span class="report-total">{total}</span>
    <button type="button" class="report-copy" disabled={!hasTimeDetails(selected)} onclick={copy}
      >{#if copied === 'done'}<Check size={12} aria-hidden="true" />Copied{:else}<Copy
          size={12}
          aria-hidden="true"
        />{copied === 'failed' ? 'Not copied' : 'Copy report'}{/if}</button
    >
  </div>
  <div
    id={`${id}-report`}
    role="tabpanel"
    aria-labelledby={`${id}-${mode}-tab`}
    tabindex="0"
    class="report-body"
  >
    {#if !hasTimeDetails(selected)}<p class="empty">
        Not recorded for this {mode === 'response' ? 'response' : 'chat'}.
      </p>{/if}
    {#if selected.parts.length}
      <ul class="parts" aria-label="Time by what the agent waited on">
        {#each selected.parts as part (part.kind)}
          <li title={timeKindHints[part.kind]}>
            <span class="part-name">{part.name}</span>
            <span class="part-bar" class:unrecorded={part.kind === 'unrecorded'} aria-hidden="true"
              ><span style:width={`${part.share * 100}%`}></span></span
            >
            <span class="part-time">{formatReplyTime(part.ms)}</span>
            <span class="part-share">{timeShare(part.share)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#each lists as list (list.key)}
      {@const whole = all[`${mode}/${list.key}`] ?? false}
      <h4 id={`${id}-${list.key}-name`}>{list.name}</h4>
      <ul class="calls" id={`${id}-${list.key}`} aria-labelledby={`${id}-${list.key}-name`}>
        {#each whole ? list.calls : list.calls.slice(0, initialRows) as call, index (index)}
          <li>
            <span class="call-time">{formatReplyTime(call.ms)}</span>
            <ToolIcon icon={call.icon} size={13} />
            <span class="call-name" title={callTitle(call)}
              >{#if call.code}<code>{call.title}</code
                >{:else}{call.title}{#if call.detail}{' '}<code>{call.detail}</code>{/if}{/if}</span
            >
            {#if call.count > 1}<span class="call-count" title={`${call.count} calls`}
                >×{call.count}</span
              >{/if}
            {#if call.failed}<span class="call-failed">{call.failed} failed</span>{/if}
          </li>
        {/each}
      </ul>
      {#if list.calls.length > initialRows}
        <button
          class="show-calls"
          aria-expanded={whole}
          aria-controls={`${id}-${list.key}`}
          onclick={() => (all[`${mode}/${list.key}`] = !whole)}
          >{whole ? 'Show fewer' : `Show all ${list.calls.length}`}</button
        >
      {/if}
    {/each}
  </div>
</div>

<style>
  .time-report {
    max-width: 640px;
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
    padding: 6px 8px 6px 6px;
    border-bottom: 1px solid var(--border);
  }
  .report-tabs {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--hover);
  }
  .report-tabs button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 4px 9px;
  }
  .report-tabs button[aria-selected='true'] {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .report-total {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .report-copy,
  .show-calls {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 9px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  :is(.report-copy, .show-calls):not(:disabled):hover {
    border-color: var(--border-hover);
  }
  .report-copy:disabled {
    color: var(--text-faint);
  }
  .report-body {
    padding: 10px 12px 12px;
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* One grid for every row, so names, bars and numbers line up. */
  .parts {
    display: grid;
    grid-template-columns: auto minmax(32px, 1fr) auto auto;
    gap: 6px 12px;
    align-items: center;
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
  .part-bar {
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--meter-track);
    overflow: hidden;
  }
  .part-bar > span {
    display: block;
    min-width: 2px;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--accent);
  }
  .part-bar.unrecorded > span {
    background: var(--text-faint);
  }
  .part-time,
  .part-share,
  .call-time,
  .call-count {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .part-time {
    color: var(--text);
    text-align: right;
  }
  .part-share {
    min-width: 2.6em;
    color: var(--text-muted);
    text-align: right;
  }
  h4 {
    margin: 14px 0 6px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .calls {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    gap: 5px 8px;
    align-items: baseline;
  }
  .calls li {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: baseline;
  }
  .calls li :global(svg) {
    align-self: center;
    color: var(--text-muted);
  }
  .call-time {
    color: var(--text);
    text-align: right;
  }
  .call-name {
    display: -webkit-box;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .call-name code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .call-count {
    grid-column: 4;
    color: var(--text-muted);
  }
  .call-failed {
    grid-column: 5;
    color: var(--danger);
    font-size: var(--text-xs);
    white-space: nowrap;
  }
  .show-calls {
    margin-top: 8px;
  }
</style>
