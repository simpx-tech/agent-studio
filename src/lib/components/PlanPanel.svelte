<script lang="ts">
  import { Check, Circle, LoaderCircle, CircleAlert, Square } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import { planStepLabel } from '$lib/plans';
  // A reply's plan steps, opened from the Plan toggle in its footer row.
  let { message }: { message: Message } = $props();
  const steps = $derived(message.workflow?.steps ?? message.plan?.steps ?? []);
  const completed = $derived(steps.filter((step) => step.status === 'complete').length);
</script>

<div class="plan-panel">
  {#if message.workflow}<p class="plan-note">
      Legacy prompt sequence. This is saved history from the removed custom sequencer.
    </p>{/if}
  {#if !steps.length}<p class="plan-note">The agent cleared its plan.</p>{/if}
  {#if message.plan?.explanation && !message.workflow}<p class="plan-note">
      {message.plan.explanation}
    </p>{/if}
  <ol>
    {#each steps as step, i}
      {@const state =
        step.status === 'running' && message.status !== 'running'
          ? message.status === 'cancelled'
            ? 'cancelled'
            : 'unknown'
          : step.status}
      {@const label =
        state === 'error'
          ? 'Failed'
          : state === 'cancelled'
            ? 'Stopped'
            : planStepLabel(
                step.status === 'complete'
                  ? 'complete'
                  : step.status === 'running'
                    ? 'running'
                    : 'pending',
                message.status,
              )}
      <li class:done={state === 'complete'} class:working={state === 'running'}>
        <span class="step-icon" aria-label={label} title={label}>
          {#if state === 'complete'}<Check size={15} />{:else if state === 'running'}<LoaderCircle
              size={15}
              class="spinning"
            />{:else if state === 'error'}<CircleAlert
              size={15}
            />{:else if state === 'cancelled'}<Square size={13} />{:else}<Circle size={14} />{/if}
        </span><span>{step.title}</span><small>{label}</small>
      </li>
    {/each}
  </ol>
  {#if message.workflow && message.plan?.steps.length}
    <div class="agent-plan">
      <strong>Agent’s current plan</strong>
      <ol>
        {#each message.plan.steps as step (step.id)}
          <li>
            <span class="step-icon" aria-label={planStepLabel(step.status, message.status)}
              >{#if step.status === 'complete'}<Check size={15} />{:else}<Circle
                  size={14}
                />{/if}</span
            ><span
              >{step.status === 'running' && message.status === 'running'
                ? (step.activeForm ?? step.title)
                : step.title}</span
            ><small>{planStepLabel(step.status, message.status)}</small>
          </li>
        {/each}
      </ol>
    </div>
  {/if}
  {#if message.status !== 'running' && completed < steps.length}<p class="plan-note last">
      {message.status === 'cancelled'
        ? message.workflow
          ? 'Stopped. Remaining steps were not run.'
          : 'Stopped. Unfinished steps remain unconfirmed.'
        : 'Unfinished steps remain as reported; completion of the reply does not mark them done.'}
    </p>{/if}
</div>

<style>
  ol {
    padding: 0;
    margin: 0;
    list-style: none;
    display: grid;
    gap: 8px;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: var(--text-sm);
    line-height: var(--leading-snug);
    color: var(--text-secondary);
  }
  li.done > span:nth-child(2) {
    color: var(--text-muted);
  }
  li.working > span:nth-child(2) {
    color: var(--text);
  }
  li > span:nth-child(2) {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .step-icon {
    display: flex;
    padding-top: 1px;
    flex-shrink: 0;
    color: var(--text-faint);
  }
  .done .step-icon {
    color: var(--success);
  }
  .working .step-icon {
    color: var(--accent-strong);
  }
  small {
    font-size: var(--text-2xs);
    color: var(--text-muted);
    max-width: 110px;
    text-align: right;
  }
  .plan-note {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin: 0 0 10px;
  }
  .plan-note.last {
    margin: 12px 0 0;
  }
  .agent-plan {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    margin-top: 14px;
  }
  .agent-plan > strong {
    display: block;
    margin-bottom: 10px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
  }
  @media (max-width: 600px) {
    small {
      max-width: 75px;
    }
  }
</style>
