// Opt-in real-provider proof. Only the owned credits QA identity is modified.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9558, 'http://127.0.0.1:1438/');
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.credits-qa');
  let workspace = await page.invoke('load_workspace');
  assert(!workspace.conversations.some((c) => c.messages.some((m) => m.status === 'running')));
  const installation = await page.invoke('get_installation');
  const folder = await mkdtemp(join(tmpdir(), 'studio-session-spend-'));
  const chats = [];
  for (const provider of ['codex', 'claude']) {
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
    assert(connection);
    const now = new Date().toISOString();
    const chat = {
      id: crypto.randomUUID(),
      title: `Session spend ${provider} QA ${Date.now()}`,
      titleStatus: 'fallback',
      settings: {
        provider,
        connectionId: connection.id,
        model: '',
        reasoning: '',
        instructions: '',
      },
      location: {
        computerId: installation.computerId,
        environmentId: installation.id,
        path: folder,
      },
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    workspace.conversations.push(chat);
    chats.push(chat);
  }
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(() => document.querySelector('[aria-label="Message"]'));
  const report = [];
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
    for (let turn = 1; turn <= 2; turn++) {
      await page.evaluate((turn) => {
        const input = document.querySelector('[aria-label="Message"]');
        input.value = `Reply only SESSION_SPEND_OK_${turn}. Do not use tools, inspect files, delegate, or run commands.`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, turn);
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.click('[aria-label="Send message"]');
      const deadline = Date.now() + 240000;
      let reply;
      while (Date.now() < deadline) {
        workspace = await page.invoke('load_workspace');
        const c = workspace.conversations.find((c) => c.id === chat.id);
        reply = c?.messages.at(-1);
        if (
          c?.messages.filter((m) => m.role === 'assistant').length === turn &&
          reply?.status !== 'running'
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(reply?.status, 'complete', reply?.error);
      assert.equal(reply.accountUsage?.revision, 2);
      assert(
        reply.accountUsage.before && reply.accountUsage.after,
        'Live before/after readings missing',
      );
      assert.equal(reply.accountUsage.runId, reply.runId);
      assert(reply.usage?.input > 0);
      if (chat.settings.provider === 'codex') assert.equal(reply.usage.scope, 'reply');
      else assert.equal(typeof reply.usage.costUsd, 'number');
      report.push({
        provider: chat.settings.provider,
        turn,
        usage: reply.usage,
        observations: !!reply.accountUsage.before && !!reply.accountUsage.after,
      });
      console.log(
        `${chat.settings.provider} turn ${turn}: tokens, scope and account observations saved; credit estimate ${reply.usage.sessionCredits == null ? 'unavailable' : 'reported'}.`,
      );
    }
    await page.click('[aria-label^="Show context usage details"]');
    await page.waitFor(() => document.querySelector('.chat-spend'));
    const expectedInput = report
      .filter((r) => r.provider === chat.settings.provider)
      .reduce((sum, r) => sum + r.usage.input, 0);
    assert(
      await page.evaluate(
        (expected) =>
          document.querySelector('.chat-spend').textContent.includes(expected.toLocaleString()),
        expectedInput,
      ),
    );
    await page.evaluate(() =>
      document.querySelector('.chat-spend').scrollIntoView({ block: 'nearest' }),
    );
    const capture = await page.cdp('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await mkdir('artifacts/credits', { recursive: true });
    await writeFile(
      `artifacts/credits/session-${chat.settings.provider}-native.png`,
      Buffer.from(capture.data, 'base64'),
    );
    await page.click('[aria-label="Close usage details"]');
  }
  await writeFile(
    'artifacts/credits/session-native-results.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), report, errors: page.errors }, null, 2),
  );
  assert.deepEqual(page.errors, []);
} finally {
  page.close();
}
