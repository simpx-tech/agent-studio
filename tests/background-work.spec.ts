import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

for (const mobile of [false, true])
  test(`background work is a toggle in its reply footer, never running in history ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await page.getByLabel('Message', { exact: true }).fill('Build the image and test it');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
    const command = (id: string, extra: Record<string, unknown>) =>
      emit({
        kind: 'tool',
        tool: {
          id,
          name: 'Run command',
          category: 'tool',
          operation: 'command',
          commandRun: true,
          revision: 1,
          status: 'complete',
          sources: [],
          agents: [],
          command: 'PRIVATE_COMMAND',
          ...extra,
        },
      });
    const build = (revision: number, status: string, elapsedMs: number) =>
      command('build', {
        detail: 'Build the Docker image',
        background: true,
        revision,
        status,
        elapsedMs,
      });
    await command('edit', {
      name: 'Edit',
      operation: 'edit',
      commandRun: false,
      path: '/fixture/Dockerfile',
    });
    await build(1, 'running', 793_000);
    await command('server', {
      detail: 'Start the preview server',
      background: true,
      status: 'running',
      elapsedMs: 5_000,
    });
    await emit({
      kind: 'tool',
      tool: {
        id: 'agents',
        name: 'Sub-agents',
        category: 'agent',
        revision: 1,
        status: 'running',
        sources: [],
        agents: [
          { id: 'reader', name: 'Review the Dockerfile', status: 'running', background: true },
        ],
      },
    });
    await emit({
      kind: 'progress',
      id: 'moved-on',
      revision: 1,
      text: 'The build runs in the background, so I will check the tests meanwhile.',
    });
    await command('tests', { detail: 'Run unit tests' });

    // A compact toggle beside the running reply's elapsed time; the composer stays uncluttered.
    const toggle = page.locator('.reply-footer .progress-toggle', { hasText: 'Background work' });
    await expect(toggle).toHaveText(/Background work\s*3/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.background-work')).toHaveCount(0);
    await expect(page.locator('.response-extras')).toHaveCount(0);
    const timer = await page.locator('.reply-footer .running-reply-time').boundingBox();
    const button = await toggle.boundingBox();
    expect(Math.abs(timer!.y + timer!.height / 2 - (button!.y + button!.height / 2))).toBeLessThan(
      4,
    );
    await toggle.click();
    const work = page.getByRole('region', { name: /Background work/ });
    const runs = work.locator('li');
    await expect(runs).toHaveText([
      /Build the Docker image\s*Command\s*13m 13s/,
      /Start the preview server\s*Command\s*5s/,
      /Review the Dockerfile\s*Sub-agent/,
    ]);
    expect(await work.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // History shows the launches as started work, without a spinner or a running clock.
    const group = page.locator('.activity-group').first();
    const heading = group.locator(':scope > summary');
    await expect(heading).toHaveText(
      'Edited 1 file, started 2 background tasks, and started 1 background sub-agent',
    );
    await expect(group.locator('.spinning')).toHaveCount(0);
    await expect(group.locator('.group-progress')).toHaveCount(0);
    await heading.click();
    const buildCard = group.locator('.tool-card', { hasText: 'Build the Docker image' });
    await expect(buildCard.locator('summary')).toContainText('In background');
    await expect(buildCard.locator('summary')).not.toContainText('13m');
    await buildCard.locator('summary').click();
    await expect(buildCard).toContainText('Background work below this reply tracks it.');
    const agentsCard = group.locator('.tool-card', { hasText: 'Sub-agents' });
    await agentsCard.locator(':scope > summary').click();
    await expect(agentsCard.locator('.subagent')).toContainText('In background');
    await page.screenshot({
      path: `artifacts/background-work/live-${mobile ? 'mobile' : 'desktop'}.png`,
    });

    // The host's clock advances in Background work; the outcome returns to history.
    await build(2, 'running', 794_000);
    await expect(runs.first()).toContainText('13m 14s');
    await build(3, 'complete', 800_000);
    await emit({
      kind: 'tool',
      tool: {
        id: 'agents',
        name: 'Sub-agents',
        category: 'agent',
        revision: 2,
        status: 'complete',
        sources: [],
        agents: [
          { id: 'reader', name: 'Review the Dockerfile', status: 'complete', background: true },
        ],
      },
    });
    await expect(toggle).toHaveText(/Background work\s*1/);
    await expect(runs).toHaveText([/Start the preview server\s*Command\s*5s/]);
    await expect(buildCard.locator('summary')).toContainText('13m 20s');
    await expect(buildCard.locator('summary')).toContainText('Completed');
    await expect(buildCard).toContainText('Ran in the background.');

    // A server left for the user ends with the reply as Left running.
    await emit({ kind: 'text', text: 'The image builds and the preview server is running.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    await expect(toggle).toHaveCount(0);
    await expect(work).toHaveCount(0);
    await page.getByLabel('Work history', { exact: true }).click();
    await heading.click();
    await expect(heading).toHaveText(
      'Edited 1 file, started 2 background tasks, and started 1 background sub-agent',
    );
    const server = group.locator('.tool-card', { hasText: 'Start the preview server' });
    await expect(server.locator('summary')).toContainText('Left running');
    await expect(server.locator('summary')).not.toContainText('5s');
    await server.locator('summary').click();
    await expect(server).toContainText(
      'Still running in the background when this reply ended. Its later outcome was not recorded.',
    );
    await page.screenshot({
      path: `artifacts/background-work/history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
      'PRIVATE_',
    );
  });

test('a stopped reply leaves background work unconfirmed and removes the card', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Start the build');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 'build',
        name: 'Run command',
        category: 'tool',
        commandRun: true,
        detail: 'Build the Docker image',
        background: true,
        revision: 1,
        status: 'running',
        elapsedMs: 9000,
        sources: [],
        agents: [],
      },
    }),
  );
  await page.locator('.reply-footer .progress-toggle', { hasText: 'Background work' }).click();
  await expect(page.locator('.background-work li')).toHaveText([
    /Build the Docker image\s*Command\s*9s/,
  ]);
  await page.evaluate(() => (window as any).finishCapabilities('cancelled'));
  await expect(page.locator('.background-work')).toHaveCount(0);
  await page.getByLabel('Work history', { exact: true }).click();
  const heading = page.locator('.activity-group > summary').last();
  await expect(heading).toContainText('1 background task');
  await expect(heading).toContainText('Outcome unconfirmed');
  await heading.click();
  await expect(page.locator('.tool-card summary').last()).toContainText('Outcome unconfirmed');
});

test('work left running stays listed after its reply and reports its outcome to history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(() => {
    const state = window as any,
      native = state.__TAURI_INTERNALS__;
    const invoke = native.invoke,
      transform = native.transformCallback;
    const callbacks = new Map<number, (value: unknown) => void>();
    let listener = 0;
    native.transformCallback = (fn: (value: unknown) => void) => {
      const id = transform(fn);
      callbacks.set(id, fn);
      return id;
    };
    native.invoke = async (command: string, args: any) => {
      if (command === 'plugin:event|listen' && args.event === 'studio-background-work')
        listener = args.handler;
      if (command === 'background_work')
        return JSON.parse(localStorage.getItem('test-background-work') ?? '[]');
      return invoke(command, args);
    };
    state.hostBackground = (payload: unknown) =>
      callbacks.get(listener)!({ event: 'studio-background-work', id: 1, payload });
  });
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Start a preview server for me');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  const server = {
    id: 'claude:server',
    name: 'Run command',
    category: 'tool',
    operation: 'command',
    commandRun: true,
    detail: 'Start the preview server',
    background: true,
    revision: 1,
    status: 'running',
    elapsedMs: 5000,
    facts: [],
    sources: [],
    agents: [],
  };
  await page.evaluate((tool) => {
    (window as any).emitCapability({ kind: 'tool', tool });
    (window as any).emitCapability({ kind: 'text', text: 'The preview server is running.' });
    (window as any).finishCapabilities('complete');
  }, server);
  const ids = () =>
    page.evaluate(() => {
      const chat = JSON.parse(localStorage.getItem('test-workspace')!).conversations[0];
      return { conversationId: chat.id, runId: chat.messages.at(-1).runId };
    });
  await expect.poll(async () => (await ids()).runId).toBeTruthy();
  const { conversationId, runId } = await ids();
  const toggle = page.locator('.reply-footer .progress-toggle', { hasText: 'Background work' });
  const card = page.locator('.background-work');
  await expect(toggle).toHaveCount(0);
  // The host keeps the server listed after the reply ended, and its time keeps advancing.
  await page.evaluate((payload) => (window as any).hostBackground(payload), {
    kind: 'snapshot',
    conversationId,
    runs: [
      {
        id: server.id,
        runId,
        kind: 'command',
        label: server.detail,
        elapsedMs: 65_000,
        command: 'PRIVATE_COMMAND',
      },
    ],
  });
  // The finished reply's footer row keeps a toggle for the work it left running.
  await expect(page.locator('.message').last().locator('.reply-footer')).toContainText(
    'Background work',
  );
  await expect(toggle).toHaveText(/Background work\s*1/);
  await toggle.click();
  await expect(card.locator('li')).toHaveText([/Start the preview server\s*Command\s*1m 5s/]);
  await expect(card.locator('li')).toContainText('1m 6s', { timeout: 3000 });
  await page.getByLabel('Work history', { exact: true }).click();
  await page.locator('.activity-group > summary').first().click();
  const call = page.locator('.tool-card').first();
  await expect(call.locator('summary')).toContainText('Left running');
  // Another chat's list never appears here, and malformed events are ignored.
  await page.evaluate((payload) => (window as any).hostBackground(payload), {
    kind: 'snapshot',
    conversationId: crypto.randomUUID(),
    runs: [{ id: 'other', runId: 'other', kind: 'command', label: 'Other chat', elapsedMs: 1 }],
  });
  await page.evaluate((payload) => (window as any).hostBackground(payload), {
    kind: 'snapshot',
    conversationId,
    runs: [{ id: 'bad' }],
  });
  await expect(card.locator('li')).toHaveCount(1);
  await expect(card).not.toContainText('Other chat');
  // The CLI reports the outcome after the reply: history records it and the list empties.
  await page.evaluate(
    ({ tool, conversationId, runId }) => {
      const host = (window as any).hostBackground;
      host({
        kind: 'tool',
        conversationId,
        runId,
        tool: { ...tool, revision: 2, status: 'complete', elapsedMs: 70_000 },
      });
      host({ kind: 'snapshot', conversationId, runs: [] });
    },
    { tool: server, conversationId, runId },
  );
  await expect(toggle).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await expect(call.locator('summary')).toContainText('Completed');
  await expect(call.locator('summary')).toContainText('1m 10s');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-workspace')!)
            .conversations[0].messages.at(-1)
            .blocks.find((b: any) => b.tool)?.tool.status,
      ),
    )
    .toBe('complete');
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toContain(
    'PRIVATE_',
  );
  // A window that loads later asks the host for its current lists.
  await page.evaluate(
    (snapshot) => localStorage.setItem('test-background-work', JSON.stringify([snapshot])),
    {
      conversationId,
      runs: [
        { id: 'claude:watch', runId, kind: 'monitor', label: 'Build failures', elapsedMs: 1000 },
      ],
    },
  );
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(toggle).toHaveText(/Background work\s*1/);
  await toggle.click();
  await expect(card.locator('li')).toHaveText([/Build failures\s*Monitor\s*\d+s/]);
});
