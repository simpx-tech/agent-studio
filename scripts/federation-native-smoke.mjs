// Opt-in: synthetic relay request through a real Windows Tauri host and its existing Codex login.
// Start the app with scripts/native-federation.tauri.json and CDP port 9431 first.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';
import { initialWorkspace, settingsFor } from '../src/lib/domain.ts';

const directory = resolve('artifacts/native-relay-data');
await mkdir(directory, { recursive: true });
const token = crypto.randomUUID() + crypto.randomUUID();
const relay = createRelay({ token, directory });
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${relay.address().port}`;
const source = crypto.randomUUID();
const call = async (method, path, body) => {
  const response = await fetch(`${url}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-environment-id': source,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
};
const browser = await chromium.connectOverCDP('http://127.0.0.1:9431');
const page = browser.contexts()[0].pages()[0];
if (!page) throw new Error('Isolated native QA app was not found');
await page.goto('http://localhost:1420/');
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const identity = await invoke('get_installation');
const existing = await invoke('load_workspace');
if (existing?.conversations?.some((c) => !c.title.startsWith('Native relay QA')))
  throw new Error('QA workspace has unrelated conversations; refusing to replace it.');
const workspace = initialWorkspace();
workspace.fleet.computers.push({ id: identity.computerId, name: 'Desktop QA' });
workspace.fleet.environments.push({
  id: identity.id,
  computerId: identity.computerId,
  name: 'Windows',
  platform: 'windows',
});
const codexAccount = crypto.randomUUID(),
  claudeAccount = crypto.randomUUID();
const codexConnection = crypto.randomUUID(),
  isolatedConnection = crypto.randomUUID();
workspace.fleet.accounts.push(
  { id: codexAccount, name: 'Codex existing login QA', provider: 'codex', purpose: 'personal' },
  { id: claudeAccount, name: 'Claude isolated login QA', provider: 'claude', purpose: 'personal' },
);
workspace.fleet.connections.push(
  { id: codexConnection, accountId: codexAccount, environmentId: identity.id, profile: 'existing' },
  {
    id: isolatedConnection,
    accountId: claudeAccount,
    environmentId: identity.id,
    profile: 'isolated',
  },
);
await invoke('save_workspace', { workspace });
await page.reload();
await page.getByRole('button', { name: 'Connections', exact: true }).click();
const codexStatus = await invoke('detect_connection', {
  provider: 'codex',
  connectionId: codexConnection,
});
const isolatedStatus = await invoke('detect_connection', {
  provider: 'claude',
  connectionId: isolatedConnection,
});
if (isolatedStatus.auth === 'ready')
  throw new Error('New isolated profile unexpectedly reused an authenticated login');
let mismatchRejected = false;
try {
  await invoke('detect_connection', { provider: 'claude', connectionId: codexConnection });
} catch (e) {
  mismatchRejected = String(e).includes('do not match');
}
if (!mismatchRejected) throw new Error('Provider/connection mismatch was not rejected');
await page.getByRole('button', { name: 'Set up sync', exact: true }).click();
await page.getByLabel('Relay URL', { exact: true }).fill(url);
await page.getByLabel('Relay pairing key', { exact: true }).fill(token);
await page.getByRole('button', { name: 'Pair & sync', exact: true }).click();
await expect(page.getByText(/^Synced /)).toBeVisible({ timeout: 30_000 });
const id = crypto.randomUUID(),
  conversationId = crypto.randomUUID(),
  assistantId = crypto.randomUUID();
const settings = {
  ...settingsFor(workspace.preferences, 'codex'),
  model: 'gpt-5.6-luna',
  reasoning: 'low',
  connectionId: codexConnection,
};
const now = new Date().toISOString();
for (let tries = 0; tries < 5; tries++) {
  const current = await call('GET', 'state');
  current.workspace.conversations.push({
    id: conversationId,
    title: 'Native relay QA response',
    titleStatus: 'fallback',
    settings,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: now,
        blocks: [{ type: 'markdown', text: 'Reply only: native relay ready' }],
      },
      {
        id: assistantId,
        runId: id,
        role: 'assistant',
        status: 'running',
        createdAt: now,
        settings,
        executionLabel: 'Codex existing login QA · Desktop QA / Windows',
        blocks: [],
      },
    ],
  });
  try {
    await call('PUT', 'state', { revision: current.revision, workspace: current.workspace });
    break;
  } catch {
    if (tries === 4) throw new Error('Workspace stayed busy');
  }
}
await call('POST', 'jobs', {
  id,
  source,
  target: identity.id,
  method: 'run',
  args: {
    connectionId: codexConnection,
    request: {
      runId: id,
      conversationId,
      assistantId,
      agent: settings,
      messages: [{ role: 'user', text: 'Reply only: native relay ready' }],
    },
  },
});
let job;
const deadline = Date.now() + 90_000;
do {
  await new Promise((r) => setTimeout(r, 800));
  job = await call('GET', `jobs/${id}`);
} while (['queued', 'running'].includes(job.status) && Date.now() < deadline);
if (job.status !== 'complete')
  throw new Error(`Native request ${job.status}: ${job.error ?? 'no result'}`);
if (!job.events.some((e) => e.kind === 'text' && /native relay ready/i.test(e.text)))
  throw new Error('Expected native reply was missing');
await page.getByRole('button', { name: 'Native relay QA response', exact: true }).first().click();
await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
await page.screenshot({ path: 'artifacts/native-federation-chat.png' });
const saved = await invoke('load_workspace');
if (
  saved.conversations.find((c) => c.id === conversationId)?.messages.at(-1)?.status !== 'complete'
)
  throw new Error('Execution host did not retain its final result');
await writeFile(
  'artifacts/native-federation-result.json',
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      codexAuth: codexStatus.auth,
      isolatedClaudeAuth: isolatedStatus.auth,
      mismatchRejected,
      remoteStatus: job.status,
      hostRetainedResult: true,
      rendererErrors: errors,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    codexAuth: codexStatus.auth,
    isolatedClaudeAuth: isolatedStatus.auth,
    mismatchRejected,
    remoteStatus: job.status,
    hostRetainedResult: true,
    rendererErrors: errors.length,
  }),
);
await page.getByRole('button', { name: 'Connections', exact: true }).click();
await page.getByText('Sync settings', { exact: true }).click();
await page.getByRole('button', { name: 'Disconnect relay', exact: true }).click();
await expect(page.getByRole('button', { name: 'Set up sync', exact: true })).toBeVisible({
  timeout: 15_000,
});
await browser.close();
await new Promise((r) => relay.close(r));
