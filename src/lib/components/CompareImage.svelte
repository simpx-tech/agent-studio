<script lang="ts">
  import { ImageOff, RotateCcw } from '@lucide/svelte';
  import type { PaneLink, PanePlace } from '$lib/comparison';
  import { imageInfo, paneLabel, type SentFile } from '$lib/sent-files';
  import { imageLabel, toolOutputImageUrl } from '$lib/tool-output';
  import { KeptImage } from '$lib/tool-output-images.svelte';
  import ComparePane from './ComparePane.svelte';
  import ZoomableImage from './ZoomableImage.svelte';

  let {
    link,
    paneKey,
    runId,
    toolId,
    connectionId,
    file,
    position,
  }: {
    /** The comparison this image is a pane of. */
    link: PaneLink;
    paneKey: string;
    runId: string;
    toolId: string;
    connectionId?: string;
    file: SentFile;
    /** Its place among the comparison's files, from 0. */
    position: number;
  } = $props();

  // The chat and the file viewer show the image read once from the computer that keeps it.
  const kept = new KeptImage(() => ({ runId, toolId, index: file.index, connectionId }));
  const info = $derived(imageInfo(file));
  const label = $derived(paneLabel(file));
  const detail = $derived(imageLabel(info));
  const title = $derived(`${file.name} · ${detail}`);
  // The image's views in the chat and in the file viewer, while they are drawn.
  const images: Partial<Record<PanePlace, ReturnType<typeof ZoomableImage>>> = {};

  $effect(() =>
    link.join(paneKey, {
      expanded,
      shown() {},
      view(place) {
        const view = images[place]?.current();
        return view && { kind: 'image', view };
      },
      follow(place, view) {
        if (view.kind === 'image') images[place]?.take(view.view);
      },
      zoom: (place, factor) => images[place]?.zoomBy(factor),
      reset: (place) => images[place]?.fit(),
      animated: false,
      playing: false,
      setPlaying() {},
    }),
  );
</script>

{#snippet picture(place: PanePlace)}
  {#if kept.image}
    <ZoomableImage
      bind:this={images[place]}
      src={toolOutputImageUrl(kept.image)}
      alt={`Image ${position + 1}, ${label}`}
      width={info.width}
      height={info.height}
      pane={place}
      onopen={place === 'inline' ? link.expand : undefined}
      onmoved={(view) => link.moved(paneKey, place, { kind: 'image', view })}
      initial={() => {
        const shared = link.shared(paneKey, place, 'image');
        return shared?.kind === 'image' ? shared.view : undefined;
      }}
    />
  {:else if kept.error}
    <div class="pane-note failed" role="alert">
      <ImageOff size={14} aria-hidden="true" /><span>{kept.error}</span>
      <button type="button" class="pane-retry" onclick={() => kept.retry()}
        ><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </div>
  {:else}
    <p class="pane-note" role="status">Loading image…</p>
  {/if}
{/snippet}

<!-- The file viewer draws this pane at full size, beside the comparison's others. -->
{#snippet expanded()}
  <ComparePane place="expanded" {label} {detail} {title}>
    {#snippet stage()}{@render picture('expanded')}{/snippet}
  </ComparePane>
{/snippet}

<ComparePane place="inline" {label} {detail} {title}>
  {#snippet stage()}{@render picture('inline')}{/snippet}
</ComparePane>

<style>
  .pane-note {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 8px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
  .pane-note.failed {
    color: var(--danger);
  }
  .pane-retry {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .pane-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
