<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { LoaderCircle, RefreshCw, Search, TriangleAlert } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import { providers, type Conversation } from '$lib/domain';
  import { accountName, type Fleet } from '$lib/fleet';
  import { dayLabel } from '$lib/app-sessions';
  import { folderName } from '$lib/locations';
  import { formatModelName } from '$lib/replies';
  import {
    byRecency,
    importedConversation,
    matchesSearch,
    originName,
    type ImportableChat,
    type ImportProvider,
    type ImportSource,
  } from '$lib/imports';
  import { importChat, listImportableChats, listImportSources } from '$lib/transport';

  // Chats the Claude Code and Codex CLIs saved on this computer, from every account's profile and
  // each environment's default CLI directory, imported into History one at a time.
  let {
    fleet,
    close,
    save,
    open,
  }: {
    fleet: Fleet;
    close: () => void;
    /** Keeps an imported conversation in the workspace; throws when it cannot. */
    save: (conversation: Conversation) => Promise<void>;
    /** Opens a conversation that already holds a listed chat. */
    open: (conversationId: string) => void;
  } = $props();

  type Listed = ImportableChat & { provider: ImportProvider };
  let chats = $state<Listed[]>([]);
  let reading = $state(0);
  let loading = $state(true);
  let truncated = $state(false);
  let failures = $state<string[]>([]);
  let query = $state('');
  let account = $state('all');
  let showStudio = $state(false);
  const selected = new SvelteSet<string>();
  // Chats imported while the dialog is open, by key.
  const imported = new SvelteMap<string, string>();
  let busy = $state(false);
  let stopping = $state(false);
  let progress = $state({ done: 0, total: 0 });
  let errors = $state<string[]>([]);
  let summary = $state('');
  let generation = 0;

  const accountKey = (chat: Listed) =>
    chat.connectionId ?? `none:${chat.provider}:${chat.location?.environmentId ?? ''}`;
  function environmentOf(key: string, chat?: Listed) {
    const environmentId = key.startsWith('none:')
      ? chat?.location?.environmentId
      : fleet.connections.find((c) => c.id === key)?.environmentId;
    return fleet.environments.find((e) => e.id === environmentId);
  }
  function accountLabel(key: string, provider: ImportProvider) {
    if (key.startsWith('none:')) return `No ${providers[provider].name} account`;
    return accountName(fleet, key) ?? 'Removed account';
  }
  function sourceName(source: ImportSource) {
    const environment = fleet.environments.find((e) => e.id === source.environmentId);
    const where = environment?.platform === 'wsl' ? ` in ${environment.name}` : '';
    return source.connectionId
      ? `${providers[source.provider].name} chats of ${accountName(fleet, source.connectionId) ?? 'a removed account'}${where}`
      : `${providers[source.provider].name} chats of this computer's CLI${where}`;
  }
  const conversationOf = (chat: Listed) => imported.get(chat.key) ?? chat.conversationId;
  const selectable = (chat: Listed) => !conversationOf(chat) && !!chat.location;
  const shown = (chat: Listed) =>
    showStudio || chat.origin !== 'studio' || !!chat.imported || imported.has(chat.key);

  async function load() {
    const run = ++generation;
    loading = true;
    chats = [];
    failures = [];
    truncated = false;
    selected.clear();
    try {
      const sources = await listImportSources();
      if (run !== generation) return;
      reading = sources.length;
      // Each store reads on its own: Claude's files are quick, Codex lists through its CLI.
      await Promise.all(
        sources.map(async (source) => {
          try {
            const listed = await listImportableChats(source.id);
            if (run !== generation) return;
            const known = new Map(chats.map((chat, index) => [chat.session, index]));
            const next = [...chats];
            for (const chat of listed.chats) {
              const entry = { ...chat, provider: source.provider };
              const index = known.get(chat.session);
              // An account switch copies a session into another profile: keep the newest copy.
              if (index === undefined) known.set(chat.session, next.push(entry) - 1);
              else if (byRecency(entry, next[index]) < 0) next[index] = entry;
            }
            chats = next;
            truncated ||= !!listed.truncated;
          } catch (e) {
            if (run === generation)
              failures = [
                ...failures,
                `${sourceName(source)}: ${String(e).replace(/^Error: /, '')}`,
              ];
          } finally {
            if (run === generation) reading--;
          }
        }),
      );
    } catch (e) {
      if (run === generation) failures = [String(e).replace(/^Error: /, '')];
    } finally {
      if (run === generation) loading = false;
    }
  }
  onMount(() => {
    void load();
    return () => generation++;
  });

  const accountOptions = $derived.by(() => {
    const counts = new Map<string, { provider: ImportProvider; chat: Listed; count: number }>();
    for (const chat of chats) {
      if (!shown(chat)) continue;
      const key = accountKey(chat);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { provider: chat.provider, chat, count: 1 });
    }
    const environments = new Set([...counts].map(([key, e]) => environmentOf(key, e.chat)?.id));
    const total = [...counts.values()].reduce((n, e) => n + e.count, 0);
    return [
      { id: 'all', name: 'All accounts', detail: `${total} ${total === 1 ? 'chat' : 'chats'}` },
      ...[...counts]
        .map(([key, entry]) => {
          const environment = environments.size > 1 ? environmentOf(key, entry.chat) : undefined;
          return {
            id: key,
            name: accountLabel(key, entry.provider),
            detail: `${providers[entry.provider].name}${environment ? ` · ${environment.name}` : ''} · ${entry.count} ${entry.count === 1 ? 'chat' : 'chats'}`,
            mark: providers[entry.provider].mark,
            color: providers[entry.provider].color,
            provider: entry.provider,
          };
        })
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)),
    ];
  });
  $effect(() => {
    if (account !== 'all' && !accountOptions.some((option) => option.id === account))
      account = 'all';
  });
  const visible = $derived(
    chats
      .filter(
        (chat) =>
          shown(chat) &&
          (account === 'all' || accountKey(chat) === account) &&
          matchesSearch(chat, query),
      )
      .sort(byRecency),
  );
  const choosable = $derived(visible.filter(selectable));
  const allChosen = $derived(
    choosable.length > 0 && choosable.every((chat) => selected.has(chat.key)),
  );
  const someChosen = $derived(choosable.some((chat) => selected.has(chat.key)));
  let allBox = $state<HTMLInputElement>();
  // A partly chosen list shows its select-all box as mixed, a property rather than an attribute.
  $effect(() => {
    if (allBox) allBox.indeterminate = someChosen && !allChosen;
  });
  function chooseAll() {
    if (allChosen) for (const chat of choosable) selected.delete(chat.key);
    else for (const chat of choosable) selected.add(chat.key);
  }
  function when(chat: Listed) {
    const time = Date.parse(chat.updatedAt ?? chat.createdAt ?? '');
    return Number.isFinite(time) ? dayLabel(time, Date.now()) : '';
  }

  async function importSelected() {
    if (busy || !selected.size) return;
    const queue = chats.filter((chat) => selected.has(chat.key)).sort(byRecency);
    busy = true;
    stopping = false;
    errors = [];
    summary = '';
    progress = { done: 0, total: queue.length };
    let count = 0;
    let notes = 0;
    for (const chat of queue) {
      if (stopping) break;
      try {
        const id = crypto.randomUUID();
        const result = await importChat(chat.key, id, chat.connectionId);
        await save(importedConversation(result, id, fleet));
        imported.set(chat.key, id);
        selected.delete(chat.key);
        count++;
        notes += result.notes?.length ?? 0;
      } catch (e) {
        errors = [...errors, `${chat.title}: ${String(e).replace(/^Error: /, '')}`];
      }
      progress = { done: progress.done + 1, total: queue.length };
    }
    busy = false;
    summary = count
      ? `Imported ${count} ${count === 1 ? 'chat' : 'chats'} into History.${notes ? ' Some images or records could not be read; their replies say what was left out.' : ''}`
      : '';
  }
</script>

<ConnectionDialog title="Import chats" wide {busy} {close}>
  <div class="import-chats" aria-busy={busy || loading}>
    <p>
      Chats that Claude Code and Codex saved on this computer: from the terminal, the desktop apps
      and each account's own profile. Imported chats open in History. Continuing one picks up its
      saved session with its context and tool results, as a copy, so the original stays as it was in
      its app.
    </p>
    <div class="import-toolbar">
      <label class="import-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          placeholder="Search chats"
          aria-label="Search chats"
          bind:value={query}
        />
      </label>
      <div class="import-account">
        <ChoicePicker
          field
          label="Account"
          options={accountOptions}
          value={account}
          disabled={!chats.length}
          onchange={(value) => (account = value)}
        />
      </div>
      <label class="checkbox import-studio">
        <input type="checkbox" bind:checked={showStudio} />
        Show chats Agent Studio started
      </label>
      <button
        type="button"
        class="icon-button"
        aria-label="Read the chats again"
        title="Read the chats again"
        disabled={busy || loading}
        onclick={() => void load()}><RefreshCw size={16} /></button
      >
    </div>
    <div class="import-list-head">
      <label class="checkbox">
        <input
          type="checkbox"
          bind:this={allBox}
          checked={allChosen}
          disabled={busy || !choosable.length}
          onchange={chooseAll}
        />
        Select all shown
      </label>
      <span class="import-status" role="status">
        {#if loading}<LoaderCircle class="spin" size={14} aria-hidden="true" />
          Reading chats on this computer{reading > 0
            ? ` (${reading} ${reading === 1 ? 'place' : 'places'} left)`
            : ''}…
        {:else}{visible.length} {visible.length === 1 ? 'chat' : 'chats'}{/if}
      </span>
    </div>
    <ul class="import-list" aria-label="Chats to import">
      {#each visible as chat (chat.key)}
        {@const existing = conversationOf(chat)}
        <li class="import-row" class:done={!!existing}>
          <label class="checkbox import-check">
            <input
              type="checkbox"
              aria-label={`Import ${chat.title}`}
              checked={selected.has(chat.key)}
              disabled={busy || !selectable(chat)}
              onchange={(event) =>
                event.currentTarget.checked ? selected.add(chat.key) : selected.delete(chat.key)}
            />
          </label>
          <span
            class="provider-icon import-provider"
            style:--provider-color={providers[chat.provider].color}
            aria-hidden="true">{providers[chat.provider].mark}</span
          >
          <div class="import-text">
            <strong title={chat.preview}>{chat.title}</strong>
            <span class="import-detail">
              <span title={chat.path}>{folderName(chat.path) || 'No folder'}</span>
              <span>{originName(chat.provider, chat.origin)}</span>
              {#if account === 'all'}<span>{accountLabel(accountKey(chat), chat.provider)}</span
                >{/if}
              {#if chat.model}<span>{formatModelName(chat.model)}</span>{/if}
              {#if chat.archived}<span>Archived</span>{/if}
            </span>
            {#if chat.unavailable && !existing}<span class="import-warning"
                ><TriangleAlert size={12} aria-hidden="true" />{chat.unavailable}{chat.location
                  ? ' It can still be imported to read.'
                  : ''}</span
              >{/if}
          </div>
          <span class="import-when">{when(chat)}</span>
          {#if existing}
            <span class="import-existing"
              >{chat.imported || imported.has(chat.key) ? 'Imported' : 'In Agent Studio'}
              <button
                type="button"
                class="text-button"
                disabled={busy}
                onclick={() => open(existing)}>Open</button
              ></span
            >
          {/if}
        </li>
      {:else}
        {#if !loading}
          <li class="import-empty">
            {chats.length
              ? 'No chats match.'
              : 'No Claude Code or Codex chats were found on this computer.'}
          </li>
        {/if}
      {/each}
    </ul>
    {#if truncated}<p class="import-note">
        Only the 5,000 most recent chats of each place are listed.
      </p>{/if}
    {#if failures.length}
      <div class="error-banner" role="alert">
        {#each failures as failure (failure)}<p>{failure}</p>{/each}
      </div>
    {/if}
    {#if errors.length}
      <div class="error-banner" role="alert">
        {#each errors as error (error)}<p>{error}</p>{/each}
      </div>
    {/if}
    <div class="dialog-actions">
      {#if summary}<span class="import-summary" role="status">{summary}</span>{/if}
      {#if busy}
        <button
          type="button"
          class="secondary"
          disabled={stopping}
          onclick={() => (stopping = true)}
          >{stopping ? 'Stopping…' : 'Stop after this chat'}</button
        >
      {:else}
        <button type="button" class="secondary" onclick={close}>Close</button>
      {/if}
      <button
        type="button"
        class="primary"
        disabled={busy || !selected.size}
        onclick={() => void importSelected()}
        >{busy
          ? `Importing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : `Import ${selected.size} ${selected.size === 1 ? 'chat' : 'chats'}`}</button
      >
    </div>
  </div>
</ConnectionDialog>

<style>
  .import-chats {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    flex: 1;
  }
  .import-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .import-search {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 220px;
    min-width: 0;
    color: var(--text-muted);
  }
  .import-search :global(svg) {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
  }
  .import-search input {
    width: 100%;
    padding-left: 32px;
  }
  .import-account {
    flex: 0 1 240px;
    min-width: 180px;
  }
  .import-studio {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .import-list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 10px;
    font-size: var(--text-sm);
  }
  .import-list-head .checkbox {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .import-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .import-list {
    flex: 1;
    min-height: 120px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-sunken);
  }
  .import-row {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
  }
  .import-row:hover {
    background: var(--hover);
  }
  .import-row.done {
    opacity: 0.72;
  }
  .import-check {
    gap: 0;
  }
  .import-provider {
    width: 28px;
    height: 28px;
    font-size: 15px;
    border-radius: var(--radius-sm);
  }
  .import-text {
    display: grid;
    gap: 3px;
    min-width: 0;
  }
  .import-text strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--text);
  }
  .import-detail {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    min-width: 0;
  }
  .import-detail > span:not(:first-child)::before {
    content: '·';
    margin: 0 6px;
    color: var(--text-faint);
  }
  .import-warning {
    display: inline-flex;
    align-items: flex-start;
    gap: 5px;
    color: var(--warning);
    font-size: var(--text-sm);
  }
  .import-warning :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  .import-when {
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .import-existing {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .import-empty {
    padding: 28px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--text-base);
  }
  .import-note {
    font-size: var(--text-sm);
  }
  .import-chats :global(.error-banner) {
    display: grid;
    gap: 4px;
    margin: 0;
    max-height: 120px;
    overflow-y: auto;
  }
  .import-chats :global(.error-banner p) {
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .import-summary {
    margin-right: auto;
    align-self: center;
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
  .import-chats :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 650px) {
    .import-row {
      grid-template-columns: auto auto minmax(0, 1fr);
    }
    .import-when,
    .import-existing {
      grid-column: 3;
    }
    .import-account {
      flex: 1 1 100%;
    }
  }
</style>
