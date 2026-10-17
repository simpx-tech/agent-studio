<script lang="ts">
  import { untrack } from 'svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { reasoningName } from '$lib/models';
  import type { ChatLocation, ProviderId, Reasoning } from '$lib/domain';
  import type { AgentChoice } from '$lib/workflow-model';
  import type { WorkflowPickers } from '$lib/workflow-view';
  let {
    pickers,
    provider: initialProvider = 'claude',
    start,
    close,
  }: {
    pickers: WorkflowPickers;
    provider?: ProviderId;
    start: (spec: {
      title: string;
      text: string;
      location?: ChatLocation;
      orchestrator: AgentChoice;
      driver: string;
      elsewhere: boolean;
    }) => Promise<void>;
    close: () => void;
  } = $props();
  let text = $state('');
  let title = $state('');
  let computer = $state('');
  let path = $state('');
  let provider = $state<ProviderId>(untrack(() => initialProvider));
  let connectionId = $state('');
  let model = $state('');
  let reasoning = $state<Reasoning>('');
  let driver = $state('');
  let elsewhere = $state(true);
  let busy = $state(false);
  let error = $state('');
  $effect(() => {
    if (!driver) driver = pickers.defaultDriver;
  });
  const accounts = $derived(pickers.accounts(provider, driver));
  const models = $derived(pickers.models(provider, connectionId));
  const levels = $derived(models.find((m) => m.id === model)?.levels ?? ['low', 'medium', 'high']);
  async function submit() {
    if (!text.trim()) return;
    busy = true;
    error = '';
    try {
      const place = computer ? pickers.location(computer) : undefined;
      await start({
        title,
        text: text.trim(),
        ...(place && path.trim() ? { location: { ...place, path: path.trim() } } : {}),
        orchestrator: { provider, connectionId, model, reasoning },
        driver,
        elsewhere,
      });
    } catch (e) {
      error = String(e).replace(/^Error: /, '');
      busy = false;
    }
  }
</script>

<ConnectionDialog title="New mission" {busy} {close} wide>
  <form
    class="mission-form"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <div class="mission-body">
      <label class="field"
        ><span>Mission</span><textarea
          rows="7"
          required
          placeholder="What should be achieved, with everything the orchestrator should know"
          bind:value={text}></textarea></label
      >
      <label class="field"
        ><span>Title</span><input bind:value={title} placeholder="From the mission" /></label
      >
      <div class="field-row">
        <div class="field">
          <span>Project computer</span>
          <ChoicePicker
            field
            label="Project computer"
            options={[{ id: '', name: 'None' }, ...pickers.computers]}
            value={computer}
            onchange={(value) => (computer = value)}
          />
        </div>
        <label class="field"
          ><span>Project folder</span><input
            list="mission-folders"
            disabled={!computer}
            placeholder={computer ? 'Absolute path' : 'Standalone'}
            bind:value={path}
          /><datalist id="mission-folders"
            >{#each computer ? pickers.folders(computer) : [] as folder}<option value={folder}
              ></option>{/each}</datalist
          ></label
        >
      </div>
      <fieldset>
        <legend>Orchestrator</legend>
        <div class="field-row">
          <div class="field">
            <span>Agent</span>
            <ChoicePicker
              field
              label="Agent"
              options={[
                { id: 'claude', name: 'Claude' },
                { id: 'codex', name: 'Codex' },
              ]}
              value={provider}
              onchange={(value) => {
                provider = value as ProviderId;
                connectionId = '';
                model = '';
                reasoning = '';
              }}
            />
          </div>
          <div class="field">
            <span>Account</span>
            <ChoicePicker
              field
              label="Account"
              options={[{ id: '', name: 'Least used' }, ...accounts]}
              value={connectionId}
              onchange={(value) => (connectionId = value)}
            />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <span>Model</span>
            <ChoicePicker
              field
              label="Model"
              options={models.length ? models : [{ id: '', name: 'CLI default' }]}
              value={model}
              onchange={(value) => {
                model = value;
                reasoning = '';
              }}
            />
          </div>
          <div class="field">
            <span>Reasoning</span>
            <ChoicePicker
              field
              label="Reasoning"
              options={['', ...levels].map((level) => ({
                id: level,
                name: reasoningName(level as Reasoning) ?? level,
              }))}
              value={reasoning}
              onchange={(value) => (reasoning = value as Reasoning)}
            />
          </div>
        </div>
      </fieldset>
      <div class="field">
        <span>Runs on</span>
        <ChoicePicker
          field
          label="Runs on"
          options={pickers.drivers}
          value={driver}
          onchange={(value) => {
            driver = value;
            connectionId = '';
          }}
        />
      </div>
      <label class="checkbox"
        ><input type="checkbox" bind:checked={elsewhere} />Continue on another computer while it is
        offline</label
      >
      {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    </div>
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}>Cancel</button>
      <button type="submit" class="primary" disabled={busy || !text.trim() || !driver}
        >{busy ? 'Starting…' : 'Start mission'}</button
      >
    </div>
  </form>
</ConnectionDialog>

<style>
  .mission-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    flex: 1;
  }
  .mission-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    min-height: 0;
    padding: 4px;
    margin: -4px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 0;
  }
  .field > span {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .field-row {
    display: flex;
    gap: 10px;
    min-width: 0;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  legend {
    padding: 0 4px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  @media (max-width: 600px) {
    .field-row {
      flex-direction: column;
    }
  }
</style>
