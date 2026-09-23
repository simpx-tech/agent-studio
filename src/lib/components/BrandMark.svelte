<script lang="ts">
  // The Agent A mark: its frame follows the text color and the agent uses the accent.
  // App icons are generated from the same geometry by scripts/brand-icons.mjs.
  let { size = 18 }: { size?: number } = $props();
</script>

<svg class="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
  <path class="frame" d="M12 56 L32 25 L52 56" />
  <circle class="agent" cx="32" cy="10.5" r="7" />
  <path class="bar" d="M23.5 45 H40.5" />
</svg>

<style>
  .brand-mark {
    flex-shrink: 0;
    overflow: visible;
  }
  .frame,
  .bar {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .frame {
    stroke: currentColor;
    stroke-width: 8.5;
  }
  .agent {
    fill: var(--accent-strong);
  }
  .bar {
    stroke: var(--accent-strong);
    stroke-width: 5.5;
  }
</style>
