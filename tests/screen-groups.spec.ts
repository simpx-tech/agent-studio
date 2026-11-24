import { test, expect, type Locator, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';

// The desktop fixture's own environment, which keeps the screens.
const desktop = '11111111-1111-4111-8111-111111111111';
const titles = [
  'Bluevox editor',
  'CityBuilder editor',
  'NationGame editor',
  'Ticket queue',
  'Daily work log',
];

function record(index: number, title: string) {
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
  return {
    id,
    revision: 1,
    title,
    description: '',
    environmentId: desktop,
    project: 'D:\\Projects',
    folder: 'D:\\Projects',
    conversationId: '99999999-9999-4999-8999-999999999999',
    createdAt: '2026-11-24T12:00:00.000Z',
    updatedAt: `2026-11-24T12:0${index}:00.000Z`,
    html: `<h1>${title}</h1>`,
    actions: [],
  };
}

const panel = (page: Page) => page.locator('#conversation-panel-screens');
const groupBox = (page: Page, name: string) =>
  panel(page).getByRole('group', { name, exact: true });
const heading = (page: Page, name: string) =>
  groupBox(page, name).locator(':scope > .folder-group-row > .folder-group-toggle');
const screenRow = (page: Page, title: string) =>
  panel(page).getByRole('button', { name: title, exact: true });
/** The titles a group shows directly, its own groups' names first. */
const inside = (page: Page, name: string) =>
  groupBox(page, name).evaluate((box) =>
    [
      ...box.querySelectorAll(
        ':scope > .screen-group-items > .screen-group > .folder-group-row > .folder-group-toggle > span, :scope > .screen-group-items > .screen-list .conversation-item > span:first-of-type',
      ),
    ].map((item) => item.textContent),
  );
/** What the computer shows at its top: its groups' names, then its screens in no group. */
const top = (page: Page) =>
  panel(page)
    .locator('[data-screen-computer]')
    .evaluate((box) =>
      [
        ...box.querySelectorAll(
          ':scope > .screen-group > .folder-group-row > .folder-group-toggle > span, :scope > .screen-list .conversation-item > span:first-of-type',
        ),
      ].map((item) => item.textContent),
    );
const requests = (page: Page) =>
  page.evaluate(() =>
    ((window as any).screenRequests ?? [])
      .map((request: { op: string }) => request.op)
      .filter((op: string) => /Group$|^moveScreen$/.test(op)),
  );

async function openScreens(page: Page) {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  // Listed the newest first, as the computer lists them.
  await page.evaluate(
    (screens) => {
      localStorage.setItem('test-screens', JSON.stringify(screens));
      localStorage.removeItem('test-screen-groups');
    },
    titles.map((title, index) => record(index + 1, title)).reverse(),
  );
  await page.reload();
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await expect(screenRow(page, 'Bluevox editor')).toBeVisible();
}
async function newGroup(page: Page, opener: Locator, label: string, name: string) {
  await opener.click();
  const field = panel(page).getByRole('textbox', { name: label });
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press('Enter');
}
async function menuFor(page: Page, target: Locator, name: string) {
  await target.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `Actions for ${name}` });
  await expect(menu).toBeVisible();
  return menu;
}
/** Presses `from` with the mouse and drags it over `to`, releasing it there. */
async function drag(page: Page, from: Locator, to: Locator) {
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  const x = start.x + Math.min(40, start.width / 2);
  await page.mouse.move(x, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(x + 4, start.y + start.height / 2 + 8, { steps: 3 });
  await page.mouse.move(end.x + Math.min(40, end.width / 2), end.y + end.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
}

test('screens go in groups and groups in groups, named in place and moved by menu, key or drag @webkit', async ({
  page,
}) => {
  // One long walk through every way of grouping; WebKit under four workers needs over 30 s.
  test.setTimeout(60_000);
  await openScreens(page);
  // The newest screen first, as before any group.
  expect(await top(page)).toEqual([...titles].reverse());

  // A group named in place at the computer's top.
  await newGroup(
    page,
    panel(page).getByRole('button', { name: 'New group on Desktop' }),
    'New group on Desktop',
    'Unreal editors',
  );
  await expect(heading(page, 'Unreal editors')).toBeFocused();
  expect(await inside(page, 'Unreal editors')).toEqual([]);

  // A screen's menu moves it into the group, and the keyboard opens the same menu.
  const menu = await menuFor(page, screenRow(page, 'Bluevox editor'), 'Bluevox editor');
  await expect(menu.getByRole('menuitemradio', { name: 'Desktop' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await menu.getByRole('menuitemradio', { name: 'Unreal editors' }).click();
  await expect.poll(() => inside(page, 'Unreal editors')).toEqual(['Bluevox editor']);
  await expect(screenRow(page, 'Bluevox editor')).toBeFocused();
  await screenRow(page, 'NationGame editor').focus();
  await page.keyboard.press('Shift+F10');
  const keyed = page.getByRole('menu', { name: 'Actions for NationGame editor' });
  await expect(keyed.getByRole('menuitemradio', { name: 'Unreal editors' })).toBeVisible();
  await keyed.getByRole('menuitemradio', { name: 'Unreal editors' }).click();
  await expect
    .poll(() => inside(page, 'Unreal editors'))
    .toEqual(['NationGame editor', 'Bluevox editor']);

  // A group inside a group, from the group's menu.
  const groupMenu = await menuFor(page, heading(page, 'Unreal editors'), 'Unreal editors');
  await groupMenu.getByRole('menuitem', { name: 'New group inside' }).click();
  const field = panel(page).getByRole('textbox', { name: 'New group in Unreal editors' });
  await field.fill('Builds');
  await field.press('Enter');
  await expect(heading(page, 'Builds')).toBeFocused();
  expect(await inside(page, 'Unreal editors')).toEqual([
    'Builds',
    'NationGame editor',
    'Bluevox editor',
  ]);

  // A drag with the mouse lands a screen in the group under the pointer, and a group in
  // another group.
  await drag(page, screenRow(page, 'CityBuilder editor'), heading(page, 'Builds'));
  await expect.poll(() => inside(page, 'Builds')).toEqual(['CityBuilder editor']);
  await newGroup(
    page,
    panel(page).getByRole('button', { name: 'New group on Desktop' }),
    'New group on Desktop',
    'Edvisor',
  );
  await drag(page, screenRow(page, 'Ticket queue'), heading(page, 'Edvisor'));
  await expect.poll(() => inside(page, 'Edvisor')).toEqual(['Ticket queue']);
  await drag(page, heading(page, 'Builds'), heading(page, 'Edvisor'));
  await expect.poll(() => inside(page, 'Edvisor')).toEqual(['Builds', 'Ticket queue']);
  expect(await inside(page, 'Unreal editors')).toEqual(['NationGame editor', 'Bluevox editor']);
  // A group never goes inside itself: its own group is no place for it.
  const nested = await menuFor(page, heading(page, 'Edvisor'), 'Edvisor');
  await expect(nested.getByRole('menuitemradio')).toHaveText(['Desktop', 'Unreal editors']);
  await page.keyboard.press('Escape');
  await expect(heading(page, 'Edvisor')).toBeFocused();

  // A name already there among its neighbours is refused in place; Escape leaves it.
  await newGroup(
    page,
    panel(page).getByRole('button', { name: 'New group on Desktop' }),
    'New group on Desktop',
    'unreal EDITORS',
  );
  await expect(panel(page).getByRole('alert')).toHaveText(
    'A group named unreal EDITORS is already there.',
  );
  await panel(page).getByRole('textbox', { name: 'New group on Desktop' }).press('Escape');
  await expect(panel(page).getByRole('textbox')).toHaveCount(0);

  // Renamed in place, and a new group with a screen in it.
  const renaming = await menuFor(page, heading(page, 'Builds'), 'Builds');
  await renaming.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = panel(page).getByRole('textbox', { name: 'Rename Builds' });
  await expect(rename).toHaveValue('Builds');
  await rename.fill('Build tools');
  await rename.press('Enter');
  await expect(heading(page, 'Build tools')).toBeFocused();
  const logMenu = await menuFor(page, screenRow(page, 'Daily work log'), 'Daily work log');
  await logMenu.getByRole('menuitem', { name: 'New group with this screen' }).click();
  await panel(page).getByRole('textbox', { name: 'New group on Desktop' }).fill('Linear');
  await panel(page).getByRole('textbox', { name: 'New group on Desktop' }).press('Enter');
  await expect.poll(() => inside(page, 'Linear')).toEqual(['Daily work log']);

  // A folded group hides what it holds until a search finds something in it.
  await heading(page, 'Unreal editors').click();
  await expect(heading(page, 'Unreal editors')).toHaveAttribute('aria-expanded', 'false');
  await expect(screenRow(page, 'Bluevox editor')).toBeHidden();
  await page.getByPlaceholder('Search screens').fill('bluevox');
  await expect(screenRow(page, 'Bluevox editor')).toBeVisible();
  expect(await top(page)).toEqual(['Unreal editors']);
  await page.getByPlaceholder('Search screens').fill('');

  // What the computer keeps survives a reload: the tree reads its groups again.
  expect(await top(page)).toEqual(['Edvisor', 'Linear', 'Unreal editors']);
  expect(await requests(page)).toEqual([
    'createGroup',
    'moveScreen',
    'moveScreen',
    'createGroup',
    'moveScreen',
    'createGroup',
    'moveScreen',
    'moveGroup',
    'createGroup',
    'renameGroup',
    'createGroup',
    'moveScreen',
  ]);
  await page.reload();
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await expect.poll(() => top(page)).toEqual(['Edvisor', 'Linear', 'Unreal editors']);
  expect(await inside(page, 'Edvisor')).toEqual(['Build tools', 'Ticket queue']);
  expect(await inside(page, 'Build tools')).toEqual(['CityBuilder editor']);

  // Ungrouping leaves what a group held a level up.
  const ungrouping = await menuFor(page, heading(page, 'Edvisor'), 'Edvisor');
  await ungrouping.getByRole('menuitem', { name: 'Ungroup' }).click();
  await expect
    .poll(() => top(page))
    .toEqual(['Build tools', 'Linear', 'Unreal editors', 'Ticket queue']);
  expect(await requests(page)).toEqual(['deleteGroup']);
});

test('a refused move shows why and the computer’s groups again, and a computer of an earlier release has none', async ({
  page,
}) => {
  await openScreens(page);
  await newGroup(
    page,
    panel(page).getByRole('button', { name: 'New group on Desktop' }),
    'New group on Desktop',
    'Unreal editors',
  );
  await page.evaluate(
    () => ((window as any).refuseScreenGroups = 'Cannot save the screen groups.'),
  );
  const menu = await menuFor(page, screenRow(page, 'Bluevox editor'), 'Bluevox editor');
  await menu.getByRole('menuitemradio', { name: 'Unreal editors' }).click();
  await expect(page.locator('.notice')).toContainText('Cannot save the screen groups.');
  await expect.poll(() => inside(page, 'Unreal editors')).toEqual([]);
  await expect.poll(() => top(page)).toContain('Bluevox editor');

  // A computer whose Agent Studio predates groups lists its screens without them.
  await page.evaluate(() => localStorage.setItem('test-old-screen-host', '1'));
  await page.reload();
  await page.getByRole('tab', { name: /^Screens/ }).click();
  await expect(screenRow(page, 'Bluevox editor')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'New group on Desktop' })).toHaveCount(0);
  expect(await top(page)).toEqual([...titles].reverse());
  await screenRow(page, 'Bluevox editor').click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
});
