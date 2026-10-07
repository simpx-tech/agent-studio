<script lang="ts">
  import { SquareTerminal } from '@lucide/svelte';
  import { cliName, cliUpdateSummary, updatedClis } from '$lib/cli-updates';
  import { checkCliUpdates, setCliAutoUpdate, type CliUpdates } from '$lib/transport';
  let {
    updates,
    apply,
    environmentName,
  }: {
    updates: CliUpdates | undefined;
    apply: (updates: CliUpdates) => void;
    environmentName: (environmentId: string) => string;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  const checking = $derived(!!updates?.statuses.some((status) => status.phase === 'checking'));
  async function act(action: () => Promise<CliUpdates>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      apply(await action());
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="cli-updates-heading">
  <h2 id="cli-updates-heading"><SquareTerminal size={18} />CLI updates</h2>
  {#if updates}
    <div class="switches">
      {#each updatedClis as cli (cli.provider)}
        <label class="checkbox"
          ><input
            type="checkbox"
            checked={updates.automatic[cli.provider]}
            disabled={busy}
            onchange={(event) =>
              act(() => setCliAutoUpdate(cli.provider, event.currentTarget.checked))}
          /><span>Update {cli.name} automatically</span></label
        >
      {/each}
    </div>
    {#if updates.notice}<p>{updates.notice}</p>{/if}
    {#if updates.statuses.length}
      <ul class="installations" aria-label="CLI installations">
        {#each updates.statuses as status (status.provider + ':' + status.environmentId)}
          <li>
            <strong>{cliName(status.provider)}</strong>
            <span class="where">{environmentName(status.environmentId)}</span>
            <span class="version">{status.version ?? 'Version unknown'}</span>
            <span class="summary" role="status">{cliUpdateSummary(status)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="summary">Not checked yet.</p>
    {/if}
    <div class="actions">
      <button class="secondary" disabled={busy || checking} onclick={() => act(checkCliUpdates)}
        >{busy || checking ? 'Checking…' : 'Check for updates'}</button
      >
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
  .switches {
    display: grid;
    justify-items: start;
    gap: 8px;
  }
  .installations {
    display: grid;
    gap: 8px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .installations li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .installations strong {
    color: var(--text);
    font-weight: 500;
  }
  .where {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .version {
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .summary {
    flex-basis: 100%;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 14px 0 0;
  }
</style>
