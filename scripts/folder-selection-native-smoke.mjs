// Real page-scoped CDP/IPC check; no provider prompts. Restore preferences afterward.
// Page CDP avoids Playwright's assertion on WebView2 shared workers without browserContextId.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';

const inventory = await (await fetch('http://127.0.0.1:9432/json/list')).json();
const target = [inventory]
  .flat()
  .find((target) => target.type === 'page' && target.url.includes('1420'));
assert(target, 'Start the folder QA app first.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let next = 0;
const pending = new Map();
const errors = [];
socket.onmessage = ({ data }) => {
  const response = JSON.parse(data);
  if (response.method === 'Runtime.exceptionThrown')
    errors.push(response.params.exceptionDetails.text);
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  clearTimeout(request.timeout);
  if (response.error) request.reject(new Error(response.error.message));
  else request.resolve(response.result);
};
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (fn, ...args) => {
  const response = await cdp('Runtime.evaluate', {
    expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
    );
  return response.result.value;
};
const invoke = (command, args) =>
  evaluate((command, args) => window.__TAURI_INTERNALS__.invoke(command, args), command, args);
const waitFor = async (fn, ...args) => {
  const deadline = Date.now() + 30000;
  while (!(await evaluate(fn, ...args))) {
    assert(Date.now() < deadline, `UI condition timed out: ${fn}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const picker = (name) => `[role="combobox"][aria-label=${JSON.stringify(name)}]`;
const option = (name) => `[role="option"][aria-label=${JSON.stringify(name)}]`;
const click = (selector) =>
  evaluate((selector) => {
    const control = document.querySelector(selector);
    if (!control || control.disabled) throw new Error(`Control unavailable: ${selector}`);
    control.click();
  }, selector);
const text = (selector) =>
  evaluate((selector) => document.querySelector(selector)?.innerText, selector);
const button = (name) =>
  evaluate((name) => {
    const control = [...document.querySelectorAll('button')].find(
      (el) => (el.getAttribute('aria-label') ?? el.innerText).trim() === name,
    );
    if (!control || control.disabled) throw new Error(`Button unavailable: ${name}`);
    control.click();
  }, name);
const measure = async (selector, expectedPath) => {
  await evaluate(
    (selector, expectedPath) => {
      const start = performance.now();
      window.folderTiming = null;
      document.querySelector(selector).click();
      const check = () => {
        const folder = document.querySelector('[role="combobox"][aria-label="Folder"]');
        const ready = ['Agent', 'Model'].every((name) => {
          const picker = document.querySelector(`[role="combobox"][aria-label="${name}"]`);
          return picker && !picker.disabled;
        });
        if (
          folder?.getAttribute('title') === expectedPath &&
          ready &&
          !document.querySelector('[role="dialog"]')
        )
          window.folderTiming = Math.round(performance.now() - start);
        else if (performance.now() - start < 10000) setTimeout(check, 16);
      };
      setTimeout(check, 0);
    },
    selector,
    expectedPath,
  );
  await waitFor(() => window.folderTiming !== null);
  return evaluate(() => window.folderTiming);
};
try {
  await cdp('Runtime.enable');
  assert.equal(await invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.locations-qa');
  const before = await invoke('load_workspace');
  assert(
    !before.conversations.some((c) => c.messages.some((m) => m.status === 'running')),
    'Wait for the running reply.',
  );
  assert(
    !(await evaluate(() => document.querySelector('textarea[aria-label="Message"]')?.value)),
    'Preserve the typed draft first.',
  );
  const originalTitle = await text('.page-title');
  const originalTab = await evaluate(
    () => document.querySelector('[role="tab"][aria-selected="true"]').id,
  );
  try {
    await click('#conversation-tab-active');
    await click('#conversation-panel-active .conversation-item');
    await waitFor(() =>
      ['Computer', 'Folder', 'Agent'].every(
        (name) => document.querySelector(`[role="combobox"][aria-label="${name}"]`)?.disabled,
      ),
    );
    for (const name of ['Computer', 'Folder', 'Agent']) {
      await evaluate((selector) => document.querySelector(selector).click(), picker(name));
      assert.equal(await evaluate(() => document.querySelectorAll('[role="listbox"]').length), 0);
    }
    assert(
      await evaluate(
        () => !document.querySelector('[role="combobox"][aria-label="Model"]').disabled,
      ),
    );
    const clip = await evaluate(() => {
      const { x, y, width, height } = document
        .querySelector('.chat-toolbar')
        .getBoundingClientRect();
      return { x, y, width, height, scale: 1 };
    });
    const locked = await cdp('Page.captureScreenshot', { format: 'png', clip });
    await writeFile(
      'artifacts/conversation-settings-locked-native.png',
      Buffer.from(locked.data, 'base64'),
    );
    await click('#conversation-panel-active .folder-new-chat');
    await waitFor(() =>
      ['Computer', 'Folder', 'Agent'].every(
        (name) => !document.querySelector(`[role="combobox"][aria-label="${name}"]`)?.disabled,
      ),
    );
    if (process.argv.includes('--lock-only')) {
      assert.deepEqual(await invoke('load_workspace'), before);
      assert.deepEqual(errors, []);
      const result = {
        checkedAt: new Date().toISOString(),
        existingConversationIdentityLocked: true,
        newConversationIdentityEditable: true,
        existingConversationModelEditable: true,
        workspaceUnchanged: true,
        providerPromptsSent: 0,
        errors,
      };
      await writeFile(
        'artifacts/conversation-settings-locked-native-result.json',
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result, null, 2));
    } else {
      await waitFor(
        () =>
          !document.querySelector('.setup-hint') &&
          !document.querySelector('[aria-label="Refresh model list"]').disabled,
      );
      const folder = await evaluate(
        () => document.querySelector('[role="combobox"][aria-label="Folder"]').title,
      );
      assert(win32.isAbsolute(folder), 'A native Windows folder is required.');
      const computer = await text(picker('Computer'));
      const selected = await Promise.all(
        ['Agent', 'Model', 'Reasoning'].map((name) => text(picker(name))),
      );
      await click(picker('Computer'));
      const sameComputerMs = await measure(option(computer), folder);
      assert.deepEqual(
        await Promise.all(['Agent', 'Model', 'Reasoning'].map((name) => text(picker(name)))),
        selected,
      );
      await click(picker('Folder'));
      await click(option('Browse folders…'));
      await waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (el) => el.innerText.trim() === 'Go' && !el.disabled,
        ),
      );
      const parent = win32.dirname(folder);
      await evaluate((parent) => {
        const input = document.querySelector('input[aria-label="Folder path"]');
        input.value = parent;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, parent);
      await button('Go');
      await waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (el) => el.innerText.trim() === 'Use this folder' && !el.disabled,
        ),
      );
      await evaluate(() => {
        [...document.querySelectorAll('button')]
          .find((el) => el.innerText.trim() === 'Use this folder')
          .setAttribute('data-folder-timing', '');
      });
      const newFolderMs = await measure('[data-folder-timing]', parent);
      await click(picker('Model'));
      assert((await evaluate(() => document.querySelectorAll('[role="option"]').length)) > 1);
      await click(picker('Model'));
      await click(picker('Folder'));
      const savedFolderMs = await measure(option(win32.basename(folder)), folder);
      await button('Refresh model list');
      assert(
        await evaluate(
          () => !document.querySelector('[role="combobox"][aria-label="Model"]').disabled,
        ),
      );
      await click(picker('Model'));
      assert((await evaluate(() => document.querySelectorAll('[role="option"]').length)) > 1);
      const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(
        'artifacts/folder-selection-native.png',
        Buffer.from(screenshot.data, 'base64'),
      );
      await click(picker('Model'));
      assert.deepEqual((await invoke('load_workspace')).conversations, before.conversations);
      assert.deepEqual(errors, []);
      const result = {
        checkedAt: new Date().toISOString(),
        sameComputerMs,
        newFolderMs,
        savedFolderMs,
        sameComputerPreservesSettings: true,
        existingConversationIdentityLocked: true,
        newConversationIdentityEditable: true,
        modelsUsableDuringRefresh: true,
        conversationsUnchanged: true,
        providerPromptsSent: 0,
        viewport: await evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        })),
        errors,
      };
      await writeFile(
        'artifacts/folder-selection-native-result.json',
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    const current = await invoke('load_workspace');
    assert.deepEqual(current.conversations, before.conversations);
    if (!process.argv.includes('--lock-only')) {
      await invoke('save_workspace', {
        workspace: { ...current, preferences: before.preferences },
      });
      const previousDocument = await evaluate(
        () => (window.nativeSmokeDocument = crypto.randomUUID()),
      );
      await cdp('Page.reload');
      await waitFor(
        (previousDocument) =>
          window.nativeSmokeDocument !== previousDocument &&
          !!document.querySelector('#conversation-tab-active'),
        previousDocument,
      );
    }
    await click(`#${originalTab}`);
    if (originalTitle === 'New conversation') await button('New conversation');
    else if (
      before.conversations.some((c) => c.title === originalTitle) ||
      ['Overview', 'Connections', 'Workflows'].includes(originalTitle)
    )
      await button(originalTitle);
  }
} finally {
  socket.close();
}
