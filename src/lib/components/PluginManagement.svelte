<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { ChatSettings, ChatLocation } from '$lib/domain';
  import { managePlugins } from '$lib/transport';
  import type { PluginAction, PluginResult } from '$lib/plugins';
  let {
    settings,
    conversationId,
    location,
    running,
    search,
    changed,
  }: {
    settings: ChatSettings;
    conversationId?: string;
    location?: ChatLocation;
    running: boolean;
    search: string;
    changed: () => void;
  } = $props();
  let result = $state<PluginResult>();
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let installId = $state('');
  let confirming = $state('');
  let detailsId = $state('');
  let details = $state<string[]>([]);
  let dirs = $state('');
  let urls = $state('');
  let roots = $state('');
  let evalId = $state('');
  let trusted = $state(false);
  let budget = $state(1);
  let evaluation = $state('');
  let mounted = true;
  // The parent keys this component by selection; cleanup must retain its original owner.
  const selection = untrack(() => ({
    provider: settings.provider,
    connectionId: settings.connectionId,
  }));
  const conversation = untrack(() => conversationId);
  const folder = untrack(() => location);
  const supported = selection.provider === 'claude' || selection.provider === 'codex';
  const lines = (text: string) =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  async function cancel(silent = false) {
    try {
      if (evaluation)
        await managePlugins(selection, conversation, folder, {
          kind: 'cancel',
          operationId: evaluation,
        });
    } catch (e) {
      if (!silent && mounted) error = `Cancellation was not confirmed: ${String(e)}`;
    }
  }
  async function run(action: PluginAction) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      const value = await managePlugins(selection, conversation, folder, action);
      if (!mounted) return;
      if (action.kind === 'details') {
        detailsId = action.id;
        details = value.details;
      } else if (action.kind === 'list') {
        result = value;
        dirs = value.pluginDirs.join('\n');
        urls = value.pluginUrls.join('\n');
        roots = value.skillRoots.join('\n');
      } else {
        notice = value.message;
        confirming = '';
        installId = '';
        evalId = '';
        trusted = false;
        if (action.kind !== 'eval') changed();
        const refreshed = await managePlugins(selection, conversation, folder, { kind: 'list' });
        if (mounted) result = refreshed;
      }
    } catch (e) {
      if (mounted) error = String(e);
    } finally {
      if (mounted) {
        busy = false;
        evaluation = '';
      }
    }
  }
  onMount(() => {
    if (supported) void run({ kind: 'list' });
    return () => {
      mounted = false;
      void cancel(true);
    };
  });
</script>

{#if !supported}
  <p>Plugin management is unavailable for this agent.</p>
{:else}
  <div class="plugin-management">
    <p class="help">
      Manage plugins in this account’s CLI profile on the selected computer. Changes apply to the
      next reply.
    </p>
    <button class="text-button" disabled={busy} onclick={() => run({ kind: 'list' })}
      >Refresh plugins</button
    >
    {#if running}<p class="help">Wait for the reply to finish before changing plugins.</p>{/if}
    {#if error}<p role="alert" class="error-banner">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if busy}<p role="status">
        {evaluation ? 'Running plugin evaluation…' : 'Waiting for the selected CLI…'}
      </p>{/if}
    {#if evaluation}<button class="secondary" onclick={() => cancel()}>Cancel evaluation</button
      >{/if}
    {#if result && !result.plugins.length}<p>No installed plugins were reported.</p>{/if}
    {#each (result?.plugins ?? []).filter((p) => `${p.name} ${p.id} ${p.scope}`
        .toLowerCase()
        .includes(search.toLowerCase())) as plugin (plugin.id + plugin.scope)}
      <article>
        <div class="title">
          <strong>{plugin.name}</strong><span>{plugin.version}</span><span
            >{plugin.enabled === null
              ? 'State unknown'
              : plugin.enabled
                ? 'Enabled'
                : 'Disabled'}</span
          >
        </div>
        <p class="help">{plugin.scope} · {plugin.id}</p>
        <div class="actions">
          <button
            class="text-button"
            disabled={busy}
            onclick={() => run({ kind: 'details', id: plugin.id })}>Details</button
          >
          <button
            class="text-button"
            disabled={busy || running || plugin.enabled === null}
            onclick={() => run({ kind: 'toggle', id: plugin.id, enabled: !plugin.enabled })}
            >{plugin.enabled ? 'Disable' : 'Enable'}</button
          >
          <button
            class="text-button"
            disabled={busy || running}
            onclick={() => (confirming = plugin.id)}>Uninstall</button
          >
          {#if settings.provider === 'claude'}<button
              class="text-button"
              disabled={busy || running}
              onclick={() => {
                evalId = plugin.id;
                trusted = false;
              }}>Evaluate</button
            >{/if}
        </div>
        {#if detailsId === plugin.id}<ul>
            {#each details as line}<li>{line}</li>{/each}
          </ul>{/if}
        {#if confirming === plugin.id}<p>Uninstall {plugin.name} from this CLI profile?</p>
          <div class="actions">
            <button
              class="secondary"
              disabled={busy || running}
              onclick={() => run({ kind: 'uninstall', id: plugin.id })}>Confirm uninstall</button
            ><button class="text-button" onclick={() => (confirming = '')}>Cancel</button>
          </div>{/if}
        {#if evalId === plugin.id}
          <div class="form">
            <p>
              Evaluation runs this plugin’s test prompts using the selected account. It can consume
              paid usage and saves a local report on the selected computer. Reports are not
              published.
            </p>
            <label
              >Evaluation budget (USD)<input
                type="number"
                min="0.01"
                max="100"
                step="0.01"
                bind:value={budget}
                disabled={busy}
              /></label
            >
            <label class="trust"
              ><input type="checkbox" bind:checked={trusted} disabled={busy} />I trust this plugin
              and its evaluation suite.</label
            >
            <button
              class="secondary"
              disabled={busy ||
                running ||
                !trusted ||
                !Number.isFinite(budget) ||
                budget < 0.01 ||
                budget > 100}
              onclick={() => {
                evaluation = crypto.randomUUID();
                void run({
                  kind: 'eval',
                  id: plugin.id,
                  operationId: evaluation,
                  maxCostUsd: budget,
                  trusted: true,
                });
              }}>Run evaluation</button
            >
          </div>
        {/if}
      </article>
    {/each}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void run({ kind: 'install', id: installId.trim() });
      }}
    >
      <label
        >Plugin identifier<input
          bind:value={installId}
          placeholder="plugin@configured-source"
          disabled={busy || running}
          maxlength="200"
        /></label
      >
      <p class="help">
        Install a known plugin from a source already configured in this CLI. Claude installs into
        the selected user profile.
      </p>
      <button class="secondary" disabled={busy || running || !installId.trim()}
        >Install plugin</button
      >
    </form>
    <details class="form">
      <summary>Temporary sources for this conversation</summary>
      <p class="help">
        Use absolute paths on the selected computer, one per line. These sources apply to the next
        reply and last until the execution host restarts.
      </p>
      {#if !conversationId}<p>Send a message first to bind these sources to a conversation.</p>{/if}
      {#if settings.provider === 'claude'}
        <label
          >Plugin directories or zip files<textarea
            bind:value={dirs}
            disabled={busy || running || !conversationId}
            rows="3"></textarea></label
        >
        <label
          >Plugin zip URLs<textarea
            bind:value={urls}
            disabled={busy || running || !conversationId}
            rows="3"
            placeholder="https://example.com/plugin.zip"></textarea></label
        >
      {:else}
        <label
          >Additional skill directories<textarea
            bind:value={roots}
            disabled={busy || running || !conversationId}
            rows="3"></textarea></label
        >
      {/if}
      <button
        class="secondary"
        disabled={busy || running || !conversationId}
        onclick={() =>
          run({
            kind: 'runtime',
            pluginDirs: lines(dirs),
            pluginUrls: lines(urls),
            skillRoots: lines(roots),
          })}>Apply temporary sources</button
      >
    </details>
  </div>
{/if}

<style>
  .plugin-management {
    font-size: 12px;
    line-height: 1.6;
  }
  .help,
  .title span {
    color: var(--text-muted, #96ab86);
    font-size: 11px;
  }
  article {
    padding: 14px 0;
    border-bottom: 1px solid #35472b;
    overflow-wrap: anywhere;
  }
  .title,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .form {
    margin-top: 18px;
    display: grid;
    gap: 10px;
  }
  details.form {
    display: block;
  }
  summary {
    cursor: pointer;
  }
  label {
    display: grid;
    gap: 6px;
    margin: 10px 0;
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  .trust {
    display: flex;
    align-items: center;
  }
  .trust input {
    width: auto;
  }
  button {
    justify-self: start;
  }
</style>
