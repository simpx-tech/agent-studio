<script lang="ts">
  // Applying a picked run's changes to the comparison's folder, or removing its worktrees, on the
  // computer that made them (docs/COMPARISONS.md).
  import { onMount } from 'svelte';
  import { comparisonChanges, removeComparisonWorktrees } from '$lib/transport';
  import ConnectionDialog from './ConnectionDialog.svelte';
  let {
    kind,
    comparisonId,
    run,
    folder,
    runs,
    close,
    prepare,
    done,
  }: {
    kind: 'apply' | 'remove';
    comparisonId: string;
    /** The picked run's worktree, which Apply takes its changes from. */
    run: number;
    folder: string;
    runs: number;
    close: () => void;
    /** Lets go of what keeps the worktrees busy, such as the runs' parked CLIs. */
    prepare: () => Promise<void>;
    done: () => void;
  } = $props();
  let files = $state<{ path: string; status: string }[]>([]);
  // Apply first reads what the run changed.
  let checking = $state(true);
  let busy = $state(false);
  let error = $state('');
  onMount(() => {
    if (kind !== 'apply') {
      checking = false;
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const changes = await comparisonChanges(comparisonId, run, false);
        if (!disposed) files = changes;
      } catch (e) {
        if (!disposed) error = String(e).replace(/^Error: /, '');
      } finally {
        if (!disposed) checking = false;
      }
    })();
    return () => {
      disposed = true;
    };
  });
  async function confirm() {
    if (busy || checking || (kind === 'apply' && !files.length)) return;
    busy = true;
    error = '';
    try {
      if (kind === 'apply') await comparisonChanges(comparisonId, run, true);
      else {
        await prepare();
        await removeComparisonWorktrees(comparisonId);
      }
      done();
      close();
    } catch (e) {
      error = String(e).replace(/^Error: /, '');
    } finally {
      busy = false;
    }
  }
</script>

<ConnectionDialog title={kind === 'apply' ? 'Apply to folder' : 'Remove worktrees'} {busy} {close}>
  <form
    aria-busy={busy || checking}
    onsubmit={(event) => {
      event.preventDefault();
      void confirm();
    }}
  >
    {#if kind === 'apply'}
      <p>The picked run's changes go into {folder} as uncommitted changes.</p>
      {#if checking}<p role="status">Checking the run's worktree…</p>
      {:else if !files.length && !error}<p role="status">This run changed no files.</p>{/if}
      {#if files.length}<ul class="compare-files" aria-label="Files to change">
          {#each files as file (file.path)}<li>
              <span class="file-status" data-status={file.status}>{file.status}</span>{file.path}
            </li>{/each}
        </ul>{/if}
    {:else}
      <p>
        The worktrees of {runs} runs and their branches are removed, with every change in them.
      </p>
    {/if}
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="dialog-actions">
      <button type="button" class="secondary" disabled={busy} onclick={close}>Cancel</button><button
        type="submit"
        class={kind === 'apply' ? 'primary' : 'danger'}
        disabled={busy || checking || (kind === 'apply' && !files.length)}
        >{kind === 'apply' ? (busy ? 'Applying…' : 'Apply') : busy ? 'Removing…' : 'Remove'}</button
      >
    </div>
  </form>
</ConnectionDialog>

<style>
  .compare-files {
    display: grid;
    gap: 2px;
    max-height: 240px;
    overflow: auto;
    margin: 0;
    padding: 8px 12px;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .compare-files li {
    display: flex;
    gap: 10px;
    overflow-wrap: anywhere;
  }
  .file-status {
    flex: 0 0 64px;
    color: var(--text-muted);
  }
  .file-status[data-status='added'] {
    color: var(--diff-add-text);
  }
  .file-status[data-status='deleted'] {
    color: var(--diff-remove-text);
  }
</style>
