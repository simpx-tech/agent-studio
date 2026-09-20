// Opt-in real providers in an isolated native application, using existing CLI logins.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const output = 'artifacts/subagent-detail';
await mkdir(output, { recursive: true });
const page = await nativePage(19660, 'http://localhost:1452/');
const selected = process.env.SUBAGENT_QA_PROVIDER;
assert(!selected || ['claude', 'codex'].includes(selected));
const report = selected
  ? JSON.parse(await readFile(`${output}/native-report.json`, 'utf8'))
  : { checkedAt: new Date().toISOString(), providers: {} };
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.subagent-detail-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Subagent detail QA')));
  const chats = [];
  for (const provider of ['claude', 'codex']) {
    if (selected && provider !== selected) continue;
    let connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === identity.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
    if (!connection) {
      const account = {
        id: crypto.randomUUID(),
        provider,
        name: `Subagent detail QA ${provider}`,
        purpose: 'personal',
      };
      connection = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push(connection);
    }
    const folder = await mkdtemp(join(tmpdir(), 'studio-subagent-detail-'));
    const marker = `CHILD_MARKER_${crypto.randomUUID()}`;
    await writeFile(join(folder, 'marker.txt'), marker);
    const now = new Date().toISOString();
    const chat = {
      id: crypto.randomUUID(),
      title: `Subagent detail QA ${provider} ${Date.now()}`,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      messages: [],
      settings: {
        provider,
        model: provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    };
    workspace.conversations.push(chat);
    chats.push({ chat, marker });
  }
  await page.invoke('save_workspace', { workspace });
  for (const { chat } of chats) {
    assert.equal(
      (
        await page.invoke('detect_connection', {
          provider: chat.settings.provider,
          connectionId: chat.settings.connectionId,
        })
      ).auth,
      'ready',
    );
  }
  await page.evaluate(() => {
    window.subagentReload = true;
  });
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.subagentReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const { chat, marker } of chats) {
    await page.click('#conversation-tab-history');
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
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value =
        'Native integration test: delegate to exactly one child agent named fixture-reader. Ask it to first say CHILD_PROGRESS, read marker.txt in the current fixture folder with a read tool, then return its exact contents. Wait for it to finish. Do not read the file yourself. Do not inspect anything outside the fixture folder, edit files, use external integrations or message other sessions. In your own final answer say PARENT_DONE only; keep child results in delegation. Use native delegation tools.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    let answer;
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const saved = await page.invoke('load_workspace');
      const last = saved.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (last?.role === 'assistant' && last.status !== 'running') {
        answer = last;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    assert(answer, 'Native reply timed out');
    assert.equal(answer.status, 'complete', answer.error);
    const tools = answer.blocks.filter((b) => b.tool).map((b) => b.tool);
    const children = tools.flatMap((t) => t.agents);
    assert(
      children.some((a) => a.messages?.some((m) => m.text.includes(marker))),
      'Child text was not retained',
    );
    assert(
      children.some((a) => a.status === 'complete'),
      'Child completion was not retained',
    );
    assert(
      !answer.blocks.filter((b) => b.type === 'text').some((b) => b.text.includes(marker)),
      'Child text leaked into parent answer',
    );
    await page.click('[aria-label="Work history"]');
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(
        '.activity-group, .tool-card[data-category="agent"], .agent-result',
      ))
        el.open = true;
      document
        .querySelector('.subagent .agent-result')
        ?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `${output}/${chat.settings.provider}-native.png`,
      Buffer.from(shot.data, 'base64'),
    );
    report.providers[chat.settings.provider] = {
      complete: true,
      childMessages: children.reduce((n, a) => n + (a.messages?.length ?? 0), 0),
      markerRetained: true,
      parentIsolated: true,
      chatId: chat.id,
    };
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(
      `${chat.settings.provider}: saved child messages and completion; parent answer isolated`,
    );
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
