<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    Bot,
    ChartNoAxesGantt,
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    Gauge,
    Layers,
    ListChecks,
    MessagesSquare,
    PenLine,
    SquareTerminal,
    Timer,
    X,
  } from '@lucide/svelte';
  import { closeOnBackdrop } from '$lib/dialog-backdrop';
  import type { Message } from '$lib/domain';
  import { formatReplyTime } from '$lib/replies';
  import {
    agentOutcome,
    hasTimeDetails,
    measurementsText,
    requestsText,
    timeFamilyNames,
    timeKindHints,
    timeKindNames,
    timeMark,
    timeReport,
    timeReportMarkdown,
    timeShare,
    timeTicks,
    timedCallCount,
    type TimeSlice,
    type TimeStep,
    type TimedCall,
  } from '$lib/time-report';
  import TimeMakeup from './TimeMakeup.svelte';
  import ToolIcon from './ToolIcon.svelte';
  let {
    messages,
    title,
    folder,
    initial,
    close,
  }: {
    /** The chat's messages, read when the report opens. */
    messages: readonly Message[];
    title: string;
    folder?: string;
    /** The reply to open on; the whole chat without one. */
    initial?: string;
    close: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let closeButton: HTMLButtonElement;
  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    // Not the first control, which copies.
    closeButton.focus();
    // Its backdrop closes it as Escape and its close button do, so the page can open it again.
    const release = closeOnBackdrop(dialog, () => close());
    return () => {
      release();
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  });

  // The report reads the chat without making it reactive (src/lib/detached.ts), so what changes
  // it is named: a message more or less.
  const chat = $derived.by(() => {
    void messages.length;
    return timeReport(messages, { folder });
  });
  // Whole chat, or the reply with this id.
  let scope = $state(untrack(() => initial) ?? 'chat');
  const position = $derived(chat.list.findIndex((reply) => reply.id === scope));
  const report = $derived.by(() => {
    if (scope === 'chat') return chat;
    const index = messages.findIndex((message) => message.id === scope);
    if (index < 0) return chat;
    // What was asked names the reply.
    let before = index - 1;
    while (before >= 0 && messages[before].role !== 'user') before--;
    return timeReport(before < 0 ? [messages[index]] : [messages[before], messages[index]], {
      folder,
    });
  });
  const whole = $derived(scope === 'chat' || position < 0);
  const step = (by: number) => {
    const next = chat.list[position + by];
    if (next) scope = next.id;
  };

  // The stretch of the timeline under the pointer.
  let hovered = $state<{ at: number; slice: TimeSlice; step?: string }>();
  function hover(event: PointerEvent) {
    const timeline = report.timeline;
    if (!timeline?.length) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const at = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) * report.ms;
    let low = 0;
    let high = timeline.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (timeline[middle].start <= at) low = middle;
      else high = middle - 1;
    }
    hovered = {
      at,
      slice: timeline[low],
      step: report.stepSpans?.find((span) => span.start <= at && at < span.start + span.ms)?.title,
    };
  }
  const place = (ms: number) => `${(ms / report.ms) * 100}%`;

  // Steps of the plan in its order; stretches between notes longest first.
  let stepsBy = $state<'plan' | 'notes'>('plan');
  const steps = $derived(
    stepsBy === 'plan' && report.steps.length
      ? report.steps
      : [...report.notes].sort((a, b) => b.ms - a.ms),
  );
  const planned = $derived(stepsBy === 'plan' && report.steps.length > 0);
  let all = $state<Record<string, boolean>>({});
  const shown = <T,>(key: string, items: T[], first: number) =>
    all[key] ? items : items.slice(0, first);
  const longest = (items: { ms?: number }[]) => Math.max(1, ...items.map((item) => item.ms ?? 0));
  const callTitle = (call: TimedCall) =>
    call.hint ?? [call.title, call.detail].filter(Boolean).join(' ');
  const stepTitle = (item: TimeStep) =>
    `${item.title} · ${formatReplyTime(item.ms)}` +
    (item.stretches > 1 ? ` in ${item.stretches} stretches` : '') +
    (item.rest ? '' : ` · from ${timeMark(item.start)}`);

  let copied = $state<'done' | 'failed' | ''>('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        timeReportMarkdown(report, { title, scope: whole ? 'Whole chat' : 'This response' }),
      );
      copied = 'done';
    } catch {
      copied = 'failed';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = ''), 1500);
  }
</script>

{#snippet more(key: string, count: number, first: number)}
  {#if count > first}
    <button
      type="button"
      class="show-more"
      aria-expanded={!!all[key]}
      onclick={() => (all[key] = !all[key])}>{all[key] ? 'Show fewer' : `Show all ${count}`}</button
    >
  {/if}
{/snippet}

{#snippet calls(key: string, name: string, list: TimedCall[])}
  {#if list.length}
    <section class="card" aria-labelledby={`time-${key}`}>
      <h3 id={`time-${key}`}>
        {#if key === 'ran'}<Timer size={14} aria-hidden="true" />{:else}<PenLine
            size={14}
            aria-hidden="true"
          />{/if}{name}
      </h3>
      <ul class="calls" aria-labelledby={`time-${key}`}>
        {#each shown(`${scope}/${key}`, list, 6) as call, index (index)}
          <li>
            <span class="time">{formatReplyTime(call.ms)}</span>
            <ToolIcon icon={call.icon} size={13} />
            <span class="call-name" title={callTitle(call)}
              >{#if call.code}<code>{call.title}</code
                >{:else}{call.title}{#if call.detail}{' '}<code>{call.detail}</code>{/if}{/if}</span
            >
            {#if call.count > 1 || call.failed}<span class="count" class:failed={call.failed > 0}
                >{timedCallCount(call)}</span
              >{/if}
          </li>
        {/each}
      </ul>
      {@render more(`${scope}/${key}`, list.length, 6)}
    </section>
  {/if}
{/snippet}

<dialog
  class="time-dialog"
  bind:this={dialog}
  aria-labelledby="time-report-title"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <header>
    <div class="heading">
      <span class="eyebrow">{title}</span>
      <h2 id="time-report-title">Time report</h2>
    </div>
    <button type="button" class="quiet-button" disabled={!hasTimeDetails(report)} onclick={copy}
      >{#if copied === 'done'}<Check size={13} aria-hidden="true" />Copied{:else}<Copy
          size={13}
          aria-hidden="true"
        />{copied === 'failed' ? 'Not copied' : 'Copy report'}{/if}</button
    >
    <button
      type="button"
      class="icon-button"
      bind:this={closeButton}
      onclick={close}
      aria-label="Close time report"><X size={20} /></button
    >
  </header>
  <div class="scope">
    <div class="tabs" role="tablist" aria-label="Time report scope">
      <button
        type="button"
        role="tab"
        aria-selected={whole}
        aria-controls="time-report-body"
        onclick={() => (scope = 'chat')}>Whole chat</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={!whole}
        aria-controls="time-report-body"
        disabled={!chat.list.length}
        onclick={() => (scope = chat.list.at(-1)?.id ?? 'chat')}>One response</button
      >
    </div>
    {#if !whole}
      <div class="stepper">
        <button
          type="button"
          class="icon-button"
          aria-label="Earlier response"
          disabled={position <= 0}
          onclick={() => step(-1)}><ChevronLeft size={16} /></button
        >
        <span class="reply-name" title={chat.list[position].label}
          ><span class="muted">{position + 1} of {chat.list.length}</span>
          {chat.list[position].label}</span
        >
        <button
          type="button"
          class="icon-button"
          aria-label="Later response"
          disabled={position >= chat.list.length - 1}
          onclick={() => step(1)}><ChevronRight size={16} /></button
        >
      </div>
    {/if}
  </div>
  <div class="body" id="time-report-body" role="tabpanel" tabindex="-1">
    {#key scope}
      <section class="hero" aria-label="Total">
        <div class="total">
          <strong>{formatReplyTime(report.ms)}</strong>
          <span class="muted"
            >{[
              whole ? `${report.replies} ${report.replies === 1 ? 'reply' : 'replies'}` : '',
              report.requests ? requestsText(report) : '',
              whole && report.missing ? `${report.missing} without time` : '',
            ]
              .filter(Boolean)
              .join(' · ')}</span
          >
        </div>
        {#if report.families.length}
          <TimeMakeup makeup={report.families} tall />
          <ul class="families">
            {#each report.families as family (family.family)}
              <li data-family={family.family}>
                <span class="family-name">{family.name}</span>
                <strong>{formatReplyTime(family.ms)}</strong>
                <span class="muted">{timeShare(family.share)}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">Not recorded for this {whole ? 'chat' : 'response'}.</p>
        {/if}
      </section>

      {#if report.timeline}
        <section class="card" aria-labelledby="time-timeline">
          <h3 id="time-timeline"><ChartNoAxesGantt size={14} aria-hidden="true" />Timeline</h3>
          <div class="timeline">
            <div
              class="ribbon"
              role="img"
              aria-label="What the reply waited on, in order"
              onpointermove={hover}
              onpointerdown={hover}
              onpointerleave={() => (hovered = undefined)}
            >
              {#each report.timeline as slice, index (index)}
                <span data-family={slice.family} style:flex-grow={slice.ms}></span>
              {/each}
              {#if hovered}<span class="cursor" style:left={place(hovered.at)}></span>{/if}
            </div>
            {#if report.stepSpans?.length}
              <div class="lane" aria-label="Plan steps">
                {#each report.stepSpans as span, index (index)}
                  <span
                    class="span"
                    style:left={place(span.start)}
                    style:width={place(span.ms)}
                    title={`${span.title} · ${formatReplyTime(span.ms)}`}>{span.title}</span
                  >
                {/each}
              </div>
            {/if}
            {#if report.agentSpans?.length}
              <div class="lane" aria-label="Sub-agents">
                {#each report.agentSpans as span, index (index)}
                  <span
                    class="span agent"
                    style:left={place(span.start)}
                    style:width={place(span.ms)}
                    title={`${span.title} · ${formatReplyTime(span.ms)}`}
                    ><Bot size={11} aria-hidden="true" />{span.title}</span
                  >
                {/each}
              </div>
            {/if}
            <div class="axis" aria-hidden="true">
              {#each timeTicks(report.ms) as tick (tick)}
                <span style:left={place(tick)}>{timeMark(tick)}</span>
              {/each}
            </div>
            <p class="readout" aria-live="off">
              {#if hovered}
                <span class="dot" data-family={hovered.slice.family}></span>
                <strong>{timeMark(hovered.at)}</strong>
                {timeKindNames[hovered.slice.kind]}
                <span class="muted">for {formatReplyTime(hovered.slice.ms)}</span>
                {#if hovered.step}<span class="muted">· {hovered.step}</span>{/if}
              {:else}
                {#each report.families as family (family.family)}
                  <span class="key"
                    ><span class="dot" data-family={family.family}></span>{family.name}</span
                  >
                {/each}
              {/if}
            </p>
          </div>
        </section>
      {/if}

      {#if whole && report.list.length > 1}
        <section class="card" aria-labelledby="time-replies">
          <h3 id="time-replies"><MessagesSquare size={14} aria-hidden="true" />Responses</h3>
          <ol class="rows" aria-labelledby="time-replies">
            {#each report.list as reply, index (reply.id)}
              <li>
                <button type="button" class="row" onclick={() => (scope = reply.id)}>
                  <span class="name"><span class="muted">{index + 1}</span> {reply.label}</span>
                  <TimeMakeup makeup={reply.makeup} scale={reply.ms / longest(report.list)} />
                  <span class="time">{formatReplyTime(reply.ms)}</span>
                  <span class="share">{timeShare(report.ms ? reply.ms / report.ms : 0)}</span>
                </button>
              </li>
            {/each}
          </ol>
        </section>
      {/if}

      {#if report.steps.length || report.notes.length}
        <section class="card" aria-labelledby="time-steps">
          <div class="card-heading">
            <h3 id="time-steps"><ListChecks size={14} aria-hidden="true" />Steps</h3>
            {#if report.steps.length && report.notes.length}
              <div class="tabs small" role="tablist" aria-label="Steps by">
                <button
                  type="button"
                  role="tab"
                  aria-selected={stepsBy === 'plan'}
                  onclick={() => (stepsBy = 'plan')}>Plan</button
                >
                <button
                  type="button"
                  role="tab"
                  aria-selected={stepsBy === 'notes'}
                  onclick={() => (stepsBy = 'notes')}>Notes</button
                >
              </div>
            {/if}
          </div>
          <ol class="rows" aria-labelledby="time-steps">
            {#each shown(`${scope}/${planned}`, steps, planned ? steps.length : 8) as item, index (index)}
              <li class="row" class:rest={item.rest} title={stepTitle(item)}>
                <span class="name"
                  >{item.title}{#if whole && chat.list.length > 1}<span class="muted">
                      · response {item.reply}</span
                    >{/if}{#if item.stretches > 1}<span class="muted">
                      · {item.stretches} stretches</span
                    >{/if}</span
                >
                <TimeMakeup makeup={item.makeup} scale={item.ms / longest(steps)} />
                <span class="time">{formatReplyTime(item.ms)}</span>
                <span class="share">{timeShare(item.share)}</span>
              </li>
            {/each}
          </ol>
          {@render more(`${scope}/${planned}`, steps.length, planned ? steps.length : 8)}
        </section>
      {/if}

      {#if report.agents.length}
        <section class="card" aria-labelledby="time-agents">
          <h3 id="time-agents"><Bot size={14} aria-hidden="true" />Sub-agents</h3>
          <ul class="rows" aria-labelledby="time-agents">
            {#each shown(`${scope}/agents`, report.agents, 8) as agent, index (index)}
              <li class="row" title={agent.task}>
                <span class="name"
                  >{agent.name}{#if agentOutcome(agent)}<span
                      class="tag"
                      class:failed={agent.status === 'error' || agent.status === 'blocked'}
                      >{agentOutcome(agent)}</span
                    >{/if}<span class="muted">
                    · {agent.calls}
                    {agent.calls === 1 ? 'call' : 'calls'}{agent.failed
                      ? `, ${agent.failed} failed`
                      : ''}</span
                  ></span
                >
                <TimeMakeup
                  makeup={agent.makeup}
                  scale={(agent.ms ?? 0) / longest(report.agents)}
                />
                <span class="time">{agent.ms == null ? '—' : formatReplyTime(agent.ms)}</span>
                <span class="share"
                  >{agent.ms == null || !report.ms ? '' : timeShare(agent.ms / report.ms)}</span
                >
              </li>
            {/each}
          </ul>
          {@render more(`${scope}/agents`, report.agents.length, 8)}
        </section>
      {/if}

      {#if report.parts.length}
        <section class="card" aria-labelledby="time-kinds">
          <h3 id="time-kinds"><Layers size={14} aria-hidden="true" />What it waited on</h3>
          <ul class="rows" aria-labelledby="time-kinds">
            {#each report.parts as part (part.kind)}
              <li class="row" title={timeKindHints[part.kind]}>
                <span class="name"
                  ><span class="dot" data-family={part.family}></span>{part.name}<span
                    class="muted"
                  >
                    · {timeFamilyNames[part.family]}</span
                  ></span
                >
                <TimeMakeup
                  makeup={[{ family: part.family, name: part.name, ms: part.ms, share: 1 }]}
                  scale={part.ms / longest(report.parts)}
                />
                <span class="time">{formatReplyTime(part.ms)}</span>
                <span class="share">{timeShare(part.share)}</span>
              </li>
            {/each}
          </ul>
          {#if report.measurements.length}
            <h4 id="time-measurements">
              <Gauge size={12} aria-hidden="true" />{measurementsText(report.measurements)}
            </h4>
            <ul class="measurements" aria-labelledby="time-measurements">
              {#each report.measurements as measurement, index (index)}
                <li class:beside={!measurement.clean}>
                  <span class="verdict"
                    >{measurement.clean
                      ? 'Clean'
                      : 'Beside other heavy work'}{#if report.replies > 1}<span class="muted"
                        >{' · '}response {measurement.reply}</span
                      >{/if}</span
                  >
                  {#if measurement.beside}<span class="muted beside-what"
                      >{measurement.beside.replaceAll('\n', '; ')}</span
                    >{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      {#if report.commands.length}
        <section class="card" aria-labelledby="time-commands">
          <h3 id="time-commands"><SquareTerminal size={14} aria-hidden="true" />Commands</h3>
          <ul class="rows" aria-labelledby="time-commands">
            {#each shown(`${scope}/commands`, report.commands, 6) as group (group.icon)}
              <li class="row">
                <span class="name"
                  ><ToolIcon icon={group.icon} size={13} />{group.name}<span class="muted">
                    · {group.count}
                    {group.count === 1 ? 'call' : 'calls'}</span
                  ></span
                >
                <TimeMakeup
                  makeup={[{ family: 'work', name: group.name, ms: group.ms, share: 1 }]}
                  scale={group.ms / longest(report.commands)}
                />
                <span class="time">{formatReplyTime(group.ms)}</span>
                <span class="share"></span>
              </li>
            {/each}
          </ul>
          {@render more(`${scope}/commands`, report.commands.length, 6)}
        </section>
      {/if}

      <div class="pair">
        {@render calls('ran', 'Longest calls', report.ran)}
        {@render calls('written', 'Longest to write', report.written)}
      </div>
    {/key}
  </div>
</dialog>

<style>
  .time-dialog {
    width: min(940px, calc(100vw - 32px));
    max-height: min(92vh, 980px);
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    background: var(--surface-overlay);
    color: var(--text-secondary);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .time-dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .time-dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 20px 12px 24px;
  }
  .heading {
    flex: 1 1 auto;
    min-width: 0;
  }
  .eyebrow {
    display: block;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  h2 {
    margin: 2px 0 0;
    color: var(--text);
    font-size: var(--text-xl);
    letter-spacing: var(--tracking-tighter);
  }
  .quiet-button,
  .show-more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
  }
  :is(.quiet-button, .show-more):not(:disabled):hover {
    border-color: var(--border-hover);
    color: var(--text);
  }
  .quiet-button:disabled {
    color: var(--text-faint);
  }
  .scope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    padding: 0 24px 14px;
    border-bottom: 1px solid var(--border);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--hover);
  }
  .tabs button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    padding: 5px 12px;
  }
  .tabs.small button {
    font-size: var(--text-xs);
    padding: 3px 9px;
  }
  .tabs button[aria-selected='true'] {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .tabs button:disabled {
    color: var(--text-faint);
  }
  .stepper {
    display: flex;
    flex: 1 1 240px;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .reply-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--text-muted);
    font-weight: 400;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 24px 24px;
    overflow: auto;
    font-size: var(--text-sm);
  }
  .body:focus {
    outline: none;
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .total {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
  }
  .total strong {
    color: var(--text);
    font-size: var(--text-3xl);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--tracking-tighter);
    line-height: var(--leading-tight);
  }
  .families {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .families li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--time-overhead);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }
  .families li[data-family='model'] {
    border-inline-start-color: var(--time-model);
  }
  .families li[data-family='work'] {
    border-inline-start-color: var(--time-work);
  }
  .families li[data-family='hold'] {
    border-inline-start-color: var(--time-hold);
  }
  .families li[data-family='unknown'] {
    border-inline-start-color: var(--time-unknown);
  }
  .family-name {
    flex: 1 0 100%;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .families strong {
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
  }
  ul,
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
  }
  .card-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 10px;
    color: var(--text);
    font-size: var(--text-base);
    font-weight: 600;
  }
  .card-heading h3 {
    margin: 0;
  }
  h3 :global(svg) {
    color: var(--text-muted);
  }
  /* The measurements a response made with the computer reserved, below the time on hold. */
  h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 14px 0 6px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .measurements {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--text-sm);
  }
  .measurements li {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding-inline-start: 10px;
    border-inline-start: 2px solid var(--success);
  }
  .measurements li.beside {
    border-inline-start-color: var(--warning);
  }
  .verdict {
    color: var(--text);
  }
  .beside-what {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* One grid for a card's rows, so names, bars and numbers line up. */
  .rows {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(60px, 3fr) auto auto;
    gap: 2px 14px;
    align-items: center;
  }
  .rows > li:not(.row) {
    display: contents;
  }
  .row {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
    min-height: 28px;
    padding: 2px 8px;
    margin: 0 -8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
  }
  button.row:hover {
    background: var(--hover);
  }
  .row.rest .name {
    color: var(--text-muted);
  }
  .name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name > .muted {
    flex: 0 0 auto;
  }
  .name :global(svg) {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .time,
  .share,
  .count {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .time {
    color: var(--text);
    text-align: end;
  }
  .share {
    min-width: 2.6em;
    color: var(--text-muted);
    text-align: end;
  }
  .tag {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--hover);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 17px;
  }
  .tag.failed,
  .count.failed {
    color: var(--danger);
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--time-overhead);
  }
  [data-family='model'].dot,
  .ribbon > [data-family='model'] {
    background: var(--time-model);
  }
  [data-family='work'].dot,
  .ribbon > [data-family='work'] {
    background: var(--time-work);
  }
  [data-family='hold'].dot,
  .ribbon > [data-family='hold'] {
    background: var(--time-hold);
  }
  [data-family='unknown'].dot,
  .ribbon > [data-family='unknown'] {
    background: var(--time-unknown);
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ribbon {
    position: relative;
    display: flex;
    height: 30px;
    border-radius: var(--radius-sm);
    background: var(--meter-track);
    overflow: hidden;
    touch-action: pan-y;
  }
  .ribbon > span {
    flex-basis: 0;
    min-width: 0;
    background: var(--time-overhead);
  }
  .ribbon > .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--text);
    pointer-events: none;
  }
  .lane {
    position: relative;
    height: 20px;
  }
  .span {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 3px;
    padding: 0 6px;
    overflow: hidden;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--border-strong);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .span.agent {
    background: var(--surface-2);
  }
  .span :global(svg) {
    flex: 0 0 auto;
  }
  .axis {
    position: relative;
    height: 16px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
  }
  .axis span {
    position: absolute;
    top: 0;
    padding: 3px 0 0 4px;
    border-inline-start: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-height: 20px;
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .readout strong {
    color: var(--text);
    font-weight: 600;
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-inline-end: 6px;
    color: var(--text-muted);
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
    gap: 14px;
  }
  .pair:empty {
    display: none;
  }
  .calls {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto;
    gap: 6px 8px;
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
  .call-name {
    display: -webkit-box;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    color: var(--text-secondary);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .call-name code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .count {
    grid-column: 4;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .show-more {
    margin-top: 10px;
    font-size: var(--text-xs);
  }
  /* A section fades in as its scope shows. */
  .body > :global(*) {
    animation: fade-in var(--duration) ease;
  }
  @media (max-width: 640px) {
    .time-dialog {
      width: 100vw;
      max-width: 100vw;
      max-height: 100dvh;
      height: 100dvh;
      border: 0;
      border-radius: 0;
    }
    header {
      padding: 14px 12px 10px 16px;
    }
    .scope {
      padding: 0 16px 12px;
    }
    .body {
      padding: 14px 16px 20px;
    }
    /* A row's bar goes under its name, the numbers beside the name. */
    .rows {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .row {
      row-gap: 5px;
      padding-block: 5px;
    }
    .row > :global(.makeup) {
      grid-row: 2;
      grid-column: 1 / -1;
    }
  }
</style>
