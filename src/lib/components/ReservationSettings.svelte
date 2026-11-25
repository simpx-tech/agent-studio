<script lang="ts">
  import { onMount } from 'svelte';
  import { Gauge } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { readPcSettings, savePcSettings, type PcSettings } from '$lib/transport';

  // How long a measurement waits for a moment when no other chat runs heavy work before it
  // holds their new work (src-tauri/src/reservations.rs, `Settings`).
  const choices = [0, 1, 2, 3, 5, 10, 15, 30];
  const name = (minutes: number) =>
    minutes === 0 ? 'At once' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  let settings = $state<PcSettings>();
  let busy = $state(false);
  let error = $state('');
  // A value set some other way stays a choice.
  const options = $derived(
    [...new Set([...choices, ...(settings ? [settings.lullMinutes] : [])])]
      .sort((a, b) => a - b)
      .map((minutes) => ({ id: String(minutes), name: name(minutes) })),
  );
  onMount(() => {
    let disposed = false;
    readPcSettings().then(
      (value) => {
        if (!disposed) settings = value;
      },
      (e) => {
        if (!disposed) error = String(e);
      },
    );
    return () => {
      disposed = true;
    };
  });
  async function change(value: string) {
    busy = true;
    error = '';
    try {
      settings = await savePcSettings({ lullMinutes: Number(value) });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="reservations-heading">
  <h2 id="reservations-heading"><Gauge size={18} />Reservations</h2>
  {#if settings}
    <div class="field">
      <span>Hold other chats after</span>
      <ChoicePicker
        label="Hold other chats after"
        {options}
        value={String(settings.lullMinutes)}
        field
        disabled={busy}
        onchange={change}
      />
    </div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .field {
    display: grid;
    gap: 6px;
    max-width: 320px;
    margin-top: 14px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
</style>
