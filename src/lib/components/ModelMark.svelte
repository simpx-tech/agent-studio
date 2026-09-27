<script lang="ts">
  import type { ModelMark } from '$lib/model-marks';
  import ModelIcon from './ModelIcon.svelte';
  // A chip in the toolbar, a pill in the Model picker, and a tile for a reply's avatar, where
  // the version sits beneath the icon. The version always stays readable.
  let { mark, variant }: { mark: ModelMark; variant: 'chip' | 'pill' | 'tile' } = $props();
</script>

<span
  class="model-mark {variant}"
  class:versioned={!!mark.version}
  data-line={mark.line ?? 'none'}
  style:--provider-color={mark.color}
  aria-hidden="true"
>
  <span class="icon"
    >{#if mark.line}<ModelIcon line={mark.line} />{:else}<span class="glyph">{mark.glyph}</span
      >{/if}</span
  >{#if mark.version}<span class="version">{mark.version}</span>{/if}
</span>

<style>
  .model-mark {
    --ink: color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text));
    flex-shrink: 0;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--provider-color) 22%, transparent);
    background: color-mix(in srgb, var(--provider-color) 11%, transparent);
    color: var(--ink);
    line-height: 1;
  }
  .icon {
    display: grid;
    place-items: center;
  }
  .glyph {
    font-size: 1em;
  }
  .version {
    font-family: var(--font-sans);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .chip,
  .pill {
    display: inline-flex;
    box-sizing: border-box;
  }
  .chip {
    height: 20px;
    padding: 0 6px 0 4px;
    gap: 4px;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
  }
  .chip .icon {
    width: 14px;
    height: 14px;
  }
  /* Pills share one width for the usual versions, so the names beside them line up. */
  .pill {
    height: 26px;
    min-width: 54px;
    padding: 0 7px 0 5px;
    gap: 5px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
  }
  .pill .version {
    flex: 1;
    text-align: center;
  }
  .pill:not(.versioned) {
    justify-content: center;
    padding: 0;
  }
  .pill .icon {
    width: 17px;
    height: 17px;
  }
  /* A tile as wide as a reply's avatar: the icon, with the version beneath it when known. */
  .tile {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    box-sizing: border-box;
    padding: 5px 0;
    border-radius: var(--radius-md);
    font-size: 16px;
  }
  .tile .icon {
    width: 17px;
    height: 17px;
  }
  .tile .version {
    font-size: var(--text-xs);
    white-space: nowrap;
  }
</style>
