<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  type Option = { id: string; name: string };

  let {
    options,
    value,
    label,
    title,
    icon,
    disabled = false,
    onchange,
  }: {
    /** The choices in order, one stop each. */
    options: Option[];
    value: string;
    label: string;
    title?: string;
    icon?: Snippet;
    disabled?: boolean;
    onchange: (value: string) => void;
  } = $props();
  // The thumb's width: a stop lies where the thumb's center rests on it.
  const thumb = 12;
  let input = $state<HTMLInputElement>();
  const index = $derived(
    Math.max(
      0,
      options.findIndex((option) => option.id === value),
    ),
  );
  const stops = $derived(Math.max(1, options.length - 1));

  export function focus() {
    input?.focus();
  }

  async function choose(at: number) {
    const option = options[at];
    if (option && option.id !== value) onchange(option.id);
    // A value the page keeps puts the thumb back on it.
    await tick();
    if (input && input.value !== String(index)) input.value = String(index);
  }

  // A finger or pen chooses the stop it touches and follows a drag along the track: iOS moves
  // a range input only from its thumb. The mouse keeps the input's own handling.
  function touched(event: PointerEvent) {
    if (event.pointerType === 'mouse' || disabled || !input || options.length < 2) return;
    if (event.type === 'pointermove' && !event.buttons) return;
    const box = input.getBoundingClientRect();
    if (box.width <= thumb) return;
    const at = Math.round(((event.clientX - box.left - thumb / 2) / (box.width - thumb)) * stops);
    void choose(Math.max(0, Math.min(options.length - 1, at)));
  }

  // Setting the value before a larger maximum clamps it, so it is put right once both are set.
  $effect(() => {
    const at = String(index);
    if (input && input.value !== at) input.value = at;
  });
</script>

<div
  class="choice-slider"
  class:disabled
  title={title ?? label}
  style:--thumb={`${thumb}px`}
  style:--stops={stops}
  style:--at={index}
>
  {#if icon}<span class="slider-icon" aria-hidden="true">{@render icon()}</span>{/if}
  <span class="slider-track">
    <span class="slider-line" aria-hidden="true"></span>
    <span class="slider-fill" aria-hidden="true"></span>
    {#each options as option, i (option.id)}<span
        class="slider-stop"
        class:reached={i <= index}
        style:--stop={i}
        aria-hidden="true"
      ></span>{/each}
    <input
      bind:this={input}
      type="range"
      min="0"
      max={options.length - 1}
      step="1"
      value={index}
      aria-label={label}
      aria-valuetext={options[index]?.name}
      {disabled}
      oninput={(event) => void choose(event.currentTarget.valueAsNumber)}
      onpointerdown={touched}
      onpointermove={touched}
    />
  </span>
  <!-- Every name takes the same place, so the control keeps the width of the longest. -->
  <span class="slider-value" aria-hidden="true">
    {#each options as option, i (option.id)}<span class:shown={i === index}>{option.name}</span
      >{/each}
  </span>
</div>

<style>
  /* A page fits the control to its room through --slider-track, --slider-gap and
     --slider-padding. */
  .choice-slider {
    --slider-height: var(--control-md);
    display: flex;
    align-items: center;
    gap: var(--slider-gap, 7px);
    min-height: var(--control-md);
    padding: 0 var(--slider-padding, 9px);
    color: var(--text-secondary);
    font-size: var(--text-base);
    font-weight: 500;
    user-select: none;
    -webkit-user-select: none;
  }
  .choice-slider.disabled {
    opacity: 0.62;
  }
  .slider-icon {
    display: flex;
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .choice-slider:not(.disabled):hover .slider-icon,
  .choice-slider:has(input:focus-visible) .slider-icon {
    color: var(--text-secondary);
  }
  .choice-slider:not(.disabled):hover,
  .choice-slider:has(input:focus-visible) {
    color: var(--text);
  }
  .slider-track {
    position: relative;
    flex-shrink: 0;
    width: var(--slider-track, 80px);
    height: var(--slider-height);
  }
  .slider-line,
  .slider-fill {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2);
    height: 2px;
    border-radius: 1px;
    translate: 0 -50%;
  }
  .slider-line {
    right: calc(var(--thumb) / 2);
    background: var(--border-strong);
  }
  .slider-fill {
    width: calc((100% - var(--thumb)) * var(--at) / var(--stops));
    background: var(--text-muted);
  }
  .slider-stop {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--stop) / var(--stops));
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-faint);
    translate: -50% -50%;
  }
  .slider-stop.reached {
    background: var(--text-muted);
  }
  input {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
    /* A sideways drag moves the slider rather than the toolbar it scrolls in. */
    touch-action: pan-y;
  }
  input:disabled {
    cursor: not-allowed;
  }
  input:focus-visible {
    outline: none;
  }
  input::-webkit-slider-runnable-track {
    height: var(--slider-height);
    border: 0;
    background: transparent;
  }
  input::-moz-range-track {
    height: var(--slider-height);
    border: 0;
    background: transparent;
  }
  input::-webkit-slider-thumb {
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc((var(--slider-height) - var(--thumb)) / 2);
    border: 0;
    border-radius: 50%;
    background: var(--text-secondary);
    box-shadow: 0 0 0 2px var(--bg);
    appearance: none;
    -webkit-appearance: none;
    transition:
      background-color var(--duration-fast) ease,
      box-shadow var(--duration-fast) ease;
  }
  input::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border: 0;
    border-radius: 50%;
    background: var(--text-secondary);
    box-shadow: 0 0 0 2px var(--bg);
    transition:
      background-color var(--duration-fast) ease,
      box-shadow var(--duration-fast) ease;
  }
  .choice-slider:not(.disabled):hover input::-webkit-slider-thumb,
  input:active::-webkit-slider-thumb {
    background: var(--text);
  }
  .choice-slider:not(.disabled):hover input::-moz-range-thumb,
  input:active::-moz-range-thumb {
    background: var(--text);
  }
  input:focus-visible::-webkit-slider-thumb {
    background: var(--text);
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  input:focus-visible::-moz-range-thumb {
    background: var(--text);
    box-shadow:
      0 0 0 2px var(--bg),
      0 0 0 4px var(--focus-ring);
  }
  .slider-value {
    display: grid;
    flex-shrink: 0;
  }
  .slider-value > span {
    grid-area: 1 / 1;
    visibility: hidden;
    white-space: nowrap;
  }
  .slider-value > .shown {
    visibility: visible;
  }
  @media (max-width: 650px) {
    .choice-slider {
      --slider-height: 44px;
      --slider-track: 96px;
      min-height: 44px;
    }
  }
</style>
