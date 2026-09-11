<script lang="ts">
  import { onMount } from 'svelte';
  import { X, Plus, Trash2, ArrowUp, ArrowDown, Play, GitBranch } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { workflowSchema, type Workflow } from '$lib/workflows';
  let {
    workflows,
    canRun,
    close,
    save,
    run,
  }: {
    workflows: Workflow[];
    canRun: boolean;
    close: () => void;
    save: (values: Workflow[]) => Promise<void>;
    run: (workflow: Workflow, input: string) => Promise<void>;
  } = $props();
  let draft = $state<Workflow>({
    id: crypto.randomUUID(),
    name: '',
    steps: [{ title: '', prompt: '' }],
  });
  let input = $state('');
  let error = $state('');
  let busy = $state(false);
  let dialog: HTMLDialogElement;
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => focused?.isConnected && focused.focus();
  });
  function select(id: string) {
    const value = workflows.find((w) => w.id === id);
    draft = value
      ? JSON.parse(JSON.stringify(value))
      : { id: crypto.randomUUID(), name: '', steps: [{ title: '', prompt: '' }] };
    error = '';
  }
  function move(index: number, offset: number) {
    const steps = [...draft.steps];
    [steps[index], steps[index + offset]] = [steps[index + offset], steps[index]];
    draft.steps = steps;
  }
  async function commit(start = false) {
    const parsed = workflowSchema.safeParse(draft);
    if (!parsed.success) {
      error = 'Give the workflow a name and fill in a title and prompt for every step.';
      return;
    }
    if (start && !canRun) return;
    busy = true;
    error = '';
    try {
      const exists = workflows.some((w) => w.id === draft.id);
      if (!exists && workflows.length >= 100)
        throw new Error('You can save up to 100 workflows. Remove one before adding another.');
      await save(
        exists
          ? workflows.map((w) => (w.id === draft.id ? parsed.data : w))
          : [...workflows, parsed.data],
      );
      if (start) await run(parsed.data, input);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function remove() {
    busy = true;
    error = '';
    try {
      await save(workflows.filter((w) => w.id !== draft.id));
      select('');
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="workflow-manager"
  aria-labelledby="workflow-title"
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}
>
  <header>
    <div>
      <span class="eyebrow">REUSABLE STEPS</span>
      <h2 id="workflow-title">Claude workflows</h2>
    </div>
    <button class="icon-button" aria-label="Close workflows" disabled={busy} onclick={close}
      ><X size={20} /></button
    >
  </header>
  <div class="workflow-body">
    <div class="workflow-select">
      <ChoicePicker
        label="Saved workflow"
        field
        value={workflows.some((w) => w.id === draft.id) ? draft.id : ''}
        options={[
          { id: '', name: 'New workflow' },
          ...workflows.map((w) => ({ id: w.id, name: w.name })),
        ]}
        onchange={select}
        disabled={busy}
      /><button class="secondary" onclick={() => select('')} disabled={busy}
        ><Plus size={14} />New</button
      >
    </div>
    <label
      >Workflow name<input
        aria-label="Workflow name"
        maxlength="80"
        bind:value={draft.name}
        placeholder="Research, draft, review…"
        disabled={busy}
      /></label
    >
    <p class="field-hint">
      Steps run in order with the current Claude account, model, computer, and folder. Each step
      receives the conversation and earlier results. A failed or stopped step ends the run.
    </p>
    <div class="workflow-steps">
      {#each draft.steps as step, i}
        <section aria-label={`Workflow step ${i + 1}`}>
          <div class="step-heading">
            <strong>Step {i + 1}</strong><button
              class="icon-button"
              aria-label={`Move step ${i + 1} up`}
              disabled={busy || i === 0}
              onclick={() => move(i, -1)}><ArrowUp size={14} /></button
            ><button
              class="icon-button"
              aria-label={`Move step ${i + 1} down`}
              disabled={busy || i === draft.steps.length - 1}
              onclick={() => move(i, 1)}><ArrowDown size={14} /></button
            ><button
              class="icon-button"
              aria-label={`Remove step ${i + 1}`}
              disabled={busy || draft.steps.length === 1}
              onclick={() => (draft.steps = draft.steps.filter((_, index) => index !== i))}
              ><Trash2 size={14} /></button
            >
          </div>
          <label
            >Title<input
              aria-label={`Step ${i + 1} title`}
              maxlength="100"
              bind:value={step.title}
              disabled={busy}
              placeholder="Review the draft"
            /></label
          >
          <label
            >Prompt<textarea
              aria-label={`Step ${i + 1} prompt`}
              rows="3"
              maxlength="8000"
              bind:value={step.prompt}
              disabled={busy}
              placeholder="What should Claude do in this step?"></textarea></label
          >
        </section>
      {/each}
    </div>
    <button
      class="text-button"
      onclick={() => draft.steps.push({ title: '', prompt: '' })}
      disabled={busy || draft.steps.length >= 12}><Plus size={14} />Add step</button
    >
    <label class="workflow-input"
      >Input for this run<textarea
        aria-label="Workflow input"
        rows="2"
        maxlength="16000"
        bind:value={input}
        placeholder="Optional topic, requirements, or starting material"
        disabled={busy}></textarea></label
    >
    {#if !canRun}<p class="field-hint">
        To run, select a ready Claude conversation or choose Claude and a folder. Wait for any
        current reply to finish and remove draft image attachments.
      </p>{/if}
    {#if error}<p role="alert" class="workflow-error">{error}</p>{/if}
  </div>
  <footer>
    {#if workflows.some((w) => w.id === draft.id)}<button
        class="text-button delete-workflow"
        onclick={remove}
        disabled={busy}><Trash2 size={14} />Delete</button
      >{/if}<button class="secondary" disabled={busy} onclick={() => void commit()}
      ><GitBranch size={14} />Save workflow</button
    ><button class="primary" disabled={busy || !canRun} onclick={() => void commit(true)}
      ><Play size={14} />Run workflow</button
    >
  </footer>
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 0;
    width: min(700px, calc(100vw - 28px));
    max-height: calc(100dvh - 28px);
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
  }
  dialog::backdrop {
    background: #080b0dcc;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 22px;
  }
  header {
    justify-content: space-between;
  }
  h2 {
    margin: 4px 0 0;
    font-size: 20px;
  }
  .workflow-body {
    padding: 0 22px 16px;
    overflow: auto;
    min-height: 0;
  }
  .workflow-select {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
    align-items: center;
  }
  .workflow-select :global(.choice-picker) {
    flex: 1;
  }
  label {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 12px;
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .workflow-steps {
    display: grid;
    gap: 12px;
  }
  section {
    padding: 12px 14px 3px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: #ffffff02;
  }
  .step-heading {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  .step-heading strong {
    flex: 1;
  }
  .workflow-input {
    margin-top: 18px;
  }
  .workflow-error {
    color: #f1a69b;
    font-size: 12px;
  }
  footer {
    border-top: 1px solid var(--line);
    justify-content: flex-end;
  }
  .delete-workflow {
    margin-right: auto;
  }
  @media (max-width: 600px) {
    dialog {
      width: calc(100vw - 14px);
      max-height: calc(100dvh - 14px);
    }
    header,
    footer {
      padding: 12px;
    }
    .workflow-body {
      padding: 0 12px 12px;
    }
    footer {
      flex-wrap: wrap;
      gap: 8px;
    }
  }
</style>
