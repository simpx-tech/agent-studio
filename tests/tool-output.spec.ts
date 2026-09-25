import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// A 2×1 PNG: one red and one blue pixel.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC';

type Tool = Record<string, unknown> & { id: string };
const tool = (fields: Tool) => ({
  category: 'tool',
  revision: 1,
  status: 'running',
  facts: [],
  sources: [],
  agents: [],
  ...fields,
});
const calls: Tool[] = [
  {
    id: 'claude:git-status',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: 'git status --short',
    shell: 'bash',
    detail: 'Show working tree status',
  },
  {
    id: 'claude:git-diff',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: 'git diff --stat',
    shell: 'bash',
  },
  {
    id: 'claude:tests',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: 'npm test -- --run',
    shell: 'powershell',
  },
  { id: 'claude:read', name: 'Read', operation: 'read', path: 'C:\\Projects\\studio\\src\\app.ts' },
  { id: 'claude:shot', name: 'View image', operation: 'viewImage', path: 'C:\\tmp\\shot.png' },
  {
    id: 'claude:docs',
    name: 'mcp__docs__search',
    input: '{\n  "query": "layout"\n}',
  },
  {
    id: 'claude:quiet',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: 'true',
  },
  {
    id: 'claude:build',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: 'npm run build',
  },
  {
    id: 'claude:heredoc',
    name: 'Run command',
    operation: 'command',
    commandRun: true,
    command: "cat <<'EOF' > notes.md",
    commandTruncated: true,
  },
];
const buildLog = Array.from({ length: 3000 }, (_, i) => `module ${i} built\n`).join('');
const outputs = {
  'claude:git-status': { stdout: ' M src/app.ts\n?? notes.md\n', exitCode: 0 },
  'claude:git-diff': { stdout: ' src/app.ts | 2 +-\n', exitCode: 0 },
  'claude:tests': {
    stdout: 'RUN v4\n<script>window.outputExecuted = true</script>\n',
    stderr: 'FAIL src/a.test.ts\n',
    exitCode: 1,
  },
  'claude:read': { stdout: 'const a = 1;\nexport default a;\n', startLine: 10 },
  'claude:shot': {
    images: [{ mediaType: 'image/png', data: png, bytes: 72, width: 2, height: 1 }],
  },
  'claude:docs': { stdout: 'Layout guide\n' },
  // The host previews long streams by their ends and returns them whole on request.
  'claude:build': {
    stdout: buildLog,
    previewStdout: 'module 0 built\n[… 51 KB not shown …]\nmodule 2999 built\n',
    exitCode: 0,
  },
  // A command the saved record shortened comes whole from the host.
  'claude:heredoc': { command: "cat <<'EOF' > notes.md\nThe complete note body\nEOF" },
};
const summaries: Record<string, object> = {
  'claude:git-status': { lines: 2, bytes: 26, exitCode: 0 },
  'claude:git-diff': { lines: 1, bytes: 19, exitCode: 0 },
  'claude:tests': { lines: 3, bytes: 64, stderr: true, exitCode: 1 },
  'claude:read': { lines: 2, bytes: 31 },
  'claude:shot': { lines: 0, bytes: 0, images: 1 },
  'claude:docs': { lines: 1, bytes: 13 },
  'claude:quiet': { lines: 0, bytes: 0, exitCode: 0 },
  'claude:build': { lines: 3000, bytes: buildLog.length, exitCode: 0 },
  'claude:heredoc': { lines: 0, bytes: 0, exitCode: 0 },
};

async function startReply(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await page.getByLabel('Message', { exact: true }).fill('Check the project');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate((outputs) => ((window as any).toolOutputs = outputs), outputs);
}
const emit = (page: Page, event: unknown) =>
  page.evaluate((event) => (window as any).emitCapability(event), event);
async function emitCalls(page: Page) {
  for (const [index, call] of calls.entries()) {
    await emit(page, { kind: 'tool', tool: tool(call) });
    if (index === 1)
      await emit(page, {
        kind: 'progress',
        id: 'between',
        revision: 1,
        text: 'Now the tests.',
      });
  }
  for (const call of calls)
    await emit(page, {
      kind: 'tool',
      tool: tool({ ...call, revision: 2, status: 'complete', output: summaries[call.id] }),
    });
}
const card = (page: Page, text: string) =>
  page.locator('.tool-card').filter({ has: page.locator('summary', { hasText: text }) });
const outputCalls = (page: Page) =>
  page.evaluate(() => ((window as any).toolOutputCalls ?? []).map((c: any) => c.toolId));

for (const mobile of [false, true]) {
  test(`tool calls show commands, icons and their outputs ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await startReply(page);
    await emitCalls(page);
    const groups = page.locator('.activity-group');
    await expect(groups).toHaveCount(2);
    // A run of git commands shares the Git icon; mixed kinds fall back to the command icon.
    await expect(groups.nth(0).locator(':scope > summary [data-icon]')).toHaveAttribute(
      'data-icon',
      'git',
    );
    await expect(groups.nth(0).locator(':scope > summary')).toContainText('Ran 2 commands');
    await expect(groups.nth(1).locator(':scope > summary [data-icon]')).toHaveAttribute(
      'data-icon',
      'terminal',
    );
    await expect(groups.nth(1).locator(':scope > summary')).toContainText('viewed 1 image');
    await groups.nth(0).locator(':scope > summary').click();
    const status = card(page, 'Show working tree status');
    await expect(status.locator('summary [data-icon]')).toHaveAttribute('data-icon', 'git');
    await expect(status.locator('.query-preview')).toHaveText('git status --short');
    await expect(card(page, 'git diff --stat').locator('.tool-label.code')).toHaveText(
      'git diff --stat',
    );
    // Results are read only when a call is opened.
    expect(await outputCalls(page)).toEqual([]);
    await status.locator('summary').click();
    const result = status.getByTestId('tool-result');
    await expect(result.getByRole('region', { name: 'Command text', exact: true })).toHaveText(
      /\$\s*git status --short/,
    );
    await expect(result.getByRole('region', { name: 'Output text', exact: true })).toContainText(
      'M src/app.ts',
    );
    await expect(result.locator('.exit-code')).toHaveText('Exit code 0');
    expect(await outputCalls(page)).toEqual(['claude:git-status']);
    const runId = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).runId,
    );
    expect(await page.evaluate(() => (window as any).toolOutputCalls[0].runId)).toBe(runId);

    await groups.nth(1).locator(':scope > summary').click();
    const tests = card(page, 'npm test -- --run');
    await expect(tests.locator('summary [data-icon]')).toHaveAttribute('data-icon', 'test');
    await tests.locator('summary').click();
    await expect(tests.locator('.result-title').first()).toHaveText('PowerShell');
    await expect(tests.locator('.prompt')).toHaveText('PS>');
    await expect(tests.getByRole('region', { name: 'Output text', exact: true })).toContainText(
      '<script>window.outputExecuted = true</script>',
    );
    await expect(
      tests.getByRole('region', { name: 'Error output text', exact: true }),
    ).toContainText('FAIL src/a.test.ts');
    await expect(tests.locator('.exit-code.failed')).toHaveText('Exit code 1');
    await expect(tests.locator('.stream-label.failed')).toHaveText('Standard error');
    expect(await page.evaluate(() => (window as any).outputExecuted)).toBeUndefined();

    const read = card(page, 'src/app.ts');
    await expect(read.locator('summary [data-icon]')).toHaveAttribute('data-icon', 'code');
    await read.locator('summary').click();
    await expect(read.locator('.result-title')).toHaveText('File content');
    await expect(read.locator('.gutter')).toHaveText('10\n11');
    await expect(read.locator('.hljs-keyword').first()).toHaveText('const');

    const shot = card(page, 'View image');
    await expect(shot.locator('summary [data-icon]')).toHaveAttribute('data-icon', 'image');
    await shot.locator('summary').click();
    const image = shot.locator('.result-image img');
    await expect(image).toBeVisible();
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
    await shot.getByRole('button', { name: /Open image 1/ }).click();
    const preview = page.getByRole('dialog', { name: 'Image preview' });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('2 × 1');
    await preview.getByRole('button', { name: 'Close image preview' }).click();
    await expect(preview).toBeHidden();

    // A failed read explains itself and can be retried.
    await page.evaluate(() => ((window as any).failToolOutput = 'The computer is offline.'));
    const docs = card(page, 'search');
    await expect(docs.locator('summary [data-icon]')).toHaveAttribute('data-icon', 'plug');
    await docs.locator('summary').click();
    await expect(docs.getByRole('region', { name: 'Input text', exact: true })).toContainText(
      '"layout"',
    );
    await expect(docs.getByRole('alert')).toContainText('The computer is offline.');
    await page.evaluate(() => delete (window as any).failToolOutput);
    await docs.getByRole('button', { name: 'Retry' }).click();
    await expect(docs.getByRole('region', { name: 'Output text', exact: true })).toContainText(
      'Layout guide',
    );

    // An empty result needs no request.
    const quiet = card(page, 'true');
    await quiet.locator('summary').click();
    await expect(quiet.locator('.result-meta')).toHaveText('No output');
    expect(await outputCalls(page)).not.toContain('claude:quiet');

    // A long result shows its ends until the whole of it is asked for.
    const build = card(page, 'npm run build');
    await build.locator('summary').click();
    const log = build.getByRole('region', { name: 'Output text', exact: true });
    await expect(log).toContainText('module 2999 built');
    await expect(log).not.toContainText('module 1500 built');
    await build.getByRole('button', { name: 'Show full output' }).click();
    await expect(log).toContainText('module 1500 built');
    await expect(build.getByRole('button', { name: 'Show full output' })).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        (window as any).toolOutputCalls
          .filter((call: any) => call.toolId === 'claude:build')
          .map((call: any) => !!call.full),
      ),
    ).toEqual([false, true]);

    // A command the saved record shortened is shown whole.
    const heredoc = card(page, "cat <<'EOF' > notes.md");
    await heredoc.locator('summary').click();
    await expect(heredoc.getByRole('region', { name: 'Command text', exact: true })).toContainText(
      'The complete note body',
    );
    await expect(heredoc.locator('.result-meta', { hasText: 'Shortened' })).toHaveCount(0);

    expect(
      await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/tool-output/live-${mobile ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    });

    await emit(page, { kind: 'text', text: 'Checked.' });
    await page.evaluate(() => (window as any).finishCapabilities('complete'));
    // Commands and sizes are saved with the reply; outputs stay on the computer that ran it.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
              .status,
        ),
      )
      .toBe('complete');
    const saved = await page.evaluate(() => localStorage.getItem('test-workspace')!);
    expect(saved).toContain('git status --short');
    expect(saved).not.toContain('M src/app.ts');
    expect(saved).not.toContain('FAIL src/a.test.ts');

    await page.reload();
    await page.evaluate((outputs) => ((window as any).toolOutputs = outputs), outputs);
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item').first().click();
    await page.getByLabel('Work history', { exact: true }).click();
    await page.locator('.activity-group').nth(0).locator(':scope > summary').click();
    const restored = card(page, 'Show working tree status');
    await restored.locator('summary').click();
    await expect(restored.getByRole('region', { name: 'Output text', exact: true })).toContainText(
      'M src/app.ts',
    );
    await page.screenshot({
      path: `artifacts/tool-output/history-${mobile ? 'mobile' : 'desktop'}.png`,
    });
  });
}

test('a result is loaded once, waits while the host reads it, and missing results explain why', async ({
  page,
}) => {
  await startReply(page);
  await emit(page, { kind: 'tool', tool: tool({ ...calls[0], status: 'running' }) });
  await page.locator('.activity-group > summary').click();
  const status = card(page, 'Show working tree status');
  await status.locator('summary').click();
  // While the command runs there is nothing to read yet.
  await expect(status.getByTestId('tool-result')).toContainText(
    'The output appears when the command finishes.',
  );
  await page.evaluate(() => ((window as any).holdToolOutput = true));
  await emit(page, {
    kind: 'tool',
    tool: tool({ ...calls[0], revision: 2, status: 'complete', output: summaries[calls[0].id] }),
  });
  await expect(status.getByRole('status')).toHaveText('Loading output…');
  await page.evaluate(() => {
    (window as any).holdToolOutput = false;
    (window as any).releaseToolOutput();
  });
  await expect(status.getByRole('region', { name: 'Output text', exact: true })).toContainText(
    'M src/app.ts',
  );
  // Collapsing and reopening, or a later revision, uses the loaded result.
  await status.locator('summary').click();
  await status.locator('summary').click();
  await emit(page, {
    kind: 'tool',
    tool: tool({ ...calls[0], revision: 3, status: 'complete', output: summaries[calls[0].id] }),
  });
  await expect(status.getByRole('region', { name: 'Output text', exact: true })).toContainText(
    'M src/app.ts',
  );
  expect(await outputCalls(page)).toEqual(['claude:git-status']);
  await emit(page, {
    kind: 'tool',
    tool: tool({
      ...calls[1],
      status: 'complete',
      output: { lines: 1, bytes: 10 },
      id: 'claude:pruned',
    }),
  });
  const pruned = card(page, 'git diff --stat');
  await pruned.locator('summary').click();
  await expect(pruned.getByRole('alert')).toContainText('was not kept on the computer that ran it');
});
