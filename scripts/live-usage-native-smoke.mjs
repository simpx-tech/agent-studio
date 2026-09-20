// Opt-in selected-profile native proof. Never consumes a real reset credit.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const output = 'artifacts/live-usage';
await mkdir(output, { recursive: true });
const page = await nativePage(19672, 'http://127.0.0.1:1463/');
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.live-usage-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const installation = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Live Usage QA')),
    'Unexpected QA data; preserve it',
  );
  const chats = [];
  for (const provider of ['codex', 'claude']) {
    const connection = workspace.fleet.connections.find(
      (c) =>
        c.environmentId === installation.id &&
        c.profile === 'existing' &&
        workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
    );
    assert(connection);
    assert.equal(
      (await page.invoke('detect_connection', { provider, connectionId: connection.id })).auth,
      'ready',
    );
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const chat = {
      id,
      title: `Live Usage QA ${provider} ${id.slice(0, 8)}`,
      titleStatus: 'generated',
      createdAt: now,
      updatedAt: now,
      settings: {
        provider,
        model: provider === 'codex' ? 'gpt-5.6-sol' : 'sonnet',
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: {
        computerId: installation.computerId,
        environmentId: installation.id,
        path: await mkdtemp(join(tmpdir(), 'studio-live-usage-')),
      },
      messages: [],
    };
    workspace.conversations.push(chat);
    chats.push(chat);
  }
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  await page.evaluate(async () => {
    const { listen } = await import('/node_modules/@tauri-apps/api/event.js');
    window.liveUsageEvents = [];
    await listen('studio-account-update', ({ payload }) => window.liveUsageEvents.push(payload));
  });
  const report = {
    checkedAt: new Date().toISOString(),
    providers: [],
    realResetCreditsConsumed: 0,
  };
  for (const chat of chats) {
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
    await page.waitFor(() => document.querySelector('[aria-label="Message"]'));
    await page.evaluate(() => {
      const e = document.querySelector('[aria-label="Message"]');
      e.value = 'Reply exactly LIVE_USAGE_OK. Do not use tools, access files, browse, or delegate.';
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
    const deadline = Date.now() + 180000;
    let message;
    while (Date.now() < deadline) {
      const saved = (await page.invoke('load_workspace')).conversations.find(
        (c) => c.id === chat.id,
      );
      message = saved.messages.at(-1);
      if (
        message?.role === 'assistant' &&
        ['complete', 'error', 'cancelled'].includes(message.status)
      )
        break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(message?.status, 'complete', message?.error ?? 'Provider did not finish');
    const events = await page.evaluate(
      (connectionId) => window.liveUsageEvents.filter((e) => e.connectionId === connectionId),
      chat.settings.connectionId,
    );
    assert(events.length > 0, chat.settings.provider + ' did not emit a live account event');
    assert(events.every((e) => e.snapshot.provider === chat.settings.provider));
    const latest = events.at(-1);
    const native = (await page.invoke('live_account_updates')).find(
      (e) => e.connectionId === chat.settings.connectionId,
    );
    assert(native && native.revision >= latest.revision);
    await page.evaluate(() => document.querySelector('.context-chip').click());
    await page.waitFor(() => document.querySelector('#usage-details'));
    const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `${output}/native-${chat.settings.provider}.png`,
      Buffer.from(shot.data, 'base64'),
    );
    await page.evaluate(() =>
      document.querySelector('[aria-label="Close usage details"]')?.click(),
    );
    const notices =
      chat.settings.provider === 'codex'
        ? await page
            .invoke('manage_account', {
              connectionId: chat.settings.connectionId,
              input: { action: 'workspaceMessages' },
            })
            .then(
              (v) => ({ supported: true, count: v.messages.length }),
              () => ({ supported: false }),
            )
        : undefined;
    report.providers.push({
      provider: chat.settings.provider,
      events: events.length,
      windows: latest.snapshot.windows.length,
      accountChanged: events.some((e) => e.accountChanged > 0),
      rateLimitStatus: latest.limitStatus?.status ?? null,
      notices,
    });
  }
  const saved = JSON.stringify(await page.invoke('load_workspace'));
  assert(!saved.includes('accountChanged'));
  assert(!saved.includes('workspaceMessages'));
  assert.deepEqual(page.errors, []);
  await writeFile(`${output}/native-results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  page.close();
}
