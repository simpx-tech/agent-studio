import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// Workflows (docs/WORKFLOWS.md): the Workflows page lists them, and static and dynamic workflows start
// from a chat with their graph beside it, on the desktop mock, whose replies wait until a test
// finishes them and whose workflow store lives in local storage.

type Request = {
  runId: string;
  conversationId: string;
  agent: { provider: string; reasoning: string; instructions: string };
  mission?: { runId: string; role: string };
  messages: { role: string; text: string }[];
};
const requests = (page: Page) =>
  page.evaluate(() => ((window as any).runRequests ?? []) as Request[]);
/** Ends a reply the mock holds, with its answer. */
async function reply(page: Page, runId: string, text: string, status = 'complete') {
  await page.evaluate(
    ({ runId, text, status }) => {
      const run = (window as any).capabilityRuns[runId];
      run.emit({ kind: 'text', text });
      run.finish(status);
    },
    { runId, text, status },
  );
}
/** Sends a workflow tool call as the host would, and waits for the page's answer. */
async function call(page: Page, request: Request, tool: string, input: unknown) {
  const id = crypto.randomUUID();
  await page.evaluate((call) => (window as any).emitTauriEvent('studio-workflow-call', call), {
    id,
    runId: request.runId,
    conversationId: request.conversationId,
    connectionId: null,
    tool,
    input,
    mission: request.mission ?? null,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) => ((window as any).workflowAnswers ?? []).find((a: any) => a.id === id),
        id,
      ),
    )
    .toBeTruthy();
  return page.evaluate(
    (id) => ((window as any).workflowAnswers ?? []).find((a: any) => a.id === id),
    id,
  ) as Promise<{ text: string; error: boolean }>;
}
async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
/** The Workflows page, from the sidebar, and a new workflow chat from it. */
async function newWorkflowChat(page: Page) {
  await page.getByRole('button', { name: /^Workflows/ }).click();
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New', exact: true }).click();
}

test('a workflow starts from a chat whose agent builds it beside its graph', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  // The Workflows page, empty at first.
  await page.getByRole('button', { name: /^Workflows/ }).click();
  await expect(page.getByText('No workflows yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New workflow' }).click();
  await expect(page.getByRole('heading', { name: 'What should it do?' })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute(
    'placeholder',
    'Describe the workflow…',
  );
  await expect(page.getByRole('radio', { name: 'Static' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await send(page, 'Write about swords every morning.');
  // The chat becomes the workflow's assistant: Claude at its maximum reasoning, told which
  // workflow it changes.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [assistant] = await requests(page);
  expect(assistant.agent.provider).toBe('claude');
  expect(assistant.agent.reasoning).toBe('max');
  expect(assistant.mission).toBeUndefined();
  const workflowId = assistant.agent.instructions.match(/workflow ([0-9a-f-]{36})/)?.[1];
  expect(workflowId).toBeTruthy();
  expect(assistant.messages.at(-1)?.text).toBe('Write about swords every morning.');
  const panel = page.getByRole('dialog', { name: 'Workflow' });
  await expect(panel.locator('.workflow-card')).toHaveCount(1);
  // The assistant saves a workflow, which the graph shows at once, from top to bottom.
  const read = JSON.parse((await call(page, assistant, 'workflow_read', { id: workflowId })).text);
  const saved = await call(page, assistant, 'workflow_save', {
    id: workflowId,
    revision: read.revision,
    name: 'Sword writer',
    nodes: [
      read.nodes[0],
      { key: 'write', type: 'agent', title: 'Write', config: { prompt: 'Write about swords.' } },
      { key: 'finish', type: 'end', title: 'Finish', config: { output: '{{write.output}}' } },
    ],
    edges: [
      { source: read.nodes[0].key, target: 'write' },
      { source: 'write', target: 'finish' },
    ],
  });
  expect(saved.error).toBe(false);
  await expect(panel.locator('.workflow-card')).toHaveCount(3);
  await expect(panel.getByLabel('Workflow name')).toHaveValue('Sword writer');
  // The chat is named by its workflow.
  await expect(page.locator('.page-title')).toHaveText('Sword writer');
  await expect(panel.locator('.svelte-flow__background')).toBeVisible();
  const top = async (title: string) =>
    (await panel.locator('.workflow-card').filter({ hasText: title }).boundingBox())!.y;
  expect(await top('Write')).toBeLessThan(await top('Finish'));
  // The chat and the graph share the window by halves, as it grows and shrinks.
  const share = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('#workflow-panel')!;
      return (
        dialog.getBoundingClientRect().width / dialog.parentElement!.getBoundingClientRect().width
      );
    });
  expect(await share()).toBeCloseTo(0.5, 1);
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(share).toBeCloseTo(0.5, 1);
  await page.setViewportSize({ width: 1380, height: 900 });
  // It stays out of the chat lists; the workflow is on the Workflows page.
  await reply(page, assistant.runId, 'It writes about swords each morning.');
  await page.getByRole('tab', { name: /^Active/ }).click();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  await page.getByRole('button', { name: /^Workflows/ }).click();
  const tile = page.locator('.workflow-tile').filter({ hasText: 'Sword writer' });
  await expect(tile).toContainText('Never run');
  // It opens in its chat, with its graph beside it.
  await tile.click();
  await expect(panel.locator('.workflow-card')).toHaveCount(3);
  await expect(
    page.locator('.message').filter({ hasText: 'It writes about swords' }),
  ).toBeVisible();
  // A connection dragged from a step's output to empty space adds a step there.
  const write = panel.locator('.workflow-card').filter({ hasText: 'Write' });
  const handle = write.locator('.svelte-flow__handle.source').first();
  // The graph glides into view after a change; the handle is where it stays.
  await expect
    .poll(async () => {
      const first = JSON.stringify(await handle.boundingBox());
      await page.waitForTimeout(100);
      return first === JSON.stringify(await handle.boundingBox());
    })
    .toBe(true);
  const from = (await handle.boundingBox())!;
  const canvas = (await panel.locator('.workflow-canvas').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width - 100, canvas.y + canvas.height - 70, { steps: 8 });
  await page.mouse.move(canvas.x + canvas.width - 80, canvas.y + canvas.height - 60, { steps: 4 });
  await page.mouse.up();
  await page
    .getByRole('menu', { name: 'Add a step here' })
    .getByRole('menuitem', { name: 'Confirm' })
    .click();
  await expect(panel.locator('.workflow-card')).toHaveCount(4);
  await expect(panel.locator('.svelte-flow__edge')).toHaveCount(3);
  await panel.getByLabel('What to confirm').fill('Publish it?');
  // Your edits save by themselves, merged with the agent's.
  await expect
    .poll(async () => {
      const now = JSON.parse(
        (await call(page, assistant, 'workflow_read', { id: workflowId })).text,
      );
      return now.nodes.find((n: any) => n.type === 'confirm')?.config.question;
    })
    .toBe('Publish it?');
  // The inspector never scrolls sideways.
  const inspector = panel.locator('.inspector-body');
  expect(
    await inspector.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test('a workflow runs beside its chat, through a Confirm step, with its history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await newWorkflowChat(page);
  await send(page, 'Publish a post after I approve it.');
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [assistant] = await requests(page);
  const workflowId = assistant.agent.instructions.match(/workflow ([0-9a-f-]{36})/)![1];
  const read = JSON.parse((await call(page, assistant, 'workflow_read', { id: workflowId })).text);
  await call(page, assistant, 'workflow_save', {
    id: workflowId,
    revision: read.revision,
    name: 'Poster',
    nodes: [
      read.nodes[0],
      { key: 'ok', type: 'confirm', config: { question: 'Publish it?', approve: 'Publish' } },
      { key: 'yes', type: 'end', config: { output: 'published' } },
      { key: 'no', type: 'end', config: { output: 'kept' } },
    ],
    edges: [
      { source: read.nodes[0].key, target: 'ok' },
      { source: 'ok', sourcePort: 'approved', target: 'yes' },
      { source: 'ok', sourcePort: 'rejected', target: 'no' },
    ],
  });
  await reply(page, assistant.runId, 'Done.');
  const panel = page.getByRole('dialog', { name: 'Workflow' });
  await expect(panel.locator('.workflow-card')).toHaveCount(4);
  // With nothing to choose, Run starts at once, and the run shows in the workflow's place.
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.locator('.run-status')).toHaveText('Running');
  await expect(panel.getByRole('button', { name: 'Back to the workflow' })).toBeVisible();
  // While it runs, it leads the Active list.
  await expect(page.locator('.workflow-run-item').filter({ hasText: 'Poster' })).toBeVisible();
  // The run asks for approval with the step's own buttons.
  const waiting = panel.getByRole('region', { name: 'Waiting for you' });
  await waiting.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(panel.locator('.run-status')).toHaveText('Completed');
  await expect(panel.getByRole('region', { name: 'Run', exact: true })).toContainText('published');
  // Its history lists each step as it ran, in order, each opening on what it did.
  const history = panel.getByRole('region', { name: 'History' });
  await expect(history.locator('.entry-title > span')).toHaveText([
    'Manual',
    'ok',
    'yes',
    'Completed',
  ]);
  await expect(history.locator('.entry').nth(1)).toContainText('Approved');
  await history.locator('.entry-head').nth(2).click();
  await expect(history.locator('.entry').nth(2)).toContainText('published');
  // Choosing a step on the graph shows its entries alone.
  await panel.locator('.workflow-card').filter({ hasText: 'ok' }).click();
  await expect(history.locator('.entry')).toHaveCount(1);
  await history.getByRole('button', { name: 'Show the whole history' }).click();
  await expect(history.locator('.entry')).toHaveCount(4);
  await expect(page.locator('.workflow-run-item')).toHaveCount(0);
  // Back, the workflow keeps its runs beside Run; the Workflows page lists it among what ran.
  await panel.getByRole('button', { name: 'Back to the workflow' }).click();
  await expect(panel.locator('.workflow-card')).toHaveCount(4);
  await panel.getByRole('combobox', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Completed');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Workflows/ }).click();
  const recent = page.locator('.run-row').filter({ hasText: 'Poster' });
  await expect(recent).toContainText('Completed');
  await expect(page.locator('.workflow-tile').filter({ hasText: 'Poster' })).toContainText(
    'Completed',
  );
  // A run opens in its workflow's panel again.
  await recent.click();
  await expect(panel.locator('.run-status')).toHaveText('Completed');
});

test('a dynamic workflow starts from a chat and its orchestrator works in it', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await newWorkflowChat(page);
  await page.getByRole('radio', { name: 'Dynamic' }).click();
  await expect(page.getByRole('heading', { name: /the goal\?/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Runs on/ })).toBeVisible();
  await send(page, 'Make every asset of the game, reviewed.');
  // The chat is its orchestrator: your words are its first message, its role its instructions.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [orchestrator] = await requests(page);
  expect(orchestrator.mission?.role).toBe('orchestrator');
  expect(orchestrator.messages.at(-1)?.text).toBe('Make every asset of the game, reviewed.');
  expect(orchestrator.agent.instructions).toMatch(/orchestrator of an Agent Studio dynamic workflow/);
  const panel = page.getByRole('dialog', { name: 'Workflow' });
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  // It plans and starts an agent while its turn runs.
  const plan = await call(page, orchestrator, 'dynamic_plan', {
    tasks: [{ id: 'sword', title: 'Sword model' }],
  });
  expect(plan.error).toBe(false);
  const spawned = await call(page, orchestrator, 'dynamic_spawn', {
    title: 'Sword',
    task: 'Model the sword.',
    taskId: 'sword',
  });
  expect(spawned.error).toBe(false);
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const worker = (await requests(page))[1];
  expect(worker.mission).toBeUndefined();
  await expect(panel.locator('.workflow-card').filter({ hasText: 'Sword model' })).toBeVisible();
  // While it runs, it leads the Active list.
  await page.getByRole('tab', { name: /^Active/ }).click();
  await expect(
    page.locator('.workflow-run-item').filter({ hasText: 'Make every asset of the game' }),
  ).toBeVisible();
  // The agent's chat asks you something: the run shows it, with no alert of the chat's own.
  await page.evaluate((runId) => {
    const w = window as any;
    w.testQuestion = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'style',
          header: 'Style',
          question: 'Which style?',
          multiSelect: false,
          options: [{ label: 'Flat', description: '' }],
        },
      ],
    };
    w.capabilityRuns[runId].emit({ kind: 'question', question: w.testQuestion });
  }, worker.runId);
  const waiting = panel.getByRole('region', { name: 'Waiting for you' });
  await expect(waiting).toContainText('Sword');
  await waiting.getByRole('radio', { name: 'Flat' }).check();
  await waiting.getByRole('button', { name: 'Send answers' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).answersSent?.length ?? 0)).toBe(1);
  await expect(waiting).toHaveCount(0);
  const notices = await page.evaluate(() => JSON.parse(localStorage.getItem('test-notices') ?? '[]'));
  expect(notices.filter((n: any) => n.conversationId === worker.conversationId)).toEqual([]);
  // Its chat is the workflow's: you read it there, without a composer.
  await panel.getByRole('button', { name: 'Open the chat of Sword' }).click();
  await expect(page.locator('.workflow-owned')).toContainText('Make every asset of the game');
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  await page.locator('.workflow-owned').getByRole('button', { name: 'Open workflow' }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await expect(panel.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  // Another chat's call of an orchestrator's tool is refused.
  const foreign = await call(
    page,
    { ...orchestrator, conversationId: worker.conversationId },
    'dynamic_state',
    {},
  );
  expect(foreign.error).toBe(true);
  await reply(page, orchestrator.runId, 'Started the sword.');
  await reply(page, worker.runId, 'The sword is in assets/sword.glb.');
  // The orchestrator hears the agent's reply in its next turn, shown in its chat as an update.
  await expect.poll(async () => (await requests(page)).length, { timeout: 15_000 }).toBe(3);
  const wake = (await requests(page))[2];
  expect(wake.conversationId).toBe(orchestrator.conversationId);
  expect(wake.messages.at(-1)?.text).toContain('The sword is in assets/sword.glb.');
  await expect(page.locator('.workflow-update')).toHaveCount(1);
  // Its summary leaves out the chat id written for the orchestrator.
  await expect(page.locator('.workflow-update summary')).toHaveText(
    /^\S+ Agent "Sword" finished\.$/,
  );
  const done = await call(page, wake, 'dynamic_complete', { summary: 'The sword is done.' });
  expect(done.error).toBe(false);
  await expect(panel.locator('.run-status')).toHaveText('Completed');
  // Its history shows the agent's reply where it finished.
  const history = panel.getByRole('region', { name: 'History' });
  const finished = history.locator('.entry').filter({ hasText: 'Sword finished' });
  await finished.locator('.entry-head').click();
  await expect(finished).toContainText('The sword is in assets/sword.glb.');
  // Its chats stay out of the Active list, which it left once it ended; the workflow is on the
  // Workflows page.
  await page.getByRole('tab', { name: /^Active/ }).click();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  await page.getByRole('button', { name: /^Workflows/ }).click();
  await expect(
    page.locator('.run-row').filter({ hasText: 'Make every asset of the game, reviewed.' }),
  ).toContainText('Completed');
});
