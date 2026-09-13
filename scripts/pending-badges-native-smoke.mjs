// Fresh isolated app, CDP 9500. Exercises actual Claude work while another chat has focus.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { createRelay } from '../relay/server.ts';
import { nativePage } from './native-page.mjs';
const page = await nativePage(Number(process.env.QA_NOTIFICATION_PORT ?? 9500));
try {
  assert.equal(
    await page.invoke('plugin:app|identifier'),
    process.env.QA_NOTIFICATION_IDENTIFIER ?? 'com.vinicius.agentstudio.pending-badges-qa',
  );
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert.equal(workspace.conversations.length, 0, 'A fresh QA workspace is required.');
  const directory = await mkdtemp(join(tmpdir(), 'studio-foreground-native-relay-'));
  const token = randomBytes(32).toString('hex');
  const deliveries = [];
  const server = createRelay({
    directory,
    token,
    webDirectory: resolve('build'),
    pushSender: async (_subscription, payload) => {
      deliveries.push(JSON.parse(payload));
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const actor = crypto.randomUUID();
  const pair = await fetch(url + '/v1/browser-session', {
    method: 'POST',
    headers: { origin: url },
    body: JSON.stringify({ token, environmentId: actor }),
  });
  const key = createECDH('prime256v1');
  key.generateKeys();
  const enrolled = await fetch(url + '/v1/push', {
    method: 'PUT',
    headers: {
      cookie: pair.headers.get('set-cookie').split(';')[0],
      origin: url,
      'x-environment-id': actor,
    },
    body: JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/foreground-native-fixture',
      keys: {
        p256dh: key.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    }),
  });
  assert.equal(enrolled.status, 200);
  await page.invoke('relay_connect', { url, token });
  await page.invoke('set_desktop_notifications', { enabled: true, sound: true });
  const initialNotifications = await page.invoke('desktop_notification_settings');
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
  await page.cdp('Page.bringToFront');
  await page.evaluate(() => document.querySelector('[aria-label="Message"]').focus());
  await page.waitFor(() => document.hasFocus() && document.visibilityState === 'visible');
  await send('Reply with just Ready. Do not use tools.');
  await complete(chats[0].id);
  await page.waitFor(() => document.querySelector('[aria-label="1 pending chats"]'));
  // Wait until the real native checkpoint reaches the relay before claiming silence.
  const headers = { authorization: `Bearer ${token}`, 'x-environment-id': actor };
  const deadline = Date.now() + 15_000;
  while (true) {
    const state = await (await fetch(url + '/v1/state', { headers })).json();
    if (
      state.workspace.conversations.find((c) => c.id === chats[0].id)?.messages.at(-1)?.status ===
      'complete'
    )
      break;
    assert(Date.now() < deadline, 'Native completion did not sync to relay.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const before = await page.invoke('desktop_notification_settings');
  assert(before.enabled && before.sound && !before.lastError);
  assert.equal(
    before.lastSent,
    initialNotifications.lastSent,
    'Viewed completion must stay silent.',
  );
  assert.equal(deliveries.length, 0, 'Viewed desktop chat must also suppress PWA push.');
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
  assert(after.lastSent > (before.lastSent ?? 0) && !after.lastError && after.sound);
  const deliveryDeadline = Date.now() + 15_000;
  while (!deliveries.length) {
    assert(Date.now() < deliveryDeadline, 'Other-chat completion did not send PWA push.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].conversationId, chats[1].id);
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
        foregroundSameChatSilent: true,
        foregroundSameChatPushSuppressed: true,
        foregroundOtherChatPush: true,
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
    'Native viewed-chat silence, relay push suppression, other-chat notifications, custom audio, draft preservation and pending count passed.',
  );
} finally {
  page.close();
}
