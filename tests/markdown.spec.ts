import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRelay } from '../relay/server';
import { initialWorkspace } from '../src/lib/domain';
import { mockDesktop } from './desktop-helper';
import { chooseTestFolder } from './folder-helper';

test('code colors update during streaming and survive saved history', async ({ page }) => {
  await mockDesktop(page, 'capabilities');
  await page.goto('/');
  await chooseTestFolder(page);
  await page.getByLabel('Message', { exact: true }).fill('Show highlighted code examples');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForFunction(() => !!(window as any).emitCapability);
  await page.evaluate(() => {
    (window as any).emitCapability({
      kind: 'progress',
      id: 'code-progress',
      revision: 1,
      text: 'Checking the data shape:\n\n```json\n{"ready": true}\n```',
    });
    (window as any).emitCapability({
      kind: 'text',
      text: 'TypeScript\n\n```TS example.ts\n// A friendly greeting\nconst greeting: string = "Hello, world!";',
    });
  });
  await expect(page.locator('.prose code.language-json .hljs-literal')).toHaveText('true');
  const code = page.locator('.message:not(.user) .prose code.language-ts').first();
  await expect(code.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(code.locator('.hljs-string')).toHaveText('"Hello, world!"');
  const colors = await code.evaluate((element) =>
    ['.hljs-keyword', '.hljs-string', '.hljs-comment'].map(
      (selector) => getComputedStyle(element.querySelector(selector)!).color,
    ),
  );
  expect(new Set(colors).size).toBe(3);
  await page.evaluate(() => {
    // Typed text events carry cumulative snapshots, not raw provider deltas.
    (window as any).emitCapability({
      kind: 'text',
      text: 'TypeScript\n\n```TS example.ts\n// A friendly greeting\nconst greeting: string = "Hello, world!";\nconsole.log(greeting);\n```\n\nPython\n\n```py\ndef greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("Ada"))\n```',
    });
    (window as any).finishCapabilities('complete');
  });
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.locator('.prose code.language-py .hljs-keyword').first()).toHaveText('def');
  await page.screenshot({ path: 'artifacts/syntax-highlighting-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(code).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/syntax-highlighting-mobile.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.reload();
  await page.getByRole('tab', { name: /History/ }).click();
  await page.getByRole('button', { name: /Show highlighted code examples/ }).click();
  await expect(code.locator('.hljs-string')).toHaveText('"Hello, world!"');
  await expect(code).toContainText('console.log(greeting);');
});

test('production PWA keeps highlighted HTML inert and preserves plain code fallbacks', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-markdown-web-'));
  const server = createRelay({
    token: 'synthetic-markdown-fixture-pairing-key',
    directory,
    webDirectory: resolve('build'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const html =
    '<script>window.codeExecuted = true</script>\n<img src=x onerror="window.codeExecuted=true">\n<p>&lt;literal&gt; & text</p>';
  const plain = '<b>const plain = "keep this literal";</b> &amp;';
  const large = '// long code block\n' + 'const value = 1;\n'.repeat(4200);
  const snippets = [
    ['html Example', html],
    ['ps1', '$greeting = "Hello"\nWrite-Output $greeting'],
    ['rs', 'fn main() { let count = 42; }'],
    ['unknown-language', plain],
    ['', plain],
    ['text', plain],
    ['js" onclick="window.codeExecuted=true', plain],
    ['js', large],
  ];
  const workspace = initialWorkspace(),
    now = new Date().toISOString();
  workspace.conversations.push({
    id: crypto.randomUUID(),
    title: 'Syntax highlighting fixture',
    createdAt: now,
    updatedAt: now,
    archived: true,
    settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'complete',
        createdAt: now,
        blocks: [
          {
            type: 'markdown',
            text:
              snippets
                .map(([lang, source]) => '```' + lang + '\n' + source + '\n```')
                .join('\n\n') +
              '\n\nInline `const untouched = true`\n\n<script>window.codeExecuted=true</script>\n<a href="javascript:window.codeExecuted=true">Unsafe link</a>',
          },
        ],
      },
    ],
  });
  try {
    await page.addInitScript((workspace) => {
      if (window.top === window)
        localStorage.setItem('agent-studio.browser.v1', JSON.stringify(workspace));
    }, workspace);
    await page.goto(url);
    await page.getByRole('tab', { name: /History/ }).click();
    await page.getByRole('button', { name: /Syntax highlighting fixture/ }).click();
    const codes = page.locator('.prose pre code');
    await expect(codes).toHaveCount(snippets.length);
    for (const [index, [, source]] of snippets.entries()) {
      expect((await codes.nth(index).textContent())?.trimEnd()).toBe(source.trimEnd());
      if (index < 3) expect(await codes.nth(index).locator('span').count()).toBeGreaterThan(0);
      else await expect(codes.nth(index).locator('span')).toHaveCount(0);
    }
    await expect(page.locator('.prose p > code span')).toHaveCount(0);
    await expect(
      page.locator(
        '.prose script, .prose img, .prose [onclick], .prose [onerror], .prose a[href^="javascript:"]',
      ),
    ).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).codeExecuted)).toBeUndefined();
    const firstCode = codes.first();
    expect(
      await firstCode
        .locator('.hljs-name')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    ).not.toBe(await firstCode.evaluate((el) => getComputedStyle(el).color));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
