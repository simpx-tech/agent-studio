<script lang="ts">
  import { ChevronDown, FileCode2 } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import { formatReplyTime, type ReplyTimeTotal } from '$lib/replies';
  import type { ChangeSummary } from '$lib/file-changes';
  import FileChanges from './FileChanges.svelte';
  import AccountChanges from './AccountChanges.svelte';
  import { money } from '$lib/spend';
  let {
    message,
    timeTotal,
    responseChanges,
    chatChanges,
    folder,
  }: {
    message: Message;
    timeTotal?: ReplyTimeTotal;
    responseChanges: ChangeSummary;
    chatChanges: ChangeSummary;
    folder?: string;
  } = $props();
  let expanded = $state<'usage' | 'files' | null>(null);
  // File changes render when first opened and then stay, keeping their scope and list
  // expansion across panel switches. Unopened diffs stay out of the page.
  let filesOpened = $state(false);
  function toggle(section: 'usage' | 'files') {
    expanded = expanded === section ? null : section;
    if (section === 'files') filesOpened = true;
  }
  const usage = $derived(message.usage);
  const elapsed = $derived(
    message.durationMs == null ? 'Time not recorded' : formatReplyTime(message.durationMs),
  );
  const totalTime = $derived(
    timeTotal?.durationMs == null
      ? 'Not recorded'
      : `${timeTotal.missing ? '≥ ' : ''}${formatReplyTime(timeTotal.durationMs)}`,
  );
  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const cost = $derived(
    usage?.costUsd == null
      ? null
      : usage.costUsd > 0 && usage.costUsd < 0.000001
        ? '<$0.000001'
        : currency.format(usage.costUsd),
  );
  // Claude replies saved before costs were reply-scoped hold the CLI's running total.
  const runningTotal = $derived(
    message.settings?.provider === 'claude' && cost != null && usage?.scope !== 'reply',
  );
</script>

<div class="reply-footer">
  <div class="footer-controls">
    <button
      type="button"
      class="footer-toggle usage-toggle"
      id={message.id + '-usage-toggle'}
      aria-label="Reply usage and cost"
      aria-expanded={expanded === 'usage'}
      aria-controls={message.id + '-usage'}
      onclick={() => toggle('usage')}
    >
      <ChevronDown size={13} class="disclosure" aria-hidden="true" />
      <span class="usage-summary">
        <span>{elapsed}</span>
        {#if timeTotal}<span title="Recorded AI time in this conversation through this reply"
            >{timeTotal.durationMs == null ? 'Total time not recorded' : `${totalTime} total`}</span
          >{/if}
      </span>
    </button>
    <button
      type="button"
      class="footer-toggle files-toggle"
      id={message.id + '-files-toggle'}
      aria-expanded={expanded === 'files'}
      aria-controls={message.id + '-files'}
      onclick={() => toggle('files')}
    >
      <ChevronDown size={13} class="disclosure" aria-hidden="true" />
      <FileCode2 size={13} aria-hidden="true" />
      <span>Files edited</span><span class="file-count"
        >{responseChanges.files.length || (responseChanges.recorded ? '0' : '—')}</span
      >
    </button>
  </div>
  <div
    class="reply-usage"
    id={message.id + '-usage'}
    role="region"
    aria-labelledby={message.id + '-usage-toggle'}
    hidden={expanded !== 'usage'}
  >
    <div class="usage-breakdown">
      <dl>
        <div>
          <dt>{usage?.scope === 'session' ? 'Chat input tokens' : 'Input tokens'}</dt>
          <dd>{usage?.input?.toLocaleString() ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>{usage?.scope === 'session' ? 'Chat output tokens' : 'Output tokens'}</dt>
          <dd>{usage?.output?.toLocaleString() ?? 'Not reported'}</dd>
        </div>
        {#if usage?.cachedInput != null}
          <div>
            <dt>Cached input tokens</dt>
            <dd>{usage.cachedInput.toLocaleString()}</dd>
          </div>
        {/if}
        {#if usage?.reasoningOutput != null}
          <div>
            <dt>Reasoning tokens</dt>
            <dd>{usage.reasoningOutput.toLocaleString()}</dd>
          </div>
        {/if}
        {#if message.durationMs != null}
          <div>
            <dt>Elapsed time</dt>
            <dd>{elapsed}</dd>
          </div>
        {/if}
        {#if timeTotal}<div>
            <dt>Total AI time</dt>
            <dd>{totalTime}</dd>
          </div>{/if}
        <div>
          <dt>
            {usage?.scope === 'session'
              ? 'Estimated chat cost (USD)'
              : runningTotal
                ? 'Chat cost so far (USD)'
                : 'Estimated cost (USD)'}
          </dt>
          <dd>{cost ?? 'Not reported'}</dd>
        </div>
        {#if message.settings?.provider === 'codex'}<div>
            <dt>Estimated chat credits</dt>
            <dd>
              {usage?.sessionCredits?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ??
                'Not reported'}
            </dd>
          </div>{/if}
        {#if usage?.sessionCostUsd != null}<div>
            <dt>Estimated native chat cost (USD)</dt>
            <dd>{money(usage.sessionCostUsd)}</dd>
          </div>{/if}
      </dl>
      {#if timeTotal}<p>
          Total AI time sums this and earlier saved AI replies in this conversation, including
          stopped and failed replies.
          {#if timeTotal.missing}
            Timing is missing for {timeTotal.missing}
            {timeTotal.missing === 1 ? 'reply' : 'replies'}; the total includes recorded time only.
          {/if}
        </p>{/if}
      {#if usage?.cachedInput != null}<p>Cached tokens are already included in input.</p>{/if}
      <p>
        {usage?.scope === 'session'
          ? 'Cumulative native chat reading through this reply, not an additional per-reply charge. Estimates may differ from billing.'
          : runningTotal
            ? 'Saved before Agent Studio recorded per-reply Claude costs: the conversation’s running estimate through this reply, not an additional charge.'
            : cost == null
              ? 'No cost was reported for this reply. Older replies may not have a saved cost.'
              : 'Estimate reported by the provider for this reply. Your plan determines actual billing.'}
      </p>
      <AccountChanges {message} />
      {#if message.settings?.provider === 'codex'}<p>
          Native chat estimates cover the session through this reply. They are not additional
          per-reply charges.
        </p>{/if}
    </div>
  </div>
  <div
    id={message.id + '-files'}
    role="region"
    aria-labelledby={message.id + '-files-toggle'}
    hidden={expanded !== 'files'}
  >
    {#if filesOpened}
      <FileChanges response={responseChanges} chat={chatChanges} id={message.id} {folder} />
    {/if}
  </div>
</div>

<style>
  .reply-footer {
    margin-top: 12px;
    min-width: 0;
    color: var(--text-muted);
    font-size: 11px;
  }
  .footer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    margin-left: -6px;
  }
  .footer-toggle {
    display: flex;
    gap: 6px;
    align-items: center;
    min-height: 26px;
    padding: 3px 8px 3px 6px;
    cursor: pointer;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    min-width: 0;
    text-align: left;
  }
  .footer-toggle:not(:disabled):hover,
  .footer-toggle[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
  }
  .usage-toggle {
    font-variant-numeric: tabular-nums;
  }
  .files-toggle {
    white-space: nowrap;
  }
  .file-count {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .footer-toggle :global(svg) {
    flex-shrink: 0;
  }
  .footer-toggle :global(.disclosure) {
    color: var(--text-faint);
  }
  .footer-toggle[aria-expanded='true'] :global(.disclosure) {
    transform: rotate(180deg);
  }
  .usage-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
  }
  .usage-summary span {
    white-space: nowrap;
  }
  .usage-summary span + span {
    color: var(--text-faint);
  }
  .usage-breakdown {
    max-width: 460px;
    margin-top: 6px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: 12px;
    line-height: var(--leading-normal);
  }
  dl {
    margin: 0;
  }
  dl > div {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 18px;
    padding: 3px 0;
  }
  dl > div + div {
    border-top: 1px solid var(--border);
  }
  dd {
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
