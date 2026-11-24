<script lang="ts" module>
  import type { ModelMark as Mark } from '$lib/model-marks';
  /** A run the composer will start: an agent, account, model and reasoning, `count` times. */
  export type CompareChoice = {
    id: string;
    label: string;
    mark: Mark;
    account?: { name: string; color: string };
    count: number;
  };
</script>

<script lang="ts">
  // The runs of a comparison a new chat will send (docs/COMPARISONS.md): each a choice from the
  // toolbar's Agent, Model and Reasoning, run as many times as its count, the same one included.
  import { Minus, Plus } from '@lucide/svelte';
  import ModelMark from './ModelMark.svelte';
  let {
    choices,
    next,
    oneAtATime,
    disabled = false,
    add,
    count,
    sequence,
  }: {
    choices: CompareChoice[];
    /** What Add takes: the toolbar's choice now. */
    next: { label: string; mark: Mark };
    oneAtATime: boolean;
    disabled?: boolean;
    add: () => void;
    count: (id: string, count: number) => void;
    sequence: (oneAtATime: boolean) => void;
  } = $props();
  const total = $derived(choices.reduce((sum, choice) => sum + choice.count, 0));
</script>

<div class="compare-runs" role="group" aria-label="Runs">
  <ul>
    {#each choices as choice (choice.id)}<li class="compare-choice">
        <ModelMark mark={choice.mark} variant="chip" />
        <span class="choice-label" title={choice.account?.name}>{choice.label}</span>
        {#if choice.account}<span
            class="account-dot"
            style:--account-color={choice.account.color}
            aria-label={choice.account.name}
          ></span>{/if}
        <span class="choice-count">
          <button
            type="button"
            {disabled}
            aria-label={`One run fewer of ${choice.label}`}
            onclick={() => count(choice.id, choice.count - 1)}><Minus size={12} /></button
          ><span>×{choice.count}</span><button
            type="button"
            {disabled}
            aria-label={`One run more of ${choice.label}`}
            onclick={() => count(choice.id, choice.count + 1)}><Plus size={12} /></button
          >
        </span>
      </li>{/each}
    <li>
      <button type="button" class="compare-add" {disabled} onclick={add}
        ><Plus size={13} aria-hidden="true" /><ModelMark mark={next.mark} variant="chip" /><span
          >{next.label}</span
        ></button
      >
    </li>
  </ul>
  <div class="compare-options">
    <label
      ><input
        type="checkbox"
        checked={oneAtATime}
        {disabled}
        onchange={(event) => sequence(event.currentTarget.checked)}
      />One at a time</label
    >
    <span class="compare-total" class:short={total < 2}>{total} {total === 1 ? 'run' : 'runs'}</span
    >
  </div>
</div>

<style>
  .compare-runs {
    display: grid;
    gap: 6px;
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--border);
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .compare-choice,
  .compare-add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    height: var(--control-sm);
    padding: 0 4px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    font-size: var(--text-xs);
  }
  .choice-label,
  .compare-add span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .choice-count {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .choice-count button {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .choice-count button:not(:disabled):hover {
    background: var(--hover);
    color: var(--text);
  }
  .compare-add {
    padding: 0 8px;
    border-style: dashed;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .compare-add:not(:disabled):hover {
    border-color: var(--border-hover);
    background: var(--hover);
    color: var(--text);
  }
  .compare-options {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .compare-options label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .compare-total {
    font-variant-numeric: tabular-nums;
  }
  .compare-total.short {
    color: var(--warning);
  }
</style>
