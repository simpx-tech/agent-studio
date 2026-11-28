<script lang="ts">
  import { CircleCheck, Gauge, Hourglass, TriangleAlert } from '@lucide/svelte';
  import { toolElapsed } from '$lib/activity';
  import { clock } from '$lib/clock';
  import { pcTurnNote, type PcHold } from '$lib/pc-reservations';
  import { formatBytes } from '$lib/tool-output';
  let {
    hold,
    self,
    title,
    opens,
    open,
    openReservations,
  }: {
    hold: PcHold;
    /** The chat whose reply shows the card, which it names as this chat. */
    self?: string;
    /** A chat's title, or a repository's merge train where its id stands for a chat's. */
    title: (conversationId: string) => string;
    /** Whether a chat can be opened from here. */
    opens?: (conversationId: string) => boolean;
    open?: (conversationId: string) => void;
    /** Opens the Reservations window. */
    openReservations?: () => void;
  } = $props();
  const since = (at?: number) => (at == null ? '' : toolElapsed(Math.max(0, clock.now - at)));
  const time = (at: number) =>
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = (id: string) => (id === self ? 'This chat' : title(id));
  // A label names a call by its description, then its command in backticks.
  const parts = (label: string) =>
    label.split('`').map((text, index) => ({ text, code: index % 2 === 1 }));
  const plain = (label: string) => label.replace(/`/g, '');
  // Where the measurement it waits for stands, which time moves on.
  const measured = $derived.by(() => {
    const measure = hold.measure;
    if (!measure) return '';
    if (measure.phase === 'open')
      return `Measuring for ${since(measure.openedAt)}${measure.minutes ? ` of about ${Math.round(measure.minutes)} min` : ''}`;
    if (hold.kind === 'window') {
      if (measure.phase === 'lull')
        return measure.holdsAt != null
          ? `Other chats work on until then, or until ${time(measure.holdsAt)}`
          : 'Other chats work on until then';
      return measure.scope === 'gpu'
        ? "Other chats' games, editors and browser tests wait until it has measured"
        : "Other chats' new work waits until it has measured";
    }
    if (measure.phase === 'lull')
      return measure.holdsAt != null
        ? `Not measuring yet: it waits for a lull, until ${time(measure.holdsAt)} at most`
        : 'Not measuring yet: it waits for a lull';
    // The work its measurement waits for, listed below, says it.
    return hold.work.length ? '' : 'Not measuring yet';
  });
  const note = $derived(hold.turn ? pcTurnNote(hold.turn, clock.now) : undefined);
  const stalled = $derived(
    !!hold.turn && hold.turn.stalledAt != null && hold.turn.keptUntil == null,
  );
</script>

{#snippet label(text: string)}
  {#each parts(text) as part, index (index)}{#if part.code}<code>{part.text}</code
      >{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet chat(id: string)}
  {#if open && id !== self && opens?.(id) !== false}<button
      type="button"
      class="pc-chat"
      title={`Open ${name(id)}`}
      onclick={() => open?.(id)}>{name(id)}</button
    >{:else}<strong class="pc-chat-name">{name(id)}</strong>{/if}
{/snippet}

<!-- What the reply waits for on this computer, where its wait shows (requested 2026-11-28):
     why it waits, on whose work, and what it runs once the wait ends. -->
<div
  class="pc-hold"
  class:ready={hold.ready}
  data-kind={hold.kind}
  role="group"
  aria-label={hold.heading}
>
  <div class="pc-hold-head">
    {#if hold.ready}<CircleCheck size={17} aria-hidden="true" />{:else}<Hourglass
        size={17}
        aria-hidden="true"
      />{/if}
    <strong>{hold.heading}</strong>
    {#if hold.since != null}<span
        class="pc-hold-time"
        aria-label={`Waiting for ${since(hold.since)}`}>{since(hold.since)}</span
      >{/if}
  </div>
  {#if hold.holder}
    <p class="pc-holder">
      {@render chat(hold.holder.conversationId)}{' '}{hold.holder
        .does}{#if hold.holder.purpose}:{' '}<span class="pc-purpose">{hold.holder.purpose}</span
        >{/if}
    </p>
  {/if}
  {#if note}<p class="pc-note" class:stalled>
      {#if stalled}<TriangleAlert size={13} aria-hidden="true" />{/if}{note
        .charAt(0)
        .toUpperCase() + note.slice(1)}
    </p>{/if}
  {#if measured}<p class="pc-status">{measured}</p>{/if}
  {#if hold.reason}<p class="pc-status">{hold.reason}</p>{/if}
  {#if hold.work.length}
    <div class="pc-work">
      {#if hold.workHeading}<span class="pc-label">{hold.workHeading}</span>{/if}
      <ul>
        {#each hold.work as item, index (index)}
          <li>
            {#if item.conversationId}<span class="pc-who">{@render chat(item.conversationId)}</span
              >{/if}
            <span class="pc-what" title={item.handOver ? undefined : plain(item.label)}
              >{#if item.handOver}Asked to hand over what it holds{:else}{@render label(
                  item.label,
                )}{/if}</span
            >
            {#if item.bytes}<span class="pc-meta">{formatBytes(item.bytes)}</span>{/if}
            {#if item.since != null}<span class="pc-meta">{since(item.since)}</span>{/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if hold.facts.length}
    <dl class="pc-facts">
      {#each hold.facts as fact (fact.label)}
        <div class:wide={fact.wide}>
          <dt>{fact.label}</dt>
          <dd title={plain(fact.value)}>{@render label(fact.value)}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  {#if openReservations}
    <div class="pc-actions">
      <button type="button" class="text-button" onclick={openReservations}
        ><Gauge size={13} aria-hidden="true" />Reservations</button
      >
    </div>
  {/if}
</div>

<style>
  /* A full card in the warning colour where the reply's wait shows, at the end of its live
     work, so a reader following the chat sees it (requested 2026-11-28). */
  .pc-hold {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin: 2px 0 4px;
    padding: 12px 14px 12px 13px;
    border: 1px solid var(--warning-border);
    border-left: 4px solid var(--warning);
    border-radius: var(--radius-lg);
    background: var(--warning-soft);
    color: var(--text);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .pc-hold.ready {
    border-color: var(--accent-border);
    border-left-color: var(--accent-strong);
    background: var(--accent-soft);
  }
  .pc-hold-head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .pc-hold-head > :global(svg) {
    flex: none;
    color: var(--warning);
  }
  .ready .pc-hold-head > :global(svg) {
    color: var(--accent-strong);
  }
  .pc-hold-head strong {
    min-width: 0;
    font-size: var(--text-md);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .pc-hold-time {
    flex: none;
    margin-left: auto;
    color: var(--warning);
    font-size: var(--text-md);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .ready .pc-hold-time {
    color: var(--accent-text);
  }
  p {
    margin: 0;
  }
  .pc-holder {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .pc-purpose {
    color: var(--text);
  }
  .pc-chat,
  .pc-chat-name {
    color: var(--text);
    font-weight: 600;
  }
  .pc-chat {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-weight: 600;
    text-align: start;
    text-decoration: underline;
    text-decoration-color: var(--warning-border);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .pc-chat:hover {
    text-decoration-color: currentColor;
  }
  .pc-status,
  .pc-note {
    color: var(--text-secondary);
  }
  .pc-note {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .pc-note.stalled {
    color: var(--warning);
    font-weight: 600;
  }
  .pc-label,
  .pc-facts dt {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .pc-work {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .pc-work ul {
    display: grid;
    gap: 3px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pc-work li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 5px 9px;
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }
  .pc-who {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pc-what {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pc-meta {
    flex: none;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .pc-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 6px 16px;
    margin: 0;
  }
  .pc-facts div {
    min-width: 0;
  }
  .pc-facts dd {
    margin: 1px 0 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* What the chat waits to run, or measures, takes a row of its own and shows whole. */
  .pc-facts .wide {
    grid-column: 1 / -1;
  }
  .pc-facts .wide dd {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .pc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .pc-actions .text-button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  @media (max-width: 650px) {
    /* A row's chat goes above what it runs. */
    .pc-work li {
      flex-wrap: wrap;
      row-gap: 2px;
    }
    .pc-who {
      max-width: 100%;
    }
    .pc-what {
      flex-basis: 100%;
      order: 3;
    }
  }
</style>
