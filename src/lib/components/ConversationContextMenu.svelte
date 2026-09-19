<script lang="ts">
  import { onMount } from 'svelte';
  import { GitFork, Trash2 } from '@lucide/svelte';

  let {
    x,
    y,
    name,
    trigger,
    close,
    remove,
    fork,
    forkDisabled = false,
  }: {
    x: number;
    y: number;
    name: string;
    trigger: HTMLElement;
    close: (restoreFocus?: boolean) => void;
    remove: () => void;
    fork: () => void;
    forkDisabled?: boolean;
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
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
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
    onclick={fork}
    disabled={forkDisabled}
    title={forkDisabled
      ? 'A finished reply is needed to fork this conversation'
      : 'Start a separate chat from the finished replies'}
    ><GitFork size={15} aria-hidden="true" />Fork conversation</button
  >
  <button class="danger" type="button" role="menuitem" tabindex="-1" onclick={remove}
    ><Trash2 size={15} aria-hidden="true" />Delete conversation</button
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
    color: var(--text);
    white-space: nowrap;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: #2b3427;
  }
  button.danger {
    color: #efaa96;
  }
  button.danger:hover,
  button.danger:focus-visible {
    background: #392921;
  }
  @media (pointer: coarse) {
    button {
      min-height: 44px;
    }
  }
</style>
