import { describe, expect, it } from 'vitest';
import { staticRun } from './workflow-engine';
import {
  keyedChatId,
  newNode,
  summarize,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowNode,
} from './workflow-model';
import { testHost } from './workflow-test-host';

/**
 * What workflows need to follow things up over many runs (docs/WORKFLOWS.md): a chat kept per
 * value of a key, chats kept with yours, Command steps, and what Watch triggers and webhooks hand
 * their runs.
 */

/** A workflow from steps given as [key, type, config] and connections as [from, to, port]. */
function workflow(
  steps: [string, NodeType, Record<string, unknown>?, Partial<WorkflowNode>?][],
  links: [string, string, string?][],
): WorkflowDefinition {
  return {
    name: 'Reviews',
    description: '',
    graph: {
      nodes: steps.map(([key, type, config = {}, extra = {}]) => ({
        ...newNode(type, { x: 0, y: 0 }, []),
        id: key,
        key,
        title: key,
        config,
        ...extra,
      })),
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
const definitionId = '33333333-3333-4333-8333-333333333333';
/** A run of `definition` as a Watch trigger starts it for one item. */
function watched(
  t: ReturnType<typeof testHost>,
  definition: WorkflowDefinition,
  item: Record<string, unknown>,
  previous = '',
) {
  return staticRun(
    definitionId,
    definition,
    1,
    {},
    { preferred: t.environmentId, elsewhere: true },
    { kind: 'trigger', nodeId: 'start', trigger: 'watch' },
    t.now(),
    {
      nodeId: 'start',
      kind: 'watch',
      text: JSON.stringify(item),
      payload: item,
      key: String(item.url),
      previous,
    },
  );
}

describe('a chat kept per key', () => {
  const reviews = workflow(
    [
      ['start', 'start', { trigger: 'watch', watch: { script: 'gh pr list' } }],
      [
        'review',
        'agent',
        {
          prompt: 'Review {{trigger.json.url}}, before: {{trigger.previous}}.',
          chatKey: '{{trigger.id}}',
          title: '{{trigger.json.title}}',
        },
      ],
    ],
    [['start', 'review']],
  );

  it('continues in a later run the chat an earlier run kept for the same value', async () => {
    const t = testHost();
    const first = await t.driver(watched(t, reviews, { url: 'pr/1', title: 'Fix it' }));
    await first.tick();
    expect(t.started).toHaveLength(1);
    // The chat's id comes from the workflow, the step and the value, so every run finds it.
    expect(t.started[0].id).toBe(await keyedChatId(definitionId, 'review', 'pr/1'));
    expect(t.started[0].text).toBe('Review pr/1, before: .');
    expect(t.started[0].title).toBe('Reviews · Fix it');
    t.answer(t.started[0].id, 'Reviewed.');
    await first.tick();
    expect(first.run.status).toBe('completed');

    const second = await t.driver(
      watched(t, reviews, { url: 'pr/1', title: 'Fix it' }, 'abc 2026-11-24'),
    );
    await second.tick();
    // No new chat: the same chat hears the follow-up, and belongs to this run too.
    expect(t.started).toHaveLength(1);
    expect(t.sent).toEqual([
      { conversationId: t.started[0].id, text: 'Review pr/1, before: abc 2026-11-24.' },
    ]);
    expect(second.run.agents.map((a) => a.conversationId)).toEqual([t.started[0].id]);
    t.answer(t.started[0].id, 'Looked again.');
    await second.tick();
    expect(second.run.status).toBe('completed');
    expect(second.run.activations.find((a) => a.nodeId === 'review')?.output?.ref).toBeDefined();

    // Another value has a chat of its own.
    const third = await t.driver(watched(t, reviews, { url: 'pr/2', title: 'Other' }));
    await third.tick();
    expect(t.started).toHaveLength(2);
    expect(t.started[1].id).toBe(await keyedChatId(definitionId, 'review', 'pr/2'));
  });

  it('waits for the chat while its reply runs', async () => {
    const t = testHost();
    const first = await t.driver(watched(t, reviews, { url: 'pr/1', title: 'Fix it' }));
    await first.tick();
    const second = await t.driver(watched(t, reviews, { url: 'pr/1', title: 'Fix it' }, 'x'));
    await second.tick();
    expect(second.run.activations.find((a) => a.nodeId === 'review')).toMatchObject({
      status: 'waiting',
      waitFor: 'chat',
    });
    expect(t.sent).toEqual([]);
  });
});

describe('a chat kept yours', () => {
  it('is listed with your chats, alerts for itself and stays when the run ends', async () => {
    const t = testHost();
    const definition = workflow(
      [
        ['start', 'start'],
        ['review', 'agent', { prompt: 'Review it.', yours: true }],
      ],
      [['start', 'review']],
    );
    const run = staticRun(
      definitionId,
      definition,
      1,
      {},
      { preferred: t.environmentId, elsewhere: true },
      { kind: 'user' },
      t.now(),
    );
    const driver = await t.driver(run);
    await driver.tick();
    expect(t.started[0].yours).toBe(true);
    expect(driver.run.agents[0].external).toBe(true);
    // Its chat is one the run writes to, not one of the run's own.
    const summary = summarize({
      id: driver.id,
      kind: 'run',
      revision: 1,
      updatedAt: 'now',
      body: driver.run as unknown as Record<string, unknown>,
    });
    expect(summary.conversations).toEqual([]);
    expect(summary.listed).toEqual([t.started[0].id]);
    // A question in it alerts as the chat, not again as the run.
    const reply = t.conversations.get(t.started[0].id)!.messages.at(-1)!;
    reply.questions = [
      {
        id: crypto.randomUUID(),
        revision: 1,
        status: 'pending',
        questions: [{ id: 'q', header: '', question: 'Which branch?', options: [], multiSelect: false }],
      } as never,
    ];
    await driver.tick();
    expect(driver.run.agents[0].asking).toBe('Which branch?');
    expect(driver.run.alerts.filter((a) => a.kind === 'question')).toEqual([]);
  });
});

describe('Command steps', () => {
  const commands = workflow(
    [
      ['start', 'start', { inputs: [{ name: 'repo', default: 'me/app' }] }],
      [
        'list',
        'command',
        {
          shell: 'bash',
          script: 'gh pr list --repo "$PARAM_REPO" --json url',
          params: { repo: '{{input.repo}}' },
          timeout: 60,
        },
      ],
      ['end', 'end', { output: 'First: {{list.json.0.url}}' }],
    ],
    [
      ['start', 'list'],
      ['list', 'end'],
    ],
  );
  const begin = async () => {
    const t = testHost();
    const driver = await t.driver(
      staticRun(
        definitionId,
        commands,
        1,
        {},
        { preferred: t.environmentId, elsewhere: true },
        { kind: 'user' },
        t.now(),
      ),
    );
    await driver.tick();
    const [job, started] = [...t.commands.entries()][0];
    return { t, driver, job, started };
  };

  it('run a script as written, with values as variables, and hand on its output', async () => {
    const { t, driver, job, started } = await begin();
    // The script is never a template: values reach it only as PARAM_ variables.
    expect(started.spec).toEqual({
      owner: driver.id,
      environmentId: t.environmentId,
      folder: '',
      shell: 'bash',
      script: 'gh pr list --repo "$PARAM_REPO" --json url',
      params: { repo: 'me/app' },
      timeout: 60,
    });
    expect(driver.run.activations.find((a) => a.nodeId === 'list')).toMatchObject({
      status: 'running',
      job: { environmentId: t.environmentId, id: job },
    });
    // It goes on while the job runs.
    await driver.tick();
    expect(driver.run.status).toBe('running');
    t.endCommand(job, { stdout: '[{"url":"https://x/pr/7"}]\n' });
    await driver.tick();
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('First: https://x/pr/7');
  });

  it('fail with what the command printed to stderr', async () => {
    const { t, driver, job } = await begin();
    t.endCommand(job, { exitCode: 4, stderr: 'gh: not signed in\n' });
    await driver.tick();
    expect(driver.run.status).toBe('failed');
    expect(driver.run.detail).toBe('list failed: gh: not signed in');
  });

  it('run again when their computer’s app ended them, and stop with the run', async () => {
    const { t, driver, job } = await begin();
    t.endCommand(job, { exitCode: null, interrupted: true });
    await driver.tick();
    const again = [...t.commands.keys()].find((id) => id !== job)!;
    expect(again).toBeDefined();
    expect(driver.run.activations.find((a) => a.nodeId === 'list')?.job?.id).toBe(again);
    await driver.stop('Stopped');
    expect(t.stoppedCommands).toEqual([again]);
  });

  it('run again when their computer no longer keeps the job', async () => {
    const { t, driver, job } = await begin();
    t.commands.delete(job);
    await driver.tick();
    expect(t.commands.size).toBe(1);
    expect([...t.commands.keys()][0]).not.toBe(job);
  });

  it('wait for their computer while it is offline', async () => {
    const t = testHost();
    t.offline.add(t.environmentId);
    const driver = await t.driver(
      staticRun(
        definitionId,
        commands,
        1,
        {},
        { preferred: t.environmentId, elsewhere: true },
        { kind: 'user' },
        t.now(),
      ),
    );
    await driver.tick();
    expect(t.commands.size).toBe(0);
    expect(driver.run.activations.find((a) => a.nodeId === 'list')).toMatchObject({
      status: 'waiting',
      waitFor: 'ready',
      wait: 'Waiting for Desktop',
    });
  });
});

describe('what triggers hand their runs', () => {
  it('names a watched item, its version before, a webhook’s headers and a chat by value', async () => {
    const t = testHost();
    const chat = crypto.randomUUID();
    t.conversations.set(chat, {
      id: chat,
      title: 'Earlier',
      settings: { provider: 'claude', model: '', reasoning: '' },
      createdAt: 'now',
      updatedAt: 'now',
      messages: [],
    } as never);
    const definition = workflow(
      [
        ['start', 'start', { trigger: 'webhook' }],
        [
          'note',
          'message',
          {
            target: 'chat',
            conversationId: '{{trigger.json.conversationId}}',
            text: '{{trigger.headers.x-github-event}} {{trigger.id}}|{{trigger.previous}}',
            wait: false,
          },
        ],
      ],
      [['start', 'note']],
    );
    const run = staticRun(
      definitionId,
      definition,
      1,
      {},
      { preferred: t.environmentId, elsewhere: true },
      { kind: 'trigger', nodeId: 'start', trigger: 'webhook' },
      t.now(),
      {
        nodeId: 'start',
        kind: 'webhook',
        payload: { conversationId: chat },
        key: 'item',
        previous: 'before',
        headers: { 'x-github-event': 'pull_request' },
      },
    );
    expect(run.trigger).toMatchObject({
      key: 'item',
      previous: 'before',
      headers: { 'x-github-event': 'pull_request' },
    });
    const driver = await t.driver(run);
    await driver.tick();
    expect(t.sent).toEqual([{ conversationId: chat, text: 'pull_request item|before' }]);
    expect(driver.run.status).toBe('completed');
  });
});
