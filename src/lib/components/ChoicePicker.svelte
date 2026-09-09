<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Check, ChevronDown } from '@lucide/svelte';
  import { anchorPopover } from '$lib/anchorPopover';
  type Option = {
    id: string;
    name: string;
    detail?: string;
    title?: string;
    mark?: string;
    color?: string;
  };

  let {
    options,
    value,
    label,
    title,
    icon,
    disabled = false,
    field = false,
    onchange,
  }: {
    options: Option[];
    value: string;
    label: string;
    title?: string;
    icon?: Snippet;
    disabled?: boolean;
    field?: boolean;
    onchange: (value: string) => void;
  } = $props();
  const id = $props.id();
  let root: HTMLDivElement;
  let trigger = $state<HTMLButtonElement>();
  let open = $state(false);
  let highlighted = $state(0);
  let search = '';
  let searchedAt = 0;
  const selected = $derived(options.find((option) => option.id === value) ?? options[0]);

  async function highlight(index: number) {
    highlighted = Math.max(0, Math.min(index, options.length - 1));
    await tick();
    const option = document.getElementById(`${id}-option-${highlighted}`);
    const list = document.getElementById(`${id}-list`);
    if (option && list) {
      const item = option.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
      else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
    }
  }

  $effect(() => {
    if (disabled) open = false;
  });

  function show() {
    if (disabled) return;
    open = true;
    // Safari does not focus buttons on a pointer click. Keep combobox keyboard
    // navigation and focus ownership consistent after opening with touch/mouse.
    trigger?.focus({ preventScroll: true });
    search = '';
    void highlight(options.findIndex((option) => option.id === value));
  }

  function choose(index: number) {
    if (!options[index]) return;
    onchange(options[index].id);
    open = false;
    trigger?.focus({ preventScroll: true });
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    } else if (event.key === 'Tab') {
      open = false;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(highlighted);
      else show();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasOpen = open;
      if (!open) show();
      if (event.key === 'Home') void highlight(0);
      else if (event.key === 'End') void highlight(options.length - 1);
      else if (wasOpen) void highlight(highlighted + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!open) show();
      search = (Date.now() - searchedAt < 700 ? search : '') + event.key.toLocaleLowerCase();
      searchedAt = Date.now();
      const index = options.findIndex((option) =>
        option.name.toLocaleLowerCase().startsWith(search),
      );
      if (index >= 0) void highlight(index);
    }
  }
</script>

<svelte:document
  onpointerdown={(event) => {
    if (open && !root.contains(event.target as Node)) open = false;
  }}
/>

<div class="agent-picker" class:field bind:this={root}>
  <button
    class="picker-trigger"
    class:expanded={open}
    type="button"
    role="combobox"
    aria-label={label}
    {title}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${id}-list`}
    aria-activedescendant={open ? `${id}-option-${highlighted}` : undefined}
    bind:this={trigger}
    onclick={() => (open ? (open = false) : show())}
    onkeydown={keyboard}
    onblur={() => (open = false)}
  >
    {#if icon}<span class="picker-icon" aria-hidden="true">{@render icon()}</span>{/if}
    <span class="selected-name">{selected?.name ?? value}</span>
    <ChevronDown size={15} aria-hidden="true" />
  </button>

  {#if open}
    <div class="picker-popover" popover="manual" use:anchorPopover={trigger!}>
      <div class="picker-heading" id={`${id}-label`}>Choose {label.toLowerCase()}</div>
      <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} class="picker-options">
        {#each options as option, index (option.id)}
          <button
            id={`${id}-option-${index}`}
            class="picker-option"
            class:highlighted={index === highlighted}
            type="button"
            role="option"
            aria-selected={option.id === value}
            aria-label={option.name}
            title={option.title}
            tabindex="-1"
            onpointermove={() => (highlighted = index)}
            onpointerdown={(event) => event.preventDefault()}
            onclick={() => choose(index)}
          >
            {#if option.mark}<span
                class="option-mark"
                style:--provider-color={option.color}
                aria-hidden="true">{option.mark}</span
              >{/if}
            <span class="option-copy">
              <span class="option-name">{option.name}</span>
              {#if option.detail}<span class="option-detail">{option.detail}</span>{/if}
            </span>
            <span class="option-check" aria-hidden="true">
              {#if option.id === value}<Check size={15} strokeWidth={2} />{/if}
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .agent-picker {
    position: relative;
    min-width: 0;
  }
  .picker-trigger {
    max-width: 220px;
    padding: 8px 10px;
    gap: 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
  }
  .picker-trigger:hover,
  .picker-trigger.expanded {
    background: #252c22;
    border-color: #3d4b32;
  }
  .field .picker-trigger {
    width: 100%;
    max-width: none;
    min-height: 41px;
    justify-content: space-between;
    padding: 10px 12px;
    background: #141a12;
    border-color: #34412a;
  }
  .picker-trigger.expanded {
    color: var(--green);
  }
  .selected-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--muted);
  }
  .picker-icon + .selected-name {
    flex: 1;
    text-align: left;
  }
  .picker-popover {
    position: fixed;
    z-index: 30;
    inset: auto;
    margin: 0;
    color: var(--text);
    overflow: hidden;
    padding: 6px;
    border: 1px solid #3a4433;
    border-radius: 12px;
    background: #1b2119;
    box-shadow:
      0 16px 40px #0006,
      0 2px 8px #0004;
  }
  .picker-popover:popover-open {
    display: flex;
    flex-direction: column;
  }
  .picker-heading {
    flex-shrink: 0;
    padding: 9px 10px 11px;
    color: #99a58c;
    font-size: 9px;
    letter-spacing: 1.3px;
    text-transform: uppercase;
  }
  .picker-options {
    min-height: 0;
    max-height: 360px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .picker-option {
    width: 100%;
    padding: 10px;
    gap: 11px;
    border: 1px solid transparent;
    border-radius: 7px;
    text-align: left;
    justify-content: flex-start;
  }
  .picker-option[aria-selected='true'] {
    color: var(--green);
    background: #283420;
  }
  .picker-option.highlighted {
    background: #303c28;
    border-color: #4b5e3a;
  }
  .option-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    color: var(--provider-color);
    background: color-mix(in srgb, var(--provider-color) 9%, transparent);
    font-size: 23px;
    line-height: 1;
  }
  .option-copy {
    display: grid;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }
  .option-name {
    font-size: 12px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .option-detail {
    color: #9da892;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .option-check {
    display: flex;
    width: 15px;
    flex-shrink: 0;
    color: var(--green);
  }
  @media (max-width: 650px) {
    .picker-option {
      min-height: 48px;
    }
    .option-name {
      font-size: 14px;
    }
  }
</style>
