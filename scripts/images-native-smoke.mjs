// Opt-in: real image understanding via the native composer and existing CLI logins.
// Use native-images.tauri.json, separate target/WebView directories, and CDP 9461.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { nativePage } from './native-page.mjs';
const page = await nativePage(9461);
const report = { checkedAt: new Date().toISOString(), providers: {} };
async function reloadReady() {
  const marker = crypto.randomUUID();
  await page.evaluate((marker) => {
    window.imagesPageMarker = marker;
  }, marker);
  await page.cdp('Page.reload');
  await page.waitFor(
    (marker) =>
      window.imagesPageMarker !== marker &&
      document.querySelector('[aria-label="New conversation"]')?.disabled === false,
    marker,
  );
}
try {
  assert.equal(await page.invoke('plugin:app|identifier'), 'com.vinicius.agentstudio.images-qa');
  await page.waitFor(
    () => document.querySelector('[aria-label="New conversation"]')?.disabled === false,
  );
  const identity = await page.invoke('get_installation');
  const workspace = await page.invoke('load_workspace');
  assert(
    workspace.conversations.every((c) => c.title.startsWith('Image QA')),
    'Use only a disposable images workspace.',
  );
  await mkdir('artifacts/images-native', { recursive: true });
  for (const [provider, model] of [
    ['claude', 'sonnet'],
    ['codex', 'gpt-5.6-sol'],
  ]) {
    const workspace = await page.invoke('load_workspace');
    let account = workspace.fleet.accounts.find((a) => a.provider === provider);
    if (!account) {
      account = {
        id: crypto.randomUUID(),
        name: `${provider} Image QA`,
        provider,
        purpose: 'personal',
      };
      workspace.fleet.accounts.push(account);
    }
    let connection = workspace.fleet.connections.find(
      (c) =>
        c.accountId === account.id && c.environmentId === identity.id && c.profile === 'existing',
    );
    if (!connection) {
      connection = {
        id: crypto.randomUUID(),
        accountId: account.id,
        environmentId: identity.id,
        profile: 'existing',
      };
      workspace.fleet.connections.push(connection);
    }
    const folder = await mkdtemp(join(tmpdir(), 'studio-images-'));
    const id = crypto.randomUUID(),
      title = `Image QA ${provider} ${id.slice(0, 8)}`,
      now = new Date().toISOString();
    workspace.conversations.push({
      id,
      title,
      titleStatus: 'fallback',
      settings: {
        provider,
        model,
        reasoning: 'low',
        instructions: '',
        connectionId: connection.id,
      },
      location: { computerId: identity.computerId, environmentId: identity.id, path: folder },
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    await page.invoke('save_workspace', { workspace });
    await reloadReady();
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((el) => el.textContent.includes('History'))
        .click(),
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((el) => el.textContent.includes(title))
          .click(),
      title,
    );
    const code = `VIOLET-${Math.floor(1000 + Math.random() * 9000)}`;
    const base64 = await page.evaluate(
      (code, provider) => {
        const canvas = document.createElement('canvas');
        canvas.width = provider === 'codex' ? 1024 : 640;
        canvas.height = provider === 'codex' ? 768 : 440;
        const ctx = canvas.getContext('2d');
        if (provider === 'codex') {
          // Exercise echoed input larger than the ordinary 2 MB output-line limit.
          const noise = ctx.createImageData(canvas.width, canvas.height);
          let seed = 173;
          for (let i = 0; i < noise.data.length; i += 4) {
            for (let channel = 0; channel < 3; channel++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              noise.data[i + channel] = seed >>> 24;
            }
            noise.data[i + 3] = 255;
          }
          ctx.putImageData(noise, 0, 0);
          ctx.translate(192, 164);
        }
        ctx.fillStyle = '#fff9ea';
        ctx.fillRect(0, 0, 640, 440);
        ctx.fillStyle = '#2179cb';
        ctx.beginPath();
        ctx.moveTo(320, 35);
        ctx.lineTo(145, 285);
        ctx.lineTo(495, 285);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#171923';
        ctx.font = 'bold 44px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(code, 320, 375);
        return canvas.toDataURL('image/png').split(',')[1];
      },
      code,
      provider,
    );
    assert(Buffer.from(base64, 'base64').length <= 2 * 1024 * 1024);
    if (provider === 'codex') assert(base64.length > 2_000_000);
    const path = resolve(`artifacts/images-native/${provider}-fixture.png`);
    await writeFile(path, Buffer.from(base64, 'base64'));
    const { root } = await page.cdp('DOM.getDocument');
    const { nodeId } = await page.cdp('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[aria-label="Image files"]',
    });
    await page.cdp('DOM.setFileInputFiles', { nodeId, files: [path] });
    await page.waitFor(() => !!document.querySelector('.composer .image-thumbnail img'));
    await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Message"]');
      el.value =
        'Look only at the attached image. State its shape, its color, and the exact printed code. Do not use tools, read files, inspect the environment, or use integrations. Answer in one short sentence.';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitFor(() => !document.querySelector('[aria-label="Send message"]').disabled);
    const before = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/images-native/${provider}-composer.png`,
      Buffer.from(before.data, 'base64'),
    );
    await page.button('Send message');
    const deadline = Date.now() + 300000;
    while (
      await page.evaluate(
        () =>
          !document.querySelector('.message:not(.user)') ||
          !!document.querySelector('.message[data-status="running"]'),
      )
    ) {
      assert(Date.now() < deadline, `${provider} image reply timed out`);
      await new Promise((r) => setTimeout(r, 750));
    }
    const reply = await page.evaluate(() => ({
      status: document.querySelector('.message:not(.user)').dataset.status,
      text: document.querySelector('.message:not(.user) .prose')?.textContent,
      error: document.querySelector('.message-error')?.textContent,
    }));
    report.providers[provider] = reply;
    await writeFile('artifacts/images-native-result.json', JSON.stringify(report, null, 2));
    assert.equal(reply.status, 'complete', reply.error);
    assert(reply.text.includes(code), `${provider} did not read the code from the image`);
    assert(
      /blue/i.test(reply.text) && /triangle/i.test(reply.text),
      `${provider} did not identify the image`,
    );
    await page.waitFor(
      (id) =>
        window.__TAURI_INTERNALS__
          .invoke('load_workspace')
          .then(
            (w) => w.conversations.find((c) => c.id === id)?.messages.at(-1)?.status === 'complete',
          ),
      id,
    );
    const saved = (await page.invoke('load_workspace')).conversations.find((c) => c.id === id);
    assert.equal(saved.messages[0].images[0].data, base64);
    assert.equal(saved.messages[0].images[0].mediaType, 'image/png');
    assert(
      !saved.messages[1].blocks.some((block) => block.tool),
      'Visual understanding must not rely on reading a local file.',
    );
    await reloadReady();
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((el) => el.textContent.includes('History'))
        .click(),
    );
    await page.evaluate(
      (title) =>
        [...document.querySelectorAll('.conversation-item')]
          .find((el) => el.textContent.includes(title))
          .click(),
      title,
    );
    await page.waitFor(() => !!document.querySelector('.message.user img')?.naturalWidth);
    const after = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(
      `artifacts/images-native/${provider}-reply.png`,
      Buffer.from(after.data, 'base64'),
    );
    report.providers[provider] = { ...reply, preservedBytes: true, reopened: true, noTools: true };
    console.log(
      `${provider}: image code, shape, color, saved bytes, and reopened preview verified.`,
    );
  }
  assert.deepEqual(page.errors, []);
  report.rendererErrors = page.errors;
  await writeFile('artifacts/images-native-result.json', JSON.stringify(report, null, 2));
} finally {
  page.close();
}
