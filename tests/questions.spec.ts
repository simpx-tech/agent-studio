import { test, expect } from '@playwright/test';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { seedAndPairPwa } from './pwa-helper';

test('desktop keeps an unanswered question and its draft across older relay syncs', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.addInitScript(() => {
    const w = window as any;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    let remote = {
      fleet: { computers: [], environments: [], accounts: [], connections: [] },
      conversations: [],
    };
    w.questionSyncs = 0;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'relay_resume') return 'https://old-relay.example.com';
      if (command === 'load_sync_state') return null;
      if (command === 'save_sync_state') return;
      if (command === 'relay_request') {
        if (args.path === 'v1/state') {
          if (args.method === 'PUT') {
            remote = structuredClone(args.body.workspace);
            for (const chat of remote.conversations as any[])
              for (const message of chat.messages) {
                if (message.questions?.length) w.questionSyncs++;
                delete message.questions;
              }
          }
          return { status: 200, body: { instanceId: 'old-relay', revision: 0, workspace: remote } };
        }
        return { status: 200, body: [] };
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Ask a question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    w.testQuestion = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'color',
          header: 'Color',
          question: 'Choose a color',
          multiSelect: false,
          options: [{ label: 'Blue', description: 'Blue color' }],
        },
        {
          id: 'notes',
          header: 'Notes',
          question: 'Any color notes?',
          multiSelect: false,
          options: [],
        },
      ],
    };
    w.emitCapability({ kind: 'question', question: w.testQuestion });
  });
  const form = page.getByRole('region', { name: 'Agent questions' });
  await form.getByRole('radio', { name: 'Blue' }).check();
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  await form.getByLabel('Your answer: Any color notes?').fill('Keep this answer too');
  await page.getByLabel('Message', { exact: true }).fill('Keep my message draft');
  await expect.poll(() => page.evaluate(() => (window as any).questionSyncs)).toBeGreaterThan(0);
  await expect(form.getByText('Question 2 of 2')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).questionSyncs), { timeout: 15000 })
    .toBeGreaterThan(2);
  await expect(form.getByLabel('Your answer: Any color notes?')).toHaveValue(
    'Keep this answer too',
  );
  await form.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(form.getByRole('radio', { name: 'Blue' })).toBeChecked();
  await form.getByRole('button', { name: 'Next', exact: true }).click();
  expect(await page.evaluate(() => (window as any).answersSent ?? [])).toEqual([]);
  await expect(page.getByText('Waiting for you', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Send answers' }).click();
  await expect(form).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as any;
    w.emitCapability({ kind: 'text', text: 'Blue was explicitly selected.' });
    w.finishCapabilities('complete');
  });
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my message draft');
  const count = await page.evaluate(() => (window as any).questionSyncs);
  await expect
    .poll(() => page.evaluate(() => (window as any).questionSyncs))
    .toBeGreaterThan(count);
  await expect(form).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
        return workspace.conversations.at(-1).messages.at(-1).questions[0].status;
      }),
    )
    .toBe('answered');
  expect(await page.evaluate(() => (window as any).answersSent)).toHaveLength(1);
  await page.screenshot({ path: 'artifacts/questions-relay-retention.png', fullPage: true });
});

test('paired Viewer answers a desktop-started question through the owning host and restores its result', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-question-pwa-'));
  const token = 'synthetic-question-relay-fixture-token';
  const server = createRelay({ token, directory, webDirectory: resolve('build') });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const host = crypto.randomUUID(),
    computer = crypto.randomUUID(),
    account = crypto.randomUUID(),
    connection = crypto.randomUUID();
  const runId = crypto.randomUUID(),
    requestId = crypto.randomUUID(),
    conversationId = crypto.randomUUID(),
    now = new Date().toISOString();
  const workspace = initialWorkspace();
  workspace.fleet = {
    computers: [{ id: computer, name: 'Question host' }],
    environments: [{ id: host, computerId: computer, name: 'Windows', platform: 'windows' }],
    accounts: [{ id: account, name: 'Question account', provider: 'codex', purpose: 'personal' }],
    connections: [{ id: connection, environmentId: host, accountId: account, profile: 'existing' }],
  };
  workspace.conversations.push({
    id: conversationId,
    title: 'Remote question',
    createdAt: now,
    updatedAt: now,
    location: { computerId: computer, environmentId: host, path: 'C:\\Question fixture' },
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
        questions: [
          {
            id: requestId,
            revision: 1,
            status: 'pending',
            questions: [
              {
                id: 'color',
                header: 'Color',
                question: 'Which color?',
                multiSelect: false,
                options: [
                  { label: 'Blue', description: 'Cool color' },
                  { label: 'Red', description: 'Warm color' },
                ],
              },
            ],
          },
        ],
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
  let busy = false;
  const worker = async () => {
    if (busy) return;
    busy = true;
    try {
      await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [runId] });
      for (const job of await call('GET', 'jobs')) {
        received.push(job);
        if (job.method === 'answer') {
          const state = await call('GET', 'state');
          const chat = state.workspace.conversations.find((c: any) => c.id === conversationId);
          chat.messages[0].questions[0] = {
            ...chat.messages[0].questions[0],
            revision: 2,
            status: 'answered',
            response: job.args.answer,
          };
          chat.messages[0].status = 'complete';
          chat.messages[0].blocks = [{ type: 'markdown', text: 'Your answer reached the host.' }];
          chat.updatedAt = new Date().toISOString();
          await call('PUT', 'state', { revision: state.revision, workspace: state.workspace });
        }
        await call('PUT', `jobs/${job.id}`, {
          status: 'complete',
          events: [],
          result: job.method === 'models' ? { codex: [] } : null,
        });
      }
    } finally {
      busy = false;
    }
  };
  let workerError: unknown;
  const timer = setInterval(() => {
    void worker().catch((e) => (workerError = e));
  }, 200);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await call('POST', 'heartbeat', { environmentId: host, connections: [], running: [runId] });
    await seedAndPairPwa(page, url, token, workspace);
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: /Remote question/ }).click();
    await page.getByRole('radio', { name: 'Blue' }).check();
    await page.getByRole('button', { name: 'Send answers' }).click();
    await expect(page.getByText('Your answer reached the host.', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Agent questions' })).toHaveCount(0);
    const response = received.find((job) => job.method === 'answer');
    expect(response.target).toBe(host);
    expect(response.args).toEqual({
      runId,
      connectionId: connection,
      answer: { requestId, skipped: false, answers: [{ id: 'color', values: ['Blue'] }] },
    });
    expect(received.filter((job) => job.method === 'run')).toHaveLength(0);
    await page.reload();
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: /Remote question/ }).click();
    await expect(page.getByText('Your answer reached the host.', { exact: true })).toBeVisible();
    await expect(page.getByText('Your answers', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Agent questions' })).toHaveCount(0);
    const saved = await call('GET', 'state');
    expect(
      saved.workspace.conversations.find((c: any) => c.id === conversationId).messages[0]
        .questions[0].response.answers,
    ).toEqual([{ id: 'color', values: ['Blue'] }]);
    await expect(page.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
    expect(workerError).toBeUndefined();
  } finally {
    clearInterval(timer);
    while (busy) await new Promise((done) => setTimeout(done, 10));
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mobile of [false, true])
  test(`question steps preserve choices, text, retry and saved answers ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockDesktop(page, 'capabilities');
    await page.goto('/');
    await chooseTestFolder(page);
    await page.getByLabel('Message', { exact: true }).fill('Ask for my preferences');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
    await page.evaluate(() => {
      const w = window as any;
      w.testQuestion = {
        id: crypto.randomUUID(),
        revision: 1,
        status: 'pending',
        questions: [
          {
            id: 'format',
            header: 'Format',
            question: 'Choose a format',
            multiSelect: false,
            options: [
              { label: 'Brief', description: 'A short summary' },
              { label: 'Detailed', description: 'Every step' },
            ],
          },
          {
            id: 'sections',
            header: 'Sections',
            question: 'Which sections?',
            multiSelect: true,
            options: [
              { label: 'Intro', description: 'Opening context' },
              { label: 'Examples', description: 'Concrete examples' },
            ],
          },
          {
            id: '__proto__',
            header: 'Notes',
            question: 'Any extra notes?',
            multiSelect: false,
            options: [],
          },
        ],
      };
      w.emitCapability({ kind: 'question', question: w.testQuestion });
    });
    const form = page.getByRole('region', { name: 'Agent questions' });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
          return workspace.conversations.at(-1)?.messages.at(-1)?.questions?.[0]?.status;
        }),
      )
      .toBe('pending');
    const next = form.getByRole('button', { name: 'Next', exact: true });
    const back = form.getByRole('button', { name: 'Back', exact: true });
    await expect(form.getByText('Question 1 of 3')).toBeVisible();
    await expect(form.getByRole('group')).toHaveCount(1);
    await expect(next).toBeEnabled();
    await expect(back).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
    await expect(form.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText('Waiting for you', { exact: true })).toBeVisible();
    const navigation = form.getByRole('navigation', { name: 'Question navigation' });
    await expect(navigation.getByRole('button')).toHaveCount(3);
    await next.click();
    await expect(form.getByText('Question 2 of 3')).toBeVisible();
    await expect(next).toBeEnabled();
    await navigation.getByRole('button', { name: 'Question 3: Notes', exact: true }).click();
    await expect(form.getByText('Question 3 of 3')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Send answers' })).toBeDisabled();
    await navigation.getByRole('button', { name: 'Question 1: Format', exact: true }).click();
    await expect(form.getByRole('radio')).toHaveCount(2);
    await expect(form.getByText('Choose one.', { exact: true })).toBeVisible();
    await form.getByRole('radio', { name: 'Detailed' }).check();
    await form.getByRole('radio', { name: 'Brief' }).check();
    await expect(form.getByRole('radio', { name: 'Detailed' })).not.toBeChecked();
    await expect(
      navigation.getByRole('button', { name: 'Question 1: Format, answered', exact: true }),
    ).toHaveAttribute('aria-current', 'step');
    await expect(form.getByText('Question 1 of 3')).toBeVisible();
    await next.press('Enter');
    await expect(form.getByText('Question 2 of 3')).toBeVisible();
    await expect(form.locator('legend')).toBeFocused();
    await expect(next).toBeEnabled();
    await expect(form.getByRole('radio')).toHaveCount(0);
    await expect(form.getByRole('checkbox')).toHaveCount(2);
    await expect(form.getByText('Choose any that apply.', { exact: true })).toBeVisible();
    await form.getByRole('checkbox', { name: 'Intro' }).check();
    await form.getByRole('checkbox', { name: 'Examples' }).check();
    await form.getByLabel('Your answer: Which sections?').fill('Closing thoughts');
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `artifacts/question-navigation-${mobile ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    });
    await next.click();
    await expect(form.getByText('Question 3 of 3')).toBeVisible();
    await expect(next).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Send answers' })).toBeDisabled();
    await form
      .getByLabel('Your answer: Any extra notes?')
      .fill('Keep literal <script> and $(text)\nSecond line');
    // Enter in a textarea stays a newline; navigation and selection never deliver an answer.
    await form.getByLabel('Your answer: Any extra notes?').press('Enter');
    await expect(form.getByText('Question 3 of 3')).toBeVisible();
    await back.click();
    await expect(form.getByRole('checkbox', { name: 'Intro' })).toBeChecked();
    await expect(form.getByRole('checkbox', { name: 'Examples' })).toBeChecked();
    await expect(form.getByLabel('Your answer: Which sections?')).toHaveValue('Closing thoughts');
    await back.click();
    await expect(form.getByRole('radio', { name: 'Brief' })).toBeChecked();
    await form.getByLabel('Your answer: Choose a format').fill('Custom format');
    await expect(form.getByRole('radio', { name: 'Brief' })).not.toBeChecked();
    await form.getByLabel('Your answer: Choose a format').fill('');
    await expect(next).toBeEnabled();
    await expect(
      navigation.getByRole('button', { name: 'Question 1: Format', exact: true }),
    ).toBeVisible();
    await navigation
      .getByRole('button', { name: 'Question 3: Notes, answered', exact: true })
      .click();
    await expect(form.getByRole('button', { name: 'Send answers' })).toBeDisabled();
    await navigation
      .getByRole('button', { name: 'Question 1: Format', exact: true })
      .press('Enter');
    await form.getByRole('radio', { name: 'Detailed' }).check();
    await next.click();
    await next.click();
    await expect(form.getByLabel('Your answer: Any extra notes?')).toHaveValue(
      'Keep literal <script> and $(text)\nSecond line\n',
    );
    expect(await page.evaluate(() => (window as any).answersSent ?? [])).toEqual([]);
    await page.getByLabel('Message', { exact: true }).fill('Unsent draft');
    await page.evaluate(() => ((window as any).answerFailure = true));
    await form.getByRole('button', { name: 'Send answers' }).click();
    await expect(form.getByRole('alert')).toContainText('offline');
    await expect(form.getByLabel('Your answer: Any extra notes?')).toHaveValue(
      'Keep literal <script> and $(text)\nSecond line\n',
    );
    await page.evaluate(() => ((window as any).answerFailure = false));
    const box = await form.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeLessThanOrEqual(mobile ? 390 : 1380);
    await form.getByRole('button', { name: 'Send answers' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByText('Your answers', { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      const w = window as any;
      w.emitCapability({ kind: 'text', text: 'I will use those preferences.' });
      w.finishCapabilities('complete');
    });
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent draft');
    const answers = await page.evaluate(() => (window as any).answersSent);
    expect(answers).toHaveLength(1);
    expect(answers[0].answer.answers).toEqual([
      { id: 'format', values: ['Detailed'] },
      { id: 'sections', values: ['Intro', 'Examples', 'Closing thoughts'] },
      { id: '__proto__', values: ['Keep literal <script> and $(text)\nSecond line'] },
    ]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
          return workspace.conversations.at(-1).messages.at(-1).questions[0].response.answers;
        }),
      )
      .toEqual(answers[0].answer.answers);
    await page.screenshot({
      path: `artifacts/questions-no-answer-card-${mobile ? 'mobile' : 'desktop'}.png`,
      fullPage: true,
    });
  });

test('explicit skip resumes the tool and cancelled runs cannot accept old answers', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Ask');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).emitCapability === 'function');
  await page.evaluate(() => {
    const w = window as any;
    w.testQuestion = {
      id: crypto.randomUUID(),
      status: 'pending',
      revision: 1,
      questions: [
        { id: 'q', header: '', question: 'What next?', multiSelect: false, options: [] },
        { id: 'q2', header: '', question: 'Anything else?', multiSelect: false, options: [] },
      ],
    };
    w.emitCapability({ kind: 'question', question: w.testQuestion });
  });
  await page.getByLabel('Your answer: What next?').fill('Partial answer');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Skip questions' }).click();
  await expect(page.getByRole('region', { name: 'Agent questions' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).answersSent[0].answer)).toMatchObject({
    answers: [],
    skipped: true,
  });
  await page.evaluate(() => {
    const w = window as any;
    w.testQuestion.id = crypto.randomUUID();
    w.emitCapability({ kind: 'question', question: w.testQuestion });
  });
  await page.getByLabel('Your answer: What next?').fill('Keep waiting');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.evaluate(() => (window as any).finishCapabilities('cancelled'));
  await expect(page.getByText('Questions no longer awaiting answers')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).answersSent)).toHaveLength(1);
});
