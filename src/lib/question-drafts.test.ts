import { describe, expect, it } from 'vitest';
import {
  applyQuestionDraft,
  draftRequest,
  shownQuestionDrafts,
  type QuestionDraft,
} from './question-drafts';
import type { ToolActivity } from './activity';
import { questionRequestSchema } from './questions';
import type { RunEvent } from './domain';

const draft = (revision: number, question = 'Which theme', extra: Partial<QuestionDraft> = {}) => ({
  id: 'toolu_ask',
  revision,
  questions: [
    {
      header: 'Theme',
      question,
      multiSelect: false,
      options: [{ label: 'Dark', description: 'Easy on the eyes' }],
    },
  ],
  ...extra,
});
const written = (questionDraft: QuestionDraft): RunEvent => ({
  kind: 'questiondraft',
  questionDraft,
});
const call = (status: ToolActivity['status']): ToolActivity => ({
  id: 'claude:toolu_ask',
  revision: 1,
  name: 'mcp__agent_studio__studio_ask_user',
  category: 'tool',
  status,
  sources: [],
  agents: [],
});

describe('question drafts', () => {
  it('follows a question as it is written, ignoring stale and malformed updates', () => {
    let drafts = applyQuestionDraft([], written(draft(1, '')))!;
    drafts = applyQuestionDraft(drafts, written(draft(3, 'Which theme do')))!;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].questions[0].question).toBe('Which theme do');
    // An older revision, applied again from a relay job, never takes the text back.
    expect(applyQuestionDraft(drafts, written(draft(2, 'Which')))).toBeUndefined();
    expect(applyQuestionDraft(drafts, written(draft(3, 'Which')))).toBeUndefined();
    const invalid = { ...draft(4), questions: Array(5).fill(draft(4).questions[0]) };
    expect(applyQuestionDraft(drafts, written(invalid))).toBeUndefined();
    expect(applyQuestionDraft(drafts, { kind: 'text', text: 'Answer' })).toBeUndefined();
  });

  it('closes for good when its question is recorded or its call ends without one', () => {
    const drafts = applyQuestionDraft([], written(draft(2)))!;
    const recorded = applyQuestionDraft(drafts, {
      kind: 'question',
      draft: 'toolu_ask',
      question: { ...draftRequest(drafts[0]), id: crypto.randomUUID() },
    })!;
    expect(recorded).toEqual([{ id: 'toolu_ask', revision: 3, questions: [], closed: true }]);
    // A later update cannot reopen it, whatever its revision.
    expect(applyQuestionDraft(recorded, written(draft(9)))).toBeUndefined();
    expect(shownQuestionDrafts(recorded, [call('running')])).toEqual([]);
    const refused = applyQuestionDraft(drafts, written(draft(3, '', { closed: true })))!;
    expect(shownQuestionDrafts(refused, [])).toEqual([]);
    // A question that replaces no draft leaves the drafts alone.
    const plain: RunEvent = { kind: 'question', question: draftRequest(drafts[0]) };
    expect(applyQuestionDraft(drafts, plain)).toBeUndefined();
  });

  it('shows only open drafts whose call still runs, at most sixteen per reply', () => {
    const drafts = applyQuestionDraft([], written(draft(1)))!;
    expect(shownQuestionDrafts(drafts, [])).toHaveLength(1);
    expect(shownQuestionDrafts(drafts, [call('running')])).toHaveLength(1);
    expect(shownQuestionDrafts(drafts, [call('error')])).toEqual([]);
    expect(shownQuestionDrafts(undefined, [])).toEqual([]);
    let many: QuestionDraft[] = [];
    for (let i = 0; i < 20; i++)
      many = applyQuestionDraft(many, written({ ...draft(1), id: `call${i}` })) ?? many;
    expect(many).toHaveLength(16);
  });

  it('takes the shape of the question it becomes', () => {
    const request = draftRequest(draft(2));
    expect(request.questions).toEqual([{ id: 'q1', ...draft(2).questions[0] }]);
    expect(request.status).toBe('pending');
    // The form shows it like a recorded question, though no answer can name it.
    expect(questionRequestSchema.safeParse({ ...request, id: crypto.randomUUID() }).success).toBe(
      true,
    );
  });
});
