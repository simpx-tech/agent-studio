import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// Workflows that follow things up over many runs (docs/WORKFLOWS.md): the Review requests
// template's Watch trigger looks at a command's list of pull requests, starts a run for each that
// is new or changed, reviews each in a chat of yours kept for it across runs, and skips a change
// while that pull request's run still waits; and a Command step's output reaches the next step.

type Request = {
  runId: string;
  conversationId: string;
  messages: { role: string; text: string }[];
};
const requests = (page: Page) =>
  page.evaluate(() => ((window as any).runRequests ?? []) as Request[]);
async function reply(page: Page, runId: string, text: string) {
  await page.evaluate(
    ({ runId, text }) => {
      const run = (window as any).capabilityRuns[runId];
      run.emit({ kind: 'text', text });
      run.finish('complete');
    },
    { runId, text },
  );
}
const workflowMode = (page: Page) => page.getByRole('tab', { name: /^Workflow/ });
const agentMode = (page: Page) => page.getByRole('tab', { name: 'Agent', exact: true });
async function newWorkflowChat(page: Page) {
  const tab = workflowMode(page);
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await page.getByRole('button', { name: 'New workflow' }).click();
}
/** The pull requests the mocked `gh` lists, one JSON object a line. */
async function listPulls(page: Page, pulls: { number: number; title: string; head: string }[]) {
  await page.evaluate((pulls) => {
    (window as any).pulls = pulls.map((pull) => ({
      url: `https://github.com/o/app/pull/${pull.number}`,
      number: pull.number,
      title: pull.title,
      repository: 'o/app',
      author: 'ana',
      head: pull.head,
      requested: true,
      reviewed: '',
      version: `${pull.head} `,
    }));
  }, pulls);
}
const lastText = (request: Request) => request.messages.at(-1)?.text ?? '';
/** A new static workflow whose assistant saved these steps, its graph on screen. */
async function savedWorkflow(
  page: Page,
  name: string,
  nodes: (start: Record<string, unknown>) => unknown[],
  edges: (start: string) => unknown[],
) {
  await newWorkflowChat(page);
  await page.getByLabel('Message', { exact: true }).fill(`Make ${name}.`);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(1);
  const [assistant] = (await page.evaluate(() => (window as any).runRequests)) as (Request & {
    agent: { instructions: string };
  })[];
  const workflowId = assistant.agent.instructions.match(/workflow ([0-9a-f-]{36})/)![1];
  const answer = async (tool: string, input: unknown) => {
    const id = crypto.randomUUID();
    await page.evaluate((call) => (window as any).emitTauriEvent('studio-workflow-call', call), {
      id,
      runId: assistant.runId,
      conversationId: assistant.conversationId,
      connectionId: null,
      tool,
      input,
      mission: null,
    });
    await expect
      .poll(() =>
        page.evaluate(
          (id) => ((window as any).workflowAnswers ?? []).some((a: any) => a.id === id),
          id,
        ),
      )
      .toBe(true);
    return page.evaluate(
      (id) => ((window as any).workflowAnswers ?? []).find((a: any) => a.id === id),
      id,
    );
  };
  const read = JSON.parse((await answer('workflow_read', { id: workflowId })).text);
  const saved = await answer('workflow_save', {
    id: workflowId,
    revision: read.revision,
    name,
    nodes: nodes(read.nodes[0]),
    edges: edges(read.nodes[0].key),
  });
  expect(saved.error).toBe(false);
  await reply(page, assistant.runId, 'Done.');
  return workflowId;
}

test('Review requests reviews each pull request in a chat of yours and follows it up', async ({
  page,
}) => {
  await page.clock.install();
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(() => {
    const w = window as any;
    w.workflowCommandResult = () => ({
      stdout: (w.pulls ?? []).map((pull: unknown) => JSON.stringify(pull)).join('\n'),
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 20_000 });
  await listPulls(page, [
    { number: 1, title: 'Fix login', head: 'h1' },
    { number: 2, title: 'Add cache', head: 'h2' },
  ]);
  await newWorkflowChat(page);
  await page
    .getByRole('group', { name: 'Start from' })
    .getByRole('button', { name: 'Review requests' })
    .click();
  const graph = page.locator('.workflow-main');
  await expect(graph.locator('.workflow-card')).toHaveCount(5);
  await expect(graph.locator('.workflow-card').first()).toContainText('Every 5 minutes');

  // Its trigger looks at once and starts a run for each pull request already waiting, whose
  // review chat is one of yours.
  await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(2);
  const commands = await page.evaluate(() => (window as any).workflowCommands);
  expect(commands[0]).toMatchObject({ op: 'command', shell: 'bash', folder: '' });
  expect(commands[0].script).toContain('gh api graphql');
  const reviews = await requests(page);
  const first = reviews.find((r) => lastText(r).includes('/pull/1'))!;
  const second = reviews.find((r) => lastText(r).includes('/pull/2'))!;
  expect(lastText(first)).toContain('o/app #1 by ana: Fix login');
  expect(first.conversationId).not.toBe(second.conversationId);
  await agentMode(page).click();
  const listed = page.locator('#conversation-panel-active .conversation-item:not(.workflow-run-item)');
  await expect(listed.filter({ hasText: '#1 Fix login' })).toHaveCount(1);
  await expect(listed.filter({ hasText: '#2 Add cache' })).toHaveCount(1);

  // The first has something to post and waits for approval; the second has nothing.
  await reply(page, first.runId, 'Draft: a comment on line 3.');
  await reply(page, second.runId, 'Nothing to post.');
  await workflowMode(page).click();
  await page.locator('.workflow-item').filter({ hasText: 'Review requests' }).click();
  await graph.getByRole('combobox', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Completed' })).toHaveCount(1);
  await expect(page.getByRole('option').filter({ hasText: 'Waiting for you' })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Both change. The first's change waits for its run; the second's is reviewed again in its
  // own chat, which remembers its first review.
  await listPulls(page, [
    { number: 1, title: 'Fix login', head: 'h1b' },
    { number: 2, title: 'Add cache', head: 'h2b' },
  ]);
  await page.clock.fastForward('05:10');
  await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(3);
  const again = (await requests(page))[2];
  expect(again.conversationId).toBe(second.conversationId);
  expect(lastText(again)).toContain('Head commit h2b');
  await reply(page, again.runId, 'Nothing to post.');

  // Approved, the review is posted from the first's chat.
  await graph.getByRole('combobox', { name: 'Runs', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Waiting for you' }).click();
  const history = graph.getByRole('button', { name: 'History', exact: true });
  if ((await history.getAttribute('aria-pressed')) !== 'true') await history.click();
  await graph
    .getByRole('region', { name: 'Waiting for you' })
    .getByRole('button', { name: 'Post', exact: true })
    .click();
  await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(4);
  const post = (await requests(page))[3];
  expect(post.conversationId).toBe(first.conversationId);
  expect(lastText(post)).toContain('Approved. Post what you drafted now with gh');
  await reply(page, post.runId, 'Posted the review.');
  await expect(graph.locator('.run-status')).toHaveText('Completed');

  // Its run ended, the first's change starts a run at the next look, in its chat again.
  await page.clock.fastForward('05:10');
  await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(5);
  const followUp = (await requests(page))[4];
  expect(followUp.conversationId).toBe(first.conversationId);
  expect(lastText(followUp)).toContain('Head commit h1b');
  // The trigger's settings say what its last look found.
  await graph.getByRole('button', { name: 'Back to the workflow' }).click();
  await graph.locator('.workflow-card').first().click();
  await expect(page.locator('.workflow-inspector')).toContainText('2 items');
});

test('a Command step runs its script with values as variables and hands on its output', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(() => {
    (window as any).workflowCommandResult = (request: any) => ({
      stdout: JSON.stringify({ repo: request.params?.repo, count: 2 }),
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 20_000 });
  await savedWorkflow(
    page,
    'Counter',
    (start) => [
      { ...start, config: { trigger: 'manual' } },
      {
        key: 'count',
        type: 'command',
        title: 'Count',
        config: {
          script: 'gh pr list --repo "$PARAM_REPO" | wc -l',
          params: { repo: '{{run.title}}' },
        },
      },
      { key: 'end', type: 'end', config: { output: '{{count.json.repo}} has {{count.json.count}}' } },
    ],
    (start) => [
      { source: start, target: 'count' },
      { source: 'count', target: 'end' },
    ],
  );
  const graph = page.locator('.workflow-main');
  await expect(graph.locator('.workflow-card')).toHaveCount(3);
  await expect(graph.locator('.workflow-card').nth(1)).toContainText('gh pr list');
  // Its settings show the script as written and its values apart.
  await graph.locator('.workflow-card').nth(1).click();
  const inspector = page.locator('.workflow-inspector');
  await expect(inspector.getByLabel('Command', { exact: true })).toHaveValue(
    'gh pr list --repo "$PARAM_REPO" | wc -l',
  );
  await expect(inspector.getByRole('group', { name: 'Values as PARAM_<NAME>' })).toBeVisible();
  await inspector.getByRole('button', { name: 'Close step settings' }).click();
  await graph.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(graph.locator('.run-status')).toHaveText('Completed');
  await graph.getByRole('button', { name: 'History', exact: true }).click();
  await expect(graph.getByRole('region', { name: 'Run', exact: true })).toContainText(
    'Counter has 2',
  );
  const commands = await page.evaluate(() => (window as any).workflowCommands);
  // The script never holds a value: the value goes as its own variable.
  expect(commands).toEqual([
    expect.objectContaining({
      op: 'command',
      script: 'gh pr list --repo "$PARAM_REPO" | wc -l',
      params: { repo: 'Counter' },
    }),
  ]);
});

test('a trigger that waits for its earlier run starts the next once that run ended', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible({ timeout: 20_000 });
  await savedWorkflow(
    page,
    'Releases',
    (start) => [
      {
        ...start,
        title: 'Chat',
        config: { trigger: 'chat', chat: { events: ['completed'] }, overlap: 'queue' },
      },
      { key: 'ok', type: 'confirm', config: { question: 'Ship {{trigger.json.reply}}?', approve: 'Ship' } },
    ],
    (start) => [{ source: start, target: 'ok' }],
  );
  const runRows = page.locator('#conversation-panel-active .workflow-run-item');
  // A reply ending in a chat of yours starts a run, which waits for approval.
  await agentMode(page).click();
  const say = async (text: string, answer: string) => {
    const before = (await requests(page)).length;
    await page.getByLabel('Message', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => (await requests(page)).length, { timeout: 20_000 }).toBe(before + 1);
    // The trigger fires on a change it sees: it must see the reply running before it ends.
    await page.waitForTimeout(5_000);
    await reply(page, (await requests(page))[before].runId, answer);
  };
  await say('Build one.', 'v1');
  await expect(runRows).toHaveCount(1, { timeout: 20_000 });
  // Another reply while that run waits starts nothing yet.
  await say('Build two.', 'v2');
  await page.waitForTimeout(5_000);
  await expect(runRows).toHaveCount(1);
  // Approved, the run ends and the waiting event starts its run.
  await runRows.first().click();
  const graph = page.locator('.workflow-main');
  const history = graph.getByRole('button', { name: 'History', exact: true });
  if ((await history.getAttribute('aria-pressed')) !== 'true') await history.click();
  const waiting = graph.getByRole('region', { name: 'Waiting for you' });
  await expect(waiting).toContainText('Ship v1?');
  await waiting.getByRole('button', { name: 'Ship', exact: true }).click();
  await expect(graph.locator('.run-status')).toHaveText('Completed');
  await graph.getByRole('button', { name: 'Back to the workflow' }).click();
  await graph.getByRole('combobox', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole('option').filter({ hasText: 'Waiting for you' }).click();
  if ((await history.getAttribute('aria-pressed')) !== 'true') await history.click();
  await expect(graph.getByRole('region', { name: 'Waiting for you' })).toContainText('Ship v2?');
});
