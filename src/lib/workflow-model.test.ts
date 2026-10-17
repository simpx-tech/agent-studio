import { describe, expect, it } from 'vitest';
import {
  answerText,
  definitionSchema,
  freshKey,
  graphIssues,
  keyFrom,
  newDefinition,
  newNode,
  nodeConfig,
  questionRequest,
  readRun,
  summarize,
  type RunQuestion,
  type WorkflowGraph,
} from './workflow-model';
import { questionRequestSchema } from './questions';

const user = { kind: 'user' as const };

describe('workflow model', () => {
  it('starts a definition with one Start step that a run can begin from', () => {
    const definition = newDefinition('Report', user, '2026-10-16T00:00:00.000Z');
    expect(definitionSchema.parse(definition)).toEqual(definition);
    expect(definition.graph.nodes.map((n) => [n.type, n.key])).toEqual([['start', 'start']]);
    expect(graphIssues(definition.graph).filter((i) => i.blocking)).toEqual([]);
  });

  it('fills step settings with defaults and keeps settings a newer release wrote', () => {
    const node = newNode('agent', { x: 1, y: 2 }, ['agent_1']);
    expect(node.key).toBe('agent_2');
    const config = nodeConfig({ type: 'agent', config: { prompt: 'Hi', future: 1 } }, 'agent');
    expect(config).toMatchObject({
      prompt: 'Hi',
      chat: 'continue',
      connectionId: '',
      listed: false,
    });
    // Settings that no longer fit fall back to the defaults instead of failing.
    expect(nodeConfig({ type: 'wait', config: { amount: 'soon' } }, 'wait').amount).toBe(5);
  });

  it('makes keys from types and titles', () => {
    expect(freshKey('screenAction', [])).toBe('screen_action_1');
    expect(keyFrom('Review the sword', ['review_the_sword'])).toBe('review_the_sword_2');
    expect(keyFrom('3D model', [])).toBe('s_3d_model');
    expect(keyFrom('!!!', [])).toBe('step');
  });

  it('reports what keeps a graph from running', () => {
    const start = newNode('start', { x: 0, y: 0 }, []);
    const agent = newNode('agent', { x: 0, y: 0 }, [start.key]);
    const loose = newNode('notify', { x: 0, y: 0 }, [start.key, agent.key]);
    const graph: WorkflowGraph = {
      nodes: [start, agent, loose, { ...newNode('end', { x: 0, y: 0 }, []), key: agent.key }],
      edges: [
        { id: 'e1', source: start.id, sourcePort: 'out', target: agent.id },
        { id: 'e2', source: agent.id, sourcePort: 'true', target: loose.id },
        { id: 'e3', source: agent.id, sourcePort: 'out', target: start.id },
      ],
    };
    const messages = graphIssues(graph).map((i) => `${i.blocking ? '!' : '?'} ${i.message}`);
    expect(messages).toContain(`! The key ${agent.key} is used twice.`);
    expect(messages).toContain('! Agent has no true output.');
    expect(messages).toContain('! Start takes no input.');
    expect(messages).toContain('! Agent: write a prompt.');
    expect(messages.some((m) => m.startsWith('? End is not connected'))).toBe(true);
  });

  it('turns run questions into the question form and their answers into text', () => {
    const question: RunQuestion = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'answered',
      source: 'orchestrator',
      createdAt: 'now',
      questions: [
        {
          id: 'style',
          header: 'Style',
          question: 'Which style?',
          options: [{ label: 'Flat', description: '' }],
          multiSelect: false,
        },
        { id: 'size', header: '', question: 'Size?', options: [], multiSelect: false },
      ],
      answers: [
        { id: 'style', values: ['Flat'] },
        { id: 'size', values: ['Large'] },
      ],
    };
    expect(questionRequestSchema.safeParse(questionRequest(question)).success).toBe(true);
    expect(answerText(question)).toBe('Style: Flat\nSize?: Large');
    expect(answerText({ ...question, skipped: true })).toBe('(Skipped.)');
    const pending = { ...question, status: 'pending' as const, answers: undefined };
    expect(questionRequestSchema.safeParse(questionRequest(pending)).success).toBe(true);
  });

  it('summarizes definitions with their schedules', () => {
    const definition = newDefinition('Daily', user);
    definition.graph.nodes[0].config = {
      schedules: [
        { id: 's1', every: 'days', at: '08:30', timezone: 'America/Sao_Paulo' },
        { id: 's2', enabled: false },
      ],
    };
    const summary = summarize({
      id: crypto.randomUUID(),
      kind: 'definition',
      revision: 3,
      updatedAt: 'now',
      body: definition,
    });
    expect(summary).toMatchObject({ title: 'Daily', steps: 1 });
    expect(summary.schedules).toEqual([
      {
        id: 's1',
        every: 'days',
        interval: 1,
        at: '08:30',
        days: [1],
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });

  it('reads runs with defaults for parts older writers left out', () => {
    const run = readRun({
      mode: 'dynamic',
      status: 'running',
      createdAt: 'a',
      updatedAt: 'a',
      startedAt: 'a',
      createdBy: user,
      driver: { preferred: crypto.randomUUID() },
    });
    expect(run).toMatchObject({
      title: 'Workflow',
      notes: [],
      agents: [],
      inbox: [],
      driver: { elsewhere: true },
    });
    expect(readRun({ mode: 'other' })).toBeUndefined();
  });
});
