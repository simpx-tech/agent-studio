<script lang="ts">
  import { onMount } from 'svelte';
  import { Minus, Square, Copy, X } from '@lucide/svelte';
  import { desktop, controlWindow, watchWindowMaximized, type WindowAction } from '$lib/transport';

  let { title, onerror }: { title: string; onerror: (message: string) => void } = $props();
  let native = $state(false);
  let maximized = $state(false);

  async function act(action: WindowAction) {
    try {
      await controlWindow(action);
    } catch (error) {
      onerror(`Could not change the window: ${String(error)}`);
    }
  }

  onMount(() => {
    native = desktop();
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void watchWindowMaximized(
      (value) => {
        if (!disposed) maximized = value;
      },
      (error) => {
        if (!disposed) onerror(`Could not read the window state: ${String(error)}`);
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        if (!disposed) onerror(`Could not watch the window state: ${String(error)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

<header class="topbar" class:native-titlebar={native} data-tauri-drag-region={native || undefined}>
  <strong class="page-title" {title} data-tauri-drag-region={native || undefined}>{title}</strong>
  {#if native}
    <div class="window-controls" role="group" aria-label="Window controls">
      <button
        class="icon-button window-control"
        aria-label="Minimize window"
        title="Minimize"
        onclick={() => act('minimize')}><Minus size={16} aria-hidden="true" /></button
      >
      <button
        class="icon-button window-control"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        title={maximized ? 'Restore' : 'Maximize'}
        onclick={() => act('toggleMaximize')}
      >
        {#if maximized}<Copy size={14} aria-hidden="true" />{:else}<Square
            size={14}
            aria-hidden="true"
          />{/if}
      </button>
      <button
        class="icon-button window-control window-close"
        aria-label="Close window"
        title="Close"
        onclick={() => act('close')}><X size={17} aria-hidden="true" /></button
      >
    </div>
  {/if}
</header>
