import { test, expect, type Locator } from '@playwright/test';
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
const note = (id: string, text: string) => ({
  type: 'activity' as const,
  text,
  progress: { id, revision: 1 },
});

test('a reply’s time opens as a report of its steps, sub-agents and calls, and of the whole chat @webkit', async ({
  page,
  context,
  browserName,
}) => {
  const copies = browserName === 'chromium';
  if (copies) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const workspace = initialWorkspace();
  const at = '2026-11-24T10:00:00.000Z';
  const runId = crypto.randomUUID();
  const message = (fields: Partial<Message>): Message => ({
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
      message({ durationMs: 60_000 }),
      message({ role: 'user', blocks: [{ type: 'markdown', text: 'Fix the build' }] }),
      message({
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
          timeline: {
            kinds: ['waiting', 'thinking', 'calls', 'commands', 'writing'],
            runs: [0, 27_000, 1, 150_000, 2, 60_000, 3, 360_000, 4, 3000],
          },
          steps: [
            { at: 27_000, title: 'Find the cause' },
            { at: 237_000, title: 'Run the tests' },
            { at: 597_000 },
          ],
          notes: [
            { at: 30_000, id: 'n1' },
            { at: 240_000, id: 'n2' },
          ],
        },
        blocks: [
          note('n1', 'Reading the build script'),
          note('n2', 'Running the tests'),
          call('agents', {
            category: 'agent',
            name: 'Sub-agents',
            agents: [
              {
                id: 'a1',
                name: 'Explore the relay',
                status: 'complete',
                startMs: 40_000,
                elapsedMs: 90_000,
              },
            ],
          }),
          call('s', {
            parentId: 'a1',
            command: 'rg sync src',
            commandRun: true,
            startMs: 50_000,
            elapsedMs: 20_000,
          }),
          call('a', { ...tests, startMs: 240_000, elapsedMs: 150_000 }),
          call('b', { ...tests, startMs: 400_000, elapsedMs: 140_000, status: 'error' }),
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
  const summary = footer.locator('.time-report');
  // Nothing of it is in the page until its panel opens.
  await expect(summary).toHaveCount(0);
  await toggle.click();
  await expect(summary.locator('.report-total')).toHaveText(
    '10m 0s · 42 model requests, 1 retried',
  );
  await expect(summary.locator('.parts li')).toHaveText([
    /^\s*Commands\s*6m 0s\s*60%\s*$/,
    /^\s*Thinking\s*2m 30s\s*25%\s*$/,
    /^\s*Writing calls\s*1m 0s\s*10%\s*$/,
    /^\s*Waiting for the model\s*27\.0s\s*5%\s*$/,
    /^\s*Writing\s*3\.0s\s*<1%\s*$/,
  ]);
  // Bars share one track, each as long as its share.
  const bars = await summary.locator('.makeup').evaluateAll((tracks) =>
    tracks.map((track) => {
      // Laid-out widths: a bar grows in with a transform as it first shows.
      const fill = (track.firstElementChild as HTMLElement).offsetWidth;
      const whole = track.getBoundingClientRect();
      return [whole.x, whole.width, fill / (track as HTMLElement).offsetWidth];
    }),
  );
  expect(new Set(bars.map(([x, width]) => `${Math.round(x)}/${Math.round(width)}`)).size).toBe(1);
  expect(bars[0][2]).toBeCloseTo(0.6, 2);
  expect(bars[1][2]).toBeCloseTo(0.25, 2);
  // The footer's cards are as wide as the reply, so the time summary, the usage table and Files
  // edited line up.
  const edges = async (card: Locator) => {
    const box = (await card.boundingBox())!;
    return [Math.round(box.x), Math.round(box.x + box.width)];
  };
  const reply = await edges(footer);
  expect(await edges(summary)).toEqual(reply);
  expect(await edges(footer.locator('.usage-breakdown'))).toEqual(reply);
  await footer.getByRole('button', { name: /^Files edited/ }).click();
  expect(await edges(footer.locator('.changes-body'))).toEqual(reply);
  await toggle.click();

  // The report opens on this reply.
  const open = summary.getByRole('button', { name: 'Open report' });
  // From the keyboard: WebKit gives a clicked button no focus to return to.
  await open.focus();
  await page.keyboard.press('Enter');
  const report = page.getByRole('dialog', { name: 'Time report' });
  await expect(report.getByRole('tab', { name: 'One response' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(report.locator('.reply-name')).toHaveText(/^\s*2 of 2\s*Fix the build\s*$/);
  await expect(report.locator('.total')).toHaveText(
    /^\s*10m 0s\s*42 model requests, 1 retried\s*$/,
  );
  await expect(report.locator('.families li')).toHaveText([
    /^\s*Model\s*4m 0s\s*40%\s*$/,
    /^\s*Commands and tools\s*6m 0s\s*60%\s*$/,
  ]);
  // Its time in order, with the plan's steps and its sub-agent under it.
  const ribbon = report.locator('.ribbon');
  await expect(ribbon.locator('span[data-family]')).toHaveCount(5);
  await expect(report.getByLabel('Plan steps').locator('.span')).toHaveText([
    'Find the cause',
    'Run the tests',
  ]);
  await expect(report.getByLabel('Sub-agents', { exact: true }).locator('.span')).toHaveText([
    'Explore the relay',
  ]);
  const strip = (await ribbon.boundingBox())!;
  await page.mouse.move(strip.x + strip.width * 0.5, strip.y + strip.height / 2);
  await expect(report.locator('.readout')).toHaveText(
    /^\s*5m\s*Commands\s*for 6m 0s\s*· Run the tests\s*$/,
  );
  await page.mouse.move(2, 2);
  await expect(report.locator('.readout')).toHaveText(/^\s*Model\s*Commands and tools\s*$/);
  // What each step of the plan took, and what it was made of.
  const steps = report.getByRole('list', { name: 'Steps' }).locator('li');
  await expect(steps).toHaveText([
    /^\s*Find the cause\s*3m 30s\s*35%\s*$/,
    /^\s*Run the tests\s*6m 0s\s*60%\s*$/,
    /^\s*Outside the plan\s*30\.0s\s*5%\s*$/,
  ]);
  await expect(steps.nth(1).getByRole('img')).toHaveAccessibleName('Commands and tools 100%');
  // The stretches between the model's notes, longest first.
  await report.getByRole('tab', { name: 'Notes' }).click();
  await expect(steps).toHaveText([
    /^\s*Running the tests\s*6m 0s\s*60%\s*$/,
    /^\s*Reading the build script\s*3m 30s\s*35%\s*$/,
    /^\s*Before the first note\s*30\.0s\s*5%\s*$/,
  ]);
  await expect(report.getByRole('list', { name: 'Sub-agents' }).locator('li')).toHaveText([
    /^\s*Explore the relay\s*· 1\s*call\s*1m 30s\s*15%\s*$/,
  ]);
  await expect(report.getByRole('list', { name: 'Commands' }).locator('li')).toHaveText([
    /^\s*Tests\s*· 2\s*calls\s*4m 50s\s*$/,
    /^\s*Scripts\s*· 6\s*calls\s*39\.0s\s*$/,
    /^\s*Searching\s*· 1\s*call\s*20\.0s\s*$/,
  ]);
  // Calls that did the same count together, a call's own time apart from writing it.
  const ran = report.getByRole('list', { name: 'Longest calls' }).locator('li');
  await expect(ran).toHaveCount(6);
  await expect(ran.first()).toHaveText(/^\s*4m 50s\s*npm test\s*2 times, 1 failed\s*$/);
  await report.getByRole('button', { name: 'Show all 8' }).click();
  await expect(ran).toHaveCount(8);
  await expect(ran.last()).toHaveText(/^\s*4\.0s\s*node step-5\.mjs\s*$/);
  await expect(report.getByRole('list', { name: 'Longest to write' }).locator('li')).toHaveText([
    /^\s*30\.0s\s*Write\s*C:\/repo\/notes\.md\s*$/,
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
    expect(copied).toContain('| Find the cause | 3m 30s | 35% | Model 100% |');
    expect(copied).toContain(
      '| Explore the relay | 1m 30s | 1 | Model 78%, Commands and tools 22% |',
    );
    expect(copied).toContain('| 4m 50s | 2 times, 1 failed | `npm test` |');
  }

  // The whole chat adds the reply that recorded nothing, and says so.
  await report.getByRole('tab', { name: 'Whole chat' }).click();
  await expect(report.locator('.total')).toHaveText(
    /^\s*11m 0s\s*2 replies · 42 model requests, 1 retried\s*$/,
  );
  await expect(report.locator('.families li').last()).toHaveText(
    /^\s*Not recorded\s*1m 0s\s*9%\s*$/,
  );
  await expect(report.locator('.ribbon')).toHaveCount(0);
  const replies = report.getByRole('list', { name: 'Responses' }).getByRole('button');
  await expect(replies).toHaveText([
    /^\s*1\s*Reply 1\s*1m 0s\s*9%\s*$/,
    /^\s*2\s*Fix the build\s*10m 0s\s*91%\s*$/,
  ]);
  // A response's row opens it, and the arrows step between responses.
  await replies.last().click();
  await expect(report.locator('.reply-name')).toHaveText(/^\s*2 of 2\s*Fix the build\s*$/);
  await report.getByRole('button', { name: 'Earlier response' }).click();
  await expect(report.locator('.total')).toHaveText(/^\s*1m 0s\s*$/);
  await expect(report.getByText('Not recorded for this response.')).toHaveCount(0);
  await expect(report.locator('.families li')).toHaveText([/^\s*Not recorded\s*1m 0s\s*100%\s*$/]);
  await expect(report.getByRole('button', { name: 'Copy report' })).toBeDisabled();
  // Escape closes it and returns to what opened it.
  await page.keyboard.press('Escape');
  await expect(report).toHaveCount(0);
  await expect(open).toBeFocused();

  // The chat's toolbar opens the whole chat's.
  await page.getByRole('button', { name: 'Time report', exact: true }).click();
  await expect(report.getByRole('tab', { name: 'Whole chat' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await report.getByRole('button', { name: 'Close time report' }).click();
  await expect(report).toHaveCount(0);
});
