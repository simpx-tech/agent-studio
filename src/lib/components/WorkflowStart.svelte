<script lang="ts">
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { nodeConfig, type WorkflowDefinition } from '$lib/workflow-model';
  import type { WorkflowPickers } from '$lib/workflow-view';
  let {
    definition,
    pickers,
    start,
    close,
  }: {
    definition: WorkflowDefinition;
    pickers: WorkflowPickers;
    start: (inputs: Record<string, string>, driver: string) => Promise<void>;
    close: () => void;
  } = $props();
  const inputs = $derived(
    nodeConfig(definition.graph.nodes.find((n) => n.type === 'start') ?? { type: 'start' }, 'start')
      .inputs,
  );
  let values = $state<Record<string, string>>({});
  let driver = $state('');
  let busy = $state(false);
  let error = $state('');
  $effect(() => {
    if (!driver) driver = pickers.defaultDriver;
  });
  async function submit() {
    busy = true;
    error = '';
    try {
      const filled: Record<string, string> = {};
      for (const input of inputs) filled[input.name] = values[input.name] ?? input.default;
      await start(filled, driver);
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
    <div class="field">
      <span>Runs on</span>
      <ChoicePicker
        field
        label="Runs on"
        options={pickers.drivers}
        value={driver}
        onchange={(value) => (driver = value)}
      />
    </div>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || !driver}
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
