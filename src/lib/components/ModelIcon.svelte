<script lang="ts">
  import type { ModelLine } from '$lib/model-marks';
  // One illustration per model line, drawn on a 24-unit grid as line art with a soft wash of
  // its own color, so lines stay distinct at 14px beside their version number.
  let { line }: { line: ModelLine } = $props();
  const petals = [0, 72, 144, 216, 288];
</script>

<svg viewBox="0 0 24 24" aria-hidden="true" data-line={line}>
  {#if line === 'haiku'}
    <!-- A cherry blossom: a haiku's season in five petals. -->
    {#each petals as angle (angle)}
      <path
        class="wash"
        transform="rotate({angle} 12 12)"
        d="M12 12C9.9 10.4 9.2 7 10.6 4.1L12 5.4l1.4-1.3c1.4 2.9.7 6.3-1.4 7.9z"
      />
    {/each}
    <circle class="solid" cx="12" cy="12" r="1.3" />
  {:else if line === 'sonnet'}
    <!-- A quill, for verse written by hand. -->
    <path
      class="wash"
      d="M19.8 3.2c-5.8.6-10.6 4.8-12.2 11.4-.2.8-.2 1.6 0 2 .4.2 1.2.1 2-.2 6.4-1.8 10.3-7 10.2-13.2z"
    />
    <path d="M19.8 3.2C15.5 7.8 11.4 12.1 7.4 16.8L4.2 20.2" />
    <path d="M15.4 8.9l2.3.6M12.6 12l2.4.4" />
  {:else if line === 'opus'}
    <!-- Beamed notes: an opus is a composition. -->
    <path
      class="wash"
      d="M9 18.2a2.6 2 0 1 1-5.2 0 2.6 2 0 0 1 5.2 0zM20.2 16.2a2.6 2 0 1 1-5.2 0 2.6 2 0 0 1 5.2 0z"
    />
    <path d="M9 18.2V6.4l11.2-2.6v12.4M9 9.8l11.2-2.6" />
  {:else if line === 'fable'}
    <!-- The fox of Aesop's fables. -->
    <path
      class="wash"
      d="M4.2 4.6l5 4.2c1.8-.4 3.8-.4 5.6 0l5-4.2c.6 3.8.2 7-1.2 9.6-1.6 2.8-4 5-6.6 6.4-2.6-1.4-5-3.6-6.6-6.4-1.4-2.6-1.8-5.8-1.2-9.6z"
    />
    <path d="M5.6 13.1c2.4-.3 4.4.7 6.4 3.1 2-2.4 4-3.4 6.4-3.1" />
    <circle class="solid" cx="9.2" cy="11.3" r=".95" />
    <circle class="solid" cx="14.8" cy="11.3" r=".95" />
    <circle class="solid" cx="12" cy="18.7" r=".95" />
  {:else if line === 'mythos'}
    <!-- The all-seeing eye of myth. -->
    <path
      class="wash"
      d="M2.6 12c2.4-4.2 5.6-6.4 9.4-6.4s7 2.2 9.4 6.4c-2.4 4.2-5.6 6.4-9.4 6.4S5 16.2 2.6 12z"
    />
    <circle cx="12" cy="12" r="3" />
    <circle class="solid" cx="12" cy="12" r="1.2" />
    <path d="M12 2.4V4M5.4 4.6l.9 1.3M18.6 4.6l-.9 1.3" />
  {:else if line === 'astra'}
    <!-- A star and its sparks. -->
    <path
      class="wash"
      d="M12 3.2c.6 5.2 3.6 8.2 8.8 8.8-5.2.6-8.2 3.6-8.8 8.8-.6-5.2-3.6-8.2-8.8-8.8 5.2-.6 8.2-3.6 8.8-8.8z"
    />
    <path d="M18.8 3v3.4M17.1 4.7h3.4" />
    <circle class="solid" cx="5.2" cy="18.8" r=".9" />
  {:else if line === 'sol'}
    <!-- The sun. -->
    <circle class="wash" cx="12" cy="12" r="4.2" />
    <path
      d="M12 2.4v3.2M21.6 12h-3.2M12 21.6v-3.2M2.4 12h3.2M16.7 7.3l1.3-1.3M16.7 16.7l1.3 1.3M7.3 16.7L6 18M7.3 7.3L6 6"
    />
  {:else if line === 'luna'}
    <!-- The crescent moon and a star. -->
    <path class="wash" d="M20.2 14.6A8.6 8.6 0 1 1 9.4 3.8a6.8 6.8 0 0 0 10.8 10.8z" />
    <path class="solid" d="M17.4 4.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
  {:else if line === 'terra'}
    <!-- Mountains of the earth. -->
    <path class="wash" d="M2.6 19.4l6-10 3.8 5.8 3-4.2 6 8.4z" />
    <path d="M6.9 12.3l1.2-.8.8.9 1.3-.4" />
  {:else if line === 'gpt'}
    <!-- A crystal lattice for GPT models of no named line. -->
    <path class="wash" d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
    <path d="M12 7.4l4 2.3v4.6l-4 2.3-4-2.3V9.7z" />
  {:else if line === 'flash'}
    <!-- A lightning bolt. -->
    <path class="wash" d="M13.2 2.6L5.6 13.2h5.8l-.8 8.2 7.8-10.8h-5.8z" />
  {:else if line === 'pro'}
    <!-- A cut gem. -->
    <path class="wash" d="M7 4.2h10l4 5-9 11.4L3 9.2z" />
    <path d="M3 9.2h18M9.6 4.2L8.2 9.2 12 20.6l3.8-11.4-1.4-5" />
  {:else}
    <!-- Gemini's twin stars. -->
    <path
      class="wash"
      d="M9 7c.5 3.6 2.4 5.5 6 6-3.6.5-5.5 2.4-6 6-.5-3.6-2.4-5.5-6-6 3.6-.5 5.5-2.4 6-6z"
    />
    <path
      class="wash"
      d="M17 3.4c.3 2 1.2 2.9 3.2 3.2-2 .3-2.9 1.2-3.2 3.2-.3-2-1.2-2.9-3.2-3.2 2-.3 2.9-1.2 3.2-3.2z"
    />
  {/if}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .wash {
    fill: currentColor;
    fill-opacity: 0.2;
  }
  .solid {
    fill: currentColor;
    stroke: none;
  }
</style>
