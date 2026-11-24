<script lang="ts">
  import { formatReplyTime } from '$lib/replies';
  import { makeupText, timeShare, type Makeup } from '$lib/time-report';
  let {
    makeup,
    scale = 1,
    tall = false,
  }: {
    /** What a stretch of time was made of, by who spent it. */
    makeup: Makeup;
    /** How much of the track the whole takes: a row's share beside the longest row's. */
    scale?: number;
    tall?: boolean;
  } = $props();
</script>

<!-- A bar in as many parts as the time had, each as long as its share. -->
<span
  class="makeup"
  class:tall
  role="img"
  aria-label={makeupText(makeup) || 'Not recorded'}
  style:--scale={scale}
>
  <span class="parts">
    {#each makeup as part (part.family)}
      <span
        data-family={part.family}
        style:flex-grow={part.ms}
        title={`${part.name} · ${formatReplyTime(part.ms)} · ${timeShare(part.share)}`}
      ></span>
    {/each}
  </span>
</span>

<style>
  .makeup {
    display: block;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--meter-track);
    overflow: hidden;
  }
  .makeup.tall {
    height: 12px;
  }
  .parts {
    display: flex;
    gap: 2px;
    width: calc(var(--scale) * 100%);
    min-width: 3px;
    height: 100%;
  }
  .parts > span {
    flex-basis: 0;
    min-width: 2px;
    border-radius: 2px;
    background: var(--time-overhead);
  }
  .parts > span:first-child {
    border-start-start-radius: var(--radius-full);
    border-end-start-radius: var(--radius-full);
  }
  .parts > span:last-child {
    border-start-end-radius: var(--radius-full);
    border-end-end-radius: var(--radius-full);
  }
  .parts > [data-family='model'] {
    background: var(--time-model);
  }
  .parts > [data-family='work'] {
    background: var(--time-work);
  }
  .parts > [data-family='hold'] {
    background: var(--time-hold);
  }
  .parts > [data-family='unknown'] {
    background: var(--time-unknown);
  }
  /* A bar grows from its start when it first shows. */
  @media (prefers-reduced-motion: no-preference) {
    .parts {
      transform-origin: left center;
      animation: grow var(--duration-slow) var(--ease-out) both;
    }
    @keyframes grow {
      from {
        transform: scaleX(0);
      }
    }
  }
</style>
