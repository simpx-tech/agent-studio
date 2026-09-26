<script module lang="ts">
  import { createFetchCache, type ToolOutputModel } from '$lib/tool-output';
  import { readToolOutputModel } from '$lib/transport';
  // Models a window already read, bounded so several heavy files cannot pile up.
  const models = createFetchCache<ToolOutputModel>((model) => model.bytes, {
    entries: 6,
    bytes: 64_000_000,
  });
</script>

<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { Box, Maximize2, Pause, Play, RotateCcw, X, ZoomIn, ZoomOut } from '@lucide/svelte';
  import {
    formatBytes,
    modelBytes,
    modelFormats,
    type ToolOutputModelType,
  } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';
  import { createModelScene, type ModelScene } from '$lib/model-scene';
  import ChoicePicker from './ChoicePicker.svelte';

  let {
    runId,
    toolId,
    connectionId,
    file,
  }: {
    runId: string;
    toolId: string;
    connectionId?: string;
    file: SentFile;
  } = $props();

  let model = $state<ToolOutputModel>();
  let error = $state('');
  let attempt = $state(0);
  let expanded = $state(false);
  let dialog = $state<HTMLDialogElement>();
  const format = $derived(modelFormats[file.mediaType as ToolOutputModelType] ?? 'glb');
  const label = $derived(`${format.toUpperCase()} · ${formatBytes(file.bytes)}`);
  // Only the model's identity selects it; relay updates of the reply do not reload it.
  const key = $derived(`${runId}\n${toolId}\n${file.index}`);
  $effect(() => {
    const current = key;
    void attempt;
    let live = true;
    error = '';
    untrack(() =>
      models.get(current, () => readToolOutputModel(runId, toolId, file.index, connectionId)),
    ).then(
      (value) => {
        if (live) model = value;
      },
      (reason) => {
        if (live) error = String(reason instanceof Error ? reason.message : reason);
      },
    );
    return () => {
      live = false;
    };
  });

  /**
   * Builds the scene once its canvas is on screen, so a long chat holds no drawing context
   * for a model nobody has scrolled to, pauses it while the reply is out of view, and
   * releases it with the canvas.
   */
  let generation = 0;
  function viewer(canvas: HTMLCanvasElement, wheelZoom: boolean) {
    const owner = ++generation;
    let scene: ModelScene | undefined;
    let cancelled = false;
    let onScreen = false;
    const sizes = new ResizeObserver(() => scene?.resize());
    const follow = (created: ModelScene) => created.play(playing && onScreen ? clip : null);
    const visible = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      if (cancelled) return;
      if (scene) return follow(scene);
      if (!onScreen) return;
      createModelScene(canvas, modelBytes(model!), format, { wheelZoom }).then(
        (created) => {
          if (cancelled) return created.dispose();
          scene = created;
          clips = created.clips;
          playing = created.clips.length > 0;
          sizes.observe(canvas);
          follow(created);
        },
        () => {
          if (!cancelled) error = 'This model could not be opened.';
        },
      );
    });
    visible.observe(canvas);
    // The expanded view mounts its own canvas before this one leaves, so only the stage
    // that is still on screen owns the controls.
    controls = {
      play: (next: number | null) => scene?.play(next),
      zoom: (factor: number) => scene?.zoom(factor),
      reset: () => scene?.reset(),
    };
    return {
      destroy() {
        cancelled = true;
        visible.disconnect();
        sizes.disconnect();
        scene?.dispose();
        scene = undefined;
        if (generation === owner) controls = undefined;
      },
    };
  }

  let clips = $state<string[]>([]);
  let clip = $state(0);
  let playing = $state(false);
  let controls = $state<{
    play(clip: number | null): void;
    zoom(factor: number): void;
    reset(): void;
  }>();
  function play(next: number) {
    clip = next;
    playing = true;
    controls?.play(next);
  }
  function toggle() {
    playing = !playing;
    controls?.play(playing ? clip : null);
  }
  async function expand() {
    expanded = true;
    await tick();
    dialog?.showModal();
  }
</script>

{#snippet stage(wheelZoom: boolean)}
  <div class="model-stage">
    {#if model}
      <!-- The canvas draws the parsed model; it runs no code from the file. -->
      <canvas use:viewer={wheelZoom} aria-label={`3D model ${file.name}`}></canvas>
    {/if}
    {#if !model && !error}
      <p class="model-note" role="status">Loading model…</p>
    {/if}
    {#if error}
      <p class="model-note failed" role="alert">
        {error}
        <button type="button" class="model-action" onclick={() => attempt++}>
          <RotateCcw size={12} aria-hidden="true" />Retry
        </button>
      </p>
    {/if}
  </div>
{/snippet}

{#snippet bar(wheelZoom: boolean)}
  <div class="model-bar">
    <span class="model-name" title={file.name}><Box size={13} aria-hidden="true" />{file.name}</span
    >
    {#if clips.length}
      <button
        type="button"
        class="model-action"
        onclick={toggle}
        aria-label={playing ? 'Pause animation' : 'Play animation'}
      >
        {#if playing}<Pause size={13} aria-hidden="true" />{:else}<Play
            size={13}
            aria-hidden="true"
          />{/if}
      </button>
      {#if clips.length > 1}
        <ChoicePicker
          options={clips.map((name, index) => ({ id: String(index), name }))}
          value={String(clip)}
          label="Animation"
          onchange={(value) => play(Number(value))}
        />
      {/if}
    {/if}
    <span class="model-spacer"></span>
    {#if !wheelZoom}
      <button
        type="button"
        class="model-action"
        aria-label="Zoom in"
        onclick={() => controls?.zoom(0.8)}><ZoomIn size={13} aria-hidden="true" /></button
      >
      <button
        type="button"
        class="model-action"
        aria-label="Zoom out"
        onclick={() => controls?.zoom(1.25)}><ZoomOut size={13} aria-hidden="true" /></button
      >
    {/if}
    <button
      type="button"
      class="model-action"
      aria-label="Reset view"
      onclick={() => controls?.reset()}
    >
      <RotateCcw size={13} aria-hidden="true" />
    </button>
    {#if !wheelZoom}
      <button
        type="button"
        class="model-action"
        aria-label={`Expand ${file.name}`}
        onclick={expand}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    {/if}
    <span class="model-size">{label}</span>
  </div>
{/snippet}

{#if !expanded}
  <figure class="model-view">
    {@render stage(false)}
    {@render bar(false)}
  </figure>
{/if}

<dialog
  bind:this={dialog}
  class="model-preview"
  aria-label="Model preview"
  onclose={() => {
    expanded = false;
    clips = [];
    playing = false;
  }}
>
  {#if expanded}
    <div class="model-preview-heading">
      <span>{file.name} · {label}</span><button
        type="button"
        class="icon-button"
        aria-label="Close model preview"
        onclick={() => dialog?.close()}><X size={18} /></button
      >
    </div>
    {@render stage(true)}
    {@render bar(true)}
  {/if}
</dialog>

<style>
  .model-view {
    display: grid;
    gap: 4px;
    max-width: 100%;
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
  .model-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(100%, 420px);
    height: 280px;
    border-radius: var(--radius-xs);
    background: radial-gradient(120% 90% at 50% 0%, var(--hover), transparent 70%), var(--code-bg);
    overflow: hidden;
  }
  .model-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: pan-y;
    cursor: grab;
  }
  .model-stage canvas:active {
    cursor: grabbing;
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
  .model-preview {
    width: min(94vw, 1100px);
    max-height: 94vh;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-xl);
  }
  .model-preview::backdrop {
    background: var(--backdrop);
  }
  .model-preview-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 6px 6px 14px;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .model-preview .model-stage {
    width: 100%;
    height: min(72vh, 720px);
    border-radius: 0;
  }
  .model-preview .model-bar {
    padding: 6px 10px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
</style>
