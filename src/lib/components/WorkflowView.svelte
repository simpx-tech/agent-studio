<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import {
    CircleAlert,
    CirclePause,
    CirclePlay,
    CircleStop,
    ListTree,
    Maximize2,
    MessageSquare,
    Play,
    Plus,
    Settings2,
    Target,
    Trash2,
    WandSparkles,
    Workflow,
    X,
  } from '@lucide/svelte';
  import WorkflowCanvas from './WorkflowCanvas.svelte';
  import WorkflowInspector from './WorkflowInspector.svelte';
  import WorkflowRunPanel from './WorkflowRunPanel.svelte';
  import WorkflowStart from './WorkflowStart.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import DriverPicker from './DriverPicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import type { Conversation } from '$lib/domain';
  import { jsonEqual } from '$lib/json-equal';
  import type { WorkflowClient } from '$lib/workflow-client.svelte';
  import { mergeDefinition } from '$lib/workflow-merge';
  import {
    graphIssues,
    newNode,
    nodeCatalog,
    nodeTypeIds,
    readDefinition,
    readRun,
    triggerOf,
    type NodeType,
    type WorkflowDefinition,
  } from '$lib/workflow-model';
  import { layeredLayout } from '$lib/workflow-layout';
  import { workflowAgent } from '$lib/workflow-preferences';
  import {
    CARD_WIDTH,
    definitionCards,
    missionCards,
    staticRunCards,
    type WorkflowPickers,
  } from '$lib/workflow-view';
  // A workflow, run or mission (docs/WORKFLOWS.md): as a page of its own, or as the panel beside
  // the chat that changes it (a workflow's assistant) or drives it (a mission's orchestrator).
  let {
    client,
    id,
    pickers,
    conversation,
    openChat,
    openDoc,
    deleteChats,
    closed,
    variant = 'page',
    expand,
    chat,
    close,
    webhookUrl,
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
    /** It was deleted. */
    closed: () => void;
    variant?: 'page' | 'panel';
    /** Shows it as a page of its own, from the panel. */
    expand?: () => void;
    /** Returns to the chat that changes or drives it, from its page. */
    chat?: () => void;
    /** Closes the panel. */
    close?: () => void;
    webhookUrl?: (workflowId: string, nodeId: string, secret: string) => string | undefined;
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
  // Narrow, the side details lie over the graph instead of beside it.
  let width = $state(0);
  const narrow = $derived(variant === 'panel' || (width > 0 && width < 820));

  // ---- A definition being edited: saved as you go, merged with what the agent saves ----------
  let draft = $state<WorkflowDefinition>();
  let base: WorkflowDefinition | undefined;
  let draftRevision = $state<number | null>(null);
  let dirty = $state(false);
  let saving = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let settingsOpen = $state(false);
  let adding = $state(false);
  let starting = $state(false);
  let fit = $state(0);
  // A connection dropped on empty space: the step menu opens where it was dropped.
  let dropMenu = $state<{
    from: { node: string; port: string };
    at: { x: number; y: number };
    screen: { x: number; y: number };
  }>();
  $effect(() => {
    const doc = open?.doc;
    if (!doc || doc.kind !== 'definition') return;
    untrack(() => {
      // Your edits are saved over what arrived; until then they stay as they are.
      if (draftRevision === doc.revision || dirty || saving) return;
      const body = readDefinition(doc.body);
      if (!body) return;
      // A newer version saved elsewhere, as by the agent, fits the graph into view again.
      const changed = draftRevision !== null;
      draft = body;
      base = structuredClone(body);
      draftRevision = doc.revision;
      if (changed) fit++;
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
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 600);
  }
  async function save() {
    clearTimeout(saveTimer);
    if (!draft || !dirty || !base || draftRevision === null) return;
    if (saving) {
      saveTimer = setTimeout(() => void save(), 300);
      return;
    }
    saving = true;
    error = '';
    const sent = structuredClone($state.snapshot(draft)) as WorkflowDefinition;
    const body: WorkflowDefinition = {
      ...sent,
      updatedAt: new Date().toISOString(),
      updatedBy: { kind: 'user' },
    };
    // Triggers other than Run need a computer that watches them.
    if (
      !body.runsOn &&
      body.graph.nodes.some((n) => n.type === 'start' && triggerOf(n) !== 'manual')
    )
      body.runsOn = pickers.defaultDriver;
    try {
      const result = await client.saveDraft(id, draftRevision, base, body);
      base = structuredClone(result.body);
      draftRevision = result.revision;
      const now = $state.snapshot(draft) as WorkflowDefinition;
      if (jsonEqual(now, sent)) {
        draft = result.body;
        dirty = false;
      } else {
        // Edited while it saved: those edits go over what was saved, in the next save.
        draft = mergeDefinition(sent, now, result.body);
        saveTimer = setTimeout(() => void save(), 300);
      }
    } catch (e) {
      error = message(e);
    } finally {
      saving = false;
    }
  }
  onDestroy(() => {
    if (dirty) void save();
  });
  function addStep(
    type: NodeType,
    at?: { x: number; y: number },
    from?: { node: string; port: string },
  ) {
    adding = false;
    dropMenu = undefined;
    edit((definition) => {
      const source = definition.graph.nodes.find((n) => n.id === (from?.node ?? selected));
      const right = Math.max(0, ...definition.graph.nodes.map((n) => n.position.x));
      const position =
        at ??
        (source
          ? { x: source.position.x + CARD_WIDTH + 80, y: source.position.y }
          : { x: right + CARD_WIDTH + 80, y: 0 });
      const node = newNode(
        type,
        position,
        definition.graph.nodes.map((n) => n.key),
      );
      if (type === 'start') node.title = 'Manual';
      // New agents start with the agent chosen last: Claude at its maximum reasoning at first.
      if (type === 'agent' || type === 'screen') {
        const agent = workflowAgent();
        const known = pickers
          .accounts(agent.provider, pickers.here)
          .some((a) => a.id === agent.connectionId);
        node.config = {
          ...node.config,
          provider: agent.provider,
          connectionId: known ? agent.connectionId : '',
          model: agent.model,
          reasoning: agent.reasoning,
        };
      }
      definition.graph.nodes.push(node);
      const port =
        from?.port ?? (source ? nodeCatalog[source.type as NodeType]?.ports[0] : undefined);
      if (source && port && nodeCatalog[type].input)
        definition.graph.edges.push({
          id: `e${crypto.randomUUID().slice(0, 8)}`,
          source: source.id,
          sourcePort: port,
          target: node.id,
        });
      selected = node.id;
      settingsOpen = false;
    });
    if (!at) fit++;
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
  async function run() {
    if (dirty) await save();
    starting = true;
  }
  // The step menu where a connection was dropped stays within the window.
  const dropPlace = $derived.by(() => {
    if (!dropMenu) return undefined;
    const x = Math.min(dropMenu.screen.x, window.innerWidth - 340);
    const y = Math.min(dropMenu.screen.y, window.innerHeight - 320);
    return { x: Math.max(8, x), y: Math.max(8, y) };
  });

  // ---- A run being followed --------------------------------------------------------------------
  const runDoc = $derived(open?.doc.kind === 'run' ? readRun(open.doc.body) : undefined);
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // Cards read their chats' live state each second, not on every streamed event.
  const runGraph = $derived.by(() => {
    void now;
    const current = runDoc;
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
  const active = $derived(runDoc?.status === 'running' || runDoc?.status === 'paused');
  // Narrow, the run's details open on demand, and by themselves when it asks you something.
  let detailsOpen = $state(false);
  const asking = $derived(!!runDoc?.questions.some((q) => q.status === 'pending'));
  $effect(() => {
    if (asking) untrack(() => (detailsOpen = true));
  });
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
    runDoc?.sessions.filter((s) => !s.endedAt).at(-1) ?? runDoc?.sessions.at(-1),
  );
  const title = $derived(
    kind === 'definition'
      ? (draft?.name ?? summary?.title ?? 'Workflow')
      : (runDoc?.title ?? summary?.title ?? 'Run'),
  );
  const steps = $derived(draft?.graph.nodes.length ?? 0);
</script>

<section
  class="workflow-page"
  class:panel={variant === 'panel'}
  class:narrow
  aria-label={title}
  bind:clientWidth={width}
>
  <header class="workflow-toolbar">
    <div class="workflow-heading">
      {#if kind === 'run' && runDoc?.mode === 'dynamic'}<Target
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
            {steps}
            {steps === 1 ? 'step' : 'steps'}{#if saving || dirty}
              · Saving…{/if}
          {:else if runDoc}
            <span class="run-status status-{runDoc.status}">{statusNames[runDoc.status]}</span
            >{#each [runDoc.detail, driverName && active ? `on ${driverName}` : ''].filter(Boolean) as part}<span
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
          <button
            class="secondary"
            aria-expanded={adding}
            aria-label="Add step"
            title="Add step"
            onclick={() => (adding = !adding)}
            ><Plus size={15} /><span class="label">Add step</span></button
          >
          {#if adding}
            <div class="menu" role="menu">
              {#each ['start', ...nodeTypeIds.filter((t) => t !== 'start')] as NodeType[] as type (type)}
                <button role="menuitem" onclick={() => addStep(type)}
                  ><WorkflowIcon {type} /><span>{nodeCatalog[type].label}</span></button
                >
              {/each}
            </div>
          {/if}
        </div>
        <button
          class="secondary"
          title="Arrange the steps neatly"
          aria-label="Arrange the steps"
          onclick={arrange}><WandSparkles size={15} /><span class="label">Arrange</span></button
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
        <button
          class="primary"
          disabled={!!blocking.length}
          aria-label="Run"
          title={blocking.length ? 'Fix what the steps show first' : undefined}
          onclick={() => void run()}><Play size={15} /><span class="label">Run</span></button
        >
      {:else if runDoc}
        {#if runDoc.definition}<button
            class="icon-button"
            title="Open the workflow"
            aria-label="Open the workflow"
            onclick={() => openDoc(runDoc.definition!.id)}><Workflow size={16} /></button
          >{/if}
        {#if variant === 'page' && orchestrator && conversation(orchestrator.conversationId)}<button
            class="icon-button"
            title="Orchestrator chat"
            aria-label="Open the orchestrator's chat"
            onclick={() => openChat(orchestrator.conversationId)}
            ><MessageSquare size={16} /></button
          >{/if}
        {#if narrow}<button
            class="icon-button"
            title="Details"
            aria-label="Run details"
            aria-pressed={detailsOpen}
            onclick={() => (detailsOpen = !detailsOpen)}><ListTree size={16} /></button
          >{/if}
        {#if runDoc.status === 'running'}<button
            class="secondary"
            disabled={busy}
            aria-label="Pause"
            onclick={() => void act(() => client.command(id, 'pause'))}
            ><CirclePause size={15} /><span class="label">Pause</span></button
          >{:else if runDoc.status === 'paused'}<button
            class="secondary"
            disabled={busy}
            aria-label="Resume"
            onclick={() => void act(() => client.command(id, 'resume'))}
            ><CirclePlay size={15} /><span class="label">Resume</span></button
          >{/if}
        {#if active}<button
            class="secondary"
            disabled={busy}
            aria-label="Stop"
            onclick={() => (confirming = 'stop')}
            ><CircleStop size={15} /><span class="label">Stop</span></button
          >{:else}<button
            class="icon-button"
            title="Delete run"
            aria-label="Delete this run"
            onclick={() => (confirming = 'delete')}><Trash2 size={16} /></button
          >{/if}
      {/if}
      {#if variant === 'page' && chat}<button
          class="icon-button"
          title="Chat"
          aria-label="Show its chat"
          onclick={chat}><MessageSquare size={16} /></button
        >{/if}
      {#if variant === 'panel'}
        {#if expand}<button
            class="icon-button"
            title="Expand"
            aria-label="Show the workflow as a page"
            onclick={expand}><Maximize2 size={15} /></button
          >{/if}
        {#if close}<button
            class="icon-button"
            title="Close"
            aria-label="Close the workflow panel"
            onclick={close}><X size={16} /></button
          >{/if}
      {/if}
    </div>
  </header>
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
          dropMenu = undefined;
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
        dropped={(from, at, screen) => {
          adding = false;
          dropMenu = { from, at, screen };
        }}
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
          webhookUrl={webhookUrl ? (nodeId, secret) => webhookUrl(id, nodeId, secret) : undefined}
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
          <header>
            <h2>Workflow</h2>
            <button
              class="icon-button"
              aria-label="Close workflow settings"
              onclick={() => (settingsOpen = false)}><X size={16} /></button
            >
          </header>
          <label class="field"
            ><span>Description</span><textarea
              rows="4"
              value={draft.description}
              oninput={(event) => edit((d) => (d.description = event.currentTarget.value))}
            ></textarea></label
          >
          <DriverPicker
            drivers={pickers.drivers}
            value={{
              preferred: draft.runsOn || pickers.defaultDriver,
              elsewhere: draft.elsewhere,
              ...(draft.continueOn ? { continueOn: draft.continueOn } : {}),
            }}
            onchange={(next) =>
              edit((d) => {
                d.runsOn = next.preferred;
                d.elsewhere = next.elsewhere;
                d.continueOn = next.continueOn;
              })}
          />
          {#if issues.length}
            <ul class="issue-list">
              {#each issues as issue, index (index)}<li class:blocking={issue.blocking}>
                  {issue.message}
                </li>{/each}
            </ul>
          {/if}
        </aside>
      {/if}
      {#if dropMenu && dropPlace}
        <div
          class="menu drop-menu"
          role="menu"
          aria-label="Add a step here"
          style:left={`${dropPlace.x}px`}
          style:top={`${dropPlace.y}px`}
        >
          {#each nodeTypeIds.filter((t) => t !== 'start') as type (type)}
            <button role="menuitem" onclick={() => addStep(type, dropMenu!.at, dropMenu!.from)}
              ><WorkflowIcon {type} /><span>{nodeCatalog[type].label}</span></button
            >
          {/each}
        </div>
      {/if}
    {:else if runDoc && runGraph}
      <WorkflowCanvas
        label={runDoc.mode === 'dynamic' ? 'Mission graph' : 'Run steps'}
        cards={runGraph.cards}
        links={runGraph.links}
        {selected}
        select={(next) => {
          selected = next;
          if (next) detailsOpen = true;
        }}
        {openChat}
      />
      {#if !narrow || detailsOpen}
        <WorkflowRunPanel
          run={runDoc}
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
          drivers={pickers.drivers}
          changeDriver={(next) => void act(() => client.command(id, 'driver', undefined, next))}
          close={narrow ? () => (detailsOpen = false) : undefined}
        />
      {/if}
    {:else}
      <p class="workflow-status" role="status">
        {summary || client.mode === 'loading' ? 'Opening…' : 'This workflow is no longer saved.'}
      </p>
    {/if}
  </div>
</section>
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && (dropMenu || adding)) {
      dropMenu = undefined;
      adding = false;
    }
  }}
/>
{#if starting && draft}<WorkflowStart
    definition={draft}
    {pickers}
    close={() => (starting = false)}
    start={async (inputs, driver, trigger) => {
      const runId = await client.startRun(id, inputs, driver, { kind: 'user' }, trigger);
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
            const chats = runDoc
              ? runDoc.agents.filter((a) => !a.listed).map((a) => a.conversationId)
              : [];
            await client.remove(id);
            if (alsoChats && chats.length) await deleteChats(chats);
            closed();
          });
        else
          void act(async () => {
            const assistant = draft?.assistant?.conversationId;
            await client.remove(id);
            if (alsoChats && assistant) await deleteChats([assistant]);
            closed();
          });
      }}
    >
      <p>
        {#if confirming === 'stop'}Stop <strong>{title}</strong>? Its running replies stop too.
        {:else if confirming === 'delete'}Delete the run <strong>{title}</strong> and its history?
        {:else}Delete <strong>{title}</strong>? Its runs stay.{/if}
      </p>
      {#if confirming === 'delete' && runDoc?.agents.some((a) => !a.listed)}<label class="checkbox"
          ><input type="checkbox" bind:checked={alsoChats} />Also delete its {runDoc.agents.filter(
            (a) => !a.listed,
          ).length}
          chats</label
        >{/if}
      {#if confirming === 'deleteDefinition' && draft?.assistant}<label class="checkbox"
          ><input type="checkbox" bind:checked={alsoChats} />Also delete its chat</label
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
    container-type: inline-size;
  }
  .workflow-page.panel {
    padding: 10px 12px 12px;
  }
  .workflow-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    flex-wrap: wrap;
  }
  /* The buttons go below the name when it would have less than this beside them. */
  .workflow-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 150px;
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
  .panel .workflow-heading h1,
  .panel .title-input {
    font-size: var(--text-md);
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
    margin-left: auto;
  }
  /* Too narrow for the buttons' names, they keep their icons and their names on hover. */
  @container (max-width: 520px) {
    .workflow-tools .label {
      display: none;
    }
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
  .drop-menu {
    position: fixed;
    right: auto;
    z-index: 40;
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
    position: relative;
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
    overflow-x: hidden;
    overflow-y: auto;
  }
  .workflow-settings header {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
  .error-banner {
    margin: 0;
  }
  /* Narrow, step settings and run details lie over the graph's right side. */
  .narrow .workflow-body > :global(aside) {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 5;
    width: min(360px, calc(100% - 16px));
    max-height: none;
    box-shadow: var(--shadow-lg);
  }
  @media (max-width: 600px) {
    .workflow-page:not(.panel) {
      padding: 8px 10px 10px;
    }
  }
</style>
