<script lang="ts">
  import { onMount, untrack, type ComponentProps } from 'svelte';
  import { showPanel } from '$lib/side-panels';
  import PanelResize from './PanelResize.svelte';
  import WorkflowView from './WorkflowView.svelte';
  // A workflow's graph beside the chat that changes it, or a mission's beside the chat of its
  // orchestrator (docs/WORKFLOWS.md): docked on wide windows, a drawer over the chat otherwise.
  let {
    takeFocus = false,
    close,
    run = $bindable(),
    ...view
  }: Omit<ComponentProps<typeof WorkflowView>, 'variant' | 'close' | 'run'> & {
    /** Whether it takes focus when it opens: only when the reader opened it. */
    takeFocus?: boolean;
    close: () => void;
    /** The run of the workflow it shows in the workflow's place. */
    run?: string;
  } = $props();
  let viewportWidth = $state(0);
  let workspaceWidth = $state(0);
  let panelWidth = $state<number>();
  const docked = $derived(viewportWidth >= 1000 && workspaceWidth >= 760);
  let dialog = $state<HTMLDialogElement>();
  let mounted = $state(false);
  let shown = false;
  $effect(() => {
    if (!mounted || !dialog) return;
    const dock = docked;
    const box = dialog;
    untrack(() =>
      showPanel(box, dock, '[aria-label="Close the workflow panel"]', !shown && !takeFocus),
    );
    shown = true;
  });
  onMount(() => {
    const workspace = dialog?.parentElement;
    const observer = new ResizeObserver(() => {
      if (workspace) workspaceWidth = workspace.getBoundingClientRect().width;
    });
    if (workspace) {
      workspaceWidth = workspace.getBoundingClientRect().width;
      observer.observe(workspace);
    }
    mounted = true;
    return () => observer.disconnect();
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} />
<dialog
  bind:this={dialog}
  id="workflow-panel"
  class="workflow-panel"
  class:docked
  style:--workflow-panel-width={panelWidth ? `${panelWidth}px` : undefined}
  aria-modal={docked ? undefined : 'true'}
  aria-label="Workflow"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  {#if docked}<PanelResize
      availableWidth={workspaceWidth}
      share={0.5}
      onresize={(width) => (panelWidth = width)}
      storageKey="agent-studio.workflow-panel-share"
      label="Resize workflow panel"
      controls="workflow-panel"
    />{/if}
  <WorkflowView {...view} variant="panel" {close} bind:run />
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--surface-overlay);
    padding: 0;
    top: var(--mobile-top, 0px);
    margin: 0 0 0 auto;
    width: min(760px, 100vw);
    height: var(--mobile-height, 100dvh);
    max-width: none;
    max-height: none;
    overflow: hidden;
    border: 0;
    border-left: 1px solid var(--border-strong);
    border-radius: 0;
    box-shadow: var(--shadow-xl);
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
  }
  dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  dialog.docked {
    position: relative;
    inset: auto;
    align-self: stretch;
    flex: 0 0 var(--workflow-panel-width, 50%);
    width: var(--workflow-panel-width, 50%);
    min-width: 360px;
    height: auto;
    min-height: 0;
    margin: 0;
    border-left-color: var(--border);
    box-shadow: none;
    background: var(--bg-sidebar);
  }
</style>
