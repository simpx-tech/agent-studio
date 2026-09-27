<script module lang="ts">
  import { createFetchCache } from '$lib/tool-output';
  import type { ModelFormat } from '$lib/model-scene';
  // Models a window already read, as decoded bytes, bounded so several heavy files cannot
  // pile up. The inline and expanded views of a model share its entry.
  const models = createFetchCache<{ format: ModelFormat; bytes: ArrayBuffer }>(
    (model) => model.bytes.byteLength,
    { entries: 6, bytes: 64_000_000 },
  );
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { Box, Maximize2, Pause, Play, RotateCcw, X, ZoomIn, ZoomOut } from '@lucide/svelte';
  import {
    formatBytes,
    modelBytes,
    modelFormats,
    type ToolOutputModelType,
  } from '$lib/tool-output';
  import { readToolOutputModel } from '$lib/transport';
  import type { SentFile } from '$lib/sent-files';
  import { createModelViewer, type ModelViewer, type ViewerStatus } from '$lib/model-viewer';
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

  type View = 'inline' | 'expanded';
  let expanded = $state(false);
  let dialog = $state<HTMLDialogElement>();
  const format = $derived(modelFormats[file.mediaType as ToolOutputModelType] ?? 'glb');
  const label = $derived(`${format.toUpperCase()} · ${formatBytes(file.bytes)}`);
  // Only the model's identity selects it: relay updates of the reply do not reload it, while
  // a group sent again under the same id builds the model it now names.
  const key = $derived(`${runId}\n${toolId}\n${file.index}\n${file.mediaType}`);
  function load() {
    return models.get(key, async () => {
      const model = await readToolOutputModel(runId, toolId, file.index, connectionId);
      // The loader follows the format the computer recognized in the file itself.
      return { format: model.format, bytes: await modelBytes(model) };
    });
  }

  let clips = $state<string[]>([]);
  let clip = $state(0);
  // Animations play on their own unless the reader asked for less motion.
  let playing = $state(!reducedMotion());
  let statuses = $state<Partial<Record<View, ViewerStatus>>>({});
  const viewers: Partial<Record<View, ModelViewer>> = {};

  /** Each stage builds its scene through a viewer that keeps it only while it is on screen. */
  function viewer(stage: HTMLElement, view: View) {
    statuses[view] = undefined;
    if (view === 'inline') {
      clips = [];
      clip = 0;
    }
    const created = createModelViewer(stage, {
      label: `3D model ${file.name}`,
      load,
      wheelZoom: view === 'expanded',
      clip: () => clip,
      playing: () => playing,
      onStatus(status) {
        if (viewers[view] !== created) return;
        statuses[view] = status;
        if (status.phase === 'ready') clips = status.clips;
      },
    });
    viewers[view] = created;
    if (view === 'inline' && expanded) created.suspend(true);
    return {
      destroy() {
        created.destroy();
        if (viewers[view] !== created) return;
        delete viewers[view];
        statuses[view] = undefined;
      },
    };
  }
  const each = (act: (viewer: ModelViewer) => void) => Object.values(viewers).forEach(act);
  function play(next: number) {
    clip = next;
    playing = true;
    each((v) => {
      v.setClip(next);
      v.setPlaying(true);
    });
  }
  function toggle() {
    playing = !playing;
    each((v) => v.setPlaying(playing));
  }
  // The inline view keeps its place in the chat while the expanded one is open, so the reading
  // position holds and focus returns to Expand on close; it only gives up its scene.
  async function expand() {
    expanded = true;
    viewers.inline?.suspend(true);
    await tick();
    dialog?.showModal();
  }
</script>

{#snippet stage(view: View)}
  {@const status = statuses[view]}
  {#key key}
    <!-- The viewer adds the canvas that draws the parsed model; it runs no code from the file. -->
    <div class="model-stage" use:viewer={view}>
      {#if status?.phase === 'failed'}
        <p class="model-note failed" role="alert">
          {status.message}
          <button type="button" class="model-action" onclick={() => viewers[view]?.retry()}>
            <RotateCcw size={12} aria-hidden="true" />Retry
          </button>
        </p>
      {:else if status?.phase !== 'ready'}
        <p class="model-note" role="status">Loading model…</p>
      {/if}
    </div>
  {/key}
{/snippet}

{#snippet bar(view: View)}
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
    <button
      type="button"
      class="model-action"
      aria-label="Zoom in"
      onclick={() => viewers[view]?.zoom(0.8)}><ZoomIn size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="model-action"
      aria-label="Zoom out"
      onclick={() => viewers[view]?.zoom(1.25)}><ZoomOut size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="model-action"
      aria-label="Reset view"
      onclick={() => viewers[view]?.reset()}
    >
      <RotateCcw size={13} aria-hidden="true" />
    </button>
    {#if view === 'inline'}
      <button
        type="button"
        class="model-action"
        aria-label={`Expand ${file.name}`}
        aria-haspopup="dialog"
        onclick={expand}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    {/if}
    <span class="model-size">{label}</span>
  </div>
{/snippet}

<figure class="model-view">
  {@render stage('inline')}
  {@render bar('inline')}
</figure>

<dialog
  bind:this={dialog}
  class="model-preview"
  aria-label="Model preview"
  onclose={() => {
    expanded = false;
    viewers.inline?.suspend(false);
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
    {@render stage('expanded')}
    {@render bar('expanded')}
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
