<script lang="ts">
  import {
    Link2,
    Maximize2,
    Pause,
    Play,
    RotateCcw,
    Sun,
    Unlink2,
    ZoomIn,
    ZoomOut,
  } from '@lucide/svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { isModel, type SentFile, type SentFiles } from '$lib/sent-files';
  import {
    comparisonDetail,
    comparisonName,
    paneAspect,
    PaneSync,
    viewerColumns,
    type ComparedPane,
    type PaneLink,
    type PanePlace,
  } from '$lib/comparison';
  import { lightings, type Lighting } from '$lib/model-scene';
  import { modelLighting, setModelLighting } from '$lib/model-lighting.svelte';
  import type { FileViewer, ViewedComparison } from '$lib/file-viewer.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import CompareImage from './CompareImage.svelte';
  import CompareModel from './CompareModel.svelte';

  let {
    group,
    connectionId,
    viewer,
  }: {
    /** A compare_files group: two or more files side by side. */
    group: SentFiles;
    connectionId?: string;
    /** The viewer that connects the comparison with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  const panes = new SvelteMap<string, ComparedPane>();
  const sync = new PaneSync(panes);
  // Synced to begin with: a comparison looks at the same thing in each file.
  let synced = $state(true);
  const link: PaneLink = {
    join(key, pane) {
      panes.set(key, pane);
      return () => {
        if (panes.get(key) === pane) panes.delete(key);
      };
    },
    moved: (key, place, view) => sync.moved(key, place, view),
    shared: (key, place, kind) => sync.shared(key, place, kind),
  };
  // Only a file's identity selects its pane, so a comparison sent again rebuilds what changed.
  const fileKey = (file: SentFile) =>
    `${group.runId}\n${group.toolId}\n${isModel(file) ? 'model' : 'image'}\n${file.index}`;
  const keys = $derived(group.files.map(fileKey));
  const models = $derived(group.files.filter(isModel).length);
  // Synced means something only when two panes show the same kind of file.
  const syncable = $derived(models > 1 || group.files.length - models > 1);
  const aspect = $derived(paneAspect(group.files));
  const columns = $derived(viewerColumns(group.files.length));
  const animated = $derived([...panes.values()].filter((pane) => pane.animated));
  const playing = $derived(animated.some((pane) => pane.playing));

  const modes = [
    { synced: false, name: 'Free', icon: Unlink2 },
    { synced: true, name: 'Synced', icon: Link2 },
  ];
  function setMode(next: boolean) {
    synced = next;
    sync.setSynced(next);
  }
  // The arrows choose a mode, as in any radio group, and so never step the file viewer.
  function modeKeys(event: KeyboardEvent) {
    const next = { ArrowLeft: false, ArrowUp: false, ArrowRight: true, ArrowDown: true }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setMode(next);
    const radios = (event.currentTarget as HTMLElement).parentElement;
    radios?.querySelector<HTMLButtonElement>(`[data-synced="${next}"]`)?.focus();
  }
  function toggle() {
    const next = !playing;
    for (const pane of animated) pane.setPlaying(next);
  }
  // A comparison's models give their scenes in the chat up while the file viewer shows them.
  function shown(showing: boolean) {
    for (const pane of panes.values()) pane.shown(showing);
  }
  const viewed = $derived<ViewedComparison>({
    kind: 'comparison',
    name: comparisonName(group.files),
    label: comparisonDetail(group.files),
    caption: group.caption,
    view: expandedView,
    shown,
  });
</script>

{#snippet bar(place: PanePlace)}
  <div class="compare-bar">
    {#if syncable}
      <div class="compare-mode" role="radiogroup" aria-label="Views">
        {#each modes as mode (mode.name)}
          <button
            type="button"
            role="radio"
            class="mode-option"
            data-synced={mode.synced}
            aria-checked={synced === mode.synced}
            tabindex={synced === mode.synced ? 0 : -1}
            onclick={() => setMode(mode.synced)}
            onkeydown={modeKeys}><mode.icon size={13} aria-hidden="true" />{mode.name}</button
          >
        {/each}
      </div>
    {/if}
    {#if animated.length}
      <button
        type="button"
        class="compare-action"
        onclick={toggle}
        aria-label={playing ? 'Pause animations' : 'Play animations'}
      >
        {#if playing}<Pause size={13} aria-hidden="true" />{:else}<Play
            size={13}
            aria-hidden="true"
          />{/if}
      </button>
    {/if}
    <span class="compare-spacer"></span>
    {#if models}
      <ChoicePicker
        options={lightings}
        value={modelLighting.value}
        label="Lighting"
        onchange={(value) => setModelLighting(value as Lighting)}
      >
        {#snippet icon()}<Sun size={13} />{/snippet}
      </ChoicePicker>
    {/if}
    <button
      type="button"
      class="compare-action"
      aria-label="Zoom in"
      onclick={() => sync.zoom(place, 1.25)}><ZoomIn size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="compare-action"
      aria-label="Zoom out"
      onclick={() => sync.zoom(place, 0.8)}><ZoomOut size={13} aria-hidden="true" /></button
    >
    <button
      type="button"
      class="compare-action"
      aria-label="Reset views"
      onclick={() => sync.reset(place)}
    >
      <RotateCcw size={13} aria-hidden="true" />
    </button>
    {#if place === 'inline'}
      <button
        type="button"
        class="compare-action"
        aria-label="Expand comparison"
        aria-haspopup="dialog"
        onclick={(event) => viewer.open(event.currentTarget)}
      >
        <Maximize2 size={13} aria-hidden="true" />
      </button>
    {/if}
  </div>
{/snippet}

{#snippet panesOf(place: PanePlace)}
  {#if place === 'inline'}
    {#each group.files as file, position (fileKey(file))}
      {#if isModel(file)}
        <CompareModel
          {link}
          paneKey={fileKey(file)}
          runId={group.runId}
          toolId={group.toolId}
          {connectionId}
          {file}
        />
      {:else}
        <CompareImage
          {link}
          paneKey={fileKey(file)}
          runId={group.runId}
          toolId={group.toolId}
          {connectionId}
          {file}
          {position}
        />
      {/if}
    {/each}
  {:else}
    <!-- Each pane in the chat draws its file at full size here. -->
    {#each keys as key (key)}
      {@const pane = panes.get(key)}
      {#if pane}{@render pane.expanded()}{/if}
    {/each}
  {/if}
{/snippet}

<!-- The file viewer draws every pane at full size, side by side. -->
{#snippet expandedView()}
  <div
    class="compare-expanded"
    style:--wide={columns.wide}
    style:--tall={columns.tall}
    style:--pane-aspect={aspect}
  >
    <div class="compare-grid expanded">{@render panesOf('expanded')}</div>
    {@render bar('expanded')}
  </div>
{/snippet}

<div
  class="compare-view"
  role="group"
  aria-label={`Comparison of ${comparisonName(group.files)}`}
  style:--pane-aspect={aspect}
  {@attach viewer.attach(viewed)}
>
  <div class="compare-grid">{@render panesOf('inline')}</div>
  {@render bar('inline')}
</div>

<style>
  .compare-view {
    display: grid;
    gap: 4px;
    min-width: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .compare-view:hover {
    border-color: var(--border-hover);
  }
  /* Side by side at any width a pane stays usable at, wrapping only on the narrowest screens. */
  .compare-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr));
    gap: 4px;
    min-width: 0;
  }
  /* In the file viewer the panes share its room, in columns, or in rows on a tall screen. */
  .compare-expanded {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    container-type: size;
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .compare-grid.expanded {
    flex: 1;
    min-height: 0;
    grid-template-columns: repeat(var(--wide), minmax(0, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 1px;
    background: var(--border);
  }
  @container (orientation: portrait) {
    .compare-grid.expanded {
      grid-template-columns: repeat(var(--tall), minmax(0, 1fr));
    }
  }
  .compare-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .compare-expanded .compare-bar {
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }
  .compare-spacer {
    flex: 1;
  }
  .compare-mode {
    display: inline-flex;
    padding: 1px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .mode-option {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .mode-option:hover {
    color: var(--text);
  }
  .mode-option[aria-checked='true'] {
    background: var(--accent-soft);
    color: var(--text);
  }
  .compare-action {
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
  .compare-action:hover {
    background: var(--hover);
    color: var(--text);
  }
  /* The Lighting picker stays the size of the bar's buttons. */
  .compare-bar :global(.picker-trigger) {
    min-height: 22px;
    padding: 0 4px 0 6px;
    gap: 4px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
