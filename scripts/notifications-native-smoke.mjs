// npm run tauri dev -- --no-watch --no-dev-server --config scripts/native-notifications.tauri.json
// Use an isolated Cargo target, WebView2 profile, and CDP port 9497.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9497);
assert.equal(
  await page.invoke('plugin:app|identifier'),
  'com.vinicius.agentstudio.notifications-qa',
);
await page.waitFor(
  () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
);
const identity = await page.invoke('get_installation');
const workspace = await page.invoke('load_workspace');
assert.equal(
  workspace.conversations.length,
  0,
  'Requires a fresh isolated notification QA workspace.',
);
const directory = await mkdtemp(join(tmpdir(), 'studio-native-push-relay-'));
const folder = await mkdtemp(join(tmpdir(), 'studio-native-push-project-'));
const token = randomBytes(32).toString('hex');
const deliveries = [];
const server = createRelay({
  token,
  directory,
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
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-native-push',
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  }),
});
assert.equal(enrolled.status, 200);
const chats = [],
  results = [];
for (const provider of ['claude', 'codex']) {
  const account = workspace.fleet.accounts.find(
    (a) =>
      a.provider === provider &&
      workspace.fleet.connections.some(
        (c) => c.accountId === a.id && c.environmentId === identity.id && c.profile === 'existing',
      ),
  );
  const connection = workspace.fleet.connections.find(
    (c) =>
      c.accountId === account?.id && c.environmentId === identity.id && c.profile === 'existing',
  );
  if (!connection) {
    results.push({ provider, verified: false, reason: 'No existing login on this computer.' });
    continue;
  }
  const status = await page.invoke('detect_connection', { provider, connectionId: connection.id });
  if (status.auth !== 'ready') {
    results.push({ provider, verified: false, reason: 'Requires sign-in.' });
    continue;
  }
  const catalog = await page.invoke('list_models', { provider, connectionId: connection.id });
  const model =
    catalog[provider].find((m) => m.id === (provider === 'claude' ? 'sonnet' : 'gpt-5.6-sol'))
      ?.id ?? catalog[provider][0]?.id;
  assert(model, 'A reported model is required.');
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const chat = {
    id,
    title: `Notifications QA ${provider}`,
    titleStatus: 'fallback',
    createdAt: now,
    updatedAt: now,
    settings: { provider, model, reasoning: 'low', instructions: '', connectionId: connection.id },
    location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
    messages: [],
  };
  workspace.conversations.push(chat);
  chats.push(chat);
}
assert(chats.length, 'At least one actual signed-in provider is required.');
await page.invoke('save_workspace', { workspace });
await page.invoke('relay_connect', { url, token });
await page.cdp('Page.reload');
await page.waitFor(
  () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
);
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
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value =
      'Ask me one short question about which color I prefer. Reply only with that question in English. Do not use any tools.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitFor(
    () => document.querySelector('[aria-label="Send message"]')?.disabled === false,
  );
  await page.button('Send message');
  console.log(`${chat.settings.provider}: checking real reply completion and relay notification`);
  let reply;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    reply = (await page.invoke('load_workspace')).conversations
      .find((c) => c.id === chat.id)
      ?.messages.at(-1);
    if (
      reply?.role === 'assistant' &&
      reply.status !== 'running' &&
      deliveries.some((d) => d.conversationId === chat.id)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(reply?.status, 'complete', reply?.error);
  assert(
    reply.blocks.some((b) => b.type === 'markdown' && b.text.includes('?')),
    'Expected an actual question in the reply.',
  );
  assert.equal(
    deliveries.filter((d) => d.conversationId === chat.id && d.kind === 'complete').length,
    1,
  );
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    `artifacts/notifications-native-${chat.settings.provider}.png`,
    Buffer.from(shot.data, 'base64'),
  );
  results.push({
    provider: chat.settings.provider,
    model: chat.settings.model,
    verified: true,
    questionReply: true,
    pushQueuedOnce: true,
  });
}
assert.equal(await page.evaluate(() => !!document.querySelector('.push-settings')), false);
await writeFile(
  'artifacts/notifications-native-result.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      results,
      physicalPhone: false,
      pushService: 'controlled sender',
      rendererErrors: page.errors,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ results, relay: url, native: 'Isolated QA app and relay remain running.' }),
);
page.close();
