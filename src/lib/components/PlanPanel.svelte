<script lang="ts">
  import {
    Check,
    Circle,
    LoaderCircle,
    CircleAlert,
    Square,
    ChevronDown,
    ListChecks,
  } from '@lucide/svelte';
  import type { Message } from '$lib/domain';
  import { planStepLabel } from '$lib/plans';
  import NativeWorkflowPanel from './NativeWorkflowPanel.svelte';
  let { message, compact = false }: { message: Message; compact?: boolean } = $props();
  const steps = $derived(message.workflow?.steps ?? message.plan?.steps ?? []);
  const completed = $derived(steps.filter((step) => step.status === 'complete').length);
</script>

{#if message.nativeWorkflows}<NativeWorkflowPanel {message} {compact} />{/if}
{#if message.plan || message.workflow}
  <details class="plan-panel" class:compact open={message.status === 'running'}>
    <summary
      ><ListChecks size={16} /><strong>{message.workflow?.name ?? 'Plan and progress'}</strong><span
        >{completed}/{steps.length} complete</span
      ><ChevronDown size={14} /></summary
    >
    <div class="plan-body">
      {#if message.workflow}<p class="plan-note">
          Legacy prompt sequence. This is saved history from the removed custom sequencer.
        </p>{/if}
      {#if !steps.length}<p class="muted small">The agent cleared its plan.</p>{/if}
      {#if message.plan?.explanation && !message.workflow}<p class="plan-explanation">
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
              {#if state === 'complete'}<Check
                  size={15}
                />{:else if state === 'running'}<LoaderCircle
                  size={15}
                  class="spinning"
                />{:else if state === 'error'}<CircleAlert
                  size={15}
                />{:else if state === 'cancelled'}<Square size={13} />{:else}<Circle
                  size={14}
                />{/if}
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
      {#if message.status !== 'running' && completed < steps.length}<p class="plan-note">
          {message.status === 'cancelled'
            ? message.workflow
              ? 'Stopped. Remaining steps were not run.'
              : 'Stopped. Unfinished steps remain unconfirmed.'
            : 'Unfinished steps remain as reported; completion of the reply does not mark them done.'}
        </p>{/if}
    </div>
  </details>
{/if}

<style>
  .plan-panel {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    margin: 10px 0;
    overflow: hidden;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px;
    cursor: pointer;
    font-size: 12px;
    list-style: none;
  }
  summary strong {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  summary > span {
    color: var(--muted);
    white-space: nowrap;
    font-size: 11px;
  }
  .plan-body {
    padding: 0 14px 12px;
    max-height: 260px;
    overflow: auto;
  }
  ol {
    padding: 0;
    margin: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    font-size: 12px;
    line-height: 1.5;
  }
  li > span:nth-child(2) {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .step-icon {
    display: flex;
    padding-top: 2px;
    flex-shrink: 0;
    color: var(--muted);
  }
  .done .step-icon {
    color: #9bc9ac;
  }
  .working .step-icon {
    color: #a9bff0;
  }
  small {
    font-size: 10px;
    color: var(--muted);
    max-width: 110px;
    text-align: right;
  }
  .plan-explanation,
  .plan-note {
    font-size: 11px;
    color: var(--muted);
    margin: 0 0 10px;
  }
  .plan-note {
    margin: 12px 0 0;
  }
  .agent-plan {
    border-top: 1px solid var(--line);
    padding-top: 12px;
    margin-top: 14px;
  }
  .agent-plan > strong {
    display: block;
    margin-bottom: 10px;
    font-size: 11px;
    color: var(--muted);
  }
  .compact {
    margin: 0 0 10px;
  }
  @media (max-width: 600px) {
    .plan-body {
      max-height: 180px;
    }
    summary {
      padding: 10px;
    }
    small {
      max-width: 75px;
    }
  }
</style>
