<script lang="ts">
  import { onMount } from 'svelte';
  import { Trash2 } from '@lucide/svelte';

  let {
    x,
    y,
    name,
    trigger,
    disabled,
    close,
    remove,
  }: {
    x: number;
    y: number;
    name: string;
    trigger: HTMLElement;
    disabled: boolean;
    close: (restoreFocus?: boolean) => void;
    remove: () => void;
  } = $props();
  let menu: HTMLDivElement;
  let item: HTMLButtonElement;

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
    item.focus({ preventScroll: true });
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
      item.focus();
    }
  }
</script>

<svelte:document
  onpointerdown={(event) => {
    if (menu && !menu.contains(event.target as Node)) close();
  }}
/>

<div
  class="conversation-context-menu"
  role="menu"
  tabindex="-1"
  aria-label={`Actions for ${name}`}
  popover="manual"
  bind:this={menu}
  onkeydown={keyboard}
  oncontextmenu={(event) => event.preventDefault()}
>
  <button
    type="button"
    role="menuitem"
    tabindex="-1"
    aria-disabled={disabled}
    title={disabled ? 'Stop the response before deleting this conversation.' : undefined}
    bind:this={item}
    onclick={() => {
      if (!disabled) remove();
    }}><Trash2 size={15} aria-hidden="true" />Delete conversation</button
  >
</div>

<style>
  .conversation-context-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 5px;
    width: 204px;
    max-width: calc(100vw - 16px);
    border: 1px solid #3a4433;
    border-radius: 8px;
    background: #1b2119;
    box-shadow: 0 12px 32px #0006;
  }
  button {
    width: 100%;
    min-height: 36px;
    padding: 8px 10px;
    justify-content: flex-start;
    gap: 9px;
    border-radius: 5px;
    font-size: 12px;
    color: #efaa96;
    white-space: nowrap;
  }
  button:hover,
  button:focus-visible {
    background: #392921;
  }
  button[aria-disabled='true'] {
    color: var(--muted);
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
