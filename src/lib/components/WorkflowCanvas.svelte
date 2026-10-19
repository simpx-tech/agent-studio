<script lang="ts">
  import {
    Background,
    BackgroundVariant,
    Controls,
    MiniMap,
    SvelteFlow,
    type Connection,
    type Edge,
    type Node,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/base.css';
  import { untrack } from 'svelte';
  import WorkflowCard from './WorkflowCard.svelte';
  import WorkflowEdge from './WorkflowEdge.svelte';
  import WorkflowFit from './WorkflowFit.svelte';
  import WorkflowFlowBridge from './WorkflowFlowBridge.svelte';
  import { appearance } from '$lib/appearance.svelte';
  import type { GraphCard, GraphLink } from '$lib/workflow-view';
  let {
    cards,
    links,
    editable = false,
    selected,
    select,
    connect,
    remove,
    moved,
    dropped,
    openChat,
    label,
    fit = 0,
  }: {
    cards: GraphCard[];
    links: GraphLink[];
    editable?: boolean;
    selected?: string;
    select: (id: string | undefined) => void;
    connect?: (source: string, port: string, target: string) => void;
    remove?: (nodes: string[], edges: string[]) => void;
    moved?: (id: string, position: { x: number; y: number }) => void;
    /**
     * A connection dragged from a step's output and dropped on empty space: the new step goes
     * there, `at` on the graph and `screen` where the pointer left it.
     */
    dropped?: (
      from: { node: string; port: string },
      at: { x: number; y: number },
      screen: { x: number; y: number },
    ) => void;
    openChat?: (conversationId: string) => void;
    label: string;
    /** Changes when the graph should be fit into view, as after a step is added. */
    fit?: number;
  } = $props();
  // A run's graph grows as it works: it stays fit into view until the reader moves it.
  let panned = false;
  let grown = $state(0);
  let known = 0;
  // A canvas that changes size, as when a window narrows to a phone's, fits its graph again.
  let width = $state(0);
  let height = $state(0);
  let size = '';
  $effect(() => {
    const next = `${Math.round(width / 40)}x${Math.round(height / 40)}`;
    if (!width || !height || next === size) return;
    const first = !size;
    size = next;
    if (!first && !panned) grown++;
  });
  $effect(() => {
    const count = cards.length;
    if (!editable && !panned && count > known && known > 0) grown++;
    known = count;
  });
  const nodeTypes = { card: WorkflowCard };
  const edgeTypes = { flow: WorkflowEdge };
  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  // Where the reader dragged cards of a run, which its live updates keep.
  const dragged = new Map<string, { x: number; y: number }>();
  // A workflow keeps at least one trigger.
  const triggers = $derived(cards.filter((card) => card.data.type === 'start').length);
  $effect(() => {
    const next = cards.map((card): Node => ({
      id: card.id,
      type: 'card',
      position: (!editable && dragged.get(card.id)) || card.position,
      data: { ...card.data, openChat, editable },
      selected: card.id === selected,
      deletable: editable && (card.data.type !== 'start' || triggers > 1),
      connectable: editable,
      draggable: true,
    }));
    untrack(() => (nodes = next));
  });
  $effect(() => {
    const next = links.map((link): Edge => ({
      id: link.id,
      source: link.source,
      sourceHandle: link.sourceHandle,
      target: link.target,
      ...(link.label ? { label: link.label } : {}),
      animated: !!link.active,
      deletable: editable,
      class: link.active ? 'active-link' : undefined,
    }));
    untrack(() => (edges = next));
  });
  function beforeConnect(connection: Connection): false {
    if (!editable || connection.source === connection.target) return false;
    connect?.(connection.source, connection.sourceHandle ?? 'out', connection.target);
    // The workflow's own copy decides what the graph shows.
    return false;
  }
  let toFlow: ((x: number, y: number) => { x: number; y: number }) | undefined;
  function connectEnd(
    event: MouseEvent | TouchEvent,
    state: {
      isValid: boolean | null;
      fromNode: { id: string } | null;
      fromHandle: { id?: string | null; type: string } | null;
      toNode: unknown;
    },
  ) {
    if (!editable || !dropped || !toFlow) return;
    if (state.isValid || state.toNode || !state.fromNode || state.fromHandle?.type !== 'source')
      return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!point) return;
    dropped(
      { node: state.fromNode.id, port: state.fromHandle.id ?? 'out' },
      toFlow(point.clientX, point.clientY),
      { x: point.clientX, y: point.clientY },
    );
  }
  async function beforeDelete({ nodes: gone, edges: cut }: { nodes: Node[]; edges: Edge[] }) {
    if (editable) {
      const starts = gone.filter((n) => (n.data as { type?: string }).type === 'start');
      const keep = starts.length >= triggers ? starts[0]?.id : undefined;
      remove?.(
        gone.filter((n) => n.id !== keep).map((n) => n.id),
        cut.map((e) => e.id),
      );
    }
    return false;
  }
</script>

<div
  class="workflow-canvas"
  role="application"
  aria-label={label}
  bind:clientWidth={width}
  bind:clientHeight={height}
>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    minZoom={0.15}
    maxZoom={1.75}
    colorMode={appearance.resolved}
    nodesConnectable={editable}
    elementsSelectable
    deleteKey={editable ? ['Delete', 'Backspace'] : null}
    proOptions={{ hideAttribution: true }}
    onbeforeconnect={beforeConnect}
    onconnectend={connectEnd}
    onbeforedelete={beforeDelete}
    onnodeclick={({ node }) => select(node.id)}
    onpaneclick={() => select(undefined)}
    onmovestart={(event) => {
      if (event) panned = true;
    }}
    onnodedragstop={({ targetNode }) => {
      if (!targetNode) return;
      if (editable) moved?.(targetNode.id, targetNode.position);
      else dragged.set(targetNode.id, targetNode.position);
    }}
    defaultEdgeOptions={{ type: 'flow' }}
  >
    <WorkflowFit token={fit + grown} {width} {height} />
    <WorkflowFlowBridge ready={(api) => (toFlow = api.toFlow)} />
    <Background variant={BackgroundVariant.Dots} gap={18} size={1.6} />
    <Controls showLock={false} />
    {#if cards.length > 8}<MiniMap pannable zoomable class="workflow-minimap" />{/if}
  </SvelteFlow>
</div>

<style>
  .workflow-canvas {
    position: relative;
    flex: 1;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    overflow: hidden;
    background: var(--surface-sunken);
  }
  .workflow-canvas :global(.svelte-flow) {
    --xy-background-color: var(--surface-sunken);
    --xy-background-pattern-color: color-mix(in srgb, var(--text-muted) 38%, transparent);
    --xy-edge-stroke: var(--border-strong);
    --xy-edge-stroke-selected: var(--accent-strong);
    --xy-edge-stroke-width: 1.5;
    --xy-connectionline-stroke: var(--accent-strong);
    --xy-attribution-background-color: transparent;
    --xy-minimap-background-color: var(--surface-1);
    --xy-minimap-mask-background-color: color-mix(in srgb, var(--bg) 60%, transparent);
    --xy-minimap-node-background-color: var(--surface-3);
    --xy-controls-button-background-color: var(--surface-overlay);
    --xy-controls-button-background-color-hover: var(--surface-3);
    --xy-controls-button-color: var(--text-secondary);
    --xy-controls-button-color-hover: var(--text);
    --xy-controls-button-border-color: var(--border);
    --xy-edge-label-background-color: var(--surface-1);
    --xy-edge-label-color: var(--text-muted);
    --xy-selection-background-color: var(--accent-soft);
    --xy-selection-border: 1px dashed var(--accent-border);
    background: var(--surface-sunken);
    font-family: var(--font-sans);
  }
  .workflow-canvas :global(.svelte-flow__node) {
    border-radius: var(--radius-xl);
  }
  .workflow-canvas :global(.svelte-flow__node:focus-visible) {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .workflow-canvas :global(.svelte-flow__edge.active-link .svelte-flow__edge-path) {
    stroke: var(--accent-strong);
  }
  .workflow-canvas :global(.svelte-flow__edge-textbg) {
    fill: var(--surface-1);
  }
  .workflow-canvas :global(.svelte-flow__edge-text) {
    fill: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .workflow-canvas :global(.svelte-flow__controls) {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }
  .workflow-canvas :global(.svelte-flow__controls-button svg) {
    fill: currentColor;
  }
  .workflow-canvas :global(.workflow-minimap) {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  @media (max-width: 700px) {
    .workflow-canvas :global(.workflow-minimap) {
      display: none;
    }
  }
</style>
