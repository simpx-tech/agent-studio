import { describe, expect, it } from 'vitest';
import { staticRun, type RunDriver } from './workflow-engine';
import {
  newNode,
  readRun,
  summarize,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowNode,
} from './workflow-model';
import { staticTimeline } from './workflow-view';
import { testHost } from './workflow-test-host';

/** A workflow from steps given as [key, type, config] and connections as [from, to, port]. */
function workflow(
  steps: [string, NodeType, Record<string, unknown>?, Partial<WorkflowNode>?][],
  links: [string, string, string?][],
): WorkflowDefinition {
  const nodes = steps.map(([key, type, config = {}, extra = {}]) => ({
    ...newNode(type, { x: 0, y: 0 }, []),
    id: key,
    key,
    title: key,
    config,
    ...extra,
  }));
  return {
    name: 'Test',
    description: '',
    graph: {
      nodes,
      edges: links.map(([source, target, port = 'out'], i) => ({
        id: `e${i}`,
        source,
        target,
        sourcePort: port,
      })),
    },
    runsOn: '',
    elsewhere: true,
    createdAt: 'now',
    updatedAt: 'now',
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
  };
}
async function start(definition: WorkflowDefinition, inputs: Record<string, string> = {}) {
  const t = testHost();
  const run = staticRun(
    crypto.randomUUID(),
    definition,
    1,
    inputs,
    { preferred: t.environmentId, elsewhere: true },
    { kind: 'user' },
    t.now(),
  );
  const driver = await t.driver(run);
  return { t, driver };
}
const statuses = (driver: RunDriver) =>
  Object.fromEntries(
    driver.run.activations.map((a) => [
      `${a.nodeId}${a.scope ? `@${a.scope.split('#').at(-1)}` : ''}`,
      a.status,
    ]),
  );

describe('static workflow runs', () => {
  it('runs steps in order, passing outputs through templates', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start', { inputs: [{ name: 'topic' }] }],
          ['research', 'agent', { prompt: 'Research {{input.topic}}.' }],
          ['end', 'end', { output: 'Done: {{research.output}}' }],
        ],
        [
          ['start', 'research'],
          ['research', 'end'],
        ],
      ),
      { topic: 'swords' },
    );
    await driver.tick();
    expect(t.started).toHaveLength(1);
    expect(t.started[0].text).toBe('Research swords.');
    // Its chat belongs to the run.
    expect(driver.run.agents[0].external).toBeUndefined();
    expect(driver.run.agents.map((a) => a.conversationId)).toEqual([t.started[0].id]);
    expect(driver.run.detail).toBe('research running');
    t.answer(t.started[0].id, 'Swords are sharp.');
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('Done: Swords are sharp.');
    // The step's chat gives back its process once its reply ends, and reads as done.
    expect(t.released).toEqual([t.started[0].id]);
    expect(driver.run.agents[0]).toMatchObject({ status: 'done', revision: 2 });
    expect(driver.run.agents[0].endedAt).toBeDefined();
    const saved = await t.store.read([driver.id], { [driver.id]: 0 });
    expect(readRun(saved.docs[0].body)?.status).toBe('completed');
    expect(saved.events[driver.id].map((e) => e.text)).toContain('research finished');
  });

  it('branches on conditions and repeats a review loop in the same chat', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['draft', 'agent', { prompt: 'Draft it.' }],
          ['review', 'agent', { prompt: 'Review: {{previous.output}}' }],
          ['check', 'condition', { left: '{{review.output}}', op: 'contains', right: 'approved' }],
          ['fix', 'message', { target: 'step', step: 'draft', text: 'Fix: {{review.output}}' }],
          ['end', 'end', { output: '{{fix.output}}' }],
        ],
        [
          ['start', 'draft'],
          ['draft', 'review'],
          ['review', 'check'],
          ['check', 'end', 'true'],
          ['check', 'fix', 'false'],
          ['fix', 'review'],
        ],
      ),
    );
    await driver.tick();
    const draft = t.started[0].id;
    t.answer(draft, 'v1');
    await driver.tick();
    const review = t.started[1].id;
    expect(t.started[1].text).toBe('Review: v1');
    t.answer(review, 'Too short.');
    await driver.tick();
    // The fix goes to the draft's chat, and the review continues its own chat.
    expect(t.sent).toEqual([{ conversationId: draft, text: 'Fix: Too short.' }]);
    t.answer(draft, 'v2');
    await driver.tick();
    expect(t.sent[1]).toEqual({ conversationId: review, text: 'Review: v2' });
    t.answer(review, 'Approved.');
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('v2');
    expect(t.started).toHaveLength(2);
  });

  it('records each step as it ran, in order, a return to an earlier step included', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['draft', 'agent', { prompt: 'Draft it.' }],
          ['check', 'condition', { left: '{{previous.output}}', op: 'contains', right: 'good' }],
          ['fix', 'message', { target: 'step', step: 'draft', text: 'Better.' }],
          ['end', 'end', { output: '{{draft.output}}' }],
        ],
        [
          ['start', 'draft'],
          ['draft', 'check'],
          ['check', 'end', 'true'],
          ['check', 'fix', 'false'],
          ['fix', 'check'],
        ],
      ),
    );
    await driver.tick();
    t.answer(t.started[0].id, 'meh');
    await driver.tick();
    t.answer(t.started[0].id, 'good now');
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    const history = staticTimeline(driver.run, []);
    expect(history.map((e) => [e.title, e.again ?? 0, e.detail])).toEqual([
      ['start', 0, ''],
      ['draft', 0, ''],
      ['check', 0, 'False'],
      ['fix', 0, ''],
      ['check', 1, 'True'],
      ['end', 0, ''],
    ]);
    expect(history[1]).toMatchObject({ card: 'draft', chat: t.started[0].id, status: 'done' });
  });

  it('loops over items one after another with each item in its own scope', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          [
            'list',
            'set',
            { values: [{ name: 'assets', value: '["sword","shield"]', json: true }] },
          ],
          ['each', 'loop', { items: '{{list.json.assets}}' }],
          ['make', 'agent', { prompt: 'Make {{item}} ({{index}})', chat: 'new' }],
          ['end', 'end', { output: '{{each.output}}' }],
        ],
        [
          ['start', 'list'],
          ['list', 'each'],
          ['each', 'make', 'each'],
          ['each', 'end', 'done'],
        ],
      ),
    );
    await driver.tick();
    expect(t.started.map((s) => s.text)).toEqual(['Make sword (0)']);
    t.answer(t.started[0].id, 'Sword made');
    await driver.tick();
    expect(t.started.map((s) => s.text)).toEqual(['Make sword (0)', 'Make shield (1)']);
    t.answer(t.started[1].id, 'Shield made');
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(JSON.parse(driver.run.output!)).toEqual(['Sword made', 'Shield made']);
  });

  it('runs loop items side by side and merges branches', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['each', 'loop', { items: 'a\nb\nc', parallel: true }],
          ['make', 'agent', { prompt: 'Make {{item}}' }],
          ['other', 'agent', { prompt: 'Other' }],
          ['join', 'merge'],
          ['end', 'end', { output: '{{join.output}}' }],
        ],
        [
          ['start', 'each'],
          ['start', 'other'],
          ['each', 'make', 'each'],
          ['each', 'join', 'done'],
          ['other', 'join'],
          ['join', 'end'],
        ],
      ),
    );
    await driver.tick();
    expect(t.started.map((s) => s.text).sort()).toEqual(['Make a', 'Make b', 'Make c', 'Other']);
    for (const spec of t.started) t.answer(spec.id, spec.text.toUpperCase());
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toContain('OTHER');
    expect(driver.run.output).toContain('MAKE A');
  });

  it('starts at the trigger that fired, with what it handed over', async () => {
    const definition = workflow(
      [
        ['manual', 'start', { inputs: [{ name: 'topic', default: 'swords' }] }],
        ['chat', 'start', { trigger: 'chat' }],
        ['end', 'end', { output: '{{trigger.kind}}: {{trigger.json.reply}} / {{input.topic}}' }],
      ],
      [
        ['manual', 'end'],
        ['chat', 'end'],
      ],
    );
    const t = testHost();
    const run = staticRun(
      crypto.randomUUID(),
      definition,
      1,
      {},
      { preferred: t.environmentId, elsewhere: true },
      { kind: 'trigger', nodeId: 'chat', trigger: 'chat' },
      t.now(),
      { nodeId: 'chat', kind: 'chat', text: 'Built.', payload: { reply: 'Built.' } },
    );
    expect(run.activations.map((a) => a.nodeId)).toEqual(['chat']);
    const driver = await t.driver(run);
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('chat: Built. / swords');
    // A manual run starts at the first manual trigger.
    const manual = staticRun(
      crypto.randomUUID(),
      definition,
      1,
      { topic: 'maps' },
      { preferred: t.environmentId, elsewhere: true },
      { kind: 'user' },
      t.now(),
    );
    expect(manual.activations.map((a) => a.nodeId)).toEqual(['manual']);
    expect(manual.trigger).toMatchObject({ nodeId: 'manual', kind: 'manual' });
  });

  it('follows Approved or Rejected after a Confirm step', async () => {
    const steps = (): Parameters<typeof workflow>[0] => [
      ['start', 'start'],
      ['ok', 'confirm', { question: 'Publish {{run.title}}?', approve: 'Publish' }],
      ['yes', 'end', { output: 'published' }],
      ['no', 'end', { output: 'kept' }],
    ];
    const links: Parameters<typeof workflow>[1] = [
      ['start', 'ok'],
      ['ok', 'yes', 'approved'],
      ['ok', 'no', 'rejected'],
    ];
    for (const [answer, output] of [
      ['Publish', 'published'],
      ['Reject', 'kept'],
    ]) {
      const { driver } = await start(workflow(steps(), links));
      await driver.tick();
      const question = driver.run.questions[0];
      expect(question.confirm).toEqual({ approve: 'Publish', reject: 'Reject' });
      expect(question.questions[0].question).toBe('Publish Test?');
      expect(driver.run.detail).toBe('Waiting for your approval');
      Object.assign(question, {
        status: 'answered',
        revision: 2,
        answers: [{ id: 'answer', values: [answer] }],
      });
      await driver.tick();
      expect(driver.run.output).toBe(output);
    }
    // Skipping is not approving.
    const { driver } = await start(workflow(steps(), links));
    await driver.tick();
    Object.assign(driver.run.questions[0], {
      status: 'answered',
      revision: 2,
      skipped: true,
      answers: [],
    });
    await driver.tick();
    expect(driver.run.output).toBe('kept');
  });

  it('asks the user and continues with the answer', async () => {
    const { driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['ask', 'ask', { question: 'Which style?', choices: ['Flat', 'Realistic'] }],
          ['end', 'end', { output: 'Style: {{ask.output}}' }],
        ],
        [
          ['start', 'ask'],
          ['ask', 'end'],
        ],
      ),
    );
    await driver.tick();
    expect(driver.run.detail).toBe('Waiting for your answer');
    expect(driver.run.alerts.map((a) => [a.kind, a.text])).toEqual([['question', 'Which style?']]);
    const question = driver.run.questions[0];
    Object.assign(question, {
      status: 'answered',
      revision: 2,
      answers: [{ id: 'answer', values: ['Flat'] }],
    });
    await driver.tick();
    expect(driver.run.output).toBe('Style: Flat');
  });

  it('alerts once for what an agent asks in its chat, and shows it until answered', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['work', 'agent', { prompt: 'Work.' }],
        ],
        [['start', 'work']],
      ),
    );
    await driver.tick();
    const reply = t.conversations.get(t.started[0].id)!.messages.at(-1)!;
    const request = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending' as const,
      questions: [
        { id: 'color', header: '', question: 'Which color?', options: [], multiSelect: false },
      ],
    };
    reply.questions = [request];
    await driver.tick();
    await driver.tick();
    expect(driver.run.alerts.filter((a) => a.kind === 'question').map((a) => a.text)).toEqual([
      'work: Which color?',
    ]);
    expect(driver.run.agents[0].asking).toBe('Which color?');
    expect(driver.run.detail).toBe('Waiting for your answer');
    const summary = summarize({
      id: driver.id,
      kind: 'run',
      revision: 1,
      updatedAt: 'now',
      body: driver.run as never,
    });
    expect(summary.questions).toBe(1);
    reply.questions = [
      {
        ...request,
        status: 'answered',
        revision: 2,
        response: { requestId: request.id, skipped: false, answers: [{ id: 'color', values: ['Red'] }] },
      },
    ];
    await driver.tick();
    expect(driver.run.agents[0].asking).toBeUndefined();
    expect(driver.run.detail).toBe('work running');
    expect(driver.run.alerts.filter((a) => a.kind === 'question')).toHaveLength(1);
  });

  it('runs a dynamic workflow from a Run workflow step and continues with its result', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start', { inputs: [{ name: 'topic' }] }],
          ['research', 'workflow', { kind: 'dynamic', goal: 'Research {{input.topic}}.' }],
          ['end', 'end', { output: '{{research.json.verdict}} from {{research.run}}' }],
        ],
        [
          ['start', 'research'],
          ['research', 'end'],
        ],
      ),
      { topic: 'swords' },
    );
    await driver.tick();
    const [[childId, child]] = [...t.runs];
    expect(child).toMatchObject({
      mode: 'dynamic',
      title: 'Research swords.',
      parent: { runId: driver.id, activationId: driver.run.activations[1].id },
    });
    expect(child.mission?.text).toBe('Research swords.');
    expect(driver.run.activations[1]).toMatchObject({
      status: 'waiting',
      waitFor: 'child',
      childRunId: childId,
    });
    t.runs.set(childId, { ...child, status: 'completed', output: '{"verdict": "Sharp"}' });
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe(`Sharp from ${childId}`);
  });

  it('starts another run when a Run workflow step whose run failed is retried', async () => {
    const definitionId = crypto.randomUUID();
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['call', 'workflow', { workflowId: definitionId }],
        ],
        [['start', 'call']],
      ),
    );
    t.definitions.set(definitionId, {
      body: workflow(
        [
          ['start', 'start'],
          ['end', 'end', { output: 'Inner' }],
        ],
        [['start', 'end']],
      ),
      revision: 1,
    });
    await driver.tick();
    const first = driver.run.activations[1].childRunId!;
    t.runs.set(first, { ...t.runs.get(first)!, status: 'failed', detail: 'Broke' });
    await driver.tick();
    expect(driver.run.status).toBe('failed');
    driver.run.commands.push({
      id: crypto.randomUUID(),
      kind: 'retry',
      activationId: driver.run.activations[1].id,
      at: 'now',
    });
    await driver.tick();
    const second = driver.run.activations[1].childRunId!;
    expect(second).not.toBe(first);
    expect(t.runs.get(second)?.title).toBe('Test');
    expect(driver.run.status).toBe('running');
  });

  it('waits for a usage reset instead of failing, and continues an interrupted reply', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          [
            'work',
            'agent',
            { prompt: 'Work.', connectionId: 'aaaaaaaa-0000-4000-8000-000000000001' },
          ],
        ],
        [['start', 'work']],
      ),
    );
    const reset = t.now() + 3_600_000;
    t.usage.set(t.connections[0], {
      provider: 'claude',
      checkedAt: t.now() / 1000,
      windows: [
        {
          id: '5h',
          label: '5-hour',
          usedPercent: 100,
          resetsAt: reset / 1000,
          windowMinutes: 300,
          model: null,
          bucket: 'claude',
        },
      ],
      context: null,
      detail: '',
    });
    await driver.tick();
    expect(t.started).toHaveLength(0);
    expect(driver.run.activations[1]).toMatchObject({ status: 'waiting', waitFor: 'usage' });
    t.usage.delete(t.connections[0]);
    t.advance(3_600_001);
    await driver.tick();
    await driver.tick();
    expect(t.started).toHaveLength(1);
    // The app closed under the reply: it continues in the same chat, not as another try.
    t.answer(t.started[0].id, '', 'cancelled', {
      error: 'This response was interrupted when the app closed.',
    });
    await driver.tick();
    await driver.tick();
    expect(t.sent[0].conversationId).toBe(t.started[0].id);
    expect(t.sent[0].text).toMatch(/^Your previous reply was interrupted/);
    expect(driver.run.activations[1].attempts).toBe(1);
    expect(driver.run.agents[0].status).toBe('running');
    // A reply that reaches a usage limit waits in the graph, then runs again in its chat.
    t.answer(t.started[0].id, '', 'error', { error: "You've hit your usage limit" });
    await driver.tick();
    expect(driver.run.agents[0]).toMatchObject({ status: 'waiting' });
    expect(driver.run.agents[0].wait).toMatch(/^Waiting for a usage reset/);
    t.advance(15 * 60_000 + 1);
    await driver.tick();
    await driver.tick();
    expect(t.sent).toHaveLength(2);
    expect(driver.run.agents[0].status).toBe('running');
    expect(driver.run.agents[0].wait).toBeUndefined();
    t.answer(t.started[0].id, 'Worked.');
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.agents[0].status).toBe('done');
  });

  it('retries a failed step, then follows its error port', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['work', 'agent', { prompt: 'Work.' }, { retries: 1, retryDelay: 10 }],
          ['report', 'notify', { title: 'Failed', text: '{{previous.output}}' }],
        ],
        [
          ['start', 'work'],
          ['work', 'report', 'error'],
        ],
      ),
    );
    await driver.tick();
    t.answer(t.started[0].id, '', 'error', { error: 'CLI crashed' });
    await driver.tick();
    expect(driver.run.activations[1]).toMatchObject({ status: 'waiting', waitFor: 'retry' });
    t.advance(10_001);
    await driver.tick();
    expect(t.sent).toHaveLength(1);
    t.answer(t.started[0].id, '', 'error', { error: 'CLI crashed again' });
    await driver.tick();
    expect(statuses(driver)).toMatchObject({ work: 'failed', report: 'done' });
    expect(driver.run.alerts.find((a) => a.kind === 'notify')?.text).toBe(
      'Failed: CLI crashed again',
    );
    expect(driver.run.status).toBe('completed');
  });

  it('fails the run when a step fails without a way on, and stops its other replies', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['a', 'agent', { prompt: 'A' }],
          ['b', 'agent', { prompt: 'B' }],
        ],
        [
          ['start', 'a'],
          ['start', 'b'],
        ],
      ),
    );
    await driver.tick();
    t.answer(t.started[0].id, '', 'error', { error: 'Broken' });
    await driver.tick();
    expect(driver.run.status).toBe('failed');
    expect(driver.run.detail).toBe('a failed: Broken');
    expect(t.conversations.get(t.started[1].id)!.messages.at(-1)!.status).toBe('cancelled');
  });

  it('waits for times, pauses, resumes and stops on command', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['pause', 'wait', { amount: 2, unit: 'minutes' }],
          ['end', 'end', { output: 'Waited' }],
        ],
        [
          ['start', 'pause'],
          ['pause', 'end'],
        ],
      ),
    );
    await driver.tick();
    expect(driver.run.activations[1]).toMatchObject({ status: 'waiting', waitFor: 'time' });
    driver.run.commands.push({ id: crypto.randomUUID(), kind: 'pause', at: 'now' });
    await driver.tick();
    expect(driver.run.status).toBe('paused');
    t.advance(120_001);
    await driver.tick();
    expect(driver.run.status).toBe('paused');
    driver.run.commands.push({ id: crypto.randomUUID(), kind: 'resume', at: 'now' });
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('Waited');
  });

  it('merges a write it lost with the copy that won', async () => {
    const { t, driver } = await start(
      workflow(
        [
          ['start', 'start'],
          ['ask', 'ask', { question: 'Go?' }],
        ],
        [['start', 'ask']],
      ),
    );
    await driver.tick();
    // Another device answers while the driver holds its copy.
    const saved = await t.store.read([driver.id]);
    const theirs = readRun(saved.docs[0].body)!;
    Object.assign(theirs.questions[0], {
      status: 'answered',
      revision: 2,
      answers: [{ id: 'answer', values: ['Yes'] }],
    });
    theirs.notes.push({
      id: 'n1',
      revision: 1,
      title: 'From the phone',
      text: 'Hi',
      author: 'user',
      updatedAt: 'now',
    });
    await t.store.put({
      id: driver.id,
      kind: 'run',
      expected: saved.docs[0].revision,
      body: theirs as never,
    });
    driver.run.detail = 'Changed here';
    driver.change();
    await driver.flush();
    expect(driver.run.questions[0].status).toBe('answered');
    expect(driver.run.notes.map((n) => n.id)).toEqual(['n1']);
    await driver.tick();
    expect(driver.run.status).toBe('completed');
  });
});
