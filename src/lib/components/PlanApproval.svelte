<script lang="ts">
  import type { QuestionRequest, QuestionAnswer } from '$lib/questions';
  import { answerQuestion } from '$lib/transport';
  import ProposedPlan from './ProposedPlan.svelte';
  let {
    request,
    runId,
    connectionId,
    running,
  }: { request: QuestionRequest; runId?: string; connectionId?: string; running: boolean } =
    $props();
  let busy = $state(false);
  let sent = $state('');
  let error = $state('');
  const approval = $derived(request.planApproval!);
  const active = $derived(running && request.status === 'pending' && !!runId && !sent);
  const decision = $derived(
    sent || (request.response?.skipped ? 'Decline' : request.response?.answers[0]?.values[0]),
  );
  async function submit(value: 'Approve' | 'Decline') {
    if (!active || busy || !runId) return;
    busy = true;
    error = '';
    const answer: QuestionAnswer = {
      requestId: request.id,
      skipped: false,
      answers: [{ id: 'approval', values: [value] }],
    };
    try {
      await answerQuestion(runId, answer, connectionId);
      sent = value;
    } catch (e) {
      error = String(e).replace(/^Error: /, '');
    } finally {
      busy = false;
    }
  }
</script>

<section class="plan-approval" aria-label="Plan mode approval">
  {#if approval.text}<ProposedPlan text={approval.text} />{/if}
  {#if active}
    <p>
      {approval.action === 'enter'
        ? 'Claude wants to enter plan mode.'
        : 'Approve this plan and let Claude implement it?'}
    </p>
    <p class="muted small">
      {approval.action === 'enter'
        ? 'Claude can explore and prepare a plan. Implementation requires your approval.'
        : 'Approval resumes full tool access for this reply. Your mode choice still applies to the next message.'}
    </p>
    <div class="actions">
      <button type="button" class="primary" disabled={busy} onclick={() => submit('Approve')}
        >{approval.action === 'enter' ? 'Enter plan mode' : 'Approve and implement'}</button
      >
      <button type="button" disabled={busy} onclick={() => submit('Decline')}
        >{approval.action === 'enter' ? 'Decline' : 'Keep planning'}</button
      >
    </div>
  {:else}
    <p class="muted small" role="status">
      {decision === 'Approve'
        ? approval.action === 'enter'
          ? 'Plan mode entry approved.'
          : 'Plan approved for implementation.'
        : decision === 'Decline'
          ? 'Plan-mode change declined.'
          : 'Plan approval is no longer available.'}
    </p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .plan-approval {
    margin: 14px 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
</style>
