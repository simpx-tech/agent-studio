import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test.use({ locale: 'en-US' });

const output = 'artifacts/sidebar-marks';
const input = (page: Page) => page.getByLabel('Message', { exact: true });
const panel = (page: Page) => page.locator('#conversation-panel-active');
const row = (page: Page, title: string) =>
  panel(page)
    .locator('.conversation-item')
    .filter({ has: page.getByText(title, { exact: true }) });
const mark = (page: Page, title: string) => row(page, title).locator('.chat-uses');
// The color a mark's frame is drawn in, as its style names it.
const frame = (locator: Locator) =>
  locator.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--account-color'));
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));

type Chat = { title: string; provider: string; model: string; account: string; ran: string };
const chats: Chat[] = [
  {
    title: 'Opus chat',
    provider: 'claude',
    model: 'opus',
    account: 'Claude CLI login',
    ran: 'Opus 5.5',
  },
  {
    title: 'Sonnet chat',
    provider: 'claude',
    model: 'sonnet',
    account: 'Second Claude',
    ran: 'Sonnet 5',
  },
  {
    title: 'Sol chat',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    account: 'Codex CLI login',
    ran: 'GPT-5.6 Sol',
  },
  {
    title: 'Default chat',
    provider: 'claude',
    model: '',
    account: 'Claude CLI login',
    ran: 'CLI default',
  },
  // Its account was removed.
  { title: 'Orphan chat', provider: 'claude', model: 'fable', account: '', ran: 'Fable 5.1' },
];

/**
 * Chats on several models and accounts, copied from one sent through the composer so each keeps
 * its folder, and a second Claude account. A slow reply is stopped first.
 */
async function seed(page: Page, mode?: string) {
  await mockDesktop(page, mode);
  // The reload below is no new start of the app, which would move every chat to History.
  await page.addInitScript(() => {
    const session = JSON.parse(localStorage.getItem('test-app-session') ?? 'null');
    localStorage.setItem(
      'test-app-session',
      JSON.stringify(
        session
          ? { ...session, reloaded: true }
          : { id: crypto.randomUUID(), startedAt: Date.now() - 3_600_000 },
      ),
    );
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await input(page).fill('Seed');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  if (mode === 'slow') await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute(
    'data-status',
    mode === 'slow' ? 'cancelled' : 'complete',
  );
  await page.evaluate((chats) => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const fleet = workspace.fleet;
    const environmentId = fleet.connections[0].environmentId;
    const accountId = crypto.randomUUID();
    fleet.accounts.push({
      id: accountId,
      name: 'Second Claude',
      provider: 'claude',
      purpose: 'personal',
    });
    fleet.connections.push({
      id: crypto.randomUUID(),
      environmentId,
      accountId,
      profile: 'isolated',
    });
    const connectionOf = (name: string) => {
      if (!name) return crypto.randomUUID();
      const account = fleet.accounts.find((a: { name: string }) => a.name === name);
      return fleet.connections.find((c: { accountId: string }) => c.accountId === account.id).id;
    };
    const [seed] = workspace.conversations;
    const now = Date.now();
    workspace.conversations = chats.map((chat, index) => {
      const settings = {
        ...seed.settings,
        provider: chat.provider,
        model: chat.model,
        reasoning: '',
        connectionId: connectionOf(chat.account),
      };
      const at = new Date(now - index * 60_000).toISOString();
      const [question, answer] = seed.messages;
      return {
        ...seed,
        id: crypto.randomUUID(),
        title: chat.title,
        settings,
        createdAt: at,
        updatedAt: at,
        messages: [
          { ...question, id: crypto.randomUUID(), createdAt: at },
          {
            ...answer,
            id: crypto.randomUUID(),
            createdAt: at,
            status: 'complete',
            settings,
            modelName: chat.ran,
            usage: undefined,
          },
        ],
      };
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  }, chats);
  await page.reload();
  await expect(row(page, chats[0].title)).toBeVisible();
  // Every account has its color once the new one took its own.
  await expect.poll(async () => (await saved(page)).accountColors?.length).toBe(4);
  const workspace = await saved(page);
  const colors = new Map<string, string>(
    workspace.accountColors.map((c: { accountId: string; color: string }) => [
      c.accountId,
      c.color,
    ]),
  );
  return (name: string) => {
    const account = workspace.fleet.accounts.find((a: { name: string }) => a.name === name);
    return `var(--account-${colors.get(account.id)})`;
  };
}

test('each chat’s row shows its model’s print framed in its account’s color @webkit', async ({
  page,
}) => {
  await mkdir(output, { recursive: true });
  const color = await seed(page);
  const lines: Record<string, string> = {
    'Opus chat': 'opus',
    'Sonnet chat': 'sonnet',
    'Sol chat': 'sol',
    // A model the reply could not name has its provider's glyph.
    'Default chat': 'none',
    'Orphan chat': 'fable',
  };
  for (const chat of chats) {
    const uses = mark(page, chat.title);
    await expect(uses).toHaveAttribute('data-line', lines[chat.title]);
    // Hovering the mark names the model and the account, and so does the row's description,
    // while its name stays its title.
    const label = [chat.ran, chat.account].filter(Boolean).join(' · ');
    await expect(uses).toHaveAttribute('title', label);
    await expect(row(page, chat.title)).toHaveAccessibleDescription(label);
    await expect(panel(page).getByRole('button', { name: chat.title, exact: true })).toBeVisible();
    // The mark adds no text to the row.
    expect(await row(page, chat.title).evaluate((element) => element.textContent)).toBe(chat.title);
    if (chat.account) {
      await expect(uses).toHaveClass(/accounted/);
      expect(await frame(uses)).toBe(color(chat.account));
    } else {
      // A chat whose account is gone keeps its print, unframed, in the same place.
      await expect(uses).not.toHaveClass(/accounted/);
      expect(await frame(uses)).toBe('');
    }
  }
  await expect(mark(page, 'Default chat').locator('.art')).toHaveAttribute('data-glyph', '✳︎');
  // Every mark is the same size at the start of its row, before its title, whatever the title.
  const boxes = await panel(page)
    .locator('.chat-uses')
    .evaluateAll((marks) =>
      marks.map((element) => {
        const box = element.getBoundingClientRect();
        const item = element.closest('.conversation-item')!;
        const row = item.getBoundingClientRect();
        const title = item.querySelector(':scope > span')!.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          gap: Math.round(box.left - row.left),
          before: box.right <= title.left,
        };
      }),
    );
  expect(boxes).toHaveLength(chats.length);
  expect(new Set(boxes.map((box) => `${box.width}x${box.height}:${box.gap}`)).size).toBe(1);
  expect(boxes[0].width).toBe(18);
  expect(boxes.every((box) => box.before)).toBe(true);
  // Frames of the two Claude accounts differ.
  expect(color('Claude CLI login')).not.toBe(color('Second Claude'));
  await panel(page).screenshot({ path: `${output}/rows.png` });

  // A model chosen for the next reply shows at once.
  await row(page, 'Opus chat').click();
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  await expect(mark(page, 'Opus chat')).toHaveAttribute('data-line', 'sonnet');
  await expect(row(page, 'Opus chat')).toHaveAccessibleDescription('Sonnet · Claude CLI login');
});

test('a running reply’s row keeps its account until it ends, then shows the next reply’s', async ({
  page,
}) => {
  const color = await seed(page, 'slow');
  await row(page, 'Opus chat').click();
  await input(page).fill('Keep going');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  // The mock catalog names the alias Opus, as the new reply records it.
  await expect(row(page, 'Opus chat')).toHaveAccessibleDescription('Opus · Claude CLI login');
  // Another account for the next message leaves the running reply's frame in place.
  const agent = page.getByRole('combobox', { name: 'Agent', exact: true });
  await agent.click();
  await page.getByRole('option', { name: 'Claude · Second Claude', exact: true }).click();
  await expect(agent).toContainText('Second Claude');
  expect(await frame(mark(page, 'Opus chat'))).toBe(color('Claude CLI login'));
  await expect(row(page, 'Opus chat')).toHaveAccessibleDescription('Opus · Claude CLI login');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(row(page, 'Opus chat')).toHaveAccessibleDescription('Opus · Second Claude');
  expect(await frame(mark(page, 'Opus chat'))).toBe(color('Second Claude'));
});
