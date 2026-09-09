// Start native-window.tauri.json with a separate WebView profile and CDP port 9438.
// Checks real window behavior without sending provider prompts. Closes only this QA app.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { nativePage } from './native-page.mjs';

const qaProcessId = process.argv[2];
assert(/^\d+$/.test(qaProcessId ?? ''), 'Pass the isolated QA process ID.');
const page = await nativePage(9438);
const helper = (action, args = {}) =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      'scripts/window-native-helper.ps1',
      '-QAProcessId',
      qaProcessId,
      '-Action',
      action,
      ...Object.entries(args).flatMap(([key, value]) => [`-${key}`, String(value)]),
    ],
    { windowsHide: true, stdio: 'pipe' },
  );
const windowState = (name) => page.invoke(`plugin:window|${name}`);
const screenshot = async (name) => {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/window-${name}.png`, Buffer.from(data, 'base64'));
};
const report = { checkedAt: new Date().toISOString(), providerPromptsSent: 0 };
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.window-qa');
  helper('Restore');
  await page.waitFor(() => document.querySelector('.window-controls button'));
  assert.equal(await windowState('is_decorated'), false);
  assert.equal(await windowState('is_resizable'), true);
  assert.equal(await page.evaluate(() => document.querySelector('.topbar').clientHeight), 47);
  assert.equal(
    await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height),
    48,
  );
  report.frameless = true;
  report.titlebarHeight = 48;

  await page.button('Maximize window');
  await page.waitFor(() => document.querySelector('[aria-label="Restore window"]'));
  assert.equal(await windowState('is_maximized'), true);
  await screenshot('maximized');
  await page.button('Restore window');
  await page.waitFor(() => document.querySelector('[aria-label="Maximize window"]'));
  assert.equal(await windowState('is_maximized'), false);
  report.maximizeRestore = true;

  // OS-driven changes must also update the button, independently of its click handler.
  helper('Maximize');
  await page.waitFor(() => document.querySelector('[aria-label="Restore window"]'));
  helper('Restore');
  await page.waitFor(() => document.querySelector('[aria-label="Maximize window"]'));
  report.externalMaximizeRestore = true;

  // Tauri handles a double click on the title's own drag region.
  const title = await page.evaluate(() => {
    const r = document.querySelector('.page-title').getBoundingClientRect();
    return { x: r.x + 10, y: r.y + 5 };
  });
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.cdp('Input.dispatchMouseEvent', { type, ...title, button: 'left', clickCount: 2 });
  await page.waitFor(() => document.querySelector('[aria-label="Restore window"]'));
  assert.equal(await windowState('is_maximized'), true);
  await page.button('Restore window');
  await page.waitFor(() => document.querySelector('[aria-label="Maximize window"]'));
  report.titleDoubleClick = true;

  await page.button('Minimize window');
  await page.waitFor(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized'));
  helper('Restore');
  assert.equal(await windowState('is_minimized'), false);
  report.minimize = true;

  const dpr = await page.evaluate(() => devicePixelRatio);
  helper('Resize', { Width: 840 * dpr, Height: 640 * dpr });
  await page.waitFor(() => innerWidth === 840 && innerHeight === 640);
  // Use --pointer only on an interactive desktop that delivers synthetic OS mouse input.
  if (process.argv.includes('--pointer')) {
    const before = await windowState('outer_position');
    helper('Drag', { X: 600 * dpr, Y: 24 * dpr, DeltaX: 70, DeltaY: 50 });
    const after = await windowState('outer_position');
    assert(
      Math.abs(after.x - before.x) >= 50 && Math.abs(after.y - before.y) >= 30,
      'Titlebar must move the native window.',
    );
    report.titleDrag = true;

    const size = await windowState('outer_size');
    helper('Drag', { X: size.width - 1, Y: size.height / 2, DeltaX: 90, DeltaY: 0 });
    const resized = await windowState('outer_size');
    assert(resized.width > size.width + 30, 'The native right edge must resize the window.');
    report.edgeResize = true;
  } else {
    report.pointerGestures = 'Not exercised: run with --pointer on an interactive Windows desktop.';
  }

  assert.equal(
    await page.evaluate(() => {
      const header = document.querySelector('.topbar');
      return (
        header.hasAttribute('data-tauri-drag-region') &&
        header.querySelector('.page-title').hasAttribute('data-tauri-drag-region') &&
        [...header.querySelectorAll('button')].every(
          (button) => !button.hasAttribute('data-tauri-drag-region'),
        )
      );
    }),
    true,
  );
  report.dragRegionsExcludeButtons = true;
  helper('Resize', { Width: 840 * dpr, Height: 640 * dpr });
  await page.waitFor(() => innerWidth === 840 && innerHeight === 640);

  await page.button('New conversation');
  const originalTitle = await page.evaluate(
    () => document.querySelector('.page-title').textContent,
  );
  await page.evaluate(() => {
    document.querySelector('.page-title').textContent =
      'A very long conversation title that should truncate gracefully and leave every window button accessible '.repeat(
        4,
      );
  });
  const layout = await page.evaluate(() => {
    const title = document.querySelector('.page-title');
    const controls = document.querySelector('.window-controls');
    return {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      overflow: document.documentElement.scrollWidth > innerWidth,
      titleTruncated: title.scrollWidth > title.clientWidth,
      controlsVisible:
        title.getBoundingClientRect().right < controls.getBoundingClientRect().left &&
        controls.getBoundingClientRect().right <= innerWidth,
    };
  });
  assert.equal(layout.overflow, false);
  assert.equal(layout.titleTruncated, true);
  assert.equal(layout.controlsVisible, true);
  report.minimumWindow = layout;
  await screenshot('minimum-long-title');
  await page.evaluate((title) => {
    document.querySelector('.page-title').textContent = title;
  }, originalTitle);
  await screenshot('minimum-chat');

  await page.evaluate(() => document.querySelector('[aria-label="Minimize window"]').focus());
  for (const type of ['keyDown', 'keyUp'])
    await page.cdp('Input.dispatchKeyEvent', {
      type,
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
    });
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
    'Maximize window',
  );
  for (const type of ['keyDown', 'keyUp'])
    await page.cdp('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
  await page.waitFor(() => document.querySelector('[aria-label="Restore window"]'));
  assert.equal(await windowState('is_maximized'), true);
  report.keyboardControls = true;
  await page.button('Restore window');
  helper('Resize', { Width: 1380 * dpr, Height: 900 * dpr });
  await page.waitFor(() => innerWidth === 1380 && innerHeight === 900);
  await screenshot('native-chat');
  assert.deepEqual(page.errors, []);
  assert.equal(await page.evaluate(() => !!document.querySelector('.notice')), false);
  report.errors = page.errors;
  await page.button('Close window');
  // Let the existing close handler finish cancellation/cleanup before checking process exit.
  let alive = true;
  const deadline = Date.now() + 10000;
  while (alive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      process.kill(Number(qaProcessId), 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'Close must exit the isolated native app.');
  report.close = true;
  await writeFile('artifacts/window-native-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
