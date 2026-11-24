import { test, expect, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockDesktop } from './desktop-helper';
import { initialWorkspace, settingsFor } from '../src/lib/domain';

const output = 'artifacts/model-marks';
const tint = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).getPropertyValue('--provider-color'));

test('each Claude line has its own print and tint beside its version, and a reply says when another model ran @webkit', async ({
  page,
}) => {
  await mkdir(output, { recursive: true });
  await mockDesktop(page);
  const model = (id: string, name: string) => ({
    id,
    name,
    reasoningLevels: id === 'haiku' || !id ? [] : ['low', 'medium', 'high'],
    defaultReasoning: '',
  });
  const workspace = initialWorkspace();
  const now = new Date().toISOString();
  const settings = {
    ...settingsFor(workspace.preferences),
    provider: 'claude' as const,
    model: 'opus',
  };
  const reply = (text: string, reported: string) => ({
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    role: 'assistant' as const,
    status: 'complete' as const,
    createdAt: now,
    settings,
    // The picker named Opus 5.5 for both replies; the first came from an older CLI.
    modelName: 'Opus 5.5',
    blocks: [{ type: 'markdown' as const, text }],
    usage: { model: reported },
  });
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Model marks fixture',
    settings,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'Which model answers?' }],
      },
      reply('An answer from the older CLI.', 'claude-opus-5'),
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'And now?' }],
      },
      reply('An answer after the update.', 'claude-opus-5-5'),
    ],
  });
  await page.addInitScript(
    ({ workspace, models }) => {
      localStorage.setItem('test-workspace', JSON.stringify(workspace));
      localStorage.setItem('test-claude-models', JSON.stringify(models));
    },
    {
      workspace,
      models: [
        model('', 'CLI default'),
        model('opus', 'Opus 5.5'),
        model('sonnet', 'Sonnet 5'),
        model('fable', 'Fable 5.1'),
        model('haiku', 'Haiku 4.5'),
      ],
    },
  );
  await page.goto('/');
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: 'Model marks fixture', exact: true }).click();

  const replies = page.getByTestId('message').filter({ has: page.locator('.message-avatar') });
  const older = replies.filter({ hasText: 'An answer from the older CLI.' });
  const newer = replies.filter({ hasText: 'An answer after the update.' });
  // Both replies draw Opus's print; only the version tells them apart.
  const avatar = (reply: Locator) => reply.locator('.message-avatar .model-mark');
  await expect(older.locator('.message-heading strong')).toHaveText('Opus 5');
  await expect(avatar(older)).toHaveAttribute('data-line', 'opus');
  await expect(avatar(older).locator('.version')).toHaveText('5');
  await expect(older.locator('.model-mismatch')).toHaveText('Ran Opus 5 instead of Opus 5.5');
  await expect(newer.locator('.message-heading strong')).toHaveText('Opus 5.5');
  await expect(avatar(newer)).toHaveAttribute('data-line', 'opus');
  await expect(avatar(newer).locator('.version')).toHaveText('5.5');
  await expect(avatar(newer).locator('svg')).toBeVisible();
  await expect(newer.locator('.model-mismatch')).toHaveCount(0);
  expect(await tint(avatar(older))).toBe(await tint(avatar(newer)));
  await page.screenshot({ path: `${output}/replies-${test.info().project.name}.png` });

  // The toolbar shows the selected model's print and leaves its version to the name beside it,
  // and every choice carries its own mark.
  const picker = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(picker.locator('.model-mark')).toHaveAttribute('data-line', 'opus');
  await expect(picker.locator('.model-mark svg')).toBeVisible();
  await expect(picker.locator('.model-mark .version')).toHaveCount(0);
  await expect(picker.locator('.selected-name')).toHaveText('Opus 5.5');
  // The print keeps its square at the start of the trigger, and the name stays whole beside it.
  // WebKit, which draws the macOS and Linux apps, once measured the print as an SVG's default
  // 300px, drawing it over the Agent picker and wrapping every choice's name letter by letter.
  const trigger = (await picker.boundingBox())!;
  const chip = (await picker.locator('.model-mark').boundingBox())!;
  expect(chip.width).toBe(chip.height);
  expect(chip.x).toBeGreaterThan(trigger.x);
  expect(chip.x + chip.width).toBeLessThan(
    (await picker.locator('.selected-name').boundingBox())!.x,
  );
  expect(
    await picker.locator('.selected-name').evaluate((name) => name.scrollWidth <= name.clientWidth),
  ).toBe(true);
  // The composer shows the next message's model beside its send button, so it stays in sight
  // while writing: the print and the version, named on hover.
  const composer = page.getByRole('form', { name: 'Message composer', exact: true });
  const send = composer.getByRole('button', { name: 'Send message', exact: true });
  const badge = (name: string) => composer.getByRole('img', { name, exact: true });
  await expect(badge('Opus 5.5')).toHaveAttribute('title', 'Opus 5.5');
  await expect(badge('Opus 5.5').locator('.model-mark')).toHaveAttribute('data-line', 'opus');
  await expect(badge('Opus 5.5').locator('.model-mark svg')).toBeVisible();
  await expect(badge('Opus 5.5').locator('.version')).toHaveText('5.5');
  expect(await tint(badge('Opus 5.5').locator('.model-mark'))).toBe(await tint(avatar(newer)));
  // Beside the send button, as tall as it is.
  const besideSend = async (name: string) => {
    const mark = (await badge(name).locator('.model-mark').boundingBox())!;
    const button = (await send.boundingBox())!;
    const gap = button.x - mark.x - mark.width;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(12);
    expect(mark.y).toBeCloseTo(button.y, 0);
    expect(mark.height).toBeCloseTo(button.height, 0);
  };
  await besideSend('Opus 5.5');
  await composer.screenshot({ path: `${output}/composer-${test.info().project.name}.png` });
  await picker.click();
  const options = page.getByRole('option');
  const marks = options.locator('.model-mark');
  await expect(marks).toHaveCount(5);
  expect(
    await marks.evaluateAll((all) => all.map((mark) => mark.getAttribute('data-line'))),
  ).toEqual(['none', 'opus', 'sonnet', 'fable', 'haiku']);
  // CLI default keeps the provider glyph, since which model it runs is unknown, centered in a
  // mark as wide as the others, so every name starts at the same place.
  await expect(marks.first()).toHaveText('✳\uFE0E');
  await expect(marks.first().locator('svg')).toHaveCount(0);
  await expect(marks.locator('.version')).toHaveText(['5.5', '5', '5.1', '4.5']);
  const boxes = await marks.evaluateAll((all) =>
    all.map((mark) => {
      const { left, width } = mark.getBoundingClientRect();
      return { left, width };
    }),
  );
  expect(new Set(boxes.map(({ width }) => width)).size).toBe(1);
  const glyph = (await marks.first().locator('.glyph').boundingBox())!;
  expect(Math.abs(glyph.x + glyph.width / 2 - boxes[0].left - boxes[0].width / 2)).toBeLessThan(1);
  const starts = await options
    .locator('.option-name')
    .evaluateAll((all) => all.map((name) => name.getBoundingClientRect().left));
  expect(new Set(starts).size).toBe(1);
  // Every line draws a different print.
  const icons = await marks.locator('svg').evaluateAll((all) => all.map((icon) => icon.innerHTML));
  expect(icons).toHaveLength(4);
  expect(new Set(icons).size).toBe(4);
  await expect(options.locator('.option-name')).toHaveText([
    'CLI default',
    'Opus 5.5',
    'Sonnet 5',
    'Fable 5.1',
    'Haiku 4.5',
  ]);
  const tints = await Promise.all(
    ['Opus 5.5', 'Sonnet 5', 'Fable 5.1', 'Haiku 4.5'].map((name) =>
      tint(page.getByRole('option', { name, exact: true }).locator('.model-mark')),
    ),
  );
  expect(new Set(tints).size).toBe(4);
  expect(tints[0]).toBe(await tint(avatar(newer)));
  await page.screenshot({ path: `${output}/picker-${test.info().project.name}.png` });
  await page.getByRole('option', { name: 'Haiku 4.5', exact: true }).click();
  await expect(picker.locator('.model-mark')).toHaveAttribute('data-line', 'haiku');
  await expect(picker.locator('.model-mark .version')).toHaveCount(0);
  await expect(picker.locator('.selected-name')).toHaveText('Haiku 4.5');
  expect(await tint(picker.locator('.model-mark'))).toBe(tints[3]);
  // The composer's mark follows the choice.
  await expect(badge('Haiku 4.5').locator('.model-mark')).toHaveAttribute('data-line', 'haiku');
  await expect(badge('Haiku 4.5').locator('.version')).toHaveText('4.5');
  expect(await tint(badge('Haiku 4.5').locator('.model-mark'))).toBe(tints[3]);
  await expect(badge('Opus 5.5')).toHaveCount(0);
  // Without a version it is the mark alone, CLI default's provider glyph in a square.
  await picker.click();
  await page.getByRole('option', { name: 'CLI default', exact: true }).click();
  const unresolved = badge('CLI default').locator('.model-mark');
  await expect(unresolved).toHaveAttribute('data-line', 'none');
  await expect(unresolved).toHaveText('✳\uFE0E');
  const square = (await unresolved.boundingBox())!;
  expect(square.width).toBe(square.height);
  await besideSend('CLI default');
  // A phone keeps it beside the send button, on another row when the tools leave no room.
  await picker.click();
  await page.getByRole('option', { name: 'Opus 5.5', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await besideSend('Opus 5.5');
  expect(await composer.evaluate((form) => form.scrollWidth <= form.clientWidth)).toBe(true);
  await composer.screenshot({ path: `${output}/composer-phone-${test.info().project.name}.png` });
});

test('Settings keeps Claude Code and Codex updated automatically and Connections shows their versions', async ({
  page,
}) => {
  await mockDesktop(page);
  const checkedAt = new Date(2026, 8, 27, 12, 40).getTime();
  await page.addInitScript((checkedAt) => {
    const environmentId = '11111111-1111-4111-8111-111111111111';
    localStorage.setItem(
      'test-cli-updates',
      JSON.stringify({
        automatic: { claude: true, codex: true },
        statuses: [
          {
            provider: 'claude',
            environmentId,
            phase: 'updated',
            version: '2.1.283',
            previous: '2.1.278',
            checkedAt,
          },
          {
            provider: 'codex',
            environmentId,
            phase: 'waiting',
            version: '0.153.4',
            checkedAt,
            message:
              'Codex 0.157.1 is available. Agent Studio installs it once no Codex chat on this computer is replying or waiting for its next message.',
          },
        ],
      }),
    );
  }, checkedAt);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'CLI updates' });
  const claudeSwitch = section.getByRole('checkbox', { name: 'Update Claude Code automatically' });
  const codexSwitch = section.getByRole('checkbox', { name: 'Update Codex automatically' });
  await expect(claudeSwitch).toBeChecked();
  await expect(codexSwitch).toBeChecked();
  // The page formats times in the browser's locale.
  const clock = await page.evaluate(
    (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    checkedAt,
  );
  const rows = section.getByRole('listitem');
  await expect(rows.filter({ hasText: 'Claude Code' }).getByRole('status')).toHaveText(
    `Updated from 2.1.278 to 2.1.283 at ${clock}.`,
  );
  await expect(rows.filter({ hasText: 'Codex' }).getByRole('status')).toContainText(
    'Codex 0.157.1 is available.',
  );
  await expect(rows.filter({ hasText: 'Codex' })).toContainText('0.153.4');
  await section.screenshot({ path: `${output}/settings.png` });
  // Each CLI has its own switch.
  await codexSwitch.uncheck();
  await expect(codexSwitch).not.toBeChecked();
  await expect(claudeSwitch).toBeChecked();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-cli-updates')!).automatic),
  ).toEqual({ claude: true, codex: false });
  await section.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).cliUpdateChecks)).toBe(1);

  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  // Only this computer's cards have update readings.
  const card = (provider: string) =>
    page.getByRole('article', { name: `${provider} connections` }).filter({ hasText: 'Version' });
  await expect(card('Claude')).toHaveCount(1);
  await expect(card('Claude').locator('.cli-location').filter({ hasText: 'Version' })).toHaveText(
    /Version\s*2\.1\.283\s*Updated from 2\.1\.278/,
  );
  await expect(card('Codex').locator('.cli-location').filter({ hasText: 'Version' })).toHaveText(
    /Version\s*0\.153\.4\s*Update waiting/,
  );
  await card('Codex').screenshot({ path: `${output}/connections-codex.png` });
});
