<script lang="ts">
  import { onMount } from 'svelte';
  import { X, Play } from '@lucide/svelte';
  let {
    canRun,
    close,
    run,
  }: { canRun: boolean; close: () => void; run: (input: string) => Promise<void> } = $props();
  let input = $state('');
  let dialog: HTMLDialogElement;
  onMount(() => {
    const focused = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => focused?.isConnected && focused.focus();
  });
</script>

<dialog
  bind:this={dialog}
  class="native-workflow-launcher"
  aria-labelledby="workflow-title"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <header>
    <h2 id="workflow-title">Claude workflows</h2>
    <button class="icon-button" aria-label="Close workflows" onclick={close}><X size={20} /></button
    >
  </header>
  <p>
    Claude Code runs the workflow with its native orchestration engine on the selected computer.
  </p>
  <label
    >Task or saved command<textarea
      aria-label="Workflow request"
      rows="5"
      maxlength="16000"
      bind:value={input}
      placeholder="Describe the work, or enter /saved-workflow followed by its input"
    ></textarea></label
  >
  <p class="hint">
    Saved workflows come from Claude’s project, personal profile, or plugins. To keep a new
    workflow, include “save it for reuse” and the name and location you want in your request.
  </p>
  <p class="hint">
    Phases and agents appear in the progress panel. Stop response stops the owned run. Claude’s
    terminal /workflows menu and pause/resume controls are not available here.
  </p>
  {#if !canRun}<p class="hint">
      Select a ready Claude connection and wait for the current reply to finish.
    </p>{/if}
  <footer>
    <button
      class="primary"
      disabled={!canRun || !input.trim()}
      onclick={() =>
        void run(`Use Claude Code’s native Workflow tool for this request.\n\n${input.trim()}`)}
      ><Play size={14} />Run native workflow</button
    >
  </footer>
</dialog>

<style>
  dialog {
    width: min(580px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--panel);
    color: var(--text);
    padding: 24px;
  }
  dialog::backdrop {
    background: #0008;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    font-size: 18px;
    margin: 0;
  }
  p {
    font-size: 13px;
    line-height: 1.6;
  }
  label {
    display: grid;
    gap: 8px;
    font-size: 12px;
  }
  textarea {
    resize: vertical;
    min-height: 100px;
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px;
    font: inherit;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 20px;
  }
</style>
