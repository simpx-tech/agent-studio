<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { restartBlocked, updateSummary } from '$lib/app-updates';
  import { checkForAppUpdate, type AppUpdateStatus } from '$lib/transport';
  let {
    status,
    restart,
  }: {
    status: AppUpdateStatus | undefined;
    restart: () => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  const blocked = $derived(restartBlocked(status));
  const working = $derived(
    status?.phase === 'checking' ||
      status?.phase === 'downloading' ||
      status?.phase === 'installing',
  );
  const checked = $derived(status?.checkedAt ? new Date(status.checkedAt) : undefined);
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="updates-heading">
  <h2 id="updates-heading"><RefreshCw size={18} />App updates</h2>
  <p>
    Agent Studio downloads signed updates from GitHub Releases in the background. Restarting
    installs them; it waits for replies running on this computer to finish.
  </p>
  {#if status}
    <p class="state">Current version {status.currentVersion}</p>
    <p role="status" title={checked?.toLocaleString()}>
      {updateSummary(status)}{#if status.phase === 'current' && checked}{' '}
        Checked {checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.{/if}
    </p>
    {#if status.notes && (status.phase === 'ready' || status.phase === 'downloading')}
      <details>
        <summary>What’s new in {status.version}</summary>
        <p class="notes">{status.notes}</p>
      </details>
    {/if}
    <div class="actions">
      {#if status.phase === 'ready' || status.phase === 'installing'}
        <button
          class="primary"
          disabled={busy || !!blocked}
          onclick={() => act(restart)}
          title={blocked}
          >{status.phase === 'installing' || busy ? 'Restarting…' : 'Restart to update'}</button
        >
        {#if status.phase === 'ready' && blocked}<span class="hint">{blocked}</span>{/if}
      {:else if status.phase !== 'unavailable'}
        <button class="secondary" disabled={busy || working} onclick={() => act(checkForAppUpdate)}
          >{status.phase === 'checking' ? 'Checking…' : 'Check for updates'}</button
        >
      {/if}
    </div>
  {/if}
  {#if error || (status?.message && status.phase !== 'unavailable')}
    <p role="alert">{error || status?.message}</p>
  {/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .state {
    color: var(--text);
    font-weight: 500;
  }
  details {
    margin: 12px 0;
    max-width: 640px;
  }
  summary {
    width: fit-content;
    cursor: pointer;
    color: var(--text);
    font-size: var(--text-base);
    font-weight: 500;
  }
  .notes {
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 14px 0 0;
  }
  .hint {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
