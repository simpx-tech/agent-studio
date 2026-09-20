import { describe, it, expect } from 'vitest';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  historyFor,
  initialWorkspace,
  restoreWorkspace,
  settingsFor,
  type Message,
  type RunEvent,
} from './domain';
import { mergeProposedPlans, proposedPlansSchema } from './proposed-plans';
import { questionRequestSchema, validAnswer } from './questions';
import { emptyShared, mergeShared, sharedWorkspace } from './sync';

const proposal = { id: 'p1', revision: 1, text: 'Draft', complete: false, truncated: false };
const reply = (): Message => ({
  id: crypto.randomUUID(),
  runId: crypto.randomUUID(),
  role: 'assistant',
  status: 'running',
  createdAt: '',
  blocks: [],
});
describe('proposed plans', () => {
  it('replaces streaming text with the authoritative final plan without changing TODOs or answer text', () => {
    const message = reply(),
      events: RunEvent[] = [];
    const todo = {
      revision: 1,
      steps: [{ id: 't1', title: 'Investigate', status: 'running' as const }],
    };
    applyRunEvent(message, { kind: 'plan', plan: todo });
    for (const p of [
      proposal,
      { ...proposal, revision: 2, text: 'Final plan', complete: true },
      { ...proposal, revision: 3, text: 'Late draft' },
    ]) {
      const event: RunEvent = { kind: 'proposedplan', proposedPlan: p };
      applyRunEvent(message, event);
      retainRunEvent(events, event);
    }
    expect(message.plan).toEqual(todo);
    expect(message.blocks).toEqual([]);
    expect(message.proposedPlans![0].text).toBe('Final plan');
    const replay = reply();
    events.forEach((e) => applyRunEvent(replay, e));
    expect(replay.proposedPlans).toEqual(message.proposedPlans);
  });
  it('retains finished plans and mode selection through history/export and old relay checkpoints', () => {
    const w = initialWorkspace(),
      settings = { ...settingsFor(w.preferences), planMode: true },
      message = reply();
    message.settings = settings;
    message.status = 'complete';
    message.proposedPlans = [{ ...proposal, complete: true }];
    w.conversations.push({
      id: crypto.randomUUID(),
      title: 'Plan',
      createdAt: '',
      updatedAt: '',
      settings,
      messages: [message],
    });
    const saved = restoreWorkspace(JSON.parse(JSON.stringify(w)));
    expect(saved.conversations[0].settings.planMode).toBe(true);
    expect(historyFor(saved.conversations[0])[0].text).toContain('not approval to execute');
    const base = sharedWorkspace(saved),
      old = structuredClone(base);
    delete old.conversations[0].messages[0].proposedPlans;
    for (const merged of [
      mergeShared(base, base, old),
      mergeShared(base, old, base),
      mergeShared(emptyShared(), base, old),
    ])
      expect(merged.conversations[0].messages[0].proposedPlans).toEqual(message.proposedPlans);
    old.conversations[0].messages[0].runId = crypto.randomUUID();
    expect(mergeShared(base, base, old).conversations[0].messages[0].proposedPlans).toBeUndefined();
  });
  it('bounds metadata and keeps unfinished or truncated proposals out of bootstrap context', () => {
    expect(
      proposedPlansSchema.safeParse(
        Array.from({ length: 9 }, (_, i) => ({ ...proposal, id: String(i) })),
      ).success,
    ).toBe(false);
    expect(proposedPlansSchema.safeParse([{ ...proposal, text: 'x'.repeat(128001) }]).success).toBe(
      false,
    );
    expect(
      mergeProposedPlans([proposal], [{ ...proposal, revision: 0, text: 'stale' }])[0].text,
    ).toBe('Draft');
  });
  it('plan approval accepts only explicit approved/declined actions and requires reviewable text', () => {
    const q = questionRequestSchema.parse({
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        { id: 'approval', header: 'Plan', question: 'Approve?', options: [], multiSelect: false },
      ],
      planApproval: { action: 'exit', text: 'Plan' },
    });
    const answer = {
      requestId: q.id,
      skipped: false,
      answers: [{ id: 'approval', values: ['Approve'] }],
    };
    expect(validAnswer(q, answer)).toBe(true);
    expect(validAnswer(q, { ...answer, answers: [{ id: 'approval', values: ['Yes'] }] })).toBe(
      false,
    );
    expect(validAnswer(q, { ...answer, answers: [] })).toBe(false);
    expect(
      questionRequestSchema.safeParse({ ...q, planApproval: { action: 'exit' } }).success,
    ).toBe(false);
  });
});
