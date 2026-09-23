<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { X } from '@lucide/svelte';

  let {
    title,
    busy = false,
    wide = false,
    close,
    children,
  }: {
    title: string;
    busy?: boolean;
    // Wide dialogs keep a fixed height and let their content scroll internally.
    wide?: boolean;
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
  class:wide
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
    padding: 22px 24px 22px;
    color: var(--text);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-xl);
  }
  dialog[open] {
    animation: dialog-in var(--duration) ease;
  }
  dialog.wide[open] {
    display: flex;
    flex-direction: column;
    width: min(940px, calc(100vw - 32px));
    height: min(720px, calc(100dvh - 48px));
    overflow: hidden;
  }
  dialog.wide header {
    flex-shrink: 0;
  }
  dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 18px;
  }
  header .icon-button {
    margin-right: -6px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-xl);
    letter-spacing: var(--tracking-tighter);
  }
  dialog :global(form) {
    display: grid;
    gap: 18px;
  }
  dialog :global(label),
  dialog :global(.fleet-field) {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    min-width: 0;
  }
  dialog :global(label.checkbox) {
    flex-direction: row;
    font-weight: 400;
    color: var(--text);
  }
  dialog :global(input) {
    width: 100%;
  }
  dialog :global(.fleet-fields) {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  dialog :global(.dialog-actions) {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  dialog :global(p) {
    color: var(--text-muted);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    margin: 0;
  }
  dialog :global(p strong) {
    color: var(--text);
    font-weight: 600;
  }
  dialog :global(.error-banner) {
    margin: 0 0 16px;
    padding: 9px 12px;
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-md);
  }
  dialog :global(details) {
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  dialog :global(summary) {
    width: fit-content;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    margin-bottom: 12px;
  }
  dialog :global(summary:hover) {
    color: var(--text);
  }
  @keyframes dialog-in {
    from {
      opacity: 0;
    }
  }
  @media (max-width: 600px) {
    dialog {
      padding: 18px;
    }
    dialog :global(.fleet-fields) {
      grid-template-columns: 1fr;
    }
  }
</style>
