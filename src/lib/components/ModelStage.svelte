<script lang="ts">
  import { RotateCcw } from '@lucide/svelte';
  import { modelViewCount } from '$lib/tool-output';
  import type { ModelPane, ModelPlace } from '$lib/model-pane.svelte';

  let {
    pane,
    place,
    compared = false,
  }: {
    pane: ModelPane;
    place: ModelPlace;
    /** A pane of a comparison, which sizes the stage instead of its own shape. */
    compared?: boolean;
  } = $props();

  const status = $derived(pane.statuses[place]);
</script>

{#if pane.viewsOnly}
  {#key pane.key}
    <div
      class="model-stage"
      class:expanded={place === 'expanded'}
      class:compared
      use:pane.viewsStage={place}
    >
      {#if pane.views.phase === 'ready'}
        <div
          class="model-turntable"
          role="slider"
          tabindex="0"
          aria-label={`Turn ${pane.name}`}
          aria-valuemin={1}
          aria-valuemax={modelViewCount}
          aria-valuenow={pane.turn + 1}
          aria-valuetext={`View ${pane.turn + 1} of ${modelViewCount}`}
          onkeydown={pane.turnKeys}
          onpointerdown={pane.grab}
        >
          <img src={pane.views.urls[pane.turn]} alt="" draggable="false" />
        </div>
      {:else if pane.views.phase === 'failed'}
        <p class="model-note failed" role="alert">
          {pane.views.message}
          <button type="button" class="model-action" onclick={pane.loadViews}>
            <RotateCcw size={12} aria-hidden="true" />Retry
          </button>
        </p>
      {:else}
        <p class="model-note" role="status">Loading views…</p>
      {/if}
    </div>
  {/key}
{:else}
  {#key pane.key}
    <!-- The viewer adds the canvas that draws the parsed model; it runs no code from the file. -->
    <div
      class="model-stage"
      class:expanded={place === 'expanded'}
      class:compared
      use:pane.scene={place}
    >
      {#if status?.phase === 'failed'}
        <p class="model-note failed" role="alert">
          {status.message}
          <button type="button" class="model-action" onclick={() => pane.retry(place)}>
            <RotateCcw size={12} aria-hidden="true" />Retry
          </button>
        </p>
      {:else if status?.phase !== 'ready'}
        <p class="model-note" role="status">Loading model…</p>
      {/if}
    </div>
  {/key}
{/if}

<style>
  .model-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 16 / 10;
    min-height: 220px;
    max-height: min(560px, 70vh);
    border-radius: var(--radius-xs);
    background: radial-gradient(120% 90% at 50% 0%, var(--hover), transparent 70%), var(--code-bg);
    color: var(--text-muted);
    overflow: hidden;
  }
  /* The viewer's canvas, added by script, fills the stage above its notes. */
  .model-stage :global(.model-canvas) {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
  }
  .model-stage :global(.model-canvas:active) {
    cursor: grabbing;
  }
  /* In the file viewer the stage takes the room its controls leave. */
  .model-stage.expanded {
    flex: 1;
    min-height: 0;
    max-height: none;
    aspect-ratio: auto;
    border-radius: 0;
  }
  /* A comparison gives each of its panes its size. */
  .model-stage.compared {
    flex: 1;
    height: 100%;
    min-height: 0;
    max-height: none;
    aspect-ratio: auto;
  }
  /* Views another computer rendered, turned through by dragging or the arrow keys. */
  .model-turntable {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    touch-action: pan-y;
    user-select: none;
  }
  .model-turntable:active {
    cursor: grabbing;
  }
  .model-turntable img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    pointer-events: none;
  }
  .model-note {
    margin: 0;
    padding: 8px;
    font-size: var(--text-xs);
    text-align: center;
  }
  .model-note.failed {
    color: var(--danger);
  }
  .model-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .model-action:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
