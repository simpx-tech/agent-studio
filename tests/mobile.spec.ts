import { signInPwa } from './pwa-helper';
import { test, expect, type Page } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function expectSynced(page: Page) {
  await page.waitForResponse(
    (response) => response.url().endsWith('/v1/heartbeat') && response.status() === 200,
  );
  await expect(page.locator('.browser-status [role="status"]')).toHaveCount(0);
  await expect(page.getByText('Connected to your server', { exact: true })).toHaveCount(0);
}

test('pairing survives a relay restart and worker update, and startup retries an unavailable server', async ({
  page,
  context,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-mobile-update-'));
  const webDirectory = join(directory, 'public');
  cpSync(resolve('build'), webDirectory, { recursive: true });
  const token = 'synthetic-mobile-update-pairing-key';
  let server = createRelay({ token, directory, webDirectory });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  let unavailablePath = '';
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await signInPwa(page, token);
    await expectSynced(page);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const installation = await page.evaluate(() =>
      localStorage.getItem('agent-studio.installation'),
    );
    const cookie = (await context.cookies(url + '/v1/state')).find(
      (cookie) => cookie.name === 'agent_studio_session',
    );
    expect(cookie?.httpOnly).toBe(true);

    // An actual new service worker and a fresh relay instance on the same origin.
    const worker = join(webDirectory, 'service-worker.js');
    const source = readFileSync(worker, 'utf8');
    const updated = source.replace('agent-studio-shell-${', 'agent-studio-shell-updated-${');
    expect(updated).not.toBe(source);
    writeFileSync(worker, updated);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createRelay({ token, directory, webDirectory });
    const handleRequest = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (unavailablePath && req.url === `/v1/${unavailablePath}`) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{}');
      } else handleRequest.call(server, req, res);
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting))
      .toBe(true);
    await expect(page.getByText('Connected to your server', { exact: true })).toHaveCount(0);
    await page.goto('about:blank');
    await page.goto(url);
    await expectSynced(page);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).every((name) => name.startsWith('agent-studio-shell-updated-')),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('agent-studio.installation'))).toBe(
      installation,
    );
    expect(
      (await context.cookies(url + '/v1/state')).find((value) => value.name === cookie!.name)
        ?.value,
    ).toBe(cookie!.value);

    // No focus/reload action after recovery: the existing page must retry by itself.
    for (const path of ['browser-session', 'state']) {
      unavailablePath = path;
      await page.reload();
      await expect(
        page.getByRole('status').filter({ hasText: /Server unavailable/ }),
      ).toBeVisible();
      unavailablePath = '';
      await expectSynced(page);
    }
    await expect(page.getByRole('button', { name: 'Install app', exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect(page.locator('.browser-status')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('mobile-update-reconnected.png') });
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(token);
    expect(errors).toEqual([]);
    // Explicit disconnect still wins and stays disconnected after reloading.
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByText('Sync settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(
      (await context.cookies(url + '/v1/state')).some(
        (value) => value.name === 'agent_studio_session',
      ),
    ).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('phone pairs to the hosted PWA, controls a remote host, resumes and stays safe offline', async ({
  page,
  context,
  browserName,
}, testInfo) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-mobile-'));
  const token = 'synthetic-mobile-pairing-key-'.repeat(2);
  let timeOffset = 0;
  const server = createRelay({
    token,
    directory,
    webDirectory: resolve('build'),
    now: () => Date.now() + timeOffset,
  });
  let jobRequests = 0;
  let expireBeforeNextJob = false;
  server.on('request', (request) => {
    if (request.method === 'POST' && request.url === '/v1/jobs') {
      ++jobRequests;
      if (expireBeforeNextJob) {
        timeOffset += 16_000;
        expireBeforeNextJob = false;
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID(),
    wsl = crypto.randomUUID(),
    wslConnection = crypto.randomUUID();
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
  shared.fleet.environments.push({
    id: wsl,
    computerId: computer,
    name: 'WSL · Ubuntu QA',
    platform: 'wsl',
    distribution: 'Ubuntu',
    discoveredOn: host,
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
  shared.fleet.connections.push({
    id: wslConnection,
    accountId: account,
    environmentId: wsl,
    profile: 'existing',
  });
  await call('PUT', 'state', { revision: 0, workspace: shared });
  const running = new Set<string>();
  const jobs: any[] = [];
  let busy = false;
  let hold = false;
  let hostOpen = true;
  let modelFailure = false;
  let workerError = '';
  async function work() {
    if (busy || !hostOpen) return;
    busy = true;
    try {
      await call('POST', 'heartbeat', {
        environmentId: host,
        connections: [connection, wslConnection].map((connectionId) => ({
          connectionId,
          installed: true,
          auth: 'ready',
          detail: 'Synthetic executor',
          version: 'test',
        })),
        running: [...running],
      });
      for (const job of await call('GET', 'jobs')) {
        jobs.push(job);
        if (job.method === 'run') {
          running.add(job.id);
          continue;
        }
        if (job.method === 'models' && modelFailure) {
          await call('PUT', `jobs/${job.id}`, {
            status: 'error',
            events: [],
            error: 'Synthetic model query failure',
          });
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
    await expect(page.getByRole('button', { name: 'Open conversations' })).toHaveCount(0);
    await page
      .getByLabel('Workspace key', { exact: true })
      .fill('wrong-key-with-enough-characters-to-submit');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('rejected');
    await page.getByLabel('Workspace key', { exact: true }).fill(token);
    const pairingResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/browser-session') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect(await (await pairingResponse).headerValue('set-cookie')).toContain(
      'HttpOnly; SameSite=Strict',
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectSynced(page);
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
    // WinCairo reports None even for Strict cookies; the wire assertion above
    // remains mandatory. Chromium and other WebKit platforms check storage too.
    // https://github.com/microsoft/playwright/blob/main/tests/library/browsercontext-cookies.spec.ts
    if (browserName !== 'webkit' || process.platform !== 'win32')
      expect(cookie?.sameSite).toBe('Strict');
    hold = true;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep working');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Working from your phone…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop response' }).click();
    await expect.poll(() => running.size).toBe(0);

    // A real provider error is actionable, but a host going offline is normal state.
    const savedModel = await page.getByRole('combobox', { name: 'Model', exact: true }).innerText();
    const savedAgent = await page.getByRole('combobox', { name: 'Agent', exact: true }).innerText();
    modelFailure = true;
    // Reopening after reload starts a fresh automatic catalog query.
    await page.reload();
    await expectSynced(page);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Phone control QA', exact: true }).click();
    await page.getByRole('button', { name: 'Conversation actions' }).click();
    await expect(page.getByRole('button', { name: 'Refresh model list', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Copy conversation', exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('status').filter({ hasText: 'Could not refresh models' }),
    ).toBeVisible();
    modelFailure = false;
    hostOpen = false;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
    await page.getByRole('button', { name: 'Open conversations' }).click();
    // A computer-scoped draft clears the folder and resets automatic query readiness.
    await page.getByRole('button', { name: 'New conversation on Desktop QA', exact: true }).click();
    // Expire the real heartbeat when the next query reaches the server, before the
    // PWA can poll it. This also covers the online-to-offline request race (409).
    expireBeforeNextJob = true;
    const offlineResponse = page.waitForResponse(
      (response) => response.url().endsWith('/v1/jobs') && response.status() === 409,
    );
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Phone control QA', exact: true }).click();
    expect((await (await offlineResponse).json()).code).toBe('host_offline');
    await expect(page.locator('.computer-setting')).toContainText('Offline');
    await expect(page.locator('.setup-hint')).toContainText('Desktop QA is offline');
    await expect(page.getByText(/Could not refresh models/)).toHaveCount(0);
    const offlineJobRequests = jobRequests;
    await page.reload();
    await expectSynced(page);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await expect(
      page.locator('.computer-group-toggle').filter({ hasText: 'Desktop QA' }),
    ).toContainText('Offline');
    await page.getByRole('button', { name: 'Phone control QA', exact: true }).click();
    await expect(page.locator('.computer-setting')).toContainText('Offline');
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(savedModel);
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText(savedAgent);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Offline draft');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('mobile-host-offline.png') });
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(page.locator('.computer-state')).toHaveText(['Offline', 'Offline']);
    await expect(page.locator('.computer-state.ready')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
    await expect(page.getByRole('option', { name: 'Desktop QA', exact: true })).toContainText(
      'Offline',
    );
    await expect(page.getByRole('option', { name: 'WSL · Ubuntu QA', exact: true })).toContainText(
      'Offline · On Desktop QA',
    );
    await page.getByRole('option', { name: 'WSL · Ubuntu QA', exact: true }).click();
    await expect(page.locator('.setup-hint')).toContainText(
      'WSL · Ubuntu QA is offline. Open Agent Studio on Desktop QA',
    );
    await expectSynced(page);
    await expect(page.getByText(/Could not refresh models/)).toHaveCount(0);
    expect(jobRequests).toBe(offlineJobRequests);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Phone control QA', exact: true }).click();
    const beforeReconnect = jobs.length;
    hostOpen = true;
    await work();
    await expect(page.locator('.computer-setting')).not.toContainText('Offline');
    await expect
      .poll(() =>
        jobs
          .slice(beforeReconnect)
          .some(
            (job) =>
              job.method === 'models' &&
              job.target === host &&
              job.args.connectionId === connection,
          ),
      )
      .toBe(true);
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(savedModel);
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText(savedAgent);
    await expect(page.getByText(/Could not refresh models/)).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
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
    clearInterval(timer);
    while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
    const before = jobs.length;
    // Stop the real server so no API or shell request can reach the network.
    // WinCairo's offline emulation fails navigation before consulting the worker.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (browserName !== 'webkit' || process.platform !== 'win32') await context.setOffline(true);
    await page.reload();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /(?:You’re offline|Server unavailable)/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
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
