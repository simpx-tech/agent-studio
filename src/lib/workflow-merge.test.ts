import { describe, expect, it } from 'vitest';
import { mergeDefinition, mergeRun } from './workflow-merge';
import {
  newDefinition,
  newNode,
  readRun,
  type WorkflowDefinition,
  type WorkflowRun,
} from './workflow-model';

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

describe('mergeDefinition', () => {
  const at = '2026-10-17T00:00:00.000Z';
  const definition = (): WorkflowDefinition => {
    const d = newDefinition('Report', { kind: 'user' }, at);
    const agent = newNode('agent', { x: 300, y: 0 }, ['start']);
    agent.config = { ...agent.config, prompt: 'Summarize.' };
    d.graph.nodes.push(agent);
    d.graph.edges.push({ id: 'e1', source: d.graph.nodes[0].id, sourcePort: 'out', target: agent.id });
    return d;
  };
  it('keeps your moves and settings beside an agent’s new steps and prompt', () => {
    const base = definition();
    const agent = base.graph.nodes[1];
    const mine = structuredClone(base);
    mine.graph.nodes[1].position = { x: 400, y: 80 };
    mine.graph.nodes[1].retries = 2;
    mine.description = 'Mine';
    const theirs = structuredClone(base);
    theirs.name = 'Daily report';
    theirs.graph.nodes[1].config = { ...theirs.graph.nodes[1].config, prompt: 'Summarize today.' };
    const notify = newNode('notify', { x: 600, y: 0 }, theirs.graph.nodes.map((n) => n.key));
    theirs.graph.nodes.push(notify);
    theirs.graph.edges.push({ id: 'e2', source: agent.id, sourcePort: 'out', target: notify.id });
    const merged = mergeDefinition(base, mine, theirs);
    expect(merged.name).toBe('Daily report');
    expect(merged.description).toBe('Mine');
    const step = merged.graph.nodes.find((n) => n.id === agent.id)!;
    expect(step.position).toEqual({ x: 400, y: 80 });
    expect(step.retries).toBe(2);
    expect(step.config.prompt).toBe('Summarize today.');
    expect(merged.graph.nodes.map((n) => n.id)).toEqual([
      base.graph.nodes[0].id,
      agent.id,
      notify.id,
    ]);
    expect(merged.graph.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
  it('drops what either side deleted and renames a key both sides took', () => {
    const base = definition();
    const agent = base.graph.nodes[1];
    const mine = structuredClone(base);
    const wait = newNode('wait', { x: 0, y: 200 }, mine.graph.nodes.map((n) => n.key));
    mine.graph.nodes.push(wait);
    const theirs = structuredClone(base);
    theirs.graph.nodes = theirs.graph.nodes.filter((n) => n.id !== agent.id);
    theirs.graph.edges = [];
    const other = newNode('wait', { x: 0, y: 400 }, theirs.graph.nodes.map((n) => n.key));
    theirs.graph.nodes.push(other);
    expect(other.key).toBe(wait.key);
    const merged = mergeDefinition(base, mine, theirs);
    expect(merged.graph.nodes.some((n) => n.id === agent.id)).toBe(false);
    expect(merged.graph.edges).toEqual([]);
    const keys = merged.graph.nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(merged.graph.nodes.find((n) => n.id === other.id)?.key).toBe(other.key);
    expect(merged.graph.nodes.find((n) => n.id === wait.id)?.key).not.toBe(other.key);
  });
});
