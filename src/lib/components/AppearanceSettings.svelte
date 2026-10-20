<script lang="ts">
  import { Monitor, Moon, Palette, Sun } from '@lucide/svelte';
  import {
    appearance,
    setChatCard,
    setThemePreference,
    type ChatCard,
    type ThemePreference,
  } from '$lib/appearance.svelte';

  const options: { id: ThemePreference; name: string; icon: typeof Moon }[] = [
    { id: 'dark', name: 'Dark', icon: Moon },
    { id: 'light', name: 'Light', icon: Sun },
    { id: 'system', name: 'System', icon: Monitor },
  ];
  // Which part of a chat is a card, drawn where the card goes.
  const cards: { id: ChatCard; name: string }[] = [
    { id: 'header', name: 'Toolbar' },
    { id: 'chat', name: 'Conversation' },
    { id: 'whole', name: 'Whole chat' },
  ];
  let group = $state<HTMLDivElement>();
  let cardGroup = $state<HTMLDivElement>();
  function moveCard(event: KeyboardEvent) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    const current = cards.findIndex((card) => card.id === appearance.chatCard);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? cards.length - 1
          : (current +
              (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) +
              cards.length) %
            cards.length;
    setChatCard(cards[index].id);
    cardGroup?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  }

  function move(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const current = options.findIndex((option) => option.id === appearance.preference);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (current + step! + options.length) % options.length;
    setThemePreference(options[index].id);
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  }
</script>

<section aria-labelledby="appearance-heading">
  <h2 id="appearance-heading"><Palette size={18} />Appearance</h2>
  <div class="theme-options" role="radiogroup" aria-label="Theme" bind:this={group}>
    {#each options as option (option.id)}
      <button
        type="button"
        role="radio"
        class="theme-option"
        aria-checked={appearance.preference === option.id}
        tabindex={appearance.preference === option.id ? 0 : -1}
        onclick={() => setThemePreference(option.id)}
        onkeydown={move}
      >
        <span class={`theme-preview ${option.id}`} aria-hidden="true">
          <span class="preview-sidebar"><i></i><i></i><i></i></span>
          <span class="preview-main"><i></i><i></i><b></b></span>
        </span>
        <span class="theme-name"><option.icon size={14} aria-hidden="true" />{option.name}</span>
      </button>
    {/each}
  </div>
  <h3 id="chat-card-heading">Chat card</h3>
  <div
    class="theme-options"
    role="radiogroup"
    aria-labelledby="chat-card-heading"
    bind:this={cardGroup}
  >
    {#each cards as card (card.id)}
      <button
        type="button"
        role="radio"
        class="theme-option"
        aria-checked={appearance.chatCard === card.id}
        tabindex={appearance.chatCard === card.id ? 0 : -1}
        onclick={() => setChatCard(card.id)}
        onkeydown={moveCard}
      >
        <span class={`card-preview ${card.id}`} aria-hidden="true">
          <span class="preview-bar"><i></i></span>
          <span class="preview-body"><i></i><i></i><b></b></span>
        </span>
        <span class="theme-name">{card.name}</span>
      </button>
    {/each}
  </div>
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .theme-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    max-width: 520px;
    margin-top: 14px;
  }
  .theme-option {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-content: stretch;
    gap: 8px;
    justify-items: stretch;
    padding: 6px 6px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
    color: var(--text-secondary);
    text-align: left;
  }
  .theme-option:not(:disabled):hover {
    border-color: var(--border-hover);
  }
  .theme-option[aria-checked='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--accent-border);
  }
  .theme-preview {
    --canvas: var(--palette-dark-canvas);
    --rail: var(--palette-dark-sidebar);
    --ink: var(--palette-dark-line);
    display: grid;
    grid-template-columns: 30% 1fr;
    height: 64px;
    overflow: hidden;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--canvas);
  }
  .theme-preview.light {
    --canvas: var(--palette-light-canvas);
    --rail: var(--palette-light-sidebar);
    --ink: var(--palette-light-line);
  }
  .theme-preview.system {
    background: linear-gradient(
      135deg,
      var(--palette-dark-canvas) 0 50%,
      var(--palette-light-canvas) 50% 100%
    );
  }
  .theme-preview.system .preview-sidebar {
    background: transparent;
  }
  .preview-sidebar,
  .preview-main {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 7px;
  }
  .preview-sidebar {
    background: var(--rail);
  }
  .preview-main {
    justify-content: flex-end;
  }
  .theme-preview i,
  .theme-preview b {
    display: block;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--ink);
  }
  .preview-sidebar i:first-child {
    width: 70%;
    background: var(--palette-accent);
  }
  .preview-main i:first-child {
    width: 55%;
    align-self: flex-end;
  }
  .preview-main i:nth-child(2) {
    width: 80%;
  }
  .preview-main b {
    height: 12px;
    border-radius: 4px;
  }
  .theme-preview.system i,
  .theme-preview.system b {
    background: color-mix(in srgb, var(--palette-dark-line) 50%, var(--palette-light-line));
  }
  .theme-preview.system .preview-sidebar i:first-child {
    background: var(--palette-accent);
  }
  .theme-name {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  h3 {
    margin: 22px 0 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
  /* The part that is a card has its own outline in the preview. */
  .card-preview {
    display: flex;
    flex-direction: column;
    gap: 4px;
    height: 64px;
    padding: 5px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  .preview-bar,
  .preview-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: 4px;
  }
  .preview-body {
    flex: 1;
    justify-content: flex-end;
  }
  .card-preview.header .preview-bar,
  .card-preview.chat .preview-body,
  .card-preview.whole .preview-bar,
  .card-preview.whole .preview-body {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }
  /* The whole chat is one card, a divider between its toolbar and its conversation. */
  .card-preview.whole {
    gap: 0;
  }
  .card-preview.whole .preview-bar {
    border-radius: 4px 4px 0 0;
  }
  .card-preview.whole .preview-body {
    border-top: 0;
    border-radius: 0 0 4px 4px;
  }
  .card-preview i,
  .card-preview b {
    display: block;
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--border-strong);
  }
  .preview-bar i {
    width: 60%;
  }
  .preview-body i:first-child {
    width: 45%;
    align-self: flex-end;
  }
  .preview-body i:nth-child(2) {
    width: 70%;
  }
  .preview-body b {
    height: 8px;
    border-radius: 3px;
  }
  @media (max-width: 420px) {
    .theme-options {
      gap: 6px;
    }
    .theme-preview {
      height: 52px;
    }
  }
</style>
