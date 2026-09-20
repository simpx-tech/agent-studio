<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import { contextCache, searchMentions } from '$lib/transport';
  import {
    mentionQuery,
    retainMentions,
    maxMentions,
    hasMention,
    type Mention,
    type MentionResult,
  } from '$lib/mentions';
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
    references = $bindable([]),
    staleTokens = $bindable([]),
    referenceSelection = $bindable(''),
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
    references?: Mention[];
    staleTokens?: string[];
    referenceSelection?: string;
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
  let inventoryRevision = $state(0);
  let mentionResults = $state<MentionResult>();
  let mentionLoading = $state(false);
  let mentionError = $state('');
  let appCatalog: { key: string; value: MentionResult; checkedAt: number } | undefined;
  const referenceScope = $derived(
    contextKey({ ...settings, model: '', conversationId }, location) + scope,
  );
  const mention = $derived(mentionQuery(prompt, caret));
  const mentionSupported = $derived(
    settings.provider === 'codex' || (settings.provider === 'claude' && mention?.kind === 'file'),
  );
  const mentionMode = $derived(!!mention && mentionSupported);
  // App names filter one catalog locally; typing must not restart its native query.
  const mentionSearchKind = $derived(mention?.kind);
  const mentionSearchTerm = $derived(mention?.kind === 'app' ? '' : mention?.query);
  const mentionOptions = $derived(
    (mentionResults?.entries ?? [])
      .filter(
        (m) =>
          mention?.kind !== 'app' ||
          `${m.name} ${m.token}`.toLowerCase().includes(mention.query.toLowerCase()),
      )
      .map((m) => ({
        id: m.path,
        name: m.kind === 'file' ? m.name : m.token,
        detail: m.kind === 'app' ? m.name : 'File',
        title: m.path,
      })),
  );
  $effect(() => {
    referenceScope;
    untrack(() => {
      if (referenceSelection === referenceScope) return;
      staleTokens = [...staleTokens, ...references.map((m) => m.token)];
      references = [];
      referenceSelection = referenceScope;
      appCatalog = undefined;
      mentionResults = undefined;
      open = false;
    });
  });
  $effect(() => {
    const text = prompt;
    untrack(() => {
      references = retainMentions(text, references);
      staleTokens = staleTokens.filter((t) => hasMention(text, t));
    });
  });
  $effect(() => {
    const selection = referenceScope,
      kind = mentionSearchKind,
      term = mentionSearchTerm;
    const visible = open && mentionMode && available;
    inventoryRevision;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    untrack(() => {
      mentionResults = undefined;
      mentionError = '';
      mentionLoading = false;
      if (!visible || !kind || term === undefined) return;
      const selected = {
        provider: settings.provider,
        connectionId: settings.connectionId,
        conversationId,
      };
      const folder = location ? { ...location } : undefined;
      if (
        kind === 'app' &&
        appCatalog?.key === selection &&
        Date.now() - appCatalog.checkedAt < 60_000
      ) {
        mentionResults = appCatalog.value;
        return;
      }
      mentionLoading = true;
      timer = setTimeout(() => {
        void searchMentions(selected, folder, kind, kind === 'app' ? '' : term)
          .then((value) => {
            if (cancelled) return;
            mentionResults = value;
            if (kind === 'app') appCatalog = { key: selection, value, checkedAt: Date.now() };
          })
          .catch((cause) => {
            if (!cancelled)
              mentionError =
                typeof cause === 'string'
                  ? cause
                  : 'Could not search mentions. Check the selected computer and reopen the picker.';
          })
          .finally(() => {
            if (!cancelled) mentionLoading = false;
          });
      }, 250);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });
  function chooseMention(path: string) {
    const selected = mentionResults?.entries.find((m) => m.path === path);
    if (!selected || !mention || !input || !available || !mentionSupported) return;
    if (references.length >= maxMentions && !references.some((m) => m.token === selected.token)) {
      error = `Use up to ${maxMentions} mentions per message.`;
      return;
    }
    const before = prompt.slice(0, mention.start),
      after = prompt.slice(mention.end);
    const nextCaret = before.length + selected.token.length + 1;
    if (before.length + selected.token.length + after.length + 1 > 30_000) {
      error = 'The message is too long to insert this mention.';
      return;
    }
    prompt = `${before}${selected.token}${/^\s/.test(after) ? '' : ' '}${after}`;
    if (settings.provider === 'codex')
      references = [...references.filter((m) => m.token !== selected.token), selected];
    staleTokens = staleTokens.filter((t) => t !== selected.token);
    open = false;
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(nextCaret, nextCaret);
      caret = nextCaret;
    });
  }
  onMount(() => {
    const changed = () => {
      chosen = undefined;
      snapshot = undefined;
      inventoryRevision++;
      appCatalog = undefined;
    };
    window.addEventListener('studio-skills-changed', changed);
    return () => window.removeEventListener('studio-skills-changed', changed);
  });
  const key = $derived(contextKey({ ...settings, conversationId, forked }, location));
  const token = $derived(commandToken(prompt));
  const query = $derived(commandQuery(prompt, caret));
  const choices = $derived(
    commandChoices(settings.provider, available ? snapshot : undefined).filter(
      (c) => !busy || !['/instructions', '/fast'].includes(c.name),
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
    inventoryRevision;
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
      const candidate = mentionQuery(input!.value, caret);
      open =
        commandQuery(input!.value, caret) !== undefined ||
        (!!candidate &&
          (settings.provider === 'codex' ||
            (settings.provider === 'claude' && candidate.kind === 'file')));
      error = '';
    };
    for (const event of ['input', 'click', 'select', 'focus'])
      input.addEventListener(event, update);
    const keyup = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update();
    };
    input.addEventListener('keyup', keyup);
    return () => {
      input?.removeEventListener('keyup', keyup);
      for (const event of ['input', 'click', 'select', 'focus'])
        input?.removeEventListener(event, update);
    };
  });
  // Programmatic draft updates must not leave a popup or a skill from old input.
  $effect(() => {
    if (!prompt.startsWith('/')) {
      chosen = undefined;
      error = '';
    }
    if (!prompt) open = false;
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
    if (
      open &&
      mentionMode &&
      (event.key === 'Enter' || event.key === 'Tab') &&
      !event.shiftKey &&
      !event.isComposing &&
      !mentionOptions.length
    ) {
      event.preventDefault();
      return true;
    }
    // Keyup must not reopen a dismissed/selected popup.
    return picker?.handleKeydown(event) ?? false;
  }
  export async function submission(): Promise<
    | { handled: boolean; skills?: SkillReference[]; mentions?: Mention[]; compact?: boolean }
    | undefined
  > {
    error = '';
    const mentions = settings.provider === 'codex' ? retainMentions(prompt, references) : [];
    if (mentions.length > maxMentions) {
      error = `The restored draft has more than ${maxMentions} mentions. Remove some before sending.`;
      return;
    }
    if (staleTokens.some((t) => hasMention(prompt, t))) {
      error = 'The mention selection changed. Choose those mentions again, or remove their text.';
      return;
    }
    const match = commandToken(prompt);
    if (!match) return { handled: false, ...(mentions.length ? { mentions } : {}) };
    const name = `/${match[1]}`;
    if (name === '/fast' && settings.provider === 'claude') {
      if (busy) {
        error = 'Wait for the reply to finish before changing Fast mode.';
        return;
      }
      const argument = prompt.slice(match[0].length).trim();
      if (argument && !['on', 'off', 'default'].includes(argument)) {
        error = 'Use /fast to open its settings, or /fast on, /fast off, or /fast default.';
        return;
      }
      prompt = '';
      open = false;
      oncommand(argument ? `fast:${argument}` : 'fast');
      return { handled: true };
    }
    if (name === '/compact') {
      if (!conversationId || busy || !available || settings.provider === 'gemini') {
        error =
          'Compaction is available in an idle Claude or Codex conversation on a connected computer.';
        return;
      }
      if (settings.provider === 'codex' && prompt.trim() !== '/compact') {
        error =
          'Codex compaction does not accept additional instructions. Use /compact on its own.';
        return;
      }
      open = false;
      return { handled: false, compact: true };
    }
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
    return {
      handled: false,
      ...(selected.skill ? { skills: [selected.skill] } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
  }
</script>

{#if input}
  <ChoicePicker
    bind:this={picker}
    anchor={input}
    bind:open
    options={mentionMode ? mentionOptions : filtered}
    value=""
    label={mentionMode ? (mention?.kind === 'app' ? 'Apps' : 'Files') : 'Commands and skills'}
    heading={mentionMode
      ? `${mention?.kind === 'app' ? 'Apps' : 'Files'} · ${mentionLoading ? 'Loading…' : '↑ ↓ · Enter or Tab'}`
      : loading
        ? 'Commands and skills · Loading…'
        : 'Commands and skills · ↑ ↓ · Enter or Tab'}
    emptyMessage={mentionMode
      ? !available
        ? 'Connect the selected agent to search mentions.'
        : mentionLoading
          ? 'Searching…'
          : mentionError || `No matching ${mention?.kind === 'app' ? 'enabled apps' : 'files'}`
      : loading
        ? 'Loading commands and skills…'
        : queryError || 'No matching commands or skills'}
    onchange={mentionMode ? chooseMention : choose}
  />
{/if}
{#if error}<p class="command-notice" role="alert">{error}</p>
{:else if open && mentionMode && (mentionResults?.notice || mentionResults?.truncated)}<p
    class="command-notice"
    role="status"
  >
    {mentionResults.notice}
    {mentionResults.truncated
      ? mention?.kind === 'app'
        ? 'Catalog is limited; some apps may not appear.'
        : 'Showing limited results. Narrow your search.'
      : ''}
  </p>
{:else if open && !mentionMode && queryError}<p class="command-notice" role="status">
    {queryError}
  </p>{/if}

<style>
  .command-notice {
    margin: 6px 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
