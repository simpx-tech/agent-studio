// Fresh isolated app, CDP 9500. Exercises actual Claude work while another chat has focus.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9500);
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    'com.vinicius.agentstudio.pending-badges-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert.equal(workspace.conversations.length, 0, 'A fresh QA workspace is required.');
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.environmentId === identity.id &&
      c.profile === 'existing' &&
      workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === 'claude'),
  );
  assert(connection, 'An existing Claude connection is required.');
  assert.equal(
    (await page.invoke('detect_connection', { provider: 'claude', connectionId: connection.id }))
      .auth,
    'ready',
  );
  const catalog = await page.invoke('list_models', {
    provider: 'claude',
    connectionId: connection.id,
  });
  const model = catalog.claude.find((m) => m.id === 'sonnet')?.id ?? catalog.claude[0]?.id;
  assert(model);
  const folder = await mkdtemp(join(tmpdir(), 'studio-pending-badges-'));
  const chats = ['Focused chat', 'Working chat'].map((title) => ({
    id: crypto.randomUUID(),
    title,
    titleStatus: 'fallback',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      provider: 'claude',
      model,
      reasoning: '',
      instructions: '',
      connectionId: connection.id,
    },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  }));
  workspace.conversations.push(...chats);
  await page.invoke('save_workspace', { workspace });
  await page.cdp('Page.reload');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const open = async (title, scope) => {
    await page.evaluate(
      (scope) =>
        [...document.querySelectorAll('[role="tab"]')]
          .find((e) => e.textContent.includes(scope))
          .click(),
      scope,
    );
    await page.waitFor(
      (title) =>
        [...document.querySelectorAll('.conversation-item')].some((e) =>
          e.textContent.includes(title),
        ),
      title,
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((e) => e.textContent.includes(title))
          .click(),
      title,
    );
  };
  const send = async (prompt) => {
    await page.evaluate((prompt) => {
      const input = document.querySelector('[aria-label="Message"]');
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await page.waitFor(
      () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
    );
    await page.button('Send message');
  };
  const complete = async (id) => {
    const deadline = Date.now() + 180_000;
    let reply;
    while (Date.now() < deadline) {
      reply = (await page.invoke('load_workspace')).conversations
        .find((c) => c.id === id)
        ?.messages.at(-1);
      if (reply?.role === 'assistant' && reply.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(reply?.status, 'complete', reply?.error);
    return reply;
  };
  await open(chats[0].title, 'History');
  await send('Reply with just Ready. Do not use tools.');
  await complete(chats[0].id);
  await page.waitFor(() => document.querySelector('[aria-label="1 pending chats"]'));
  const before = await page.invoke('desktop_notification_settings');
  assert(before.enabled && before.sound && before.lastSent && !before.lastError);
  await open(chats[1].title, 'History');
  await send(
    'Use your shell tool to wait 6 seconds, then reply with just Finished. Do not read or modify files.',
  );
  await open(chats[0].title, 'Active');
  await page.cdp('Page.bringToFront');
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.focus();
    input.value = 'Preserve this draft while the other chat finishes';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(() => document.hasFocus() && document.visibilityState === 'visible');
  const running = (await page.invoke('load_workspace')).conversations
    .find((c) => c.id === chats[1].id)
    .messages.at(-1);
  assert.equal(running.status, 'running', 'Switch chats before the provider finishes.');
  const reply = await complete(chats[1].id);
  await page.waitFor(() => document.querySelector('[aria-label="2 pending chats"]'));
  const after = await page.invoke('desktop_notification_settings');
  assert(after.lastSent > before.lastSent && !after.lastError && after.sound);
  assert(await page.evaluate(() => document.hasFocus() && document.visibilityState === 'visible'));
  assert.equal(
    await page.evaluate(() => document.querySelector('[aria-label="Message"]').value),
    'Preserve this draft while the other chat finishes',
  );
  assert(
    reply.blocks.some((b) => b.tool?.commandRun || b.tool?.name === 'Run command'),
    'Require an actual shell tool event.',
  );
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/pending-badges-native.png', Buffer.from(shot.data, 'base64'));
  await writeFile(
    'artifacts/pending-badges-native.json',
    JSON.stringify(
      {
        provider: 'claude',
        model,
        foregroundOtherChatCompletion: true,
        nativeNotification: true,
        nativeChimeCompleted: true,
        pendingCount: 2,
        draftPreserved: true,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(page.errors, []);
  console.log(
    'Native foreground other-chat notification, custom audio, draft preservation and pending count passed.',
  );
} finally {
  page.close();
}
