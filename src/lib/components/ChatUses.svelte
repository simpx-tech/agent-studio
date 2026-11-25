<script lang="ts">
  import type { ModelMark } from '$lib/model-marks';
  import ModelIcon from './ModelIcon.svelte';
  // What a chat uses, at a glance at the start of its row in the sidebar: its model's print (or its
  // provider's glyph for a model of no known line) framed in its account's color. The row's
  // description names both (`label`, read through `id`), and so does hovering the mark. It adds
  // no text to the row, whose text stays its title: the glyph is drawn by CSS.
  let { id, mark, color, label }: { id: string; mark: ModelMark; color?: string; label: string } =
    $props();
</script>

<i
  class="chat-uses"
  class:accounted={!!color}
  {id}
  role="img"
  aria-label={label}
  aria-hidden="true"
  title={label}
  data-line={mark.line ?? 'none'}
  style:--provider-color={mark.color}
  style:--account-color={color}
  ><span class="art" data-glyph={mark.line ? undefined : mark.glyph}
    >{#if mark.line}<ModelIcon line={mark.line} />{/if}</span
  ></i
>

<style>
  /* A chat whose account is gone keeps the print in the same place, without a frame. */
  .chat-uses {
    display: grid;
    flex: none;
    place-items: center;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    padding: 3px;
    border-radius: 6px;
    font-style: normal;
    line-height: 1;
  }
  /* The account's color frames the print, a line of the sidebar's own surface between them, so
     a frame keeps its color beside a print of the same hue. */
  .accounted {
    background: var(--account-color);
  }
  .art {
    position: relative;
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 3px;
    background: color-mix(in srgb, var(--provider-color) 12%, transparent);
    color: color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text));
  }
  .accounted .art {
    outline: 1px solid var(--bg-sidebar);
  }
  .art[data-glyph]::before {
    content: attr(data-glyph);
    font-family: system-ui, sans-serif;
    font-size: 11px;
  }
  /* Its edge lies over the print, so a pale print keeps its shape on a light surface. */
  .art::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--provider-color) 24%, transparent);
    content: '';
  }
</style>
