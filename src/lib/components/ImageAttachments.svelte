<script lang="ts">
  import { X } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { imageUrl, isInline, type ChatImage, type DraftImage } from '$lib/images';
  import { chatImageUrl, readChatImage } from '$lib/transport';
  type Shown = ChatImage | DraftImage;
  let { images, remove }: { images: Shown[]; remove?: (id: string) => void } = $props();
  let preview = $state<Shown>();
  let dialog = $state<HTMLDialogElement>();
  function close() {
    dialog?.close();
    preview = undefined;
  }
  /**
   * Shows an image wherever its bytes are: a draft's in this window's memory, a stored one
   * through the desktop's image protocol or the relay's image store, and one saved inline before
   * the image store in the message itself. An object URL this makes is released with the image.
   */
  function source(img: HTMLImageElement, image: Shown) {
    let current = image;
    let url: string | undefined;
    const release = () => {
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    };
    const unavailable = () => {
      img.removeAttribute('src');
      img.alt = `${current.name} is not available on this device`;
      img.title = img.alt;
    };
    async function show(image: Shown) {
      img.alt = image.name;
      img.removeAttribute('title');
      if ('blob' in image) {
        url = URL.createObjectURL(image.blob);
        img.src = url;
        return;
      }
      if (isInline(image)) {
        img.src = imageUrl(image);
        return;
      }
      const direct = chatImageUrl(image.hash);
      if (direct) {
        img.src = direct;
        return;
      }
      try {
        const blob = await readChatImage(image.hash);
        if (current !== image) return;
        url = URL.createObjectURL(blob);
        img.src = url;
      } catch {
        if (current === image) unavailable();
      }
    }
    img.addEventListener('error', unavailable);
    void show(image);
    return {
      update(next: Shown) {
        if (next === current) return;
        release();
        current = next;
        void show(next);
      },
      destroy() {
        img.removeEventListener('error', unavailable);
        release();
      },
    };
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
        <img use:source={image} alt={image.name} />
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
    <img use:source={preview} alt={preview.name} />
  {/if}
</dialog>
