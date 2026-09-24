<script lang="ts">
  import { ChevronDown, FileCode2, GitBranch, Layers, ListChecks } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { Message } from '$lib/domain';
  import { formatReplyTime, type ReplyTimeTotal } from '$lib/replies';
  import type { ChangeSummary } from '$lib/file-changes';
  import type { BackgroundRun } from '$lib/background-work';
  import { planProgress } from '$lib/plans';
  import { nativeWorkflowStatus } from '$lib/workflows';
  import FileChanges from './FileChanges.svelte';
  import AccountChanges from './AccountChanges.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import NativeWorkflowPanel from './NativeWorkflowPanel.svelte';
  import BackgroundWork from './BackgroundWork.svelte';
  import RunningReplyTime from './RunningReplyTime.svelte';
  import { money } from '$lib/spend';
  let {
    message,
    timeTotal,
    responseChanges,
    chatChanges,
    folder,
    background = [],
  }: {
    message: Message;
    timeTotal?: ReplyTimeTotal;
    responseChanges: ChangeSummary;
    chatChanges: ChangeSummary;
    folder?: string;
    /** Background work this reply started that still runs. */
    background?: BackgroundRun[];
  } = $props();
  // A running reply's row starts with its live elapsed time; a finished reply's with its
  // timing and files. Plans, workflows and background work follow as compact toggles.
  const running = $derived(message.status === 'running');
  const plan = $derived(planProgress(message));
  const workflows = $derived(message.nativeWorkflows?.runs ?? []);
  // One panel opens below the row at a time. Each renders when first opened and then stays,
  // keeping file scope, list expansion and nested disclosures across panel switches.
  let expanded = $state<string | null>(null);
  const opened = new SvelteSet<string>();
  function toggle(section: string) {
    expanded = expanded === section ? null : section;
    opened.add(section);
  }
  // Close a panel whose toggle is gone, such as background work that has finished.
  $effect(() => {
    const sections = [
      ...(running ? [] : ['usage', 'files']),
      ...(plan ? ['plan'] : []),
      ...workflows.map((run) => `workflow:${run.id}`),
      ...(background.length ? ['background'] : []),
    ];
    if (expanded && !sections.includes(expanded)) expanded = null;
  });
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
    {#if running}<RunningReplyTime createdAt={message.createdAt} />{:else}{@render finished()}{/if}
    {#if plan}<button
        type="button"
        class="footer-toggle progress-toggle"
        id={message.id + '-plan-toggle'}
        aria-expanded={expanded === 'plan'}
        aria-controls={message.id + '-plan'}
        title={`${plan.complete} of ${plan.total} steps complete${plan.current ? `. In progress: ${plan.current}` : ''}`}
        onclick={() => toggle('plan')}
      >
        <ChevronDown size={13} class="disclosure" aria-hidden="true" />
        <ListChecks size={13} aria-hidden="true" />
        <span class="progress-label">{plan.title}</span><span class="count"
          >{plan.complete}/{plan.total}</span
        >{#if plan.current}<span class="current">{plan.current}</span>{/if}
      </button>{/if}
    {#each workflows as run, i (run.id)}<button
        type="button"
        class="footer-toggle progress-toggle"
        id={`${message.id}-workflow-${i}-toggle`}
        aria-expanded={expanded === `workflow:${run.id}`}
        aria-controls={`${message.id}-workflow-${i}`}
        title="Native Claude workflow"
        onclick={() => toggle(`workflow:${run.id}`)}
      >
        <ChevronDown size={13} class="disclosure" aria-hidden="true" />
        <GitBranch size={13} aria-hidden="true" />
        <span class="progress-label">{run.name || 'Claude workflow'}</span><span class="count"
          >{nativeWorkflowStatus(run.status, message.status)}</span
        >
      </button>{/each}
    {#if background.length}<button
        type="button"
        class="footer-toggle progress-toggle"
        id={message.id + '-background-toggle'}
        aria-expanded={expanded === 'background'}
        aria-controls={message.id + '-background'}
        title={`${background.length} running in the background`}
        onclick={() => toggle('background')}
      >
        <ChevronDown size={13} class="disclosure" aria-hidden="true" />
        <Layers size={13} aria-hidden="true" />
        <span class="progress-label">Background work</span><span class="count"
          >{background.length}</span
        >
      </button>{/if}
  </div>
  {#if !running}{@render finishedPanels()}{/if}
  {#if plan}<div
      class="progress-panel"
      id={message.id + '-plan'}
      role="region"
      aria-labelledby={message.id + '-plan-toggle'}
      hidden={expanded !== 'plan'}
    >
      {#if opened.has('plan')}<PlanPanel {message} />{/if}
    </div>{/if}
  {#each workflows as run, i (run.id)}<div
      class="progress-panel"
      id={`${message.id}-workflow-${i}`}
      role="region"
      aria-labelledby={`${message.id}-workflow-${i}-toggle`}
      hidden={expanded !== `workflow:${run.id}`}
    >
      {#if opened.has(`workflow:${run.id}`)}<NativeWorkflowPanel {message} {run} />{/if}
    </div>{/each}
  {#if background.length}<div
      class="progress-panel"
      id={message.id + '-background'}
      role="region"
      aria-labelledby={message.id + '-background-toggle'}
      hidden={expanded !== 'background'}
    >
      {#if opened.has('background')}<BackgroundWork
          runs={background}
          live={expanded === 'background'}
        />{/if}
    </div>{/if}
</div>

{#snippet finished()}
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
    <span>Files edited</span><span class="count"
      >{responseChanges.files.length || (responseChanges.recorded ? '0' : '—')}</span
    >
  </button>
{/snippet}

{#snippet finishedPanels()}
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
    {#if opened.has('files')}
      <FileChanges response={responseChanges} chat={chatChanges} id={message.id} {folder} />
    {/if}
  </div>
{/snippet}

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
  .files-toggle,
  .progress-toggle {
    white-space: nowrap;
  }
  .progress-toggle {
    max-width: 100%;
  }
  .count {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .progress-label {
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A running plan names its current step, truncated to keep the row compact. */
  .current {
    min-width: 0;
    max-width: 22em;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-faint);
  }
  .progress-panel {
    max-width: 640px;
    max-height: 300px;
    overflow: auto;
    margin-top: 6px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: 12px;
  }
  @media (max-width: 600px) {
    .progress-panel {
      max-height: 220px;
    }
    .current {
      display: none;
    }
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
