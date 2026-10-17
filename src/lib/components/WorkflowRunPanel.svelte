<script lang="ts">
  import { MessageSquare, Pencil, Plus, RotateCcw, SkipForward, Trash2, X } from '@lucide/svelte';
  import QuestionForm from './QuestionForm.svelte';
  import DriverPicker from './DriverPicker.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import { messageText, type Conversation } from '$lib/domain';
  import {
    answerText,
    nodeCatalog,
    isNodeType,
    questionRequest,
    type Activation,
    type RunDriverChoice,
    type RunNote,
    type RunQuestion,
    type WorkflowEvent,
    type WorkflowRun,
  } from '$lib/workflow-model';
  import { chatActivity, type DriverChoice } from '$lib/workflow-view';
  import type { QuestionAnswer } from '$lib/questions';
  let {
    run,
    events,
    selected,
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
    close,
  }: {
    run: WorkflowRun;
    events: WorkflowEvent[];
    selected?: string;
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
    close?: () => void;
  } = $props();
  let confirming = $state<string>();
  let confirmError = $state('');
  async function decide(item: RunQuestion, approve: boolean) {
    confirming = item.id;
    confirmError = '';
    try {
      await answer({
        requestId: item.id,
        skipped: false,
        answers: [
          { id: 'answer', values: [approve ? item.confirm!.approve : item.confirm!.reject] },
        ],
      });
    } catch (error) {
      confirmError = String(error).replace(/^Error: /, '');
    } finally {
      confirming = undefined;
    }
  }
  let tab = $state<'details' | 'history' | 'notes' | 'chats'>('details');
  let editing = $state<{ id?: string; title: string; text: string }>();
  let noteError = $state('');
  let expanded = $state<Record<string, boolean>>({});
  const active = $derived(run.status === 'running' || run.status === 'paused');
  const pending = $derived(run.questions.filter((q) => q.status === 'pending'));
  const notes = $derived(run.notes.filter((n) => !n.deleted));
  const time = (at?: string) => {
    if (!at) return '';
    const date = new Date(at);
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
  const statusLabel: Record<string, string> = {
    queued: 'Queued',
    running: 'Running',
    waiting: 'Waiting',
    done: 'Done',
    failed: 'Failed',
    stopped: 'Stopped',
    skipped: 'Skipped',
    planned: 'Planned',
    blocked: 'Blocked',
    cancelled: 'Cancelled',
    lost: 'Lost',
  };
  const output = (activation: Activation) => {
    const out = activation.output;
    if (!out) return '';
    if (out.text !== undefined) return out.text;
    if (out.ref) {
      const message = conversation(out.ref.conversationId)?.messages.find(
        (m) => m.id === out.ref!.messageId,
      );
      if (message) return messageText(message);
    }
    return out.json !== undefined ? JSON.stringify(out.json, null, 2) : '';
  };
  const node = $derived(run.graph.nodes.find((n) => n.id === selected));
  const activations = $derived(
    node ? run.activations.filter((a) => a.nodeId === node.id).reverse() : [],
  );
  const task = $derived(
    selected?.startsWith('task:') ? run.tasks.find((t) => `task:${t.id}` === selected) : undefined,
  );
  const agent = $derived(
    selected?.startsWith('agent:')
      ? run.agents.find((a) => `agent:${a.conversationId}` === selected)
      : undefined,
  );
  const question = $derived(
    selected?.startsWith('question:')
      ? run.questions.find((q) => `question:${q.id}` === selected)
      : undefined,
  );
  const child = $derived(
    selected?.startsWith('workflow:')
      ? run.children.find((c) => `workflow:${c.runId}` === selected)
      : undefined,
  );
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
      noteError = String(error).replace(/^Error: /, '');
    }
  }
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
{#snippet agentRow(item: WorkflowRun['agents'][number])}
  {@const chat = conversation(item.conversationId)}
  <li class="agent">
    <div class="agent-text">
      <span class="agent-title">{item.title}</span>
      <span class="muted"
        >{statusLabel[item.status] ?? item.status} · {computerName(
          item.environmentId,
        )}{#if item.connectionId}
          · {accountName(item.connectionId)}{/if}{#if item.model}
          · {item.model}{/if}</span
      >
      {#if chatActivity(chat) ?? item.wait}<span class="muted"
          >{chatActivity(chat) ?? item.wait}</span
        >{/if}
    </div>
    {#if chat}<button
        class="icon-button"
        title="Open chat"
        aria-label={`Open the chat of ${item.title}`}
        onclick={() => openChat(item.conversationId)}><MessageSquare size={15} /></button
      >{/if}
  </li>
{/snippet}

<aside class="run-panel" aria-label="Run details">
  {#if pending.length}
    <div class="questions">
      {#each pending as item (item.id)}
        {#if item.confirm}
          <div class="confirm" role="group" aria-label="Confirm">
            {#if item.questions[0].header}<strong>{item.questions[0].header}</strong>{/if}
            <p class="prose">{item.questions[0].question}</p>
            <div class="confirm-actions">
              <button
                class="secondary"
                disabled={!active || confirming === item.id}
                onclick={() => void decide(item, false)}>{item.confirm.reject}</button
              >
              <button
                class="primary"
                disabled={!active || confirming === item.id}
                onclick={() => void decide(item, true)}>{item.confirm.approve}</button
              >
            </div>
            {#if confirmError}<p class="error" role="alert">{confirmError}</p>{/if}
          </div>
        {:else}
          <QuestionForm request={questionRequest(item)} running={active} send={answer} />
        {/if}
      {/each}
    </div>
  {/if}
  <div class="tabs" role="tablist" aria-label="Run details">
    {#each [['details', 'Details'], ['history', 'History'], ['notes', run.mode === 'dynamic' ? 'Notes' : 'Notes'], ['chats', 'Chats']] as [id, name]}
      <button
        role="tab"
        aria-selected={tab === id}
        tabindex={tab === id ? 0 : -1}
        onclick={() => (tab = id as typeof tab)}
        >{name}{#if id === 'notes' && notes.length}<span class="count">{notes.length}</span
          >{/if}{#if id === 'chats' && run.agents.length}<span class="count"
            >{run.agents.length}</span
          >{/if}</button
      >
    {/each}
    {#if close}<button class="icon-button close" aria-label="Close run details" onclick={close}
        ><X size={15} /></button
      >{/if}
  </div>
  <div class="panel-body" role="tabpanel">
    {#if tab === 'details'}
      {#if node}
        <h3><WorkflowIcon type={node.type} />{node.title || node.key}</h3>
        <p class="muted">
          {isNodeType(node.type) ? nodeCatalog[node.type].label : node.type} ·
          <code>{node.key}</code>
        </p>
        {#if !activations.length}<p class="muted">It has not run yet.</p>{/if}
        <ol class="activations">
          {#each activations as activation (activation.id)}
            <li class="activation status-{activation.status}">
              <div class="activation-head">
                <span class="badge">{statusLabel[activation.status] ?? activation.status}</span>
                {#if activation.scope}<span class="muted"
                    >Item {Number(activation.scope.split('#').at(-1)) + 1}</span
                  >{/if}
                <span class="muted"
                  >{time(activation.startedAt ?? activation.createdAt)}{#if activation.endedAt}
                    – {time(activation.endedAt)}{/if}</span
                >
                {#if activation.attempts > 1}<span class="muted">Try {activation.attempts}</span
                  >{/if}
                <span class="spacer"></span>
                {#if activation.conversationId}<button
                    class="icon-button"
                    title="Open chat"
                    aria-label="Open its chat"
                    onclick={() => openChat(activation.conversationId!)}
                    ><MessageSquare size={14} /></button
                  >{/if}
                {#if active && ['failed', 'stopped'].includes(activation.status)}<button
                    class="icon-button"
                    title="Retry"
                    aria-label="Retry this step"
                    onclick={() => command('retry', activation.id)}><RotateCcw size={14} /></button
                  >{/if}
                {#if active && ['failed', 'waiting'].includes(activation.status)}<button
                    class="icon-button"
                    title="Skip"
                    aria-label="Skip this step"
                    onclick={() => command('skip', activation.id)}><SkipForward size={14} /></button
                  >{/if}
              </div>
              {#if activation.wait}<p class="muted">{activation.wait}</p>{/if}
              {#if activation.error}<p class="error">{activation.error}</p>{/if}
              {@render long(activation.id, output(activation))}
            </li>
          {/each}
        </ol>
      {:else if selected === 'orchestrator'}
        <h3><WorkflowIcon type="orchestrator" />Orchestrator</h3>
        <ol class="sessions">
          {#each [...run.sessions].reverse() as session, index (session.conversationId)}
            <li>
              <div class="activation-head">
                <span class="badge">Session {run.sessions.length - index}</span>
                <span class="muted"
                  >{computerName(session.environmentId)}{#if session.connectionId}
                    · {accountName(session.connectionId)}{/if}</span
                >
                <span class="spacer"></span>
                {#if conversation(session.conversationId)}<button
                    class="icon-button"
                    title="Open chat"
                    aria-label="Open this session's chat"
                    onclick={() => openChat(session.conversationId)}
                    ><MessageSquare size={14} /></button
                  >{/if}
              </div>
              <p class="muted">
                {time(session.startedAt)}{#if session.endedAt}
                  – {time(session.endedAt)}{/if} · {session.turns} turn{session.turns === 1
                  ? ''
                  : 's'}
              </p>
            </li>
          {/each}
        </ol>
      {:else if task}
        <h3><WorkflowIcon type="task" />{task.title || task.id}</h3>
        <p class="muted">
          {statusLabel[task.status] ?? task.status}{#if task.phase}
            · {task.phase}{/if}
        </p>
        {#if task.description}<p class="prose">{task.description}</p>{/if}
        {#if task.result}<p class="prose"><strong>Result</strong> {task.result}</p>{/if}
        {#if task.dependsOn.length}<p class="muted">
            After {task.dependsOn
              .map((id) => run.tasks.find((t) => t.id === id)?.title ?? id)
              .join(', ')}
          </p>{/if}
        <ul class="agents">
          {#each run.agents.filter((a) => a.taskId === task.id) as item (item.conversationId)}
            {@render agentRow(item)}
          {/each}
        </ul>
      {:else if agent}
        <h3><WorkflowIcon type="agent" />{agent.title}</h3>
        <ul class="agents">{@render agentRow(agent)}</ul>
      {:else if question}
        <h3><WorkflowIcon type="ask" />Question</h3>
        {#each question.questions as item (item.id)}<p class="prose">{item.question}</p>{/each}
        {#if question.status !== 'pending'}<p class="muted">{answerText(question)}</p>{/if}
      {:else if child}
        <h3><WorkflowIcon type="workflow" />{child.title}</h3>
        <p class="muted">{statusLabel[child.status] ?? child.status}</p>
        <button class="secondary" onclick={() => openRun(child.runId)}>Open run</button>
      {:else}
        <h3>{run.mode === 'dynamic' ? 'Mission' : 'Run'}</h3>
        {#if run.mission}<p class="prose">{run.mission.text}</p>{/if}
        <dl>
          <dt>Started</dt>
          <dd>{time(run.startedAt)}</dd>
          {#if run.endedAt}<dt>Ended</dt>
            <dd>{time(run.endedAt)}</dd>{/if}
          {#each Object.entries(run.inputs) as [name, value] (name)}<dt>{name}</dt>
            <dd>{value}</dd>{/each}
        </dl>
        {#if run.output}<h4>Output</h4>
          {@render long('output', run.output)}{/if}
        {#if drivers?.length && changeDriver}
          <div class="driver">
            <DriverPicker
              {drivers}
              value={run.driver}
              disabled={!active}
              onchange={(next) => changeDriver(next)}
            />
          </div>
        {/if}
      {/if}
    {:else if tab === 'history'}
      {#if !events.length}<p class="muted">Nothing yet.</p>{/if}
      <ol class="history">
        {#each [...events].reverse() as event (event.seq)}
          <li><time datetime={event.at}>{time(event.at)}</time><span>{event.text}</span></li>
        {/each}
      </ol>
    {:else if tab === 'notes'}
      {#if editing}
        <form
          class="note-form"
          onsubmit={(event) => {
            event.preventDefault();
            void submitNote();
          }}
        >
          <input aria-label="Title" placeholder="Title" bind:value={editing.title} />
          <textarea aria-label="Note" rows="6" bind:value={editing.text}></textarea>
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
      {#if !notes.length && !editing}<p class="muted">No notes.</p>{/if}
      <ul class="notes">
        {#each notes as note (note.id)}
          <li>
            <div class="activation-head">
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
                onclick={() => (editing = { id: note.id, title: note.title, text: note.text })}
                ><Pencil size={14} /></button
              >
              <button
                class="icon-button"
                title="Delete"
                aria-label={`Delete ${note.title || 'note'}`}
                onclick={() =>
                  void saveNote({ id: note.id, title: note.title, text: note.text, deleted: true })}
                ><Trash2 size={14} /></button
              >
            </div>
            <p class="prose">{note.text}</p>
          </li>
        {/each}
      </ul>
    {:else}
      {#if !run.agents.length}<p class="muted">No chats yet.</p>{/if}
      <ul class="agents">
        {#each [...run.agents].reverse() as item (item.conversationId)}{@render agentRow(
            item,
          )}{/each}
      </ul>
    {/if}
  </div>
</aside>

<style>
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
  }
  .confirm .prose {
    margin: 0;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .driver {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .run-panel {
    display: flex;
    flex-direction: column;
    width: 380px;
    flex-shrink: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    overflow: hidden;
  }
  .questions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-bottom: 1px solid var(--border);
    max-height: 50%;
    overflow-y: auto;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs [role='tab'] {
    display: inline-flex;
    gap: 6px;
    padding: 7px 10px 8px;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .tabs [role='tab'][aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--accent-strong);
  }
  .tabs .close {
    margin-left: auto;
  }
  .count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .panel-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
    overscroll-behavior: contain;
    min-height: 0;
    font-size: var(--text-sm);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--text-md);
  }
  h4 {
    margin: 4px 0 0;
    font-size: var(--text-sm);
  }
  .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
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
    gap: 8px;
  }
  .activation,
  .sessions li,
  .notes li {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .activation.status-failed {
    border-color: var(--danger-border);
  }
  .activation.status-running {
    border-color: var(--accent-border);
  }
  .activation-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .badge {
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    font-size: var(--text-2xs);
  }
  .spacer {
    flex: 1;
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
  .agent {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .agent-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .agent-text > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-title {
    font-weight: 600;
  }
  .history li {
    display: grid;
    grid-template-columns: 52px 1fr;
    gap: 8px;
    font-size: var(--text-xs);
  }
  .history time {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .history span {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
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
  .note-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 900px) {
    .run-panel {
      width: 100%;
    }
    .questions {
      max-height: none;
    }
    .panel-body {
      overflow: visible;
    }
  }
</style>
