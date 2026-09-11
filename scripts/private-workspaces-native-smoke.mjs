// Run with the isolated native-private-workspaces Tauri config and WebView2 CDP 9512.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server.ts';
import { createWorkspace } from '../relay/workspaces.ts';
import { nativePage } from './native-page.mjs';

const output = resolve('artifacts/private-workspaces-native');
await mkdir(output, { recursive: true });
const page = await nativePage(9512);
assert.equal(
  await page.invoke('plugin:app|identifier'),
  'com.vinicius.agentstudio.private-workspaces-qa',
);
const original = await page.invoke('load_workspace');
assert.equal(original?.conversations?.length ?? 0, 0, 'Use a fresh isolated QA installation.');
const directory = await mkdtemp(join(tmpdir(), 'studio-private-native-'));
const ownerToken = crypto.randomUUID() + crypto.randomUUID();
const alice = createWorkspace({ directory, name: 'Native QA Alice' });
const bob = createWorkspace({ directory, name: 'Native QA Bob' });
const server = createRelay({ token: ownerToken, directory });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
async function rejectOtherWorkspace() {
  const error = await page.evaluate(
    async (url, token) => {
      try {
        await window.__TAURI_INTERNALS__.invoke('relay_connect', { url, token });
        return '';
      } catch (error) {
        return String(error);
      }
    },
    url,
    bob.token,
  );
  assert.match(error, /different private workspace/);
}
try {
  await page.invoke('relay_connect', { url, token: alice.token });
  const request = () =>
    page.invoke('relay_request', { method: 'GET', path: 'v1/state', body: null });
  assert.equal((await request()).body.workspaceId, alice.workspace.id);
  await rejectOtherWorkspace();
  assert.equal((await request()).body.workspaceId, alice.workspace.id);
  await page.invoke('relay_disconnect');
  assert.equal(await page.invoke('relay_resume'), null);
  await rejectOtherWorkspace();
  await page.invoke('relay_connect', { url, token: alice.token });
  assert.equal((await request()).body.workspaceId, alice.workspace.id);
  assert.deepEqual((await page.invoke('load_workspace'))?.conversations, original?.conversations);
  await page.button('Connections');
  await page.button('Set up sync');
  await page.evaluate((url) => {
    const input = document.querySelector('input[aria-label="Relay URL"]');
    input.value = url;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, url);
  await page.evaluate((token) => {
    const input = document.querySelector('input[aria-label="Relay pairing key"]');
    input.value = token;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, bob.token);
  await page.button('Pair & sync');
  await page.waitFor(() => document.body.innerText.includes('different private workspace'));
  // Never retain the synthetic test key in the evidence screenshot.
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Relay pairing key"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(output, 'connections.png'), Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        nativeOrigin: 'http://tauri.localhost/',
        pairing: true,
        crossWorkspaceRejected: true,
        oldPairingPreserved: true,
        disconnectRetainsBinding: true,
        sameWorkspaceRepairing: true,
        localConversationsPreserved: true,
        visibleWrongWorkspaceError: true,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native workspace pairing, rejection, protected-pairing preservation and disconnect binding passed.',
  );
} finally {
  await page.invoke('relay_disconnect');
  page.close();
  await new Promise((done) => server.close(done));
}
