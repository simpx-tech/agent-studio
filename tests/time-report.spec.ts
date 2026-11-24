import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { initialWorkspace, type Message } from '../src/lib/domain';

const call = (id: string, fields: Record<string, unknown>) => ({
  type: 'activity' as const,
  text: 'Bash',
  tool: {
    id,
    revision: 1,
    category: 'tool' as const,
    name: 'Bash',
    status: 'complete' as const,
    facts: [],
    sources: [],
    agents: [],
    ...fields,
  },
});

test('a reply’s timing panel reports where its time and the chat’s went @webkit', async ({
  page,
  context,
  browserName,
}) => {
  const copies = browserName === 'chromium';
  if (copies) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const workspace = initialWorkspace();
  const at = '2026-11-24T10:00:00.000Z';
  const runId = crypto.randomUUID();
  const reply = (fields: Partial<Message>): Message => ({
    id: crypto.randomUUID(),
    role: 'assistant',
    status: 'complete',
    createdAt: at,
    blocks: [{ type: 'markdown', text: 'Done.' }],
    ...fields,
  });
  const tests = { command: 'npm test', commandRun: true };
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Timed chat',
    archived: true,
    createdAt: at,
    updatedAt: at,
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    messages: [
      // Saved before time was recorded: its minute is the chat's, unexplained.
      reply({ durationMs: 60_000 }),
      reply({
        runId,
        durationMs: 600_000,
        timeSpent: {
          version: 1,
          revision: 2,
          runId,
          spent: {
            commands: 360_000,
            thinking: 150_000,
            calls: 60_000,
            waiting: 27_000,
            writing: 3000,
          },
          requests: 42,
          retries: 1,
        },
        blocks: [
          call('a', { ...tests, elapsedMs: 150_000 }),
          call('b', { ...tests, elapsedMs: 140_000, status: 'error' }),
          call('c', {
            name: 'Write',
            path: 'C:\\repo\\notes.md',
            elapsedMs: 30_400,
            writeMs: 30_000,
          }),
          ...Array.from({ length: 6 }, (_, i) =>
            call(`d${i}`, {
              command: `node step-${i}.mjs`,
              commandRun: true,
              elapsedMs: 9000 - i * 1000,
            }),
          ),
          { type: 'markdown', text: 'Done.' },
        ],
      }),
    ],
  });
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(
    (w) => localStorage.setItem('test-workspace', JSON.stringify(w)),
    workspace,
  );
  await page.goto('/');
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByText('Timed chat').click();
  const footer = page.locator('.reply-footer').last();
  const toggle = footer.getByRole('button', { name: 'Reply time, usage and cost', exact: true });
  const report = footer.locator('.time-report');
  // Nothing of it is in the page until its panel opens.
  await expect(report).toHaveCount(0);
  await toggle.click();
  await expect(report.getByRole('tab', { name: 'This response' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(report.locator('.report-total')).toHaveText('10m 0s · 42 model requests, 1 retried');
  const parts = report.locator('.parts li');
  await expect(parts).toHaveText([
    /^Commands\s*6m 0s\s*60%$/,
    /^Thinking\s*2m 30s\s*25%$/,
    /^Writing calls\s*1m 0s\s*10%$/,
    /^Waiting for the model\s*27\.0s\s*5%$/,
    /^Writing\s*3\.0s\s*<1%$/,
  ]);
  // Bars share one track, each as long as its share.
  const bars = await report.locator('.part-bar').evaluateAll((tracks) =>
    tracks.map((track) => {
      const fill = track.firstElementChild!.getBoundingClientRect();
      const whole = track.getBoundingClientRect();
      return [whole.x, whole.width, fill.width / whole.width];
    }),
  );
  expect(new Set(bars.map(([x, width]) => `${Math.round(x)}/${Math.round(width)}`)).size).toBe(1);
  expect(bars[0][2]).toBeCloseTo(0.6, 2);
  expect(bars[1][2]).toBeCloseTo(0.25, 2);
  // Calls that did the same count together, a call's own time apart from writing it.
  const ran = report.getByRole('list', { name: 'Longest calls' }).locator('li');
  await expect(ran).toHaveCount(5);
  await expect(ran.first()).toHaveText(/^4m 50s\s*npm test\s*×2\s*1 failed$/);
  await expect(ran.nth(1)).toHaveText(/^9\.0s\s*node step-0\.mjs\s*$/);
  await report.getByRole('button', { name: 'Show all 7' }).click();
  await expect(ran).toHaveCount(7);
  await expect(ran.last()).toHaveText(/^4\.0s\s*node step-5\.mjs\s*$/);
  await expect(report.getByRole('list', { name: 'Longest to write' }).locator('li')).toHaveText([
    /^30\.0s\s*Write\s*C:\/repo\/notes\.md\s*$/,
  ]);
  if (copies) {
    await report.getByRole('button', { name: 'Copy report' }).click();
    await expect(report.getByRole('button', { name: 'Copied' })).toBeVisible();
    // Windows hands the clipboard's text back with its own line ends.
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
      '\r\n',
      '\n',
    );
    expect(copied).toContain(
      '# Time report: Timed chat\n\nThis response, 10m 0s, 42 model requests, 1 retried.',
    );
    expect(copied).toContain('| Commands | 6m 0s | 60% |');
    expect(copied).toContain('| 4m 50s | 2 times, 1 failed | `npm test` |');
  }
  // The whole chat adds the reply that recorded nothing, and says so.
  await report.getByRole('tab', { name: 'This response' }).press('ArrowRight');
  await expect(report.getByRole('tab', { name: 'Whole chat' })).toBeFocused();
  await expect(report.locator('.report-total')).toHaveText(
    '11m 0s · 2 replies · 42 model requests, 1 retried',
  );
  await expect(parts).toHaveCount(6);
  await expect(parts.last()).toHaveText(/^Not recorded\s*1m 0s\s*9%$/);
  await expect(ran).toHaveCount(5);
  // The reply that recorded nothing says so, and has nothing to copy.
  const earlier = page.locator('.reply-footer').first();
  await earlier.getByRole('button', { name: 'Reply time, usage and cost', exact: true }).click();
  await expect(earlier.locator('.time-report .empty')).toHaveText(
    'Not recorded for this response.',
  );
  await expect(earlier.getByRole('button', { name: 'Copy report' })).toBeDisabled();
  // The panel keeps its scope and lists while its chat is left and shown again.
  await page.keyboard.press('Control+n');
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByText('Timed chat').click();
  await expect(report.getByRole('tab', { name: 'Whole chat' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await report.getByRole('tab', { name: 'This response' }).click();
  await expect(ran).toHaveCount(7);
});
