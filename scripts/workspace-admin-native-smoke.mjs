// Uses native-workspace-admin.tauri.json and an isolated WebView2 profile on CDP 9520.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';
import { editWorkspace } from '../relay/workspaces.ts';
import { nativePage } from './native-page.mjs';

const output = resolve('artifacts/workspace-admin-native');
const directory = join(output, 'relay');
await mkdir(directory, { recursive: true });
// Fixed synthetic loopback fixture permits reruns without replacing the native binding.
const token = 'synthetic-workspace-admin-native-owner-key';
editWorkspace({ directory, id: 'owner', role: 'admin' });
const server = createRelay({ token, directory });
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(4349, '127.0.0.1', done);
});
const url = 'http://127.0.0.1:4349';
const page = await nativePage(9520);
assert.equal(
  await page.invoke('plugin:app|identifier'),
  'com.vinicius.agentstudio.workspace-admin-qa',
);
const original = await page.invoke('load_workspace');
assert.equal(original?.conversations?.length ?? 0, 0, 'Use the isolated QA installation.');
const request = (method, path, body = null) => page.invoke('relay_request', { method, path, body });
const fill = (label, value) =>
  page.evaluate(
    (label, value) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      assertInput(input);
      function assertInput(input) {
        if (!input) throw new Error('Required input missing.');
      }
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    label,
    value,
  );
let createdId;
try {
  await page.button('Connections');
  const paired = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.innerText.trim() === 'Disconnect relay',
    ),
  );
  if (!paired) {
    await page.button('Set up sync');
    await fill('Relay URL', url);
    await fill('Relay pairing key', token);
    await page.button('Pair & sync');
  }
  await page.waitFor(() => !!document.querySelector('.workspace-administration'));
  const initial = await request('GET', 'v1/workspace-admin');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.role, 'admin');
  assert.equal(initial.body.workspaceId, 'owner');

  await page.button('Create workspace');
  const name = `Native managed ${Date.now()}`;
  await fill('Workspace name', name);
  await page.click('dialog form button.primary');
  await page.waitFor(() => !!document.querySelector('textarea[aria-label="New workspace key"]'));
  const issued = await page.evaluate(
    () => document.querySelector('textarea[aria-label="New workspace key"]').value,
  );
  assert(issued.length >= 32);
  const list = await request('GET', 'v1/workspace-admin');
  const created = list.body.workspaces.find((workspace) => workspace.name === name);
  assert.equal(created.role, 'member');
  createdId = created.id;
  const member = await fetch(`${url}/v1/workspace-admin`, {
    headers: { authorization: `Bearer ${issued}`, 'x-environment-id': crypto.randomUUID() },
  });
  assert.equal(member.status, 200);
  assert.deepEqual(await member.json(), { workspaceId: createdId, role: 'member' });
  assert.equal(JSON.stringify(await page.invoke('load_workspace')).includes(issued), false);
  assert.equal(
    await page.evaluate(
      (key) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(key),
      issued,
    ),
    false,
  );
  await page.button('Done');
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll('textarea[aria-label="New workspace key"]').length,
    ),
    0,
  );

  const grant = await request('PUT', `v1/workspace-admin/workspaces/${createdId}`, {
    name,
    role: 'admin',
  });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.workspace.role, 'admin');
  await page.button('Refresh workspaces');
  await page.waitFor(
    (id) =>
      document.querySelector(`[data-workspace-id="${id}"]`)?.innerText.includes('Administrator'),
    createdId,
  );
  await page.evaluate(() =>
    document.querySelector('.workspace-administration').scrollIntoView({ block: 'center' }),
  );
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'connections.png'), Buffer.from(screenshot.data, 'base64'));

  assert.equal(
    (await request('PUT', 'v1/workspace-admin/workspaces/owner', { name: 'Owner', role: 'member' }))
      .status,
    200,
  );
  await page.button('Refresh workspaces');
  await page.waitFor(() => !document.querySelector('.workspace-administration'));
  assert.equal(
    (await request('POST', 'v1/workspace-admin/workspaces', { name: 'Forbidden', role: 'admin' }))
      .status,
    403,
  );
  assert.equal((await request('GET', 'v1/state')).body.workspaceId, 'owner');
  assert.deepEqual(
    (await page.invoke('load_workspace'))?.conversations ?? [],
    original?.conversations ?? [],
  );
  assert.deepEqual(page.errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        nativeOrigin: 'http://tauri.localhost/',
        nativeAdminRead: true,
        nativeCreateFromUi: true,
        memberIsolation: true,
        nativeRoleAssignment: true,
        oneTimeKeyNotPersisted: true,
        demotionHidesControls: true,
        demotedMutationRejected: true,
        ownerChatsPreserved: true,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native workspace creation, role assignment, key privacy and demotion checks passed.',
  );
} finally {
  editWorkspace({ directory, id: 'owner', role: 'admin' });
  if (createdId) editWorkspace({ directory, id: createdId, role: 'member' });
  const connected = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.innerText.trim() === 'Disconnect relay',
    ),
  );
  if (connected) await page.button('Disconnect relay');
  page.close();
  await new Promise((done) => server.close(done));
}
