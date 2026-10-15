<script module lang="ts">
  // Each stop gets room for its name, and the slider adds the popover's padding and border, its
  // own side padding and the thumb.
  const spacing = 48;
  const frame = 70;
  /** How wide a popover gives `count` stops room for their names. */
  export const sliderWidth = (count: number) =>
    Math.max(288, frame + Math.max(0, count - 1) * spacing);
</script>

<script lang="ts">
  type Option = { id: string; name: string };

  let {
    options,
    value,
    label,
    onchange,
    onclose,
    onblur,
  }: {
    /** The choices in order, one stop each. */
    options: Option[];
    value: string;
    label: string;
    onchange: (value: string) => void;
    /** Escape or Enter asks to close the slider. */
    onclose?: () => void;
    onblur?: (event: FocusEvent) => void;
  } = $props();
  // The thumb's width: a stop lies where the thumb's center rests on it.
  const thumb = 16;
  let input = $state<HTMLInputElement>();
  let track = $state<HTMLElement>();
  // While a pointer drags the thumb, it follows the pointer between stops.
  let dragging = $state(false);
  let dragAt = $state(0);
  let pointer: number | undefined;
  let pressedAt = 0;
  const index = $derived(
    Math.max(
      0,
      options.findIndex((option) => option.id === value),
    ),
  );
  const stops = $derived(Math.max(1, options.length - 1));
  const progress = $derived(dragging ? dragAt : options.length > 1 ? index / stops : 0);

  export function focus() {
    input?.focus({ preventScroll: true });
  }

  function choose(at: number) {
    const option = options[at];
    if (option && option.id !== value) onchange(option.id);
  }
  // Where along the stops a point lies, from 0 at the first to 1 at the last.
  function along(x: number) {
    if (!track) return 0;
    const box = track.getBoundingClientRect();
    const travel = box.width - thumb;
    return travel > 0 ? Math.min(1, Math.max(0, (x - box.left - thumb / 2) / travel)) : 0;
  }

  function press(event: PointerEvent) {
    if (event.button !== 0 || options.length < 2) return;
    // Focus stays on the slider, whose keys go on working.
    event.preventDefault();
    focus();
    pointer = event.pointerId;
    pressedAt = event.clientX;
    try {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks still chooses where it pressed.
    }
    const name = (event.target as Element).closest<HTMLElement>('[data-stop]');
    choose(name ? Number(name.dataset.stop) : Math.round(along(event.clientX) * stops));
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    if (!dragging && Math.abs(event.clientX - pressedAt) < 3) return;
    dragging = true;
    dragAt = along(event.clientX);
    choose(Math.round(dragAt * stops));
  }
  // The thumb settles on the stop nearest to where it was let go.
  function release(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    pointer = undefined;
    dragging = false;
  }

  function keys(event: KeyboardEvent) {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    onclose?.();
  }

  // Setting the value before a larger maximum clamps it, so it is put right once both are set.
  $effect(() => {
    const at = String(index);
    if (input && input.value !== at) input.value = at;
  });
</script>

<div
  class="choice-slider"
  class:dragging
  style:--thumb={`${thumb}px`}
  style:--stops={stops}
  style:--progress={progress}
>
  <div
    class="slider-area"
    role="presentation"
    onpointerdown={press}
    onpointermove={move}
    onpointerup={release}
    onpointercancel={release}
    onlostpointercapture={release}
  >
    <div class="slider-track" bind:this={track}>
      <span class="slider-line" aria-hidden="true"><span class="slider-fill"></span></span>
      {#each options as option, i (option.id)}<span
          class="slider-stop"
          class:reached={i <= index}
          style:--stop={i}
          aria-hidden="true"
        ></span>{/each}
      <span class="slider-runner" aria-hidden="true"><span class="slider-thumb"></span></span>
      <input
        bind:this={input}
        type="range"
        min="0"
        max={options.length - 1}
        step="1"
        value={index}
        aria-label={label}
        aria-valuetext={options[index]?.name}
        oninput={(event) => choose(event.currentTarget.valueAsNumber)}
        onkeydown={keys}
        {onblur}
      />
    </div>
    <div class="slider-names" aria-hidden="true">
      {#each options as option, i (option.id)}<span
          data-stop={i}
          class:chosen={i === index}
          style:--stop={i}>{option.name}</span
        >{/each}
    </div>
  </div>
</div>

<style>
  .choice-slider {
    --track-height: 24px;
    padding: 6px 20px 10px;
    user-select: none;
    -webkit-user-select: none;
  }
  .slider-area {
    cursor: pointer;
    /* The slider takes a sideways drag; nothing scrolls under it. */
    touch-action: none;
  }
  .slider-track {
    position: relative;
    height: var(--track-height);
  }
  .slider-line {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2);
    right: calc(var(--thumb) / 2);
    height: 4px;
    margin-top: -2px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--border-strong);
  }
  /* The fill and the thumb glide to the chosen stop and follow a drag at once. */
  .slider-fill {
    position: absolute;
    inset: 0;
    background: var(--accent-strong);
    transform: scaleX(var(--progress));
    transform-origin: left center;
    transition: transform var(--duration-slow) var(--ease-out);
  }
  .slider-stop {
    position: absolute;
    top: 50%;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--stop) / var(--stops));
    width: 6px;
    height: 6px;
    margin: -3px 0 0 -3px;
    border-radius: 50%;
    background: var(--border-hover);
    transition: background-color var(--duration-slow) ease;
  }
  .slider-stop.reached {
    background: var(--accent-strong);
  }
  /* As wide as the thumb travels, so moving it by its own width moves the thumb to the end. */
  .slider-runner {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: calc(100% - var(--thumb));
    transform: translateX(calc(var(--progress) * 100%));
    transition: transform var(--duration-slow) var(--ease-out);
    pointer-events: none;
  }
  .slider-thumb {
    position: absolute;
    top: 50%;
    left: 0;
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc(var(--thumb) / -2);
    border-radius: 50%;
    background: var(--accent-strong);
    box-shadow: 0 0 0 3px var(--surface-overlay);
    transition:
      scale var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) ease;
  }
  .slider-area:hover .slider-thumb {
    scale: 1.1;
  }
  .dragging .slider-fill,
  .dragging .slider-runner {
    transition: none;
  }
  .dragging .slider-thumb {
    scale: 1.2;
    box-shadow:
      0 0 0 3px var(--surface-overlay),
      0 0 0 7px var(--focus-glow);
  }
  .choice-slider:has(input:focus-visible) .slider-thumb {
    box-shadow:
      0 0 0 3px var(--surface-overlay),
      0 0 0 5px var(--focus-ring);
  }
  /* The input keeps the keys and what assistive technology reads; the page draws the rest. */
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    pointer-events: none;
  }
  .slider-names {
    position: relative;
    height: 18px;
    margin-top: 2px;
  }
  .slider-names > span {
    position: absolute;
    top: 0;
    left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--stop) / var(--stops));
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 18px;
    white-space: nowrap;
    translate: -50% 0;
    transition: color var(--duration-slow) ease;
  }
  .slider-names > .chosen {
    color: var(--text);
  }
  @media (max-width: 650px) {
    .choice-slider {
      --track-height: 40px;
    }
    .slider-names {
      height: 20px;
    }
    .slider-names > span {
      font-size: var(--text-sm);
      line-height: 20px;
    }
  }
</style>
