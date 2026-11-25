import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { initialWorkspace } from '../src/lib/domain';

// This computer's reservations for measurements (src-tauri/src/reservations.rs): the window
// shows the one holding it now and every one its history kept.
test('the reservations window shows the computer now and each past measurement with what it waited for @webkit', async ({
  page,
}) => {
  const workspace = initialWorkspace();
  const at = '2026-11-24T10:00:00.000Z';
  const bench = crypto.randomUUID();
  const art = crypto.randomUUID();
  const gone = crypto.randomUUID();
  for (const [id, title] of [
    [bench, 'Chunk benchmark'],
    [art, 'Level art'],
  ])
    workspace.conversations.push({
      id,
      title,
      archived: true,
      createdAt: at,
      updatedAt: at,
      settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
      messages: [],
    });
  const start = Date.parse('2026-11-24T20:00:00.000Z');
  const gb = 1024 ** 3;
  const measured = {
    id: 'pc-2',
    conversationId: bench,
    purpose: 'Benchmark of chunk meshing',
    minutes: 2,
    askedAt: start + 60_000,
    openedAt: start + 69_114,
    endedAt: start + 90_000,
    endedBy: 'release',
    waitedMs: 9114,
    windowMs: 20_847,
    blockers: [
      { conversationId: art, label: 'handing over', ms: 6344 },
      { conversationId: art, label: 'Level step 2 `Start-Sleep -Seconds 15`', ms: 4654 },
    ],
    others: [],
    held: {
      chats: 1,
      ms: 19_400,
      refused: 2,
      causes: [{ conversationId: art, label: 'handing over', ms: 5000 }],
    },
    asks: [
      {
        conversationId: art,
        readMs: 1887,
        endedMs: 6344,
        ended: 'handed over',
        programs: [{ name: 'UnrealEditor.exe', outcome: 'closed' }],
      },
    ],
    stopped: [
      {
        by: bench,
        conversationId: gone,
        background: true,
        programs: [{ name: 'node.exe', outcome: 'ended' }],
      },
    ],
    machine: {
      samples: 10,
      cpuAverage: 42.3,
      cpuPeak: 55,
      holderAverage: 2.8,
      othersAverage: 39.5,
      othersPeak: 52,
      memoryTotal: 64 * gb,
      memoryUsedPeak: 33 * gb,
      memoryAvailableLeast: 24 * gb,
      programs: [
        {
          name: 'cl.exe',
          owner: 'user',
          processes: 2,
          cpuAverage: 5.1,
          cpuPeak: 21,
          memoryPeak: 2 * gb,
        },
        {
          name: 'UnrealEditor.exe',
          owner: { chat: art },
          processes: 1,
          cpuAverage: 2,
          cpuPeak: 4,
          memoryPeak: 14 * gb,
        },
      ],
    },
  };
  // Kept before hand-overs and stops were recorded, and ended before its window opened.
  const unopened = {
    id: 'pc-1',
    conversationId: bench,
    purpose: 'Profile the build',
    minutes: null,
    askedAt: start,
    openedAt: null,
    endedAt: start + 30_000,
    endedBy: 'reply',
    waitedMs: null,
    windowMs: null,
    blockers: [{ conversationId: art, label: '`cargo build`', ms: 30_000 }],
    others: [],
    held: { chats: 0, ms: 0, refused: 0, causes: [] },
    machine: {
      samples: 0,
      cpuAverage: 0,
      cpuPeak: 0,
      holderAverage: 0,
      othersAverage: 0,
      othersPeak: 0,
      memoryTotal: 0,
      memoryUsedPeak: 0,
      memoryAvailableLeast: null,
      programs: [],
    },
  };
  const now = {
    reservations: [
      {
        id: 'pc-3',
        conversationId: bench,
        purpose: 'Benchmark again',
        phase: 'draining',
        askedAt: Date.now() - 5000,
        waitingFor: [
          { conversationId: art, label: '`npm test`' },
          { conversationId: art, label: 'handing over', handOver: true },
        ],
        held: 1,
      },
    ],
  };
  await mockDesktop(page);
  await page.addInitScript(
    ({ w, history, state }) => {
      localStorage.setItem('test-workspace', JSON.stringify(w));
      if (!sessionStorage.getItem('pc-seeded')) {
        sessionStorage.setItem('pc-seeded', '1');
        localStorage.setItem('test-pc-history', JSON.stringify(history));
        localStorage.setItem('test-pc-state', JSON.stringify(state));
      }
    },
    { w: workspace, history: [unopened, measured, 'a line that is not a record'], state: now },
  );
  await page.goto('/');

  // The gauge says what the measurement waits for, and opens the window.
  const gauge = page.locator('.pc-reserved');
  await expect(gauge).toHaveAttribute(
    'title',
    'Computer reserved: Benchmark again · Chunk benchmark · Waiting for 1 command and 1 chat to hand over · 1 chat waits',
    // Named once the workspace loaded.
    { timeout: 15_000 },
  );
  await gauge.click();
  const dialog = page.getByRole('dialog', { name: 'Reservations' });
  await expect(dialog).toBeVisible();
  const live = dialog.getByLabel('Now');
  await expect(live.locator('.live-head')).toContainText('Waiting');
  await expect(live.locator('.live-head .name')).toHaveText(
    /^\s*Benchmark again\s*· Chunk benchmark\s*$/,
  );
  await expect(live.locator('.waits li')).toHaveText([
    /Level art\s*· npm test/,
    /Level art\s*· handing over/,
    /1 chat waits/,
  ]);

  // What the measurements took together, then each one, newest first.
  await expect(dialog.locator('.tiles li')).toHaveText([
    /Measurements\s*2\s*20\.8s measuring/,
    /Waited to start\s*39\.1s/,
    /Other chats waited\s*19\.4s\s*2 commands/,
  ]);
  const history = dialog.getByLabel('History');
  const rows = history.locator('button.row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.name')).toContainText(
    'Benchmark of chunk meshing · Chunk benchmark',
  );
  await expect(rows.nth(0).locator('.time')).toHaveText('30.0s');
  await expect(rows.nth(0).locator('.share')).toHaveText('40%');
  await expect(rows.nth(1).locator('.name')).toContainText('Profile the build');
  await expect(rows.nth(1).locator('.share')).toHaveText('');

  // One measurement: why it waited, who handed over, what was stopped, how busy it all was.
  await rows.nth(0).click();
  await expect(dialog.locator('.stepper')).toContainText('2 of 2');
  await expect(dialog.locator('.purpose')).toHaveText('Benchmark of chunk meshing');
  await expect(dialog.locator('.identity-text')).toContainText('Chunk benchmark');
  await expect(dialog.locator('.identity-text')).toContainText('Released');
  await expect(dialog.locator('.tiles li')).toHaveText([
    /Waited to start\s*9\.1s/,
    /Measuring\s*20\.8s/,
    /Other chats waited\s*19\.4s\s*1 chat · 2 commands/,
    /Other programs' CPU\s*40%\s*52% at most/,
  ]);
  await expect(dialog.getByLabel('Before it opened').locator('.row')).toHaveText([
    /Level art\s*· handing over\s*6\.3s/,
    /Level art\s*· Level step 2 Start-Sleep -Seconds 15\s*4\.7s/,
  ]);
  await expect(dialog.getByLabel('Hand-overs').locator('li')).toHaveText(
    /Level art\s*Handed over after 6\.3s\s*· read after 1\.9s\s*· UnrealEditor\.exe closed/,
  );
  await expect(dialog.getByLabel('Stopped').locator('li')).toHaveText(
    /Another chat\s*node\.exe ended, background work stopped/,
  );
  await expect(dialog.locator('.stats')).toContainText(/CPU\s*42%\s*· 55% at most/);
  await expect(dialog.getByLabel('Other programs').locator('.row')).toHaveText([
    /cl\.exe\s*×2\s*· Yours\s*5\.1%\s*· 21%\s*2\.0 GB/,
    /UnrealEditor\.exe\s*· Level art\s*2\.0%\s*· 4\.0%\s*14 GB/,
  ]);
  await expect(dialog.getByLabel('Why other chats waited').locator('.row')).toHaveText(
    /Level art\s*· handing over\s*5\.0s/,
  );
  // The one before, which never opened.
  await dialog.getByRole('button', { name: 'Earlier reservation' }).click();
  await expect(dialog.locator('.stepper')).toContainText('1 of 2');
  await expect(dialog.locator('.identity-text')).toContainText('Its reply ended');
  await expect(dialog.locator('.tiles li').nth(1)).toHaveText(/Measuring\s*Never opened/);
  await expect(dialog.getByLabel('Before it opened').locator('.row')).toHaveText(
    /Level art\s*· cargo build\s*30\.0s/,
  );
  await dialog.getByRole('button', { name: 'All', exact: true }).click();
  await expect(rows).toHaveCount(2);

  // A reservation that ends joins the history.
  await page.evaluate(
    (record) => {
      const history = JSON.parse(localStorage.getItem('test-pc-history')!);
      localStorage.setItem('test-pc-history', JSON.stringify([...history, record]));
      localStorage.setItem('test-pc-state', '{"reservations":[]}');
      (window as any).emitTauriEvent('studio-pc', { reservations: [] });
    },
    {
      ...measured,
      id: 'pc-3',
      purpose: 'Benchmark again',
      askedAt: start + 120_000,
      endedAt: start + 150_000,
    },
  );
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator('.name')).toContainText('Benchmark again');
  await expect(dialog.getByLabel('Now')).toHaveCount(0);
  await expect(gauge).toHaveCount(0);

  // A chat it names opens from it.
  await rows.nth(0).click();
  await dialog.getByRole('button', { name: 'Open chat' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.topbar .page-title')).toHaveText('Chunk benchmark');

  // /reservations opens it too, without the gauge.
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('/reservations');
  await input.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Reservations' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Reservations' })).toHaveCount(0);
});
