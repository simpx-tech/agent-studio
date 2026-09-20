// Opt-in real Claude/Codex execution in an isolated native app. No credentials are copied.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const output = 'artifacts/tool-progress';
await mkdir(output, { recursive: true });
const page = await nativePage(19659, 'http://localhost:1420/');
const report = { checkedAt: new Date().toISOString(), providers: {} };
const capture = async (name) => {
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${output}/${name}.png`, Buffer.from(shot.data, 'base64'));
};
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.tool-progress-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Tool progress QA')));
  const chats = [];
  for (const provider of ['claude', 'codex']) {
    let account = workspace.fleet.accounts.find(
      (a) =>
        a.provider === provider &&
        workspace.fleet.connections.some(
          (c) =>
            c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
        ),
    );
    if (!account) {
      account = {
        id: crypto.randomUUID(),
        provider,
        name: `Tool progress QA ${provider}`,
        purpose: 'personal',
      };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push({
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      });
    }
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    const folder = await mkdtemp(join(tmpdir(), `studio-progress-${provider}-`));
    await writeFile(
      join(folder, 'progress.cjs'),
      `const fs = require('node:fs'); let n = 0; const timer = setInterval(() => { console.log('PRIVATE_TOOL_OUTPUT_' + (++n)); if (n === 6) { clearInterval(timer); fs.writeFileSync('done.txt', 'PROGRESS_OK'); } }, 2000);`,
    );
    const now = new Date().toISOString();
    const chat = {
      id: crypto.randomUUID(),
      title: `Tool progress QA ${provider} ${Date.now()}`,
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
    };
    workspace.conversations.push(chat);
    chats.push(chat);
  }
  await page.invoke('save_workspace', { workspace });
  for (const chat of chats) {
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
  await page.evaluate(() => (window.progressReload = true));
  await page.cdp('Page.reload');
  await page.waitFor(
    () =>
      !window.progressReload &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  for (const chat of chats) {
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
        'Run node progress.cjs in the selected directory and wait for it to finish. Do not background it or modify files. Use only this command; do not inspect other files or use external integrations. After it exits successfully, reply PROGRESS_OK only. Do not repeat its output.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    const deadline = Date.now() + 240000;
    let liveSeen = false,
      answer;
    while (Date.now() < deadline) {
      const ui = await page.evaluate(() => ({
        elapsed: document.querySelector('.live-activity .group-progress .tool-elapsed')
          ?.textContent,
        body: document.body.textContent,
      }));
      assert(!ui.body.includes('PRIVATE_TOOL_OUTPUT_'));
      if (!liveSeen && ui.elapsed && ui.elapsed !== '0s') {
        liveSeen = true;
        await capture(`${chat.settings.provider}-native-live`);
        console.log(`${chat.settings.provider}: live elapsed time ${ui.elapsed}`);
      }
      const saved = await page.invoke('load_workspace');
      const last = saved.conversations.find((c) => c.id === chat.id)?.messages.at(-1);
      if (last?.role === 'assistant' && last.status !== 'running') {
        answer = last;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    assert(answer, 'Native reply timed out');
    assert.equal(answer.status, 'complete', answer.error);
    assert(liveSeen, 'No native live timer was visible');
    assert.equal(await readFile(join(chat.location.path, 'done.txt'), 'utf8'), 'PROGRESS_OK');
    const tools = answer.blocks.filter((b) => b.tool).map((b) => b.tool);
    assert(tools.some((t) => t.commandRun && t.elapsedMs >= 1000));
    assert(!JSON.stringify(tools).includes('PRIVATE_TOOL_OUTPUT_'));
    await page.click('[aria-label="Work history"]');
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.activity-group, .tool-card')) el.open = true;
      const command = [...document.querySelectorAll('.tool-card')].find((el) =>
        el.querySelector('.tool-title')?.textContent.includes('Run command'),
      );
      command?.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
    await capture(`${chat.settings.provider}-native-history`);
    report.providers[chat.settings.provider] = {
      chatId: chat.id,
      liveSeen,
      tools,
      complete: true,
      outputExcluded: true,
    };
    await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
    console.log(`${chat.settings.provider}: completed, saved elapsed time, raw output excluded`);
  }
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
