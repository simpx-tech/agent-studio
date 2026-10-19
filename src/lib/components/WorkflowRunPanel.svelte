<script lang="ts">
  import {
    ChevronRight,
    CircleCheck,
    CircleStop,
    CircleX,
    Hourglass,
    LoaderCircle,
    MessageCircleQuestionMark,
    MessageSquare,
    Pencil,
    Plus,
    RotateCcw,
    SkipForward,
    SquareArrowOutUpRight,
    Trash2,
    X,
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import QuestionForm from './QuestionForm.svelte';
  import PlanApproval from './PlanApproval.svelte';
  import ElicitationForm from './ElicitationForm.svelte';
  import DriverPicker from './DriverPicker.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import { messageText, type Conversation, type Message } from '$lib/domain';
  import { formatReplyTime } from '$lib/replies';
  import {
    questionRequest,
    type Activation,
    type RunDriverChoice,
    type RunNote,
    type RunQuestion,
    type StepOutput,
    type WorkflowEvent,
    type WorkflowRun,
  } from '$lib/workflow-model';
  import {
    dynamicTimeline,
    staticTimeline,
    statusText,
    type DriverChoice,
    type TimelineEntry,
  } from '$lib/workflow-view';
  import type { QuestionAnswer } from '$lib/questions';
  // A run beside its graph (docs/WORKFLOWS.md): what it waits for you to answer, what it set out
  // to do and what came of it, and its history, each step as it ran, in order.
  let {
    run,
    events,
    now,
    selected,
    filter,
    conversation,
    computerName,
    accountName,
    openChat,
    openRun,
    command,
    answer,
    saveNote,
    drivers,
    changeDriver,
    select,
    clearFilter,
    close,
  }: {
    run: WorkflowRun;
    events: WorkflowEvent[];
    /** The time, each second, for what still runs. */
    now: number;
    /** The graph card the reader chose. */
    selected?: string;
    /** The card whose entries the history shows alone. */
    filter?: string;
    conversation: (id: string) => Conversation | undefined;
    computerName: (environmentId: string) => string;
    accountName: (connectionId?: string) => string;
    openChat: (conversationId: string) => void;
    openRun: (runId: string) => void;
    command: (kind: 'retry' | 'skip', activationId: string) => void;
    answer: (answer: QuestionAnswer) => Promise<void>;
    saveNote: (
      note: Pick<RunNote, 'title' | 'text'> & { id?: string; deleted?: boolean },
    ) => Promise<void>;
    /** The computers that run workflows, and a change of where this run continues. */
    drivers?: DriverChoice[];
    changeDriver?: (driver: RunDriverChoice) => void;
    /** Shows an entry's card on the graph. */
    select: (card: string | undefined) => void;
    clearFilter: () => void;
    /** Closes it, beside the graph it opened from. */
    close?: () => void;
  } = $props();
  const active = $derived(run.status === 'running' || run.status === 'paused');
  const message = (e: unknown) => String(e).replace(/^Error: /, '');

  // ---- What waits for you ---------------------------------------------------------------------
  const pending = $derived(run.questions.filter((q) => q.status === 'pending'));
  // The questions and forms the chats of its agents wait on, from their running replies.
  const asking = $derived.by(() => {
    void now;
    return run.agents.flatMap((agent) => {
      if (agent.status !== 'running' && agent.status !== 'waiting') return [];
      const chat = conversation(agent.conversationId);
      const reply = chat?.messages.at(-1);
      if (!chat || reply?.role !== 'assistant' || reply.status !== 'running') return [];
      const questions = (reply.questions ?? []).filter((q) => q.status === 'pending');
      const forms = (reply.elicitations ?? []).filter((e) => e.status === 'pending');
      if (!questions.length && !forms.length) return [];
      return [
        {
          agent,
          reply,
          questions,
          forms,
          connectionId: reply.settings?.connectionId ?? chat.settings.connectionId,
        },
      ];
    });
  });
  let deciding = $state<string>();
  let decideError = $state('');
  async function decide(item: RunQuestion, approve: boolean) {
    deciding = item.id;
    decideError = '';
    try {
      await answer({
        requestId: item.id,
        skipped: false,
        answers: [
          { id: 'answer', values: [approve ? item.confirm!.approve : item.confirm!.reject] },
        ],
      });
    } catch (error) {
      decideError = message(error);
    } finally {
      deciding = undefined;
    }
  }

  // ---- What it set out to do, and what came of it ----------------------------------------------
  let expanded = $state<Record<string, boolean>>({});
  const time = (at?: string) => {
    if (!at) return '';
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : date.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
  };
  const span = (from?: string, to?: string) => {
    const start = Date.parse(from ?? '');
    const end = to ? Date.parse(to) : now;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? formatReplyTime(end - start)
      : '';
  };
  // The computer it prefers to run on.
  const preferred = $derived(run.driver.preferred);
  let changingDriver = $state(false);
  const inputs = $derived(Object.entries(run.inputs));
  const notes = $derived(run.notes.filter((n) => !n.deleted));
  let notesOpen = $state(false);
  let editing = $state<{ id?: string; title: string; text: string }>();
  let noteError = $state('');
  async function submitNote() {
    if (!editing) return;
    noteError = '';
    try {
      await saveNote({
        ...(editing.id ? { id: editing.id } : {}),
        title: editing.title.trim(),
        text: editing.text,
      });
      editing = undefined;
    } catch (error) {
      noteError = message(error);
    }
  }

  // ---- Its history -----------------------------------------------------------------------------
  const entries = $derived(
    run.mode === 'dynamic' ? dynamicTimeline(run, events) : staticTimeline(run, events),
  );
  const numbered = $derived(entries.map((entry, index) => ({ entry, number: index + 1 })));
  const shown = $derived(filter ? numbered.filter(({ entry }) => entry.card === filter) : numbered);
  const filterName = $derived.by(() => {
    if (!filter) return '';
    const node = run.graph.nodes.find((n) => n.id === filter);
    if (node) return node.title || node.key;
    if (filter === 'orchestrator') return 'Orchestrator';
    if (filter.startsWith('task:'))
      return run.tasks.find((t) => `task:${t.id}` === filter)?.title || 'Task';
    if (filter.startsWith('agent:'))
      return run.agents.find((a) => `agent:${a.conversationId}` === filter)?.title || 'Agent';
    if (filter.startsWith('workflow:'))
      return run.children.find((c) => `workflow:${c.runId}` === filter)?.title || 'Workflow';
    if (filter.startsWith('question:')) return 'Question';
    return '';
  });
  let opened = $state<Record<string, boolean>>({});
  function toggle(entry: TimelineEntry) {
    opened = { ...opened, [entry.id]: !opened[entry.id] };
    select(entry.card);
  }
  const replyOf = (chat: string | undefined, id: string | undefined): Message | undefined =>
    chat && id ? conversation(chat)?.messages.find((m) => m.id === id) : undefined;
  /** A step's output or input as text: its own text, the reply it names, or its value. */
  function outputText(output: StepOutput | undefined): string {
    if (!output) return '';
    if (output.text !== undefined) return output.text;
    if (output.ref) {
      const reply = replyOf(output.ref.conversationId, output.ref.messageId);
      if (reply) return messageText(reply);
    }
    return output.json !== undefined ? JSON.stringify(output.json, null, 2) : '';
  }
  const firstLine = (text: string) =>
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? '';
  /** The line under an entry's title: how it went, else the start of what it handed on. */
  function line(entry: TimelineEntry): string {
    if (entry.detail) return entry.detail;
    if (entry.activation?.status !== 'done' || entry.activation.output?.port === 'error') return '';
    const text = firstLine(outputText(entry.activation.output));
    // A trigger without inputs hands over nothing worth a line.
    return text === '{}' || text === '[]' ? '' : text;
  }
  // A followed history stays at its end as entries arrive, as a followed chat does: what it set
  // out to do and its history scroll together, below what waits for you.
  let list = $state<HTMLElement>();
  let atEnd = true;
  function scrolled() {
    if (!list) return;
    atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  }
  $effect(() => {
    void shown.length;
    untrack(() => {
      if (atEnd && list) queueMicrotask(() => list && (list.scrollTop = list.scrollHeight));
    });
  });
</script>

{#snippet long(id: string, text: string)}
  {#if text}
    <pre class="output" class:clipped={!expanded[id] && text.length > 600}>{expanded[id] ||
      text.length <= 600
        ? text
        : text.slice(0, 600)}</pre>
    {#if text.length > 600}<button
        class="text-button"
        type="button"
        onclick={() => (expanded = { ...expanded, [id]: !expanded[id] })}
        >{expanded[id] ? 'Show less' : 'Show all'}</button
      >{/if}
  {/if}
{/snippet}
{#snippet mark(status: string)}
  {#if status === 'running'}<LoaderCircle size={13} class="spinning" aria-hidden="true" />
  {:else if status === 'attention'}<MessageCircleQuestionMark size={13} aria-hidden="true" />
  {:else if status === 'waiting' || status === 'queued'}<Hourglass size={13} aria-hidden="true" />
  {:else if status === 'done' || status === 'skipped'}<CircleCheck size={13} aria-hidden="true" />
  {:else if status === 'failed'}<CircleX size={13} aria-hidden="true" />
  {:else if status === 'stopped'}<CircleStop size={13} aria-hidden="true" />{/if}
{/snippet}
{#snippet stepDetails(entry: TimelineEntry, activation: Activation)}
  {@const took = span(activation.startedAt ?? activation.createdAt, activation.endedAt)}
  <p class="muted">
    {statusText(entry.status) ||
      activation.status}{#if took}{` · ${took}`}{/if}{#if activation.attempts > 1}{` · try ${activation.attempts}`}{/if}
  </p>
  {#if activation.wait && activation.status === 'waiting'}<p class="muted">
      {activation.wait}
    </p>{/if}
  {#if activation.error}<p class="error">{activation.error}</p>{/if}
  {#if outputText(activation.input)}<h4>Input</h4>
    {@render long(`${entry.id}:in`, outputText(activation.input))}{/if}
  {#if activation.status === 'done' && outputText(activation.output)}<h4>Output</h4>
    {@render long(`${entry.id}:out`, outputText(activation.output))}{/if}
  <div class="entry-actions">
    {#if entry.chat && conversation(entry.chat)}<button
        class="secondary small"
        onclick={() => openChat(entry.chat!)}><MessageSquare size={13} />Open chat</button
      >{/if}
    {#if entry.runId}<button class="secondary small" onclick={() => openRun(entry.runId!)}
        ><SquareArrowOutUpRight size={13} />Open run</button
      >{/if}
    {#if active && ['failed', 'stopped'].includes(activation.status)}<button
        class="secondary small"
        onclick={() => command('retry', activation.id)}><RotateCcw size={13} />Retry</button
      >{/if}
    {#if active && ['failed', 'waiting'].includes(activation.status)}<button
        class="secondary small"
        onclick={() => command('skip', activation.id)}><SkipForward size={13} />Skip</button
      >{/if}
  </div>
{/snippet}
{#snippet eventDetails(entry: TimelineEntry)}
  {@const reply = replyOf(entry.chat, entry.messageId)}
  {@const chat = entry.chat ? conversation(entry.chat) : undefined}
  {@const child = entry.runId ? run.children.find((c) => c.runId === entry.runId) : undefined}
  {@const task =
    !reply && chat
      ? chat.messages.find((m) => m.role === 'user' && m.sentBy === 'workflow')
      : undefined}
  {#if entry.text}{@render long(`${entry.id}:text`, entry.text)}{/if}
  {#if reply}<h4>Reply</h4>
    {@render long(`${entry.id}:reply`, messageText(reply))}
  {:else if task}<h4>Task</h4>
    {@render long(`${entry.id}:task`, messageText(task))}{/if}
  {#if child}<p class="muted">
      {child.status[0].toUpperCase() + child.status.slice(1)}
    </p>
    {#if child.output}{@render long(`${entry.id}:child`, child.output)}{/if}{/if}
  <div class="entry-actions">
    {#if chat}<button class="secondary small" onclick={() => openChat(chat.id)}
        ><MessageSquare size={13} />Open chat</button
      >{/if}
    {#if entry.runId}<button class="secondary small" onclick={() => openRun(entry.runId!)}
        ><SquareArrowOutUpRight size={13} />Open run</button
      >{/if}
  </div>
{/snippet}

<aside class="run-sheet" aria-label="Run">
  {#if close}<header class="sheet-head">
      <h2>History</h2>
      <button class="icon-button" title="Close" aria-label="Close the history" onclick={close}
        ><X size={16} /></button
      >
    </header>{/if}
  {#if pending.length || asking.length}
    <section class="needs-you" aria-label="Waiting for you">
      {#each pending as item (item.id)}
        {#if item.confirm}
          <div class="confirm" role="group" aria-label="Confirm">
            {#if item.questions[0].header}<strong>{item.questions[0].header}</strong>{/if}
            <p class="prose">{item.questions[0].question}</p>
            <div class="confirm-actions">
              <button
                class="secondary"
                disabled={!active || deciding === item.id}
                onclick={() => void decide(item, false)}>{item.confirm.reject}</button
              >
              <button
                class="primary"
                disabled={!active || deciding === item.id}
                onclick={() => void decide(item, true)}>{item.confirm.approve}</button
              >
            </div>
            {#if decideError}<p class="error" role="alert">{decideError}</p>{/if}
          </div>
        {:else}
          <QuestionForm request={questionRequest(item)} running={active} send={answer} />
        {/if}
      {/each}
      {#each asking as ask (ask.reply.id)}
        <div class="agent-asks">
          <div class="asks-head">
            <span>{ask.agent.title}</span>
            <button
              class="icon-button"
              title="Open chat"
              aria-label={`Open the chat of ${ask.agent.title}`}
              onclick={() => openChat(ask.agent.conversationId)}><MessageSquare size={14} /></button
            >
          </div>
          {#each ask.questions as request (request.id)}
            {#if request.planApproval}<PlanApproval
                {request}
                runId={ask.reply.runId}
                connectionId={ask.connectionId}
                running
              />{:else}<QuestionForm
                {request}
                runId={ask.reply.runId}
                connectionId={ask.connectionId}
                running
              />{/if}
          {/each}
          {#each ask.forms as receipt (receipt.id)}
            <ElicitationForm
              {receipt}
              runId={ask.reply.runId}
              connectionId={ask.connectionId}
              running
            />
          {/each}
        </div>
      {/each}
    </section>
  {/if}
  <div class="sheet-body" bind:this={list} onscroll={scrolled}>
    <section class="overview" aria-label={run.mode === 'dynamic' ? 'Goal' : 'Run'}>
      {#if run.mission}
        <p class="goal" class:clamped={!expanded.goal}>{run.mission.text}</p>
        {#if run.mission.text.length > 240 || run.mission.text.split('\n').length > 4}<button
            class="text-button"
            onclick={() => (expanded = { ...expanded, goal: !expanded.goal })}
            >{expanded.goal ? 'Show less' : 'Show all'}</button
          >{/if}
      {/if}
      {#if inputs.length}
        <dl>
          {#each inputs as [name, value] (name)}<dt>{name}</dt>
            <dd>{value}</dd>{/each}
        </dl>
      {/if}
      {#if run.output && !active}
        <h4>Result</h4>
        {@render long('output', run.output)}
      {/if}
      <p class="meta">
        <span
          >{time(
            run.startedAt,
          )}{#if span(run.startedAt, run.endedAt)}{` · ${span(run.startedAt, run.endedAt)}`}{/if}</span
        >
        {#if preferred}<span>· {computerName(preferred)}</span>{/if}
        {#if drivers?.length && changeDriver && active}<button
            class="text-button"
            aria-expanded={changingDriver}
            onclick={() => (changingDriver = !changingDriver)}>Change</button
          >{/if}
      </p>
      {#if changingDriver && drivers?.length && changeDriver}
        <DriverPicker
          {drivers}
          value={run.driver}
          disabled={!active}
          onchange={(next) => changeDriver(next)}
        />
      {/if}
      {#if run.mode === 'dynamic' || notes.length}
        <div class="notes">
          <button
            class="notes-toggle"
            aria-expanded={notesOpen}
            onclick={() => (notesOpen = !notesOpen)}
            ><ChevronRight
              size={13}
              class={notesOpen ? 'expanded-chevron' : ''}
            />Notes{#if notes.length}<span class="count">{notes.length}</span>{/if}</button
          >
          {#if notesOpen}
            {#if editing}
              <form
                class="note-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void submitNote();
                }}
              >
                <input aria-label="Title" placeholder="Title" bind:value={editing.title} />
                <textarea aria-label="Note" rows="5" bind:value={editing.text}></textarea>
                {#if noteError}<p class="error" role="alert">{noteError}</p>{/if}
                <div class="dialog-actions">
                  <button type="button" class="secondary" onclick={() => (editing = undefined)}
                    >Cancel</button
                  >
                  <button type="submit" class="primary">Save note</button>
                </div>
              </form>
            {:else}
              <button class="text-button" onclick={() => (editing = { title: '', text: '' })}
                ><Plus size={14} />Add note</button
              >
            {/if}
            <ul class="note-list">
              {#each notes as note (note.id)}
                <li>
                  <div class="note-head">
                    <strong>{note.title || 'Note'}</strong>
                    <span class="muted"
                      >{note.author === 'user'
                        ? 'You'
                        : note.author === 'orchestrator'
                          ? 'Orchestrator'
                          : 'Workflow'} · {time(note.updatedAt)}</span
                    >
                    <span class="spacer"></span>
                    <button
                      class="icon-button"
                      title="Edit"
                      aria-label={`Edit ${note.title || 'note'}`}
                      onclick={() =>
                        (editing = { id: note.id, title: note.title, text: note.text })}
                      ><Pencil size={13} /></button
                    >
                    <button
                      class="icon-button"
                      title="Delete"
                      aria-label={`Delete ${note.title || 'note'}`}
                      onclick={() =>
                        void saveNote({
                          id: note.id,
                          title: note.title,
                          text: note.text,
                          deleted: true,
                        })}><Trash2 size={13} /></button
                    >
                  </div>
                  <p class="prose">{note.text}</p>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>
    <section class="history" aria-label="History">
      <header class="history-head">
        {#if !close}<h3>History</h3>{/if}
        {#if filter}<span class="filter-chip"
            >{filterName}<button
              class="icon-button"
              aria-label="Show the whole history"
              title="Show all"
              onclick={clearFilter}><X size={12} /></button
            ></span
          >{/if}
      </header>
      <ol class="entries">
        {#each shown as { entry, number } (entry.id)}
          {@const detail = line(entry)}
          <li class="entry status-{entry.status}">
            <button
              class="entry-head"
              aria-expanded={!!opened[entry.id]}
              onclick={() => toggle(entry)}
            >
              <span class="entry-number">{number}</span>
              <span class="entry-icon"><WorkflowIcon type={entry.icon} size={13} /></span>
              <span class="entry-text">
                <span class="entry-title"
                  ><span>{entry.title}</span>{#if entry.item}<small>Item {entry.item}</small
                    >{/if}{#if entry.again}<small>Again</small>{/if}</span
                >
                {#if detail}<span class="entry-detail">{detail}</span>{/if}
              </span>
              <span class="entry-time"
                >{entry.status === 'running' ? span(entry.at) : time(entry.at)}</span
              >
              <span class="entry-mark">{@render mark(entry.status)}</span>
            </button>
            {#if opened[entry.id]}
              <div class="entry-body">
                {#if entry.activation}{@render stepDetails(entry, entry.activation)}
                {:else}{@render eventDetails(entry)}{/if}
              </div>
            {/if}
          </li>
        {:else}<li class="muted empty">Nothing yet.</li>{/each}
      </ol>
    </section>
  </div>
</aside>

<style>
  .run-sheet {
    display: flex;
    flex-direction: column;
    width: 400px;
    flex-shrink: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    overflow: hidden;
    font-size: var(--text-sm);
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  .sheet-head h2 {
    flex: 1;
    margin: 0;
    font-size: var(--text-md);
  }
  section {
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .needs-you {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 55%;
    overflow-y: auto;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--warning-soft) 45%, transparent);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .agent-asks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .asks-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--text-secondary);
    font-weight: 600;
  }
  .sheet-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .overview {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .goal {
    margin: 0;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .goal.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .notes-toggle {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 6px;
    min-height: 0;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .notes-toggle :global(svg) {
    transition: transform var(--duration-fast);
  }
  .notes-toggle :global(.expanded-chevron) {
    transform: rotate(90deg);
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .note-list li {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .note-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .note-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .history {
    display: flex;
    flex-direction: column;
    padding: 0;
    border-bottom: 0;
  }
  .history-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px 6px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }
  h4 {
    margin: 2px 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 8px;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-xs);
  }
  .filter-chip .icon-button {
    width: 20px;
    height: 20px;
    min-height: 0;
    color: inherit;
  }
  .entries {
    padding: 0 8px 10px;
  }
  .entry {
    border-radius: var(--radius-md);
  }
  .entry-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    min-height: 34px;
    padding: 6px 6px;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-secondary);
    text-align: left;
    font-weight: 400;
  }
  .entry-head:hover {
    background: var(--hover);
    color: var(--text);
  }
  .entry-number {
    flex: 0 0 22px;
    padding-top: 1px;
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .entry-icon {
    display: inline-flex;
    flex-shrink: 0;
    padding-top: 2px;
    color: var(--text-muted);
  }
  .entry-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .entry-title {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .entry-title > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-title small {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .entry-detail {
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-time {
    flex-shrink: 0;
    padding-top: 1px;
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .entry-mark {
    display: inline-flex;
    flex: 0 0 13px;
    padding-top: 2px;
    color: var(--text-muted);
  }
  .status-running .entry-mark,
  .status-running .entry-time {
    color: var(--accent-text);
  }
  .status-attention .entry-mark {
    color: var(--warning);
  }
  .status-done .entry-mark {
    color: var(--success);
  }
  .status-failed .entry-mark,
  .status-failed .entry-detail {
    color: var(--danger);
  }
  .entry-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 8px 10px 64px;
  }
  .entry-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .entry-actions:empty {
    display: none;
  }
  .small {
    min-height: 26px;
    padding: 2px 8px;
    gap: 5px;
    font-size: var(--text-xs);
  }
  .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .empty {
    padding: 8px 6px;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  .prose {
    margin: 0;
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  ol,
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .note-list {
    gap: 6px;
  }
  .spacer {
    flex: 1;
  }
  .count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .output {
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 420px;
    overflow-y: auto;
  }
  .output.clipped {
    mask-image: linear-gradient(to bottom, black 70%, transparent);
  }
  .text-button {
    align-self: flex-start;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: var(--text-xs);
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
