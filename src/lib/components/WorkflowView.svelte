<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import {
    ArrowLeft,
    CircleAlert,
    CircleCheck,
    CirclePause,
    CirclePlay,
    CircleStop,
    CircleX,
    Copy,
    History,
    LoaderCircle,
    Maximize2,
    MessageCircleQuestionMark,
    MessageSquare,
    Play,
    Plus,
    Settings2,
    SquareArrowOutUpRight,
    Target,
    Trash2,
    WandSparkles,
    Workflow,
    X,
  } from '@lucide/svelte';
  import WorkflowView from './WorkflowView.svelte';
  import WorkflowCanvas from './WorkflowCanvas.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import WorkflowInspector from './WorkflowInspector.svelte';
  import WorkflowRunPanel from './WorkflowRunPanel.svelte';
  import PanelResize from './PanelResize.svelte';
  import WorkflowStart from './WorkflowStart.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import DriverPicker from './DriverPicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import type { Conversation } from '$lib/domain';
  import { jsonEqual } from '$lib/json-equal';
  import { formatReplyTime } from '$lib/replies';
  import type { WorkflowClient } from '$lib/workflow-client.svelte';
  import { mergeDefinition } from '$lib/workflow-merge';
  import {
    freshKey,
    freshNodeId,
    graphIssues,
    newNode,
    nodeCatalog,
    nodeConfig,
    nodeTypeIds,
    readDefinition,
    readRun,
    runActive,
    triggerLabels,
    triggerOf,
    webhookSecret,
    WORKFLOW_ACCOUNT,
    type NodeType,
    type RunDriverChoice,
    type TriggerKind,
    type WorkflowDefinition,
    type WorkflowSummary,
  } from '$lib/workflow-model';
  import { arrangeSteps, flowPorts, flowsSideways, STEP_HEIGHT } from '$lib/workflow-layout';
  import { workflowAgent } from '$lib/workflow-preferences';
  import {
    CARD_WIDTH,
    definitionCards,
    missionCards,
    runStatusNames,
    runTime,
    staticRunCards,
    type WorkflowPickers,
  } from '$lib/workflow-view';
  // A workflow or a run of one, static or dynamic (docs/WORKFLOWS.md): as a page of its own, or as
  // the panel beside the chat that changes it (a static workflow's assistant) or drives it (a
  // dynamic workflow's orchestrator). A workflow shows its graph, which you edit, and its runs in
  // a picker beside Run; a run opens in its place, its graph beside its history.
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
    chatShown = false,
    close,
    back,
    switchRun,
    run = $bindable(),
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
    /** Shows it as a page of its own, from the panel, with the run it shows. */
    expand?: (run?: string) => void;
    /** Shows its chat: returns to it from its page, or opens and closes it beside the graph. */
    chat?: () => void;
    /** Whether its chat shows beside it. */
    chatShown?: boolean;
    /** Closes the panel. */
    close?: () => void;
    /** Returns to the workflow whose run this is. */
    back?: () => void;
    /** Shows another run of the workflow in this one's place. */
    switchRun?: (id: string) => void;
    /** The run of this workflow it shows in its place. */
    run?: string;
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
  // The card whose entries a run's history shows alone, chosen on its graph.
  let filter = $state<string>();
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
  // A right-click on the graph: a menu of what can be done there.
  let contextMenu = $state<{
    kind: 'pane' | 'node' | 'edge';
    id?: string;
    at: { x: number; y: number };
    screen: { x: number; y: number };
  }>();
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
      base = structuredClone(body);
      // Steps laid out from left to right, before graphs flowed downwards, are laid out again.
      if (flowsSideways(body.graph.nodes, body.graph.edges)) {
        const positions = arrangeSteps(body.graph.nodes, body.graph.edges);
        for (const node of body.graph.nodes)
          node.position = positions.get(node.id) ?? node.position;
      }
      draft = body;
      draftRevision = doc.revision;
      if (changed) fit++;
    });
  });
  const issues = $derived(draft ? graphIssues(draft.graph) : []);
  const blocking = $derived(issues.filter((i) => i.blocking));
  const names = {
    computer: (environmentId: string) => pickers.computerName(environmentId),
    account: (connectionId?: string) => pickers.accountName(connectionId),
    workflow: (workflowId: string) => client.summaries.get(workflowId)?.title,
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
  // Steps go below the step they follow, a step's branches side by side in its ports' order and
  // its error branch beside it; a step added on its own goes below the lowest one.
  const rowGap = 64;
  const columnGap = 40;
  function addStep(
    type: NodeType,
    at?: { x: number; y: number },
    from?: { node: string; port: string },
  ) {
    adding = false;
    dropMenu = undefined;
    edit((definition) => {
      const source = definition.graph.nodes.find((n) => n.id === (from?.node ?? selected));
      const port =
        from?.port ?? (source ? nodeCatalog[source.type as NodeType]?.ports[0] : undefined);
      const lowest = definition.graph.nodes.reduce<
        (typeof definition.graph.nodes)[number] | undefined
      >((low, n) => (!low || n.position.y > low.position.y ? n : low), undefined);
      let position = at;
      if (!position && source) {
        const ports = flowPorts(source.type);
        const index = ports.indexOf(port ?? 'out');
        const offset =
          port === 'error'
            ? CARD_WIDTH + columnGap
            : ports.length > 1 && index >= 0
              ? (index - (ports.length - 1) / 2) * (CARD_WIDTH + columnGap)
              : 0;
        position = { x: source.position.x + offset, y: source.position.y + STEP_HEIGHT + rowGap };
      }
      position ??= lowest
        ? { x: lowest.position.x, y: lowest.position.y + STEP_HEIGHT + rowGap }
        : { x: 0, y: 0 };
      const node = newNode(
        type,
        position,
        definition.graph.nodes.map((n) => n.key),
      );
      if (type === 'start') node.title = 'Manual';
      // New agents start with the agent chosen last: Claude at its maximum reasoning at first,
      // on the least used account while new chats start on one.
      if (type === 'agent' || type === 'screen') {
        const agent = workflowAgent();
        const known =
          agent.connectionId === WORKFLOW_ACCOUNT ||
          (!pickers.balancing &&
            pickers
              .accounts(agent.provider, pickers.here)
              .some((a) => a.id === agent.connectionId));
        node.config = {
          ...node.config,
          provider: agent.provider,
          connectionId: known ? agent.connectionId : '',
          model: agent.model,
          reasoning: agent.reasoning,
        };
      }
      definition.graph.nodes.push(node);
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
      const positions = arrangeSteps(definition.graph.nodes, definition.graph.edges);
      for (const node of definition.graph.nodes)
        node.position = positions.get(node.id) ?? node.position;
    });
    fit++;
  }
  // Run starts at once when there is nothing to choose: one trigger without inputs, and one
  // computer to run on.
  async function startRun() {
    if (dirty) await save();
    if (!draft) return;
    const triggers = draft.graph.nodes.filter((n) => n.type === 'start');
    const only = triggers.length === 1 ? triggers[0] : undefined;
    if (!only || nodeConfig(only, 'start').inputs.length || pickers.drivers.length > 1) {
      starting = true;
      return;
    }
    error = '';
    try {
      await begin({}, defaultDriver(draft), only.id);
    } catch (e) {
      error = message(e);
    }
  }
  const defaultDriver = (definition: WorkflowDefinition): RunDriverChoice => ({
    preferred: pickers.defaultDriver,
    elsewhere: definition.elsewhere,
    ...(definition.continueOn ? { continueOn: definition.continueOn } : {}),
  });
  async function begin(inputs: Record<string, string>, driver: RunDriverChoice, trigger: string) {
    const runId = await client.startRun(id, inputs, driver, { kind: 'user' }, trigger);
    starting = false;
    run = runId;
  }
  /** A copy of a step beside it, with a key, schedules and a webhook address of its own. */
  function duplicate(id: string) {
    edit((definition) => {
      const node = definition.graph.nodes.find((n) => n.id === id);
      if (!node) return;
      const copy = structuredClone($state.snapshot(node)) as typeof node;
      copy.id = freshNodeId();
      copy.key = freshKey(
        node.type,
        definition.graph.nodes.map((n) => n.key),
      );
      copy.position = { x: node.position.x + 40, y: node.position.y + 40 };
      const config = copy.config as {
        schedules?: { id: string }[];
        webhook?: { secret?: string };
      };
      if (Array.isArray(config.schedules))
        config.schedules = config.schedules.map((s) => ({
          ...s,
          id: crypto.randomUUID().slice(0, 8),
        }));
      if (config.webhook?.secret) config.webhook = { ...config.webhook, secret: webhookSecret() };
      definition.graph.nodes.push(copy);
      selected = copy.id;
      settingsOpen = false;
    });
  }
  /** Removes a step and its connections, keeping a workflow's last trigger. */
  function removeStep(id: string) {
    edit((definition) => {
      const node = definition.graph.nodes.find((n) => n.id === id);
      if (
        !node ||
        (node.type === 'start' &&
          definition.graph.nodes.filter((n) => n.type === 'start').length < 2)
      )
        return;
      definition.graph.nodes = definition.graph.nodes.filter((n) => n.id !== id);
      definition.graph.edges = definition.graph.edges.filter(
        (e) => e.source !== id && e.target !== id,
      );
      if (selected === id) selected = undefined;
    });
  }
  // The chat, the history and the run a run's card leads to.
  const cardTargets = (id: string) => {
    const card = runGraph?.cards.find((c) => c.id === id);
    if (!card) return {};
    const rows = [...card.data.rows].reverse();
    return {
      chat: card.data.conversationId ?? rows.find((r) => r.conversationId)?.conversationId,
      run:
        (typeof card.data.runId === 'string' ? card.data.runId : undefined) ??
        rows.find((r) => r.runId)?.runId,
    };
  };
  /**
   * Closes the right-click menu and does what its item does with what the menu was opened on,
   * read before closing it, since the menu's own values follow it.
   */
  function fromMenu(run: (target: NonNullable<typeof contextMenu>) => void) {
    const target = contextMenu;
    contextMenu = undefined;
    if (target) run(target);
  }
  // The menu takes the keyboard while it is open, so Escape and the arrow keys reach it rather
  // than the step that had focus, and gives focus back when Escape closes it.
  let menuElement = $state<HTMLElement>();
  let menuReturn: HTMLElement | undefined;
  function openContextMenu(next: NonNullable<typeof contextMenu>) {
    adding = false;
    dropMenu = undefined;
    menuReturn = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    contextMenu = next;
  }
  $effect(() => {
    menuElement?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  });
  function menuKey(event: KeyboardEvent) {
    const items = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? at + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? at - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : undefined;
    if (next === undefined || !items.length) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  }
  const menuPlace = $derived.by(() => {
    if (!contextMenu) return undefined;
    const x = Math.min(contextMenu.screen.x, window.innerWidth - 340);
    const y = Math.min(contextMenu.screen.y, window.innerHeight - 340);
    return { x: Math.max(8, x), y: Math.max(8, y) };
  });
  // The step menu where a connection was dropped stays within the window.
  const dropPlace = $derived.by(() => {
    if (!dropMenu) return undefined;
    const x = Math.min(dropMenu.screen.x, window.innerWidth - 340);
    const y = Math.min(dropMenu.screen.y, window.innerHeight - 320);
    return { x: Math.max(8, x), y: Math.max(8, y) };
  });
  // ---- A run being followed --------------------------------------------------------------------
  const runDoc = $derived(open?.doc.kind === 'run' ? readRun(open.doc.body) : undefined);
  // The workflow's runs, newest first: this workflow's, or the runs of the workflow whose run
  // this is, which the Runs picker moves between.
  const owner = $derived(kind === 'definition' ? id : back ? runDoc?.definition?.id : undefined);
  const runs = $derived(
    owner
      ? [...client.summaries.values()]
          .filter((s) => s.kind === 'run' && s.definitionId === owner)
          .sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt))
      : [],
  );
  const runsGoing = $derived(runs.filter((r) => runActive(r.status)).length);
  const runChoices = $derived(
    runs.map((r) => ({
      id: r.id,
      name: runTime(r.createdAt ?? r.updatedAt),
      detail: [
        r.questions ? 'Waiting for you' : runStatusNames[r.status ?? ''],
        took(r),
        r.trigger && r.trigger !== 'manual' ? triggerLabels[r.trigger as TriggerKind] : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  );
  function chooseRun(next: string) {
    if (kind === 'definition') run = next;
    else switchRun?.(next);
  }
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
  // A run's history lies beside its graph only while open (requested 2026-10-19): from History in
  // the header, a card chosen on the graph, or something new the run waits on you for.
  let historyOpen = $state(false);
  // The panel at the graph's right (a step's settings, the workflow's, a run's history) shares one
  // width, which the gap beside it resizes while it lies beside the graph rather than over it
  // (requested 2026-10-19).
  let sideWidth = $state<number>();
  let bodyWidth = $state(0);
  const sideBeside = $derived(
    kind === 'definition'
      ? (!!selectedNode || settingsOpen) && !narrow
      : historyOpen && !!runDoc && width > 560,
  );
  const sideDefault = $derived(
    kind === 'definition'
      ? Math.min(480, Math.max(360, Math.round(bodyWidth * 0.36)))
      : narrow
        ? Math.min(340, Math.round(bodyWidth * 0.48))
        : 400,
  );
  const waiting = $derived(kind === 'run' ? (summary?.questions ?? 0) : 0);
  let waitingSeen = 0;
  $effect(() => {
    const count = waiting;
    untrack(() => {
      if (count > waitingSeen) historyOpen = true;
      waitingSeen = count;
    });
  });
  // Choosing a card shows it on the graph and its entries alone in the history.
  function chooseCard(next: string | undefined) {
    selected = next;
    filter = next;
    if (next) historyOpen = true;
  }
  const lease = $derived(client.leases[id]);
  const driverName = $derived(
    lease && lease.expiresAt > client.now ? pickers.computerName(lease.holder) : '',
  );
  const active = $derived(runDoc?.status === 'running' || runDoc?.status === 'paused');
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
  const title = $derived(
    kind === 'definition'
      ? (draft?.name ?? summary?.title ?? 'Workflow')
      : back && runDoc?.mode !== 'dynamic'
        ? `Run · ${runTime(runDoc?.createdAt ?? summary?.createdAt)}`
        : (runDoc?.title ?? summary?.title ?? 'Run'),
  );
  const steps = $derived(draft?.graph.nodes.length ?? 0);
  /** How long a run took, or has taken so far. */
  const took = (s: WorkflowSummary) => {
    const from = Date.parse(s.createdAt ?? '');
    const to = s.endedAt ? Date.parse(s.endedAt) : runActive(s.status) ? now : NaN;
    return Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? formatReplyTime(to - from)
      : '';
  };
</script>

{#snippet statusMark(s: WorkflowSummary)}
  <span class="run-mark status-{s.questions ? 'attention' : s.status}">
    {#if s.questions}<MessageCircleQuestionMark size={15} aria-hidden="true" />
    {:else if s.status === 'running'}<LoaderCircle size={15} class="spinning" aria-hidden="true" />
    {:else if s.status === 'paused'}<CirclePause size={15} aria-hidden="true" />
    {:else if s.status === 'completed'}<CircleCheck size={15} aria-hidden="true" />
    {:else if s.status === 'failed'}<CircleX size={15} aria-hidden="true" />
    {:else}<CircleStop size={15} aria-hidden="true" />{/if}
  </span>
{/snippet}
{#snippet runPicker()}
  {#if runs.length}<div class="runs-picker">
      <ChoicePicker
        label="Runs"
        title="Runs"
        value={kind === 'definition' ? '' : id}
        placeholder={`Runs · ${runs.length}`}
        fallbackToFirst={false}
        options={runChoices}
        width={320}
        onchange={chooseRun}
      >
        {#snippet icon()}{#if runsGoing}<LoaderCircle
              size={15}
              class="spinning runs-live"
            />{:else}<History size={15} />{/if}{/snippet}
        {#snippet optionIcon(option)}{@const item = client.summaries.get(option.id)}{#if item}{@render statusMark(
              item,
            )}{/if}{/snippet}
      </ChoicePicker>
    </div>{/if}
{/snippet}

{#snippet sideGap()}<PanelResize
    gutter={10}
    availableWidth={bodyWidth}
    minWidth={300}
    reserve={320}
    defaultWidth={sideDefault}
    onresize={(next) => (sideWidth = next)}
    storageKey="agent-studio.workflow-side-width"
    label="Resize side panel"
    controls="workflow-side"
  />{/snippet}

{#if kind === 'definition' && run}
  <!-- A run of this workflow, in its place until Back. -->
  <WorkflowView
    {client}
    id={run}
    {pickers}
    {conversation}
    {openChat}
    {openDoc}
    {deleteChats}
    closed={() => (run = undefined)}
    {variant}
    expand={expand ? () => expand(run) : undefined}
    {chat}
    {chatShown}
    {close}
    back={() => (run = undefined)}
    switchRun={(next) => (run = next)}
    {webhookUrl}
  />
{:else}
  <section
    class="workflow-page"
    class:panel={variant === 'panel'}
    class:narrow
    aria-label={title}
    bind:clientWidth={width}
  >
    <header class="workflow-toolbar">
      <div class="workflow-heading">
        {#if back}<button
            class="icon-button back"
            title="Workflow"
            aria-label="Back to the workflow"
            onclick={back}><ArrowLeft size={16} /></button
          >{:else if kind === 'run' && runDoc?.mode === 'dynamic'}<Target
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
                · Saving…{/if}{#if blocking.length}
                ·
                <button
                  class="issues"
                  title={blocking.map((i) => i.message).join('\n')}
                  onclick={() => {
                    settingsOpen = true;
                    selected = undefined;
                  }}><CircleAlert size={13} aria-hidden="true" />{blocking.length} to fix</button
                >{/if}
            {:else if runDoc}
              <span class="run-status status-{runDoc.status}">{runStatusNames[runDoc.status]}</span
              >{#each [runDoc.detail, driverName && active ? `on ${driverName}` : ''].filter(Boolean) as part}<span
                  >{` · ${part}`}</span
                >{/each}
            {/if}
          </p>
        </div>
      </div>
      <div class="workflow-tools">
        {#if kind === 'definition' && draft}
          <button
            class="primary"
            disabled={!!blocking.length}
            aria-label="Run"
            title={blocking.length ? 'Fix what the steps show first' : undefined}
            onclick={() => void startRun()}><Play size={15} /><span class="label">Run</span></button
          >
          {@render runPicker()}
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
        {:else if runDoc}
          {#if back}{@render runPicker()}{/if}
          {#if runDoc.definition && !back}<button
              class="icon-button"
              title="Open the workflow"
              aria-label="Open the workflow"
              onclick={() => openDoc(runDoc.definition!.id)}><Workflow size={16} /></button
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
        {#if runDoc}<button
            class="secondary"
            aria-label="History"
            aria-pressed={historyOpen}
            onclick={() => (historyOpen = !historyOpen)}
            ><History size={15} /><span class="label">History</span>{#if waiting}<span
                class="waiting-count"
                title="Waiting for you">{waiting}</span
              >{/if}</button
          >{/if}
        {#if variant === 'page' && chat}<button
            class="secondary"
            aria-label="Chat"
            aria-pressed={chatShown}
            onclick={chat}><MessageSquare size={15} /><span class="label">Chat</span></button
          >{/if}
        {#if variant === 'panel'}
          {#if expand}<button
              class="icon-button"
              title="Expand"
              aria-label="Show the workflow as a page"
              onclick={() => expand?.()}><Maximize2 size={15} /></button
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
    <div
      class="workflow-body"
      bind:clientWidth={bodyWidth}
      style:--workflow-side-width={sideWidth ? `${sideWidth}px` : undefined}
    >
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
            contextMenu = undefined;
            dropMenu = { from, at, screen };
          }}
          menu={(target, at, screen) => openContextMenu({ ...target, at, screen })}
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
        <div class="canvas-tools">
          <div class="add-menu">
            <button class="secondary" aria-expanded={adding} onclick={() => (adding = !adding)}
              ><Plus size={15} aria-hidden="true" />Add step</button
            >
            {#if adding}
              <div class="menu" role="menu" aria-label="Add step">
                {#each ['start', ...nodeTypeIds.filter((t) => t !== 'start')] as NodeType[] as type (type)}
                  <button role="menuitem" onclick={() => addStep(type)}
                    ><WorkflowIcon {type} /><span>{nodeCatalog[type].label}</span></button
                  >
                {/each}
              </div>
            {/if}
          </div>
          <button class="secondary" title="Arrange the steps neatly" onclick={arrange}
            ><WandSparkles size={15} aria-hidden="true" />Arrange</button
          >
        </div>
        {#if sideBeside}{@render sideGap()}{/if}
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
          <aside id="workflow-side" class="workflow-settings" aria-label="Workflow settings">
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
            <button class="delete-workflow" onclick={() => (confirming = 'deleteDefinition')}
              ><Trash2 size={15} aria-hidden="true" />Delete workflow</button
            >
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
          label={runDoc.mode === 'dynamic' ? 'Dynamic workflow graph' : 'Run steps'}
          cards={runGraph.cards}
          links={runGraph.links}
          {selected}
          select={chooseCard}
          {openChat}
          openRun={openDoc}
          {fit}
          menu={(target, at, screen) =>
            openContextMenu(
              target.kind === 'node' ? { ...target, at, screen } : { kind: 'pane', at, screen },
            )}
        />
        {#if sideBeside}{@render sideGap()}{/if}
        {#if historyOpen}<WorkflowRunPanel
            run={runDoc}
            events={open?.events ?? []}
            {now}
            {selected}
            {filter}
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
            select={(card) => (selected = card)}
            clearFilter={() => {
              filter = undefined;
              selected = undefined;
            }}
            close={() => (historyOpen = false)}
          />{/if}
      {:else}
        <p class="workflow-status" role="status">
          {summary || client.mode === 'loading' ? 'Opening…' : 'This workflow is no longer saved.'}
        </p>
      {/if}
    </div>
  </section>
{/if}
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && (dropMenu || adding || contextMenu)) {
      const back = contextMenu ? menuReturn : undefined;
      dropMenu = undefined;
      adding = false;
      contextMenu = undefined;
      if (back?.isConnected) back.focus();
    }
  }}
  onpointerdown={(event) => {
    // A menu closes on a press anywhere but in it.
    if (contextMenu && !(event.target instanceof Element && event.target.closest('.context-menu')))
      contextMenu = undefined;
  }}
/>
{#if contextMenu && menuPlace}
  {@const target = contextMenu}
  <div
    class="menu context-menu"
    class:steps={kind === 'definition' && target.kind === 'pane'}
    bind:this={menuElement}
    onkeydown={menuKey}
    role="menu"
    tabindex="-1"
    aria-label={target.kind === 'pane' ? 'Graph' : target.kind === 'edge' ? 'Connection' : 'Step'}
    style:left={`${menuPlace.x}px`}
    style:top={`${menuPlace.y}px`}
  >
    {#if kind === 'definition' && draft}
      {#if target.kind === 'pane'}
        {#each ['start', ...nodeTypeIds.filter((t) => t !== 'start')] as NodeType[] as type (type)}
          <button
            role="menuitem"
            onclick={() =>
              fromMenu((t) => {
                selected = undefined;
                addStep(type, t.at);
              })}><WorkflowIcon {type} /><span>{nodeCatalog[type].label}</span></button
          >
        {/each}
        <hr />
        <button role="menuitem" onclick={() => fromMenu(arrange)}
          ><WandSparkles size={15} aria-hidden="true" /><span>Arrange</span></button
        >
        <button role="menuitem" onclick={() => fromMenu(() => fit++)}
          ><Maximize2 size={15} aria-hidden="true" /><span>Fit to view</span></button
        >
      {:else if target.kind === 'node' && target.id}
        {@const id = target.id}
        <button
          role="menuitem"
          onclick={() =>
            fromMenu((t) => {
              selected = t.id;
              settingsOpen = false;
            })}><Settings2 size={15} aria-hidden="true" /><span>Settings</span></button
        >
        <button role="menuitem" onclick={() => fromMenu((t) => t.id && duplicate(t.id))}
          ><Copy size={15} aria-hidden="true" /><span>Duplicate</span></button
        >
        <button
          role="menuitem"
          class="danger-item"
          disabled={draft.graph.nodes.find((n) => n.id === id)?.type === 'start' &&
            draft.graph.nodes.filter((n) => n.type === 'start').length < 2}
          onclick={() => fromMenu((t) => t.id && removeStep(t.id))}
          ><Trash2 size={15} aria-hidden="true" /><span>Delete</span></button
        >
      {:else if target.kind === 'edge' && target.id}
        <button
          role="menuitem"
          class="danger-item"
          onclick={() =>
            fromMenu((t) =>
              edit((d) => (d.graph.edges = d.graph.edges.filter((e) => e.id !== t.id))),
            )}><Trash2 size={15} aria-hidden="true" /><span>Delete connection</span></button
        >
      {/if}
    {:else if target.kind === 'node' && target.id}
      {@const leads = cardTargets(target.id)}
      {#if leads.chat}<button
          role="menuitem"
          onclick={() =>
            fromMenu((t) => {
              const chat = t.id && cardTargets(t.id).chat;
              if (chat) openChat(chat);
            })}><MessageSquare size={15} aria-hidden="true" /><span>Open chat</span></button
        >{/if}
      <button role="menuitem" onclick={() => fromMenu((t) => t.id && chooseCard(t.id))}
        ><History size={15} aria-hidden="true" /><span>Show its history</span></button
      >
      {#if leads.run}<button
          role="menuitem"
          onclick={() =>
            fromMenu((t) => {
              const run = t.id && cardTargets(t.id).run;
              if (run) openDoc(run);
            })}><SquareArrowOutUpRight size={15} aria-hidden="true" /><span>Open run</span></button
        >{/if}
    {:else}
      <button role="menuitem" onclick={() => fromMenu(() => fit++)}
        ><Maximize2 size={15} aria-hidden="true" /><span>Fit to view</span></button
      >
    {/if}
  </div>
{/if}
{#if starting && draft}<WorkflowStart
    definition={draft}
    {pickers}
    close={() => (starting = false)}
    start={begin}
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
              ? runDoc.agents.filter((a) => !a.external).map((a) => a.conversationId)
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
      {#if confirming === 'delete' && runDoc?.agents.some((a) => !a.external)}<label class="checkbox"
          ><input type="checkbox" bind:checked={alsoChats} />Also delete its {runDoc.agents.filter(
            (a) => !a.external,
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
    animation: fade-in var(--duration) ease;
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
  .workflow-heading .back {
    flex-shrink: 0;
    margin-left: -6px;
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
  /* The settings and the chat stay pressed while they are open. */
  .workflow-tools button[aria-pressed='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .workflow-tools button[aria-pressed='true']:not(:disabled):hover {
    background: var(--accent-soft-hover);
    color: var(--accent-hover);
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
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--danger);
    font: inherit;
    cursor: pointer;
  }
  .issues:hover {
    text-decoration: underline;
  }
  .runs-picker {
    flex-shrink: 1;
    min-width: 0;
    max-width: 200px;
  }
  .runs-picker :global(.runs-live) {
    color: var(--accent-text);
  }
  .canvas-tools {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 4;
    display: flex;
    gap: 6px;
  }
  .canvas-tools button {
    background: var(--surface-overlay);
    box-shadow: var(--shadow-sm);
  }
  .add-menu {
    position: relative;
  }
  .menu {
    position: absolute;
    left: 0;
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
    animation: fade-in var(--duration-fast) ease;
  }
  .drop-menu {
    position: fixed;
    z-index: 40;
  }
  /* A right-click menu: one column of actions, or the steps to add and the graph's actions. */
  .context-menu {
    position: fixed;
    z-index: 40;
    grid-template-columns: minmax(170px, 1fr);
  }
  .context-menu.steps {
    grid-template-columns: repeat(2, minmax(140px, 1fr));
  }
  .context-menu hr {
    grid-column: 1 / -1;
    width: 100%;
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .context-menu .danger-item {
    color: var(--danger);
  }
  .menu button {
    justify-content: flex-start;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    background: none;
    box-shadow: none;
  }
  .menu button:hover {
    background: var(--hover);
  }
  /* The gap beside the panel at the graph's right is the handle that resizes it. */
  .workflow-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .run-mark {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .run-mark.status-running {
    color: var(--accent-text);
  }
  .run-mark.status-attention,
  .run-mark.status-paused {
    color: var(--warning);
  }
  .run-mark.status-completed {
    color: var(--success);
  }
  .run-mark.status-failed {
    color: var(--danger);
  }
  .waiting-count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 18px;
    text-align: center;
  }
  .workflow-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: var(--workflow-side-width, 340px);
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
  .delete-workflow {
    align-self: flex-start;
    margin-top: auto;
    border: 0;
    background: none;
    color: var(--danger);
    font-size: var(--text-sm);
    gap: 6px;
    padding: 4px 0;
  }
  .delete-workflow:hover {
    text-decoration: underline;
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
  /* Narrow, a run's history keeps to a narrower column, since choosing a card on the graph shows
     its entries, and lies over the graph only where there is no room for both. */
  .narrow .workflow-body > :global(.run-sheet) {
    width: var(--workflow-side-width, min(340px, 48%));
  }
  @container (max-width: 560px) {
    .workflow-body > :global(.run-sheet) {
      position: absolute;
      top: 8px;
      right: 8px;
      bottom: 8px;
      z-index: 5;
      width: calc(100% - 16px);
      box-shadow: var(--shadow-lg);
    }
  }
  /* Narrow, a step's settings lie over the graph's right side. */
  .narrow .workflow-body > :global(aside:not(.run-sheet)) {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 5;
    width: min(400px, calc(100% - 16px));
    max-height: none;
    box-shadow: var(--shadow-lg);
  }
  @media (max-width: 600px) {
    .workflow-page:not(.panel) {
      padding: 8px 10px 10px;
    }
  }
</style>
