<script lang="ts">
  import {
    Box,
    ChevronLeft,
    ChevronRight,
    Maximize2,
    Pause,
    Play,
    RotateCcw,
    Sun,
    ZoomIn,
    ZoomOut,
  } from '@lucide/svelte';
  import { modelViewCount } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';
  import { lightings, type Lighting } from '$lib/model-scene';
  import { modelLighting, setModelLighting } from '$lib/model-lighting.svelte';
  import { ModelPane, type ModelPlace } from '$lib/model-pane.svelte';
  import type { FileViewer, ViewedModel } from '$lib/file-viewer.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import ModelStage from './ModelStage.svelte';

  let {
    runId,
    toolId,
    connectionId,
    file,
    caption,
    viewer,
  }: {
    runId: string;
    toolId: string;
    connectionId?: string;
    file: SentFile;
    /** The caption of the group the model came in. */
    caption?: string;
    /** The viewer that connects this model with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  const pane = new ModelPane(() => ({ runId, toolId, connectionId, file }));
  const viewed = $derived<ViewedModel>({
    kind: 'model',
    name: file.name,
    label: pane.viewsOnly ? `${pane.label} · ${modelViewCount} views` : pane.label,
    caption,
    view: expandedView,
    shown: pane.shown,
  });
</script>

{#snippet bar(place: ModelPlace)}
  <div class="model-bar">
    <!-- The file viewer's heading names the model it shows. -->
    {#if place === 'inline'}<span class="model-name" title={file.name}
        ><Box size={13} aria-hidden="true" />{file.name}</span
      >{/if}
    {#if pane.clips.length}
      <button
        type="button"
        class="model-action"
        onclick={pane.toggle}
        aria-label={pane.playing ? 'Pause animation' : 'Play animation'}
      >
        {#if pane.playing}<Pause size={13} aria-hidden="true" />{:else}<Play
            size={13}
            aria-hidden="true"
          />{/if}
      </button>
      {#if pane.clips.length > 1}
        <ChoicePicker
          options={pane.clips.map((name, index) => ({ id: String(index), name }))}
          value={String(pane.clip)}
          label="Animation"
          onchange={(value) => pane.play(Number(value))}
        />
      {/if}
    {/if}
    <span class="model-spacer"></span>
    <ChoicePicker
      options={lightings}
      value={modelLighting.value}
      label="Lighting"
      onchange={(value) => setModelLighting(value as Lighting)}
    >
      {#snippet icon()}<Sun size={13} />{/snippet}
    </ChoicePicker>
    <button
      type="button"
      class="model-action"
      aria-label="Zoom in"
      onclick={() => pane.zoom(place, 0.8)}><ZoomIn size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="model-action"
      aria-label="Zoom out"
      onclick={() => pane.zoom(place, 1.25)}><ZoomOut size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="model-action"
      aria-label="Reset view"
      onclick={() => pane.reset(place)}
    >
      <RotateCcw size={13} aria-hidden="true" />
    </button>
    {#if place === 'inline'}
      <button
        type="button"
        class="model-action"
        aria-label={`Expand ${file.name}`}
        aria-haspopup="dialog"
        onclick={(event) => viewer.open(event.currentTarget)}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    {/if}
    {#if place === 'inline'}<span class="model-size">{pane.label}</span>{/if}
  </div>
{/snippet}

{#snippet turntableBar(place: ModelPlace)}
  <div class="model-bar">
    <!-- The file viewer's heading names the model it shows. -->
    {#if place === 'inline'}<span class="model-name" title={file.name}
        ><Box size={13} aria-hidden="true" />{file.name}</span
      >{/if}
    <span class="model-spacer"></span>
    <button
      type="button"
      class="model-action"
      aria-label="Turn left"
      disabled={pane.views.phase !== 'ready'}
      onclick={() => pane.step(-1)}><ChevronLeft size={13} aria-hidden="true" /></button
    >
    <span class="model-turn" aria-hidden="true">{pane.turn + 1}/{modelViewCount}</span>
    <button
      type="button"
      class="model-action"
      aria-label="Turn right"
      disabled={pane.views.phase !== 'ready'}
      onclick={() => pane.step(1)}><ChevronRight size={13} aria-hidden="true" /></button
    >
    {#if place === 'inline'}
      <button
        type="button"
        class="model-action"
        aria-label={`Expand ${file.name}`}
        aria-haspopup="dialog"
        onclick={(event) => viewer.open(event.currentTarget)}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    {/if}
    <span class="model-size" title="The whole model could not be read here"
      >{pane.label} · {modelViewCount} views</span
    >
  </div>
{/snippet}

<!-- The file viewer draws this at full size, beside the chat's other files. -->
{#snippet expandedView()}
  <div class="model-expanded">
    <ModelStage {pane} place="expanded" />
    {#if pane.viewsOnly}
      {@render turntableBar('expanded')}
    {:else}
      {@render bar('expanded')}
    {/if}
  </div>
{/snippet}

<figure class="model-view" {@attach viewer.attach(() => viewed)}>
  <ModelStage {pane} place="inline" />
  {#if pane.viewsOnly}
    {@render turntableBar('inline')}
  {:else}
    {@render bar('inline')}
  {/if}
</figure>

<style>
  .model-view {
    display: grid;
    gap: 4px;
    width: 100%;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .model-view:hover {
    border-color: var(--border-hover);
  }
  .model-turn {
    min-width: 2.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .model-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .model-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .model-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-spacer {
    flex: 1;
  }
  .model-size {
    font-variant-numeric: tabular-nums;
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
  /* The bar's pickers, Lighting and Animation, stay the size of its buttons. */
  .model-bar :global(.picker-trigger) {
    min-height: 22px;
    padding: 0 4px 0 6px;
    gap: 4px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  /* In the file viewer the model stands on a surface of its own over the scrim, its stage
     taking the room its controls leave. */
  .model-expanded {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .model-expanded .model-bar {
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
</style>
