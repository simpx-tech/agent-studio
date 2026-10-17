import { describe, expect, it } from 'vitest';
import { mergeRun } from './workflow-merge';
import { readRun, type WorkflowRun } from './workflow-model';

const base = (): WorkflowRun =>
  readRun({
    mode: 'dynamic',
    title: 'Mission',
    status: 'running',
    createdAt: 'a',
    updatedAt: 'a',
    startedAt: 'a',
    createdBy: { kind: 'user' },
    driver: { preferred: crypto.randomUUID() },
    notes: [{ id: 'style', revision: 1, title: 'Style', text: 'Flat', updatedAt: 'a' }],
    inbox: [{ id: 'i1', at: 'a', kind: 'agent', text: 'done' }],
  })!;

describe('mergeRun', () => {
  it('keeps the driver’s progress and the user’s answer and note together', () => {
    const original = base();
    const question = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending' as const,
      source: 'orchestrator' as const,
      createdAt: 'b',
      questions: [{ id: 'q', header: '', question: 'Go?', options: [], multiSelect: false }],
    };
    original.questions = [question];
    // The driver delivered the inbox, added a task and noted progress.
    const driver = structuredClone(original);
    driver.inbox = [];
    driver.tasks = [
      {
        id: 't1',
        revision: 1,
        title: 'Plan',
        description: '',
        status: 'running',
        dependsOn: [],
        phase: '',
        result: '',
        createdAt: 'b',
        updatedAt: 'b',
      },
    ];
    driver.notes = [
      { ...original.notes[0], revision: 2, text: 'Flat, bold outlines', updatedAt: 'c' },
    ];
    driver.detail = 'Planning';
    // Meanwhile the user answered, wrote a note and asked for a pause.
    const user = structuredClone(original);
    user.questions = [
      { ...question, revision: 2, status: 'answered', answers: [{ id: 'q', values: ['Yes'] }] },
    ];
    user.notes = [
      ...original.notes,
      { id: 'u1', revision: 1, title: 'Budget', text: 'Any', author: 'user', updatedAt: 'c' },
    ];
    user.commands = [{ id: crypto.randomUUID(), kind: 'pause', at: 'c' }];
    user.status = 'paused';
    const merged = mergeRun(original, driver, user);
    expect(merged.questions[0].status).toBe('answered');
    expect(merged.notes.map((n) => [n.id, n.text])).toEqual([
      ['style', 'Flat, bold outlines'],
      ['u1', 'Any'],
    ]);
    expect(merged.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(merged.inbox).toEqual([]);
    expect(merged.commands).toHaveLength(1);
    expect(merged.status).toBe('paused');
    expect(merged.detail).toBe('Planning');
  });

  it('keeps an item only one side added to the inbox and an ended run ended', () => {
    const original = base();
    const mine = structuredClone(original);
    mine.inbox = [...original.inbox, { id: 'i2', at: 'b', kind: 'answer', text: 'Yes' }];
    mine.status = 'completed';
    mine.endedAt = 'b';
    const theirs = structuredClone(original);
    theirs.inbox = [];
    theirs.status = 'paused';
    const merged = mergeRun(original, mine, theirs);
    expect(merged.inbox.map((i) => i.id)).toEqual(['i2']);
    expect(merged.status).toBe('completed');
    expect(merged.endedAt).toBe('b');
  });
});
