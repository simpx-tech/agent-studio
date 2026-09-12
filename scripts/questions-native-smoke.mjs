import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
import { questionRelay } from './questions-old-relay.mjs';

const page = await nativePage(9497, 'http://127.0.0.1:1430/');
const report = { checkedAt: new Date().toISOString(), runs: [] };
const syncRegression = process.env.QA_QUESTION_OLD_RELAY === '1';
const multiStep = process.env.QA_QUESTION_STEPS === '1';
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.questions-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Questions QA')),
    'Not a disposable workspace',
  );
  const folder = await mkdtemp(join(tmpdir(), 'studio-questions-'));
  const chats = [];
  for (const mode of (process.env.QA_QUESTION_MODES ?? 'codex,claude,claude-native').split(',')) {
    const provider = mode.startsWith('claude') ? 'claude' : 'codex';
    const account = workspace.fleet.accounts.find((a) => a.provider === provider);
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection, `Missing ${provider} connection`);
    const state = await page.invoke('detect_connection', { provider, connectionId: connection.id });
    assert.equal(state.auth, 'ready', `${provider} needs sign-in`);
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      title = `Questions QA ${mode} ${id.slice(0, 8)}`;
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model:
          provider === 'claude' ? (syncRegression || multiStep ? 'opus' : 'sonnet') : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      messages: [],
    });
    chats.push({ id, mode, title });
  }
  await page.invoke('save_workspace', { workspace });
  const relay = syncRegression ? await questionRelay(workspace) : undefined;
  if (relay) await page.invoke('relay_connect', { url: relay.url, token: relay.token });
  await page.evaluate(() => (window.questionQaReloadPending = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.questionQaReloadPending &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false &&
      [...document.querySelectorAll('[role="tab"]')].some((e) => e.textContent.includes('History')),
  );
  for (const chat of chats) {
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((e) => e.textContent.includes('History'))
        .click(),
    );
    await page.waitFor(
      (title) =>
        [...document.querySelectorAll('.conversation-item')].some((e) =>
          e.textContent.includes(title),
        ),
      chat.title,
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((e) => e.textContent.includes(title))
          .click(),
      chat.title,
    );
    await page.evaluate(
      (mode, multiStep) => {
        const el = document.querySelector('[aria-label="Message"]');
        const tool =
          mode === 'claude-native'
            ? 'AskUserQuestion'
            : mode === 'claude'
              ? 'mcp__agent_studio__studio_ask_user'
              : 'studio_ask_user';
        const questions = multiStep
          ? 'ask exactly two questions IN ONE TOOL CALL: first which color I prefer, with Red and Blue options; second which format I prefer, with Brief and Detailed options'
          : 'ask which color I prefer, with Red and Blue options';
        el.value = `This is an interactive question test. Call the actual ${tool} tool exactly once now to ${questions}. Then wait for my submitted answer and reply with all chosen answers and the words QUESTION ROUNDTRIP PASSED. Do not infer my answer. Do not use files, shell commands, web, or subagents. Use only the specified question tool.${mode === 'claude-native' ? ' Do NOT substitute studio_ask_user or mcp__agent_studio__studio_ask_user. If AskUserQuestion is deferred, use ToolSearch to select:AskUserQuestion first. If it is unavailable, report that explicitly.' : ''}`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      chat.mode,
      multiStep,
    );
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    console.log(`${chat.mode}: waiting for actual question`);
    let reply;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const current = await page.invoke('load_workspace');
      reply = current.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (
        reply?.questions?.some((q) => q.status === 'pending') ||
        (reply?.role === 'assistant' && reply.status !== 'running')
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(reply?.status, 'running', reply?.error ?? 'Provider did not wait for a question');
    assert.equal(reply.questions?.length, 1, 'No actual question event');
    assert.equal(reply.questions[0].questions.length, multiStep ? 2 : 1);
    if (chat.mode === 'claude-native')
      assert.equal(
        reply.questions[0].questions[0].id,
        'q1',
        'Claude substituted a different question tool',
      );
    await page.waitFor(() => document.querySelector('.question-card input'));
    const requestId = reply.questions[0].id;
    const heldUntil = Date.now() + 10000;
    while (Date.now() < heldUntil) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const held = await page.invoke('load_workspace');
      const current = held.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      assert.equal(
        current?.questions?.[0]?.id,
        requestId,
        'Question disappeared without an answer',
      );
      assert.equal(current.questions[0].status, 'pending');
      assert.equal(current.status, 'running');
      assert(await page.evaluate(() => !!document.querySelector('.question-card input')));
    }
    if (relay)
      assert((relay.dropped.get(reply.runId) ?? 0) >= 3, 'No repeated relay stripping reproduced');
    await page.evaluate(() => {
      const options = [...document.querySelectorAll('.question-option')];
      const blue = options.find((e) => e.textContent.includes('Blue'));
      if (!blue) throw new Error('Blue option missing');
      blue.querySelector('input').click();
      const draft = document.querySelector('[aria-label="Message"]');
      draft.value = 'Preserved native draft';
      draft.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.question-card').scrollIntoView({ block: 'center' });
    });
    if (multiStep) {
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('.question-card fieldset').length),
        1,
      );
      await page.button('Next');
      await page.waitFor(() =>
        document.querySelector('.question-count')?.textContent.includes('2 of 2'),
      );
      await page.evaluate(() => {
        const brief = [...document.querySelectorAll('.question-option')].find(
          (e) => e.querySelector('strong').textContent === 'Brief',
        );
        if (!brief) throw new Error('Brief option missing');
        brief.querySelector('input').click();
      });
      await page.button('Back');
      await page.waitFor(() =>
        document.querySelector('.question-count')?.textContent.includes('1 of 2'),
      );
      assert(
        await page.evaluate(() =>
          [...document.querySelectorAll('.question-option')].some(
            (e) => e.textContent.includes('Blue') && e.querySelector('input').checked,
          ),
        ),
      );
      await page.button('Next');
      await page.waitFor(() =>
        document.querySelector('.question-count')?.textContent.includes('2 of 2'),
      );
      assert(
        await page.evaluate(() =>
          [...document.querySelectorAll('.question-option')].some(
            (e) => e.textContent.includes('Brief') && e.querySelector('input').checked,
          ),
        ),
      );
      const held = await page.invoke('load_workspace');
      const waiting = held.conversations.find((c) => c.id === chat.id).messages.at(-1);
      assert.equal(waiting.status, 'running');
      assert.equal(waiting.questions[0].status, 'pending');
      assert.equal(waiting.questions[0].response, undefined, 'Navigation submitted an answer');
    }
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/questions-native-${multiStep ? 'steps-' : ''}${chat.mode}.png`,
      Buffer.from(shot.data, 'base64'),
    );
    await page.button('Send answers');
    const completeDeadline = Date.now() + 180000;
    while (Date.now() < completeDeadline) {
      const current = await page.invoke('load_workspace');
      reply = current.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (reply?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(reply.status, 'complete', reply.error);
    assert.equal(reply.questions[0].status, 'answered');
    const text = reply.blocks
      .filter((b) => b.type === 'markdown')
      .map((b) => b.text)
      .join('');
    assert.match(text, /Blue/i);
    if (multiStep) {
      assert.match(text, /Brief/i);
      assert.deepEqual(
        reply.questions[0].response.answers.map((a) => a.values),
        [['Blue'], ['Brief']],
      );
    }
    assert.match(text, /QUESTION ROUNDTRIP PASSED/);
    assert.equal(
      await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
      'Preserved native draft',
    );
    report.runs.push({
      mode: chat.mode,
      conversationId: chat.id,
      status: reply.status,
      questions: reply.questions.length,
      steps: reply.questions[0].questions.length,
      answer: reply.questions[0].response.answers,
      pendingHeldMs: 10000,
      strippedSyncs: relay?.dropped.get(reply.runId),
    });
    console.log(
      `${chat.mode}: real question, UI answer, provider continuation and saved history passed`,
    );
  }
  assert.deepEqual(page.errors, []);
  const resultFile = `artifacts/questions-native-${multiStep ? 'steps-' : ''}${syncRegression ? 'sync-' : ''}result.json`;
  const previous = await readFile(resultFile, 'utf8')
    .then(JSON.parse)
    .catch(() => ({ runs: [] }));
  report.runs = [
    ...previous.runs.filter((r) => !report.runs.some((n) => n.mode === r.mode)),
    ...report.runs,
  ];
  await writeFile(resultFile, JSON.stringify(report, null, 2));
  if (relay)
    console.log('Native regression passed. Disposable relay remains running on port 14997.');
} finally {
  page.close();
}
