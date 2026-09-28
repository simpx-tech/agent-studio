<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
  import type { FileViewer } from '$lib/file-viewer.svelte';
  import { readKeptImage } from '$lib/tool-output-images.svelte';
  import ViewedImage from './ViewedImage.svelte';

  let { viewer }: { viewer: FileViewer } = $props();

  let dialog = $state<HTMLDialogElement>();
  const file = $derived(viewer.file(viewer.current));
  const open = $derived(!!file);
  // Read again whenever the shown file or the set of files changes, as when a reply adds one.
  const order = $derived(file ? viewer.ordered() : []);
  const index = $derived(viewer.current ? order.indexOf(viewer.current) : -1);
  const kind = $derived(file?.kind === 'model' ? 'model' : 'image');

  // The dialog exists only while it shows a file, and goes with the file's reply.
  $effect(() => {
    if (dialog && open && !dialog.open) dialog.showModal();
  });
  $effect(() => () => viewer.close());
  // A model gives its inline view's scene up while the viewer shows it.
  const shown = $derived(file?.kind === 'model' ? file.shown : undefined);
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
  // The arrow keys step through the files unless the file's own view used them.
  $effect(() => {
    if (!open) return;
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) return;
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
  <dialog
    bind:this={dialog}
    class="file-viewer"
    aria-label={kind === 'model' ? 'Model preview' : 'Image preview'}
    tabindex="-1"
    onclose={() => viewer.close()}
  >
    <header class="file-viewer-heading">
      <span class="file-viewer-title" aria-live="polite">
        <span class="file-viewer-name" title={file.name}>{file.name}</span>
        <span class="file-viewer-detail">{file.label}</span>
        {#if order.length > 1}<span class="file-viewer-detail">{index + 1} of {order.length}</span
          >{/if}
      </span>
      <button
        type="button"
        class="icon-button"
        aria-label={`Close ${kind} preview`}
        onclick={() => dialog?.close()}><X size={18} /></button
      >
    </header>
    <div class="file-viewer-body">
      {#key viewer.current}
        {#if file.kind === 'image'}
          <ViewedImage image={file} swipe={order.length > 1 ? (by) => void step(by) : undefined} />
        {:else}
          {@render file.view()}
        {/if}
      {/key}
      {#if order.length > 1}
        <button
          type="button"
          class="file-viewer-step previous"
          aria-label="Previous file"
          title="Previous file"
          aria-disabled={index <= 0}
          onclick={() => void step(-1)}><ChevronLeft size={22} aria-hidden="true" /></button
        >
        <button
          type="button"
          class="file-viewer-step next"
          aria-label="Next file"
          title="Next file"
          aria-disabled={index >= order.length - 1}
          onclick={() => void step(1)}><ChevronRight size={22} aria-hidden="true" /></button
        >
      {/if}
    </div>
    {#if file.caption}<p class="file-viewer-caption">{file.caption}</p>{/if}
  </dialog>
{/if}

<style>
  .file-viewer {
    width: min(96vw, 1600px);
    height: min(94dvh, 1200px);
    max-width: none;
    max-height: none;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .file-viewer[open] {
    display: flex;
    flex-direction: column;
    animation: fade-in var(--duration) ease;
  }
  .file-viewer:focus {
    outline: none;
  }
  .file-viewer::backdrop {
    background: var(--backdrop);
  }
  .file-viewer-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 6px 6px 14px;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .file-viewer-title {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .file-viewer-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .file-viewer-detail {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* The file's own view fills the body: a zoomable image or the model's stage, each with its
     controls below. */
  .file-viewer-body {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .file-viewer-step {
    position: absolute;
    top: 50%;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    background: var(--surface-overlay);
    color: var(--text-secondary);
    box-shadow: var(--shadow-md);
    translate: 0 -50%;
    cursor: pointer;
  }
  .file-viewer-step.previous {
    left: 12px;
  }
  .file-viewer-step.next {
    right: 12px;
  }
  .file-viewer-step:not([aria-disabled='true']):hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .file-viewer-step[aria-disabled='true'] {
    opacity: 0.35;
    cursor: default;
  }
  .file-viewer-caption {
    margin: 0;
    padding: 8px 14px 10px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    .file-viewer {
      width: 100vw;
      height: 100dvh;
      border: 0;
      border-radius: 0;
    }
    .file-viewer-step {
      width: 36px;
      height: 36px;
    }
    .file-viewer-step.previous {
      left: 6px;
    }
    .file-viewer-step.next {
      right: 6px;
    }
  }
</style>
