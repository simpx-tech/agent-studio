// Reuse the isolated native-window.tauri.json app on CDP 9438. No provider prompts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const qaProcessId = process.argv[2];
assert(/^\d+$/.test(qaProcessId ?? ''), 'Pass the isolated QA process ID.');
const page = await nativePage(9438);
const resize = (width, height, dpr) =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      'scripts/window-native-helper.ps1',
      '-Action',
      'Resize',
      '-QAProcessId',
      qaProcessId,
      '-Width',
      String(width * dpr),
      '-Height',
      String(height * dpr),
    ],
    { windowsHide: true },
  );
const snapshot = async (name) => {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/compact-shell-${name}.png`, Buffer.from(data, 'base64'));
};
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.window-qa');
  await page.waitFor(
    () =>
      document.querySelector('.sidebar-tools button') &&
      !document.querySelector('[aria-label="New conversation"]').disabled,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('.page-title').textContent),
    'New conversation',
  );
  assert.equal(await page.evaluate(() => !!document.querySelector('.chat-layout')), true);
  assert.equal(
    await page.evaluate(
      () => !!document.querySelector('.new-chat, .sidebar-bottom, .brand small, .sidebar nav'),
    ),
    false,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.sidebar button')]
        .map((b) => b.textContent.trim())
        .filter((text) =>
          ['Overview', 'Workflows', 'New conversation', 'Personal workspace'].includes(text),
        ),
    ),
    [],
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.brand')).fontSize),
    '15px',
  );
  assert.equal(await page.invoke('plugin:window|is_decorated'), false);
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.window-controls button').length),
    3,
  );

  // A settings round trip must preserve the draft, both via the logo and the footer toggle.
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    assertEmpty(input.value);
    function assertEmpty(value) {
      if (value) throw new Error('Preserve the existing QA draft.');
    }
    input.value = 'Keep this draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const back of ['Back to conversation', 'Connections']) {
    await page.button('Connections');
    await page.waitFor(() => document.querySelector('.page-title').textContent === 'Connections');
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('.connections-button').getAttribute('aria-pressed'),
      ),
      'true',
    );
    await page.button(back);
    await page.waitFor(
      () => document.querySelector('[aria-label="Message"]')?.value === 'Keep this draft',
    );
  }
  await page.evaluate(() => {
    const input = document.querySelector('[aria-label="Message"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dpr = await page.evaluate(() => devicePixelRatio);
  const sizes = [];
  for (const [width, height] of [
    [1380, 900],
    [840, 640],
  ]) {
    resize(width, height, dpr);
    await page.waitFor(
      (width, height) => innerWidth === width && innerHeight === height,
      width,
      height,
    );
    const layout = await page.evaluate(() => {
      const connections = document.querySelector('.connections-button').getBoundingClientRect();
      const list = document.querySelector('.conversation-list').getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        listTop: list.top,
        listHeight: list.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        connectionsVisible: connections.top >= 0 && connections.bottom <= innerHeight,
      };
    });
    assert.equal(layout.overflow, false);
    assert.equal(layout.connectionsVisible, true);
    assert(layout.listTop < 200);
    await snapshot(`${width}`);
    sizes.push(layout);
  }
  resize(1380, 900, dpr);
  assert.deepEqual(page.errors, []);
  const result = {
    checkedAt: new Date().toISOString(),
    directChatStartup: true,
    removedPagesAndFooter: true,
    compactBrand: true,
    connectionsRoundTripPreservesDraft: true,
    nativeControls: true,
    sizes,
    providerPromptsSent: 0,
    errors: page.errors,
  };
  await writeFile('artifacts/compact-shell-native-result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  page.close();
}
