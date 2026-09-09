import { test, expect, type Page } from '@playwright/test';
import { chooseTestFolder } from './folder-helper';
import { expectVisibleQuotaComparison } from './quota-helper';

async function mockDesktop(page: Page, mode = 'success') {
  await page.addInitScript(
    ({ mode }) => {
      (window as any).isTauri = true;
      const callbacks = new Map<number, (value: unknown) => void>();
      let next = 0;
      let pending: (() => void) | undefined;
      (window as any).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' } },
        transformCallback(fn: (v: unknown) => void) {
          const id = ++next;
          callbacks.set(id, fn);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(command: string, args: any) {
          if (command === 'plugin:window|is_maximized') return false;
          if (command === 'plugin:event|listen') return 0;
          if (command === 'plugin:event|unlisten') return;
          if (['detect_connection', 'list_models', 'list_folders'].includes(command)) {
            const state = window as any;
            (state.cliCalls ??= []).push({ command, ...args });
            if (state.holdCli?.includes(command))
              await new Promise<void>((resolve) => {
                (state.pendingCli ??= []).push({ command, ...args, resolve });
              });
          }
          if (command === 'get_installation')
            return {
              id: '11111111-1111-4111-8111-111111111111',
              computerId: '22222222-2222-4222-8222-222222222222',
              name: 'Desktop',
              platform: 'windows',
            };
          if (command === 'discover_wsl')
            return {
              distributions:
                mode === 'locations' || mode === 'computer-routing'
                  ? [{ id: '33333333-3333-4333-8333-333333333333', name: 'Ubuntu', running: true }]
                  : [],
              warning: null,
            };
          if (command === 'list_folders') {
            if (args.path === '/missing') throw new Error('Folder does not exist');
            const path =
              args.path ||
              (args.environmentId === '33333333-3333-4333-8333-333333333333'
                ? '/home/test/studio'
                : 'C:\\Projects\\studio');
            return {
              path,
              parent: path.startsWith('/') ? '/home/test' : 'C:\\Projects',
              entries: [],
              truncated: false,
            };
          }
          if (command === 'inspect_environment_clis')
            return ['codex', 'claude', 'gemini'].map((id) => ({
              id,
              path:
                args.environmentId === '11111111-1111-4111-8111-111111111111'
                  ? 'C:/CLIs/' + id + '.exe'
                  : id === 'codex'
                    ? '/usr/local/bin/codex'
                    : null,
            }));
          if (command === 'detect_connection') {
            const fleet = JSON.parse(localStorage.getItem('test-workspace')!).fleet;
            const wsl =
              fleet.connections.find((c: any) => c.id === args.connectionId)?.environmentId ===
              '33333333-3333-4333-8333-333333333333';
            return {
              id: args.provider,
              installed: !wsl || args.provider === 'codex',
              location: wsl ? 'WSL · Ubuntu' : 'Windows',
              auth:
                mode === 'login-flow' &&
                args.provider === 'gemini' &&
                localStorage.getItem('test-google-login') !== 'ready'
                  ? 'login'
                  : 'ready',
              version: 'Test fixture',
              detail: 'Fixture connection',
            };
          }
          if (command === 'load_workspace')
            return JSON.parse(localStorage.getItem('test-workspace') ?? 'null');
          if (command === 'save_workspace') {
            localStorage.setItem('test-workspace', JSON.stringify(args.workspace));
            return;
          }
          if (command === 'list_models') {
            const model = (
              id: string,
              name: string,
              levels = ['low', 'medium', 'high'],
              defaultReasoning = 'medium',
            ) => ({
              id,
              name,
              reasoningLevels: levels,
              defaultReasoning,
              contextWindow: 20000,
              contextSource: 'Fixture metadata',
            });
            return {
              codex: [
                model('', 'CLI default'),
                model('gpt-6-astra', 'GPT-6 Astra'),
                model('gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'high'], 'low'),
              ],
              claude: [
                model('', 'CLI default'),
                model('sonnet', 'Sonnet'),
                model('fable', 'Fable'),
                model('opus', 'Opus', ['low', 'medium', 'high', 'max']),
              ],
              gemini: [
                model('gemini-3.8-flash', 'Gemini 3.8 Flash'),
                model('gemini-3.1-pro', 'Gemini 3.1 Pro', ['low', 'high'], 'high'),
              ],
            };
          }
          if (command === 'detect_providers')
            return ['codex', 'claude', 'gemini'].map((id) => ({
              id,
              installed: true,
              version: 'Test fixture',
              auth:
                mode === 'login-flow' &&
                id === 'gemini' &&
                localStorage.getItem('test-google-login') !== 'ready'
                  ? 'login'
                  : 'ready',
              detail: 'Fixture connection',
            }));
          if (command === 'sign_in') {
            localStorage.setItem('test-sign-in-provider', args.provider);
            return;
          }
          if (command === 'read_context') {
            const state = window as any;
            (state.contextCalls ??= []).push(args);
            if (state.holdContext)
              await new Promise<void>((resolve) => (state.releaseContext = resolve));
            if (state.failContext)
              throw new Error('Context is unavailable on the selected computer.');
            return {
              provider: args.provider,
              model: args.model,
              checkedAt: Date.now(),
              execution: 'Windows',
              folder: args.location?.path ?? 'C:\\Runtime',
              profile: `C:\\Profiles\\${args.connectionId}`,
              entries: [
                {
                  name: args.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md',
                  path: `${args.location?.path}\\${args.provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`,
                  kind: 'instructions',
                  scope: 'Project',
                  status: 'reported',
                  detail: `Loaded in a fresh CLI context query. Revision ${state.contextRevision ?? 0}.`,
                },
                {
                  name: 'CLAUDE.local.md',
                  path: `${args.location?.path}\\CLAUDE.local.md`,
                  kind: 'instructions',
                  scope: 'Project',
                  status: 'discovered',
                  detail: 'Available on disk; use is unconfirmed.',
                },
                {
                  name: 'test-skill',
                  path: 'C:\\Profiles\\skills\\test-skill\\SKILL.md',
                  kind: 'skills',
                  scope: 'User',
                  status: state.enableSkill ? 'reported' : 'disabled',
                  detail: 'Disabled in the selected profile.',
                },
                {
                  name: 'MEMORY.md',
                  path: 'C:\\Profiles\\projects\\fixture\\memory\\MEMORY.md',
                  kind: 'memories',
                  scope: 'Project memory',
                  status: 'discovered',
                  detail: 'Available on disk; use is unconfirmed.',
                },
              ],
              notes: ['This is a startup inspection, not a read history of an earlier reply.'],
              truncated: false,
            };
          }
          if (command === 'read_usage') {
            if (localStorage.getItem('test-usage-error')) throw new Error('Usage refresh failed');
            const requests = JSON.parse(localStorage.getItem('test-usage-requests') ?? '[]');
            requests.push(args);
            localStorage.setItem('test-usage-requests', JSON.stringify(requests));
            const limitWindow = (
              id: string,
              minutes: number,
              percent: number | null,
              model: string | null = null,
            ) => ({
              id,
              label: id,
              windowMinutes: minutes,
              usedPercent:
                mode === 'usage-pace'
                  ? id === '5-hour'
                    ? 70
                    : model === 'fable'
                      ? 50
                      : 25
                  : percent,
              resetsAt:
                Math.floor(Date.now() / 1000) + (mode === 'usage-pace' ? minutes * 30 : 3600),
              model,
              bucket: args.provider,
            });
            const snapshot = {
              provider: args.provider,
              checkedAt: Math.floor(Date.now() / 1000),
              context:
                args.provider === 'claude'
                  ? {
                      model: args.model || 'claude-sonnet-5',
                      tokens: 20000,
                      source: 'Fixture CLI context',
                    }
                  : null,
              detail: 'Reported by fixture',
              windows: [
                ...(mode === 'usage-missing' ? [] : [limitWindow('5-hour', 300, 12)]),
                limitWindow('Weekly', 10080, args.provider === 'claude' ? 31 : 26),
                ...(args.provider === 'claude'
                  ? [limitWindow('Fable weekly', 10080, 62, 'fable')]
                  : []),
              ],
            };
            if (mode === 'usage-race' && args.provider === 'codex')
              return new Promise(
                (resolve) => ((window as any).resolveUsage = () => resolve(snapshot)),
              );
            return snapshot;
          }
          if (command === 'generate_title') {
            const requests = JSON.parse(localStorage.getItem('test-title-requests') ?? '[]');
            requests.push(args);
            localStorage.setItem('test-title-requests', JSON.stringify(requests));
            if (mode !== 'title-deferred') throw new Error('Title unavailable');
            return new Promise((resolve) => {
              (window as any).resolveTitle = () =>
                resolve({
                  title: 'Planning a balcony garden',
                  provider: args.provider,
                  model: 'gpt-5.6-luna',
                });
            });
          }
          if (command === 'cancel_title') {
            localStorage.setItem('test-cancelled-title', args.conversationId);
            return;
          }
          if (command === 'cancel_run') {
            pending?.();
            return;
          }
          if (command === 'run_agent') {
            localStorage.setItem('test-last-request', JSON.stringify(args.request));
            const turnCount = Number(localStorage.getItem('test-run-count') ?? 0) + 1;
            localStorage.setItem('test-run-count', String(turnCount));
            const id = args.onEvent.id;
            let index = 0;
            const emit = (message: unknown) => callbacks.get(id)?.({ message, index: index++ });
            emit({ kind: 'activity', text: 'Connected' });
            if (mode === 'capabilities') {
              (window as any).emitCapability = emit;
              return await new Promise((resolve) => {
                (window as any).finishCapabilities = resolve;
                pending = () => resolve('cancelled');
              });
            }
            if (mode === 'settings-deferred')
              await new Promise<void>((resolve) => ((window as any).finishReply = resolve));
            if (mode === 'error')
              throw new Error(
                'Your CLI login needs attention. Open Connections, sign in, and try again.',
              );
            emit({
              kind: 'text',
              text: '## A clear answer\n\nHello **world**.\n\n```html\n<div>Safe code</div>\n```\n\n<script>window.pwned=true</script><img src="https://invalid.test/pixel" onerror="window.pwned=true">\n\n[Unsafe](javascript:alert(1))\n\n| A | B |\n| --- | --- |\n| 1 | 2 |',
            });
            if (mode === 'slow')
              return new Promise((resolve) => (pending = () => resolve('cancelled')));
            if (mode === 'usage-deferred' && turnCount > 1)
              await new Promise<void>((resolve) => ((window as any).finishReply = resolve));
            await new Promise((resolve) => setTimeout(resolve, 200));
            emit(
              mode.startsWith('usage-')
                ? {
                    kind: 'usage',
                    input: 2000,
                    output: 100,
                    cachedInput: 1500,
                    contextInput:
                      mode === 'usage-unmeasured' || (mode === 'usage-deferred' && turnCount > 1)
                        ? null
                        : 2000,
                    contextWindow: 20000,
                  }
                : { kind: 'usage', input: 20, output: 10 },
            );
            return 'complete';
          }
        },
      };
    },
    { mode },
  );
}

async function imageFixture(page: Page, name = 'diagram.png') {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 220;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f4eee2';
    ctx.fillRect(0, 0, 360, 220);
    ctx.fillStyle = '#267fcb';
    ctx.beginPath();
    ctx.moveTo(180, 30);
    ctx.lineTo(80, 180);
    ctx.lineTo(280, 180);
    ctx.closePath();
    ctx.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

test('images can be previewed, sent without text, reopened and retried with the original bytes', async ({
  page,
}) => {
  await mockDesktop(page, 'error');
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.getByLabel('Image files').setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Remove diagram.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview diagram.png' }).click();
  await expect(page.getByRole('dialog', { name: 'Image preview' }).getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages[0].text).toBe('');
  expect(request.messages[0].images[0].data).toBe(file.buffer.toString('base64'));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).messages),
  ).toEqual(request.messages);
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(
    page.locator('.message.user').getByRole('img', { name: 'diagram.png' }),
  ).toBeVisible();
});

test('pasting and dropping images preserves drafts and supports removal at compact widths', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.getByLabel('Message', { exact: true }).fill('Please explain this diagram.');
  expect(
    await page.evaluate(() => {
      const text = new DataTransfer();
      text.setData('text/plain', 'Ordinary text');
      return document.querySelector('textarea')!.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: text,
          bubbles: true,
          cancelable: true,
        }),
      );
    }),
  ).toBe(true);
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'pasted.png', {
        type: 'image/png',
      }),
    );
    document
      .querySelector('textarea')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Remove pasted.png' })).toBeVisible();
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'dropped.png', {
        type: 'image/png',
      }),
    );
    document
      .querySelector('.composer')!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Remove dropped.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Please explain this diagram.',
  );
  await expect(page.getByRole('button', { name: 'Remove pasted.png' })).toBeVisible();
  await page.setViewportSize({ width: 840, height: 640 });
  await page.screenshot({ path: 'artifacts/images-composer-compact.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Remove pasted.png' }).click();
  await expect(page.getByRole('button', { name: 'Preview pasted.png' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message[data-status="complete"]')).toHaveCount(2);
  await page.getByLabel('Message', { exact: true }).fill('And what shape is it?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('test-run-count'))).toBe('2');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages[0].images.map((image: any) => image.name)).toEqual(['dropped.png']);
  expect(request.messages.at(-1).text).toBe('And what shape is it?');
});

test('invalid and excess images stay out of the draft and Gemini attachment input is explicit', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  for (const [file, error] of [
    [{ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }, 'Choose a PNG'],
    [
      { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
      'not a valid image',
    ],
    [
      { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) },
      '2 MB',
    ],
  ] as const) {
    await page.getByLabel('Image files').setInputFiles(file);
    await expect(page.getByRole('alert').filter({ hasText: error })).toBeVisible();
  }
  const file = await imageFixture(page);
  await page
    .getByLabel('Image files')
    .setInputFiles(Array.from({ length: 5 }, (_, n) => ({ ...file, name: `${n}.png` })));
  await expect(page.getByRole('alert').filter({ hasText: 'up to 4' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove .*\.png$/ })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page
    .getByRole('option', { name: /^Gemini/ })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Attach images' })).toHaveAttribute(
    'title',
    /Codex and Claude/,
  );
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
});

test('a delayed image read cannot attach to a newer conversation or send before it finishes', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const file = await imageFixture(page);
  await page.evaluate(() => {
    const decode = Image.prototype.decode;
    Image.prototype.decode = async function () {
      await decode.call(this);
      await new Promise<void>((resolve) => ((window as any).finishImageRead = resolve));
    };
  });
  await page.getByLabel('Message', { exact: true }).fill('Old draft');
  await page.getByLabel('Image files').setInputFiles(file);
  await expect(page.getByRole('status').filter({ hasText: 'Reading images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).finishImageRead))
    .toBe('function');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('New draft');
  await page.evaluate(() => (window as any).finishImageRead());
  await expect(page.getByRole('status').filter({ hasText: 'Reading images' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview diagram.png' })).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('New draft');
});

test('browser preview keeps per-chat choices without an agent library', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Browser preview ·')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Your agents' })).toHaveCount(0);
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet (latest)', exact: true }).click();
  await page.getByRole('combobox', { name: 'Reasoning', exact: true }).click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await page.getByLabel('Instructions', { exact: true }).fill('Use short sentences.');
  await page.getByRole('button', { name: 'Save instructions', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Claude');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning', exact: true })).toContainText(
    'High',
  );
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('Gemini automatically exposes its existing CLI login', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await expect(card.getByText('CLI setup', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('Gemini CLI login');
  await expect(card.getByRole('button', { name: 'Open sign-in', exact: true })).toBeVisible();
  await expect(card).not.toContainText('@google/gemini-cli');
});

test('external Google sign-in updates on focus and survives reload without a chat', async ({
  page,
}) => {
  await mockDesktop(page, 'login-flow');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await expect(card).toContainText('Sign in or refresh');
  await card.getByRole('button', { name: 'Open sign-in' }).click();
  await expect(card).toContainText('Sign in or refresh');
  await page.evaluate(() => {
    localStorage.setItem('test-google-login', 'ready');
    window.dispatchEvent(new Event('focus'));
  });
  await expect(card).not.toContainText('Sign in or refresh');
  await expect(page.locator('.notice[role="status"]')).toContainText('Gemini is connected');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(card).not.toContainText('Sign in or refresh');
  await page.evaluate(() => localStorage.removeItem('test-google-login'));
  await page.getByRole('button', { name: 'Refresh connections' }).click();
  await expect(card).toContainText('Sign in or refresh');
});

test('sign-in completion is polled while the external console remains open', async ({ page }) => {
  await mockDesktop(page, 'login-flow');
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const card = page
    .locator('.connection-card')
    .filter({ has: page.getByRole('heading', { name: 'Gemini' }) });
  await card.getByRole('button', { name: 'Open sign-in' }).click();
  await page.evaluate(() => localStorage.setItem('test-google-login', 'ready'));
  await expect(card).not.toContainText('Sign in or refresh', {
    timeout: 8000,
  });
  await expect(page.locator('.notice[role="status"]')).toContainText('Gemini is connected');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('native transport contract renders rich output, preserves history, and strips unsafe HTML', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page
    .getByLabel('Message', { exact: true })
    .fill('First line\nSecond line: quotes " & $(x)');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await expect(page.locator('.prose h2')).toHaveText('A clear answer');
  await expect(page.locator('.prose pre code')).toContainText('<div>Safe code</div>');
  await expect(page.locator('.prose table td')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await expect(page.locator('.prose script, .prose img, .prose [href^="javascript:"]')).toHaveCount(
    0,
  );
  await page.getByLabel('Message', { exact: true }).fill('Follow up');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect(request.messages[0].text).toContain('$(x)');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: /First line/ })
    .first()
    .click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
  await page.screenshot({ path: 'artifacts/chat-fixture.png', fullPage: true });
});

test('failures offer retry and stop keeps partial output', async ({ page }) => {
  await mockDesktop(page, 'slow');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByLabel('Message', { exact: true }).fill('Slow response');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.prose')).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('[data-status="cancelled"]')).toContainText('Hello world');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
});

test('login errors never masquerade as a completed answer', async ({ page }) => {
  await mockDesktop(page, 'error');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Gemini');
  await page.getByLabel('Message', { exact: true }).fill('Hello');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-status="error"]')).toContainText('login needs attention');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(2);
});

test('corrupted storage is preserved and editing is blocked', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('agent-studio.preview.v1', '{"version":999}'),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('No saved data has been overwritten');
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('agent-studio.preview.v1'))).toBe(
    '{"version":999}',
  );
});

test('compact chat shell keeps navigation and the editor accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.locator('.chat-layout')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Overview|Workflows)$/ })).toHaveCount(0);
  await expect(page.locator('.new-chat, .sidebar-bottom, .brand small')).toHaveCount(0);
  await expect(page.getByText('Personal workspace', { exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
  const connections = page.getByRole('button', { name: 'Connections', exact: true });
  await connections.click();
  await expect(page.locator('.page-title')).toHaveText('Connections');
  await expect(connections).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await expect(connections).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: 'artifacts/compact-shell-browser.png', fullPage: true });
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await expect(page.getByLabel('Instructions', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Save instructions', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close chat instructions' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('sidebar divider resizes with pointer and keyboard, remembers width, and keeps the chat usable', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const sidebar = page.locator('.sidebar');
  const divider = page.getByRole('separator', { name: 'Resize sidebar' });
  const width = () =>
    sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const dragTo = async (targetWidth: number) => {
    const bounds = (await divider.boundingBox())!;
    const before = await width();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 250);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + targetWidth - before, bounds.y + 250, {
      steps: 8,
    });
  };
  await expect.poll(width).toBe(236);
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft while resizing');
  await dragTo(350);
  await page.mouse.up();
  await expect.poll(width).toBe(350);
  await expect(divider).toHaveAttribute('aria-valuenow', '350');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep this draft while resizing',
  );
  await divider.press('ArrowLeft');
  await expect.poll(width).toBe(340);
  await dragTo(400);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(width).toBe(340);
  await page.reload();
  await expect.poll(width).toBe(340);
  await page.setViewportSize({ width: 880, height: 720 });
  await expect.poll(width).toBe(280);
  expect(
    await page.locator('.main-area').evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThanOrEqual(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/sidebar-resize-compact.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await expect.poll(width).toBe(340);
  await divider.press('Home');
  await expect.poll(width).toBe(180);
  await dragTo(80);
  await page.mouse.up();
  await expect.poll(width).toBe(180);
  await divider.press('End');
  await expect.poll(width).toBe(480);
  await page.screenshot({ path: 'artifacts/sidebar-resize-wide.png', animations: 'disabled' });
  await divider.dblclick();
  await expect.poll(width).toBe(236);
  await page.reload();
  await expect.poll(width).toBe(236);
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(divider).toBeHidden();
  await expect.poll(width).toBe(64);
});

async function pick(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function returnAfterUsageCacheExpires(page: Page) {
  await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 61_000));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test('subscription windows include resets and Fable is shown only for Fable', async ({ page }) => {
  await mockDesktop(page, 'usage-success');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Sonnet');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-5-hour')).toContainText('12%');
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  await expect(page.getByTestId('limit-weekly')).toContainText('Resets in');
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  await pick(page, 'Model', 'Fable');
  await expect(page.locator('.usage-strip').getByRole('progressbar')).toHaveCount(3);
  await expect(page.getByTestId('limit-fable-weekly')).toContainText('62%');
  await expect(page.getByTestId('limit-fable-weekly').getByRole('meter')).toHaveAttribute(
    'aria-valuenow',
    '62',
  );
  await page.screenshot({ path: 'artifacts/usage-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/usage-compact.png', fullPage: true });
  await pick(page, 'Model', 'Sonnet');
  await expect(page.getByTestId('limit-fable-weekly')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('quota pace explains ahead, below, and on-track budgets and withdraws guidance on failure', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-pace');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Fable');
  await page.locator('.context-chip').click();
  const short = page.getByTestId('limit-5-hour').getByTestId('quota-pace');
  const week = page.getByTestId('limit-weekly').getByTestId('quota-pace');
  const fable = page.getByTestId('limit-fable-weekly').getByTestId('quota-pace');
  await expect(short.getByRole('img', { name: 'Ahead of pace' })).toHaveAttribute(
    'title',
    /Ahead of pace/,
  );
  await expect(short.locator('.pace-indicator')).toHaveText('');
  await expect(short).toContainText('58%');
  await expect(short).toContainText('Budget: 12%/hour');
  await expect(short.locator('.pace-indicator')).toHaveClass(/tone-watch/);
  await expect(week.getByRole('img', { name: 'Below pace' })).toBeVisible();
  await expect(fable.getByRole('img', { name: 'On track' })).toBeVisible();
  const belowColor = await week
    .locator('.pace-indicator')
    .evaluate((node) => getComputedStyle(node).color);
  const steadyColor = await fable
    .locator('.pace-indicator')
    .evaluate((node) => getComputedStyle(node).color);
  expect(belowColor).not.toBe(steadyColor);
  await expect(page.getByTestId('limit-weekly').locator('.quota-fill')).toHaveCSS(
    'background-color',
    belowColor,
  );
  await expect(page.getByTestId('limit-fable-weekly').locator('.quota-fill')).toHaveCSS(
    'background-color',
    steadyColor,
  );
  for (const [label, current] of [
    ['5-hour', 70],
    ['weekly', 25],
    ['fable-weekly', 50],
  ] as const) {
    const card = page.getByTestId(`limit-${label}`);
    await expect(card).not.toContainText(/Recommended|Guide unavailable/);
    await expect(card.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      `${current}% used, recommended 50%`,
    );
    const bars = await card.locator('.usage-meter').evaluate((el) => {
      const actual = el.querySelector('.quota-fill')!.getBoundingClientRect();
      const recommended = el.querySelector('.recommended-fill')!.getBoundingClientRect();
      return {
        actual: actual.width / el.clientWidth,
        recommended: recommended.width / el.clientWidth,
        aligned: Math.abs(actual.left - recommended.left) < 1,
        sameTrack:
          Math.abs(actual.top - recommended.top) < 1 &&
          Math.abs(actual.bottom - recommended.bottom) < 1,
      };
    });
    expect(bars.actual).toBeCloseTo(current / 100, 2);
    expect(bars.recommended).toBeCloseTo(0.5, 2);
    expect(bars.aligned && bars.sameTrack).toBe(true);
    await expectVisibleQuotaComparison(card.getByRole('meter'), current > 50);
  }
  await expect(page.locator('.usage-strip .recommended-fill')).toHaveCount(2);
  await expect(page.locator('.usage-strip')).not.toContainText(/Recommended|Guide unavailable/);
  await expect(page.locator('.context-chip .recommended-fill')).toHaveCount(0);
  await expect(page.locator('.usage-extra, .usage-totals')).toHaveCount(0);
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/pace-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/pace-compact.png', fullPage: true });
  await page.evaluate(() => localStorage.setItem('test-usage-error', '1'));
  await returnAfterUsageCacheExpires(page);
  await expect(short.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(week.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(fable.getByRole('img', { name: 'Pace unavailable' })).toBeVisible();
  await expect(page.locator('.usage-strip .pace-indicator')).toHaveCount(0);
  await expect(page.locator('.recommended-fill')).toHaveCount(0);
  await expect(page.getByTestId('limit-5-hour')).toContainText('70%');
});

test('context growth indicators survive reload and stay independent of drafts', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-pace');
  await page.addInitScript(() => {
    if (localStorage.getItem('test-workspace')) return;
    const settings = { provider: 'claude', model: 'sonnet', reasoning: '', instructions: '' };
    const messages = [4000, 7000, 10000].flatMap((tokens) => [
      {
        id: crypto.randomUUID(),
        role: 'user',
        status: 'complete',
        createdAt: '',
        blocks: [{ type: 'markdown', text: 'Continue the garden plan.' }],
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: '',
        settings,
        blocks: [{ type: 'markdown', text: 'Here is the next step.' }],
        promptTokensEstimate: 100,
        usage: {
          input: tokens,
          contextInput: tokens,
          output: 10,
          contextWindow: 20000,
          model: 'claude-sonnet',
        },
      },
    ]);
    localStorage.setItem(
      'test-workspace',
      JSON.stringify({
        version: 2,
        preferences: {
          lastProvider: 'claude',
          modelByProvider: { claude: 'sonnet' },
          reasoningByProvider: {},
        },
        conversations: [
          {
            id: crypto.randomUUID(),
            settings,
            title: 'Growing context fixture',
            createdAt: '',
            updatedAt: '',
            messages,
          },
        ],
      }),
    );
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  const guidance = page.getByTestId('context-pace');
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Growing quickly/);
  await expect(page.locator('.context-card, .context-chip').getByRole('img')).toHaveCount(0);
  await expect(guidance).toContainText('~2 similar exchanges to 80%');
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(meter).toHaveAttribute('aria-valuenow', '50');
  await page.getByLabel('Message', { exact: true }).fill('a'.repeat(30000));
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Growing quickly/);
  await expect(meter).toHaveAttribute('aria-valuenow', '50');
  const saved = await page.evaluate(() => localStorage.getItem('test-workspace'));
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  await expect(guidance).toContainText('~2 similar exchanges to 80%');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!))).toEqual({
    ...JSON.parse(saved!),
    conversations: JSON.parse(saved!).conversations.map((c: object) => ({ ...c, archived: true })),
  });
  await expect(page.getByTestId('forecast-pace')).toHaveCount(0);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const replies = workspace.conversations[0].messages.filter(
      (message: { role: string }) => message.role === 'assistant',
    );
    replies.forEach(
      (message: { usage: { contextInput: number; input: number } }, index: number) => {
        message.usage.contextInput = 1000 + index * 100;
        message.usage.input = message.usage.contextInput;
      },
    );
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Growing context fixture', exact: true }).click();
  await page.locator('.context-chip').click();
  await expect(page.locator('.context-chip')).toHaveAttribute('title', /Room available/);
  await expect(page.getByTestId('context-growth')).toHaveCount(0);
  await expect(guidance).toHaveCount(0);
  await expect(meter).toHaveAttribute('aria-valuenow', '6');
  await pick(page, 'Model', 'Opus');
  await expect(guidance.locator('.pace-indicator')).toHaveCount(0);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('reported context stays exact while typing and survives reload', async ({ page }) => {
  await mockDesktop(page, 'usage-success');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(meter).toHaveCount(0);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await page.getByLabel('Message', { exact: true }).fill('Garden context check ' + 'a'.repeat(400));
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await expect(meter).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .cachedInput,
    ),
  ).toBe(1500);
  await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
    'title',
    '2,000 input tokens',
  );
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.locator('.context-chip')).toContainText('10%');
  await expect(page.locator('.context-chip')).not.toContainText('estimated');
  await expect(page.locator('.context-chip')).not.toContainText('reported');
  await expect(page.locator('.context-card .usage-card-heading')).toHaveText('Chat context');
  await page.getByLabel('Message', { exact: true }).fill('a'.repeat(4000));
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByTestId('context-estimate')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/context-reported-browser.png', fullPage: true });
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({ path: 'artifacts/context-reported-compact.png', fullPage: true });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: /Garden context check/ })
    .first()
    .click();
  await page.locator('.context-chip').click();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  await expect(page.getByTestId('reported-context').locator('strong')).toHaveAttribute(
    'title',
    '2,000 input tokens',
  );
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Fable', exact: true }).click();
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('a turn total never masquerades as measured context', async ({ page }) => {
  await mockDesktop(page, 'usage-unmeasured');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.locator('.context-chip').click();
  await page.getByLabel('Message', { exact: true }).fill('Unmeasured context check');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1).usage
          .input,
    ),
  ).toBe(2000);
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(page.getByRole('meter', { name: 'Reported context used', exact: true })).toHaveCount(
    0,
  );
});

test('a pending reply keeps the previous reading and a completed reply without context clears it', async ({
  page,
}) => {
  await mockDesktop(page, 'usage-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  await page.getByLabel('Message', { exact: true }).fill('First request');
  await page.getByRole('button', { name: 'Send message' }).click();
  const meter = page.getByRole('meter', { name: 'Reported context used', exact: true });
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Second request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuenow', '10');
  await expect(page.getByTestId('reported-context')).toContainText('Updating…');
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.getByTestId('reported-context')).toContainText('Not measured yet');
  await expect(meter).toHaveCount(0);
});

test('missing and failed quota readings never show fabricated zero usage', async ({ page }) => {
  await mockDesktop(page, 'usage-missing');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-5-hour')).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: '5-hour limit used' })).toHaveCount(0);
  await expect(page.locator('.usage-strip .usage-chip')).toHaveCount(2);
  await expect(page.getByTestId('limit-weekly')).toContainText('26%');
  await page.evaluate(() => localStorage.setItem('test-usage-error', '1'));
  await returnAfterUsageCacheExpires(page);
  await expect(page.locator('.usage-error')).toContainText('Keeping the last reported values');
  await expect(page.getByTestId('limit-weekly')).toContainText('26%');
  await expect(page.getByTestId('limit-weekly')).toContainText('Last reported');
  await expect(page.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute(
    'aria-valuenow',
    '26',
  );
  await expect(page.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute(
    'aria-valuetext',
    /last reported/,
  );
});

test('a late usage result cannot replace the selected providers reading', async ({ page }) => {
  await mockDesktop(page, 'usage-race');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Agent', 'Claude');
  await page.locator('.context-chip').click();
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  await page.evaluate(() => (window as any).resolveUsage());
  await expect(page.getByTestId('limit-weekly')).toContainText('31%');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toContainText('Claude');
});

test('composer shows three usage bars below the input and keeps tool access in the Agent hover', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const strip = page.locator('.composer-area .usage-strip');
  await expect(strip.getByRole('progressbar')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Refresh usage', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Usage and context', exact: true })).toHaveCount(0);
  await expect(strip.getByRole('button')).toHaveCount(3);
  await expect(page.locator('.composer-caption')).toHaveCount(0);
  expect(
    await strip.evaluate(
      (el) =>
        el.getBoundingClientRect().top >=
        document.querySelector('.composer')!.getBoundingClientRect().bottom,
    ),
  ).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveAttribute(
    'title',
    /Full access/,
  );
  for (const provider of ['Claude', 'Gemini', 'Codex']) {
    await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: provider, exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveAttribute(
      'title',
      provider === 'Gemini' ? /cannot use tools/ : /Full access/,
    );
    await expect(strip.getByRole('progressbar')).toHaveCount(3);
  }
  await expect(strip.getByRole('progressbar', { name: 'Context used' })).not.toHaveAttribute(
    'aria-valuenow',
  );
  await expect(strip.getByRole('progressbar', { name: '5-hour limit used' })).toHaveAttribute(
    'aria-valuenow',
    '12',
  );
  await page.screenshot({ path: 'artifacts/composer-usage-bars-browser.png' });
  await page.locator('.context-chip').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.usage-details')).toBeVisible();
  const headerCenters = await page.locator('.usage-details-heading > *').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    }),
  );
  expect(Math.max(...headerCenters) - Math.min(...headerCenters)).toBeLessThan(1);
  expect(
    await page
      .locator('.usage-details')
      .evaluate(
        (el) =>
          el.getBoundingClientRect().bottom <=
          document.querySelector('.usage-strip')!.getBoundingClientRect().top,
      ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.usage-details')).toHaveCount(0);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(await strip.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/composer-usage-bars-narrow-browser.png' });
  await page.locator('.context-chip').click();
  await page.screenshot({ path: 'artifacts/composer-usage-expanded-narrow-browser.png' });
  await page.getByRole('button', { name: 'Close usage details', exact: true }).click();
  await expect(page.locator('.usage-details')).toHaveCount(0);
});

test('models and reasoning are remembered independently and each chat retains its settings', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await pick(page, 'Model', 'Sonnet');
  await pick(page, 'Reasoning', 'High');
  await pick(page, 'Model', 'Opus');
  await pick(page, 'Reasoning', 'Max');
  await pick(page, 'Model', 'Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Model', 'GPT-6 Astra');
  await pick(page, 'Reasoning', 'Low');
  await page.getByLabel('Message', { exact: true }).fill('First configured chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', reasoning: 'low' });
  const firstRequest = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request')!),
  );
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    firstRequest.location.path,
  );
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await pick(page, 'Reasoning', 'High');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await page.getByLabel('Message', { exact: true }).fill('Continue with a different model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.agent).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    connectionId: firstRequest.agent.connectionId,
  });
  expect(request.location).toEqual(firstRequest.location);
  expect(request.messages).toHaveLength(3);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeEnabled();
  await pick(page, 'Agent', 'Claude');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Sonnet');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await pick(page, 'Model', 'Opus');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('Max');
  await page.getByLabel('Message', { exact: true }).fill('Second configured chat');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Opus');
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('Max');
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'First configured chat', exact: true }).click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(
    'GPT-5.6 Sol',
  );
  await expect(page.getByRole('combobox', { name: 'Reasoning' })).toContainText('High');
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
      (c: any) => c.title === 'First configured chat',
    ),
  );
  expect(saved.messages[1].settings).toMatchObject({
    provider: 'codex',
    model: 'gpt-6-astra',
    reasoning: 'low',
  });
  expect(saved.messages[3].settings).toMatchObject({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning: 'high',
  });
});

test('unsupported reasoning levels are absent and only location and agent stay locked during a reply', async ({
  page,
}) => {
  await mockDesktop(page, 'slow');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Gemini');
  await pick(page, 'Model', 'Gemini 3.1 Pro');
  await page.getByRole('combobox', { name: 'Reasoning' }).click();
  await expect(page.getByRole('option')).toHaveText(['Default', 'Low', 'High']);
  await page.keyboard.press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('A slow reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  for (const name of ['Model', 'Reasoning'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeEnabled();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
});

test('model and reasoning changes during streaming apply only to the next reply and survive reload', async ({
  page,
}) => {
  await mockDesktop(page, 'settings-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Model', 'GPT-6 Astra');
  await pick(page, 'Reasoning', 'Low');
  await page.getByLabel('Message', { exact: true }).fill('Keep each reply model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await expect(page.locator('.message-heading strong')).toHaveText(['You', 'GPT-6 Astra']);
  await expect(page.locator('.message-execution')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Chat instructions', exact: true })).toBeDisabled();
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await pick(page, 'Reasoning', 'High');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    'Next message: GPT-5.6 Sol · High reasoning',
  );
  await expect(page.locator('.message-heading strong')).toHaveText(['You', 'GPT-6 Astra']);
  await expect(page.locator('.reply-switch')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ model: 'gpt-6-astra', reasoning: 'low' });
  await page.screenshot({ path: 'artifacts/next-reply-pending-browser.png' });
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Use the new model');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.reply-switch')).toHaveText(
    'Switched to GPT-5.6 Sol · High reasoning',
  );
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
  ]);
  await expect(page.getByTestId('message').last().locator('.prose')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!).agent),
  ).toMatchObject({ model: 'gpt-5.6-sol', reasoning: 'high' });
  await pick(page, 'Reasoning', 'Low');
  await expect(page.locator('.next-reply-settings')).toHaveText(
    'Next message: GPT-5.6 Sol · Low reasoning',
  );
  await expect(page.locator('.reply-switch')).toHaveText(
    'Switched to GPT-5.6 Sol · High reasoning',
  );
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('Use the new reasoning');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.reply-switch')).toHaveText([
    'Switched to GPT-5.6 Sol · High reasoning',
    'Switched to Low reasoning',
  ]);
  await page.evaluate(() => (window as any).finishReply());
  await expect(page.locator('[data-testid="message"][data-status="running"]')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Keep each reply model', exact: true }).click();
  await expect(page.locator('.message-heading strong')).toHaveText([
    'You',
    'GPT-6 Astra',
    'You',
    'GPT-5.6 Sol',
    'You',
    'GPT-5.6 Sol',
  ]);
  await expect(page.locator('.reply-switch')).toHaveText([
    'Switched to GPT-5.6 Sol · High reasoning',
    'Switched to Low reasoning',
  ]);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.filter(
      (m: any) => m.role === 'assistant',
    ),
  );
  expect(saved.map((m: any) => [m.settings.model, m.settings.reasoning])).toEqual([
    ['gpt-6-astra', 'low'],
    ['gpt-5.6-sol', 'high'],
    ['gpt-5.6-sol', 'low'],
  ]);
  await page.screenshot({ path: 'artifacts/model-switches-browser.png' });
});

test('a background title is generated once, persists, and preserves chat choices', async ({
  page,
}) => {
  await mockDesktop(page, 'title-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await pick(page, 'Model', 'GPT-6 Astra');
  await pick(page, 'Reasoning', 'High');
  await page
    .getByLabel('Message', { exact: true })
    .fill('Help me plan a small garden on my balcony');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(before.conversations[0].titleStatus).toBe('pending');
  await page.evaluate(() => (window as any).resolveTitle());
  await expect(
    page.getByRole('button', { name: 'Planning a balcony garden', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Which herbs should I grow?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Planning a balcony garden', exact: true }).click();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(4);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(after.preferences).toEqual(before.preferences);
  expect(after.conversations[0].settings).toEqual(before.conversations[0].settings);
  expect(after.conversations[0]).toMatchObject({
    titleStatus: 'generated',
    titleSource: { provider: 'codex', model: 'gpt-5.6-luna' },
  });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-title-requests')!)),
  ).toHaveLength(1);
});

test('title failure keeps the first-message title without affecting replies or retrying', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Claude');
  await page.getByLabel('Message', { exact: true }).fill('Planning a small garden');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Planning a small garden', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Planning a small garden', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Continue');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(4);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].titleStatus).toBe('fallback');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-title-requests')!)),
  ).toHaveLength(1);
});

test('a late title follows its original chat and cannot restore a deleted conversation', async ({
  page,
}) => {
  await mockDesktop(page, 'title-deferred');
  await page.goto('/');
  await chooseTestFolder(page);
  await pick(page, 'Agent', 'Codex');
  await page.getByLabel('Message', { exact: true }).fill('A balcony garden question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.evaluate(() => (window as any).resolveTitle());
  await expect(
    page.getByRole('button', { name: 'Planning a balcony garden', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-testid="message"]')).toHaveCount(0);
  await page.getByLabel('Message', { exact: true }).fill('A second garden question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('[data-testid="message"][data-status="complete"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete conversation', exact: true })
    .click();
  await page.evaluate(() => (window as any).resolveTitle());
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations.length),
    )
    .toBe(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].title).toBe('Planning a balcony garden');
  expect(await page.evaluate(() => localStorage.getItem('test-cancelled-title'))).toBeTruthy();
});

test('opening the app archives saved chats and sending from History restores the same conversation', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const message = page.getByLabel('Message', { exact: true });
  const activeTab = page.getByRole('tab', { name: /^Active/ });
  const historyTab = page.getByRole('tab', { name: /^History/ });
  for (const title of ['Resume this conversation', 'Keep this older conversation']) {
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await message.fill(title);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  }
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const source = workspace.conversations[0];
    workspace.conversations.push({
      ...source,
      id: crypto.randomUUID(),
      title: 'General conversation without a folder',
      archived: false,
      location: { ...source.location, path: '' },
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  const original = before.find((c: any) => c.title === 'Resume this conversation');
  await page.reload();
  await expect(activeTab).toHaveText('Active0');
  await expect(historyTab).toHaveText('History3');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
    )
    .toEqual(before.map((c: object) => ({ ...c, archived: true })));
  await historyTab.click();
  await page.getByRole('button', { name: original.title, exact: true }).click();
  await expect(message).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Restore to continue' })).toHaveCount(0);
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await message.fill('   ');
  await message.press('Enter');
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab).toHaveText('Active0');
  await pick(page, 'Model', 'GPT-5.6 Sol');
  await message.fill('Continue with this new prompt');
  const archivedDraft = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(archivedDraft.every((c: any) => c.archived)).toBe(true);
  expect(archivedDraft.find((c: any) => c.id === original.id).messages).toEqual(original.messages);
  await page.screenshot({ path: 'artifacts/history-ready-to-send.png', animations: 'disabled' });
  await message.press('Enter');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab).toHaveText('Active1');
  await expect(historyTab).toHaveText('History2');
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const after = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(after).toHaveLength(before.length);
  const resumed = after.find((c: any) => c.id === original.id);
  expect(resumed.archived).toBe(false);
  expect(resumed.location).toEqual(original.location);
  expect(resumed.messages.slice(0, original.messages.length)).toEqual(original.messages);
  expect(resumed.messages).toHaveLength(original.messages.length + 2);
  expect(resumed.settings.model).toBe('gpt-5.6-sol');
  expect(after.filter((c: any) => c.id !== original.id).every((c: any) => c.archived)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Refresh model list', exact: true }).click();
  await expect(activeTab).toHaveText('Active1');
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({
    path: 'artifacts/history-auto-restored-compact.png',
    animations: 'disabled',
  });
  await page.reload();
  await expect(activeTab).toHaveText('Active0');
  await expect(historyTab).toHaveText('History3');
});

test('computer and No folder plus buttons start fresh scoped drafts from collapsed history groups', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Keep this project conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const source = workspace.conversations[0];
    workspace.conversations.push({
      ...source,
      id: crypto.randomUUID(),
      title: 'Old general conversation',
      archived: true,
      location: { ...source.location, path: '' },
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: /^History/ })).toHaveText('History2');
  const original = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  const active = page.locator('#conversation-panel-active');
  const history = page.locator('#conversation-panel-history');
  const historyTab = page.getByRole('tab', { name: /^History/ });
  await historyTab.click();
  await history.getByRole('button', { name: 'Old general conversation', exact: true }).click();
  await history.locator('.computer-group-toggle').click();
  await history
    .getByRole('button', { name: 'New conversation on Desktop', exact: true })
    .press('Enter');
  await expect(page.getByRole('tab', { name: /^Active/ })).toHaveAttribute('aria-selected', 'true');
  await expect(picker('Computer')).toHaveText('Desktop');
  await expect(picker('Folder')).toHaveText('Browse folders…');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.getByTestId('message')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await page.getByLabel('Message', { exact: true }).fill('Discard this draft for the next action');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await historyTab.click();
  await history.locator('.computer-group-toggle').click();
  await history.getByRole('button', { name: 'No folder', exact: true }).click();
  await history
    .getByRole('button', { name: 'New conversation in No folder on Desktop', exact: true })
    .click();
  await expect(picker('Folder')).toHaveText('No folder');
  await expect(picker('Agent')).toBeEnabled();
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expect(page.getByTestId('message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Model context' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).contextCalls.at(-1).location)).toBeNull();
  await page.getByRole('button', { name: 'Close model context' }).click();
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('A new general conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.location).toBeUndefined();
  expect(request.agent.provider).toBe('claude');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  expect(saved.conversations[0].location).toEqual({ ...original[0].location, path: '' });
  expect(
    saved.fleet.connections.find((c: any) => c.id === request.agent.connectionId).environmentId,
  ).toBe(original[0].location.environmentId);
  expect(saved.conversations.slice(1)).toEqual(original);
  expect(saved.conversations[0].archived).not.toBe(true);
  await expect(active.locator('.folder-new-chat')).toHaveCount(1);
  const computerLeft = (await active.locator('.computer-group-row').boundingBox())!.x;
  for (const folder of await active.locator('.folder-group-row').all())
    expect((await folder.boundingBox())!.x).toBe(computerLeft + 16);
  await page.screenshot({ path: 'artifacts/sidebar-plus-wide.png', animations: 'disabled' });
  await page.setViewportSize({ width: 880, height: 720 });
  await expect(
    active.getByRole('button', { name: 'New conversation on Desktop', exact: true }),
  ).toBeVisible();
  await expect(
    active.getByRole('button', { name: 'New conversation in No folder on Desktop', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/sidebar-plus-compact.png', animations: 'disabled' });
});

test('computer then folder scopes CLI choices and groups active and history without losing messages', async ({
  page,
}) => {
  await mockDesktop(page, 'locations');
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toBeDisabled();
  await page.getByLabel('Message', { exact: true }).fill('Windows folder conversation');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0],
  );
  expect(before.location.path).toBe('C:\\Projects\\studio');
  await expect(page.locator('.topbar')).toHaveText(before.title);
  await expect(
    page.locator('.execution-toolbar, .location-path, .breadcrumb, .topbar-right'),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    before.location.path,
  );
  await expect(page.locator('.chat-toolbar')).not.toContainText(before.location.path);
  const active = page.locator('#conversation-panel-active');
  const history = page.locator('#conversation-panel-history');
  const activeTab = page.getByRole('tab', { name: /^Active/ });
  const historyTab = page.getByRole('tab', { name: /^History/ });
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(history).toBeHidden();
  await activeTab.press('End');
  await expect(historyTab).toBeFocused();
  await expect(history).toBeVisible();
  await expect(history).toContainText('No conversations in history.');
  await historyTab.press('ArrowLeft');
  await expect(activeTab).toBeFocused();
  await expect(active).toBeVisible();
  await expect(active.locator('.conversation-item')).toHaveAttribute('aria-current', 'page');
  await expect(active.locator('.conversation-computer')).toContainText('Desktop');
  await expect(active.locator('.folder-group-toggle')).toHaveText('studio');
  await active.locator('.folder-group-toggle').click();
  await expect(active.locator('.conversation-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await expect(historyTab).toHaveAttribute('aria-selected', 'true');
  await expect(history).toBeVisible();
  await expect(history.locator('.conversation-item')).toHaveCount(1);
  await expect(active.locator('.conversation-item')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.reload();
  await historyTab.click();
  await history.locator('.conversation-item').click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('button', { name: 'Restore conversation', exact: true }).click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(active).toBeVisible();
  await expect(active.locator('.conversation-item')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages,
    ),
  ).toEqual(before.messages);
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Folder environment', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await expect(page.getByLabel('Folder path', { exact: true })).toHaveValue('/home/test/studio');
  await page.getByLabel('Folder path', { exact: true }).fill('/missing');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Folder does not exist');
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Gemini', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).press('Escape');
  await expect(
    page.getByRole('combobox', { name: 'Account and environment', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await expect(page.getByRole('listbox')).not.toContainText('/home/test/studio');
  await expect(
    page.getByRole('option', { name: 'studio', exact: true }).filter({ hasText: 'WSL · Ubuntu' }),
  ).toHaveAttribute('title', '/home/test/studio');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('Linux folder conversation');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.location.environmentId).toBe('33333333-3333-4333-8333-333333333333');
  expect(request.agent.provider).toBe('codex');
  await expect(active.locator('.conversation-computer')).toHaveCount(2);
  await expect(active.locator('.conversation-folder')).toHaveCount(2);
  await page.getByRole('button', { name: 'Move to history', exact: true }).click();
  await page.screenshot({ path: 'artifacts/folder-groups-browser.png', animations: 'disabled' });
  const controlRows = () =>
    page
      .locator('.chat-configuration [role="combobox"]')
      .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().top));
  expect(new Set(await controlRows()).size).toBe(1);
  await page.setViewportSize({ width: 880, height: 720 });
  expect(new Set(await controlRows()).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/folder-groups-compact.png', animations: 'disabled' });
  await page.getByLabel('Search conversations').fill('C:\\Projects');
  await expect(activeTab).toHaveText('Active1');
  await expect(historyTab).toHaveText('History0');
  await expect(history).toContainText('No matches in history.');
  await activeTab.click();
  await expect(active.locator('.conversation-item')).toHaveCount(1);
  await expect(history.locator('.conversation-item')).toHaveCount(0);
  const originalConversations = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  await active
    .getByRole('button', { name: 'New conversation in studio on Desktop', exact: true })
    .press('Enter');
  await expect(page.locator('.page-title')).toHaveText('New conversation');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    'C:\\Projects\\studio',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await historyTab.click();
  await history.locator('.folder-group-toggle').click();
  await history
    .getByRole('button', { name: 'New conversation in studio on WSL · Ubuntu', exact: true })
    .click();
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await expect(page.getByTestId('message')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!).conversations),
  ).toEqual(originalConversations);
  await page
    .getByLabel('Message', { exact: true })
    .fill('A new conversation from the archived Linux folder');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const folderRequest = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('test-last-request')!),
  );
  expect(folderRequest.location).toEqual(request.location);
  expect(folderRequest.agent.provider).toBe('codex');
  const after = await page.evaluate(
    () => JSON.parse(localStorage.getItem('test-workspace')!).conversations,
  );
  expect(
    after.filter((c: { id: string }) =>
      originalConversations.some((original: { id: string }) => original.id === c.id),
    ),
  ).toEqual(originalConversations);
  expect(after[0].archived).not.toBe(true);
});

test('reselecting the computer preserves the draft and folders reuse ready CLI and model choices', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await picker('Reasoning').click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft and its settings');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  const calls = await page.evaluate(() => (window as any).cliCalls);
  await page.evaluate(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await picker('Computer').click();
  await page.getByRole('option', { name: 'Desktop', exact: true }).click();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(picker('Model')).toHaveText('GPT-6 Astra');
  await expect(picker('Reasoning')).toHaveText('High');
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(
    'Keep this draft and its settings',
  );
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await picker('Folder').click();
  await page.getByRole('option', { name: 'studio', exact: true }).click();
  expect(await page.evaluate(() => (window as any).cliCalls)).toEqual(calls);
  await picker('Folder').click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await page.getByLabel('Folder path', { exact: true }).fill('C:\\Projects\\second');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\second');
  await expect(picker('Agent')).toBeEnabled();
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-5.6 Sol', exact: true }).click();
  await expect(picker('Reasoning')).toHaveText('Low');
  expect(
    await page.evaluate(() =>
      (window as any).cliCalls.filter((c: any) => c.command !== 'list_folders'),
    ),
  ).toEqual(calls.filter((c: any) => c.command !== 'list_folders'));
  // An explicit catalog refresh also keeps the cached options usable while its reply is pending.
  await page.getByRole('button', { name: 'Refresh model list', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).pendingCli?.length ?? 0)).toBe(1);
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli) request.resolve();
  });
  await expect(picker('Model')).toHaveText('GPT-6 Astra');
  await expect(picker('Reasoning')).toHaveText('High');
});

test('cold CLI checks and model requests do not block folder selection or overwrite user choices', async ({
  page,
}) => {
  await mockDesktop(page);
  // Discovery now starts at launch, so hold requests before the first navigation.
  await page.addInitScript(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli
          ?.filter((r: any) => r.command === 'detect_connection')
          .map((r: any) => r.provider)
          .sort(),
      ),
    )
    .toEqual(['claude', 'codex', 'gemini']);
  await expect(picker('Model')).toBeEnabled();
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await picker('Model').click();
  await page.getByRole('option', { name: 'Sonnet (latest)', exact: true }).click();
  await picker('Reasoning').click();
  await page.getByRole('option', { name: 'High', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Wait for availability before sending');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli?.some(
          (r: any) => r.command === 'list_models' && r.provider === 'claude',
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli) request.resolve();
  });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(picker('Agent')).toHaveText('Claude');
  await expect(picker('Model')).toHaveText('Sonnet');
  await expect(picker('Reasoning')).toHaveText('High');
  await picker('Model').click();
  await expect(page.getByRole('option', { name: 'GPT-6 Astra', exact: true })).toHaveCount(0);
  await picker('Model').press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('a pending environment uses its own model catalog and late checks cannot change a newer folder', async ({
  page,
}) => {
  await mockDesktop(page, 'locations');
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  const picker = (name: string) => page.getByRole('combobox', { name, exact: true });
  await picker('Model').click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await page.evaluate(() => {
    (window as any).holdCli = ['detect_connection', 'list_models'];
  });
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await picker('Folder').click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(picker('Folder environment')).toHaveText('WSL · Ubuntu');
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(picker('Folder')).toHaveAttribute('title', '/home/test/studio');
  await picker('Model').click();
  // The saved model remains available, but another connection's catalog is never reused.
  await expect(page.getByRole('option', { name: 'gpt-6-astra', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'GPT-5.6 Sol', exact: true })).toHaveCount(0);
  await picker('Model').press('Escape');
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await picker('Model').click();
  await page.getByRole('option', { name: 'Sonnet (latest)', exact: true }).click();
  // Ubuntu's installed Codex was already detected at startup; Claude is still unchecked.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli
          ?.filter((r: any) => r.command === 'detect_connection')
          .map((r: any) => r.provider),
      ),
    )
    .toEqual(['claude']);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).pendingCli
          ?.filter((r: any) => r.command === 'list_models')
          .map((r: any) => r.provider)
          .sort(),
      ),
    )
    .toEqual(['claude', 'codex']);
  await page.evaluate(() => {
    const state = window as any;
    for (const request of state.pendingCli.filter((r: any) => r.command === 'detect_connection'))
      request.resolve();
  });
  await expect(page.locator('.setup-hint')).toContainText('Claude needs to be set up.');
  await expect(picker('Agent')).toHaveText('Claude');
  await page.getByLabel('Message', { exact: true }).fill('Keep my explicit choice');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await pick(page, 'Computer', 'Desktop');
  await picker('Folder').click();
  await page
    .getByRole('option', { name: 'studio', exact: true })
    .filter({ hasText: 'Windows' })
    .click();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await picker('Agent').click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await expect(picker('Model')).toHaveText('GPT-6 Astra');
  await page.evaluate(() => {
    for (const request of (window as any).pendingCli) request.resolve();
  });
  await expect(page.getByRole('button', { name: 'Refresh model list', exact: true })).toBeEnabled();
  await expect(picker('Folder')).toHaveAttribute('title', 'C:\\Projects\\studio');
  await expect(picker('Agent')).toHaveText('Codex');
  await expect(picker('Model')).toHaveText('GPT-6 Astra');
});

test('Desktop uses its own Claude in a WSL folder and preserves that execution choice in history', async ({
  page,
}) => {
  await mockDesktop(page, 'computer-routing');
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await pick(page, 'Folder environment', 'WSL · Ubuntu');
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await pick(page, 'Agent', 'Claude');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Claude');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page
    .getByLabel('Message', { exact: true })
    .fill('Use my Windows Claude in this WSL project');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(page.locator('.setup-hint')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const request = await page.evaluate(() => JSON.parse(localStorage.getItem('test-last-request')!));
  expect(request.agent.provider).toBe('claude');
  expect(request.location).toMatchObject({
    environmentId: '33333333-3333-4333-8333-333333333333',
    executionEnvironmentId: '11111111-1111-4111-8111-111111111111',
    path: '/home/test/studio',
  });
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  const connection = saved.fleet.connections.find(
    (c: any) => c.id === saved.conversations[0].settings.connectionId,
  );
  expect(connection.environmentId).toBe('11111111-1111-4111-8111-111111111111');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: 'Use my Windows Claude in this WSL project', exact: true })
    .click();
  for (const name of ['Computer', 'Folder', 'Agent'])
    await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled();
  await page
    .getByRole('button', { name: 'New conversation in studio on Desktop', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Claude');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByLabel('Message', { exact: true }).fill('Another WSL draft');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(page.locator('.setup-hint')).toHaveCount(0);
});

test('WSL uses only its Linux CLI and keeps Desktop accounts out of the agent picker', async ({
  page,
}) => {
  await mockDesktop(page, 'computer-routing');
  await page.goto('/');
  await pick(page, 'Computer', 'WSL · Ubuntu');
  await chooseTestFolder(page);
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'WSL · Ubuntu',
  );
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Codex');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Claude', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).press('Escape');
  await page.getByLabel('Message', { exact: true }).fill('Use the Linux agent');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('test-workspace')!));
  const chat = saved.conversations[0];
  expect(
    saved.fleet.connections.find((c: any) => c.id === chat.settings.connectionId).environmentId,
  ).toBe('33333333-3333-4333-8333-333333333333');
  expect(chat.location.executionEnvironmentId).toBeUndefined();
  await page.getByLabel('Search conversations').fill('WSL · Ubuntu');
  await expect(page.locator('.conversation-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page
    .getByRole('article', { name: 'Desktop computer', exact: true })
    .getByRole('article', { name: 'Claude connections', exact: true })
    .getByRole('button', { name: 'Chat', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText('Desktop');
  await expect(page.getByRole('combobox', { name: 'Agent', exact: true })).toHaveText('Claude');
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Browse folders…',
  );
});

test('switching computer clears the folder and an offline host never falls back to local CLIs', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await chooseTestFolder(page);
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    workspace.fleet.computers.push({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Travel laptop',
    });
    workspace.fleet.environments.push({
      id: '55555555-5555-4555-8555-555555555555',
      computerId: '44444444-4444-4444-8444-444444444444',
      name: 'Linux',
      platform: 'linux',
    });
    const accountId = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    workspace.fleet.accounts.push({
      id: accountId,
      name: 'Travel Codex',
      provider: 'codex',
      purpose: 'personal',
    });
    workspace.fleet.connections.push({
      id: connectionId,
      accountId,
      environmentId: '55555555-5555-4555-8555-555555555555',
      profile: 'existing',
    });
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Offline project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      location: {
        computerId: '44444444-4444-4444-8444-444444444444',
        environmentId: '55555555-5555-4555-8555-555555555555',
        path: '/home/test/studio',
      },
      settings: { provider: 'codex', connectionId, model: '', reasoning: '', instructions: '' },
      messages: [],
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Offline project', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Keep this offline draft in history');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('test-workspace')!).conversations.find(
          (c: any) => c.title === 'Offline project',
        ).archived,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: 'Travel laptop', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveText(
    'Browse folders…',
  );
  await page.getByLabel('Message', { exact: true }).fill('Do not run locally');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'Browse folders…', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('relay');
  await expect(page.getByRole('button', { name: 'Use this folder', exact: true })).toBeDisabled();
  await page.getByRole('dialog').press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
  await page.getByRole('combobox', { name: 'Computer', exact: true }).click();
  await page.getByRole('option', { name: 'Desktop', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).click();
  await page.getByRole('option', { name: 'studio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page
    .getByRole('button', { name: 'New conversation in studio on Travel laptop', exact: true })
    .click();
  await expect(page.getByRole('combobox', { name: 'Computer', exact: true })).toHaveText(
    'Travel laptop',
  );
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveAttribute(
    'title',
    '/home/test/studio',
  );
  await page.getByLabel('Message', { exact: true }).fill('Keep this draft on the offline laptop');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('test-last-request'))).toBeNull();
});

test('skills, web searches, and child agents keep progress, results, and saved history', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Inspect this fixture');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  const tool = (id: string, category: string, name: string, extra = {}) => ({
    kind: 'tool',
    tool: { id, category, name, revision: 1, status: 'running', sources: [], agents: [], ...extra },
  });
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit(tool('skill', 'skill', 'Skill: capability-check'));
  await emit(tool('web1', 'search', 'Web search', { query: 'IANA example domains' }));
  await emit(tool('web2', 'search', 'Web search', { query: 'IANA example domains' }));
  await emit(
    tool('agents', 'agent', 'Sub-agents', {
      agents: [
        { id: 'child1', name: 'Fixture reader', task: 'Read the marker', status: 'running' },
        { id: 'child2', name: 'Source checker', task: 'Check the source', status: 'running' },
      ],
    }),
  );
  await emit(tool('read', 'tool', 'Read', { parentId: 'child1' }));
  await expect(page.locator('[data-category="search"]')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Sub-agent: Fixture reader' })).toContainText(
    'Read',
  );
  await page.screenshot({ path: 'artifacts/capabilities-running-browser.png' });
  await emit(
    tool('skill', 'skill', 'Skill: capability-check', { revision: 2, status: 'complete' }),
  );
  await emit(
    tool('web1', 'search', 'Web search', {
      revision: 3,
      status: 'complete',
      query: 'IANA example domains',
      sources: [
        { title: 'IANA example domains', url: 'https://www.iana.org/domains/example' },
        { title: 'Unsafe', url: 'javascript:alert(1)' },
      ],
    }),
  );
  await emit(tool('web1', 'search', 'Web search', { revision: 2 }));
  await emit(
    tool('web2', 'search', 'Web search', {
      revision: 2,
      status: 'error',
      query: 'IANA example domains',
      detail: 'Search unavailable',
    }),
  );
  await emit(
    tool('agents', 'agent', 'Sub-agents', {
      revision: 2,
      status: 'error',
      agents: [
        {
          id: 'child1',
          name: 'Fixture reader',
          status: 'complete',
          result: 'Marker verified <script>window.pwned=true</script>',
        },
        { id: 'child2', name: 'Source checker', status: 'error', result: 'Source unavailable' },
      ],
    }),
  );
  await emit(tool('read', 'tool', 'Read', { parentId: 'child1', revision: 2, status: 'complete' }));
  await emit({ kind: 'text', text: 'The fixture was checked.' });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await page.getByLabel('Activity summary', { exact: true }).click();
  const searches = page.locator('[data-category="search"]');
  await expect(searches.first()).toContainText('Completed');
  await searches.first().locator(':scope > summary').click();
  await expect(searches.first().getByRole('link', { name: 'IANA example domains' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
  await page
    .getByRole('region', { name: 'Sub-agent: Fixture reader' })
    .locator('.agent-result > summary')
    .click();
  await expect(page.getByRole('region', { name: 'Sub-agent: Fixture reader' })).toContainText(
    'Marker verified <script>',
  );
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  await page.screenshot({ path: 'artifacts/capabilities-complete-browser.png' });
  await page.setViewportSize({ width: 880, height: 720 });
  expect(
    await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/capabilities-narrow-browser.png' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('test-workspace')!).conversations[0].messages.at(-1)
            .status,
      ),
    )
    .toBe('complete');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await page.getByLabel('Activity summary', { exact: true }).click();
  await expect(page.locator('[data-category="search"]')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Sub-agent: Source checker' })).toContainText(
    'Failed',
  );
});

test('tool targets stream inline and finish as an expandable filtered summary', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check the source files');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  const emit = (event: unknown) => page.evaluate((e) => (window as any).emitCapability(e), event);
  await emit({
    kind: 'progress',
    id: 'before',
    revision: 1,
    text: 'I will inspect the source files.',
  });
  const tools = [
    {
      id: 'read',
      name: 'Read',
      operation: 'read',
      path: '/fixture/src/app.ts',
      facts: [
        { label: 'Start line', value: '12' },
        { label: 'Lines read', value: '8' },
      ],
    },
    {
      id: 'glob',
      name: 'Find files',
      operation: 'glob',
      query: '**/*.svelte',
      path: '/fixture/src',
      facts: [
        { label: 'Files found', value: '2' },
        { label: 'Matching files', value: '/fixture/src/App.svelte\n/fixture/src/Menu.svelte' },
      ],
    },
    {
      id: 'find',
      name: 'Find tools',
      operation: 'toolSearch',
      query: 'select:WebSearch',
      facts: [{ label: 'Tools found', value: 'WebSearch' }],
    },
    {
      id: 'run',
      name: 'Run command',
      operation: 'command',
      commandRun: true,
      detail: 'Run the fixture tests',
      facts: [{ label: 'Exit code', value: '0' }],
    },
    { id: 'legacy', name: 'Legacy tool' },
  ];
  for (const [i, tool] of tools.entries()) {
    await emit({
      kind: 'tool',
      tool: { category: 'tool', revision: 1, status: 'running', sources: [], agents: [], ...tool },
    });
    if (i === 0)
      await emit({
        kind: 'progress',
        id: 'middle',
        revision: 1,
        text: 'The file is readable. I will find the components next.',
      });
  }
  await expect(page.locator('.activity-summary')).toHaveCount(0);
  await expect(page.locator('.live-activity')).toContainText('/fixture/src/app.ts');
  await expect(page.getByText('Lines read', { exact: true })).toBeVisible();
  expect(
    await page
      .locator('.activity-timeline')
      .evaluate((el) => [...el.children].map((e) => e.textContent)),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining('I will inspect'),
      expect.stringContaining('The file is readable'),
    ]),
  );
  const ordered = await page
    .locator('.activity-timeline')
    .evaluate((el) =>
      [...el.children]
        .filter((e) => !e.classList.contains('timeline-note'))
        .map((e) => e.textContent ?? ''),
    );
  expect(ordered[0]).toContain('I will inspect');
  expect(ordered[1]).toContain('/fixture/src/app.ts');
  expect(ordered[2]).toContain('The file is readable');
  await page.screenshot({ path: 'artifacts/activity-inline-browser.png' });
  for (const tool of tools)
    await emit({
      kind: 'tool',
      tool: { category: 'tool', revision: 2, status: 'complete', sources: [], agents: [], ...tool },
    });
  await emit({
    kind: 'progress',
    id: 'final',
    revision: 1,
    text: 'The source files passed verification.',
  });
  await emit({ kind: 'text', text: 'The source files passed verification.' });
  await emit({ kind: 'usage', input: 2400, output: 50, cachedInput: 1900, costUsd: 0.012345 });
  await page.evaluate(() => (window as any).finishCapabilities('complete'));
  const usageSummary = page.getByLabel('Reply usage and cost', { exact: true });
  await expect(usageSummary).toContainText('$0.012345 estimated cost');
  await expect(page.locator('.reply-usage')).not.toHaveAttribute('open', '');
  await expect(page.locator('.reply-usage')).toHaveCSS('font-size', '11px');
  expect(
    await page
      .locator('.reply-usage')
      .evaluate(
        (el) =>
          !!(
            el.compareDocumentPosition(document.querySelector('.activity-summary')!) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
  ).toBe(true);
  await usageSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Cached input tokens', { exact: true })).toBeVisible();
  await expect(page.getByText('Estimated cost (USD)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/reply-usage-expanded-browser.png' });
  await usageSummary.click();
  const summary = page.getByLabel('Activity summary', { exact: true });
  await expect(summary).toContainText('5 tool calls');
  await expect(summary).toContainText('0 web searches');
  await expect(summary).toContainText('0 sub-agents');
  await expect(summary).toContainText('1 command run');
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await expect(
    page.getByText('The source files passed verification.', { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText('I will inspect the source files.', { exact: true }),
  ).not.toBeVisible();
  await page.screenshot({ path: 'artifacts/activity-summary-browser.png' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('I will inspect the source files.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Command runs (1)', exact: true }).click();
  await expect(page.locator('.tool-card')).toHaveCount(1);
  await page.locator('.tool-card > summary').click();
  await expect(page.getByText('Exit code', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tool calls (5)', exact: true }).click();
  await page
    .locator('.tool-card')
    .filter({ hasText: 'Legacy tool' })
    .locator(':scope > summary')
    .click();
  await expect(
    page.getByText('No details were recorded for this tool call.', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.tool-card')
    .filter({ hasText: 'select:WebSearch' })
    .locator(':scope > summary')
    .click();
  await expect(page.getByText('Tools found', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 880, height: 720 });
  expect(
    await page.locator('.tool-activity').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/activity-details-narrow-browser.png' });
  await usageSummary.click();
  expect(
    await page.locator('.reply-usage').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/reply-usage-narrow-browser.png' });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.locator('.conversation-item').first().click();
  await expect(page.locator('.activity-summary')).not.toHaveAttribute('open', '');
  await expect(summary).toContainText('5 tool calls');
  await expect(usageSummary).toContainText('$0.012345 estimated cost');
  await expect(page.locator('.reply-usage')).not.toHaveAttribute('open', '');
  await summary.click();
  await expect(
    page.getByText('The file is readable. I will find the components next.', { exact: true }),
  ).toBeVisible();
});

test('total AI time accumulates saved replies in this conversation and survives reload', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Cumulative time fixture');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Time fixture.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'complete');
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!).conversations[0]?.messages.at(-1)
        ?.status === 'complete',
  );
  await page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-workspace')!);
    const conversation = workspace.conversations[0];
    const original = conversation.messages.at(-1);
    const message = (text: string, status: string, durationMs?: number) => ({
      ...original,
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      blocks: [{ type: 'markdown', text }],
      status,
      durationMs,
    });
    conversation.messages = [
      message('First timed reply', 'complete', 1250),
      { ...message('User waiting time', 'complete', 999999), role: 'user' },
      message('Stopped timed reply', 'cancelled', 61250),
      message('Legacy untimed reply', 'error'),
      message('Recorded zero reply', 'complete', 0),
    ];
    workspace.conversations.push({
      ...conversation,
      id: crypto.randomUUID(),
      title: 'Other time fixture',
      messages: [message('Other conversation reply', 'complete', 999999)],
    });
    localStorage.setItem('test-workspace', JSON.stringify(workspace));
  });
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Cumulative time fixture', exact: true }).click();
  const totals = page.locator('.reply-usage > summary');
  await expect(totals.nth(0)).toContainText('1.3s total');
  await expect(totals.nth(1)).toContainText('1m 2.5s total');
  await expect(totals.nth(2)).toContainText('≥ 1m 2.5s total');
  await expect(totals.nth(3)).toContainText('≥ 1m 2.5s total');
  await totals.last().click();
  await expect(page.getByText('Total AI time', { exact: true }).last()).toBeVisible();
  await expect(page.locator('.reply-usage').last()).toContainText('Timing is missing for 1 reply');
  await page.setViewportSize({ width: 880, height: 900 });
  expect(
    await page
      .locator('.reply-usage')
      .last()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: 'artifacts/reply-time-total-narrow-browser.png' });

  await page.evaluate(() => {
    (window as any).emitCapability = null;
  });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Next timed reply');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await expect(totals).toHaveCount(4);
  await page.evaluate(() => {
    (window as any).emitCapability({ kind: 'text', text: 'Next timed reply complete.' });
    (window as any).finishCapabilities('complete');
  });
  await expect(totals).toHaveCount(5);
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!)
        .conversations.find((c: any) => c.title === 'Cumulative time fixture')
        .messages.at(-1)?.status === 'complete',
  );
  const durations = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('test-workspace')!)
        .conversations.find((c: any) => c.title === 'Cumulative time fixture')
        .messages.at(-1).durationMs,
  );
  const tenths = Math.round((62500 + durations) / 100);
  const expected = `≥ ${Math.floor(tenths / 600)}m ${((tenths % 600) / 10).toFixed(1)}s total`;
  await expect(totals.last()).toContainText(expected);
  await expect(totals.first()).toContainText('1.3s total');
  await page.reload();
  await page.getByRole('tab', { name: /^History/ }).click();
  await page.getByRole('button', { name: 'Cumulative time fixture', exact: true }).click();
  await expect(totals.last()).toContainText(expected);
});

test('reply cost distinguishes unreported, zero, and tiny values', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  for (const [costUsd, expected] of [
    [undefined, 'Cost not reported'],
    [0, '$0.00 estimated cost'],
    [0.0000001, '<$0.000001 estimated cost'],
  ] as const) {
    await page.evaluate(() => {
      (window as any).emitCapability = null;
    });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check reply cost');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.message[data-status="running"]')).toHaveCount(1);
    await page.waitForFunction(() => !!(window as any).emitCapability);
    await page.evaluate((costUsd) => {
      (window as any).emitCapability({ kind: 'text', text: 'Cost fixture complete.' });
      (window as any).emitCapability({ kind: 'usage', input: 0, output: 0, costUsd });
      (window as any).finishCapabilities('complete');
    }, costUsd);
    const reply = page.getByTestId('message').last();
    await expect(reply).toHaveAttribute('data-status', 'complete');
    await expect(reply.getByLabel('Reply usage and cost')).toContainText(expected);
    await reply.getByLabel('Reply usage and cost').click();
    await expect(reply.getByText('Estimated cost (USD)', { exact: true })).toBeVisible();
    if (costUsd == null)
      await expect(reply.locator('.usage-breakdown')).toContainText('No cost was reported');
  }
});

test('skill selection adds to the draft and stopped tools never appear to keep running', async ({
  page,
}) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await page.getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByRole('button', { name: 'Use skill test-skill' })).toBeDisabled();
  await page.evaluate(() => ((window as any).enableSkill = true));
  await page.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(page.getByRole('button', { name: 'Use skill test-skill' })).toBeEnabled();
  await page.getByRole('button', { name: 'Use skill test-skill' }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toContainText('');
  await expect(composer).toHaveValue(/Use the skill "test-skill".*\n\nKeep my draft/);
  await expect(composer).toBeFocused();
  await expect(page.locator('.tool-activity')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await page.evaluate(() =>
    (window as any).emitCapability({
      kind: 'tool',
      tool: {
        id: 's',
        revision: 1,
        category: 'search',
        name: 'Web search',
        status: 'running',
        sources: [],
        agents: [],
      },
    }),
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('.tool-activity')).toContainText('Stopped');
  await expect(page.locator('.tool-activity')).not.toContainText('Running');
});

test('model context shows scoped sources, filters, refresh failures, and preserves the chat draft', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft');
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Chat instructions', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Use project conventions <script>literal</script>');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await expect(dialog.getByText('CLAUDE.md', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Reported', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Discovered', { exact: true })).toBeVisible();
  const request = await page.evaluate(() => (window as any).contextCalls.at(-1));
  expect(request.location.path).toBe('C:\\Projects\\studio');
  expect(request.connectionId).toBeTruthy();
  expect(request).not.toHaveProperty('instructions');
  await dialog.getByText('Conversation instructions', { exact: false }).click();
  await expect(dialog.locator('pre')).toHaveText(
    'Use project conventions <script>literal</script>',
  );
  await expect(dialog.locator('script')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/context-instructions-browser.png' });
  await dialog.getByRole('button', { name: /^Skills/ }).click();
  await expect(dialog.getByText('test-skill', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Disabled', { exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Filter context sources' }).fill('no-match');
  await expect(dialog).toContainText('No sources match this filter.');
  await dialog.getByRole('button', { name: /^Memories/ }).click();
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 880, height: 720 });
  await page.screenshot({ path: 'artifacts/context-memories-narrow-browser.png' });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.evaluate(() => ((window as any).failContext = true));
  await dialog.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Context is unavailable');
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('Showing last saved result');
  await page.evaluate(() => ((window as any).failContext = false));
  await dialog.getByRole('button', { name: 'Refresh model context' }).click();
  await expect(dialog.getByText('MEMORY.md', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Model context', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Keep this draft',
  );
});

test('a late context query cannot replace a newly selected model inspection', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'Claude', exact: true }).click();
  await page.evaluate(() => ((window as any).holdContext = true));
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Inspecting the selected CLI profile');
  await expect.poll(() => page.evaluate(() => !!(window as any).releaseContext)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Opus', exact: true }).click();
  await page.evaluate(() => ((window as any).holdContext = false));
  await page.getByRole('button', { name: 'Model context', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Opus');
  await expect(page.getByRole('dialog').getByText('CLAUDE.md', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).releaseContext());
  await expect(page.getByRole('dialog')).toContainText('Opus');
  expect(await page.evaluate(() => (window as any).contextCalls.at(-1).model)).toBe('opus');
});

test('reopening model context shows cached data while one shared refresh completes', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await chooseTestFolder(page);
  const open = page.getByRole('button', { name: 'Model context', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Model context' });
  await open.click();
  await expect(dialog).toContainText('Revision 0.');
  await expect(dialog.getByRole('button', { name: 'Refresh model context' })).toBeEnabled();
  const checked = await dialog.locator('footer > span').textContent();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (window as any).holdContext = true;
    (window as any).contextRevision = 1;
  });
  await open.click();
  await expect(dialog).toContainText('Revision 0.');
  await expect(dialog).toContainText('Updating…');
  await expect(dialog).not.toContainText('Inspecting the selected CLI profile');
  await expect(dialog.locator('footer > span')).toContainText(checked!);
  await expect.poll(() => page.evaluate(() => (window as any).contextCalls.length)).toBe(2);
  await page.screenshot({ path: 'artifacts/context-cached-refresh-browser.png' });
  await dialog.getByRole('button', { name: /^Skills/ }).click();
  await expect(dialog.getByText('test-skill', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await open.click();
  await expect(dialog).toContainText('Updating…');
  await expect(dialog).toContainText('Revision 0.');
  expect(await page.evaluate(() => (window as any).contextCalls.length)).toBe(2);
  await page.evaluate(() => {
    (window as any).holdContext = false;
    (window as any).releaseContext();
  });
  await expect(dialog).toContainText('Revision 1.');
  await expect(dialog).not.toContainText('Updating…');
  await page.keyboard.press('Escape');
  await page.evaluate(() => ((window as any).holdContext = true));
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'GPT-6 Astra', exact: true }).click();
  await open.click();
  await expect(dialog).toContainText('Inspecting the selected CLI profile');
  await expect(dialog).not.toContainText('Revision 1.');
  await expect.poll(() => page.evaluate(() => (window as any).contextCalls.length)).toBe(3);
  await page.evaluate(() => (window as any).releaseContext());
  await expect(dialog).toContainText('Revision 1.');
});
