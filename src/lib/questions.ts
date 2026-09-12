import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !!s.trim() && !s.includes('\0'));
const unique = (items: { id: string }[]) => new Set(items.map((q) => q.id)).size === items.length;
export const answerSchema = z.object({
  requestId: z.string().uuid(),
  answers: z
    .array(z.object({ id: text(100), values: z.array(text(4000)).min(1).max(13) }))
    .max(4)
    .refine(unique),
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
          id: text(100),
          header: z.string().max(100),
          question: text(2000),
          options: z
            .array(z.object({ label: text(200), description: z.string().max(1000) }))
            .max(12),
          multiSelect: z.boolean(),
        }),
      )
      .min(1)
      .max(4)
      .refine(unique),
    response: answerSchema.optional(),
  })
  .refine((q) => JSON.stringify(q).length <= 32000)
  .refine((q) => (q.status === 'answered' ? q.response?.requestId === q.id : !q.response));
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export const questionsSchema = z
  .array(questionRequestSchema)
  .max(16)
  .refine(unique)
  .refine((q) => JSON.stringify(q).length <= 256000);

export function validAnswer(
  question: Pick<QuestionRequest, 'id' | 'questions'>,
  answer: QuestionAnswer,
) {
  if (!answerSchema.safeParse(answer).success) return false;
  if (answer.requestId !== question.id) return false;
  if (answer.skipped) return answer.answers.length === 0;
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

// Replay actual user answers as data, never as another invocation of the tool.
export function questionHistory(questions: QuestionRequest[] = []) {
  const answered = questions.filter((q) => q.status === 'answered' && q.response);
  return answered.length
    ? '\n\nUser question responses (earlier context):\n' +
        JSON.stringify(
          answered.map((q) => ({
            questions: q.questions.map(({ id, question }) => ({ id, question })),
            answers: q.response!.answers,
            skipped: q.response!.skipped,
          })),
        )
    : '';
}
