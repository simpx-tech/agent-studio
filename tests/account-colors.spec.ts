import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

type Saved = Record<string, { accountId: string; color: string; chosenAt?: string }>;
// Each account's saved color, by the account's name.
const savedColors = (page: Page): Promise<Saved> =>
  page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const colors = new Map<string, unknown>(
      (workspace.accountColors ?? []).map((c: { accountId: string }) => [c.accountId, c]),
    );
    return Object.fromEntries(
      workspace.fleet.accounts.map((a: { id: string; name: string }) => [a.name, colors.get(a.id)]),
    );
  });
// The color a mark or dot is drawn in, as its style names it.
const colorOf = (mark: Locator) =>
  mark.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--account-color'));
const token = (color: string) => `var(--account-${color})`;
const fill = (mark: Locator) =>
  mark.evaluate((element) => getComputedStyle(element).backgroundColor);

// More Claude accounts beside the computer's own logins, added in Connections, where this ends.
async function prepare(page: Page, names = ['Second Claude']) {
  await mockDesktop(page);
  // A test can make every save of the workspace fail.
  await page.addInitScript(() => {
    const state = window as any,
      native = state.__TAURI_INTERNALS__;
    const invoke = native.invoke;
    native.invoke = async (command: string, args: unknown) => {
      if (state.failSaves && command.startsWith('save_workspace')) throw 'Synthetic save failure';
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  for (const name of names) {
    await page.getByRole('button', { name: 'Add account', exact: true }).first().click();
    await dialog.getByRole('combobox', { name: 'Account provider' }).click();
    await page.getByRole('option', { name: 'Claude', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Account name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  // Every account has a saved color once the new ones took theirs.
  await expect
    .poll(async () => Object.values(await savedColors(page)).filter(Boolean).length)
    .toBe(3 + names.length);
  return savedColors(page);
}
const account = (page: Page, name: string) =>
  page.locator('.fleet-account').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('each account has a color of its own in the Agent picker, on its control and in Connections', async ({
  page,
}) => {
  const saved = await prepare(page);
  expect(Object.keys(saved).sort()).toEqual([
    'Claude CLI login',
    'Codex CLI login',
    'Gemini CLI login',
    'Second Claude',
  ]);
  // No two accounts took the same color, and none is recorded as the user's choice.
  expect(new Set(Object.values(saved).map((c) => c.color)).size).toBe(4);
  expect(Object.values(saved).every((c) => c.chosenAt === undefined)).toBe(true);
  // Connections marks each account's name with its color.
  for (const [name, { color }] of Object.entries(saved))
    expect(await colorOf(account(page, name).locator('.account-dot'))).toBe(token(color));
  await page.screenshot({ path: 'artifacts/account-colors-connections.png' });

  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  const login = page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true });
  const second = page.getByRole('option', { name: 'Claude · Second Claude', exact: true });
  const codex = page.getByRole('option', { name: 'Codex', exact: true });
  // Accounts the list names carry their agent's glyph on their own color.
  for (const [option, name] of [
    [login, 'Claude CLI login'],
    [second, 'Second Claude'],
  ] as const) {
    const mark = option.locator('.account-mark');
    await expect(mark).toHaveText('✳\uFE0E');
    expect(await colorOf(mark)).toBe(token(saved[name].color));
    await expect(option.locator('.option-mark')).toHaveCount(0);
  }
  const fills = [
    await fill(login.locator('.account-mark')),
    await fill(second.locator('.account-mark')),
  ];
  expect(fills[0]).toMatch(/^rgb\(/);
  expect(fills[0]).not.toBe(fills[1]);
  // An agent with one account here keeps its own mark.
  await expect(codex.locator('.account-mark')).toHaveCount(0);
  await expect(codex.locator('.option-mark')).toHaveText('O');
  await page.screenshot({ path: 'artifacts/account-colors-picker.png' });

  // The selected account shows on the Agent control and on a new chat's welcome.
  await second.click();
  const welcome = page.locator('.chat-empty');
  await expect(agent.locator('.account-mark')).toHaveClass(/chip/);
  expect(await colorOf(agent.locator('.account-mark'))).toBe(token(saved['Second Claude'].color));
  expect(await fill(agent.locator('.account-mark'))).toBe(fills[1]);
  await expect(welcome.locator('.account-mark')).toHaveClass(/large/);
  expect(await colorOf(welcome.locator('.account-mark'))).toBe(token(saved['Second Claude'].color));
  await expect(welcome.locator('.eyebrow')).toHaveText(
    'A conversation with Claude · Second Claude',
  );
  await page.screenshot({ path: 'artifacts/account-colors-new-chat.png' });
  await agent.click();
  await login.click();
  expect(await colorOf(agent.locator('.account-mark'))).toBe(
    token(saved['Claude CLI login'].color),
  );
  await agent.click();
  await codex.click();
  await expect(agent.locator('.account-mark')).toHaveCount(0);
  await expect(agent.locator('svg').first()).toBeVisible();
  await expect(welcome.locator('.large-provider')).toHaveText('O');
  await expect(welcome.locator('.eyebrow')).toHaveText('A conversation with Codex');

  // Colors are the workspace's: a reload shows the same ones without choosing again.
  await page.reload();
  await expect(agent).toBeVisible();
  expect(await savedColors(page)).toEqual(saved);
});

test('Manage account changes an account’s color with the mouse or the keyboard', async ({
  page,
}) => {
  const saved = await prepare(page);
  const card = account(page, 'Second Claude');
  const dialog = page.getByRole('dialog', { name: 'Manage account', exact: true });
  const palette = dialog.getByRole('radiogroup', { name: 'Color', exact: true });
  const chosen = palette.getByRole('radio', { checked: true });
  const label = (color: string) => color[0].toUpperCase() + color.slice(1);

  await card.getByRole('button', { name: 'Manage account' }).click();
  await expect(palette.getByRole('radio')).toHaveCount(10);
  await expect(chosen).toHaveAccessibleName(label(saved['Second Claude'].color));
  // The palette is one stop for the Tab key.
  await expect(palette.locator('[tabindex="0"]')).toHaveCount(1);
  await palette.screenshot({ path: 'artifacts/account-colors-palette.png' });
  // Choosing changes nothing until the account is saved.
  await palette.getByRole('radio', { name: 'Brown', exact: true }).click();
  await expect(chosen).toHaveAccessibleName('Brown');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedColors(page)).toEqual(saved);
  expect(await colorOf(card.locator('.account-dot'))).toBe(token(saved['Second Claude'].color));

  // A save that fails leaves the account the color it had.
  await page.evaluate(() => ((window as any).failSaves = true));
  await card.getByRole('button', { name: 'Manage account' }).click();
  await palette.getByRole('radio', { name: 'Gray', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic save failure');
  await page.evaluate(() => ((window as any).failSaves = false));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await colorOf(card.locator('.account-dot'))).toBe(token(saved['Second Claude'].color));
  expect(await savedColors(page)).toEqual(saved);

  // Arrow keys move the choice and its focus; Home and End reach the ends.
  await card.getByRole('button', { name: 'Manage account' }).click();
  await chosen.focus();
  await page.keyboard.press('End');
  await expect(chosen).toHaveAccessibleName('Gray');
  await expect(chosen).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(chosen).toHaveAccessibleName('Red');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(chosen).toHaveAccessibleName('Brown');
  await expect(chosen).toBeFocused();
  await page.keyboard.press('Home');
  await expect(chosen).toHaveAccessibleName('Red');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(chosen).toHaveAccessibleName('Brown');
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // The choice is saved with its time, and the other accounts keep their colors.
  await expect.poll(async () => (await savedColors(page))['Second Claude'].color).toBe('brown');
  const after = await savedColors(page);
  expect(after['Second Claude'].chosenAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  for (const name of ['Claude CLI login', 'Codex CLI login', 'Gemini CLI login'])
    expect(after[name]).toEqual(saved[name]);
  expect(await colorOf(card.locator('.account-dot'))).toBe(token('brown'));

  // The chat shows it at once, and after a reload.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  const second = page.getByRole('option', { name: 'Claude · Second Claude', exact: true });
  await agent.click();
  expect(await colorOf(second.locator('.account-mark'))).toBe(token('brown'));
  await second.click();
  expect(await colorOf(agent.locator('.account-mark'))).toBe(token('brown'));
  await page.reload();
  await expect(agent).toBeVisible();
  expect(await savedColors(page)).toEqual(after);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  expect(await colorOf(card.locator('.account-dot'))).toBe(token('brown'));
  // Saving the account again without another choice keeps the color and its time.
  await card.getByRole('button', { name: 'Manage account' }).click();
  await expect(chosen).toHaveAccessibleName('Brown');
  await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await savedColors(page)).toEqual(after);
});

test('the account a chat switches to is named in its color', async ({ page }) => {
  const saved = await prepare(page);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  await page.getByRole('option', { name: 'Claude · Claude CLI login', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('First account reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  // A reply by the chat's first account announces nothing.
  await expect(page.locator('.reply-switch')).toHaveCount(0);

  await agent.click();
  await page.getByRole('option', { name: 'Claude · Second Claude', exact: true }).click();
  const next = page.locator('.next-reply-settings');
  await expect(next).toHaveText('Next message: Second Claude account');
  expect(await colorOf(next.locator('.account-dot'))).toBe(token(saved['Second Claude'].color));
  expect(await colorOf(agent.locator('.account-mark'))).toBe(token(saved['Second Claude'].color));
  await page.getByLabel('Message', { exact: true }).fill('Second account reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const notice = page.locator('.reply-switch');
  await expect(notice).toHaveText(['Switched to Second Claude account']);
  expect(await colorOf(notice.locator('.account-dot'))).toBe(token(saved['Second Claude'].color));
  await page.screenshot({ path: 'artifacts/account-colors-switch.png' });

  // A switch of model alone names no account, so it carries no color.
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Another model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(6);
  await expect(notice).toHaveCount(2);
  await expect(notice.nth(1)).toContainText('Switched to Sonnet');
  await expect(notice.nth(1).locator('.account-dot')).toHaveCount(0);
  await expect(notice.locator('.account-dot')).toHaveCount(1);
});

test('an account’s name shows whole on the Agent control, with no room left empty beside it @webkit', async ({
  page,
}) => {
  const long = 'an.account.with.a.much.longer.name.than.fits';
  await prepare(page, ['vinicius.portela.stm', long]);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await chooseTestFolder(page);
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  const name = agent.locator('.selected-name');
  const whole = () => name.evaluate((text) => text.scrollWidth <= text.clientWidth);
  // The control, its picker and its place in the toolbar, which starts with a divider.
  const widths = () =>
    page.locator('.agent-setting').evaluate((setting) => {
      const width = (selector: string) =>
        Math.round(setting.querySelector(selector)!.getBoundingClientRect().width);
      return {
        setting: Math.round(setting.getBoundingClientRect().width),
        picker: width('.agent-picker'),
        trigger: width('.picker-trigger'),
        mark: width('.account-mark'),
      };
    });
  const pick = async (account: string) => {
    await agent.click();
    await page.getByRole('option', { name: `Claude · ${account}`, exact: true }).click();
    await expect(name).toHaveText(`Claude · ${account}`);
  };

  await pick('vinicius.portela.stm');
  expect(await whole()).toBe(true);
  let box = await widths();
  expect(box.mark).toBe(20);
  expect(box.trigger).toBe(box.picker);
  expect(box.setting - box.trigger).toBeLessThanOrEqual(14);
  await page.locator('.chat-toolbar').screenshot({ path: 'artifacts/account-colors-toolbar.png' });

  // A name too long for the control is cut short, still without empty room after it.
  await pick(long);
  expect(await whole()).toBe(false);
  box = await widths();
  expect(box.trigger).toBe(280);
  expect(box.trigger).toBe(box.picker);
  expect(box.setting - box.trigger).toBeLessThanOrEqual(14);

  // A narrower window gives every control less, the same way.
  await page.setViewportSize({ width: 1000, height: 800 });
  box = await widths();
  expect(box.trigger).toBeLessThanOrEqual(220);
  expect(box.trigger).toBeGreaterThan(170);
  expect(box.trigger).toBe(box.picker);
  expect(box.setting - box.trigger).toBeLessThanOrEqual(14);
  await pick('vinicius.portela.stm');
  box = await widths();
  expect(box.trigger).toBeLessThanOrEqual(220);
  expect(box.setting - box.trigger).toBeLessThanOrEqual(14);
  // The list's marks are squares of one size in every engine.
  await agent.click();
  expect(
    await page
      .getByRole('option')
      .locator('.account-mark')
      .evaluateAll((marks) =>
        marks.map((mark) => {
          const { width, height } = mark.getBoundingClientRect();
          return `${width}x${height}`;
        }),
      ),
  ).toEqual(['28x28', '28x28', '28x28']);
});
