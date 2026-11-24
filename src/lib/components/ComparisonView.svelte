<script lang="ts" module>
  import type { Conversation } from '$lib/domain';
  import type { ModelMark as Mark } from '$lib/model-marks';
  /** A comparison's run as its column shows it. */
  export type ComparedRun = {
    id: string;
    chat?: Conversation;
    label: string;
    /** Its number among runs of the same model, reasoning and account. */
    repeat?: number;
    mark: Mark;
    account?: { name: string; color: string };
    branch?: string;
  };
</script>

<script lang="ts">
  // A comparison's runs side by side (docs/COMPARISONS.md): a column per run, its model, time,
  // tokens, cost and changed files at the top beside Pick, then the run's own messages as its chat
  // shows them, live while it runs.
  import type { Snippet } from 'svelte';
  import { Check, Columns3, GitBranch, LoaderCircle, Play, Trash2 } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import type { Comparison } from '$lib/comparisons';
  import { clock } from '$lib/clock';
  import { formatReplyTime } from '$lib/replies';
  import { chatSpend } from '$lib/spend';
  import { compactTokens } from '$lib/usage';
  import { summarizeFileChanges } from '$lib/file-changes';
  import ModelMark from './ModelMark.svelte';

  let {
    comparison,
    title,
    folder,
    runs,
    busy = '',
    error = '',
    canApply = false,
    canRemove = false,
    message,
    open,
    pick,
    start,
    apply,
    removeWorktrees,
  }: {
    comparison: Comparison;
    title: string;
    folder?: string;
    runs: ComparedRun[];
    busy?: string;
    error?: string;
    canApply?: boolean;
    canRemove?: boolean;
    message: Snippet<[Conversation, Message]>;
    open: (id: string) => void;
    pick: (id: string | undefined) => void;
    start: (id: string) => void;
    apply: () => void;
    removeWorktrees: () => void;
  } = $props();

  const task = $derived(runs[0]?.chat?.messages[0]);
  const taskText = $derived(
    task?.blocks
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n')
      .trim() ?? '',
  );
  let taskOpen = $state(false);

  function runStatus(chat?: Conversation) {
    const reply = chat?.messages.findLast((m) => m.role === 'assistant');
    if (!reply) return 'waiting' as const;
    return reply.status;
  }
  // The time its replies took, the one running counted until now.
  function spent(chat: Conversation) {
    let total = 0;
    for (const m of chat.messages) {
      if (m.role !== 'assistant') continue;
      if (m.status === 'running') total += Math.max(0, clock.now - Date.parse(m.createdAt));
      else total += m.durationMs ?? 0;
    }
    return total;
  }
  function cost(value: number | null) {
    if (value == null) return '—';
    if (value > 0 && value < 0.01) return '<$0.01';
    return `$${value.toFixed(2)}`;
  }
  function files(chat: Conversation) {
    const summary = summarizeFileChanges(chat.messages).files;
    if (!summary.length) return '0';
    const added = summary.reduce((sum, f) => sum + (f.added ?? 0), 0);
    const removed = summary.reduce((sum, f) => sum + (f.removed ?? 0), 0);
    return `${summary.length} · +${added} −${removed}`;
  }
  const statusName = {
    waiting: 'Waiting',
    running: 'Running',
    complete: 'Done',
    error: 'Failed',
    cancelled: 'Stopped',
  } as const;
</script>

<section class="comparison" aria-label="Comparison">
  <header class="comparison-header">
    <div class="comparison-title">
      <Columns3 size={16} aria-hidden="true" />
      <!-- The window's title names the comparison; its heading is for assistive technology. -->
      <h2 class="comparison-name">{title}</h2>
      <span class="comparison-detail"
        >{[
          `${runs.length} runs`,
          ...(folder ? [folder] : []),
          ...(comparison.oneAtATime ? ['One at a time'] : []),
        ].join(' · ')}</span
      >
    </div>
    <div class="comparison-actions">
      {#if comparison.applied}<span class="comparison-applied"
          ><Check size={14} aria-hidden="true" />Applied</span
        >{/if}
      {#if canApply}<button class="secondary" disabled={!!busy} onclick={apply}
          >{busy === 'apply' ? 'Applying…' : 'Apply to folder'}</button
        >{/if}
      {#if canRemove}<button
          class="icon-button"
          disabled={!!busy}
          title="Remove worktrees"
          aria-label="Remove worktrees"
          onclick={removeWorktrees}><Trash2 size={16} /></button
        >{/if}
    </div>
  </header>
  {#if error}<p class="comparison-error" role="alert">{error}</p>{/if}
  {#if taskText || task?.images?.length}<div class="comparison-task" class:open={taskOpen}>
      <p>
        {taskText}{#if task?.images?.length}{taskText ? ' · ' : ''}{task.images.length}
          {task.images.length === 1 ? 'image' : 'images'}{/if}
      </p>
      {#if taskText.length > 240 || taskText.split('\n').length > 3}<button
          class="text-button"
          aria-expanded={taskOpen}
          onclick={() => (taskOpen = !taskOpen)}>{taskOpen ? 'Show less' : 'Show all'}</button
        >{/if}
    </div>{/if}
  <div class="comparison-scroll">
    <div class="comparison-grid" style:--runs={runs.length}>
      {#each runs as run (run.id)}{@const chat = run.chat}{@const status =
          runStatus(chat)}{@const picked = comparison.picked === run.id}
        <article
          class="comparison-run"
          class:picked
          aria-label={`${run.label}${run.repeat ? ` #${run.repeat}` : ''}`}
        >
          <header class="run-header">
            <div class="run-name">
              <ModelMark mark={run.mark} variant="pill" />
              <strong title={run.label}
                >{run.label}{#if run.repeat}<span class="run-repeat">{` #${run.repeat}`}</span
                  >{/if}</strong
              >
              {#if run.account}<span
                  class="account-dot"
                  style:--account-color={run.account.color}
                  title={run.account.name}
                  aria-label={run.account.name}
                ></span>{/if}
            </div>
            <div class="run-controls">
              <span class="run-status" data-status={status}
                >{#if status === 'running'}<LoaderCircle
                    size={13}
                    class="spinning"
                    aria-hidden="true"
                  />{/if}{statusName[status]}</span
              >
              <button
                class="run-pick"
                aria-pressed={picked}
                disabled={status === 'waiting'}
                onclick={() => pick(picked ? undefined : run.id)}
                ><Check size={14} aria-hidden="true" />{picked ? 'Picked' : 'Pick'}</button
              >
              {#if chat}<button class="text-button" onclick={() => open(run.id)}>Open chat</button
                >{/if}
            </div>
            {#if chat}{@const spend = chatSpend(chat)}
              <dl class="run-metrics">
                <div>
                  <dt>Time</dt>
                  <dd>{formatReplyTime(spent(chat))}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    {spend.input == null && spend.output == null
                      ? '—'
                      : compactTokens((spend.input ?? 0) + (spend.output ?? 0))}
                  </dd>
                </div>
                <div>
                  <dt>Cost</dt>
                  <dd>{cost(spend.cost)}</dd>
                </div>
                <div>
                  <dt>Files</dt>
                  <dd>{files(chat)}</dd>
                </div>
              </dl>{/if}
            {#if run.branch}<p class="run-branch" title={run.branch}>
                <GitBranch size={12} aria-hidden="true" /><span>{run.branch}</span>
              </p>{/if}
          </header>
          <div class="run-body">
            {#if chat}{#each chat.messages.slice(1) as m (m.id)}{@render message(
                  chat,
                  m,
                )}{/each}{/if}
            {#if status === 'waiting'}<div class="run-waiting">
                <span>Waiting</span>
                {#if chat}<button class="secondary" onclick={() => start(run.id)}
                    ><Play size={14} aria-hidden="true" />Start now</button
                  >{/if}
              </div>{/if}
          </div>
        </article>{/each}
    </div>
  </div>
</section>

<style>
  .comparison {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .comparison-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .comparison-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--text-muted);
  }
  .comparison-name {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .comparison-detail {
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .comparison-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .comparison-applied {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--success);
    font-size: var(--text-sm);
  }
  .comparison-error {
    margin: 0;
    padding: 8px 14px;
    border-bottom: 1px solid var(--danger-border);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .comparison-task {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
  }
  .comparison-task p {
    display: -webkit-box;
    flex: 1;
    overflow: hidden;
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .comparison-task.open p {
    display: block;
  }
  .comparison-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .comparison-grid {
    display: grid;
    grid-template-columns: repeat(var(--runs), minmax(360px, 1fr));
    min-height: 100%;
  }
  .comparison-run {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-right: 1px solid var(--border);
  }
  .comparison-run:last-child {
    border-right: 0;
  }
  .comparison-run.picked {
    background: var(--accent-soft);
  }
  .run-header {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .comparison-run.picked .run-header {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .run-name {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .run-name strong {
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .run-repeat {
    color: var(--text-muted);
    font-weight: 500;
  }
  .run-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .run-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-right: auto;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .run-status[data-status='running'] {
    color: var(--accent-text);
  }
  .run-status[data-status='error'] {
    color: var(--danger);
  }
  .run-pick {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .run-pick:not(:disabled):hover {
    border-color: var(--border-hover);
    background: var(--hover);
  }
  .run-pick[aria-pressed='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .run-pick:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .run-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
  }
  .run-metrics div {
    min-width: 0;
  }
  .run-metrics dt {
    color: var(--text-faint);
    font-size: var(--text-2xs);
  }
  .run-metrics dd {
    overflow: hidden;
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .run-branch {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    margin: 0;
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }
  .run-branch span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .run-body {
    min-width: 0;
    padding: 4px 14px 24px;
  }
  .run-waiting {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .run-waiting button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  @media (max-width: 760px) {
    .comparison-grid {
      grid-template-columns: repeat(var(--runs), minmax(300px, 86vw));
    }
  }
</style>
