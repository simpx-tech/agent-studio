// Opt-in real-provider check in the dedicated reasoning QA app, never the user's workspace.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9579);
const directory = 'artifacts/reasoning-native';
const cases = [
  { provider: 'claude', label: 'claude', model: 'sonnet', requiresText: false },
  { provider: 'claude', label: 'exposed Claude', model: 'claude-sonnet-4-6', requiresText: false },
  { provider: 'codex', label: 'codex', model: '', requiresText: true },
];
async function reload() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => {
    window.reasoningQaMarker = marker;
  }, marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.reasoningQaMarker !== marker &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    marker,
  );
}
async function open(title) {
  await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .find((el) => el.textContent.includes('History'))
      .click(),
  );
  await page.waitFor(
    (title) =>
      [...document.querySelectorAll('.conversation-item')].some((el) =>
        el.textContent.includes(title),
      ),
    title,
  );
  await page.evaluate(
    (title) =>
      [...document.querySelectorAll('.conversation-item')]
        .find((el) => el.textContent.includes(title))
        .click(),
    title,
  );
  await page.waitFor(() => !!document.querySelector('[aria-label="Message"]'));
}
async function screenshot(name) {
  const capture = await page.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(`${directory}/${name}.png`, Buffer.from(capture.data, 'base64'));
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.reasoning-qa');
  await mkdir(directory, { recursive: true });
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const installation = await page.invoke('get_installation');
  let workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Reasoning QA')),
    'Not a disposable reasoning workspace',
  );
  assert(
    !workspace.conversations.some((c) => c.messages.some((m) => m.status === 'running')),
    'Wait for the existing run before rerunning QA',
  );
  for (const { provider, label, model } of cases) {
    if (workspace.conversations.some((c) => c.title === `Reasoning QA ${label}`)) continue;
    let connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
    if (!connection) {
      const account = {
        id: crypto.randomUUID(),
        name: `${provider} QA`,
        provider,
        purpose: 'personal',
      };
      connection = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: installation.id,
        profile: 'existing',
      };
      workspace.fleet.accounts.push(account);
      workspace.fleet.connections.push(connection);
    }
    const now = new Date().toISOString();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: `Reasoning QA ${label}`,
      titleStatus: 'fallback',
      createdAt: now,
      updatedAt: now,
      messages: [],
      settings: {
        provider,
        connectionId: connection.id,
        model,
        reasoning: 'high',
        instructions: '',
      },
      location: { computerId: installation.computerId, environmentId: installation.id, path: '' },
    });
  }
  await page.invoke('save_workspace', { workspace });
  await reload();
  const results = [];
  for (const { provider, label, requiresText } of cases) {
    await open(`Reasoning QA ${label}`);
    workspace = await page.invoke('load_workspace');
    const conversation = workspace.conversations.find((c) => c.title === `Reasoning QA ${label}`);
    const existing = conversation.messages.find((m) => m.role === 'assistant');
    if (!existing) {
      await page.evaluate(() => {
        const input = document.querySelector('[aria-label="Message"]');
        input.value =
          'Solve this small logic puzzle without tools, file access, integrations, or delegation: A, B, C, D, and E occupy seats 1 through 5. B is immediately right of A. C is in seat 5. D is left of A. E is not in seat 1. Find all valid seating orders. Reply with the orders and a brief explanation.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitFor(
        () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
      );
      await page.click('[aria-label="Send message"]');
    }
    console.log(`Checking ${label} native reasoning${existing ? ' from saved QA reply' : ''}...`);
    let reply,
      sawStreaming = false,
      opened = false;
    const deadline = Date.now() + 240000;
    do {
      const state = await page.evaluate(() => {
        const message = [...document.querySelectorAll('[data-testid="message"]')].at(-1);
        const panel = document.querySelector('.reasoning-panel');
        return {
          running: message?.dataset.status === 'running',
          panel: !!panel,
          open: !!panel?.open,
        };
      });
      if (state.panel && !opened) {
        assert.equal(state.open, false, 'Reasoning starts collapsed');
        await page.click('.reasoning-panel > summary');
        opened = true;
      }
      if (state.panel && state.running && !sawStreaming) {
        sawStreaming = true;
        await screenshot(`${label}-streaming`);
      }
      workspace = await page.invoke('load_workspace');
      reply = workspace.conversations.find((c) => c.id === conversation.id)?.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    assert.equal(reply?.status, 'complete', reply?.error ?? 'Reply did not complete');
    const reasoning = reply.blocks.filter((b) => b.type === 'reasoning');
    if (!requiresText && reasoning.length === 0) {
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('.reasoning-panel').length),
        0,
      );
      results.push({
        provider,
        model: reply.usage?.model,
        status: reply.status,
        blocks: 0,
        notice: 'Provider did not expose thinking text; no disclosure shown.',
      });
      await screenshot(`${label}-no-text`);
      console.log(JSON.stringify(results.at(-1)));
      continue;
    }
    assert(
      reasoning.length > 0 && reasoning.every((b) => b.text.length > 0),
      `${provider} did not report reasoning text`,
    );
    assert.equal(new Set(reasoning.map((b) => b.id)).size, reasoning.length);
    await page.waitFor(() => !!document.querySelector('.reasoning-panel'));
    assert.equal(await page.evaluate(() => document.querySelector('.reasoning-panel').open), true);
    const displayed = await page.evaluate(() =>
      [...document.querySelectorAll('.reasoning-text')].map((el) => el.textContent.trim()),
    );
    await screenshot(`${label}-complete`);
    await reload();
    await open(`Reasoning QA ${label}`);
    assert.equal(await page.evaluate(() => document.querySelector('.reasoning-panel').open), false);
    await page.click('.reasoning-panel > summary');
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll('.reasoning-text')].map((el) => el.textContent.trim()),
      ),
      displayed,
    );
    const restored = await page.invoke('load_workspace');
    assert.deepEqual(
      restored.conversations.find((c) => c.id === conversation.id).messages.at(-1).blocks,
      reply.blocks,
    );
    await screenshot(`${label}-restored`);
    results.push({
      provider,
      status: reply.status,
      model: reply.usage?.model ?? reply.modelName,
      sawStreaming,
      blocks: reasoning.length,
      characters: reasoning.reduce((sum, b) => sum + b.text.length, 0),
      savedAndRestored: true,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.deepEqual(page.errors, []);
  await writeFile(
    `${directory}/results.json`,
    JSON.stringify({ checkedAt: new Date().toISOString(), results, errors: page.errors }, null, 2),
  );
} finally {
  page.close();
}
