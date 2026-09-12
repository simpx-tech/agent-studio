<script lang="ts">
  import { tick } from 'svelte';
  import { Check } from '@lucide/svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { answerQuestion } from '$lib/transport';
  import type { QuestionRequest, QuestionAnswer } from '$lib/questions';
  import { validAnswer } from '$lib/questions';
  let {
    request,
    runId,
    connectionId,
    running,
  }: {
    request: QuestionRequest;
    runId?: string;
    connectionId?: string;
    running: boolean;
  } = $props();
  const selected = new SvelteMap<string, string[]>();
  const custom = new SvelteMap<string, string>();
  let busy = $state(false);
  let sent = $state(false);
  let error = $state('');
  let step = $state(0);
  let questionHeading: HTMLLegendElement | undefined = $state();
  const current = $derived(request.questions[step]);
  const lastStep = $derived(step === request.questions.length - 1);
  const active = $derived(running && request.status === 'pending' && !!runId && !sent);
  const answer = $derived<QuestionAnswer>({
    requestId: request.id,
    skipped: false,
    answers: request.questions.map((q) => ({
      id: q.id,
      values: [
        ...new Set([
          ...(selected.get(q.id) ?? []),
          ...(custom.get(q.id)?.trim() ? [custom.get(q.id)!.trim()] : []),
        ]),
      ],
    })),
  });
  const answered = $derived(
    request.questions.map((question, index) =>
      validAnswer(
        { id: request.id, questions: [question] },
        { ...answer, answers: [answer.answers[index]] },
      ),
    ),
  );
  async function goToStep(next: number) {
    if (!active || busy || next < 0 || next >= request.questions.length) return;
    step = next;
    await tick();
    questionHeading?.focus();
  }
  function choose(id: string, label: string, multiple: boolean, checked: boolean) {
    selected.set(
      id,
      multiple
        ? checked
          ? [...(selected.get(id) ?? []), label]
          : (selected.get(id) ?? []).filter((v) => v !== label)
        : [label],
    );
    if (!multiple) custom.set(id, '');
  }
  async function submit(skipped = false) {
    if (!active || busy || !runId || (!skipped && !lastStep)) return;
    const response = skipped ? { requestId: request.id, skipped, answers: [] } : answer;
    if (!validAnswer(request, response)) return;
    busy = true;
    error = '';
    try {
      await answerQuestion(runId, response, connectionId);
      sent = true;
    } catch (e) {
      error = String(e).replace(/^Error: /, '');
    } finally {
      busy = false;
    }
  }
</script>

{#if request.status !== 'answered' && !sent}
  <section class="question-card" aria-label="Agent questions">
    {#if active}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          if (lastStep) void submit();
          else void goToStep(step + 1);
        }}
      >
        <p class="question-status" role="status">
          <span>Your input is needed</span>
          {#if request.questions.length > 1}
            <span class="question-count">Question {step + 1} of {request.questions.length}</span>
          {/if}
        </p>
        {#if request.questions.length > 1}
          <nav class="question-steps" aria-label="Question navigation">
            {#each request.questions as question, index (question.id)}
              <button
                type="button"
                disabled={busy}
                aria-label={`Question ${index + 1}: ${question.header || question.question}${answered[index] ? ', answered' : ''}`}
                aria-current={step === index ? 'step' : undefined}
                title={question.header || question.question}
                onclick={() => goToStep(index)}
              >
                {index + 1}
                <span class="step-answer" class:answered={answered[index]} aria-hidden="true"
                  ><Check size={14} /></span
                >
              </button>
            {/each}
          </nav>
        {/if}
        {#key current.id}
          {@const q = current}
          <fieldset disabled={busy}>
            <legend bind:this={questionHeading} tabindex="-1">{q.question}</legend>
            {#if q.options.length}<p class="muted small">
                {q.multiSelect ? 'Choose any that apply.' : 'Choose one.'}
              </p>{/if}
            {#each q.options as option, i}
              <label class="question-option">
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`${request.id}-${q.id}`}
                  checked={(selected.get(q.id) ?? []).includes(option.label)}
                  onchange={(e) =>
                    choose(q.id, option.label, q.multiSelect, e.currentTarget.checked)}
                  aria-describedby={option.description ? `${request.id}-${q.id}-${i}` : undefined}
                />
                <span
                  ><strong>{option.label}</strong>{#if option.description}<small
                      id={`${request.id}-${q.id}-${i}`}>{option.description}</small
                    >{/if}</span
                >
              </label>
            {/each}
            <label class="question-text">
              <span>{q.options.length ? 'Your own answer' : 'Your answer'}</span>
              <textarea
                rows="2"
                maxlength="4000"
                aria-label={`Your answer: ${q.question}`}
                value={custom.get(q.id) ?? ''}
                oninput={(e) => {
                  custom.set(q.id, e.currentTarget.value);
                  if (!q.multiSelect && e.currentTarget.value.trim()) selected.set(q.id, []);
                }}></textarea>
            </label>
          </fieldset>
        {/key}
        {#if request.questions.length > 1 && lastStep && !validAnswer(request, answer)}
          <p class="muted small">Answer all questions to send.</p>
        {/if}
        {#if error}<p class="question-error" role="alert">{error}</p>{/if}
        <div class="question-actions">
          {#if step > 0}
            <button type="button" disabled={busy} onclick={() => goToStep(step - 1)}>Back</button>
          {/if}
          <button
            class="primary"
            type="submit"
            disabled={busy || (lastStep && !validAnswer(request, answer))}
            >{busy ? 'Sending…' : lastStep ? 'Send answers' : 'Next'}</button
          >
          <button class="text-button" type="button" disabled={busy} onclick={() => submit(true)}
            >Skip questions</button
          >
        </div>
      </form>
    {:else}
      <details open>
        <summary>Questions no longer awaiting answers</summary>
        {#each request.questions as q (q.id)}
          <p class="saved-question"><strong>{q.question}</strong></p>
        {/each}
      </details>
    {/if}
  </section>
{/if}

<style>
  .question-card {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 16px;
    margin: 16px 0;
    min-width: 0;
  }
  .question-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-weight: 600;
    margin: 0 0 16px;
  }
  .question-count {
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
  }
  .question-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  .question-steps button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .question-steps button[aria-current='step'] {
    border-color: var(--green);
    color: var(--green);
    box-shadow: inset 0 -2px var(--green);
  }
  .step-answer {
    display: flex;
    visibility: hidden;
    color: var(--green);
  }
  .step-answer.answered {
    visibility: visible;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 20px;
    min-width: 0;
  }
  legend {
    font-weight: 600;
    margin-bottom: 10px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .question-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 10px;
    margin: 6px 0;
    cursor: pointer;
  }
  .question-option:has(input:checked) {
    border-color: var(--green);
  }
  .question-option input {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    margin: 2px 0;
    accent-color: var(--green);
  }
  .question-option span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .question-option strong {
    font-size: 13px;
  }
  .question-option small {
    display: block;
    color: var(--muted);
    margin-top: 3px;
    white-space: pre-wrap;
  }
  .question-text {
    display: block;
    margin-top: 12px;
  }
  .question-text span {
    display: block;
    font-size: 12px;
    margin-bottom: 6px;
    color: var(--muted);
  }
  textarea {
    width: 100%;
    min-height: 64px;
    resize: vertical;
  }
  .question-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  .question-error {
    color: #f0a295;
  }
  summary {
    cursor: pointer;
    font-weight: 500;
  }
  .saved-question {
    margin: 12px 0 4px;
  }
  .saved-question {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
