import { z } from 'zod';

const text = z
  .string()
  .min(1)
  .refine((s) => !!s.trim() && !s.includes('\0'));
const unique = (items: { id: string }[]) => new Set(items.map((q) => q.id)).size === items.length;
export const answerSchema = z.object({
  requestId: z.string().uuid(),
  answers: z.array(z.object({ id: text, values: z.array(text).min(1) })).refine(unique),
  skipped: z.boolean().default(false),
});
export type QuestionAnswer = z.infer<typeof answerSchema>;
export const questionRequestSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().min(1).max(3),
    status: z.enum(['pending', 'answered', 'cancelled']),
    questions: z
      .array(
        z.object({
          id: text,
          header: z.string(),
          question: text,
          options: z.array(z.object({ label: text, description: z.string() })),
          multiSelect: z.boolean(),
        }),
      )
      .min(1)
      .refine(unique),
    response: answerSchema.optional(),
    planApproval: z
      .object({ action: z.enum(['enter', 'exit']), text: z.string().min(1).optional() })
      .refine((p) => p.action === 'enter' || !!p.text?.trim())
      .optional(),
  })
  .refine((q) => (q.status === 'answered' ? q.response?.requestId === q.id : !q.response));
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export const questionsSchema = z.array(questionRequestSchema).refine(unique);

export function validAnswer(
  question: Pick<QuestionRequest, 'id' | 'questions' | 'planApproval'>,
  answer: QuestionAnswer,
) {
  if (!answerSchema.safeParse(answer).success) return false;
  if (answer.requestId !== question.id) return false;
  if (answer.skipped) return answer.answers.length === 0;
  if (question.planApproval)
    return (
      answer.answers.length === 1 &&
      answer.answers[0].id === 'approval' &&
      answer.answers[0].values.length === 1 &&
      ['Approve', 'Decline'].includes(answer.answers[0].values[0])
    );
  return (
    answer.answers.length === question.questions.length &&
    question.questions.every((q) => {
      const values = answer.answers.find((a) => a.id === q.id)?.values;
      return (
        values &&
        new Set(values).size === values.length &&
        (q.multiSelect || values.length === 1) &&
        values.filter((v) => !q.options.some((o) => o.label === v)).length <= 1
      );
    })
  );
}

export function mergeQuestions(left: QuestionRequest[] = [], right: QuestionRequest[] = []) {
  const result = [...left];
  for (const q of right) {
    const index = result.findIndex((v) => v.id === q.id);
    if (index >= 0 && result[index].revision >= q.revision) continue;
    const next = [...result];
    if (index < 0) next.push(q);
    else next[index] = q;
    if (questionsSchema.safeParse(next).success) result.splice(0, result.length, ...next);
  }
  return result;
}

export { awaitingAnswer } from './notifications.ts';

// Replay actual user answers as data, never as another invocation of the tool.
export function questionHistory(questions: QuestionRequest[] = []) {
  const answered = questions.filter((q) => q.status === 'answered' && q.response);
  return answered.length
    ? '\n\nUser question responses (earlier context):\n' +
        JSON.stringify(
          answered.map((q) => ({
            ...(q.planApproval
              ? {
                  planApproval: q.planApproval,
                  note: 'Historical decision for that reply only; not permission for this reply.',
                }
              : {}),
            questions: q.questions.map(({ id, question }) => ({ id, question })),
            answers: q.response!.answers,
            skipped: q.response!.skipped,
          })),
        )
    : '';
}
