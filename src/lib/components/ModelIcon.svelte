<script lang="ts">
  import type { ModelLine } from '$lib/model-marks';
  // Each model line's small abstract print, composed of flat shapes on a 64-unit canvas in the
  // line's palette (--art-<line>-0 is the ground). Shapes use no ids, so a page can hold any
  // number of copies.
  let { line }: { line: ModelLine } = $props();
  const palette = $derived(
    [0, 1, 2, 3, 4].map((shade) => `--k${shade}: var(--art-${line}-${shade})`).join('; '),
  );
  // Mythos's sun: twelve short rays around its disc.
  const rays = Array.from({ length: 12 }, (_, index) => {
    const angle = (index * Math.PI) / 6;
    const at = (radius: number) => [32 + Math.sin(angle) * radius, 32 - Math.cos(angle) * radius];
    return [...at(21), ...at(28)].map((value) => Number(value.toFixed(2)));
  });
</script>

<svg viewBox="0 0 64 64" aria-hidden="true" data-line={line} style={palette}>
  <rect class="k0" width="64" height="64" />
  {#if line === 'opus'}
    <!-- Arches rising under a pale sun. -->
    <circle class="k4" cx="47" cy="17" r="7" />
    <circle class="k1" cx="29" cy="66" r="31" />
    <circle class="k2" cx="29" cy="66" r="22" />
    <circle class="k3" cx="29" cy="66" r="13" />
  {:else if line === 'sonnet'}
    <!-- Three lines of verse, flowing. -->
    <path class="l1" stroke-width="8.5" d="M-6 22C10 8 24 34 40 20S62 6 72 14" />
    <path class="l2" stroke-width="8.5" d="M-6 38C10 24 24 50 40 36S62 22 72 30" />
    <path class="l3" stroke-width="8.5" d="M-6 54C10 40 24 66 40 52S62 38 72 46" />
  {:else if line === 'fable'}
    <!-- Two characters meeting, and where they overlap. -->
    <circle class="k1" cx="24" cy="38" r="18" />
    <circle class="k2" cx="42" cy="25" r="15" />
    <path class="k3" d="M27.73 20.39A18 18 0 0 1 41.89 40A15 15 0 0 1 27.73 20.39z" />
    <circle class="k4" cx="50" cy="51" r="4" />
  {:else if line === 'haiku'}
    <!-- A sun setting over a quiet horizon, and one brushstroke. -->
    <circle class="k1" cx="39" cy="35" r="12" />
    <rect class="k2" y="38" width="64" height="4" />
    <rect class="k3" y="44" width="64" height="20" />
    <rect class="k3" x="8" y="16" width="12" height="2" rx="1" opacity="0.55" />
  {:else if line === 'mythos'}
    <!-- A radiant sun disc with an eye at its heart. -->
    {#each rays as [x1, y1, x2, y2] (`${x1},${y1}`)}
      <line class="l1" stroke-width="2.4" {x1} {y1} {x2} {y2} />
    {/each}
    <circle class="k1" cx="32" cy="32" r="17" />
    <circle class="k2" cx="32" cy="32" r="11" />
    <circle class="k3" cx="32" cy="32" r="5" />
  {:else if line === 'astra'}
    <!-- A star cut from the night by four quarter circles. -->
    <circle class="k1" r="29" />
    <circle class="k1" cx="64" r="29" />
    <circle class="k1" cy="64" r="29" />
    <circle class="k1" cx="64" cy="64" r="29" />
    <circle class="k2" cx="32" cy="32" r="3.5" />
    <circle class="k3" cx="53" cy="11" r="2.6" />
    <circle class="k2" cx="10" cy="54" r="1.8" />
  {:else if line === 'sol'}
    <!-- A striped sun going down. -->
    <path class="k1" d="M12 36a20 20 0 0 1 40 0z" />
    <path class="k2" d="M12 36a20 20 0 0 0 40 0z" />
    <rect class="k0" y="39" width="64" height="2.2" />
    <rect class="k0" y="44" width="64" height="2.8" />
    <rect class="k0" y="49.5" width="64" height="3.4" />
    <rect class="k3" y="55" width="64" height="9" />
  {:else if line === 'luna'}
    <!-- A crescent in its halo. -->
    <circle class="l1" stroke-width="1.5" cx="32" cy="32" r="25" />
    <circle class="k2" cx="30" cy="34" r="17" />
    <circle class="k0" cx="39" cy="27" r="15" />
    <circle class="k3" cx="50" cy="13" r="1.8" />
    <circle class="k2" cx="13" cy="17" r="1.2" />
  {:else if line === 'terra'}
    <!-- Layered hills under a clay sun. -->
    <circle class="k1" cx="46" cy="19" r="8" />
    <circle class="k2" cx="14" cy="70" r="32" />
    <circle class="k3" cx="54" cy="76" r="31" />
    <circle class="k4" cx="26" cy="88" r="28" />
  {:else if line === 'gpt'}
    <!-- Four tiles, each turning a quarter circle its own way. -->
    <path class="k1" d="M32 32H0A32 32 0 0 1 32 0z" />
    <path class="k2" d="M32 0H64A32 32 0 0 1 32 32z" />
    <path class="k3" d="M0 64V32A32 32 0 0 1 32 64z" />
    <path class="k1" d="M64 64H32A32 32 0 0 1 64 32z" />
    <circle class="k2" cx="48" cy="48" r="6" />
  {:else if line === 'flash'}
    <!-- The canvas split by a zigzag. -->
    <polygon class="k1" points="64,0 44,0 30,28 42,28 20,64 64,64" />
    <polygon class="k2" points="44,0 38,0 24,28 36,28 14,64 20,64 42,28 30,28" />
  {:else if line === 'pro'}
    <!-- A faceted prism seen from above. -->
    <polygon class="k1" points="32,32 32,6 58,32" />
    <polygon class="k2" points="32,32 32,6 6,32" />
    <polygon class="k3" points="32,32 6,32 32,58" />
    <polygon class="k4" points="32,32 58,32 32,58" />
  {:else}
    <!-- Gemini's twins, bright where they overlap. -->
    <circle class="k1" cx="24" cy="32" r="15" />
    <circle class="k2" cx="40" cy="32" r="15" />
    <path class="k3" d="M32 19.31A15 15 0 0 1 32 44.69A15 15 0 0 1 32 19.31z" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .k0 {
    fill: var(--k0);
  }
  .k1 {
    fill: var(--k1);
  }
  .k2 {
    fill: var(--k2);
  }
  .k3 {
    fill: var(--k3);
  }
  .k4 {
    fill: var(--k4);
  }
  .l1,
  .l2,
  .l3 {
    fill: none;
    stroke-linecap: round;
  }
  .l1 {
    stroke: var(--k1);
  }
  .l2 {
    stroke: var(--k2);
  }
  .l3 {
    stroke: var(--k3);
  }
</style>
