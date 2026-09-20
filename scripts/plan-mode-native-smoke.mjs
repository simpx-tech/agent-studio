// Opt-in live-provider proof using only the isolated native-plan-mode identity.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/plan-mode';
await mkdir(output, { recursive: true });
const page = await nativePage(9538, 'http://127.0.0.1:1448/');
const pause = () => new Promise((r) => setTimeout(r, 250));
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const type = (text) =>
  page.evaluate((text) => {
    const e = document.querySelector('[aria-label="Message"]');
    e.value = text;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
const shot = async (name) => {
  const s = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(s.data, 'base64'));
};
async function waitForReply(chat, fn) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const saved = (await page.invoke('load_workspace')).conversations.find((c) => c.id === chat.id);
    const m = saved.messages.at(-1);
    if (m?.role === 'assistant' && fn(m)) return m;
    if (m?.role === 'assistant' && ['error', 'cancelled'].includes(m.status))
      throw Error(m.error ?? m.status);
    await pause();
  }
  throw Error('Provider did not reach the expected plan state');
}
async function select(chat) {
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((e) => e.textContent.includes('History'))
      ?.click(),
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
  await page.waitFor(() => !!document.querySelector('.conversation-item.current'));
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.plan-mode-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation'),
    w = await page.invoke('load_workspace');
  assert(
    w.conversations.every((c) => c.title.startsWith('Plan Mode QA')),
    'Not an isolated QA workspace',
  );
  const chats = [];
  for (const [provider, planMode] of [
    ['claude', false],
    ['claude', true],
    ['codex', true],
  ]) {
    const account = w.fleet.accounts.find((a) => a.provider === provider);
    const connection = w.fleet.connections.find(
      (c) =>
        c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    assert(connection);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString(),
      folder = await mkdtemp(join(tmpdir(), `studio-plan-${provider}-`));
    const chat = {
      id,
      title: `Plan Mode QA ${provider} ${planMode ? 'plan' : 'enter'} ${id.slice(0, 8)}`,
      titleStatus: 'generated',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        planMode,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      messages: [],
    };
    chats.push(chat);
    w.conversations.push(chat);
  }
  await page.invoke('save_workspace', { workspace: w });
  await page.evaluate(() => (window.planReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.planReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const report = { checkedAt: new Date().toISOString(), chats: [] };
  for (const chat of chats) {
    await select(chat);
    const target = join(chat.location.path, 'hello.txt');
    const prompt =
      (chat.settings.provider === 'claude' && !chat.settings.planMode
        ? 'First call EnterPlanMode. '
        : '') +
      'Create a short proposed plan for adding hello.txt containing HELLO in this disposable folder. Do not implement before approval. ' +
      (chat.settings.provider === 'claude'
        ? 'Call ExitPlanMode with the complete plan text to request approval. After approval, implement and reply DONE.'
        : 'Return the final proposed plan. No questions or edits are needed.');
    await type(prompt);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    if (chat.settings.provider === 'claude') {
      if (!chat.settings.planMode) {
        await waitForReply(chat, (m) =>
          m.questions?.some((q) => q.planApproval?.action === 'enter' && q.status === 'pending'),
        );
        await page.waitFor(() =>
          [...document.querySelectorAll('button')].some((b) => b.textContent === 'Enter plan mode'),
        );
        assert.equal(await exists(target), false);
        await shot('native-enter-approval');
        await page.button('Enter plan mode');
      }
      const pending = await waitForReply(chat, (m) =>
        m.questions?.some((q) => q.planApproval?.action === 'exit' && q.status === 'pending'),
      );
      assert.equal(await exists(target), false, 'No file edits before explicit approval');
      await type('Preserved plan draft');
      await page.waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Approve and implement',
        ),
      );
      await shot(`native-claude-${chat.settings.planMode ? 'plan' : 'enter'}-proposal`);
      await page.button('Approve and implement');
      const done = await waitForReply(chat, (m) => m.id === pending.id && m.status === 'complete');
      assert.equal((await readFile(target, 'utf8')).trim(), 'HELLO');
      assert.equal(
        await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
        'Preserved plan draft',
      );
      assert(
        done.questions.some(
          (q) =>
            q.planApproval?.action === 'exit' &&
            q.status === 'answered' &&
            q.response.answers[0].values[0] === 'Approve',
        ),
      );
      report.chats.push({
        id: chat.id,
        provider: 'claude',
        initialPlan: chat.settings.planMode,
        approved: done.questions.filter((q) => q.planApproval).length,
        fileWritten: true,
        draftPreserved: true,
      });
    } else {
      const done = await waitForReply(chat, (m) => m.status === 'complete');
      assert(
        done.proposedPlans?.some((p) => p.complete && p.text.includes('hello.txt')),
        'A native proposed plan was captured',
      );
      assert.equal(await exists(target), false, 'Codex plan mode did not implement');
      await page.waitFor(() => !!document.querySelector('[aria-label="Proposed plan"]'));
      await shot('native-codex-proposal');
      await page.button('Mode');
      await page.waitFor(() => !!document.querySelector('[role="option"]'));
      await page.evaluate(() =>
        [...document.querySelectorAll('[role="option"]')]
          .find((e) => e.getAttribute('aria-label') === 'Build')
          .click(),
      );
      await type(
        'Implement the proposed plan now. Write hello.txt containing HELLO, then reply DONE.',
      );
      await page.button('Send message');
      await waitForReply(chat, (m) => m.id !== done.id && m.status === 'complete');
      assert.equal((await readFile(target, 'utf8')).trim(), 'HELLO');
      report.chats.push({
        id: chat.id,
        provider: 'codex',
        proposalCount: done.proposedPlans.length,
        noPlanEdits: true,
        buildImplemented: true,
      });
    }
    await page.evaluate(() => (window.planReload = true));
    await page.cdp('Page.reload');
    await page.waitFor(
      () =>
        !window.planReload &&
        document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    );
    await select(chat);
    await page.waitFor(() => !!document.querySelector('[aria-label="Proposed plan"]'));
    await shot(`native-history-${chat.settings.provider}-${chat.settings.planMode}`);
  }
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
