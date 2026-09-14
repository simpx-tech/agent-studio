<script lang="ts">
  import { ChevronDown, FileCode2 } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import { formatReplyTime, type ReplyTimeTotal } from '$lib/replies';
  import type { ChangeSummary } from '$lib/file-changes';
  import FileChanges from './FileChanges.svelte';
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
  function toggle(section: 'usage' | 'files') {
    expanded = expanded === section ? null : section;
  }
  const usage = $derived(message.usage);
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
        <span
          >{message.durationMs == null
            ? 'Time not recorded'
            : `${(message.durationMs / 1000).toFixed(1)}s`}</span
        >
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
          <dt>Input tokens</dt>
          <dd>{usage?.input?.toLocaleString() ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
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
            <dd>{(message.durationMs / 1000).toFixed(1)}s</dd>
          </div>
        {/if}
        {#if timeTotal}<div>
            <dt>Total AI time</dt>
            <dd>{totalTime}</dd>
          </div>{/if}
        <div>
          <dt>Estimated cost (USD)</dt>
          <dd>{cost ?? 'Not reported'}</dd>
        </div>
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
        {cost == null
          ? 'No cost was reported for this reply. Older replies may not have a saved cost.'
          : 'Estimate reported by the provider for this reply. Your plan determines actual billing.'}
      </p>
    </div>
  </div>
  <div
    id={message.id + '-files'}
    role="region"
    aria-labelledby={message.id + '-files-toggle'}
    hidden={expanded !== 'files'}
  >
    <FileChanges response={responseChanges} chat={chatChanges} id={message.id} {folder} />
  </div>
</div>

<style>
  .reply-footer {
    margin-top: 10px;
    min-width: 0;
    color: var(--text);
    font-size: 11px;
  }
  .footer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 16px;
  }
  .footer-toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 0;
    cursor: pointer;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    min-width: 0;
    text-align: left;
  }
  .usage-toggle {
    color: #8eaa76;
  }
  .files-toggle {
    color: var(--muted);
    gap: 6px;
    white-space: nowrap;
  }
  .file-count {
    font-variant-numeric: tabular-nums;
  }
  .footer-toggle:focus-visible {
    outline: 2px solid #b9ddcc;
    outline-offset: 3px;
    border-radius: 3px;
  }
  .footer-toggle :global(svg) {
    flex-shrink: 0;
  }
  .footer-toggle[aria-expanded='true'] :global(.disclosure) {
    transform: rotate(180deg);
  }
  .usage-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
  }
  .usage-summary span {
    white-space: nowrap;
  }
  .usage-breakdown {
    max-width: 440px;
    padding: 8px 0 4px 21px;
    color: #a8b69f;
    font-size: 12px;
    line-height: 1.6;
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
  dd {
    margin: 0;
    color: #d3dfca;
  }
  p {
    margin: 8px 0 0;
    font-size: 11px;
  }
</style>
