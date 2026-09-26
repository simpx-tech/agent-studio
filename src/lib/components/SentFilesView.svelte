<script lang="ts">
  import { tick } from 'svelte';
  import { X } from '@lucide/svelte';
  import { imageInfo, isModel, type SentFiles } from '$lib/sent-files';
  import { toolOutputImageUrl, type ToolOutputImage } from '$lib/tool-output';
  import ToolResultImage from './ToolResultImage.svelte';
  import ModelView from './ModelView.svelte';

  let {
    files,
    connectionId,
  }: {
    /** One accepted call: its images stay on the computer that ran the reply. */
    files: SentFiles;
    connectionId?: string;
  } = $props();

  let preview = $state<{ image: ToolOutputImage; label: string }>();
  let dialog = $state<HTMLDialogElement>();
  let previewName = $state('');
  async function open(image: ToolOutputImage, label: string, name: string) {
    preview = { image, label };
    previewName = name;
    await tick();
    dialog?.showModal();
  }
</script>

<figure class="sent-files">
  <div class="sent-images">
    {#each files.files as file (`${file.mediaType}:${file.index}`)}
      {#if isModel(file)}
        <ModelView runId={files.runId} toolId={files.toolId} {connectionId} {file} />
      {:else}
        <ToolResultImage
          runId={files.runId}
          toolId={files.toolId}
          {connectionId}
          info={imageInfo(file)}
          name={file.name}
          open={(image, label) => open(image, label, file.name)}
        />
      {/if}
    {/each}
  </div>
  {#if files.caption}<figcaption>{files.caption}</figcaption>{/if}
</figure>

<dialog
  bind:this={dialog}
  class="image-preview"
  aria-label="Image preview"
  onclose={() => (preview = undefined)}
>
  {#if preview}
    <div class="image-preview-heading">
      <span>{previewName} · {preview.label}</span><button
        type="button"
        class="icon-button"
        aria-label="Close image preview"
        onclick={() => dialog?.close()}><X size={18} /></button
      >
    </div>
    <img src={toolOutputImageUrl(preview.image)} alt={`Full size ${previewName}`} />
  {/if}
</dialog>

<style>
  .sent-files {
    display: grid;
    gap: 6px;
    margin: 0 0 14px;
  }
  .sent-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }
  figcaption {
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
  .image-preview {
    max-width: min(96vw, 1600px);
    max-height: 94vh;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-xl);
  }
  .image-preview::backdrop {
    background: var(--backdrop);
  }
  .image-preview-heading {
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
  .image-preview img {
    display: block;
    max-width: min(96vw, 1600px);
    max-height: calc(94vh - 48px);
    margin: 0 auto;
    object-fit: contain;
  }
</style>
