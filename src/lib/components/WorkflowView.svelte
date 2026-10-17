<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    CircleAlert,
    CirclePause,
    CirclePlay,
    CircleStop,
    Copy,
    LayoutGrid,
    MessageSquare,
    Play,
    Plus,
    Save,
    Settings2,
    Target,
    Trash2,
    Workflow,
  } from '@lucide/svelte';
  import WorkflowCanvas from './WorkflowCanvas.svelte';
  import WorkflowInspector from './WorkflowInspector.svelte';
  import WorkflowRunPanel from './WorkflowRunPanel.svelte';
  import WorkflowStart from './WorkflowStart.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import type { Conversation } from '$lib/domain';
  import type { WorkflowClient } from '$lib/workflow-client.svelte';
  import {
    graphIssues,
    newNode,
    nodeCatalog,
    nodeTypeIds,
    readDefinition,
    readRun,
    type NodeType,
    type WorkflowDefinition,
  } from '$lib/workflow-model';
  import { layeredLayout } from '$lib/workflow-layout';
  import {
    CARD_WIDTH,
    definitionCards,
    missionCards,
    staticRunCards,
    type WorkflowPickers,
  } from '$lib/workflow-view';
  let {
    client,
    id,
    pickers,
    conversation,
    openChat,
    openDoc,
    deleteChats,
    closed,
  }: {
    client: WorkflowClient;
    id: string;
    pickers: WorkflowPickers;
    conversation: (id: string) => Conversation | undefined;
    openChat: (conversationId: string) => void;
    /** Opens another workflow or run. */
    openDoc: (id: string) => void;
    /** Deletes chats a deleted run started. */
    deleteChats: (ids: string[]) => Promise<void>;
    closed: () => void;
  } = $props();
  // Follows the document while it is shown; reading the cache here must not restart it.
  $effect(() => {
    const target = id;
    return untrack(() => client.watch(target));
  });
  const open = $derived(client.doc(id));
  const summary = $derived(client.summaries.get(id));
  const kind = $derived(open?.doc.kind ?? summary?.kind);
  const message = (e: unknown) => String(e).replace(/^Error: /, '');
  let error = $state('');
  let selected = $state<string>();

  // ---- A definition being edited ---------------------------------------------------------------
  let draft = $state<WorkflowDefinition>();
  let draftRevision = $state<number | null>(null);
  let dirty = $state(false);
  let conflict = $state(false);
  let saving = $state(false);
  let settingsOpen = $state(false);
  let adding = $state(false);
  let starting = $state(false);
  let fit = $state(0);
  $effect(() => {
    const doc = open?.doc;
    if (!doc || doc.kind !== 'definition') return;
    untrack(() => {
      // A save in flight takes its own revision when it returns.
      if (saving || draftRevision === doc.revision) return;
      if (dirty && draftRevision !== null) {
        conflict = true;
        return;
      }
      draft = readDefinition(doc.body);
      draftRevision = doc.revision;
      conflict = false;
    });
  });
  const issues = $derived(draft ? graphIssues(draft.graph) : []);
  const blocking = $derived(issues.filter((i) => i.blocking));
  const names = {
    computer: (environmentId: string) => pickers.computerName(environmentId),
    account: (connectionId?: string) => pickers.accountName(connectionId),
  };
  const editorGraph = $derived(draft ? definitionCards(draft.graph, issues, names) : undefined);
  const selectedNode = $derived(draft?.graph.nodes.find((n) => n.id === selected));
  function edit(update: (definition: WorkflowDefinition) => void) {
    if (!draft) return;
    const next = structuredClone($state.snapshot(draft)) as WorkflowDefinition;
    update(next);
    draft = next;
    dirty = true;
  }
  function addStep(type: NodeType) {
    adding = false;
    edit((definition) => {
      const from = definition.graph.nodes.find((n) => n.id === selected);
      const right = Math.max(0, ...definition.graph.nodes.map((n) => n.position.x));
      const position = from
        ? { x: from.position.x + CARD_WIDTH + 80, y: from.position.y }
        : { x: right + CARD_WIDTH + 80, y: 0 };
      const node = newNode(
        type,
        position,
        definition.graph.nodes.map((n) => n.key),
      );
      definition.graph.nodes.push(node);
      const port = from ? nodeCatalog[from.type as NodeType]?.ports[0] : undefined;
      if (from && port)
        definition.graph.edges.push({
          id: `e${crypto.randomUUID().slice(0, 8)}`,
          source: from.id,
          sourcePort: port,
          target: node.id,
        });
      selected = node.id;
    });
    fit++;
  }
  function arrange() {
    edit((definition) => {
      const positions = layeredLayout(
        definition.graph.nodes.map((n) => ({ id: n.id, width: CARD_WIDTH, height: 110 })),
        definition.graph.edges,
        { gapX: 80, gapY: 40 },
      );
      for (const node of definition.graph.nodes)
        node.position = positions.get(node.id) ?? node.position;
    });
    fit++;
  }
  async function save(asCopy = false) {
    if (!draft || saving) return;
    saving = true;
    error = '';
    try {
      const now = new Date().toISOString();
      const body: WorkflowDefinition = {
        ...structuredClone($state.snapshot(draft)),
        ...(asCopy
          ? { name: `${draft.name} (copy)`, createdAt: now, createdBy: { kind: 'user' } }
          : {}),
        updatedAt: now,
        updatedBy: { kind: 'user' },
      } as WorkflowDefinition;
      if (
        body.graph.nodes.some(
          (n) =>
            n.type === 'start' && Array.isArray(n.config.schedules) && n.config.schedules.length,
        ) &&
        !body.runsOn
      )
        body.runsOn = pickers.defaultDriver;
      const target = asCopy ? crypto.randomUUID() : id;
      const result = await client.saveDefinition(target, asCopy ? null : draftRevision, body);
      if (!result.ok) {
        conflict = true;
        return;
      }
      if (asCopy) {
        openDoc(target);
        return;
      }
      draftRevision = result.doc.revision;
      dirty = false;
      conflict = false;
    } catch (e) {
      error = message(e);
    } finally {
      saving = false;
    }
  }
  function reload() {
    dirty = false;
    draftRevision = null;
    conflict = false;
    const doc = open?.doc;
    if (doc?.kind === 'definition') {
      draft = readDefinition(doc.body);
      draftRevision = doc.revision;
    }
  }

  // ---- A run being followed --------------------------------------------------------------------
  const run = $derived(open?.doc.kind === 'run' ? readRun(open.doc.body) : undefined);
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Cards read their chats' live state each second, not on every streamed event.
  const runGraph = $derived.by(() => {
    void now;
    const current = run;
    if (!current) return undefined;
    return untrack(() => {
      const chats = new Map<string, Conversation | undefined>();
      const lookup = (conversationId: string) => {
        if (!chats.has(conversationId)) chats.set(conversationId, conversation(conversationId));
        return chats.get(conversationId);
      };
      return current.mode === 'static'
        ? staticRunCards(current, lookup, names)
        : missionCards(current, lookup, names);
    });
  });
  const lease = $derived(client.leases[id]);
  const driverName = $derived(
    lease && lease.expiresAt > client.now ? pickers.computerName(lease.holder) : '',
  );
  const active = $derived(run?.status === 'running' || run?.status === 'paused');
  let confirming = $state<'stop' | 'delete' | 'deleteDefinition'>();
  let alsoChats = $state(true);
  let busy = $state(false);
  async function act(work: () => Promise<void>) {
    busy = true;
    error = '';
    try {
      await work();
      confirming = undefined;
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }
  const statusNames: Record<string, string> = {
    running: 'Running',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
  };
  const orchestrator = $derived(
    run?.sessions.filter((s) => !s.endedAt).at(-1) ?? run?.sessions.at(-1),
  );
  const title = $derived(
    kind === 'definition'
      ? (draft?.name ?? summary?.title ?? 'Workflow')
      : (run?.title ?? summary?.title ?? 'Run'),
  );
</script>

<section class="workflow-page" aria-label={title}>
  <header class="workflow-toolbar">
    <div class="workflow-heading">
      {#if kind === 'run' && run?.mode === 'dynamic'}<Target
          size={17}
          aria-hidden="true"
        />{:else}<Workflow size={17} aria-hidden="true" />{/if}
      <div>
        {#if kind === 'definition' && draft}
          <input
            class="title-input"
            aria-label="Workflow name"
            value={draft.name}
            oninput={(event) => edit((d) => (d.name = event.currentTarget.value || 'Workflow'))}
          />
        {:else}<h1>{title}</h1>{/if}
        <p>
          {#if kind === 'definition'}
            {draft?.graph.nodes.length ?? 0}
            {draft?.graph.nodes.length === 1 ? 'step' : 'steps'}{#if dirty}
              · Not saved{/if}
          {:else if run}
            <span class="run-status status-{run.status}">{statusNames[run.status]}</span
            >{#each [run.detail, driverName && active ? `on ${driverName}` : ''].filter(Boolean) as part}<span
                >{` · ${part}`}</span
              >{/each}
          {/if}
        </p>
      </div>
    </div>
    <div class="workflow-tools">
      {#if kind === 'definition' && draft}
        {#if blocking.length}<span class="issues" title={blocking.map((i) => i.message).join('\n')}
            ><CircleAlert size={14} aria-hidden="true" />{blocking.length}</span
          >{/if}
        <div class="add-menu">
          <button class="secondary" aria-expanded={adding} onclick={() => (adding = !adding)}
            ><Plus size={15} />Add step</button
          >
          {#if adding}
            <div class="menu" role="menu">
              {#each nodeTypeIds.filter((t) => t !== 'start') as type (type)}
                <button role="menuitem" onclick={() => addStep(type)}
                  ><WorkflowIcon {type} /><span>{nodeCatalog[type].label}</span></button
                >
              {/each}
            </div>
          {/if}
        </div>
        <button class="icon-button" title="Arrange" aria-label="Arrange the steps" onclick={arrange}
          ><LayoutGrid size={16} /></button
        >
        <button
          class="icon-button"
          title="Workflow settings"
          aria-label="Workflow settings"
          aria-pressed={settingsOpen}
          onclick={() => {
            settingsOpen = !settingsOpen;
            if (settingsOpen) selected = undefined;
          }}><Settings2 size={16} /></button
        >
        <button
          class="icon-button"
          title="Delete workflow"
          aria-label="Delete this workflow"
          onclick={() => (confirming = 'deleteDefinition')}><Trash2 size={16} /></button
        >
        <button class="secondary" disabled={!dirty || saving} onclick={() => void save()}
          ><Save size={15} />{saving ? 'Saving…' : 'Save'}</button
        >
        <button
          class="primary"
          disabled={!!blocking.length || dirty}
          title={dirty
            ? 'Save first'
            : blocking.length
              ? 'Fix what the steps show first'
              : undefined}
          onclick={() => (starting = true)}><Play size={15} />Run</button
        >
      {:else if run}
        {#if run.definition}<button
            class="icon-button"
            title="Open the workflow"
            aria-label="Open the workflow"
            onclick={() => openDoc(run.definition!.id)}><Workflow size={16} /></button
          >{/if}
        {#if orchestrator && conversation(orchestrator.conversationId)}<button
            class="icon-button"
            title="Orchestrator chat"
            aria-label="Open the orchestrator's chat"
            onclick={() => openChat(orchestrator.conversationId)}
            ><MessageSquare size={16} /></button
          >{/if}
        {#if run.status === 'running'}<button
            class="secondary"
            disabled={busy}
            onclick={() => void act(() => client.command(id, 'pause'))}
            ><CirclePause size={15} />Pause</button
          >{:else if run.status === 'paused'}<button
            class="secondary"
            disabled={busy}
            onclick={() => void act(() => client.command(id, 'resume'))}
            ><CirclePlay size={15} />Resume</button
          >{/if}
        {#if active}<button class="secondary" disabled={busy} onclick={() => (confirming = 'stop')}
            ><CircleStop size={15} />Stop</button
          >{:else}<button
            class="icon-button"
            title="Delete run"
            aria-label="Delete this run"
            onclick={() => (confirming = 'delete')}><Trash2 size={16} /></button
          >{/if}
      {/if}
    </div>
  </header>
  {#if conflict}<div class="setup-hint" role="status">
      <CircleAlert size={15} aria-hidden="true" /><span>This workflow changed elsewhere.</span>
      <button class="text-button" onclick={reload}>Reload</button>
      <button class="text-button" onclick={() => void save(true)}
        ><Copy size={13} />Save as a copy</button
      >
    </div>{/if}
  {#if error || client.error}<div class="error-banner" role="alert">
      <CircleAlert size={15} aria-hidden="true" />{error || client.error}
    </div>{/if}
  <div class="workflow-body">
    {#if kind === 'definition' && draft && editorGraph}
      <WorkflowCanvas
        label="Workflow steps"
        cards={editorGraph.cards}
        links={editorGraph.links}
        editable
        {fit}
        {selected}
        select={(next) => {
          selected = next;
          if (next) settingsOpen = false;
        }}
        connect={(source, port, target) =>
          edit((d) => {
            if (
              d.graph.edges.some(
                (e) => e.source === source && e.sourcePort === port && e.target === target,
              )
            )
              return;
            d.graph.edges.push({
              id: `e${crypto.randomUUID().slice(0, 8)}`,
              source,
              sourcePort: port,
              target,
            });
          })}
        remove={(nodes, edges) =>
          edit((d) => {
            d.graph.nodes = d.graph.nodes.filter((n) => !nodes.includes(n.id));
            d.graph.edges = d.graph.edges.filter(
              (e) =>
                !edges.includes(e.id) && !nodes.includes(e.source) && !nodes.includes(e.target),
            );
            if (selected && nodes.includes(selected)) selected = undefined;
          })}
        moved={(node, position) =>
          edit((d) => {
            const step = d.graph.nodes.find((n) => n.id === node);
            if (step) step.position = position;
          })}
      />
      {#if selectedNode}
        <WorkflowInspector
          node={selectedNode}
          graph={draft.graph}
          {pickers}
          change={(node) =>
            edit((d) => {
              d.graph.nodes = d.graph.nodes.map((n) => (n.id === node.id ? node : n));
            })}
          remove={() =>
            edit((d) => {
              const gone = selectedNode.id;
              d.graph.nodes = d.graph.nodes.filter((n) => n.id !== gone);
              d.graph.edges = d.graph.edges.filter((e) => e.source !== gone && e.target !== gone);
              selected = undefined;
            })}
          close={() => (selected = undefined)}
        />
      {:else if settingsOpen}
        <aside class="workflow-settings" aria-label="Workflow settings">
          <h2>Workflow</h2>
          <label class="field"
            ><span>Description</span><textarea
              rows="4"
              value={draft.description}
              oninput={(event) => edit((d) => (d.description = event.currentTarget.value))}
            ></textarea></label
          >
          <div class="field">
            <span>Scheduled runs run on</span>
            <ChoicePicker
              field
              label="Scheduled runs run on"
              options={pickers.drivers}
              value={draft.runsOn || pickers.defaultDriver}
              onchange={(value) => edit((d) => (d.runsOn = value))}
            />
          </div>
          <label class="checkbox"
            ><input
              type="checkbox"
              checked={draft.elsewhere}
              onchange={(event) => edit((d) => (d.elsewhere = event.currentTarget.checked))}
            />Continue on another computer while it is offline</label
          >
          {#if issues.length}
            <ul class="issue-list">
              {#each issues as issue, index (index)}<li class:blocking={issue.blocking}>
                  {issue.message}
                </li>{/each}
            </ul>
          {/if}
        </aside>
      {/if}
    {:else if run && runGraph}
      <WorkflowCanvas
        label={run.mode === 'dynamic' ? 'Mission graph' : 'Run steps'}
        cards={runGraph.cards}
        links={runGraph.links}
        {selected}
        select={(next) => (selected = next)}
        {openChat}
      />
      <WorkflowRunPanel
        {run}
        events={open?.events ?? []}
        {selected}
        {conversation}
        computerName={pickers.computerName}
        accountName={pickers.accountName}
        {openChat}
        openRun={openDoc}
        command={(kind, activationId) => void act(() => client.command(id, kind, activationId))}
        answer={(answer) => client.answerQuestion(id, answer)}
        saveNote={(note) => client.writeNote(id, note)}
      />
    {:else}
      <p class="workflow-status" role="status">
        {summary || client.mode === 'loading' ? 'Opening…' : 'This workflow is no longer saved.'}
      </p>
    {/if}
  </div>
</section>
{#if starting && draft}<WorkflowStart
    definition={draft}
    {pickers}
    close={() => (starting = false)}
    start={async (inputs, driver) => {
      const runId = await client.startRun(id, inputs, driver, { kind: 'user' });
      starting = false;
      openDoc(runId);
    }}
  />{/if}
{#if confirming}<ConnectionDialog
    title={confirming === 'stop'
      ? 'Stop run'
      : confirming === 'delete'
        ? 'Delete run'
        : 'Delete workflow'}
    {busy}
    close={() => (confirming = undefined)}
  >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (confirming === 'stop') void act(() => client.command(id, 'stop'));
        else if (confirming === 'delete')
          void act(async () => {
            const chats = run
              ? run.agents.filter((a) => !a.listed).map((a) => a.conversationId)
              : [];
            await client.remove(id);
            if (alsoChats && chats.length) await deleteChats(chats);
            closed();
          });
        else
          void act(async () => {
            await client.remove(id);
            closed();
          });
      }}
    >
      <p>
        {#if confirming === 'stop'}Stop <strong>{title}</strong>? Its running replies stop too.
        {:else if confirming === 'delete'}Delete the run <strong>{title}</strong> and its history?
        {:else}Delete <strong>{title}</strong>? Its runs stay.{/if}
      </p>
      {#if confirming === 'delete' && run?.agents.some((a) => !a.listed)}<label class="checkbox"
          ><input type="checkbox" bind:checked={alsoChats} />Also delete its {run.agents.filter(
            (a) => !a.listed,
          ).length}
          chats</label
        >{/if}
      {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onclick={() => (confirming = undefined)}>Cancel</button
        ><button type="submit" class="danger" disabled={busy}
          >{confirming === 'stop' ? 'Stop run' : 'Delete'}</button
        >
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .workflow-page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 12px 20px 16px;
    gap: 10px;
  }
  .workflow-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .workflow-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .workflow-heading > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  .workflow-heading div {
    min-width: 0;
    flex: 1;
  }
  .workflow-heading h1,
  .title-input {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title-input {
    width: 100%;
    max-width: 480px;
    padding: 2px 6px;
    margin-left: -7px;
    border-color: transparent;
    background: transparent;
  }
  .title-input:hover {
    border-color: var(--border);
  }
  .workflow-heading p {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-status.status-running {
    color: var(--accent-text);
  }
  .run-status.status-failed {
    color: var(--danger);
  }
  .run-status.status-completed {
    color: var(--success);
  }
  .run-status.status-paused {
    color: var(--warning);
  }
  .workflow-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .issues {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .add-menu {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    display: grid;
    grid-template-columns: repeat(2, minmax(140px, 1fr));
    gap: 2px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-lg);
  }
  .menu button {
    justify-content: flex-start;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .menu button:hover {
    background: var(--hover);
  }
  .workflow-body {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 10px;
  }
  .workflow-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 340px;
    flex-shrink: 0;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    overflow-y: auto;
  }
  .workflow-settings h2 {
    margin: 0;
    font-size: var(--text-md);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .field > span {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .issue-list {
    margin: 0;
    padding-left: 18px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .issue-list .blocking {
    color: var(--danger);
  }
  .workflow-status {
    margin: 0;
    padding: 20px 24px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .setup-hint,
  .error-banner {
    margin: 0;
  }
  .setup-hint .text-button {
    display: inline-flex;
    gap: 4px;
  }
  @media (max-width: 900px) {
    /* The page scrolls as a whole: the graph, then its details at their own height. */
    .workflow-page {
      padding: 8px 10px 10px;
      overflow-y: auto;
    }
    .workflow-body {
      flex: none;
      flex-direction: column;
    }
    .workflow-body > :global(.workflow-canvas) {
      flex: none;
      height: 55dvh;
      min-height: 300px;
    }
    .workflow-body > :global(aside) {
      max-height: none;
      overflow: visible;
    }
    .workflow-settings {
      width: 100%;
    }
  }
</style>
