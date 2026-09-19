<script lang="ts">
  import { tick, untrack } from 'svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { contextCache } from '$lib/transport';
  import { contextKey, type ContextSnapshot } from '$lib/context';
  import {
    appCommands,
    commandChoices,
    commandQuery,
    commandToken,
    filterCommands,
    sessionCommands,
    type ComposerCommand,
  } from '$lib/commands';
  import type { ChatLocation, ChatSettings, SkillReference } from '$lib/domain';
  let {
    input,
    prompt = $bindable(),
    settings,
    conversationId,
    forked = false,
    location,
    available,
    busy,
    scope,
    oncommand,
  }: {
    input?: HTMLTextAreaElement;
    prompt: string;
    settings: ChatSettings;
    conversationId?: string;
    forked?: boolean;
    location?: ChatLocation;
    available: boolean;
    busy: boolean;
    scope: string;
    oncommand: (name: string) => void;
  } = $props();
  let picker = $state<ChoicePicker>();
  let snapshot = $state<ContextSnapshot>();
  let open = $state(false);
  let caret = $state(0);
  let loading = $state(false);
  let error = $state('');
  let queryError = $state('');
  let chosen = $state<ComposerCommand>();
  let pending: Promise<ContextSnapshot> | undefined;
  const key = $derived(contextKey({ ...settings, conversationId, forked }, location));
  const token = $derived(commandToken(prompt));
  const query = $derived(commandQuery(prompt, caret));
  const choices = $derived(
    commandChoices(settings.provider, available ? snapshot : undefined).filter(
      (c) => !busy || c.name !== '/instructions',
    ),
  );
  const filtered = $derived(filterCommands(choices, query ?? ''));
  const needsCatalog = $derived(
    available && settings.provider !== 'gemini' && prompt.startsWith('/'),
  );

  $effect(() => {
    key;
    scope;
    untrack(() => {
      chosen = undefined;
      error = '';
      open = false;
    });
  });
  $effect(() => {
    key;
    needsCatalog;
    let cancelled = false;
    untrack(() => {
      snapshot = undefined;
      queryError = '';
      loading = false;
      pending = undefined;
      if (!needsCatalog) return;
      const selected = {
        provider: settings.provider,
        model: settings.model,
        connectionId: settings.connectionId,
        conversationId,
        forked,
      };
      snapshot = contextCache.peek(selected, location);
      loading = true;
      pending = contextCache.refresh(selected, location);
      pending
        .then((value) => {
          if (!cancelled) {
            snapshot = value;
            if (!Array.isArray(value.commands))
              queryError =
                'Update Agent Studio on the selected computer to use commands and skills.';
          }
        })
        .catch(() => {
          if (!cancelled) queryError = 'Could not refresh commands. Reopen / to retry.';
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    });
    return () => {
      cancelled = true;
    };
  });
  $effect(() => {
    if (!input) return;
    const update = () => {
      caret = input!.selectionStart;
      open = commandQuery(input!.value, caret) !== undefined;
      error = '';
    };
    for (const event of ['input', 'click', 'select', 'focus'])
      input.addEventListener(event, update);
    return () => {
      for (const event of ['input', 'click', 'select', 'focus'])
        input?.removeEventListener(event, update);
    };
  });
  // Programmatic draft updates must not leave a popup or a skill from old input.
  $effect(() => {
    if (!prompt.startsWith('/')) {
      open = false;
      chosen = undefined;
      error = '';
    }
  });
  function choose(id: string) {
    const command = choices.find((c) => c.id === id);
    if (!command || !input) return;
    const end = token?.[0].length ?? caret;
    if (command.kind === 'app') {
      prompt = prompt.slice(end).trimStart();
      open = false;
      if (command.name === '/help') {
        prompt = prompt ? `/ ${prompt}` : '/';
        void tick().then(() => {
          input?.focus();
          input?.setSelectionRange(1, 1);
          caret = 1;
          open = true;
        });
      } else oncommand(command.name.slice(1));
      return;
    }
    chosen = command;
    const rest = prompt.slice(end).trimStart();
    prompt = `${command.name} ${rest}`;
    open = false;
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(command.name.length + 1, command.name.length + 1);
    });
  }
  export function keydown(event: KeyboardEvent) {
    // Keyup must not reopen a dismissed/selected popup.
    return picker?.handleKeydown(event) ?? false;
  }
  export async function submission(): Promise<
    { handled: boolean; skills?: SkillReference[] } | undefined
  > {
    error = '';
    const match = commandToken(prompt);
    if (!match) return { handled: false };
    const name = `/${match[1]}`;
    if (busy && name === '/instructions') {
      error = 'Wait for the reply to finish before editing instructions.';
      return;
    }
    const local =
      chosen?.kind === 'skill' && chosen.name === name
        ? undefined
        : appCommands.find((c) => c.name === name);
    if (local) {
      choose(local.id);
      return { handled: true };
    }
    if (!available) {
      error = 'Connect the selected agent to use its commands and skills.';
      return;
    }
    const before = key,
      draft = prompt;
    if (loading && pending) {
      try {
        await pending;
        await tick();
      } catch {
        /* Show a local error below. */
      }
    }
    if (key !== before || prompt !== draft || !available) return;
    if (queryError) {
      error = queryError;
      return;
    }
    const matches = choices.filter((c) => c.kind !== 'app' && c.name === name);
    if (!matches.length && sessionCommands.has(match[1])) {
      error = `/${match[1]} needs a persistent CLI session. Use /new for a new chat; other commands and skills are listed under /.`;
      return;
    }
    if (
      chosen?.kind === 'skill' &&
      chosen.name === name &&
      !matches.some((c) => c.id === chosen?.id)
    ) {
      error = 'The selected skill is no longer available. Choose a skill from / again.';
      return;
    }
    const selected =
      matches.find((c) => c.id === chosen?.id) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!selected) {
      error =
        matches.length > 1
          ? 'Several skills use this name. Choose its exact source from /.'
          : queryError ||
            `Command ${name} is unavailable for this agent. Type / to see commands and skills. Wrap literal slash text in backticks.`;
      return;
    }
    open = false;
    return { handled: false, ...(selected.skill ? { skills: [selected.skill] } : {}) };
  }
</script>

{#if input}
  <ChoicePicker
    bind:this={picker}
    anchor={input}
    bind:open
    options={filtered}
    value=""
    label="Commands and skills"
    heading={loading
      ? 'Commands and skills · Loading…'
      : 'Commands and skills · ↑ ↓ · Enter or Tab'}
    emptyMessage={loading
      ? 'Loading commands and skills…'
      : queryError || 'No matching commands or skills'}
    onchange={choose}
  />
{/if}
{#if error}<p class="command-notice" role="alert">{error}</p>
{:else if open && queryError}<p class="command-notice" role="status">{queryError}</p>{/if}

<style>
  .command-notice {
    margin: 6px 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
