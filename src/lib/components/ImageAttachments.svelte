<script lang="ts">
  import { X } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { imageUrl, type ChatImage } from '$lib/images';
  let { images, remove }: { images: ChatImage[]; remove?: (id: string) => void } = $props();
  let preview = $state<ChatImage>();
  let dialog = $state<HTMLDialogElement>();
  function close() {
    dialog?.close();
    preview = undefined;
  }
</script>

<div class="image-attachments" aria-label={remove ? 'Attached images' : 'Message images'}>
  {#each images as image (image.id)}
    <div class="image-attachment">
      <button
        type="button"
        class="image-thumbnail"
        title={image.name}
        aria-label={`Preview ${image.name}`}
        onclick={async () => {
          preview = image;
          await tick();
          dialog?.showModal();
        }}
      >
        <img src={imageUrl(image)} alt={image.name} />
      </button>
      {#if remove}<button
          type="button"
          class="image-remove"
          aria-label={`Remove ${image.name}`}
          onclick={() => remove?.(image.id)}><X size={12} /></button
        >{/if}
    </div>
  {/each}
</div>
<dialog
  bind:this={dialog}
  class="image-preview"
  aria-label="Image preview"
  onclose={() => (preview = undefined)}
>
  {#if preview}
    <div class="image-preview-heading">
      <span>{preview.name}</span><button
        type="button"
        class="icon-button"
        aria-label="Close image preview"
        onclick={close}><X size={18} /></button
      >
    </div>
    <img src={imageUrl(preview)} alt={preview.name} />
  {/if}
</dialog>
