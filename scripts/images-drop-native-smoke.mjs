// Real WebView2 file-drag input through CDP, in the existing isolated images QA app.
// No provider request, file-input injection, or synthetic DOM drop event.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9461);
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.images-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const before = JSON.stringify(await page.invoke('load_workspace'));
  assert(JSON.parse(before).conversations.every((c) => c.title.startsWith('Image QA')));
  const initial = await page.evaluate(() => ({
    prompt: document.querySelector('textarea[aria-label="Message"]')?.value,
    images: document.querySelectorAll('.composer .image-thumbnail').length,
    messages: document.querySelectorAll('.message').length,
  }));
  assert.equal(initial.images, 0, 'Do not overwrite an existing attachment draft.');
  assert.equal(typeof initial.prompt, 'string');
  const file = resolve('artifacts/images-native/claude-fixture.png');
  const expected = (await readFile(file)).toString('base64');
  const point = await page.evaluate(() => {
    const bounds = document.querySelector('.chat-scroll').getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + Math.min(120, bounds.height / 2) };
  });
  await page.evaluate(() => {
    window.imageDropTrusted = null;
    document.querySelector('.chat-layout').addEventListener(
      'drop',
      (event) => {
        window.imageDropTrusted = event.isTrusted;
      },
      { once: true },
    );
  });
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver'])
    await page.cdp('Input.dispatchDragEvent', { type, ...point, data });
  await page.waitFor(() =>
    document.querySelector('.image-drop-overlay')?.textContent.includes('Drop images to attach'),
  );
  // Move the drag out of the chat; CDP dragCancel alone does not emit DOM dragleave.
  await page.cdp('Input.dispatchDragEvent', { type: 'dragOver', x: 30, y: point.y, data });
  await page.waitFor(() => !document.querySelector('.image-drop-overlay'));
  for (const type of ['dragEnter', 'dragOver'])
    await page.cdp('Input.dispatchDragEvent', { type, ...point, data });
  await page.waitFor(() => !!document.querySelector('.image-drop-overlay'));
  for (const type of ['keyDown', 'keyUp'])
    await page.cdp('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
  await page.waitFor(() => !document.querySelector('.image-drop-overlay'));
  await page.cdp('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
  await page.waitFor(() => !!document.querySelector('.image-drop-overlay'));
  const hint = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/images-native/drop-hint.png', Buffer.from(hint.data, 'base64'));
  await page.cdp('Input.dispatchDragEvent', { type: 'drop', ...point, data });
  await page.waitFor(
    () => document.querySelector('.composer .image-thumbnail img')?.naturalWidth > 0,
  );
  const result = await page.evaluate(() => ({
    trusted: window.imageDropTrusted,
    source: document.querySelector('.composer .image-thumbnail img').src,
    images: document.querySelectorAll('.composer .image-thumbnail').length,
    overlay: !!document.querySelector('.image-drop-overlay'),
    focused: document.activeElement === document.querySelector('textarea[aria-label="Message"]'),
    prompt: document.querySelector('textarea[aria-label="Message"]').value,
    messages: document.querySelectorAll('.message').length,
  }));
  assert.equal(result.trusted, true);
  assert.equal(result.source, `data:image/png;base64,${expected}`);
  assert.equal(result.images, 1);
  assert.equal(result.overlay, false);
  assert.equal(result.focused, true);
  assert.equal(result.prompt, initial.prompt);
  assert.equal(result.messages, initial.messages);
  const attached = await page.cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    'artifacts/images-native/drop-attached.png',
    Buffer.from(attached.data, 'base64'),
  );
  await page.button('Remove claude-fixture.png');
  assert.equal(JSON.stringify(await page.invoke('load_workspace')), before);
  assert.deepEqual(page.errors, []);
  await writeFile(
    'artifacts/images-native-drop-result.json',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        trustedFileDrop: true,
        droppedInMessageArea: true,
        preservedBytes: true,
        attachments: result.images,
        draftPreserved: true,
        composerFocused: true,
        workspacePreserved: true,
        rendererErrors: page.errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native WebView2 file drag into the message area attached exactly one image, preserved the draft/workspace, and focused the composer.',
  );
} finally {
  page.close();
}
