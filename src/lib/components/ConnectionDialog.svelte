<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { X } from '@lucide/svelte';

  let {
    title,
    busy = false,
    close,
    children,
  }: {
    title: string;
    busy?: boolean;
    close: () => void;
    children: Snippet;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement;

  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  });
</script>

<dialog
  class="connection-dialog"
  bind:this={dialog}
  aria-labelledby={id}
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}
>
  <header>
    <h2 {id}>{title}</h2>
    <button
      class="icon-button"
      type="button"
      aria-label={`Close ${title.toLowerCase()}`}
      disabled={busy}
      onclick={close}><X size={20} /></button
    >
  </header>
  {@render children()}
</dialog>

<style>
  dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - 48px);
    padding: 26px;
    color: var(--text);
    background: var(--panel);
    border: 1px solid #46523c;
    border-radius: 16px;
    box-shadow: 0 24px 100px #0008;
  }
  dialog::backdrop {
    background: #080d0bc9;
    backdrop-filter: blur(4px);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
  }
  h2 {
    margin: 0;
    font-size: 23px;
    letter-spacing: -0.6px;
  }
  dialog :global(form) {
    display: grid;
    gap: 20px;
  }
  dialog :global(label),
  dialog :global(.fleet-field) {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
    min-width: 0;
  }
  dialog :global(input) {
    width: 100%;
  }
  dialog :global(.fleet-fields) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
  dialog :global(.dialog-actions) {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
    border-top: 1px solid var(--line);
    padding-top: 20px;
  }
  dialog :global(p) {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
    margin: 0;
  }
  dialog :global(.error-banner) {
    margin: 0 0 18px;
  }
  dialog :global(details) {
    border-top: 1px solid var(--line);
    padding-top: 16px;
  }
  dialog :global(summary) {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 14px;
  }
  @media (max-width: 600px) {
    dialog {
      padding: 20px;
    }
    dialog :global(.fleet-fields) {
      grid-template-columns: 1fr;
    }
  }
</style>
