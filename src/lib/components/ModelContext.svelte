<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { X, RefreshCw, Search, FileText, Sparkles, Brain, Copy, Check } from '@lucide/svelte';
  import { providers, type ChatSettings, type ChatLocation } from '$lib/domain';
  import { contextCache } from '$lib/transport';
  import {
    contextKey,
    contextStatuses,
    type ContextSnapshot,
    type ContextKind,
  } from '$lib/context';

  let {
    settings,
    location,
    modelName,
    accountName,
    computerName,
    close,
    useSkill,
  }: {
    settings: ChatSettings;
    location?: ChatLocation;
    modelName: string;
    accountName: string;
    computerName: string;
    close: () => void;
    useSkill: (name: string, path: string) => void;
  } = $props();
  let snapshot = $state<ContextSnapshot>();
  let error = $state('');
  let loading = $state(false);
  let category = $state<ContextKind>('instructions');
  let search = $state('');
  let refresh = $state(0);
  let copied = $state('');
  let closeButton: HTMLButtonElement;
  const selectionKey = $derived(contextKey(settings, location));
  const categories = [
    { id: 'instructions', name: 'Instructions', icon: FileText },
    { id: 'skills', name: 'Skills', icon: Sparkles },
    { id: 'memories', name: 'Memories', icon: Brain },
  ] as const;
  const entries = $derived((snapshot?.entries ?? []).filter((e) => e.kind === category));
  const filtered = $derived(
    entries.filter((e) =>
      `${e.name} ${e.path} ${e.scope} ${contextStatuses[e.status]}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
  );
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.focus();
    return () => previous?.isConnected && previous.focus();
  });
  $effect(() => {
    selectionKey;
    refresh;
    let cancelled = false;
    untrack(() => {
      const selected = {
        provider: settings.provider,
        model: settings.model,
        connectionId: settings.connectionId,
      };
      const folder = location;
      snapshot = contextCache.peek(selected, folder);
      error = '';
      loading = true;
      contextCache
        .refresh(selected, folder)
        .then((value) => {
          if (!cancelled) snapshot = value;
        })
        .catch((e) => {
          if (!cancelled) error = String(e);
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    });
    return () => {
      cancelled = true;
    };
  });
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      copied = path;
    } catch {
      error = 'Could not copy the path. Select the path text to copy it manually.';
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div
    class="modal context-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="context-title"
    tabindex="-1"
  >
    <header>
      <div>
        <span class="eyebrow">{providers[settings.provider].name} · {modelName}</span>
        <h2 id="context-title">Model context</h2>
      </div>
      <button
        bind:this={closeButton}
        class="icon-button"
        onclick={close}
        aria-label="Close model context"><X size={20} /></button
      >
    </header>
    <p class="context-intro">
      Instructions and resources for this model’s selected account and folder. Models using the same
      CLI profile and folder share these sources.
    </p>
    <div class="context-location">
      <strong>{computerName} · {accountName}</strong>
      <span>{snapshot?.execution ?? providers[settings.provider].name}</span>
      <code>{snapshot?.folder ?? location?.path ?? 'Isolated conversation folder'}</code>
      {#if snapshot}<span class="context-profile">Profile: <code>{snapshot.profile}</code></span
        >{/if}
    </div>
    {#if settings.instructions.trim()}
      <details class="context-custom">
        <summary>Conversation instructions <span>Included with the next message</span></summary>
        <pre>{settings.instructions}</pre>
      </details>
    {/if}
    <div class="context-categories" aria-label="Context categories">
      {#each categories as tab}
        <button
          class:active={category === tab.id}
          aria-pressed={category === tab.id}
          onclick={() => {
            category = tab.id;
            search = '';
          }}
        >
          <tab.icon size={15} />{tab.name}<span
            >{snapshot ? snapshot.entries.filter((e) => e.kind === tab.id).length : '—'}</span
          >
        </button>
      {/each}
    </div>
    <div class="context-search">
      <Search size={15} aria-hidden="true" /><input
        aria-label="Filter context sources"
        placeholder="Filter by name, path, or scope…"
        bind:value={search}
      />
      <button
        class="icon-button"
        disabled={loading}
        onclick={() => refresh++}
        aria-label="Refresh model context"
        title="Refresh model context"
        ><RefreshCw size={15} class={loading ? 'spinning' : ''} /></button
      >
    </div>
    {#if error}<p class="error-banner" role="alert">{error}</p>{/if}
    <div class="context-entries" aria-busy={loading}>
      {#if loading && !snapshot}<p class="context-empty" role="status">
          Inspecting the selected CLI profile…
        </p>
      {:else if snapshot && !filtered.length}<p class="context-empty">
          {search
            ? 'No sources match this filter.'
            : `No ${category} were reported or found in the inspected locations.`}
        </p>
      {:else}
        {#each filtered as entry (entry.kind + entry.path)}
          <article class="context-entry">
            <div class="context-entry-title">
              <strong>{entry.name}</strong><span class="context-scope">{entry.scope}</span><span
                class="context-status"
                class:reported={entry.status === 'reported'}>{contextStatuses[entry.status]}</span
              >
            </div>
            <div class="context-path">
              <code>{entry.path}</code><button
                class="icon-button"
                aria-label={`Copy path for ${entry.name}`}
                title="Copy path"
                onclick={() => copyPath(entry.path)}
                >{#if copied === entry.path}<Check size={14} />{:else}<Copy
                    size={14}
                  />{/if}</button
              >
            </div>
            <p>{entry.detail}</p>
            {#if entry.kind === 'skills' && settings.provider !== 'gemini'}
              <button
                class="text-button"
                disabled={entry.status === 'disabled'}
                aria-label={`Use skill ${entry.name}`}
                title={entry.status === 'disabled'
                  ? 'Disabled in the selected CLI profile'
                  : 'Add this skill to your next message'}
                onclick={() => useSkill(entry.name, entry.path)}
                ><Sparkles size={13} />Use in next message</button
              >
            {/if}
          </article>
        {/each}
      {/if}
    </div>
    {#if snapshot}
      <div class="context-notes">
        {#if snapshot.truncated}<p role="status">
            The inventory reached its size limit. Additional sources may exist.
          </p>{/if}
        {#each snapshot.notes as note}<p>{note}</p>{/each}
      </div>
      <footer>
        <span
          >Checked {new Date(snapshot.checkedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })} · File inventory
          <span role="status"
            >{loading ? '· Updating…' : error ? '· Showing last saved result' : ''}</span
          ></span
        ><button class="secondary" onclick={close}>Done</button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .context-modal {
    width: min(820px, 100%);
    height: min(800px, 100%);
    max-height: 100%;
    scrollbar-gutter: stable;
    padding: 26px;
  }
  .context-modal header {
    margin-bottom: 14px;
  }
  .context-intro {
    font-size: 12px;
    line-height: 1.7;
    color: #a9ba9b;
    margin: 0 0 16px;
  }
  .context-location {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 12px;
    font-size: 11px;
    padding: 13px 15px;
    background: #15200f;
    border: 1px solid #35472b;
    border-radius: 8px;
  }
  .context-location > strong {
    color: #d5dfca;
  }
  .context-location > span {
    color: #97af80;
  }
  .context-location > code,
  .context-profile {
    flex-basis: 100%;
  }
  code {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-size: 10px;
    color: #a4b697;
  }
  .context-custom {
    margin-top: 15px;
    font-size: 11px;
  }
  summary {
    cursor: pointer;
  }
  summary span {
    color: #91a680;
    margin-left: 10px;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    line-height: 1.7;
    padding: 12px;
    background: #15200f;
    max-height: 180px;
    overflow: auto;
  }
  .context-categories {
    display: flex;
    margin-top: 20px;
    gap: 8px;
    border-bottom: 1px solid #35472b;
  }
  .context-categories button {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 11px 12px;
    font-size: 12px;
    color: #96ab86;
    border-bottom: 2px solid transparent;
  }
  .context-categories button.active {
    color: #d9e8cb;
    border-bottom-color: #a8c68d;
  }
  .context-categories button span {
    color: #839a71;
    font-size: 10px;
  }
  .context-search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 15px 0 5px;
    color: #94ab81;
  }
  .context-search input {
    width: 100%;
    padding: 9px 10px;
  }
  .context-entries {
    min-height: 125px;
    height: 33vh;
    overflow: auto;
    scrollbar-gutter: stable;
  }
  .context-entry {
    border-bottom: 1px solid #334329;
    padding: 13px 0;
  }
  .context-entry-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 12px;
  }
  .context-entry-title strong {
    overflow-wrap: anywhere;
  }
  .context-scope {
    font-size: 10px;
    color: #8fa47e;
  }
  .context-status {
    margin-left: auto;
    font-size: 10px;
    color: #a6b49a;
  }
  .context-status.reported {
    color: #afd88e;
  }
  .context-path {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 5px;
  }
  .context-path code {
    flex: 1;
  }
  .context-path button {
    flex-shrink: 0;
  }
  .context-entry p {
    margin: 4px 25px 0 0;
    color: #8ba179;
    font-size: 10px;
    line-height: 1.6;
  }
  .context-empty {
    padding: 30px 5px;
    color: #9ab187;
    font-size: 12px;
    line-height: 1.7;
  }
  .context-notes {
    margin-top: 15px;
  }
  .context-notes p {
    color: #9caf8b;
    font-size: 10px;
    line-height: 1.7;
    margin: 5px 0;
  }
  .context-modal footer {
    align-items: center;
    padding-top: 13px;
    margin-top: 14px;
  }
  footer span {
    margin-right: auto;
    font-size: 10px;
    color: #8ba179;
  }
  @media (max-width: 700px) {
    .context-modal {
      padding: 18px;
    }
    .context-categories {
      gap: 0;
    }
    .context-categories button {
      padding: 10px 8px;
    }
  }
  @media (max-width: 360px) {
    .context-categories button {
      flex: 1;
      gap: 4px;
      padding: 10px 4px;
      font-size: 11px;
    }
  }
</style>
