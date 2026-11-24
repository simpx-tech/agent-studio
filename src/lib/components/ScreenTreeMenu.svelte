<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Folder, Laptop } from '@lucide/svelte';
  import type { ScreenDestination, ScreenMenuAction } from '$lib/screen-groups';

  // The menu of a screen or a group in the Screens tab (requested 2026-11-24): what it can do,
  // and the places it can move to, its computer's top and each group there, the current one
  // checked. It sits where it was opened, within the window, as the sidebar's other menus do.
  let {
    x,
    y,
    name,
    trigger,
    close,
    actions,
    destinations,
    current,
    choose,
    moveFirst = false,
  }: {
    x: number;
    y: number;
    name: string;
    trigger: HTMLElement;
    close: (restoreFocus?: boolean) => void;
    actions: ScreenMenuAction[];
    destinations: ScreenDestination[];
    /** The group it is in now; none at the top. */
    current?: string;
    choose: (group: string | undefined) => void;
    moveFirst?: boolean;
  } = $props();
  let menu: HTMLDivElement;

  onMount(() => {
    menu.showPopover();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? innerWidth;
    const height = viewport?.height ?? innerHeight;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 8, Math.min(x, left + width - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - bounds.height - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const dismiss = () => close();
    const scroll = (event: Event) => {
      if (
        event.target === document ||
        (event.target instanceof Element && event.target.contains(trigger))
      )
        close();
    };
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    viewport?.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      viewport?.removeEventListener('resize', dismiss);
    };
  });

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  }
</script>

<svelte:document
  onpointerdown={(event) => {
    if (menu && !menu.contains(event.target as Node)) close();
  }}
/>

{#snippet moves()}
  <div class="menu-label" role="presentation">Move to</div>
  {#each destinations as place, index (place.id ?? '')}
    {@const here = place.id === current}
    <button
      type="button"
      role="menuitemradio"
      tabindex="-1"
      aria-checked={here}
      disabled={here}
      style:padding-left={`${9 + place.depth * 14}px`}
      onclick={() => choose(place.id)}
      >{#if index === 0}<Laptop size={15} aria-hidden="true" />{:else}<Folder
          size={15}
          aria-hidden="true"
        />{/if}<span>{place.name}</span>{#if here}<Check
          class="menu-check"
          size={14}
          aria-hidden="true"
        />{/if}</button
    >
  {/each}
{/snippet}

<div
  class="screen-tree-menu"
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${name}`}
  popover="manual"
  bind:this={menu}
  onkeydown={keyboard}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#if moveFirst}{@render moves()}{#if actions.length}<div
        class="menu-separator"
        role="separator"
      ></div>{/if}{/if}
  {#each actions as action (action.label)}
    {@const Icon = action.icon}
    <button type="button" role="menuitem" tabindex="-1" onclick={action.run}
      ><Icon size={15} aria-hidden="true" /><span>{action.label}</span></button
    >
  {/each}
  {#if !moveFirst}{#if actions.length}<div
        class="menu-separator"
        role="separator"
      ></div>{/if}{@render moves()}{/if}
</div>

<style>
  .screen-tree-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 5px;
    width: 230px;
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-lg);
  }
  .screen-tree-menu:popover-open {
    animation: fade-in var(--duration-fast) ease;
  }
  .menu-label {
    padding: 6px 9px 4px;
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .menu-separator {
    height: 1px;
    margin: 5px 4px;
    background: var(--border);
  }
  button {
    width: 100%;
    min-height: 32px;
    padding: 6px 9px;
    justify-content: flex-start;
    gap: 9px;
    border-radius: var(--radius-sm);
    font-size: var(--text-base);
    color: var(--text);
  }
  button > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--active);
    outline: none;
  }
  button[aria-checked='true'] {
    opacity: 1;
    color: var(--text-secondary);
  }
  button :global(.menu-check) {
    color: var(--accent-text);
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
