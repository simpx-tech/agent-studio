// Opt-in real-provider proof that the desktop app records where a reply's time went and shows
// it (docs/USAGE.md). Run against the isolated QA build of scripts/native-time-report.tauri.json
// (docs/VERIFICATION.md, 2026-11-24); only that identity's data is changed. Each provider named
// in the arguments (default: codex claude) runs one real reply that runs a four-second command.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';

const providers = process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude'];
const output = 'artifacts/time-report';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = await nativePage(19911, 'http://tauri.localhost/');
const report = { checkedAt: new Date().toISOString(), replies: [] };
let failure;
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.time-report-qa',
  );
  await page.quitOnClose();
  await page.waitFor(() => document.querySelector('[aria-label="Message"]'));
  await sleep(3000);
  assert.equal(
    await page.evaluate(() => document.querySelector('.error-banner')?.innerText ?? null),
    null,
  );
  const installation = await page.invoke('get_installation');
  // The app finds this computer's CLI logins by itself, a moment after its first start.
  const login = (workspace, provider) =>
    workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
  let workspace;
  for (const deadline = Date.now() + 90000; Date.now() < deadline; await sleep(1000)) {
    workspace = await page.invoke('load_workspace');
    if (providers.every((provider) => login(workspace, provider))) break;
  }
  const folder = await mkdtemp(join(tmpdir(), 'studio-time-report-'));
  const now = new Date().toISOString();
  const chats = providers.map((provider) => {
    const connection = login(workspace, provider);
    assert(connection, `No ${provider} login was found on this computer`);
    return {
      id: crypto.randomUUID(),
      title: `Time report ${provider} QA ${Date.now()}`,
      titleStatus: 'fallback',
      settings: {
        provider,
        connectionId: connection.id,
        model: provider === 'claude' ? 'sonnet' : '',
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
  });
  const listed = (titles) =>
    page.evaluate((titles) => {
      [...document.querySelectorAll('[role="tab"]')]
        .find((e) => e.textContent.includes('History'))
        ?.click();
      const rows = [...document.querySelectorAll('.conversation-item')].map((e) => e.textContent);
      return titles.every((title) => rows.some((row) => row.includes(title)));
    }, titles);
  // The app's own startup save can land after this one, so seed until the sidebar lists them.
  for (let attempt = 0; ; attempt++) {
    assert(attempt < 10, 'The seeded chats never showed');
    workspace = await page.invoke('load_workspace');
    const missing = chats.filter((chat) => !workspace.conversations.some((c) => c.id === chat.id));
    if (missing.length) {
      workspace.conversations.push(...missing);
      await page.invoke('save_workspace', { workspace });
      await page.cdp('Page.reload');
      await page.waitFor(() => document.querySelector('[aria-label="Message"]'));
    }
    await sleep(2000);
    if (await listed(chats.map((chat) => chat.title))) break;
  }
  await mkdir(output, { recursive: true });
  for (const chat of chats) {
    const provider = chat.settings.provider;
    await listed([chat.title]);
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
        'This is an Agent Studio integration test in a disposable folder. Run this exact shell command once, in the foreground: node -e "setTimeout(()=>{},4000)" . Run nothing else. Then reply with just the word OK.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.click('[aria-label="Send message"]');
    let reply;
    for (const deadline = Date.now() + 240000; Date.now() < deadline; await sleep(500)) {
      const saved = (await page.invoke('load_workspace')).conversations.find(
        (c) => c.id === chat.id,
      );
      reply = saved?.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running' && reply.timeSpent) break;
    }
    assert.equal(reply?.status, 'complete', `${provider}: ${reply?.error}`);
    const { timeSpent, durationMs } = reply;
    assert(timeSpent, `${provider}: the reply saved no time`);
    assert.equal(timeSpent.runId, reply.runId);
    const total = Object.values(timeSpent.spent).reduce((sum, ms) => sum + ms, 0);
    // Every moment once: the ledger covers the span the reply's duration measures.
    assert(Math.abs(durationMs - total) < 1000, `${provider}: ${total} of ${durationMs} ms`);
    assert(timeSpent.spent.commands >= 4000, JSON.stringify(timeSpent.spent));
    assert(timeSpent.spent.commands < 4000 + durationMs / 2, JSON.stringify(timeSpent.spent));
    assert(timeSpent.requests >= 2, JSON.stringify(timeSpent));
    const command = reply.blocks.find((b) => b.tool?.command?.includes('setTimeout'))?.tool;
    assert(command?.elapsedMs >= 4000, JSON.stringify(command));
    if (provider === 'claude') assert(command.writeMs > 0, JSON.stringify(command));
    // Its timing panel shows it.
    await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Reply time, usage and cost"]')].at(-1).click(),
    );
    await page.waitFor(() => document.querySelector('.time-report .parts li'));
    const shown = await page.evaluate(() => ({
      total: document.querySelector('.time-report .report-total').innerText,
      parts: [...document.querySelectorAll('.time-report .parts li')].map((row) =>
        row.innerText.replace(/\s+/g, ' ').trim(),
      ),
      calls: [...document.querySelectorAll('.time-report .calls li')].map((row) =>
        row.innerText.replace(/\s+/g, ' ').trim(),
      ),
    }));
    assert(
      shown.parts.some((row) => row.startsWith('Commands')),
      JSON.stringify(shown),
    );
    assert(
      shown.calls.some((row) => row.includes('setTimeout')),
      JSON.stringify(shown),
    );
    await page.evaluate(() =>
      document.querySelector('.time-report').scrollIntoView({ block: 'center' }),
    );
    await sleep(400);
    const capture = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${output}/native-${provider}.png`, Buffer.from(capture.data, 'base64'));
    report.replies.push({
      provider,
      model: reply.usage?.model,
      durationMs,
      timeSpent,
      command: { elapsedMs: command.elapsedMs, writeMs: command.writeMs },
      shown,
    });
    console.log(`${provider}: ${durationMs} ms as ${JSON.stringify(timeSpent.spent)}`);
  }
  assert.deepEqual(page.errors, []);
} catch (error) {
  failure = error;
} finally {
  report.errors = page.errors;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/native-report.json`, JSON.stringify(report, null, 2));
  // Closing from the title bar releases the app's parked CLIs.
  await page.button('Close window').catch(() => {});
  page.close();
}
if (failure) console.error(failure);
// The debugging socket can outlive its close request and keep Node running.
process.exit(failure ? 1 : 0);
