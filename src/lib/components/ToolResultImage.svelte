<script module lang="ts">
  import { createFetchCache, imageSize, type ToolOutputImage } from '$lib/tool-output';
  import { readToolOutputImage } from '$lib/transport';
  // Images a window already loaded, bounded so a long run of screenshots cannot pile up.
  const images = createFetchCache<ToolOutputImage>(imageSize, { entries: 64, bytes: 96_000_000 });
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { ImageOff, RotateCcw } from '@lucide/svelte';
  import { formatBytes, toolOutputImageUrl, type ToolOutputImageInfo } from '$lib/tool-output';

  let {
    runId,
    toolId,
    connectionId,
    info,
    name,
    open,
  }: {
    runId: string;
    toolId: string;
    connectionId?: string;
    info: ToolOutputImageInfo;
    /** The tool that returned the image, for its description. */
    name: string;
    open: (image: ToolOutputImage, label: string) => void;
  } = $props();

  let image = $state<ToolOutputImage>();
  let error = $state('');
  let attempt = $state(0);
  // Only the image's identity selects it; relay updates of the call do not reload it.
  const key = $derived(`${runId}\n${toolId}\n${info.index}`);
  $effect(() => {
    const current = key;
    void attempt;
    let live = true;
    error = '';
    untrack(() =>
      images.get(current, () => readToolOutputImage(runId, toolId, info.index, connectionId)),
    ).then(
      (value) => {
        if (live) image = value;
      },
      (reason) => {
        if (live) error = String(reason instanceof Error ? reason.message : reason);
      },
    );
    return () => {
      live = false;
    };
  });
  const label = $derived(
    [info.width && info.height ? `${info.width} × ${info.height}` : '', formatBytes(info.bytes)]
      .filter(Boolean)
      .join(' · '),
  );
  // Icons and other tiny images are enlarged with crisp pixels.
  const small = $derived((info.width ?? 64) < 64 && (info.height ?? 64) < 64);
</script>

<figure class="result-image" class:small>
  {#if image}
    <button
      type="button"
      title="Open image"
      aria-label={`Open image ${info.index + 1}, ${label}`}
      onclick={() => open(image!, label)}
    >
      <img
        src={toolOutputImageUrl(image)}
        alt={`Image ${info.index + 1} returned by ${name}`}
        width={info.width}
        height={info.height}
      />
    </button>
  {:else if error}
    <div class="image-state failed" role="alert">
      <ImageOff size={16} aria-hidden="true" /><span>{error}</span>
      <button type="button" class="image-retry" onclick={() => attempt++}
        ><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </div>
  {:else}
    <!-- The placeholder takes the image's shape, so loading it moves nothing. -->
    <div
      class="image-state"
      role="status"
      style:aspect-ratio={info.width && info.height ? `${info.width} / ${info.height}` : undefined}
      style:width={info.width ? `min(100%, ${Math.max(info.width, small ? 64 : 0)}px)` : undefined}
    >
      Loading image…
    </div>
  {/if}
  <figcaption>{label}</figcaption>
</figure>

<style>
  .result-image {
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
  .result-image button:not(.image-retry) {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  .result-image:hover {
    border-color: var(--border-hover);
  }
  img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    width: auto;
    height: auto;
    border-radius: var(--radius-xs);
    background: repeating-conic-gradient(var(--hover) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  }
  .small img {
    min-width: 64px;
    image-rendering: pixelated;
  }
  .image-state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 120px;
    max-width: 100%;
    max-height: 320px;
    min-height: 48px;
    padding: 8px;
    border-radius: var(--radius-xs);
    background: var(--hover);
    font-size: var(--text-xs);
    text-align: center;
  }
  .image-state.failed {
    color: var(--danger);
  }
  .image-retry {
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
  .image-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
  figcaption {
    font-variant-numeric: tabular-nums;
  }
</style>
