<script lang="ts">
  // The Git logo drawn like the Lucide icons beside it: a rounded diamond holding the
  // branch that enters from its upper-left edge and splits down and to the right.
  import type { SVGAttributes } from 'svelte/elements';
  let {
    size = 24,
    class: className = '',
    ...rest
  }: { size?: number | string; class?: string } & SVGAttributes<SVGSVGElement> = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={['lucide', className]}
  {...rest}
>
  <path
    d="M10.59 2.59 2.59 10.59a2 2 0 0 0 0 2.82l8 8a2 2 0 0 0 2.82 0l8-8a2 2 0 0 0 0-2.82l-8-8a2 2 0 0 0-2.82 0Z"
  />
  <path d="M9.2 5.2 12 8v8.2M12 8l4 4" />
  <circle cx="12" cy="8" r="1.4" fill="currentColor" stroke="none" />
  <circle cx="12" cy="16.2" r="1.6" fill="currentColor" stroke="none" />
  <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none" />
</svg>
