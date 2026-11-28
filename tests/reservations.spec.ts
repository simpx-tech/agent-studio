import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { initialWorkspace } from '../src/lib/domain';
import { chooseTestFolder } from './folder-helper';

// This computer's reservations for measurements (src-tauri/src/reservations.rs): the window
// shows the one holding it now and every one its history kept.
test('the reservations window shows the computer now and each past measurement with what it waited for @webkit', async ({
  page,
}) => {
  const workspace = initialWorkspace();
  const at = '2026-11-24T10:00:00.000Z';
  const bench = crypto.randomUUID();
  const art = crypto.randomUUID();
  const physics = crypto.randomUUID();
  const gone = crypto.randomUUID();
  for (const [id, title] of [
    [bench, 'Chunk benchmark'],
    [art, 'Level art'],
    [physics, 'Physics tuning'],
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
    lullMs: 4000,
    contaminated: true,
    ranBeside: [
      { conversationId: art, label: 'Level step 3 `npm test`', ms: 3000 },
      {
        owner: { session: 'claude-cli' },
        name: 'cl.exe',
        ms: 8000,
        cpuAverage: 41,
        cpuPeak: 60,
      },
    ],
    blockers: [
      { conversationId: art, label: 'handing over', ms: 6344 },
      { conversationId: art, label: 'Level step 2 `Start-Sleep -Seconds 15`', ms: 4654 },
    ],
    others: [],
    // Work that stayed idle beside it, which the window did not wait for.
    idle: [{ conversationId: art, label: '`python3 watch-pr-comments.py 5201`', ms: 12_000 }],
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
    frozen: [{ conversationId: art, name: 'ShaderCompileWorker.exe', processes: 3 }],
    machine: {
      samples: 10,
      cpuAverage: 42.3,
      cpuPeak: 55,
      holderAverage: 2.8,
      insideWsl: true,
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
        {
          name: 'vmmemWSL',
          owner: 'wsl',
          processes: 1,
          cpuAverage: 1,
          cpuPeak: 3,
          memoryPeak: 6 * gb,
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
          { conversationId: art, label: '`npm test`', since: Date.now() - 5000 },
          { conversationId: art, label: 'handing over', handOver: true },
        ],
        held: 1,
      },
    ],
    // A chat waits for it, with the command it asked to run.
    waiting: [physics],
    waits: [
      {
        conversationId: physics,
        since: Date.now() - 4000,
        label: 'Run the physics tests `npm test -- physics`',
      },
    ],
    // A build runs on its grant beside one outside Agent Studio, and leaves no slot.
    grants: [
      {
        conversationId: bench,
        weight: 'build',
        bytes: 12 * gb,
        since: Date.now() - 120_000,
        label: 'Build the editor `Tools/Build.ps1 -Editor`',
      },
    ],
    builds: {
      running: [
        { conversationId: bench, label: 'Build the editor `Tools/Build.ps1 -Editor`' },
        { label: 'A build of yours: cl.exe with 6 compilers' },
      ],
      slots: 1,
      available: 6 * gb,
    },
    // A repository's landing turn with a chat in line for it, and a build waiting for a slot.
    turns: [
      {
        id: 'turn-1',
        name: 'the landing of github.com/simpx-tech/bluevox',
        landing: true,
        conversationId: bench,
        purpose: 'Final pipeline and push',
        askedAt: Date.now() - 60_000,
        grantedAt: Date.now() - 60_000,
      },
      {
        id: 'turn-2',
        name: 'the landing of github.com/simpx-tech/bluevox',
        landing: true,
        conversationId: art,
        purpose: 'Final pipeline and push',
        askedAt: Date.now() - 30_000,
      },
    ],
    slots: [
      {
        conversationId: art,
        label: '`Tools/Build.ps1`',
        since: Date.now() - 10_000,
        why: 'slots',
      },
    ],
  };
  // A landing turn that ended.
  const landed = {
    kind: 'turn',
    id: 'turn-0',
    conversationId: art,
    name: 'the landing of github.com/simpx-tech/bluevox',
    landing: true,
    purpose: 'Merge and push',
    askedAt: start + 100_000,
    grantedAt: start + 105_000,
    endedAt: start + 160_000,
    endedBy: 'release',
    waitedMs: 5000,
    heldMs: 55_000,
    waiting: 0,
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
    {
      w: workspace,
      history: [unopened, measured, landed, 'a line that is not a record'],
      state: now,
    },
  );
  await page.goto('/');

  // The gauge says what the measurement waits for, and opens the window.
  const gauge = page.locator('.pc-reserved');
  await expect(gauge).toHaveAttribute(
    'title',
    'Computer reserved: Benchmark again · Chunk benchmark · Waiting for 1 command and 1 chat to hand over · 1 chat waits · 1 build waits for a slot · 1 chat waits for a turn',
    // Named once the workspace loaded.
    { timeout: 15_000 },
  );
  await gauge.click();
  const dialog = page.getByRole('dialog', { name: 'Reservations' });
  await expect(dialog).toBeVisible();
  // What is waited for now, one card each, saying who holds it, what that holder waits on, and
  // who waits for it with what they asked to run (requested 2026-11-28).
  const computer = dialog.getByLabel('The computer');
  await expect(computer.locator('.live-head .tag')).toHaveText('Waiting to start');
  await expect(computer.locator('.live-head .name')).toHaveText(
    /^\s*Reserved by Chunk benchmark\s*$/,
  );
  await expect(computer.locator('.purpose-line')).toHaveText('Benchmark again');
  await expect(computer.locator('.state-line')).toHaveText(
    "Other chats' new commands and tool calls wait. It measures once the work below ends.",
  );
  await expect(computer.locator('h4')).toHaveText([
    'Its measurement waits for',
    'Waiting for it · 1',
  ]);
  // Each with how long it has run or waited, by the clock.
  await expect(computer.locator('.entry')).toHaveText([
    /^\s*Level art\s*npm test\s*\d+s\s*$/,
    /^\s*Level art\s*Asked to hand over what it holds\s*$/,
    /^\s*Physics tuning\s*Run the physics tests npm test -- physics\s*\d+s\s*$/,
  ]);
  await expect(computer.locator('.entry.waits-here')).toHaveCount(1);
  // Builds: which run, on how much memory, and why the one waiting waits.
  const work = dialog.getByLabel('Builds and runs');
  await expect(work.locator('h3')).toHaveText(/Builds and runs\s*· 1 build at once · 6\.0 GB free/);
  await expect(work.locator('.entry')).toHaveText([
    /Chunk benchmark\s*Build the editor Tools\/Build\.ps1 -Editor\s*12 GB\s*2m/,
    /^\s*A build of yours: cl\.exe with 6 compilers\s*$/,
    /Level art\s*Tools\/Build\.ps1\s*One build runs at a time here\s*\d+s/,
  ]);
  // A landing turn: who holds it and who is next.
  const turn = dialog.getByLabel('Landing of github.com/simpx-tech/bluevox');
  await expect(turn.locator('.live-head .name')).toHaveText(/^\s*By Chunk benchmark\s*$/);
  await expect(turn.locator('.purpose-line')).toHaveText('Final pipeline and push');
  await expect(turn.locator('.entry')).toHaveText(/Level art\s*Final pipeline and push\s*\d+s/);

  // What the measurements took together, then each one, newest first.
  await expect(dialog.locator('.tiles li')).toHaveText([
    /Measurements\s*2\s*20\.8s measuring/,
    /Ran beside other work\s*1\s*of 2/,
    /Waited to start\s*39\.1s/,
    /Other chats waited\s*19\.4s\s*2 commands/,
  ]);
  // The turns its history kept.
  await expect(dialog.getByLabel('Turns').locator('li')).toHaveText(
    /Landing of github\.com\/simpx-tech\/bluevox\s*Level art\s*· Merge and push · .* · held 55\.0s · waited 5\.0s/,
  );
  const history = dialog.getByLabel('History');
  const rows = history.locator('button.row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.name')).toContainText(
    'Benchmark of chunk meshing · Chunk benchmark',
  );
  await expect(rows.nth(0).locator('.time')).toHaveText('30.0s');
  await expect(rows.nth(0).locator('.share')).toHaveText('40%');
  await expect(rows.nth(0).locator('.share')).toHaveAttribute(
    'title',
    'Ran beside other heavy work',
  );
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
    /Measurement\s*Ran beside other work/,
  ]);
  await expect(dialog.getByLabel('Ran beside it').locator('.row')).toHaveText([
    /Level art\s*· Level step 3 npm test\s*3\.0s/,
    /Claude Code outside Agent Studio\s*· cl\.exe\s*8\.0s\s*41%/,
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
  await expect(dialog.getByLabel('Held until it ended').locator('li')).toHaveText(
    /Level art\s*ShaderCompileWorker\.exe\s*×3/,
  );
  await expect(dialog.locator('.stats')).toContainText(/CPU\s*42%\s*· 55% at most/);
  await expect(dialog.locator('.stats')).toContainText(/This chat\s*2\.8%\s*· with WSL/);
  await expect(dialog.getByLabel('Other programs').locator('.row')).toHaveText([
    /cl\.exe\s*×2\s*· Yours\s*5\.1%\s*· 21%\s*2\.0 GB/,
    /UnrealEditor\.exe\s*· Level art\s*2\.0%\s*· 4\.0%\s*14 GB/,
    /vmmemWSL\s*· WSL\s*1\.0%\s*· 3\.0%\s*6\.0 GB/,
  ]);
  await expect(dialog.getByRole('heading', { name: "Other chats' idle work" })).toBeVisible();
  await expect(dialog.locator('.facts').filter({ hasText: 'watch-pr-comments' })).toHaveText(
    /Level art\s*python3 watch-pr-comments\.py 5201\s*· 12\.0s/,
  );
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
  await expect(dialog.locator('.resource')).toHaveCount(0);
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

// How long a measurement waits for a lull before it holds other chats' work is this
// computer's own setting (src-tauri/src/reservations.rs, `Settings`).
test('Settings sets how long a measurement waits for a lull before it holds other chats', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Reservations', exact: true });
  const picker = section.getByRole('combobox', { name: 'Hold other chats after' });
  await expect(picker).toHaveText(/3 minutes/);
  await picker.click();
  await expect(page.getByRole('option')).toHaveText([
    /At once/,
    /1 minute/,
    /2 minutes/,
    /3 minutes/,
    /5 minutes/,
    /10 minutes/,
    /15 minutes/,
    /30 minutes/,
  ]);
  await page.getByRole('option', { name: '10 minutes', exact: true }).click();
  await expect(picker).toHaveText(/10 minutes/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('test-pc-settings')))
    .toBe('{"lullMinutes":10}');
});

// Requested 2026-11-26: the gauge is always in the sidebar's footer, a chat's row says where it
// stands with this computer (reserving it, or waiting for it, a build slot or its turn) as the
// monitoring pulse marks a monitor, the running reply of a chat that waits says so in a card of
// its own, and the Reservations window opens again after a click on its backdrop closed it.
test('rows and the running reply show who reserves and who waits, and the gauge always opens the window', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  const gauge = page.locator('.pc-button');
  // Shown once the app loaded, which a busy computer takes a while for.
  await expect(gauge).toBeVisible({ timeout: 15_000 });
  await expect(gauge).toHaveAttribute('title', 'Reservations');
  await expect(gauge).not.toHaveClass(/pc-reserved/);

  // A chat whose reply runs.
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Waiting chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as any).capabilityRuns ?? {}).length))
    .toBe(1);
  const me = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
        (c: any) => c.title === 'Waiting chat',
      )?.id as string,
  );
  expect(me).toBeTruthy();
  const send = (snapshot: object) =>
    page.evaluate(
      (snapshot) => (window as any).emitTauriEvent('studio-pc', snapshot),
      { reservations: [], turns: [], slots: [], waiting: [], grants: [], ...snapshot },
    );
  const row = page.locator('.conversation-item', { hasText: 'Waiting chat' });
  const card = page.locator('.pc-hold');
  const reply = page.getByTestId('message').last();
  const holder = crypto.randomUUID();
  const reserved = {
    id: 'pc-1',
    conversationId: holder,
    purpose: 'Frame timing',
    phase: 'draining',
    askedAt: Date.now(),
    waitingFor: [
      {
        conversationId: crypto.randomUUID(),
        label: 'Rebuild the candidate `Build.ps1 -Candidate`',
        since: Date.now() - 90_000,
      },
    ],
    held: 1,
  };

  // The reply has worked a little.
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 'claude:status',
        name: 'Run command',
        category: 'tool',
        operation: 'command',
        commandRun: true,
        command: 'git status',
        revision: 2,
        status: 'complete',
        facts: [],
        sources: [],
        agents: [],
      },
    }),
  );
  await expect(reply.locator('.tool-activity')).toBeVisible();

  // Another chat reserves the computer and this one waits for it: a card in the warning colour
  // says who reserved it, what that measurement still waits for and what this chat waits to run,
  // at the end of the reply's live work, never above it (requested 2026-11-28).
  await send({
    reservations: [reserved],
    waiting: [me],
    waits: [{ conversationId: me, since: Date.now() - 30_000, label: 'Run the tests `npm test`' }],
  });
  await expect(row.locator('.conversation-held')).toBeVisible();
  await expect(row).toHaveAttribute(
    'title',
    /Waiting for the computer: Another chat reserved it: Frame timing/,
  );
  await expect(card.locator('.pc-hold-head strong')).toHaveText('Waiting for the computer');
  await expect(card.locator('.pc-hold-time')).toHaveText(/^3\ds$/);
  await expect(card.locator('.pc-holder')).toHaveText(
    /^\s*Another chat\s*reserved the computer to measure:\s*Frame timing\s*$/,
  );
  await expect(card.locator('.pc-status')).toHaveCount(0);
  await expect(card.locator('.pc-label')).toHaveText('Its measurement waits for');
  await expect(card.locator('.pc-work li')).toHaveText(
    /Another chat\s*Rebuild the candidate Build\.ps1 -Candidate\s*1m 3\ds/,
  );
  await expect(card.locator('.pc-facts')).toHaveText(/Waiting to run\s*Run the tests npm test/);
  await expect(page.locator('.live-label')).toHaveText(/Waiting for the computer/);
  await expect(gauge).toHaveClass(/pc-reserved/);
  // Nothing above the reply's work: the card follows it.
  const order = () =>
    reply.evaluate((message) => {
      const card = message.querySelector('.pc-hold');
      const work = message.querySelector('.tool-activity');
      return !!card && !!work && !!(work.compareDocumentPosition(card) & 4);
    });
  await expect.poll(order).toBe(true);

  // Its agent waits with pc_wait: the card takes that call's row.
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 'claude:wait',
        name: 'Wait for the computer',
        category: 'tool',
        operation: 'pcWait',
        revision: 1,
        status: 'running',
        facts: [],
        sources: [],
        agents: [],
      },
    }),
  );
  await expect(reply.locator('.live-item .pc-hold')).toBeVisible();
  await expect(card).toHaveCount(1);
  await expect(reply.locator('.live-row')).toHaveCount(0);

  // Its own measurement waits for its window: the card says for whose work.
  await send({ reservations: [{ ...reserved, conversationId: me, held: 0 }] });
  await expect(card.locator('.pc-hold-head strong')).toHaveText(
    'Waiting for other chats to finish',
  );
  await expect(card.locator('.pc-label')).toHaveText('Its measurement waits for');
  await expect(card.locator('.pc-facts')).toHaveText(/To measure\s*Frame timing/);
  await expect(row.locator('.conversation-reserving')).toBeVisible();

  // Its build waits for a slot: the card says how long it has waited, why, and on which builds.
  await send({
    slots: [
      {
        conversationId: me,
        label: '`Tools/Build.ps1`',
        weight: 'build',
        since: Date.now() - 65_000,
        why: 'slots',
      },
    ],
    builds: {
      running: [{ label: 'A build of yours: cl.exe with 6 compilers' }],
      slots: 1,
    },
  });
  await expect(card.locator('.pc-hold-head strong')).toHaveText('Waiting for a build slot');
  await expect(card.locator('.pc-hold-time')).toHaveText(/^1m/);
  await expect(card.locator('.pc-status')).toHaveText('One build runs at a time here');
  await expect(card.locator('.pc-label')).toHaveText('Builds running');
  await expect(card.locator('.pc-work li')).toHaveText(
    /A build of yours: cl\.exe with 6 compilers/,
  );
  await expect(card.locator('.pc-facts')).toHaveText(
    /Waiting to run\s*Tools\/Build\.ps1\s*Place\s*First/,
  );
  await expect(row.locator('.conversation-held')).toBeVisible();

  // It reserves the computer itself and measures: the gauge in the accent, on its row too.
  await send({
    reservations: [
      {
        id: 'pc-2',
        conversationId: me,
        purpose: 'Frame timing',
        phase: 'open',
        askedAt: Date.now(),
        openedAt: Date.now(),
        waitingFor: [],
        held: 0,
      },
    ],
  });
  await expect(row.locator('.conversation-reserving.measuring')).toBeVisible();
  await expect(row.locator('.conversation-held')).toHaveCount(0);
  await expect(card).toHaveCount(0);

  // Nothing reserved: no mark, and the gauge stays, quiet.
  await send({});
  await expect(row.locator('.conversation-reserving')).toHaveCount(0);
  await expect(gauge).not.toHaveClass(/pc-reserved/);
  await expect(gauge).toHaveAttribute('title', 'Reservations');

  // The window opens from it, closes on its backdrop, and opens again.
  const dialog = page.getByRole('dialog', { name: 'Reservations' });
  await gauge.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(3, 3);
  await expect(dialog).toHaveCount(0);
  await gauge.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => {
    const run = (Object.values((window as any).capabilityRuns) as any[]).at(-1);
    run.finish('complete');
  });
});