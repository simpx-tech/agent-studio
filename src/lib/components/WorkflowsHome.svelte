<script lang="ts">
  import { onMount } from 'svelte';
  import {
    CircleCheck,
    CirclePause,
    CircleStop,
    CircleX,
    LoaderCircle,
    MessageCircleQuestionMark,
    Plus,
    Search,
    Target,
    Workflow,
    X,
  } from '@lucide/svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import { formatReplyTime } from '$lib/replies';
  import type { WorkflowClient } from '$lib/workflow-client.svelte';
  import {
    runActive,
    triggerLabels,
    type TriggerKind,
    type WorkflowSummary,
  } from '$lib/workflow-model';
  import { scheduleLabel } from '$lib/workflow-schedule';
  import { runStatusNames, runTime } from '$lib/workflow-view';
  // The Workflows page (docs/WORKFLOWS.md): what waits for you, what runs, your workflows and
  // what ran, each opening where it is worked on.
  let {
    client,
    computerName,
    open,
    create,
  }: {
    client: WorkflowClient;
    computerName: (environmentId: string) => string;
    /** Opens a workflow, run or mission. */
    open: (id: string) => void;
    /** A new workflow chat. */
    create: () => void;
  } = $props();
  let query = $state('');
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const all = $derived([...client.summaries.values()]);
  const shown = $derived(
    query.trim()
      ? all.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
      : all,
  );
  const runs = $derived(shown.filter((s) => s.kind === 'run'));
  const newest = (a: WorkflowSummary, b: WorkflowSummary) =>
    (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt);
  const waiting = $derived(runs.filter((s) => runActive(s.status) && s.questions).sort(newest));
  const going = $derived(runs.filter((s) => runActive(s.status) && !s.questions).sort(newest));
  const finished = $derived(
    runs
      .filter((s) => !runActive(s.status))
      .sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt)),
  );
  const definitions = $derived(
    shown.filter((s) => s.kind === 'definition').sort((a, b) => a.title.localeCompare(b.title)),
  );
  // Each workflow's latest run, and whether one runs now.
  const latest = $derived.by(() => {
    const map = new Map<string, WorkflowSummary>();
    for (const run of all)
      if (run.kind === 'run' && run.definitionId) {
        const known = map.get(run.definitionId);
        if (!known || newest(run, known) < 0) map.set(run.definitionId, run);
      }
    return map;
  });
  const triggerChips = (s: WorkflowSummary) => {
    const chips = [
      ...s.schedules.map((schedule) => ({
        kind: 'schedule',
        label: scheduleLabel(schedule as never),
      })),
      ...s.triggers.map((t) => ({
        kind: t.kind,
        label: triggerLabels[t.kind as TriggerKind] ?? t.kind,
      })),
    ];
    return chips.length ? chips : [{ kind: 'manual', label: triggerLabels.manual }];
  };
  const took = (s: WorkflowSummary) => {
    const from = Date.parse(s.createdAt ?? '');
    const to = s.endedAt ? Date.parse(s.endedAt) : runActive(s.status) ? now : NaN;
    return Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? formatReplyTime(to - from)
      : '';
  };
  const driver = (s: WorkflowSummary) => {
    const lease = client.leases[s.id];
    return lease && lease.expiresAt > client.now ? computerName(lease.holder) : '';
  };
  const runDetail = (s: WorkflowSummary) =>
    [
      s.questions
        ? 'Waiting for you'
        : runActive(s.status)
          ? s.detail || runStatusNames[s.status ?? '']
          : runStatusNames[s.status ?? ''],
      runActive(s.status) ? driver(s) && `on ${driver(s)}` : runTime(s.endedAt ?? s.updatedAt),
      took(s),
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#snippet statusMark(s: WorkflowSummary, size = 16)}
  <span class="mark status-{s.questions ? 'attention' : s.status}" aria-hidden="true">
    {#if s.questions}<MessageCircleQuestionMark {size} />
    {:else if s.status === 'running'}<LoaderCircle {size} class="spinning" />
    {:else if s.status === 'paused'}<CirclePause {size} />
    {:else if s.status === 'completed'}<CircleCheck {size} />
    {:else if s.status === 'failed'}<CircleX {size} />
    {:else}<CircleStop {size} />{/if}
  </span>
{/snippet}

{#snippet runRow(s: WorkflowSummary)}
  <li>
    <button class="run-row" onclick={() => open(s.id)}>
      {@render statusMark(s)}
      <span class="row-text">
        <span class="row-title"
          >{#if s.mode === 'dynamic'}<Target size={13} aria-label="Mission" />{/if}{s.title}</span
        >
        <span class="row-detail">{runDetail(s)}</span>
      </span>
    </button>
  </li>
{/snippet}

<section class="workflows-home" aria-label="Workflows">
  <header class="home-header">
    <h1>Workflows</h1>
    <label class="search home-search"
      ><Search size={14} aria-hidden="true" /><input
        aria-label="Search workflows"
        placeholder="Search"
        bind:value={query}
      />{#if query}<button
          class="icon-button"
          onclick={() => (query = '')}
          aria-label="Clear search"><X size={12} /></button
        >{/if}</label
    >
    <button class="primary" onclick={create}><Plus size={15} aria-hidden="true" />New</button>
  </header>
  {#if client.mode === 'unavailable'}
    <p class="home-note">Update the relay to use workflows here.</p>
  {:else if !all.length}
    <div class="home-empty">
      {#if client.mode === 'loading'}<p class="home-note">Loading…</p>
      {:else}
        <span class="empty-mark"><Workflow size={26} aria-hidden="true" /></span>
        <p>No workflows yet.</p>
        <button class="primary" onclick={create}
          ><Plus size={15} aria-hidden="true" />New workflow</button
        >
      {/if}
    </div>
  {:else}
    {#if waiting.length}
      <h2>Needs you</h2>
      <ul class="run-list">
        {#each waiting as s (s.id)}{@render runRow(s)}{/each}
      </ul>
    {/if}
    {#if going.length}
      <h2>Running</h2>
      <ul class="run-list">
        {#each going as s (s.id)}{@render runRow(s)}{/each}
      </ul>
    {/if}
    <h2>Your workflows</h2>
    {#if definitions.length}
      <ul class="workflow-grid">
        {#each definitions as s (s.id)}
          {@const last = latest.get(s.id)}
          <li>
            <button class="workflow-tile" onclick={() => open(s.id)}>
              <span class="tile-head">
                <span class="tile-icon"><Workflow size={15} aria-hidden="true" /></span>
                <span class="tile-title">{s.title}</span>
                {#if last && runActive(last.status)}{@render statusMark(last, 15)}{/if}
              </span>
              {#if s.description.trim()}<span class="tile-description">{s.description}</span>{/if}
              <span class="tile-triggers">
                {#each triggerChips(s) as chip, index (index)}<span class="chip"
                    ><WorkflowIcon type={`trigger:${chip.kind}`} size={12} />{chip.label}</span
                  >{/each}
              </span>
              <span class="tile-foot">
                <span>{s.steps} {s.steps === 1 ? 'step' : 'steps'}</span>
                {#if last}<span
                    class="tile-last status-{last.questions ? 'attention' : last.status}"
                    >{last.questions
                      ? 'Waiting for you'
                      : runStatusNames[
                          last.status ?? ''
                        ]}{#if !runActive(last.status)}{` · ${runTime(last.endedAt ?? last.updatedAt)}`}{/if}</span
                  >{:else}<span>Never run</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}<p class="home-note">{query.trim() ? 'No matches.' : 'No workflows yet.'}</p>{/if}
    {#if finished.length}
      <h2>Recent runs</h2>
      <ul class="run-list">
        {#each finished as s (s.id)}{@render runRow(s)}{/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .workflows-home {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px max(24px, calc((100% - 980px) / 2)) 40px;
  }
  .home-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .home-header h1 {
    flex: 1;
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }
  .home-search {
    width: min(260px, 40%);
    margin: 0;
  }
  .home-search input {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 24px 0 8px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .home-note {
    margin: 12px 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .home-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-top: 18vh;
    color: var(--text-muted);
  }
  .home-empty p {
    margin: 0;
  }
  .empty-mark {
    display: inline-grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: var(--radius-xl);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .run-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .run-row {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 6px 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    text-align: left;
    color: var(--text-secondary);
  }
  .run-row:hover {
    background: var(--hover);
    color: var(--text);
  }
  .mark {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .mark.status-running {
    color: var(--accent-text);
  }
  .mark.status-attention,
  .mark.status-paused {
    color: var(--warning);
  }
  .mark.status-completed {
    color: var(--success);
  }
  .mark.status-failed {
    color: var(--danger);
  }
  .row-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row-title,
  .row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-base);
    color: var(--text);
  }
  .row-title :global(svg) {
    flex-shrink: 0;
    color: var(--accent-text);
  }
  .row-detail {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .workflow-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }
  .workflow-tile {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    height: 100%;
    min-height: 128px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    text-align: left;
    color: var(--text);
    transition:
      border-color var(--duration-fast),
      background var(--duration-fast);
  }
  .workflow-tile:hover {
    border-color: var(--border-hover);
    background: var(--surface-2);
  }
  .tile-head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .tile-icon {
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .tile-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .tile-description {
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tile-triggers {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }
  .tile-foot {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: auto;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .tile-last.status-running {
    color: var(--accent-text);
  }
  .tile-last.status-attention {
    color: var(--warning);
  }
  .tile-last.status-failed {
    color: var(--danger);
  }
  @media (max-width: 600px) {
    .workflows-home {
      padding: 16px 12px 28px;
    }
    .home-header {
      flex-wrap: wrap;
    }
    .home-search {
      order: 3;
      width: 100%;
    }
  }
</style>
