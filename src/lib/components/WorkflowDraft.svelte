<script lang="ts">
  import { Target, Workflow } from '@lucide/svelte';
  import WorkflowCanvas from './WorkflowCanvas.svelte';
  import { definitionCards, type GraphCard, type GraphLink } from '$lib/workflow-view';
  import { newDefinition } from '$lib/workflow-model';

  // A workflow about to be made, beside the chat that describes it (requested 2026-10-20): the
  // graph it starts with, a static workflow's manual trigger or a dynamic one's orchestrator,
  // until its first message makes it.
  let {
    mode,
    orchestrator = '',
  }: {
    mode: 'workflow' | 'mission';
    /** Where a dynamic workflow's orchestrator will run, and on which account. */
    orchestrator?: string;
  } = $props();

  const graph = $derived<{ cards: GraphCard[]; links: GraphLink[] }>(
    mode === 'mission'
      ? {
          cards: [
            {
              id: 'orchestrator',
              position: { x: 0, y: 0 },
              data: {
                kind: 'orchestrator',
                type: 'orchestrator',
                title: 'Orchestrator',
                subtitle: orchestrator,
                status: 'idle',
                statusText: '',
                rows: [],
                ports: [{ id: 'out', label: '' }],
                input: false,
              },
            },
          ],
          links: [],
        }
      : definitionCards(newDefinition('New workflow', { kind: 'user' }).graph, []),
  );
</script>

<section class="workflow-page" class:static={mode === 'workflow'} aria-label="New workflow">
  <header class="workflow-toolbar">
    <div class="workflow-heading">
      {#if mode === 'mission'}<Target size={17} aria-hidden="true" />{:else}<Workflow
          size={17}
          aria-hidden="true"
        />{/if}
      <div>
        <h1>New workflow</h1>
        <p>{mode === 'mission' ? 'Dynamic' : 'Static'}</p>
      </div>
    </div>
  </header>
  <div class="workflow-body">
    <WorkflowCanvas
      cards={graph.cards}
      links={graph.links}
      select={() => {}}
      label="New workflow"
    />
  </div>
</section>

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
    min-height: 32px;
  }
  .workflow-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .workflow-heading > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  h1 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }
  /* A saved workflow's name is a field: the draft's takes its height, so the graph stays where it
     is when the workflow is made. */
  .static h1 {
    padding-block: 3px;
    line-height: 1.45;
  }
  p {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .workflow-body {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
</style>
