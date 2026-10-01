import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import type { Workspace } from '../src/lib/domain';

const environmentId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const saved = (page: Page): Promise<Workspace> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
const hex = () => crypto.randomUUID().replaceAll('-', '');

/** The detected Claude and Codex logins of the mocked computer, once the app saved them. */
async function connections(page: Page) {
  let found: Record<'claude' | 'codex', string> | undefined;
  await expect
    .poll(async () => {
      const fleet = (await saved(page))?.fleet;
      const id = (provider: string) =>
        fleet?.connections.find(
          (c) => fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider,
        )?.id;
      const claude = id('claude');
      const codex = id('codex');
      found = claude && codex ? { claude, codex } : undefined;
      return !!found;
    })
    .toBe(true);
  return found!;
}

function chat(title: string, extra: Record<string, unknown> = {}) {
  return {
    key: hex(),
    session: hex(),
    title,
    preview: `First prompt of ${title}`,
    path: 'C:\\Projects\\voxel',
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    origin: 'desktop',
    location: { computerId, environmentId, path: 'C:\\Projects\\voxel' },
    ...extra,
  };
}

function result(title: string, connectionId: string, answer: string) {
  const runId = crypto.randomUUID();
  return {
    title,
    provider: 'claude',
    model: 'claude-opus-5-5',
    reasoning: 'high',
    location: { computerId, environmentId, path: 'C:\\Projects\\voxel' },
    connectionId,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-02T10:00:00Z',
    messages: [
      {
        role: 'user',
        text: 'Why is the voxel mesh slow?',
        status: 'complete',
        createdAt: '2026-09-01T10:00:00Z',
      },
      {
        role: 'assistant',
        runId,
        status: 'complete',
        createdAt: '2026-09-01T10:00:02Z',
        durationMs: 4200,
        model: 'claude-opus-5-5',
        events: [
          {
            kind: 'tool',
            tool: {
              id: 'claude:t1',
              revision: 2,
              category: 'tool',
              name: 'Run command',
              status: 'complete',
              commandRun: true,
              command: 'cargo bench',
              facts: [],
              sources: [],
              agents: [],
            },
          },
          { kind: 'text', text: answer },
        ],
      },
    ],
  };
}

async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Import chats', exact: true }).click();
  return page.getByRole('dialog', { name: 'Import chats' });
}

test('lists every account’s chats, imports chosen ones into History, and opens them', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const { claude, codex } = await connections(page);
  const desktop = chat('Speed up the voxel mesher', {
    connectionId: claude,
    model: 'claude-opus-5-5',
  });
  const terminal = chat('Tidy the release notes', {
    connectionId: claude,
    origin: 'cli',
    updatedAt: '2026-08-20T10:00:00Z',
    path: 'C:\\Projects\\notes',
  });
  const studio = chat('A chat Agent Studio started', { connectionId: claude, origin: 'studio' });
  const gone = chat('Codex work in a removed folder', {
    connectionId: codex,
    origin: 'cli',
    unavailable: 'Its folder, D:\\Gone, is not on this computer.',
    path: 'D:\\Gone',
    location: { computerId, environmentId, path: 'D:\\Gone' },
    updatedAt: '2026-09-03T10:00:00Z',
  });
  await page.evaluate(
    ({ environmentId, listings, results }) => {
      const w = window as any;
      w.importSources = [
        { id: `claude:${environmentId}:default`, provider: 'claude', environmentId },
        { id: `codex:${environmentId}:default`, provider: 'codex', environmentId },
      ];
      w.importListings = listings;
      w.importResults = results;
    },
    {
      environmentId,
      listings: {
        [`claude:${environmentId}:default`]: {
          source: `claude:${environmentId}:default`,
          // A second, older copy of one session, as a moved session leaves, shows once.
          chats: [
            desktop,
            terminal,
            studio,
            { ...desktop, key: hex(), updatedAt: '2026-08-01T00:00:00Z' },
          ],
        },
        [`codex:${environmentId}:default`]: {
          source: `codex:${environmentId}:default`,
          chats: [gone],
        },
      },
      results: {
        [desktop.key]: result(desktop.title, claude, 'Cache the chunk meshes between frames.'),
        [terminal.key]: 'This chat is no longer in its CLI profile',
      },
    },
  );
  const dialog = await openImport(page);
  const list = dialog.getByRole('list', { name: 'Chats to import' });
  // Agent Studio's own chats stay out of the list unless asked for, newest first.
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.locator('strong')).toHaveText([
    'Codex work in a removed folder',
    'Speed up the voxel mesher',
    'Tidy the release notes',
  ]);
  await expect(list.getByText('Claude app', { exact: true })).toBeVisible();
  await expect(
    list.getByText(/is not on this computer\. It can still be imported to read\./),
  ).toBeVisible();
  await dialog.getByLabel('Show chats Agent Studio started').check();
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await dialog.getByLabel('Show chats Agent Studio started').uncheck();
  await dialog.getByLabel('Search chats').fill('voxel mesher');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await dialog.getByLabel('Search chats').fill('');
  // One account at a time.
  await dialog.getByRole('combobox', { name: 'Account' }).click();
  await page
    .getByRole('option', { name: /^No Codex account|Codex/ })
    .first()
    .click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Account' }).click();
  await page.getByRole('option', { name: /^All accounts/ }).click();
  await expect(list.getByRole('listitem')).toHaveCount(3);

  await dialog.getByLabel(`Import ${desktop.title}`).check();
  await page.screenshot({ path: 'artifacts/import-chats-wide.png', animations: 'disabled' });
  await dialog.getByLabel(`Import ${terminal.title}`).check();
  await dialog.getByRole('button', { name: 'Import 2 chats', exact: true }).click();
  await expect(dialog.getByText('Imported 1 chat into History.')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(
    'Tidy the release notes: This chat is no longer in its CLI profile',
  );
  const calls = await page.evaluate(() => (window as any).importCalls);
  expect(calls.map((c: { key: string }) => c.key)).toEqual([desktop.key, terminal.key]);
  expect(calls[0].connectionId).toBe(claude);
  const imported = (await saved(page)).conversations.find((c) => c.title === desktop.title)!;
  expect(imported).toMatchObject({
    id: calls[0].conversationId,
    archived: true,
    titleStatus: 'generated',
    settings: { provider: 'claude', connectionId: claude, model: 'opus', reasoning: 'high' },
    location: { path: 'C:\\Projects\\voxel' },
  });
  expect(imported.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  // The imported row now opens its conversation; the failed one can be tried again.
  const row = list.getByRole('listitem').filter({ hasText: desktop.title });
  await expect(row.getByText('Imported')).toBeVisible();
  await expect(dialog.getByLabel(`Import ${terminal.title}`)).toBeEnabled();
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.page-title')).toHaveText(desktop.title);
  await expect(page.getByText('Cache the chunk meshes between frames.')).toBeVisible();
  await expect(page.getByRole('tab', { name: /History/ })).toHaveAttribute('aria-selected', 'true');
});

test('reports a computer whose chats could not be read and keeps the rest usable', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const { claude } = await connections(page);
  const one = chat('Readable chat', { connectionId: claude });
  await page.evaluate(
    ({ environmentId, one }) => {
      const w = window as any;
      w.importSources = [
        { id: `claude:${environmentId}:default`, provider: 'claude', environmentId },
        { id: `codex:${environmentId}:default`, provider: 'codex', environmentId },
      ];
      w.importListings = {
        [`claude:${environmentId}:default`]: { source: 'claude', chats: [one] },
        [`codex:${environmentId}:default`]: 'Could not start Codex to read its chats',
      };
    },
    { environmentId, one },
  );
  const dialog = await openImport(page);
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('alert')).toContainText(
    "Codex chats of this computer's CLI: Could not start Codex to read its chats",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByLabel('Import Readable chat')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Import 0 chats' })).toBeDisabled();
  await page.screenshot({ path: 'artifacts/import-chats-narrow.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('keeps a chosen chat chosen when a newer copy of it arrives from another store', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  const { claude } = await connections(page);
  // The Claude app keeps a chat it ran in WSL in the distribution and copies it here; both
  // open on that distribution, in its folder.
  const wslEnvironmentId = '33333333-3333-4333-8333-333333333333';
  const location = {
    computerId,
    environmentId: wslEnvironmentId,
    path: '/home/me/olympus',
  };
  const copy = chat('Booking chat in React', {
    connectionId: claude,
    path: '/home/me/olympus',
    location,
    updatedAt: '2026-09-29T10:00:00Z',
  });
  const original = { ...copy, key: hex(), updatedAt: '2026-09-30T10:00:00Z' };
  const windows = `claude:${environmentId}:default`;
  const wsl = `claude:${wslEnvironmentId}:default`;
  await page.evaluate(
    ({ environmentId, wslEnvironmentId, windows, wsl, copy, original, imported }) => {
      const w = window as any;
      w.importSources = [
        { id: windows, provider: 'claude', environmentId },
        { id: wsl, provider: 'claude', environmentId: wslEnvironmentId },
      ];
      w.holdListings = [wsl];
      w.importListings = {
        [windows]: { source: windows, chats: [copy] },
        [wsl]: { source: wsl, chats: [original] },
      };
      w.importResults = { [original.key]: imported };
    },
    {
      environmentId,
      wslEnvironmentId,
      windows,
      wsl,
      copy,
      original,
      imported: { ...result(copy.title, claude, 'Done.'), location },
    },
  );
  const dialog = await openImport(page);
  const list = dialog.getByRole('list', { name: 'Chats to import' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText('olympus', { exact: true })).toBeVisible();
  await dialog.getByLabel(`Import ${copy.title}`).check();
  await page.evaluate((wsl) => (window as any).releaseListing[wsl](), wsl);
  await expect(dialog.getByRole('status')).toHaveText('1 chat');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByLabel(`Import ${copy.title}`)).toBeChecked();
  await dialog.getByRole('button', { name: 'Import 1 chat', exact: true }).click();
  await expect(dialog.getByText('Imported 1 chat into History.')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).importCalls);
  expect(calls.map((c: { key: string }) => c.key)).toEqual([original.key]);
  const conversation = (await saved(page)).conversations.find((c) => c.title === copy.title)!;
  expect(conversation.location).toEqual(location);
});
