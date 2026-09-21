import { test, expect, type Page } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

async function start(page: Page, mode: 'form' | 'url' = 'form') {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(() => {
    const w = window as any,
      original = w.__TAURI_INTERNALS__.invoke;
    w.elicitationAnswers = [];
    w.openedPages = [];
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'plugin:opener|open_url') {
        w.openedPages.push(args.url);
        return;
      }
      if (command === 'manage_elicitation') {
        if (w.failElicitation) throw new Error('Computer offline. Try again.');
        if (!args.input.action) return w.elicitationRequest;
        w.elicitationAnswers.push(args);
        w.emitCapability({
          kind: 'elicitation',
          elicitation: {
            ...w.elicitationReceipt,
            revision: 2,
            status:
              args.input.action === 'accept'
                ? 'accepted'
                : args.input.action === 'decline'
                  ? 'declined'
                  : 'cancelled',
          },
        });
        return null;
      }
      return original(command, args);
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Run an MCP tool');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate((mode) => {
    const w = window as any,
      run = JSON.parse(localStorage.getItem('test-last-request')!);
    w.elicitationReceipt = {
      id: crypto.randomUUID(),
      runId: run.runId,
      revision: 1,
      status: 'pending',
      mode,
      serverName: 'Booking server',
    };
    const field = (key: string, kind: string, extra = {}) => ({
      key,
      title: key,
      description: '',
      kind,
      required: true,
      options: [],
      minLength: null,
      maxLength: null,
      minimum: null,
      maximum: null,
      minItems: null,
      maxItems: null,
      format: null,
      pattern: null,
      default: null,
      ...extra,
    });
    w.elicitationRequest = {
      ...w.elicitationReceipt,
      message: 'Confirm your booking details.',
      url: mode === 'url' ? 'https://example.com/booking?nonce=private-fixture' : null,
      fields:
        mode === 'url'
          ? []
          : [
              field('Name', 'string', { minLength: 2 }),
              field('Guests', 'integer', { minimum: 1, maximum: 6, default: 2 }),
              field('Window seat', 'boolean'),
              field('Meal', 'string', {
                options: [
                  { value: 'veg', label: 'Vegetarian' },
                  { value: 'standard', label: 'Standard' },
                ],
              }),
              field('Extras', 'array', {
                required: false,
                options: [
                  { value: 'tea', label: 'Tea' },
                  { value: 'water', label: 'Water' },
                ],
              }),
            ],
    };
    w.emitCapability({ kind: 'elicitation', elicitation: w.elicitationReceipt });
  }, mode);
  await expect(page.getByRole('region', { name: 'MCP request' })).toBeVisible();
  return page.getByRole('region', { name: 'MCP request' });
}
test('MCP form preserves draft, validates typed answers, and stores only the receipt', async ({
  page,
}) => {
  const form = await start(page);
  await expect(page.getByText('Waiting for you', { exact: true })).toBeVisible();
  await expect(form.getByLabel('Guests', { exact: true })).toHaveValue('2');
  expect(await page.evaluate(() => (window as any).elicitationAnswers)).toEqual([]);
  await page.getByLabel('Message', { exact: true }).fill('Preserve this draft');
  await form.getByLabel('Name', { exact: true }).fill('Ada');
  await form.getByRole('combobox', { name: 'Window seat', exact: true }).click();
  await page.getByRole('option', { name: 'No', exact: true }).click();
  await form.getByRole('combobox', { name: 'Meal', exact: true }).click();
  await page.getByRole('option', { name: 'Vegetarian', exact: true }).click();
  await form.getByRole('checkbox', { name: 'Tea', exact: true }).check();
  await page.evaluate(() => ((window as any).failElicitation = true));
  await form.getByRole('button', { name: 'Send answers', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Computer offline');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Ada');
  await page.setViewportSize({ width: 1380, height: 1150 });
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/elicitation-form.png', fullPage: true });
  await page.evaluate(() => ((window as any).failElicitation = false));
  await form.getByRole('button', { name: 'Send answers', exact: true }).click();
  await expect(form).toHaveCount(0);
  const answers = await page.evaluate(() => (window as any).elicitationAnswers);
  expect(answers[0].input.content).toEqual({
    Name: 'Ada',
    Guests: 2,
    'Window seat': false,
    Meal: 'veg',
    Extras: ['tea'],
  });
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Preserve this draft');
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'Booking continued.' });
    w.finishCapabilities('complete');
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-workspace')!).conversations.at(-1).messages.at(-1)
            .elicitations[0].status,
      ),
    )
    .toBe('accepted');
  expect(await page.evaluate(() => localStorage.getItem('test-workspace'))).not.toMatch(
    /Confirm your booking|private-fixture|Vegetarian|"Ada"/,
  );
});
test('MCP URL opens only on click and requires a separate response on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const form = await start(page, 'url');
  await expect(form.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).openedPages)).toEqual([]);
  await form.getByRole('button', { name: 'Open page', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).openedPages.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).elicitationAnswers)).toEqual([]);
  await form.getByRole('button', { name: 'Continue', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/elicitation-url-mobile.png', fullPage: true });
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).elicitationAnswers))[0].input).toMatchObject({
    action: 'accept',
  });
});
for (const action of ['Decline', 'Cancel'])
  test(`MCP ${action.toLowerCase()} sends no form content`, async ({ page }) => {
    const form = await start(page);
    await form.getByRole('button', { name: action, exact: true }).click();
    await expect(form).toHaveCount(0);
    const answers = await page.evaluate(() => (window as any).elicitationAnswers);
    expect(answers[0].input.action).toBe(action.toLowerCase());
    expect(answers[0].input.content).toBeUndefined();
  });
test('provider cancellation removes pending MCP inputs and a stopped reply cannot restore them', async ({
  page,
}) => {
  const form = await start(page);
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({
      kind: 'elicitation',
      elicitation: { ...w.elicitationReceipt, revision: 2, status: 'cancelled' },
    });
    w.finishCapabilities('cancelled');
  });
  await expect(form).toHaveCount(0);
  await page.reload();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).elicitationAnswers)).toEqual([]);
});

test('paired Viewer fetches private MCP input from its owning host without persisting it', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-elicitation-pwa-'));
  const token = 'synthetic-elicitation-relay-fixture-token';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID(),
    runId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    conversationId = crypto.randomUUID(),
    now = new Date().toISOString();
  const receipt = {
    id,
    runId,
    revision: 1,
    status: 'pending' as const,
    mode: 'url' as const,
    serverName: 'Remote MCP',
  };
  const request = {
    ...receipt,
    message: 'Private remote request',
    fields: [],
    url: 'https://example.com/verify?nonce=transient-only',
  };
  const workspace = initialWorkspace();
  workspace.fleet = {
    computers: [{ id: computer, name: 'MCP host' }],
    environments: [{ id: host, computerId: computer, name: 'Windows', platform: 'windows' }],
    accounts: [{ id: account, name: 'MCP account', provider: 'codex', purpose: 'personal' }],
    connections: [{ id: connection, environmentId: host, accountId: account, profile: 'existing' }],
  };
  workspace.conversations.push({
    id: conversationId,
    title: 'Remote elicitation',
    createdAt: now,
    updatedAt: now,
    location: { computerId: computer, environmentId: host, path: 'C:\\MCP fixture' },
    settings: {
      provider: 'codex',
      model: '',
      reasoning: '',
      instructions: '',
      connectionId: connection,
    },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'running',
        createdAt: now,
        runId,
        blocks: [],
        elicitations: [receipt],
      },
    ],
  });
  const received: any[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-environment-id': host,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  let busy = false,
    workerError: unknown;
  const worker = async () => {
    if (busy) return;
    busy = true;
    try {
      await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [runId] });
      for (const job of await call('GET', 'jobs')) {
        received.push(job);
        if (job.method === 'elicitation' && job.args.input.action) {
          const state = await call('GET', 'state'),
            chat = state.workspace.conversations.find((c: any) => c.id === conversationId);
          chat.messages[0].elicitations = [{ ...receipt, status: 'declined', revision: 2 }];
          chat.messages[0].status = 'complete';
          chat.messages[0].blocks = [{ type: 'markdown', text: 'MCP response reached the host.' }];
          chat.updatedAt = new Date().toISOString();
          await call('PUT', 'state', { revision: state.revision, workspace: state.workspace });
        }
        await call('PUT', `jobs/${job.id}`, {
          status: 'complete',
          events: [],
          result:
            job.method === 'elicitation' && !job.args.input.action
              ? request
              : job.method === 'models'
                ? { codex: [] }
                : null,
        });
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void worker().catch((e) => (workerError = e));
  }, 200);
  try {
    await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [runId] });
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('button', { name: /Remote elicitation/ }).click();
    const form = page.getByRole('region', { name: 'MCP request' });
    await expect(form.getByText('Private remote request', { exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Keep remote draft');
    // A relay checkpoint replaces receipt objects without changing the request.
    // It must not fetch private input again or reset the visible form.
    const checkpoint = await call('GET', 'state');
    const remoteChat = checkpoint.workspace.conversations.find((c: any) => c.id === conversationId);
    remoteChat.title = 'Remote elicitation refreshed';
    remoteChat.updatedAt = new Date().toISOString();
    await call('PUT', 'state', {
      revision: checkpoint.revision,
      workspace: checkpoint.workspace,
    });
    await expect(page.getByRole('button', { name: /Remote elicitation refreshed/ })).toBeVisible();
    await expect(form.getByText('Private remote request', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(page.getByText('MCP response reached the host.', { exact: true })).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep remote draft');
    const calls = received.filter((j) => j.method === 'elicitation');
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (j) => j.target === host && j.args.connectionId === connection && j.args.runId === runId,
      ),
    ).toBe(true);
    expect(calls[1].args.input).toEqual({ requestId: id, action: 'decline' });
    expect(received.some((j) => j.method === 'run')).toBe(false);
    expect(readFileSync(join(directory, 'workspace.json'), 'utf8')).not.toMatch(
      /transient-only|Private remote request/,
    );
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(
      /transient-only|Private remote request/,
    );
    await page.reload();
    await page.getByRole('button', { name: /Remote elicitation/ }).click();
    await expect(form).toHaveCount(0);
    expect(workerError).toBeUndefined();
  } finally {
    clearInterval(timer);
    while (busy) await new Promise((done) => setTimeout(done, 10));
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
