import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../relay/server';
import { installation, largeWorkspace } from './large-workspace';

// A desktop with a heavy saved workspace, paired with a real relay. See docs/PERFORMANCE.md.
const token = 'synthetic-performance-relay-key-for-browser-checks';
// The longest main-thread task each interaction may take in the development build. With this
// workspace, relay polls that merged and saved everything took 370–440 ms each and fleet
// lookups that copied the whole workspace held Connections for 1.9 s; the current code has no
// task over 50 ms while idle or selecting and about 60 ms opening Connections.
const budgets = { idle: 100, connections: 250, selection: 150, streaming: 150 };

async function desktop(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-performance-'));
  const relay = createRelay({ token, directory });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const requests: string[] = [];
  await page.exposeFunction('relayBridge', async (method: string, path: string, body?: unknown) => {
    requests.push(`${method} ${path}`);
    const response = await fetch(`${origin}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': installation.id,
        'content-type': 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  });
  const workspace = largeWorkspace();
  await page.exposeFunction('savedWorkspace', () => workspace);
  await page.addInitScript(
    ({ installation, origin }) => {
      if (window.top !== window) return;
      const w = window as any;
      w.isTauri = true;
      w.saves = { workspace: 0, sync: 0 };
      w.longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          w.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      const status = (id: string) => ({
        id,
        installed: true,
        auth: 'ready',
        version: 'Synthetic CLI',
        detail: 'Verified fixture',
        location: 'Windows',
      });
      let sync: unknown = null;
      let next = 0;
      const callbacks = new Map<number, (value: unknown) => void>();
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(callback: (value: unknown) => void) {
          callbacks.set(++next, callback);
          return next;
        },
        unregisterCallback() {},
        async invoke(command: string, args: any) {
          switch (command) {
            case 'get_installation':
              return installation;
            case 'load_workspace':
              return w.savedWorkspace();
            case 'save_workspace':
              // Native saves serialize the workspace through IPC.
              JSON.stringify(args.workspace);
              w.saved = args.workspace;
              w.saves.workspace++;
              return;
            case 'save_workspace_patch': {
              // A patch serializes only the conversations it carries, as the host's does.
              JSON.stringify(args.index);
              JSON.stringify(args.upsert);
              const kept = new Map((w.saved?.conversations ?? []).map((c: any) => [c.id, c]));
              const sent = new Map(args.upsert.map((c: any) => [c.id, c]));
              const conversations = args.order.map((id: string) => {
                const conversation = sent.get(id) ?? kept.get(id);
                if (!conversation)
                  throw new Error('The whole workspace is needed to save this change.');
                sent.delete(id);
                return conversation;
              });
              if (sent.size) throw new Error('The whole workspace is needed to save this change.');
              w.saved = { ...args.index, conversations };
              w.saves.workspace++;
              w.saves.patched = (w.saves.patched ?? 0) + 1;
              w.saves.sentChats = (w.saves.sentChats ?? 0) + args.upsert.length;
              return;
            }
            case 'load_sync_state':
              return sync;
            case 'save_sync_state':
              sync = args.value;
              w.saves.sync++;
              return;
            case 'relay_resume':
              return origin;
            case 'relay_request':
              return w.relayBridge(args.method, args.path, args.body);
            case 'desktop_notification_settings':
              return { enabled: true, sound: true };
            case 'plugin:window|is_maximized':
              return false;
            case 'plugin:event|listen':
              return 0;
            case 'live_account_updates':
            case 'background_work':
              return [];
            case 'discover_wsl':
              return { distributions: [], warning: null };
            case 'inspect_environment_clis':
              return ['codex', 'claude', 'gemini'].map((id) => ({
                id,
                path: `C:\\CLIs\\${id}.exe`,
              }));
            case 'detect_providers':
              return ['codex', 'claude', 'gemini'].map(status);
            case 'detect_connection':
            case 'detect_environment_login':
              return status(args.provider);
            case 'list_models': {
              const model = (id: string, name: string) => ({
                id,
                name,
                reasoningLevels: ['low', 'medium', 'high'],
                defaultReasoning: 'medium',
              });
              return {
                claude: [model('', 'CLI default'), model('opus', 'Opus')],
                codex: [model('', 'CLI default')],
                gemini: [model('', 'CLI default')],
              };
            }
            case 'read_usage':
              return {
                provider: args.provider,
                checkedAt: Date.now() / 1000,
                windows: [],
                context: null,
                detail: 'Fixture',
              };
            case 'run_agent': {
              // A reply that connects and then waits, as one running a long tool call does,
              // until a test streams answer text and reasoning through it.
              const channel = args.onEvent.id;
              let index = 0;
              const emit = (message: unknown) =>
                callbacks.get(channel)?.({ message, index: index++ });
              emit({ kind: 'activity', text: 'Working' });
              w.streamReply = async (events: number, everyMs: number) => {
                for (let step = 0; step < events; step++) {
                  emit(
                    step % 3 === 0
                      ? { kind: 'reasoning', text: `Considering step ${step}. ` }
                      : { kind: 'text', text: `part ${step} ` },
                  );
                  await new Promise((resolve) => setTimeout(resolve, everyMs));
                }
              };
              return new Promise(() => {});
            }
            case 'cancel_run':
              return;
            case 'generate_title':
              throw new Error('Synthetic title unavailable');
          }
        },
      };
    },
    { installation, origin },
  );
  return {
    requests,
    async close() {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Waits for the first sync's checkpoint, then until relay polls only ask for the revision, or
// for four more polls so that code that never settles fails the explicit checks below.
async function settle(page: Page, requests: string[]) {
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).saves.sync), { timeout: 20_000 })
    .toBeGreaterThan(0);
  const polls = () => requests.filter((r) => r === 'POST v1/heartbeat').length;
  const synced = polls();
  await expect
    .poll(() => requests.includes('GET v1/state/revision') || polls() >= synced + 4, {
      timeout: 20_000,
    })
    .toBe(true);
}

// Durations of the long tasks that start while `action` runs, longest first.
async function longTasks(page: Page, action: () => Promise<void>) {
  const from = await page.evaluate(() => performance.now());
  await action();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 200))),
  );
  return page.evaluate(
    (from) =>
      ((window as any).longTasks as { start: number; duration: number }[])
        .filter((task) => task.start >= from)
        .map((task) => Math.round(task.duration))
        .sort((a, b) => b - a),
    from,
  );
}

test('an idle relay connection neither saves nor syncs the whole workspace', async ({ page }) => {
  test.setTimeout(60_000);
  const host = await desktop(page);
  try {
    await settle(page, host.requests);
    const saves = await page.evaluate(() => (window as any).saves);
    host.requests.length = 0;
    await page.waitForTimeout(8_000);
    const count = (request: string) => host.requests.filter((r) => r === request).length;
    expect(count('POST v1/heartbeat')).toBeGreaterThanOrEqual(2);
    expect(
      host.requests.filter((r) => r.endsWith(' v1/state')),
      'Idle polls fetched or sent the whole workspace. See docs/PERFORMANCE.md.',
    ).toEqual([]);
    expect(count('GET v1/state/revision')).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(() => (window as any).saves),
      'Idle polls saved the workspace or its sync checkpoint. See docs/PERFORMANCE.md.',
    ).toEqual(saves);
  } finally {
    await host.close();
  }
});

test('a reply waiting on a tool call neither downloads nor rewrites the whole workspace', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const host = await desktop(page);
  try {
    await settle(page, host.requests);
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item', { hasText: 'Long performance chat' }).click();
    await page.getByLabel('Message', { exact: true }).fill('Run the slow suite');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    // The reply's first progress goes out, then it waits without changing anything here.
    await expect
      .poll(() => host.requests.filter((r) => r === 'PUT v1/state').length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    // Let the send's own changes, including its failed title, finish going out.
    for (let attempt = 0; attempt < 8; attempt++) {
      host.requests.length = 0;
      await page.waitForTimeout(3_000);
      if (!host.requests.some((r) => r.endsWith(' v1/state'))) break;
    }
    const saves = await page.evaluate(() => (window as any).saves);
    host.requests.length = 0;
    await page.waitForTimeout(8_000);
    const count = (request: string) => host.requests.filter((r) => r === request).length;
    expect(count('POST v1/heartbeat')).toBeGreaterThanOrEqual(2);
    expect(count('GET v1/state/revision')).toBeGreaterThanOrEqual(2);
    expect(
      host.requests.filter((r) => r.endsWith(' v1/state')),
      'A waiting reply fetched or sent the whole workspace. See docs/PERFORMANCE.md.',
    ).toEqual([]);
    expect(
      await page.evaluate(() => (window as any).saves),
      'A waiting reply saved the workspace or its sync checkpoint. See docs/PERFORMANCE.md.',
    ).toEqual(saves);
  } finally {
    await host.close();
  }
});

test('a streaming reply saves the whole workspace far less often than it reports', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const timed = !process.env.CI;
  const host = await desktop(page);
  try {
    await settle(page, host.requests);
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item', { hasText: 'Long performance chat' }).click();
    await page.getByLabel('Message', { exact: true }).fill('Explain it while you work');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).streamReply === 'function'), {
        timeout: 20_000,
      })
      .toBe(true);
    await page.waitForTimeout(2_000);
    const before = await page.evaluate(() => (window as any).saves.workspace);
    // 120 reported events over about six seconds, 40 of them reasoning.
    const tasks = await longTasks(page, async () => {
      await page.evaluate(() => (window as any).streamReply(120, 50));
      await page.waitForTimeout(500);
    });
    const after = await page.evaluate(() => (window as any).saves);
    const saves = after.workspace - before;
    test.info().annotations.push({
      type: 'streaming',
      description: JSON.stringify({ saves, after, longTasks: tasks.slice(0, 5) }),
    });
    // Reported progress must not drive one save each.
    expect(saves, 'Saves while streaming 120 events').toBeLessThan(12);
    expect(saves, 'A streaming reply still saves its progress').toBeGreaterThan(0);
    // Each of those saves carries the streaming conversation alone, not all 24 of them.
    expect(after.patched, 'Saves sent as a patch').toBe(saves);
    expect(after.sentChats, 'Conversations sent across those saves').toBe(saves);
    if (timed)
      expect(
        tasks[0] ?? 0,
        'Longest task while a reply streams; see docs/PERFORMANCE.md to profile it',
      ).toBeLessThan(budgets.streaming);
  } finally {
    await host.close();
  }
});

test('a large workspace stays responsive while idle, in Connections and when selecting', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Hosted runners share CPUs unpredictably, so only local verification enforces the budgets.
  const timed = !process.env.CI;
  const host = await desktop(page);
  try {
    await settle(page, host.requests);
    // Streaming has its own scenario above; this one measures the three interactions.
    const measured: Record<'idle' | 'connections' | 'selection', number[]> = {
      idle: await longTasks(page, () => page.waitForTimeout(8_000)),
      connections: await longTasks(page, async () => {
        await page.getByRole('button', { name: 'Connections', exact: true }).click();
        await expect(page.locator('.fleet-account')).toHaveCount(12);
        await page.waitForTimeout(1_500);
      }),
      selection: [],
    };
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('tab', { name: /^History/ }).click();
    await page.locator('.conversation-item', { hasText: 'Long performance chat' }).click();
    await expect(page.getByTestId('message')).toHaveCount(34);
    // Collapsed Work history and diffs render on first expansion, so selections never restyle
    // them. Rendering them up front put about 8,500 elements here.
    const collapsed = await page.evaluate(
      () =>
        document.querySelectorAll(
          'details:not([open]) > :not(summary), details:not([open]) > :not(summary) *',
        ).length,
    );
    expect(collapsed, 'Elements inside collapsed disclosures').toBeLessThan(500);
    // Drag a selection across the visible replies, changing it on every move, then select all.
    const chat = (await page.locator('.chat-scroll').boundingBox())!;
    measured.selection = await longTasks(page, async () => {
      await page.mouse.move(chat.x + 40, chat.y + 40);
      await page.mouse.down();
      for (let step = 0; step < 10; step++)
        await page.mouse.move(chat.x + 200, chat.y + chat.height * (step % 2 ? 0.5 : 0.95));
      await page.mouse.up();
      await page.keyboard.press('Control+A');
    });
    const selected = await page.evaluate(() => getSelection()!.toString().length);
    expect(selected, 'Characters selected').toBeGreaterThan(5_000);
    test.info().annotations.push({
      type: 'long tasks (ms)',
      description: JSON.stringify({ ...measured, collapsed, selected }),
    });
    if (timed)
      for (const [phase, tasks] of Object.entries(measured))
        expect(
          tasks[0] ?? 0,
          `Longest ${phase} task; see docs/PERFORMANCE.md to profile it`,
        ).toBeLessThan(budgets[phase as keyof typeof budgets]);
  } finally {
    await host.close();
  }
});
