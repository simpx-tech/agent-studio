<script lang="ts">
  import { onMount } from 'svelte';
  import { AppWindow } from '@lucide/svelte';
  import { setCloseToTray, windowBehavior, type WindowBehavior } from '$lib/transport';
  import { closeSummary, keepsRunning, trayPlace } from '$lib/window-behavior';
  let behavior = $state<WindowBehavior>();
  let busy = $state(false);
  let error = $state('');
  onMount(() => {
    let disposed = false;
    windowBehavior().then(
      (value) => {
        if (!disposed) behavior = value;
      },
      (e) => {
        if (!disposed) error = String(e);
      },
    );
    return () => {
      disposed = true;
    };
  });
  async function change(input: HTMLInputElement) {
    const enabled = input.checked;
    busy = true;
    error = '';
    try {
      behavior = await setCloseToTray(enabled);
    } catch (e) {
      // The switch shows the saved choice, not the one that could not be saved.
      input.checked = !enabled;
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="background-heading">
  <h2 id="background-heading"><AppWindow size={18} />Background</h2>
  <p>
    Agent Studio can keep running after you close its window: replies keep going, notifications
    still arrive, and your other devices can still run chats on this computer.
  </p>
  {#if behavior}
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={keepsRunning(behavior)}
        disabled={busy || !!behavior.unavailable}
        onchange={(event) => change(event.currentTarget)}
      /><span>Keep running in the {trayPlace(behavior)} when the window closes</span></label
    >
    <p role="status">{closeSummary(behavior)}</p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox {
    margin: 14px 0 2px;
  }
</style>
