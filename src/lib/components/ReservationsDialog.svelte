<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ChevronLeft,
    ChevronRight,
    CircleCheck,
    CircleStop,
    Cpu,
    Gauge,
    GitMerge,
    Hammer,
    Handshake,
    Snowflake,
    History,
    Hourglass,
    MessageSquare,
    TriangleAlert,
    Users,
    X,
  } from '@lucide/svelte';
  import { dayLabel } from '$lib/app-sessions';
  import { clock } from '$lib/clock';
  import { closeOnBackdrop } from '$lib/dialog-backdrop';
  import {
    pcBesideText,
    pcEndedBy,
    pcHandingOver,
    pcOutcome,
    pcOwner,
    pcTotals,
    pcTurnEnd,
    pcTurnGroups,
    pcTurnNote,
    pcWaited,
    type PcRecord,
    type PcReservation,
    type PcSlot,
    type PcTurn,
    type PcTurnRecord,
  } from '$lib/pc-reservations';
  import { formatReplyTime } from '$lib/replies';
  import { formatBytes } from '$lib/tool-output';
  import { readPcHistory } from '$lib/transport';
  import TimeMakeup from './TimeMakeup.svelte';
  let {
    reservations,
    turns = [],
    slots = [],
    title,
    opens,
    open,
    close,
  }: {
    /** This computer's reservations now, the one holding it first. */
    reservations: PcReservation[];
    /** Named reservations now, each name's holder first. */
    turns?: PcTurn[];
    /** Chats' builds waiting for a slot, first in line first. */
    slots?: PcSlot[];
    /** A chat's title. */
    title: (conversationId: string) => string;
    /** Whether a chat can be opened from here. */
    opens: (conversationId: string) => boolean;
    open: (conversationId: string) => void;
    close: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let closeButton: HTMLButtonElement;

  let records = $state<PcRecord[]>([]);
  let turnRecords = $state<PcTurnRecord[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let now = $state(Date.now());
  async function load() {
    try {
      const history = await readPcHistory();
      records = history.reservations;
      turnRecords = history.turns;
      failed = false;
    } catch {
      failed = true;
    }
    now = Date.now();
    loaded = true;
  }
  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    closeButton.focus();
    // Its backdrop closes it as Escape and its close button do, so the page can open it again.
    const release = closeOnBackdrop(dialog, () => close());
    void load();
    return () => {
      release();
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  });
  // A reservation or a turn that ends joins the history.
  const live = $derived(
    [...reservations.map((r) => `${r.askedAt}:${r.id}`), ...turns.map((t) => t.id)].join(' '),
  );
  const groups = $derived(pcTurnGroups(turns));
  let seen = '';
  $effect(() => {
    const ids = live;
    if (seen && ids !== seen) void load();
    seen = ids;
  });

  // Reservation ids start again with the app, so a record is known by when it began too.
  const key = (record: PcRecord) => `${record.askedAt}:${record.id}`;
  let selected = $state<string>();
  const position = $derived(selected ? records.findIndex((r) => key(r) === selected) : -1);
  const record = $derived(position >= 0 ? records[position] : undefined);
  const totals = $derived(pcTotals(records));
  const spent = (item: PcRecord) => pcWaited(item) + (item.windowMs ?? 0);
  const longest = (values: number[]) => Math.max(1, ...values);
  const makeup = (item: PcRecord) => {
    const whole = Math.max(1, spent(item));
    return [
      { family: 'hold' as const, name: 'Waited to start', ms: pcWaited(item) },
      { family: 'work' as const, name: 'Measuring', ms: item.windowMs ?? 0 },
    ]
      .filter((part) => part.ms > 0)
      .map((part) => ({ ...part, share: part.ms / whole }));
  };
  const when = (ms: number) =>
    `${dayLabel(ms, now)} ${new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const percent = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  // A label names a call by its description and its command in backticks.
  const parts = (label: string) =>
    label.split('`').map((text, index) => ({ text, code: index % 2 === 1 }));
  const phase = (reservation: PcReservation) =>
    reservation.phase === 'open'
      ? 'Measuring'
      : reservation.phase === 'draining'
        ? 'Holding'
        : reservation.phase === 'lull'
          ? 'Waiting for a lull'
          : 'In line';
  const turnName = (turn: { name: string; landing: boolean }) =>
    turn.landing ? turn.name.replace(/^the landing of /, 'Landing of ') : turn.name;
  const since = (reservation: PcReservation) =>
    formatReplyTime(Math.max(0, clock.now - (reservation.openedAt ?? reservation.askedAt)));
  const askText = (ask: PcRecord['asks'][number]) =>
    ask.ended === 'handed over'
      ? `Handed over after ${formatReplyTime(ask.endedMs ?? 0)}`
      : ask.ended === 'reply ended'
        ? `Its reply ended after ${formatReplyTime(ask.endedMs ?? 0)}`
        : 'Not handed over';

  let all = $state<Record<string, boolean>>({});
  const shown = <T,>(name: string, items: T[], first: number) =>
    all[name] ? items : items.slice(0, first);
</script>

{#snippet label(text: string)}
  {#each parts(text) as part, index (index)}{#if part.code}<code>{part.text}</code
      >{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet more(name: string, count: number, first: number)}
  {#if count > first}
    <button
      type="button"
      class="show-more"
      aria-expanded={!!all[name]}
      onclick={() => (all[name] = !all[name])}
      >{all[name] ? 'Show fewer' : `Show all ${count}`}</button
    >
  {/if}
{/snippet}

{#snippet chat(conversationId: string)}
  <button
    type="button"
    class="quiet-button"
    disabled={!opens(conversationId)}
    onclick={() => open(conversationId)}
    ><MessageSquare size={13} aria-hidden="true" />Open chat</button
  >
{/snippet}

<dialog
  class="pc-dialog"
  bind:this={dialog}
  aria-labelledby="pc-dialog-title"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <header>
    <h2 id="pc-dialog-title">Reservations</h2>
    <button
      type="button"
      class="icon-button"
      bind:this={closeButton}
      onclick={close}
      aria-label="Close reservations"><X size={20} /></button
    >
  </header>
  {#if record}
    <div class="scope">
      <button type="button" class="quiet-button" onclick={() => (selected = undefined)}
        ><ChevronLeft size={14} aria-hidden="true" />All</button
      >
      <div class="stepper">
        <button
          type="button"
          class="icon-button"
          aria-label="Earlier reservation"
          disabled={position >= records.length - 1}
          onclick={() => (selected = key(records[position + 1]))}><ChevronLeft size={16} /></button
        >
        <span class="muted">{records.length - position} of {records.length}</span>
        <button
          type="button"
          class="icon-button"
          aria-label="Later reservation"
          disabled={position <= 0}
          onclick={() => (selected = key(records[position - 1]))}><ChevronRight size={16} /></button
        >
      </div>
    </div>
  {/if}
  <div class="body">
    {#if record}
      {#key selected}
        {@const machine = record.machine?.samples ? record.machine : undefined}
        <section class="hero" aria-label="Reservation">
          <div class="identity">
            <div class="identity-text">
              <strong class="purpose">{record.purpose}</strong>
              <span class="muted"
                >{title(record.conversationId)} · {when(record.askedAt)} · {pcEndedBy(record)}</span
              >
            </div>
            {@render chat(record.conversationId)}
          </div>
          <ul class="tiles">
            <li data-family="hold">
              <span class="tile-name">Waited to start</span>
              <strong>{formatReplyTime(pcWaited(record))}</strong>
            </li>
            <li data-family="work">
              <span class="tile-name">Measuring</span>
              <strong
                >{record.windowMs == null
                  ? 'Never opened'
                  : formatReplyTime(record.windowMs)}</strong
              >
            </li>
            <li data-family="hold">
              <span class="tile-name">Other chats waited</span>
              <strong>{formatReplyTime(record.held.ms)}</strong>
              <span class="muted"
                >{plural(record.held.chats, 'chat', 'chats')} · {plural(
                  record.held.refused,
                  'command',
                  'commands',
                )}</span
              >
            </li>
            {#if machine}
              <li data-family="overhead">
                <span class="tile-name">Other programs' CPU</span>
                <strong>{percent(machine.othersAverage)}</strong>
                <span class="muted">{percent(machine.othersPeak)} at most</span>
              </li>
            {/if}
            {#if record.contaminated != null}
              <li data-family={record.contaminated ? 'warning' : 'work'}>
                <span class="tile-name">Measurement</span>
                <strong class="verdict"
                  >{#if record.contaminated}<TriangleAlert
                      size={15}
                      aria-hidden="true"
                    />{'Ran beside other work'}{:else}<CircleCheck
                      size={15}
                      aria-hidden="true"
                    />{'Clean'}{/if}</strong
                >
              </li>
            {/if}
          </ul>
        </section>

        {#if record.ranBeside.length}
          {@const top = longest(record.ranBeside.map((b) => b.ms))}
          <section class="card" aria-labelledby="pc-beside">
            <h3 id="pc-beside"><TriangleAlert size={14} aria-hidden="true" />Ran beside it</h3>
            <ul class="rows">
              {#each record.ranBeside as beside, index (index)}
                <li class="row">
                  <span class="name">{@render label(pcBesideText(beside, title))}</span>
                  <TimeMakeup
                    makeup={[
                      { family: 'overhead', name: 'Ran beside it', ms: beside.ms, share: 1 },
                    ]}
                    scale={beside.ms / top}
                  />
                  <span class="time">{formatReplyTime(beside.ms)}</span>
                  <span class="share"
                    >{#if 'cpuAverage' in beside}{percent(beside.cpuAverage)}{/if}</span
                  >
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if record.blockers.length}
          {@const top = longest(record.blockers.map((b) => b.ms))}
          <section class="card" aria-labelledby="pc-blockers">
            <h3 id="pc-blockers"><Hourglass size={14} aria-hidden="true" />Before it opened</h3>
            <ul class="rows">
              {#each record.blockers as blocker, index (index)}
                <li class="row">
                  <span class="name"
                    >{title(blocker.conversationId)}<span class="muted"
                      >{#if pcHandingOver(blocker.label)}{' · '}handing over{:else}{' · '}{@render label(
                          blocker.label,
                        )}{/if}</span
                    ></span
                  >
                  <TimeMakeup
                    makeup={[{ family: 'hold', name: 'Kept it closed', ms: blocker.ms, share: 1 }]}
                    scale={blocker.ms / top}
                  />
                  <span class="time">{formatReplyTime(blocker.ms)}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if record.asks.length}
          <section class="card" aria-labelledby="pc-asks">
            <h3 id="pc-asks"><Handshake size={14} aria-hidden="true" />Hand-overs</h3>
            <ul class="facts">
              {#each record.asks as ask, index (index)}
                <li>
                  <span class="fact-name">{title(ask.conversationId)}</span>
                  <span
                    >{askText(ask)}{#if ask.readMs != null}<span class="muted"
                        >{' · '}read after {formatReplyTime(ask.readMs)}</span
                      >{/if}{#if ask.programs.length}<span class="muted"
                        >{' · '}{ask.programs
                          .map((p) => `${p.name} ${pcOutcome(p.outcome)}`)
                          .join(', ')}</span
                      >{/if}</span
                  >
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if record.stopped.length}
          <section class="card" aria-labelledby="pc-stopped">
            <h3 id="pc-stopped"><CircleStop size={14} aria-hidden="true" />Stopped</h3>
            <ul class="facts">
              {#each record.stopped as stop, index (index)}
                <li>
                  <span class="fact-name"
                    >{title(stop.conversationId)}{#if stop.by !== record.conversationId}<span
                        class="muted">{' · '}by {title(stop.by)}</span
                      >{/if}</span
                  >
                  <span
                    >{[
                      ...stop.programs.map((p) => `${p.name} ${pcOutcome(p.outcome)}`),
                      stop.background ? 'background work stopped' : '',
                    ]
                      .filter(Boolean)
                      .join(', ') || 'Nothing'}</span
                  >
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if record.frozen.length}
          <section class="card" aria-labelledby="pc-frozen">
            <h3 id="pc-frozen"><Snowflake size={14} aria-hidden="true" />Held until it ended</h3>
            <ul class="facts">
              {#each record.frozen as held, index (index)}
                <li>
                  <span class="fact-name">{title(held.conversationId)}</span>
                  <span
                    >{held.name}{#if held.processes > 1}<span class="muted"
                        >{' ×'}{held.processes}</span
                      >{/if}</span
                  >
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if machine}
          {@const busiest = longest(machine.programs.map((p) => p.cpuAverage * 10))}
          <section class="card" aria-labelledby="pc-machine">
            <h3 id="pc-machine"><Cpu size={14} aria-hidden="true" />While it was open</h3>
            <dl class="stats">
              <div>
                <dt>CPU</dt>
                <dd>
                  {percent(machine.cpuAverage)}<span class="muted"
                    >{' · '}{percent(machine.cpuPeak)} at most</span
                  >
                </dd>
              </div>
              <div>
                <dt>This chat</dt>
                <dd>
                  {percent(machine.holderAverage)}{#if machine.insideWsl}<span class="muted"
                      >{' · with WSL'}</span
                    >{/if}
                </dd>
              </div>
              <div>
                <dt>Everything else</dt>
                <dd>
                  {percent(machine.othersAverage)}<span class="muted"
                    >{' · '}{percent(machine.othersPeak)} at most</span
                  >
                </dd>
              </div>
              <div>
                <dt>Memory</dt>
                <dd>
                  {formatBytes(machine.memoryUsedPeak)}<span class="muted"
                    >{' of '}{formatBytes(machine.memoryTotal)}</span
                  >
                </dd>
              </div>
            </dl>
            {#if machine.programs.length}
              <ul class="rows programs" aria-label="Other programs">
                {#each machine.programs as program, index (index)}
                  <li class="row">
                    <span class="name"
                      >{program.name}{#if program.processes > 1}<span class="muted"
                          >{' ×'}{program.processes}</span
                        >{/if}<span class="muted">{' · '}{pcOwner(program.owner, title)}</span
                      ></span
                    >
                    <span class="meter" aria-hidden="true"
                      ><span style:width={`${((program.cpuAverage * 10) / busiest) * 100}%`}
                      ></span></span
                    >
                    <span class="time"
                      >{percent(program.cpuAverage)}<span class="muted"
                        >{' · '}{percent(program.cpuPeak)}</span
                      ></span
                    >
                    <span class="share">{formatBytes(program.memoryPeak)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if record.others.length}
              <h4>Other chats' work</h4>
              <ul class="facts">
                {#each record.others as other, index (index)}
                  <li>
                    <span class="fact-name">{title(other.conversationId)}</span>
                    <span
                      >{@render label(other.label)}<span class="muted"
                        >{' · '}{formatReplyTime(other.ms)}</span
                      ></span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            {#if record.idle.length}
              <h4>Other chats' idle work</h4>
              <ul class="facts">
                {#each record.idle as other, index (index)}
                  <li>
                    <span class="fact-name">{title(other.conversationId)}</span>
                    <span
                      >{@render label(other.label)}<span class="muted"
                        >{' · '}{formatReplyTime(other.ms)}</span
                      ></span
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}

        {#if record.held.causes.length}
          {@const top = longest(record.held.causes.map((c) => c.ms))}
          <section class="card" aria-labelledby="pc-held">
            <h3 id="pc-held"><Users size={14} aria-hidden="true" />Why other chats waited</h3>
            <ul class="rows">
              {#each record.held.causes as cause, index (index)}
                <li class="row">
                  <span class="name"
                    >{title(cause.conversationId)}<span class="muted"
                      >{#if pcHandingOver(cause.label)}{' · '}handing over{:else}{' · '}{@render label(
                          cause.label,
                        )}{/if}</span
                    ></span
                  >
                  <TimeMakeup
                    makeup={[{ family: 'hold', name: 'Waited for it', ms: cause.ms, share: 1 }]}
                    scale={cause.ms / top}
                  />
                  <span class="time">{formatReplyTime(cause.ms)}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {/key}
    {:else}
      {#if slots.length || groups.length}
        <section class="card" aria-labelledby="pc-queues">
          <h3 id="pc-queues"><Users size={14} aria-hidden="true" />In line</h3>
          <ul class="live">
            {#each groups as group (group.turns[0].id)}
              <li>
                <div class="live-head">
                  <span class="tag" class:measuring={group.turns[0].grantedAt != null}
                    >{#if group.turns[0].landing}<GitMerge
                        size={11}
                        aria-hidden="true"
                      />{/if}{turnName(group.turns[0])}</span
                  >
                  <span class="name"
                    >{group.turns[0].purpose}<span class="muted"
                      >{' · '}{title(group.turns[0].conversationId)}</span
                    >{#if pcTurnNote(group.turns[0], clock.now)}<span
                        class="turn-note"
                        class:stalled={group.turns[0].stalledAt != null &&
                          group.turns[0].keptUntil == null}
                        >{#if group.turns[0].keptUntil == null}<TriangleAlert
                            size={11}
                            aria-hidden="true"
                          />{/if}{pcTurnNote(group.turns[0], clock.now)}</span
                      >{/if}</span
                  >
                  <span class="time"
                    >{formatReplyTime(
                      Math.max(0, clock.now - (group.turns[0].grantedAt ?? group.turns[0].askedAt)),
                    )}</span
                  >
                  {@render chat(group.turns[0].conversationId)}
                </div>
                {#if group.turns.length > 1}
                  <ul class="waits">
                    {#each group.turns.slice(1) as turn (turn.id)}
                      <li>
                        <Hourglass size={12} aria-hidden="true" />{title(turn.conversationId)}<span
                          class="muted"
                          >{' · '}{turn.purpose} · {formatReplyTime(
                            Math.max(0, clock.now - turn.askedAt),
                          )}</span
                        >
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
            {#if slots.length}
              <li>
                <div class="live-head">
                  <span class="tag"><Hammer size={11} aria-hidden="true" />Builds</span>
                  <span class="name"
                    >{slots.length}
                    {slots.length === 1 ? 'build waits' : 'builds wait'} for a slot</span
                  >
                </div>
                <ul class="waits">
                  {#each slots as slot (slot.conversationId)}
                    <li>
                      <Hourglass size={12} aria-hidden="true" />{title(slot.conversationId)}<span
                        class="muted"
                        >{' · '}{@render label(slot.label)} · {slot.granted
                          ? 'slot kept'
                          : formatReplyTime(Math.max(0, clock.now - slot.since))}</span
                      >
                    </li>
                  {/each}
                </ul>
              </li>
            {/if}
          </ul>
        </section>
      {/if}

      {#if reservations.length}
        <section class="card" aria-labelledby="pc-now">
          <h3 id="pc-now"><Gauge size={14} aria-hidden="true" />Now</h3>
          <ul class="live">
            {#each reservations as reservation (reservation.id)}
              <li>
                <div class="live-head">
                  <span class="tag" class:measuring={reservation.phase === 'open'}
                    >{phase(reservation)}</span
                  >
                  <span class="name"
                    >{reservation.purpose}<span class="muted"
                      >{' · '}{title(reservation.conversationId)}</span
                    ></span
                  >
                  <span class="time">{since(reservation)}</span>
                  {@render chat(reservation.conversationId)}
                </div>
                {#if reservation.waitingFor.length || reservation.held}
                  <ul class="waits">
                    {#each reservation.waitingFor as blocker, index (index)}
                      <li>
                        <Hourglass size={12} aria-hidden="true" />{title(
                          blocker.conversationId,
                        )}<span class="muted"
                          >{#if blocker.handOver}{' · '}handing over{:else}{' · '}{@render label(
                              blocker.label,
                            )}{/if}</span
                        >
                      </li>
                    {/each}
                    {#if reservation.held}
                      <li>
                        <Users size={12} aria-hidden="true" />{plural(
                          reservation.held,
                          'chat waits',
                          'chats wait',
                        )}
                      </li>
                    {/if}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if records.length}
        {@const top = longest(records.map(spent))}
        <section class="hero" aria-label="All reservations">
          <ul class="tiles">
            <li data-family="work">
              <span class="tile-name">Measurements</span>
              <strong>{totals.count}</strong>
              <span class="muted">{formatReplyTime(totals.windowMs)} measuring</span>
            </li>
            <li data-family={totals.contaminated ? 'warning' : 'work'}>
              <span class="tile-name">Ran beside other work</span>
              <strong>{totals.contaminated}</strong>
              <span class="muted">of {totals.count}</span>
            </li>
            <li data-family="hold">
              <span class="tile-name">Waited to start</span>
              <strong>{formatReplyTime(totals.waitedMs)}</strong>
            </li>
            <li data-family="hold">
              <span class="tile-name">Other chats waited</span>
              <strong>{formatReplyTime(totals.heldMs)}</strong>
              <span class="muted">{plural(totals.refused, 'command', 'commands')}</span>
            </li>
          </ul>
        </section>
        <section class="card" aria-labelledby="pc-history">
          <h3 id="pc-history"><History size={14} aria-hidden="true" />History</h3>
          <ol class="rows">
            {#each shown('history', records, 20) as item (key(item))}
              <li>
                <button type="button" class="row" onclick={() => (selected = key(item))}>
                  <span class="name"
                    >{item.purpose}<span class="muted"
                      >{' · '}{title(item.conversationId)} · {when(item.askedAt)}</span
                    ></span
                  >
                  <TimeMakeup makeup={makeup(item)} scale={spent(item) / top} />
                  <span class="time">{formatReplyTime(spent(item))}</span>
                  <span
                    class="share"
                    class:beside={item.contaminated}
                    title={item.contaminated
                      ? 'Ran beside other heavy work'
                      : item.machine?.samples
                        ? `Other programs used ${percent(item.machine.othersAverage)} of the CPU on average while it was open`
                        : undefined}
                    >{#if item.contaminated}<TriangleAlert
                        size={11}
                        aria-label="Ran beside other heavy work"
                      />{/if}{#if item.machine?.samples}<Cpu
                        size={11}
                        aria-hidden="true"
                      />{percent(item.machine.othersAverage)}{/if}</span
                  >
                </button>
              </li>
            {/each}
          </ol>
          {@render more('history', records.length, 20)}
        </section>
      {/if}
      {#if turnRecords.length}
        <section class="card" aria-labelledby="pc-turns">
          <h3 id="pc-turns"><GitMerge size={14} aria-hidden="true" />Turns</h3>
          <ul class="facts">
            {#each shown('turns', turnRecords, 10) as turn (`${turn.askedAt}:${turn.id}`)}
              <li>
                <span class="fact-name">{turnName(turn)}</span>
                <span
                  >{title(turn.conversationId)}<span class="muted"
                    >{[
                      '',
                      turn.purpose,
                      when(turn.askedAt),
                      turn.heldMs != null && `held ${formatReplyTime(turn.heldMs)}`,
                      turn.waitedMs >= 1000 && `waited ${formatReplyTime(turn.waitedMs)}`,
                      pcTurnEnd(turn) ?? false,
                    ]
                      .filter((part) => part !== false)
                      .join(' · ')}</span
                  ></span
                >
              </li>
            {/each}
          </ul>
          {@render more('turns', turnRecords.length, 10)}
        </section>
      {/if}
      {#if !records.length && !turnRecords.length && loaded && !reservations.length && !turns.length && !slots.length}
        <p class="empty">{failed ? 'The history could not be read.' : 'No reservations yet.'}</p>
      {/if}
      {#if failed && records.length}<p class="empty">The history could not be read.</p>{/if}
    {/if}
  </div>
</dialog>

<style>
  .pc-dialog {
    width: min(880px, calc(100vw - 32px));
    max-height: min(92vh, 960px);
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-2xl);
    background: var(--surface-overlay);
    color: var(--text-secondary);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }
  .pc-dialog[open] {
    display: flex;
    flex-direction: column;
  }
  .pc-dialog::backdrop {
    background: var(--backdrop);
    backdrop-filter: blur(4px);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 18px 20px 12px 24px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    color: var(--text);
    font-size: var(--text-xl);
    letter-spacing: var(--tracking-tighter);
  }
  .scope {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 14px;
    padding: 10px 24px;
    border-bottom: 1px solid var(--border);
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  .quiet-button,
  .show-more {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
  }
  :is(.quiet-button, .show-more):not(:disabled):hover {
    border-color: var(--border-hover);
    color: var(--text);
  }
  .quiet-button:disabled {
    color: var(--text-faint);
  }
  .muted {
    color: var(--text-muted);
    font-weight: 400;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 24px 24px;
    overflow: auto;
    font-size: var(--text-sm);
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .identity {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px 14px;
  }
  .identity-text {
    display: flex;
    flex: 1 1 260px;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .purpose {
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
  }
  .tiles li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-inline-start: 3px solid var(--time-overhead);
    border-radius: var(--radius-md);
    background: var(--surface-1);
  }
  .tiles li[data-family='work'] {
    border-inline-start-color: var(--time-work);
  }
  .tiles li[data-family='hold'] {
    border-inline-start-color: var(--time-hold);
  }
  .tiles li[data-family='warning'] {
    border-inline-start-color: var(--warning);
  }
  .verdict {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tiles li[data-family='warning'] .verdict :global(svg) {
    color: var(--warning);
  }
  .tiles li[data-family='work'] .verdict :global(svg) {
    color: var(--success);
  }
  .share.beside :global(svg:first-child) {
    color: var(--warning);
  }
  .tile-name {
    flex: 1 0 100%;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .tiles strong {
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 0;
    color: var(--text-muted);
  }
  ul,
  ol,
  dl {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    min-width: 0;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 10px;
    color: var(--text);
    font-size: var(--text-base);
    font-weight: 600;
  }
  h3 :global(svg) {
    color: var(--text-muted);
  }
  h4 {
    margin: 14px 0 6px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  /* One grid for a card's rows, so names, bars and numbers line up. */
  .rows {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(60px, 3fr) auto auto;
    gap: 2px 14px;
    align-items: center;
  }
  .rows > li:not(.row) {
    display: contents;
  }
  .row {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
    min-height: 28px;
    padding: 2px 8px;
    margin: 0 -8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
  }
  button.row:hover {
    background: var(--hover);
  }
  .programs {
    margin-top: 12px;
  }
  .meter {
    display: block;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--meter-track);
    overflow: hidden;
  }
  .meter > span {
    display: block;
    min-width: 2px;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--time-overhead);
  }
  .name {
    display: block;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time,
  .share {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .time {
    color: var(--text);
    text-align: end;
  }
  .share {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    min-width: 3.4em;
    color: var(--text-muted);
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .facts li {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
  }
  .fact-name {
    color: var(--text);
    font-weight: 500;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px 14px;
  }
  .stats dt {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .stats dd {
    margin: 2px 0 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .live {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .live-head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .live-head .name {
    flex: 1 1 auto;
  }
  .tag {
    flex: 0 0 auto;
    padding: 0 7px;
    border-radius: var(--radius-full);
    background: var(--warning-soft);
    color: var(--warning);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 18px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .tag.measuring {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  /* A held turn whose reply ended, or whose holder's work may have stalled. */
  .turn-note {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-inline-start: 8px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }
  .turn-note.stalled {
    color: var(--warning);
    font-weight: 600;
  }
  .waits {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 6px 0 0;
    padding-inline-start: 4px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }
  .waits li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .waits :global(svg) {
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .show-more {
    margin-top: 10px;
    font-size: var(--text-xs);
  }
  .body > :global(*) {
    animation: fade-in var(--duration) ease;
  }
  @media (max-width: 640px) {
    .pc-dialog {
      width: 100vw;
      max-width: 100vw;
      max-height: 100dvh;
      height: 100dvh;
      border: 0;
      border-radius: 0;
    }
    header {
      padding: 14px 12px 10px 16px;
    }
    .scope {
      padding: 8px 16px;
    }
    .body {
      padding: 14px 16px 20px;
    }
    /* A row's bar goes under its name, the numbers beside the name. */
    .rows {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .row {
      row-gap: 5px;
      padding-block: 5px;
    }
    .row > :global(.makeup),
    .row > .meter {
      grid-row: 2;
      grid-column: 1 / -1;
    }
    .live-head {
      flex-wrap: wrap;
    }
  }
</style>
