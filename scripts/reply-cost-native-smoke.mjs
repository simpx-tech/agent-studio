// Opt-in live Claude check in a dedicated QA identity. Reuses a completed reply on rerun.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9458);
async function reloadReady() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => {
    window.costQaMarker = marker;
  }, marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.costQaMarker !== marker &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    marker,
  );
}
async function openHistory(title) {
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
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.cost-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  let workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Reply cost QA')),
    'Not a disposable cost workspace.',
  );
  let conversation = workspace.conversations.find((c) =>
    c.messages.some((m) => m.role === 'assistant'),
  );
  if (!conversation) {
    const folder = await mkdtemp(join(tmpdir(), 'agent-studio-cost-'));
    await writeFile(join(folder, 'README.txt'), 'REPLY_COST_NATIVE_OK');
    const account = {
      id: crypto.randomUUID(),
      name: 'Claude cost QA',
      provider: 'claude',
      purpose: 'personal',
    };
    const connection = {
      id: crypto.randomUUID(),
      accountId: account.id,
      environmentId: identity.id,
      profile: 'existing',
    };
    workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(connection);
    const now = new Date().toISOString();
    conversation = {
      id: crypto.randomUUID(),
      title: 'Reply cost QA',
      titleStatus: 'fallback',
      settings: {
        connectionId: connection.id,
        provider: 'claude',
        model: 'sonnet',
        reasoning: 'low',
        instructions: '',
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    workspace.conversations.push(conversation);
    await page.invoke('save_workspace', { workspace });
    await reloadReady();
    await openHistory(conversation.title);
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Message"]');
      el.value =
        'Read README.txt in this disposable fixture and reply only with its contents. Do not edit files, inspect other paths, use integrations, or delegate.';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.click('[aria-label="Send message"]');
    console.log('Checking one Claude reply through the native composer...');
  } else {
    await reloadReady();
    await openHistory(conversation.title);
    console.log('Reusing the saved native QA reply.');
  }
  const deadline = Date.now() + 180000;
  let reply;
  do {
    workspace = await page.invoke('load_workspace');
    reply = workspace.conversations.find((c) => c.id === conversation.id)?.messages.at(-1);
    if (reply?.role === 'assistant' && reply.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  const report = {
    checkedAt: new Date().toISOString(),
    conversationId: conversation.id,
    status: reply?.status,
    usage: reply?.usage,
  };
  await writeFile('artifacts/reply-cost-native-result.json', JSON.stringify(report, null, 2));
  assert.equal(reply?.status, 'complete', reply?.error ?? 'Reply did not complete.');
  assert(
    reply.blocks.some((b) => b.type === 'markdown' && b.text.includes('REPLY_COST_NATIVE_OK')),
  );
  assert.equal(typeof reply.usage?.costUsd, 'number');
  assert(reply.usage.costUsd >= 0);
  await page.waitFor(() => !!document.querySelector('.reply-usage'));
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.usage-toggle').getAttribute('aria-expanded') === 'true',
    ),
    false,
  );
  await page.click('[aria-label="Reply usage and cost"]');
  report.render = await page.evaluate(() => {
    const usage = document.querySelector('.reply-usage');
    return {
      expanded: document.querySelector('.usage-toggle').getAttribute('aria-expanded') === 'true',
      fontSize: getComputedStyle(usage).fontSize,
      text: usage.textContent,
      afterActivity: !!(
        usage.compareDocumentPosition(document.querySelector('.activity-summary')) &
        Node.DOCUMENT_POSITION_PRECEDING
      ),
      copyButtons: document.querySelectorAll('[aria-label="Copy response"]').length,
    };
  });
  assert.equal(report.render.expanded, true);
  assert.equal(report.render.fontSize, '11px');
  assert.equal(report.render.afterActivity, true);
  assert.equal(report.render.copyButtons, 0);
  for (const [label, width] of [
    ['wide', 1380],
    ['narrow', 880],
  ]) {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(() =>
      document.querySelector('.reply-usage').scrollIntoView({ block: 'center' }),
    );
    assert(
      await page.evaluate(() => {
        const el = document.querySelector('.reply-usage');
        return el.scrollWidth <= el.clientWidth;
      }),
    );
    const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/reply-cost-${label}-native.png`,
      Buffer.from(screenshot.data, 'base64'),
    );
  }
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  await reloadReady();
  await openHistory(conversation.title);
  await page.waitFor(() => !!document.querySelector('.reply-usage'));
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.usage-toggle').getAttribute('aria-expanded') === 'true',
    ),
    false,
  );
  const collapsed = await page.evaluate(() => document.querySelector('.usage-toggle').textContent);
  assert(collapsed.includes('total') && !/input|output|tokens|cost|\$/i.test(collapsed));
  await page.click('[aria-label="Reply usage and cost"]');
  assert(
    (await page.evaluate(() => document.querySelector('.usage-breakdown').textContent)).includes(
      'Estimated cost (USD)',
    ),
  );
  report.restored = true;
  assert.deepEqual(page.errors, []);
  await writeFile('artifacts/reply-cost-native-result.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      status: report.status,
      costUsd: reply.usage.costUsd,
      restored: report.restored,
    }),
  );
} finally {
  page.close();
}
