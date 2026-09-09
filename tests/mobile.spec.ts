import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone pairs to the hosted PWA, controls a remote host, resumes and stays safe offline', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-mobile-'));
  const token = 'synthetic-mobile-pairing-key-'.repeat(2);
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID();
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': host,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Fixture relay ${path}: ${response.status}`);
    return response.json();
  };
  const shared = emptyShared();
  shared.fleet.computers.push({ id: computer, name: 'Desktop QA' });
  shared.fleet.environments.push({
    id: host,
    computerId: computer,
    name: 'Windows',
    platform: 'windows',
  });
  shared.fleet.accounts.push({
    id: account,
    name: 'Codex QA',
    provider: 'codex',
    purpose: 'personal',
  });
  shared.fleet.connections.push({
    id: connection,
    accountId: account,
    environmentId: host,
    profile: 'existing',
  });
  await call('PUT', 'state', { revision: 0, workspace: shared });
  const running = new Set<string>();
  const jobs: any[] = [];
  let busy = false;
  let hold = false;
  let workerError = '';
  async function work() {
    if (busy) return;
    busy = true;
    try {
      await call('POST', 'heartbeat', {
        environmentId: host,
        connections: [
          {
            connectionId: connection,
            installed: true,
            auth: 'ready',
            detail: 'Synthetic executor',
            version: 'test',
          },
        ],
        running: [...running],
      });
      for (const job of await call('GET', 'jobs')) {
        jobs.push(job);
        if (job.method === 'run') {
          running.add(job.id);
          continue;
        }
        const result =
          job.method === 'folders'
            ? { path: 'C:\\Projects', parent: 'C:\\', entries: [], truncated: false }
            : job.method === 'models'
              ? {
                  codex: [
                    { id: '', name: 'CLI default', reasoningLevels: [], defaultReasoning: '' },
                  ],
                  claude: [],
                  gemini: [],
                }
              : job.method === 'title'
                ? { title: 'Phone control QA', provider: 'codex', model: 'fixture' }
                : {
                    provider: 'codex',
                    checkedAt: Date.now() / 1000,
                    windows: [],
                    context: null,
                    detail: 'Synthetic executor',
                  };
        await call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result });
      }
      for (const id of running) {
        const current = await call('GET', `jobs/${id}`);
        const status = current.cancel ? 'cancelled' : hold ? 'running' : 'complete';
        await call('PUT', `jobs/${id}`, {
          status,
          events: [
            {
              kind: 'text',
              text: hold ? 'Working from your phone…' : 'Reply from the selected computer.',
            },
          ],
          result: status === 'cancelled' ? 'cancelled' : 'complete',
        });
        if (status !== 'running') running.delete(id);
      }
    } catch (error) {
      workerError = String(error);
    } finally {
      busy = false;
    }
  }
  await work();
  const timer = setInterval(() => void work(), 150);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await expect(page.getByRole('button', { name: 'Open conversations' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up', exact: true }).click();
    await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
    await page.getByLabel('Relay pairing key').fill('wrong-key-with-enough-characters-to-submit');
    await page.getByRole('button', { name: 'Pair & sync' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('rejected');
    await page.getByLabel('Relay pairing key').fill(token);
    await page.getByRole('button', { name: 'Pair & sync' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Connected to your server', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mobile-connections.png') });
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
    await page.getByRole('option', { name: 'Desktop QA', exact: true }).click();
    await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
    await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use this folder' })).toBeEnabled();
    await page.getByRole('button', { name: 'Use this folder' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('Check the selected folder');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(
      page.getByText('Reply from the selected computer.', { exact: true }),
    ).toBeVisible();
    expect(jobs.find((job) => job.method === 'run')?.target).toBe(host);
    expect(jobs.find((job) => job.method === 'run')?.args.connectionId).toBe(connection);
    await page.screenshot({ path: testInfo.outputPath('mobile-chat.png') });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(token);
    expect(await page.evaluate(() => document.cookie)).not.toContain('agent_studio_session');
    const cookie = (await context.cookies(url + '/v1/state')).find(
      (cookie) => cookie.name === 'agent_studio_session',
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    hold = true;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep working');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Working from your phone…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect.poll(() => running.size).toBe(0);
    await page.reload();
    await expect(page.getByText('Connected to your server', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Phone control QA', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft');
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.screenshot({ path: testInfo.outputPath('mobile-drawer.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open conversations' })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
      'Keep this draft',
    );
    for (const width of [320, 390, 650, 768]) {
      await page.setViewportSize({ width, height: 740 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const send = await page.getByRole('button', { name: 'Send message' }).boundingBox();
      expect(send!.x + send!.width).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 390, height: 460 });
    await page.screenshot({ path: testInfo.outputPath('mobile-keyboard-height.png') });
    const before = jobs.length;
    await context.setOffline(true);
    await page.reload();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /(?:Offline|Server unavailable) · Reconnect to control agents/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(jobs.length).toBe(before);
    const cached = await page.evaluate(async () =>
      (
        await Promise.all(
          (await caches.keys()).map(async (name) =>
            (await (await caches.open(name)).keys()).map((request) => request.url),
          ),
        )
      ).flat(),
    );
    expect(cached.some((url) => url.includes('/v1/'))).toBe(false);
    expect(errors).toEqual([]);
    expect(workerError).toBe('');
  } finally {
    clearInterval(timer);
    await context.setOffline(false);
    while (busy) await new Promise((r) => setTimeout(r, 20));
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});
