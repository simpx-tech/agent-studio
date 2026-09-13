// Read-only proof against the real sessions created by sessions-native-smoke.mjs.
// Emits counts/hashes only; never writes native instruction text to logs or reports.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { nativePage } from './native-page.mjs';

const page = await nativePage(9513);
const identifier = 'com.vinicius.agentstudio.sessions-qa';
const output = 'artifacts/native-instructions';
const hash = (text) => createHash('sha256').update(text).digest('hex');
await mkdir(output, { recursive: true });
try {
  assert.equal(await page.invoke('plugin:app|identifier'), identifier);
  await page.waitFor(() => !!document.querySelector('[aria-label="Message"]'));
  const workspace = await page.invoke('load_workspace');
  assert(workspace.conversations.every((c) => c.title.startsWith('Sessions QA')));
  assert(!workspace.conversations.some((c) => c.messages.some((m) => m.status === 'running')));
  const report = { checkedAt: new Date().toISOString(), results: [] };
  for (const provider of ['claude', 'codex']) {
    const chat = workspace.conversations.find((c) => c.settings.provider === provider);
    assert(chat, `Missing ${provider} QA conversation`);
    const args = { conversationId: chat.id, provider, connectionId: chat.settings.connectionId };
    const bindingPath = join(
      process.env.LOCALAPPDATA,
      identifier,
      'native-sessions',
      chat.id + '.json',
    );
    const bindingBytes = await readFile(bindingPath);
    const binding = JSON.parse(bindingBytes);
    const profile = join(homedir(), provider === 'claude' ? '.claude' : '.codex');
    const storage = join(profile, provider === 'claude' ? 'projects' : 'sessions');
    const files = (await readdir(storage, { recursive: true })).filter((p) =>
      p.endsWith(provider === 'claude' ? `${binding.id}.jsonl` : `-${binding.id}.jsonl`),
    );
    assert.equal(files.length, 1);
    const nativePath = join(storage, files[0]);
    const before = await readFile(nativePath);
    const rows = before
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const result = await page.invoke('read_native_instructions', args);
    const expected =
      provider === 'claude'
        ? rows
            .filter(
              (r) =>
                r.type === 'attachment' &&
                r.attachment?.type === 'prompt_snapshot' &&
                r.isSidechain === false,
            )
            .at(-1).attachment.systemPrompt
        : [
            rows.find((r) => r.type === 'session_meta').payload.base_instructions.text,
            ...new Set(
              rows
                .filter(
                  (r) =>
                    r.type === 'response_item' &&
                    r.payload?.type === 'message' &&
                    r.payload.role === 'developer',
                )
                .map((r) => r.payload.content.map((p) => p.text).join('\n\n')),
            ),
          ];
    assert.deepEqual(
      result.blocks.map((block) => block.text),
      expected,
    );
    assert(result.studioGuidance.startsWith('You are having a conversation in Agent Studio.'));
    assert.equal(hash(await readFile(nativePath)), hash(before));
    assert.equal(hash(await readFile(bindingPath)), hash(bindingBytes));
    await assert.rejects(
      page.invoke('read_native_instructions', { ...args, conversationId: crypto.randomUUID() }),
    );
    await assert.rejects(
      page.invoke('read_native_instructions', {
        ...args,
        provider: provider === 'claude' ? 'codex' : 'claude',
      }),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .find((e) => e.textContent.includes('History'))
        ?.click(),
    );
    await page.evaluate((id) => {
      const row = [...document.querySelectorAll('.conversation-item')].find((e) =>
        e.textContent.includes(id),
      );
      if (!row) throw new Error('Missing QA chat row');
      row.click();
    }, chat.title);
    await page.button('Model context');
    await page.button('Native prompt');
    await page.waitFor(
      () => document.querySelectorAll('.native-block:not(.studio-guidance)').length > 0,
    );
    const texts = await page.evaluate(() =>
      [...document.querySelectorAll('.native-block:not(.studio-guidance) pre')].map(
        (e) => e.textContent,
      ),
    );
    assert.deepEqual(texts, expected);
    await page.evaluate(() => document.querySelector('.native-block')?.setAttribute('open', ''));
    // Screenshot stays local and is not committed. Reports contain hashes rather than prompt text.
    const screenshot = await page.cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `${provider}-native.png`), Buffer.from(screenshot.data, 'base64'));
    await page.button('Done');
    report.results.push({
      provider,
      blocks: result.blocks.length,
      characters: expected.reduce((n, t) => n + t.length, 0),
      version: result.blocks[0].version,
      captureTime: result.blocks[0].capturedAt,
      hash: hash(JSON.stringify(texts)),
      exactRecordMatch: true,
      filesUnchanged: true,
      rejectsWrongScope: true,
    });
  }
  assert.equal(page.errors.length, 0);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  page.close();
}
