<script lang="ts">
  import { untrack } from 'svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import DriverPicker from './DriverPicker.svelte';
  import {
    nodeConfig,
    triggerLabels,
    triggerOf,
    type RunDriverChoice,
    type WorkflowDefinition,
  } from '$lib/workflow-model';
  import type { WorkflowPickers } from '$lib/workflow-view';
  // Run starts a workflow by hand at one of its triggers, its first manual one unless chosen,
  // with that trigger's inputs, on the computer chosen.
  let {
    definition,
    pickers,
    start,
    close,
  }: {
    definition: WorkflowDefinition;
    pickers: WorkflowPickers;
    start: (
      inputs: Record<string, string>,
      driver: RunDriverChoice,
      trigger: string,
    ) => Promise<void>;
    close: () => void;
  } = $props();
  const triggers = $derived(definition.graph.nodes.filter((n) => n.type === 'start'));
  let trigger = $state(
    untrack(
      () =>
        (
          definition.graph.nodes.find((n) => n.type === 'start' && triggerOf(n) === 'manual') ??
          definition.graph.nodes.find((n) => n.type === 'start')
        )?.id ?? '',
    ),
  );
  const chosen = $derived(triggers.find((n) => n.id === trigger));
  const inputs = $derived(chosen ? nodeConfig(chosen, 'start').inputs : []);
  let values = $state<Record<string, string>>({});
  let driver = $state<RunDriverChoice>(
    untrack(() => ({
      preferred: pickers.defaultDriver,
      elsewhere: definition.elsewhere,
      ...(definition.continueOn ? { continueOn: definition.continueOn } : {}),
    })),
  );
  let busy = $state(false);
  let error = $state('');
  async function submit() {
    busy = true;
    error = '';
    try {
      const filled: Record<string, string> = {};
      for (const input of inputs) filled[input.name] = values[input.name] ?? input.default;
      await start(filled, $state.snapshot(driver), trigger);
    } catch (e) {
      error = String(e).replace(/^Error: /, '');
      busy = false;
    }
  }
</script>

<ConnectionDialog title={`Run ${definition.name}`} {busy} {close}>
  <form
    class="start-form"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    {#if triggers.length > 1}<div class="field">
        <span>Start at</span>
        <ChoicePicker
          field
          label="Start at"
          options={triggers.map((n) => ({
            id: n.id,
            name: n.title || n.key,
            detail: triggerLabels[triggerOf(n)],
          }))}
          value={trigger}
          onchange={(value) => (trigger = value)}
        />
      </div>{/if}
    {#each inputs as input (input.name)}
      <label class="field"
        ><span>{input.label || input.name}</span>{#if input.multiline}<textarea
            rows="4"
            value={values[input.name] ?? input.default}
            oninput={(event) => (values = { ...values, [input.name]: event.currentTarget.value })}
          ></textarea>{:else}<input
            value={values[input.name] ?? input.default}
            oninput={(event) => (values = { ...values, [input.name]: event.currentTarget.value })}
          />{/if}</label
      >
    {/each}
    <DriverPicker drivers={pickers.drivers} value={driver} onchange={(next) => (driver = next)} />
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || !driver.preferred || !trigger}
        >{busy ? 'Starting…' : 'Run'}</button
      >
    </div>
  </form>
</ConnectionDialog>

<style>
  .start-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .field > span {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
