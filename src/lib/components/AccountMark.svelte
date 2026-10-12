<script lang="ts">
  // An account's mark: its agent's glyph on the account's own color, so accounts with similar
  // names differ at a glance. A tile in each Agent picker choice, a chip on the Agent trigger and
  // a large tile on a new chat's welcome.
  let {
    glyph,
    color,
    size = 'tile',
  }: { glyph: string; color: string; size?: 'chip' | 'tile' | 'large' } = $props();
</script>

<span class="account-mark {size}" style:--account-color={color} aria-hidden="true">{glyph}</span>

<style>
  .account-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: var(--mark-size);
    height: var(--mark-size);
    background: var(--account-color);
    color: var(--text-inverse);
    font-family: system-ui, sans-serif;
    line-height: 1;
  }
  .chip {
    --mark-size: 20px;
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .tile {
    --mark-size: 28px;
    border-radius: var(--radius-md);
    font-size: 16px;
  }
  .large {
    --mark-size: 52px;
    border-radius: var(--radius-xl);
    font-size: 30px;
    box-shadow:
      0 0 0 6px color-mix(in srgb, var(--account-color) 14%, transparent),
      var(--shadow-md);
  }
</style>
