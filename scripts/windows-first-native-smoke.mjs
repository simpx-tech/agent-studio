// Actual Windows Claude login and reply with a WSL folder; isolated QA identity only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9434);
const { evaluate, invoke, click, button, waitFor, cdp } = page;
const picker = (name) => `[role="combobox"][aria-label=${JSON.stringify(name)}]`;
const option = (name) => `[role="option"][aria-label=${JSON.stringify(name)}]`;
let before;
try {
  assert.equal(await invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.windows-first-qa');
  before = await invoke('load_workspace');
  assert(
    before && before.conversations.length === 0,
    'Use the empty isolated Windows-first QA app.',
  );
  await button('Chat with Claude');
  await click(picker('Folder'));
  await click(option('Browse folders…'));
  await waitFor(() => !!document.querySelector('[aria-label="Folder environment"]'));
  await click(picker('Folder environment'));
  await click(option('WSL · Ubuntu'));
  await waitFor(() =>
    [...document.querySelectorAll('button')].some(
      (el) => el.innerText.trim() === 'Go' && !el.disabled,
    ),
  );
  await evaluate(() => {
    const input = document.querySelector('[aria-label="Folder path"]');
    input.value = '/tmp';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await button('Go');
  await waitFor(() =>
    [...document.querySelectorAll('button')].some(
      (el) => el.innerText.trim() === 'Use this folder' && !el.disabled,
    ),
  );
  await button('Use this folder');
  await waitFor(
    () =>
      !document.querySelector('[role="dialog"]') &&
      !document.querySelector('[aria-label="Agent"]').disabled,
  );
  const saved = await invoke('load_workspace');
  const location = saved.preferences.recentLocations[0];
  assert.equal(location.path, '/tmp');
  const connectionId = saved.preferences.connectionByProvider.claude;
  const status = await invoke('detect_connection', { provider: 'claude', connectionId });
  assert.equal(status.installed, true);
  assert.equal(status.location, 'Windows');
  await evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = 'Ready to use Windows Claude in the WSL folder';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(
    () =>
      !document.querySelector('[aria-label="Send message"]').disabled &&
      !document.querySelector('.setup-hint'),
  );
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    'artifacts/windows-first-wsl-ready-native.png',
    Buffer.from(screenshot.data, 'base64'),
  );
  await evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const reply = await evaluate(
    async ({ location, connectionId }) => {
      const events = [];
      const internal = window.__TAURI_INTERNALS__;
      const callback = internal.transformCallback((event) => events.push(event.message));
      try {
        const status = await internal.invoke('run_agent', {
          connectionId,
          onEvent: `__CHANNEL__:${callback}`,
          request: {
            runId: crypto.randomUUID(),
            location,
            agent: { provider: 'claude', model: 'haiku', reasoning: '', instructions: '' },
            messages: [
              {
                role: 'user',
                text: 'Without using tools, reply with only the absolute working-directory path listed in your session context.',
              },
            ],
          },
        });
        return {
          status,
          text:
            events
              .filter((event) => event?.kind === 'text')
              .map((event) => event.text)
              .at(-1) ?? '',
        };
      } finally {
        internal.unregisterCallback(callback);
      }
    },
    { location, connectionId },
  );
  assert.equal(reply.status, 'complete');
  assert(
    reply.text.toLowerCase().includes('ubuntu') && reply.text.toLowerCase().includes('tmp'),
    'Claude must report the selected WSL directory',
  );
  assert.deepEqual(page.errors, []);
  const result = {
    checkedAt: new Date().toISOString(),
    provider: 'claude',
    location: status.location,
    installed: status.installed,
    nativeSendEnabled: true,
    setupWarningAbsent: true,
    selectedWslFolderPreserved: true,
    reply,
    providerPromptsSent: 1,
    errors: page.errors,
  };
  await writeFile('artifacts/windows-first-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (before) {
    await invoke('save_workspace', { workspace: before });
    const previous = await evaluate(() => (window.qaDocument = crypto.randomUUID()));
    await cdp('Page.reload');
    await waitFor(
      (previous) =>
        window.qaDocument !== previous && !!document.querySelector('#conversation-tab-active'),
      previous,
    );
  }
  page.close();
}
