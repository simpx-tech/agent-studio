import { describe, expect, it } from 'vitest';
import {
  answerText,
  definitionSchema,
  freshKey,
  graphIssues,
  keyFrom,
  mayContinue,
  newDefinition,
  newNode,
  nodeConfig,
  questionRequest,
  readRun,
  summarize,
  triggerOf,
  webhookSecret,
  type RunQuestion,
  type WorkflowGraph,
} from './workflow-model';
import { questionRequestSchema } from './questions';

const user = { kind: 'user' as const };

describe('workflow model', () => {
  it('starts a definition with one manual trigger that a run can begin from', () => {
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
    });
    // A Run workflow step runs a saved workflow unless it names a goal of its own.
    expect(nodeConfig({ type: 'workflow', config: {} }, 'workflow')).toMatchObject({
      kind: 'static',
      goal: '',
      wait: true,
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
    expect(messages).toContain('! Trigger takes no input.');
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
      trigger: 'schedule',
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
        nodeId: definition.graph.nodes[0].id,
        every: 'days',
        interval: 1,
        at: '08:30',
        days: [1],
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });

  it('lets a workflow have many triggers and lists what computers watch, without secrets', () => {
    const definition = newDefinition('Watcher', user);
    const taken = () => definition.graph.nodes.map((n) => n.key);
    const chat = newNode('start', { x: 0, y: 200 }, taken());
    chat.config = { ...chat.config, trigger: 'chat', chat: { events: ['completed'], title: 'Build' } };
    definition.graph.nodes.push(chat);
    const hook = newNode('start', { x: 0, y: 400 }, taken());
    hook.config = { ...hook.config, trigger: 'webhook', webhook: { secret: webhookSecret() } };
    definition.graph.nodes.push(hook);
    const confirm = newNode('confirm', { x: 300, y: 0 }, taken());
    definition.graph.nodes.push(confirm);
    definition.graph.edges.push(
      { id: 'a', source: chat.id, sourcePort: 'out', target: confirm.id },
      { id: 'b', source: confirm.id, sourcePort: 'rejected', target: definition.graph.nodes[0].id },
    );
    definition.continueOn = [crypto.randomUUID()];
    definition.assistant = { conversationId: crypto.randomUUID() };
    const issues = graphIssues(definition.graph).map((i) => i.message);
    expect(issues).not.toContain('Keep one Start step.');
    expect(issues).toContain('Confirm: write what to confirm.');
    expect(issues).toContain('Manual takes no input.');
    expect(nodeConfig(chat, 'start').chat).toMatchObject({ events: ['completed'], path: '', provider: '' });
    expect(nodeConfig(definition.graph.nodes[0], 'start').webhook).toEqual({ secret: '' });
    const summary = summarize({
      id: crypto.randomUUID(),
      kind: 'definition',
      revision: 1,
      updatedAt: 'now',
      body: definition,
    });
    expect(summary.triggers).toEqual([
      { nodeId: chat.id, kind: 'chat', config: { events: ['completed'], title: 'Build' } },
      { nodeId: hook.id, kind: 'webhook', config: {} },
    ]);
    expect(JSON.stringify(summary)).not.toContain(nodeConfig(hook, 'start').webhook.secret);
    expect(summary).toMatchObject({
      continueOn: definition.continueOn,
      chat: definition.assistant.conversationId,
      conversations: [definition.assistant.conversationId],
    });
    expect(triggerOf({ config: { schedules: [{ id: 's' }] } })).toBe('schedule');
    expect(triggerOf({ config: {} })).toBe('manual');
    expect(mayContinue({ elsewhere: true }, 'x')).toBe(true);
    expect(mayContinue({ elsewhere: false }, 'x')).toBe(false);
    expect(mayContinue({ elsewhere: true, continueOn: ['y'] }, 'x')).toBe(false);
    expect(mayContinue({ elsewhere: true, continueOn: ['x'] }, 'x')).toBe(true);
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
