import { describe, expect, it } from 'vitest';
import {
  answerSchema,
  questionRequestSchema,
  validAnswer,
  mergeQuestions,
  awaitingAnswer,
  type QuestionRequest,
} from './questions';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  initialWorkspace,
  historyFor,
  restoreWorkspace,
  type Message,
  type RunEvent,
} from './domain';
import { sharedWorkspace, mergeShared } from './sync';
import { createDesktopNotificationTracker } from './desktop-notifications';

export const questionFixture = (): QuestionRequest => ({
  id: crypto.randomUUID(),
  revision: 1,
  status: 'pending',
  questions: [
    {
      id: 'format',
      header: 'Format',
      question: 'How should I format this?',
      multiSelect: false,
      options: [
        { label: 'Brief', description: 'A short summary' },
        { label: 'Detailed', description: 'Every step' },
      ],
    },
  ],
});
const message = (): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: new Date().toISOString(),
  runId: crypto.randomUUID(),
  blocks: [],
});
describe('question lifecycle', () => {
  it('waits for the user only while a question or form is pending', () => {
    const q = questionFixture();
    expect(awaitingAnswer({ questions: [q] })).toBe(true);
    expect(awaitingAnswer({ questions: [{ ...q, status: 'answered' }] })).toBe(false);
    expect(awaitingAnswer({ elicitations: [{ status: 'pending' }] })).toBe(true);
    expect(awaitingAnswer({ elicitations: [{ status: 'declined' }] })).toBe(false);
    expect(awaitingAnswer({})).toBe(false);
  });
  it('requires explicit complete answers, permits custom input and preserves skips', () => {
    const q = questionFixture();
    const a = {
      requestId: q.id,
      skipped: false,
      answers: [{ id: 'format', values: ['My own answer'] }],
    };
    expect(validAnswer(q, answerSchema.parse(a))).toBe(true);
    expect(validAnswer(q, { ...a, requestId: crypto.randomUUID() })).toBe(false);
    expect(validAnswer(q, { ...a, answers: [] })).toBe(false);
    expect(validAnswer(q, { ...a, skipped: true })).toBe(false);
    expect(validAnswer(q, { ...a, skipped: true, answers: [] })).toBe(true);
    a.answers[0].values = ['Brief', 'Detailed'];
    expect(validAnswer(q, a)).toBe(false);
    q.questions[0].multiSelect = true;
    expect(validAnswer(q, a)).toBe(true);
    expect(validAnswer(q, { ...a, answers: [{ id: 'format', values: [] }] })).toBe(false);
    expect(answerSchema.safeParse({ ...a, answers: [a.answers[0], a.answers[0]] }).success).toBe(
      false,
    );
    expect(
      questionRequestSchema.safeParse({ ...q, questions: [...q.questions, ...q.questions] })
        .success,
    ).toBe(false);
  });
  it('retains every question and answer through checkpoints, storage, sync and prompt history', () => {
    const m = message(),
      q = questionFixture(),
      next = questionFixture();
    const events: RunEvent[] = [];
    const done: QuestionRequest = {
      ...q,
      status: 'answered',
      revision: 2,
      response: { requestId: q.id, answers: [{ id: 'format', values: ['Brief'] }], skipped: false },
    };
    for (const question of [q, next, done, q]) {
      const event: RunEvent = { kind: 'question', question };
      applyRunEvent(m, event);
      retainRunEvent(events, event);
    }
    expect(events).toHaveLength(2);
    const replay = message();
    events.forEach((e) => applyRunEvent(replay, e));
    expect(replay.questions).toEqual(m.questions);
    const w = initialWorkspace(),
      now = new Date().toISOString();
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Questions',
      createdAt: now,
      updatedAt: now,
      settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
      messages: [{ ...m, status: 'complete' }],
    });
    expect(restoreWorkspace(w).conversations[0].messages[0].questions).toEqual(m.questions);
    expect(historyFor(w.conversations[0])[0].text).toContain('Brief');
    expect(historyFor(w.conversations[0])[0].text).not.toContain(next.id);
    w.conversations[0].messages[0].status = 'error';
    w.conversations[0].messages[0].blocks = [
      { type: 'markdown', text: 'Unconfirmed assistant text' },
    ];
    expect(historyFor(w.conversations[0])[0].role).toBe('user');
    expect(historyFor(w.conversations[0])[0].text).toContain('Brief');
    expect(historyFor(w.conversations[0])[0].text).not.toContain('Unconfirmed assistant text');
    const local = sharedWorkspace(w),
      remote = structuredClone(local);
    remote.conversations[0].messages[0].questions = [q, next];
    expect(mergeShared(remote, local, remote).conversations[0].messages[0].questions?.[0]).toEqual(
      done,
    );
    expect(mergeQuestions([done], [q])[0].status).toBe('answered');
    const user = { ...message(), role: 'user' as const };
    applyRunEvent(user, { kind: 'question', question: q });
    expect(user.questions).toBeUndefined();
  });
  it('notifies once for each real pending request without ringing on history or answer updates', () => {
    const w = initialWorkspace(),
      m = message(),
      q = questionFixture();
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Questions',
      createdAt: m.createdAt,
      updatedAt: m.createdAt,
      settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
      messages: [m],
    });
    const track = createDesktopNotificationTracker();
    expect(track(w)).toEqual([]);
    m.questions = [q];
    expect(track(w)).toHaveLength(1);
    expect(track(w)).toEqual([]);
    q.status = 'answered';
    expect(track(w)).toEqual([]);
    m.questions.push(questionFixture());
    expect(track(w)).toHaveLength(1);
    expect(track(w)).toEqual([]);
    const reopened = createDesktopNotificationTracker();
    expect(reopened(w)).toEqual([]);
  });

  it('retains question revisions on one-sided edits without undoing edits or deletions', () => {
    const w = initialWorkspace(),
      q = questionFixture();
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Original',
      createdAt: '',
      updatedAt: '',
      settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
      messages: [{ ...message(), questions: [q] }],
    });
    const base = sharedWorkspace(w),
      older = structuredClone(base);
    delete older.conversations[0].messages[0].questions;
    older.conversations[0].title = 'Renamed on the other device';
    older.conversations[0].archived = true;
    for (const [local, remote] of [
      [base, older],
      [older, base],
    ]) {
      const merged = mergeShared(base, local, remote);
      expect(merged.conversations[0].title).toBe('Renamed on the other device');
      expect(merged.conversations[0].archived).toBe(true);
      expect(merged.conversations[0].messages[0].questions).toEqual([q]);
    }
    const cancelled = structuredClone(base);
    cancelled.conversations[0].messages[0].questions = [{ ...q, revision: 3, status: 'cancelled' }];
    expect(
      mergeShared(base, base, cancelled).conversations[0].messages[0].questions?.[0].status,
    ).toBe('cancelled');
    expect(
      mergeShared(cancelled, cancelled, base).conversations[0].messages[0].questions?.[0].status,
    ).toBe('cancelled');
    const deleted = structuredClone(base);
    deleted.conversations = [];
    expect(mergeShared(base, base, deleted).conversations).toEqual([]);
    expect(mergeShared(base, deleted, base).conversations).toEqual([]);
  });

  it('does not attach retained questions to a replacement run, message, or account', () => {
    const w = initialWorkspace();
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Original',
      createdAt: '',
      updatedAt: '',
      settings: { provider: 'claude', model: 'opus', reasoning: '', instructions: '' },
      messages: [{ ...message(), questions: [questionFixture()] }],
    });
    const base = sharedWorkspace(w);
    for (const mismatch of ['run', 'message', 'account']) {
      const remote = structuredClone(base);
      const reply = remote.conversations[0].messages[0];
      delete reply.questions;
      if (mismatch === 'run') reply.runId = crypto.randomUUID();
      if (mismatch === 'message') reply.id = crypto.randomUUID();
      if (mismatch === 'account')
        remote.conversations[0].settings.connectionId = crypto.randomUUID();
      expect(
        mergeShared(base, base, remote).conversations[0].messages[0].questions,
      ).toBeUndefined();
    }
  });
});
