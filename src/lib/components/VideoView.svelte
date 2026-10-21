<script lang="ts">
  import { Film, Play, RotateCcw } from '@lucide/svelte';
  import { formatBytes } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';
  import { KeptVideo, formatName } from '$lib/shown-files.svelte';
  import type { FileViewer, ViewedPage } from '$lib/file-viewer.svelte';
  import FileCard from './FileCard.svelte';

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
    /** The caption of the group the video came in. */
    caption?: string;
    /** The viewer that connects this video with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  // This computer streams its own videos as they play; another computer's is read whole, which
  // waits for the reader to ask for it.
  const video = new KeptVideo(() => ({ runId, toolId, index: file.index, connectionId }));
  $effect(() => {
    if (!video.remote) void video.load();
    return () => video.dispose();
  });
  let inline = $state<HTMLVideoElement>();
  // The picture's size, as its file reported it until the player reads it.
  let natural = $state<{ width: number; height: number }>();
  const width = $derived(natural?.width ?? file.width);
  const height = $derived(natural?.height ?? file.height);
  const detail = $derived(
    [formatName(file), width && height ? `${width} × ${height}` : '', formatBytes(file.bytes)]
      .filter(Boolean)
      .join(' · '),
  );
  // The viewer takes the video up where the chat's player was, playing if it played, and gives
  // it back where it stopped.
  let resume = { time: 0, playing: false };
  let watched: number | undefined;
  function shown(showing: boolean) {
    if (showing) {
      watched = undefined;
      resume = { time: inline?.currentTime ?? 0, playing: !!inline && !inline.paused };
      inline?.pause();
    } else if (inline && watched !== undefined) inline.currentTime = watched;
  }
  const viewed = $derived<ViewedPage>({
    kind: 'video',
    name: file.name,
    label: detail,
    caption,
    view: expandedView,
    shown,
  });
  function measured(event: Event) {
    const element = event.currentTarget as HTMLVideoElement;
    if (element.videoWidth && element.videoHeight)
      natural = { width: element.videoWidth, height: element.videoHeight };
  }
  /** Plays a video read from another computer once it arrives. */
  async function play(element: () => HTMLVideoElement | undefined) {
    if (!(await video.load())) return;
    // The player exists once its source does.
    await Promise.resolve();
    void element()
      ?.play()
      .catch(() => {});
  }
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  // The whole picture, as large as the viewer's room allows.
  const fit = $derived.by(() => {
    if (!width || !height || !stageWidth || !stageHeight) return undefined;
    const scale = Math.min(stageWidth / width, stageHeight / height);
    return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
  });
  let expanded = $state<HTMLVideoElement>();
  function begin(element: HTMLVideoElement) {
    const start = () => {
      element.currentTime = resume.time;
      if (resume.playing) void element.play().catch(() => {});
    };
    if (element.readyState >= 1) start();
    else element.addEventListener('loadedmetadata', start, { once: true });
  }
</script>

{#snippet waiting(element: () => HTMLVideoElement | undefined)}
  {#if video.error}
    <p class="video-note failed" role="alert">
      {video.error}
      <button type="button" class="video-retry" onclick={() => play(element)}
        ><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </p>
  {:else if video.loading}
    <p class="video-note" role="status">Loading video…</p>
  {:else}
    <button type="button" class="video-start" onclick={() => play(element)}>
      <Play size={18} aria-hidden="true" /><span>Play video · {formatBytes(file.bytes)}</span>
    </button>
  {/if}
{/snippet}

<!-- The file viewer plays the video as large as the window allows, beside the chat's other files. -->
{#snippet expandedView()}
  <div class="video-stage" data-scrim bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
    {#if video.url}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={expanded}
        class="video-player expanded"
        src={video.url}
        controls
        playsinline
        preload="metadata"
        data-own-keys
        aria-label={file.name}
        style:width={fit ? `${fit.width}px` : undefined}
        style:height={fit ? `${fit.height}px` : undefined}
        onloadedmetadata={measured}
        ontimeupdate={(event) => (watched = (event.currentTarget as HTMLVideoElement).currentTime)}
        {@attach begin}
      ></video>
    {:else}
      <div class="video-box waiting">{@render waiting(() => expanded)}</div>
    {/if}
  </div>
{/snippet}

<FileCard
  name={file.name}
  {detail}
  attach={viewer.attach(() => viewed)}
  expand={(from) => viewer.open(from)}
>
  {#snippet icon()}<Film size={13} aria-hidden="true" />{/snippet}
  <div class="video-box" style:aspect-ratio={width && height ? `${width} / ${height}` : undefined}>
    {#if video.url}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={inline}
        class="video-player"
        src={video.url}
        controls
        playsinline
        preload="metadata"
        aria-label={file.name}
        onloadedmetadata={measured}
      ></video>
    {:else}
      {@render waiting(() => inline)}
    {/if}
  </div>
</FileCard>

<style>
  .video-box {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: min(560px, 70vh);
    border-radius: var(--radius-xs);
    background: var(--viewer-scrim);
    overflow: hidden;
  }
  .video-player {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: transparent;
  }
  /* In the file viewer the picture takes all the room it can, the scrim around it. */
  .video-stage {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .video-player.expanded {
    max-width: 100%;
    max-height: 100%;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xl);
  }
  .video-box.waiting {
    max-width: 720px;
  }
  .video-start {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 18px;
    border: 1px solid var(--viewer-border);
    border-radius: var(--radius-full);
    background: var(--viewer-control);
    color: var(--viewer-text);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .video-start:hover {
    background: var(--viewer-control-hover);
  }
  .video-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin: 0;
    padding: 12px;
    color: var(--viewer-text-muted);
    font-size: var(--text-xs);
    text-align: center;
  }
  .video-note.failed {
    color: var(--danger);
  }
  .video-retry {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--viewer-text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .video-retry:hover {
    background: var(--viewer-control-hover);
    color: var(--viewer-text);
  }
</style>
