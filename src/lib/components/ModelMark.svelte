<script lang="ts">
  import type { ModelMark } from '$lib/model-marks';
  import ModelIcon from './ModelIcon.svelte';
  // A model's print beside its version: a pill in the Model picker, and a tile on a reply's
  // avatar with the version beneath the print. The version always stays readable. The toolbar's
  // chip draws the print alone, since the model's name beside it already shows the version. A
  // model of no known line shows its provider's glyph in place of a print.
  let { mark, variant }: { mark: ModelMark; variant: 'chip' | 'pill' | 'tile' } = $props();
  const version = $derived(variant === 'chip' ? undefined : mark.version);
</script>

<span
  class="model-mark {variant}"
  class:versioned={!!version}
  data-line={mark.line ?? 'none'}
  style:--provider-color={mark.color}
  aria-hidden="true"
>
  <span class="art"
    >{#if mark.line}<ModelIcon line={mark.line} />{:else}<span class="glyph">{mark.glyph}</span
      >{/if}</span
  >{#if version}<span class="version">{version}</span>{/if}
</span>

<style>
  .model-mark {
    --tint: color-mix(in srgb, var(--provider-color) 12%, transparent);
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    box-sizing: border-box;
    overflow: hidden;
    background: var(--tint);
    color: color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text));
    line-height: 1;
  }
  /* The edge lies over the print, so a pale print keeps its shape on a light surface. */
  .model-mark::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--provider-color) 24%, transparent);
    content: '';
    pointer-events: none;
  }
  /* The print fills a square at the start of the mark; its corners follow the mark's. */
  .art {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    height: 100%;
    aspect-ratio: 1;
  }
  .version {
    font-family: var(--font-sans);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .chip {
    height: 20px;
    border-radius: var(--radius-sm);
  }
  .chip .glyph {
    font-size: 13px;
  }
  /* Pills share one width for the usual versions, so the names beside them line up. */
  .pill {
    height: 26px;
    min-width: 58px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .pill .version {
    flex: 1;
    padding: 0 6px;
    text-align: center;
  }
  .pill .glyph {
    font-size: 15px;
  }
  /* Without a version a pill keeps the same width. A print stays at its start, in line with the
     other prints, and a provider glyph moves to the middle. */
  .pill:not(.versioned)[data-line='none'] {
    justify-content: center;
  }
  .tile {
    flex: 1;
    flex-direction: column;
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
  }
  .tile .art {
    width: 100%;
    height: auto;
  }
  .tile .version {
    padding: 3px 0 4px;
  }
  .tile .glyph {
    font-size: 16px;
  }
</style>
