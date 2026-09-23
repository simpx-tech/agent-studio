<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { ChatLocation, ChatSettings } from '$lib/domain';
  import { contextKey, contextStatuses, type ContextEntry } from '$lib/context';
  import { manageMcp, openLink } from '$lib/transport';
  import { mcpActionSchema, type McpAction, type McpResult } from '$lib/mcp';
  import ChoicePicker from './ChoicePicker.svelte';

  let {
    settings,
    conversationId,
    location,
    entries,
    search,
    running = false,
    changed,
  }: {
    settings: ChatSettings;
    conversationId?: string;
    location?: ChatLocation;
    entries: ContextEntry[];
    search: string;
    running?: boolean;
    changed: () => void;
  } = $props();
  let busy = $state(false);
  let result = $state<McpResult>();
  let error = $state('');
  let adding = $state(false);
  let name = $state('');
  let type = $state('http');
  let endpoint = $state('');
  let argumentsText = $state('');
  let sessionJson = $state('{}');
  let callback = $state('');
  let logout = $state('');
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelPending: (() => void) | undefined;
  const key = $derived(contextKey({ ...settings, conversationId }, location));
  const pending = $derived(result?.status === 'pending');
  const disabled = $derived(busy || pending || running || !settings.connectionId);
  const rows = $derived(
    [
      ...entries,
      ...(result?.servers ?? [])
        .filter((s) => !entries.some((e) => e.name === s.name))
        .map((s): ContextEntry => ({
          name: s.name,
          path: '',
          kind: 'mcps',
          scope: 'Live session',
          status: s.status as ContextEntry['status'],
          detail: 'Reported by the selected CLI process.',
        })),
    ].filter((e) =>
      `${e.name} ${e.scope} ${e.status}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );
  const stateLabel = (entry: ContextEntry) => {
    const status = result?.servers.find((s) => s.name === entry.name)?.status ?? entry.status;
    return contextStatuses[status as ContextEntry['status']] ?? 'Unknown';
  };
  function reset() {
    generation++;
    clearTimeout(timer);
    cancelPending?.();
    cancelPending = undefined;
    result = undefined;
    error = '';
    callback = '';
    busy = false;
  }
  $effect(() => {
    key;
    untrack(() => {
      reset();
      adding = false;
      name = '';
      endpoint = '';
      argumentsText = '';
      sessionJson = '{}';
      logout = '';
    });
  });
  onDestroy(reset);
  async function act(action: McpAction) {
    const selected = { provider: settings.provider, connectionId: settings.connectionId };
    const selectedConversation = conversationId;
    const folder = location ? { ...location } : undefined;
    const current = generation;
    clearTimeout(timer);
    busy = true;
    error = '';
    const call = (next: McpAction) => manageMcp(selected, selectedConversation, folder, next);
    try {
      const next = await call(mcpActionSchema.parse(action));
      if (current !== generation) {
        if (next.status === 'pending' && next.operationId)
          void call({ kind: 'cancel', operationId: next.operationId }).catch(() => {});
        return;
      }
      result = next;
      callback = '';
      if (next.status === 'pending' && next.operationId) {
        const operationId = next.operationId;
        cancelPending = () => {
          void call({ kind: 'cancel', operationId }).catch(() => {});
        };
        timer = setTimeout(() => {
          void act({ kind: 'poll', operationId });
        }, 2000);
      } else {
        cancelPending = undefined;
        if (next.status === 'complete') {
          adding = false;
          logout = '';
          changed();
        }
      }
    } catch (reason) {
      if (current === generation) {
        error = String(reason).slice(0, 500);
        if (action.kind === 'poll') {
          cancelPending?.();
          cancelPending = undefined;
          result = undefined;
        } else if (result?.status === 'pending' && result.operationId) {
          const operationId = result.operationId;
          timer = setTimeout(() => {
            void act({ kind: 'poll', operationId });
          }, 3000);
        }
      }
    } finally {
      if (current === generation) busy = false;
    }
  }
  function add() {
    try {
      const server =
        type === 'stdio'
          ? { type, command: endpoint, args: JSON.parse(argumentsText || '[]') }
          : { type, url: endpoint };
      void act(mcpActionSchema.parse({ kind: 'add', name, server }));
    } catch {
      error =
        'Enter a server name and valid endpoint, or a command with arguments as a JSON array.';
    }
  }
  function setServers() {
    try {
      void act(mcpActionSchema.parse({ kind: 'setServers', servers: JSON.parse(sessionJson) }));
    } catch {
      error =
        'Enter up to 20 named HTTP, SSE, or stdio server definitions. The agent_studio name is reserved.';
    }
  }
</script>

<section class="mcp-management" aria-label="MCP management">
  {#if settings.provider === 'gemini'}
    <p>MCP management is unavailable for this agent.</p>
  {:else}
    <p>
      Manage servers for the selected account and folder. The CLI stores sign-in credentials on the
      selected computer.
    </p>
    {#if running}<p role="status">
        Wait for this reply to finish before changing MCP servers.
      </p>{/if}
    <div class="actions">
      <button class="secondary" {disabled} onclick={() => (adding = !adding)}>Add server</button>
      <button class="secondary" {disabled} onclick={() => act({ kind: 'status' })}
        >Refresh server status</button
      >
      {#if settings.provider === 'codex'}<button
          class="secondary"
          {disabled}
          onclick={() => act({ kind: 'reload' })}>Reload configuration</button
        >{/if}
    </div>
    {#if adding}
      <form
        class="editor"
        onsubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <strong>Add to this CLI profile</strong>
        <p>
          Saved for future chats. Only add servers you trust; stdio commands run on the selected
          computer.
        </p>
        <label>Server name<input bind:value={name} maxlength="200" required /></label>
        <ChoicePicker
          field
          label="Server transport"
          value={type}
          options={[
            { id: 'http', name: 'HTTP' },
            ...(settings.provider === 'claude' ? [{ id: 'sse', name: 'SSE' }] : []),
            { id: 'stdio', name: 'Local command (stdio)' },
          ]}
          onchange={(value) => (type = value)}
        />
        <label
          >{type === 'stdio' ? 'Command' : 'Server URL'}<input
            bind:value={endpoint}
            maxlength="4096"
            required
            placeholder={type === 'stdio' ? 'npx' : 'https://example.com/mcp'}
          /></label
        >
        {#if type === 'stdio'}<label
            >Arguments (JSON array)<textarea
              bind:value={argumentsText}
              placeholder={'["-y", "my-mcp-server"]'}
              maxlength="32000"></textarea></label
          >{/if}
        <div class="actions">
          <button class="primary" {disabled}>Save server</button><button
            type="button"
            class="secondary"
            onclick={() => (adding = false)}>Cancel</button
          >
        </div>
      </form>
    {/if}
    {#if error}<p class="error-banner" role="alert">{error}</p>{/if}
    {#if result}
      <div class="operation" role="status">
        <p>{result.message}</p>
        {#if pending}
          {#if settings.provider === 'codex'}<p>
              For a remote computer, open the sign-in link in a browser on that computer so the
              callback can reach the CLI.
            </p>{/if}
          <div class="actions">
            {#if result.authorizationUrl}<button
                class="primary"
                onclick={() =>
                  openLink(result!.authorizationUrl!).catch(() => {
                    error = 'Could not open sign-in. Try again.';
                  })}>Open sign-in</button
              ><button
                class="secondary"
                onclick={() =>
                  navigator.clipboard.writeText(result!.authorizationUrl!).catch(() => {
                    error = 'Could not copy the sign-in link.';
                  })}>Copy sign-in link</button
              >{/if}
            <button
              class="secondary"
              disabled={busy}
              onclick={() => act({ kind: 'cancel', operationId: result!.operationId! })}
              >Cancel sign-in</button
            >
          </div>
          {#if result.callbackAllowed}
            <details>
              <summary>Browser callback could not reach this computer?</summary>
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  void act({
                    kind: 'callback',
                    operationId: result!.operationId!,
                    callbackUrl: callback,
                  });
                }}
              >
                <label
                  >Paste the full redirect URL<input
                    type="password"
                    autocomplete="off"
                    bind:value={callback}
                    maxlength="8192"
                    required
                  /></label
                >
                <button class="secondary" disabled={busy || !callback}>Complete sign-in</button>
              </form>
            </details>
          {/if}
        {/if}
      </div>
    {/if}
    {#each rows as entry (entry.name)}
      <article>
        <div class="heading">
          <strong>{entry.name}</strong><span>{entry.scope}</span><span>{stateLabel(entry)}</span>
        </div>
        <p>{entry.detail}</p>
        {#if entry.name !== 'agent_studio'}
          <div class="actions">
            <button
              class="text-button"
              disabled={disabled || stateLabel(entry) === 'Disabled'}
              onclick={() => act({ kind: 'authenticate', name: entry.name })}>Sign in</button
            >
            {#if settings.provider === 'claude'}
              <button
                class="text-button"
                disabled={disabled || !conversationId}
                onclick={() => act({ kind: 'reconnect', name: entry.name })}>Reconnect</button
              >
              <button
                class="text-button"
                disabled={disabled || !conversationId}
                onclick={() =>
                  act({
                    kind: 'toggle',
                    name: entry.name,
                    enabled: stateLabel(entry) === 'Disabled',
                  })}>{stateLabel(entry) === 'Disabled' ? 'Enable' : 'Disable'}</button
              >
              <button
                class="text-button"
                {disabled}
                title="Open Claude's own sign-in browser on the selected Windows computer"
                onclick={() => act({ kind: 'login', name: entry.name })}>Sign in on computer</button
              >
            {/if}
            <button class="text-button" {disabled} onclick={() => (logout = entry.name)}
              >Sign out</button
            >
          </div>
          {#if logout === entry.name}<div class="editor">
              <p>
                Clear this server’s saved sign-in for this CLI profile? Other chats using the same
                profile may need to sign in again.
              </p>
              <div class="actions">
                <button
                  class="secondary"
                  {disabled}
                  onclick={() => act({ kind: 'logout', name: entry.name })}>Confirm sign out</button
                ><button class="secondary" onclick={() => (logout = '')}>Keep signed in</button>
              </div>
            </div>{/if}
        {/if}
      </article>
    {/each}
    {#if !rows.length}<p>
        {search
          ? 'No sources match this filter.'
          : 'No MCP servers were reported. Check the inspection notes for availability.'}
      </p>{/if}
    {#if settings.provider === 'claude'}
      <details class="editor">
        <summary>Live session servers</summary>
        <p>
          Replace the additional servers supplied to this idle chat session. Saved profile and
          project servers remain managed by Claude. These additions last until its process restarts.
          Agent Studio’s tools are retained.
        </p>
        <label
          >Server definitions (JSON)<textarea
            bind:value={sessionJson}
            maxlength="64000"
            rows="5"
            spellcheck="false"></textarea></label
        >
        <button class="secondary" disabled={disabled || !conversationId} onclick={setServers}
          >Apply session servers</button
        >
      </details>
      <p class="hint">
        Reconnect, enable/disable, and session servers require an idle live chat process.
      </p>
    {/if}
  {/if}
</section>

<style>
  .mcp-management {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 12px;
    font-size: var(--text-sm);
  }
  p {
    margin: 0;
    color: var(--text-muted);
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
  }
  .actions,
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .heading strong {
    color: var(--text);
    font-weight: 600;
  }
  .heading span,
  .hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  article,
  .editor,
  .operation {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--hover);
  }
  article,
  form.editor,
  .operation {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
    color: var(--text-secondary);
    font-weight: 500;
  }
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-weight: 500;
    margin-bottom: 8px;
  }
</style>
