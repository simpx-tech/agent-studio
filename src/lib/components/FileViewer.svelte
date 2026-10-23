<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
  import { closeOnScrim } from '$lib/dialog-backdrop';
  import type { FileViewer, ViewedFile } from '$lib/file-viewer.svelte';
  import type { Inset } from '$lib/image-zoom';
  import { readKeptImage } from '$lib/tool-output-images.svelte';
  import ViewedImage from './ViewedImage.svelte';

  let { viewer }: { viewer: FileViewer } = $props();

  let dialog = $state<HTMLDialogElement>();
  let width = $state(0);
  let heading = $state(0);
  const file = $derived(viewer.file(viewer.current));
  const open = $derived(!!file);
  // Read again whenever the shown file or the set of files changes, as when a reply adds one.
  const order = $derived(file ? viewer.ordered() : []);
  const index = $derived(viewer.current ? order.indexOf(viewer.current) : -1);
  const kind = $derived(file?.kind ?? 'image');
  const several = $derived(order.length > 1);
  const previews: Record<ViewedFile['kind'], string> = {
    image: 'Image preview',
    model: 'Model preview',
    comparison: 'Comparison preview',
    table: 'Table preview',
    document: 'Document preview',
    video: 'Video preview',
    audio: 'Audio preview',
  };
  // The room the controls floating on the window keep clear of the whole file: the heading
  // above, the arrows at the sides and an image's zoom controls below. A zoomed image pans
  // under them to the window's edges; everything else stays within that room.
  const phone = $derived(width > 0 && width <= 640);
  const inset = $derived.by((): Inset => {
    const side = phone ? 8 : several ? 76 : 28;
    const bottom = kind === 'image' ? (phone ? 64 : 72) : phone ? 8 : 28;
    return { top: heading + (phone ? 4 : 8), right: side, bottom, left: side };
  });

  // The dialog exists only while it shows a file, and goes with the file's reply.
  $effect(() => {
    if (dialog && open && !dialog.open) dialog.showModal();
  });
  $effect(() => () => viewer.close());
  // A model, a comparison's models and a video give way in the chat while the viewer shows them.
  const shown = $derived(file && file.kind !== 'image' ? file.shown : undefined);
  $effect(() => {
    const show = shown;
    if (!show) return;
    untrack(() => show(true));
    return () => show(false);
  });
  // The neighbours' images are read ahead, so stepping to one shows it at once.
  $effect(() => {
    for (const element of [order[index - 1], order[index + 1]]) {
      const near = viewer.file(element);
      if (near?.kind === 'image')
        readKeptImage({
          runId: near.runId,
          toolId: near.toolId,
          index: near.info.index,
          connectionId: near.connectionId,
        }).catch(() => {});
    }
  });

  async function step(by: number) {
    viewer.step(by);
    await tick();
    // Focus stays in the viewer when the control that held it went with the last file.
    if (dialog?.open && !dialog.contains(document.activeElement)) dialog.focus();
  }
  // The arrow keys step through the files unless the file's own view used them, or one that
  // scrolls or plays with them has focus, as a table, a document or a video does.
  $effect(() => {
    if (!open) return;
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) return;
      if ((event.target as Element | null)?.closest?.('[data-own-keys]')) return;
      const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!by) return;
      event.preventDefault();
      void step(by);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });
</script>

{#if file}
  <!-- The viewer covers the window. Its scrim, the room around the file and its controls, closes
       it on a click, as Escape and Close do. -->
  <dialog
    bind:this={dialog}
    bind:clientWidth={width}
    class="file-viewer"
    aria-label={previews[kind]}
    tabindex="-1"
    onclose={() => viewer.close()}
    {@attach closeOnScrim}
  >
    <div class="file-viewer-body" data-scrim>
      {#key viewer.current}
        {#if file.kind === 'image'}
          <ViewedImage
            image={file}
            {inset}
            swipe={several ? (by) => void step(by) : undefined}
            backdrop={() => dialog?.close()}
          />
        {:else}
          <div
            class="file-viewer-frame"
            data-scrim
            style:padding={`${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`}
          >
            {@render file.view()}
          </div>
        {/if}
      {/key}
    </div>
    <!-- Clicks pass through the heading's shade to the file or the scrim below it. -->
    <header class="file-viewer-heading" class:stepping={several} bind:clientHeight={heading}>
      <div class="file-viewer-title" aria-live="polite">
        <div class="file-viewer-line">
          <span class="file-viewer-name" title={file.name}>{file.name}</span>
          <span class="file-viewer-detail">{file.label}</span>
          {#if several}<span class="file-viewer-detail">{index + 1} of {order.length}</span>{/if}
        </div>
        {#if file.caption}<p class="file-viewer-caption">{file.caption}</p>{/if}
      </div>
      <button
        type="button"
        class="file-viewer-close"
        aria-label={`Close ${kind} preview`}
        onclick={() => dialog?.close()}><X size={20} aria-hidden="true" /></button
      >
    </header>
    {#if several}
      <button
        type="button"
        class="file-viewer-step previous"
        aria-label="Previous file"
        title="Previous file"
        aria-disabled={index <= 0}
        onclick={() => void step(-1)}><ChevronLeft size={24} aria-hidden="true" /></button
      >
      <button
        type="button"
        class="file-viewer-step next"
        aria-label="Next file"
        title="Next file"
        aria-disabled={index >= order.length - 1}
        onclick={() => void step(1)}><ChevronRight size={24} aria-hidden="true" /></button
      >
    {/if}
  </dialog>
{/if}

<style>
  /* The whole window, on a dark scrim in every theme, with the controls floating on it. */
  .file-viewer {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--viewer-text);
    overflow: hidden;
    overscroll-behavior: contain;
  }
  .file-viewer[open] {
    display: block;
    animation: fade-in var(--duration) ease;
  }
  .file-viewer:focus {
    outline: none;
  }
  .file-viewer::backdrop {
    background: var(--viewer-scrim);
  }
  /* The file's own view: an image covering the window, or the file within the controls' room. */
  .file-viewer-body {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .file-viewer-frame {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .file-viewer-heading {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 2;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 12px 18px 20px;
    background: linear-gradient(var(--viewer-shade), transparent);
    font-size: var(--text-sm);
    pointer-events: none;
  }
  .file-viewer-heading > * {
    pointer-events: auto;
  }
  .file-viewer-title {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding-top: 7px;
  }
  .file-viewer-line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .file-viewer-name {
    min-width: 0;
    overflow: hidden;
    color: var(--viewer-text);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-viewer-detail {
    flex-shrink: 0;
    color: var(--viewer-text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .file-viewer-caption {
    margin: 0;
    max-width: 72ch;
    color: var(--viewer-text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .file-viewer-close,
  .file-viewer-step {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    padding: 0;
    border: 1px solid var(--viewer-border);
    border-radius: 50%;
    background: var(--viewer-control);
    color: var(--viewer-text);
    box-shadow: var(--shadow-md);
    cursor: pointer;
    backdrop-filter: blur(12px);
  }
  .file-viewer-close {
    width: 36px;
    height: 36px;
    margin-left: auto;
  }
  .file-viewer-close:hover,
  .file-viewer-step:not([aria-disabled='true']):hover {
    background: var(--viewer-control-hover);
  }
  .file-viewer-step {
    position: absolute;
    top: 50%;
    z-index: 2;
    width: 48px;
    height: 48px;
    translate: 0 -50%;
  }
  .file-viewer-step.previous {
    left: 16px;
  }
  .file-viewer-step.next {
    right: 16px;
  }
  .file-viewer-step[aria-disabled='true'] {
    opacity: 0.3;
    cursor: default;
  }
  /* On a phone the arrows join Close above the file, which takes the whole width. */
  @media (max-width: 640px) {
    .file-viewer-heading {
      padding: 8px 8px 14px 12px;
    }
    .file-viewer-heading.stepping .file-viewer-title {
      margin-right: 88px;
    }
    .file-viewer-step {
      top: 8px;
      width: 36px;
      height: 36px;
      translate: none;
    }
    .file-viewer-step.previous {
      right: 92px;
      left: auto;
    }
    .file-viewer-step.next {
      right: 50px;
    }
  }
</style>
