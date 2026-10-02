import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { emptyShared } from '../src/lib/sync';
import { signInPwa } from './pwa-helper';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// The Viewer reads a screen from the computer that keeps it and runs its actions there, through
// the relay's `screens` jobs: the phone never holds a screen beyond the window showing it.
test('the Viewer opens a computer’s screen and runs its actions through the relay', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const directory = mkdtempSync(join(tmpdir(), 'studio-screens-'));
  const token = 'synthetic-screens-pairing-key-'.repeat(2);
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID();
  const call = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': host,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status !== status)
      throw new Error(`Fixture relay ${path}: ${response.status} ${await response.text()}`);
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
  const screenId = crypto.randomUUID();
  const summary = {
    id: screenId,
    revision: 3,
    title: 'Team dashboard',
    description: 'Builds of the main branch',
    environmentId: host,
    project: 'C:\\Projects\\studio',
    folder: 'C:\\Projects\\studio',
    conversationId: crypto.randomUUID(),
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:30:00.000Z',
    commands: 1,
    allowed: true,
  };
  const detail = {
    ...summary,
    html: `<h2>Builds</h2><p id="status">Checking…</p><script>
      studio.json('status').then(
        (value) => (document.getElementById('status').textContent = value.passing + ' builds passing'),
        (error) => (document.getElementById('status').textContent = error.message));
    </script>`,
    actions: [
      {
        name: 'status',
        description: 'Reads the builds',
        shell: 'powershell',
        script: 'gh run list --json conclusion',
        timeout: 60,
      },
    ],
    digest: 'b'.repeat(64),
  };
  // The computer that keeps the screen answers its jobs, as its window would.
  const screenJobs: unknown[] = [];
  let busy = false;
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
            detail: 'Synthetic',
            version: 'test',
          },
        ],
        running: [],
      });
      for (const job of await call('GET', 'jobs')) {
        if (job.method !== 'screens') {
          await call('PUT', `jobs/${job.id}`, {
            status: 'error',
            events: [],
            error: 'Not part of this fixture',
          });
          continue;
        }
        screenJobs.push(job.args);
        const request = job.args.request;
        const result =
          request.op === 'list'
            ? { screens: [summary] }
            : request.op === 'read'
              ? detail
              : request.op === 'run'
                ? {
                    exitCode: 0,
                    stdout: JSON.stringify({ passing: 3 }),
                    stderr: '',
                    truncated: false,
                    timedOut: false,
                    durationMs: 40,
                  }
                : {};
        await call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result });
      }
    } catch (error) {
      workerError = String(error);
    } finally {
      busy = false;
    }
  }
  await work();
  const timer = setInterval(() => void work(), 150);
  try {
    // The relay routes only well-formed screen requests, and only to a computer of this workspace.
    for (const request of [
      { op: 'run', id: screenId, action: 'Remove-Item', params: {} },
      { op: 'read', id: '../workspace' },
      { op: 'list', path: 'C:\\' },
      { op: 'run', id: screenId, action: 'status', params: {}, script: 'whoami' },
    ])
      await call(
        'POST',
        'jobs',
        {
          id: crypto.randomUUID(),
          source: host,
          target: host,
          method: 'screens',
          args: { environmentId: host, request },
        },
        400,
      );
    await page.goto(url);
    await signInPwa(page, token);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('tab', { name: /^Screens/ }).click();
    const row = page.getByRole('button', { name: 'Team dashboard', exact: true });
    await expect(row).toBeVisible();
    await expect(
      page.locator('.computer-group-toggle').filter({ hasText: 'Desktop QA' }),
    ).toBeVisible();
    await row.click();
    await expect(page.getByRole('heading', { name: 'Team dashboard' })).toBeVisible();
    const frame = page.frameLocator('iframe[title="Team dashboard screen"]');
    await expect(frame.locator('#status')).toHaveText('3 builds passing');
    await page.screenshot({ path: testInfo.outputPath('viewer-screen.png') });
    await page.screenshot({ path: 'artifacts/screens-viewer.png' });
    expect(screenJobs).toEqual(
      expect.arrayContaining([
        { environmentId: host, request: { op: 'list' } },
        { environmentId: host, request: { op: 'read', id: screenId } },
        { environmentId: host, request: { op: 'run', id: screenId, action: 'status', params: {} } },
      ]),
    );
    expect(workerError).toBe('');
  } finally {
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
