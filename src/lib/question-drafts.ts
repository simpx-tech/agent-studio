import { z } from 'zod';
import type { ToolActivity } from './activity.ts';
import type { RunEvent } from './domain';
import type { QuestionRequest } from './questions.ts';

/**
 * A question Claude is still writing. Claude streams a question tool's input for seconds
 * before the CLI calls the tool, so the reply shows the question as it is written and the
 * recorded request replaces it. Drafts stay in the window showing the reply: never saved,
 * synced, exported, answered or replayed.
 */
export const questionDraftSchema = z.object({
  // The tool call writing it.
  id: z.string().min(1),
  revision: z.number().int().min(1),
  questions: z.array(
    z.object({
      header: z.string(),
      question: z.string(),
      multiSelect: z.boolean(),
      options: z.array(z.object({ label: z.string().min(1), description: z.string() })),
    }),
  ),
  // The call ended without a question to answer, or its question was recorded.
  closed: z.boolean().optional(),
});
export type QuestionDraft = z.infer<typeof questionDraftSchema>;

/** A reply's drafts after an event, or undefined when the event leaves them unchanged. */
export function applyQuestionDraft(
  drafts: readonly QuestionDraft[] = [],
  event: RunEvent,
): QuestionDraft[] | undefined {
  let next: QuestionDraft;
  if (event.kind === 'question' && event.draft) {
    // The recorded question replaces its draft for good.
    const replaced = event.draft;
    const revision = drafts.find((d) => d.id === replaced)?.revision ?? 0;
    next = { id: replaced, revision: revision + 1, questions: [], closed: true };
  } else if (event.kind === 'questiondraft') {
    const parsed = questionDraftSchema.safeParse(event.questionDraft);
    if (!parsed.success) return;
    next = parsed.data;
  } else return;
  const id = next.id;
  const index = drafts.findIndex((d) => d.id === id);
  const current = index < 0 ? undefined : drafts[index];
  if (current && (current.closed || current.revision >= next.revision)) return;
  const result = [...drafts];
  if (current) result[index] = next;
  else result.push(next);
  return result;
}

/** The drafts a running reply shows: open, and their call has not ended. */
export function shownQuestionDrafts(
  drafts: readonly QuestionDraft[] | undefined,
  tools: readonly ToolActivity[],
): QuestionDraft[] {
  return (drafts ?? []).filter(
    (draft) =>
      !draft.closed &&
      (tools.find((tool) => tool.id === `claude:${draft.id}`)?.status ?? 'running') === 'running',
  );
}

/** A draft in the shape of the question it becomes, for the same form to show. */
export function draftRequest(draft: QuestionDraft): QuestionRequest {
  return {
    id: draft.id,
    revision: 1,
    status: 'pending',
    questions: draft.questions.map((q, index) => ({ id: `q${index + 1}`, ...q })),
  };
}
