<script lang="ts">
  import { Server } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import type { RunDriverChoice } from '$lib/workflow-model';
  import type { DriverChoice } from '$lib/workflow-view';
  // Where a workflow or mission runs, and which computers may continue it while that one is
  // offline (docs/WORKFLOWS.md). `compact` shows a button that opens the same choices.
  let {
    drivers,
    value,
    onchange,
    compact = false,
    disabled = false,
  }: {
    drivers: DriverChoice[];
    value: RunDriverChoice;
    onchange: (value: RunDriverChoice) => void;
    compact?: boolean;
    disabled?: boolean;
  } = $props();
  const others = $derived(drivers.filter((d) => d.id !== value.preferred));
  /** The computers that may continue it: those it lists, or every other when it lists none. */
  const continuing = $derived(
    value.elsewhere === false
      ? []
      : (value.continueOn ?? others.map((d) => d.id)).filter((id) => id !== value.preferred),
  );
  const name = (id: string) => drivers.find((d) => d.id === id)?.name ?? 'Another computer';
  const summary = $derived(
    `${name(value.preferred)}${
      !others.length
        ? ''
        : !continuing.length
          ? ' only'
          : continuing.length === others.length
            ? ', then any'
            : `, then ${continuing.map(name).join(', ')}`
    }`,
  );
  function choose(preferred: string) {
    // The computer it runs on no longer continues it; the one it ran on may, as before.
    const list = continuing.filter((id) => id !== preferred);
    if (value.preferred && value.preferred !== preferred && continuing.length === others.length)
      list.push(value.preferred);
    onchange({ preferred, elsewhere: true, continueOn: list });
  }
  function toggle(id: string, on: boolean) {
    const list = on ? [...new Set([...continuing, id])] : continuing.filter((c) => c !== id);
    onchange({ preferred: value.preferred, elsewhere: true, continueOn: list });
  }
  let open = $state(false);
  let box = $state<HTMLDivElement>();
  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (box && !box.contains(event.target as Node)) open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        open = false;
        box?.querySelector<HTMLButtonElement>('.driver-trigger')?.focus();
      }
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  });
</script>

{#snippet choices()}
  <div class="field">
    <span>Runs on</span>
    <ChoicePicker
      field
      label="Runs on"
      {disabled}
      options={drivers.map((d) => ({
        id: d.id,
        name: d.name,
        ...(d.detail ? { detail: d.detail } : d.server ? { detail: 'Server' } : {}),
      }))}
      value={value.preferred}
      onchange={choose}
    />
  </div>
  {#if others.length}
    <fieldset class="continue-on" {disabled}>
      <legend>Continue on while it is offline</legend>
      {#each others as driver (driver.id)}
        <label class="checkbox"
          ><input
            type="checkbox"
            checked={continuing.includes(driver.id)}
            onchange={(event) => toggle(driver.id, event.currentTarget.checked)}
          />{#if driver.server}<Server size={13} aria-hidden="true" />{/if}<span>{driver.name}</span
          >{#if driver.detail}<small>{driver.detail}</small>{/if}</label
        >
      {/each}
    </fieldset>
  {/if}
{/snippet}

{#if compact}
  <div class="driver-picker" bind:this={box}>
    <button
      type="button"
      class="driver-trigger"
      aria-expanded={open}
      aria-label={`Runs on ${summary}`}
      title="Where it runs"
      {disabled}
      onclick={() => (open = !open)}
      ><Server size={15} aria-hidden="true" /><span>{summary}</span></button
    >
    {#if open}<div class="driver-popover" role="group" aria-label="Where it runs">
        {@render choices()}
      </div>{/if}
  </div>
{:else}
  <div class="driver-fields">{@render choices()}</div>
{/if}

<style>
  .driver-fields,
  .driver-popover {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  .field > span,
  legend {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .continue-on {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .checkbox span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .checkbox small {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .driver-picker {
    position: relative;
    min-width: 0;
  }
  .driver-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
    height: var(--control-sm);
    padding: 0 8px;
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .driver-trigger:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }
  .driver-trigger span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .driver-popover {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 30;
    width: min(320px, 80vw);
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-lg);
  }
</style>
