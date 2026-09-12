import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9497, 'http://127.0.0.1:1430/');
const report = { checkedAt: new Date().toISOString(), runs: [] };
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
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
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
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
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
    await page.evaluate((mode) => {
      const el = document.querySelector('[aria-label="Message"]');
      const tool =
        mode === 'claude-native'
          ? 'AskUserQuestion'
          : mode === 'claude'
            ? 'mcp__agent_studio__studio_ask_user'
            : 'studio_ask_user';
      el.value = `This is an interactive question test. Call the actual ${tool} tool exactly once now to ask which color I prefer, with Red and Blue options. Then wait for my submitted answer and reply with the chosen color and the words QUESTION ROUNDTRIP PASSED. Do not infer my answer. Do not use files, shell commands, web, or subagents. Use only the specified question tool.${mode === 'claude-native' ? ' Do NOT substitute studio_ask_user or mcp__agent_studio__studio_ask_user. If AskUserQuestion is deferred, use ToolSearch to select:AskUserQuestion first. If it is unavailable, report that explicitly.' : ''}`;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, chat.mode);
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
    if (chat.mode === 'claude-native')
      assert.equal(
        reply.questions[0].questions[0].id,
        'q1',
        'Claude substituted a different question tool',
      );
    await page.waitFor(() => document.querySelector('.question-card input'));
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
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/questions-native-${chat.mode}.png`,
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
      answer: reply.questions[0].response.answers,
    });
    console.log(
      `${chat.mode}: real question, UI answer, provider continuation and saved history passed`,
    );
  }
  assert.deepEqual(page.errors, []);
  const previous = await readFile('artifacts/questions-native-result.json', 'utf8')
    .then(JSON.parse)
    .catch(() => ({ runs: [] }));
  report.runs = [
    ...previous.runs.filter((r) => !report.runs.some((n) => n.mode === r.mode)),
    ...report.runs,
  ];
  await writeFile('artifacts/questions-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
