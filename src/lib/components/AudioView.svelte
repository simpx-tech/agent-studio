<script lang="ts">
  import {
    AudioLines,
    LoaderCircle,
    Pause,
    Play,
    RotateCcw,
    Volume2,
    VolumeX,
  } from '@lucide/svelte';
  import { formatBytes } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';
  import { formatName } from '$lib/shown-files.svelte';
  import { AudioPlayer } from '$lib/audio-player.svelte';
  import { mediaTime, seekKey } from '$lib/media-time';
  import { whenNear } from '$lib/model-viewer';
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
    /** The caption of the group the sound came in. */
    caption?: string;
    /** The viewer that connects this sound with the chat's other files. */
    viewer: FileViewer;
  } = $props();

  // One player for the card and the viewer, so the sound goes on wherever the reader looks. This
  // computer streams its own sounds as they play; another computer's is read whole on Play.
  const player = new AudioPlayer(() => ({ runId, toolId, index: file.index, connectionId }));
  let row = $state<HTMLElement>();
  // A sound kept on this computer reads its length once its card nears the screen.
  $effect(() => {
    const element = row;
    if (element) return whenNear(element, () => player.prepare());
  });
  $effect(() => () => player.dispose());
  const error = $derived(player.error || player.media.error);
  const detail = $derived(
    [formatName(file), player.duration ? mediaTime(player.duration) : '', formatBytes(file.bytes)]
      .filter(Boolean)
      .join(' · '),
  );
  const viewed = $derived<ViewedPage>({
    kind: 'audio',
    name: file.name,
    label: detail,
    caption,
    view: expandedView,
    // The viewer draws this player's controls too, so nothing changes as it opens or closes.
    shown: () => {},
  });
  const progress = $derived(player.duration ? Math.min(1, player.time / player.duration) : 0);
  const position = $derived(
    player.duration
      ? `${mediaTime(player.time)} of ${mediaTime(player.duration)}`
      : mediaTime(player.time),
  );
  // Space plays or pauses from the position slider, whose other keys move along the sound.
  function keys(event: KeyboardEvent) {
    if (event.key === ' ') {
      event.preventDefault();
      player.toggle();
      return;
    }
    const to = player.duration ? seekKey(event.key, player.time, player.duration) : undefined;
    if (to === undefined) return;
    event.preventDefault();
    player.seek(to);
  }
</script>

{#snippet controls(large: boolean)}
  {@const icon = large ? 22 : 15}
  <div
    class="audio-player"
    class:large
    class:seekable={!!player.duration}
    style:--progress={progress}
  >
    <button
      type="button"
      class="audio-play"
      aria-label={`${player.playing ? 'Pause' : 'Play'} ${file.name}`}
      onclick={() => player.toggle()}
    >
      {#if player.media.loading}
        <LoaderCircle size={icon} class="spinning" aria-hidden="true" />
      {:else if player.playing}
        <Pause size={icon} fill="currentColor" aria-hidden="true" />
      {:else}
        <Play size={icon} fill="currentColor" class="audio-play-mark" aria-hidden="true" />
      {/if}
    </button>
    <span class="audio-time">{mediaTime(player.time)}</span>
    <div class="audio-track">
      <span class="audio-line" aria-hidden="true"><span class="audio-fill"></span></span>
      <span class="audio-thumb" aria-hidden="true"></span>
      <!-- The input keeps the pointer, the keys and what assistive technology reads; the page
           draws the rest. -->
      <input
        type="range"
        min="0"
        max={player.duration ?? 0}
        step="any"
        value={player.time}
        disabled={!player.duration}
        aria-label={`Position in ${file.name}`}
        aria-valuetext={position}
        data-own-keys
        oninput={(event) => player.seek(event.currentTarget.valueAsNumber)}
        onkeydown={keys}
      />
    </div>
    <span class="audio-time">{player.duration ? mediaTime(player.duration) : ''}</span>
    <button
      type="button"
      class="audio-mute"
      aria-label={`${player.muted ? 'Unmute' : 'Mute'} ${file.name}`}
      onclick={() => player.toggleMute()}
    >
      {#if player.muted}
        <VolumeX size={large ? 18 : 14} aria-hidden="true" />
      {:else}
        <Volume2 size={large ? 18 : 14} aria-hidden="true" />
      {/if}
    </button>
  </div>
  {#if error}
    <p class="audio-note" class:large role="alert">
      {error}
      <button type="button" class="audio-retry" onclick={() => player.retry()}
        ><RotateCcw size={12} aria-hidden="true" />Retry</button
      >
    </p>
  {/if}
{/snippet}

<!-- The file viewer shows the same player, larger, beside the chat's other files. -->
{#snippet expandedView()}
  <div class="audio-stage" data-scrim>
    <div class="audio-panel">
      <span class="audio-mark" class:playing={player.playing} aria-hidden="true"
        ><AudioLines size={40} /></span
      >
      {@render controls(true)}
    </div>
  </div>
{/snippet}

<FileCard
  name={file.name}
  {detail}
  attach={viewer.attach(() => viewed)}
  expand={(from) => viewer.open(from)}
>
  {#snippet icon()}<AudioLines size={13} aria-hidden="true" />{/snippet}
  <div class="audio-box" bind:this={row}>
    {@render controls(false)}
  </div>
</FileCard>

<style>
  /* The colours the player draws with, the viewer's own in the viewer, which is dark in every
     theme. */
  .audio-box {
    --fill: var(--accent-strong);
    --ring: var(--focus-ring);
    --track: var(--border-strong);
    display: grid;
    gap: 6px;
    padding: 8px 10px 8px 8px;
    border-radius: var(--radius-xs);
    background: var(--bg);
  }
  .audio-player {
    --thumb: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    color: var(--text-muted);
  }
  .audio-play {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-fg);
    cursor: pointer;
    transition: background-color var(--duration-fast) ease;
  }
  .audio-play:hover {
    background: var(--accent-hover);
  }
  /* A triangle's weight sits left of its box, so it moves right to look centred. */
  .audio-play :global(.audio-play-mark) {
    translate: 1px 0;
  }
  .audio-play:focus-visible,
  .audio-mute:focus-visible,
  .audio-retry:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  /* Room for 0:00 on both sides, so the bar keeps its length as the numbers change. */
  .audio-time {
    flex-shrink: 0;
    min-width: 4ch;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  /* Its own width, in container units, is how far the thumb travels. */
  .audio-track {
    position: relative;
    flex: 1;
    min-width: 48px;
    height: 24px;
    container-type: inline-size;
  }
  .audio-line {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2);
    right: calc(var(--thumb) / 2);
    height: 4px;
    margin-top: -2px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--track);
  }
  .audio-fill {
    position: absolute;
    inset: 0;
    background: var(--fill);
    transform: scaleX(var(--progress));
    transform-origin: left center;
  }
  /* Moved by `translate`, which a hover's `scale` leaves alone, and never past the track, so the
     chat never scrolls sideways for it. */
  .audio-thumb {
    position: absolute;
    top: 50%;
    left: 0;
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc(var(--thumb) / -2);
    border-radius: 50%;
    background: var(--fill);
    translate: calc(var(--progress) * (100cqw - var(--thumb))) 0;
    scale: 0;
    pointer-events: none;
    transition:
      scale var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) ease;
  }
  .seekable .audio-thumb {
    scale: 1;
  }
  .seekable .audio-track:hover .audio-thumb {
    scale: 1.2;
  }
  .audio-track:has(input:focus-visible) .audio-thumb {
    box-shadow: 0 0 0 3px var(--ring);
  }
  /* The native slider, unseen over the drawn one, its thumb as wide as the drawn thumb so a press
     lands where the drawn bar shows it. */
  .audio-track input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .audio-track input:disabled {
    cursor: default;
  }
  .audio-track input::-webkit-slider-thumb {
    width: var(--thumb);
    height: 24px;
    -webkit-appearance: none;
  }
  .audio-track input::-moz-range-thumb {
    width: var(--thumb);
    height: 24px;
    border: 0;
  }
  .audio-mute {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .audio-mute:hover {
    background: var(--hover);
    color: var(--text);
  }
  .audio-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--danger);
    font-size: var(--text-xs);
  }
  .audio-retry {
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
  .audio-retry:hover {
    background: var(--hover);
    color: var(--text);
  }
  /* In the file viewer the player stands alone on the scrim, larger, in the viewer's colours. */
  .audio-stage {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .audio-panel {
    --fill: var(--accent);
    --ring: var(--accent);
    --track: var(--viewer-control-hover);
    display: grid;
    justify-items: center;
    gap: 28px;
    width: min(560px, 100%);
    padding: 40px 28px 28px;
    border: 1px solid var(--viewer-border);
    border-radius: var(--radius-2xl);
    background: var(--viewer-control);
    box-shadow: var(--shadow-xl);
  }
  .audio-mark {
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    transition: scale var(--duration-slow) var(--ease-out);
  }
  .audio-mark.playing {
    scale: 1.06;
  }
  .audio-player.large {
    --thumb: 14px;
    gap: 12px;
    width: 100%;
    color: var(--viewer-text-muted);
  }
  .large .audio-play {
    width: 48px;
    height: 48px;
  }
  .large .audio-time {
    font-size: var(--text-sm);
  }
  .large .audio-line {
    height: 6px;
    margin-top: -3px;
    border-radius: 3px;
  }
  .large .audio-mute {
    width: 36px;
    height: 36px;
    color: var(--viewer-text-muted);
  }
  .large .audio-mute:hover,
  .large .audio-retry:hover {
    background: var(--viewer-control-hover);
    color: var(--viewer-text);
  }
  .audio-note.large {
    justify-content: center;
  }
  .large .audio-retry {
    color: var(--viewer-text-muted);
  }
  @media (max-width: 640px) {
    .audio-panel {
      padding: 32px 16px 20px;
    }
    .audio-player.large {
      gap: 8px;
    }
  }
</style>
