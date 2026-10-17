import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// Workflows (docs/WORKFLOWS.md): the editor, a static run and a mission, on the desktop mock,
// whose replies wait until a test finishes them and whose workflow store lives in local storage.

type Request = {
  runId: string;
  conversationId: string;
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

test('builds a workflow in the editor and runs it, keeping its chat out of the chat lists', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Workflow', exact: true }).click();
  await page.getByLabel('Workflow name').fill('Topic writer');
  // Start takes an input.
  await page.locator('.svelte-flow__node').filter({ hasText: 'Start' }).click();
  await page.getByRole('button', { name: 'Add input' }).click();
  await page.getByLabel('Name', { exact: true }).fill('topic');
  // An agent step writes about it, and an End step hands on its answer.
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('menuitem', { name: 'Agent' }).click();
  await expect(page.locator('.workflow-card')).toHaveCount(2);
  await page.getByLabel('Prompt').fill('Write about {{input.topic}}.');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('menuitem', { name: 'End' }).click();
  await page.getByLabel('Output').fill('{{agent_1.output}}');
  await expect(page.locator('.workflow-card')).toHaveCount(3);
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run Topic writer' });
  await dialog.getByLabel('topic', { exact: true }).fill('swords');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  // The run's agent chat starts with the step's prompt.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [agent] = await requests(page);
  expect(agent.messages.at(-1)?.text).toBe('Write about swords.');
  expect(agent.mission).toBeUndefined();
  await expect(page.locator('.workflow-card.status-running')).toHaveCount(1);
  await expect(page.locator('.run-status')).toHaveText('Running');
  // It stays out of the Active list and the pending badge.
  await page.getByRole('tab', { name: /^Active/ }).click();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
  await reply(page, agent.runId, 'Swords are sharp.');
  await expect(page.locator('.run-status')).toHaveText('Completed');
  await page.locator('.run-panel').getByRole('tab', { name: 'Details' }).click();
  await expect(page.locator('.run-panel')).toContainText('Swords are sharp.');
  // Its chat opens from the graph, under a note naming its workflow.
  await page.locator('.workflow-card').getByRole('button', { name: /^Open the chat of/ }).click();
  await expect(page.locator('.workflow-banner')).toContainText('Topic writer');
  await page.locator('.workflow-banner').getByRole('button', { name: 'Open workflow' }).click();
  await expect(page.locator('.run-status')).toHaveText('Completed');
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
});

test('a mission briefs its orchestrator, which plans, starts agents and hears their replies', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Mission', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New mission' });
  await dialog.getByLabel('Mission', { exact: true }).fill('Make every asset of the game, reviewed.');
  await dialog.getByLabel('Title', { exact: true }).fill('Game assets');
  await dialog.getByRole('button', { name: 'Start mission' }).click();
  // The orchestrator's chat starts with the brief and the mission tools.
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  const [orchestrator] = await requests(page);
  expect(orchestrator.mission?.role).toBe('orchestrator');
  expect(orchestrator.messages.at(-1)?.text).toContain('# Mission: Game assets');
  await expect(page.locator('.workflow-card.kind-orchestrator')).toBeVisible();
  // It plans and starts an agent while its turn runs.
  const plan = await call(page, orchestrator, 'mission_plan', {
    tasks: [{ id: 'sword', title: 'Sword model' }],
  });
  expect(plan.error).toBe(false);
  const spawned = await call(page, orchestrator, 'mission_spawn', {
    title: 'Sword',
    task: 'Model the sword.',
    taskId: 'sword',
  });
  expect(spawned.error).toBe(false);
  expect(JSON.parse(spawned.text)).toMatchObject({ status: 'running' });
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  const worker = (await requests(page))[1];
  expect(worker.mission).toBeUndefined();
  expect(worker.messages.at(-1)?.text).toContain('## Your task\nModel the sword.');
  await expect(page.locator('.workflow-card').filter({ hasText: 'Sword model' })).toContainText(
    'Sword',
  );
  // Another chat's call of a mission tool is refused.
  const foreign = await call(
    page,
    { ...orchestrator, conversationId: worker.conversationId },
    'mission_state',
    {},
  );
  expect(foreign.error).toBe(true);
  await reply(page, orchestrator.runId, 'Started the sword.');
  await reply(page, worker.runId, 'The sword is in assets/sword.glb.');
  // The orchestrator hears the agent's reply in its next turn.
  await expect.poll(async () => (await requests(page)).length, { timeout: 15_000 }).toBe(3);
  const wake = (await requests(page))[2];
  expect(wake.conversationId).toBe(orchestrator.conversationId);
  expect(wake.mission?.runId).toBe(orchestrator.mission?.runId);
  expect(wake.messages.at(-1)?.text).toContain('Agent "Sword"');
  expect(wake.messages.at(-1)?.text).toContain('The sword is in assets/sword.glb.');
  const done = await call(page, wake, 'mission_complete', { summary: 'The sword is done.' });
  expect(done.error).toBe(false);
  await expect(page.locator('.run-status')).toHaveText('Completed');
  // Its chats stay out of the Active list.
  await page.getByRole('tab', { name: /^Active/ }).click();
  await expect(page.locator('#conversation-panel-active .conversation-item')).toHaveCount(0);
});
