<script module lang="ts">
  import { createFetchCache, type ModelViews } from '$lib/tool-output';
  import type { ModelFormat } from '$lib/model-scene';
  // Models a window already read, as decoded bytes, bounded so several heavy files cannot
  // pile up. The inline and expanded views of a model share its entry; a model larger than
  // the whole budget is read again whenever its scene is built instead of kept.
  const keptBytes = 64_000_000;
  const models = createFetchCache<{ format: ModelFormat; bytes: ArrayBuffer }>(
    (model) => model.bytes.byteLength,
    { entries: 6, bytes: keptBytes },
  );
  // Views of models another computer keeps, which that computer renders once.
  const modelViews = createFetchCache<ModelViews>(
    (read) => read.views.reduce((total, view) => total + view.data.length, 0),
    { entries: 12, bytes: 48_000_000 },
  );
  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import {
    Box,
    ChevronLeft,
    ChevronRight,
    Maximize2,
    Pause,
    Play,
    RotateCcw,
    X,
    ZoomIn,
    ZoomOut,
  } from '@lucide/svelte';
  import {
    formatBytes,
    modelFormats,
    modelViewCount,
    toolOutputImageUrl,
    type ToolOutputModelType,
  } from '$lib/tool-output';
  import { modelShownAsViews, readToolOutputModel, readToolOutputModelViews } from '$lib/transport';
  import type { SentFile } from '$lib/sent-files';
  import {
    createModelViewer,
    whenNear,
    type ModelViewer,
    type ViewerStatus,
  } from '$lib/model-viewer';
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
  // A model this window can keep between scenes is read once, ahead of its stage.
  const kept = $derived(file.bytes <= keptBytes);
  function load() {
    // The loader follows the format the computer recognized in the file itself.
    const read = () => readToolOutputModel(runId, toolId, file.index, format, connectionId);
    return kept ? models.get(key, read) : read();
  }

  // Another computer's model too large for one relay request comes as views that computer
  // renders, a turn apart, which the reader turns through.
  const viewsOnly = $derived(modelShownAsViews(connectionId, file.bytes));
  type ViewsStatus =
    | { phase: 'loading' }
    | { phase: 'ready'; urls: string[] }
    | { phase: 'failed'; message: string };
  let views = $state<ViewsStatus>({ phase: 'loading' });
  let turn = $state(0);
  let viewsKey = '';
  function loadViews() {
    const requested = key;
    // The expanded stage shows what the inline one already has or awaits.
    if (requested === viewsKey && views.phase !== 'failed') return;
    if (requested !== viewsKey) turn = 0;
    viewsKey = requested;
    views = { phase: 'loading' };
    modelViews
      .get(requested, () => readToolOutputModelViews(runId, toolId, file.index, connectionId))
      .then(
        (read) => {
          if (requested === key)
            views = { phase: 'ready', urls: read.views.map(toolOutputImageUrl) };
        },
        (cause) => {
          if (requested === key)
            views = {
              phase: 'failed',
              message: String(cause instanceof Error ? cause.message : cause),
            };
        },
      );
  }
  /** Views are read once their stage comes near the screen, as a model is. */
  function viewsStage(stage: HTMLElement) {
    return { destroy: whenNear(stage, loadViews) };
  }
  function step(by: number) {
    turn = (turn + by + modelViewCount) % modelViewCount;
  }
  function turnKeys(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => step(-1),
      ArrowDown: () => step(-1),
      ArrowRight: () => step(1),
      ArrowUp: () => step(1),
      Home: () => (turn = 0),
      End: () => (turn = modelViewCount - 1),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }
  /** A horizontal drag turns through the views as it turns the 3D viewer; a vertical one scrolls. */
  function grab(event: PointerEvent) {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    const span = Math.min(64, Math.max(24, target.clientWidth / modelViewCount));
    let from = event.clientX;
    target.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => {
      const steps = Math.trunc((next.clientX - from) / span);
      if (!steps) return;
      step(steps);
      from += steps * span;
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
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
      readAhead: kept,
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

{#snippet turntable()}
  {#key key}
    <div class="model-stage" use:viewsStage>
      {#if views.phase === 'ready'}
        <div
          class="model-turntable"
          role="slider"
          tabindex="0"
          aria-label={`Turn ${file.name}`}
          aria-valuemin={1}
          aria-valuemax={modelViewCount}
          aria-valuenow={turn + 1}
          aria-valuetext={`View ${turn + 1} of ${modelViewCount}`}
          onkeydown={turnKeys}
          onpointerdown={grab}
        >
          <img src={views.urls[turn]} alt="" draggable="false" />
        </div>
      {:else if views.phase === 'failed'}
        <p class="model-note failed" role="alert">
          {views.message}
          <button type="button" class="model-action" onclick={loadViews}>
            <RotateCcw size={12} aria-hidden="true" />Retry
          </button>
        </p>
      {:else}
        <p class="model-note" role="status">Loading views…</p>
      {/if}
    </div>
  {/key}
{/snippet}

{#snippet turntableBar(view: View)}
  <div class="model-bar">
    <span class="model-name" title={file.name}><Box size={13} aria-hidden="true" />{file.name}</span
    >
    <span class="model-spacer"></span>
    <button
      type="button"
      class="model-action"
      aria-label="Turn left"
      disabled={views.phase !== 'ready'}
      onclick={() => step(-1)}><ChevronLeft size={13} aria-hidden="true" /></button
    >
    <span class="model-turn" aria-hidden="true">{turn + 1}/{modelViewCount}</span>
    <button
      type="button"
      class="model-action"
      aria-label="Turn right"
      disabled={views.phase !== 'ready'}
      onclick={() => step(1)}><ChevronRight size={13} aria-hidden="true" /></button
    >
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
    <span
      class="model-size"
      title="Too large to load on this device, so the computer that ran the reply sent eight views of it. Open the reply there to turn the model freely."
      >{label} · {modelViewCount} views</span
    >
  </div>
{/snippet}

<figure class="model-view">
  {#if viewsOnly}
    {@render turntable()}
    {@render turntableBar('inline')}
  {:else}
    {@render stage('inline')}
    {@render bar('inline')}
  {/if}
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
    {#if viewsOnly}
      {@render turntable()}
      {@render turntableBar('expanded')}
    {:else}
      {@render stage('expanded')}
      {@render bar('expanded')}
    {/if}
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
  .model-turn {
    min-width: 2.5em;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .model-action:disabled {
    opacity: 0.5;
    cursor: default;
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
