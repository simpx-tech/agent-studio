// Read-only provider protocol checks with synthetic, disposable profile data. No model turns.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-account-context-')));
const source = join(root, 'source'),
  target = join(root, 'target');
await mkdir(source);
await mkdir(target);
function processFor(exe, args, env = {}) {
  const child = spawn(exe, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const messages = [],
    waiters = [];
  let buffer = '';
  child.stdout.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'),
        line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        messages.push(value);
        for (const wake of waiters.splice(0)) wake();
      } catch {}
    }
  });
  child.on('error', (error) => {
    throw error;
  });
  async function wait(predicate) {
    const deadline = Date.now() + 30000;
    while (!messages.some(predicate)) {
      assert(Date.now() < deadline, 'Provider protocol timed out');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return messages.find(predicate);
  }
  let next = 0;
  return {
    child,
    messages,
    wait,
    send(value) {
      child.stdin.write(JSON.stringify(value) + '\n');
    },
    async rpc(method, params) {
      const id = ++next;
      this.send({ id, method, params });
      const response = await wait((v) => v.id === id);
      assert(!response.error, `${method}: ${response.error?.message}`);
      return response.result;
    },
    async close() {
      child.stdin.end();
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => {
          child.kill();
          resolve();
        }, 3000).unref();
      });
    },
  };
}
const codex = process.env.STUDIO_CODEX_EXE ?? 'codex';
async function server(profile) {
  const p = processFor(codex, ['app-server', '--stdio'], { CODEX_HOME: profile });
  await p.rpc('initialize', {
    clientInfo: { name: 'studio_context_probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  p.send({ method: 'initialized' });
  return p;
}
const a = await server(source);
let thread;
try {
  thread = (
    await a.rpc('thread/start', {
      cwd: root,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
    })
  ).thread;
  await a.rpc('thread/inject_items', {
    threadId: thread.id,
    items: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Synthetic context-transfer fixture.' }],
      },
    ],
  });
} finally {
  await a.close();
}
async function find(dir, id) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isFile() && e.name.endsWith(`-${id}.jsonl`)) return path;
    if (e.isDirectory()) {
      const found = await find(path, id);
      if (found) return found;
    }
  }
}
const path = thread.path ?? (await find(join(source, 'sessions'), thread.id));
assert(path, 'Source transcript exists');
const before = await readFile(path),
  hash = (v) => createHash('sha256').update(v).digest('hex');
const imported = join(target, relative(source, path));
await mkdir(dirname(imported), { recursive: true });
await writeFile(imported, before, { flag: 'wx' });
const b = await server(target);
let fork;
try {
  fork = (
    await b.rpc('thread/fork', {
      threadId: thread.id,
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      excludeTurns: true,
    })
  ).thread;
  assert.notEqual(fork.id, thread.id);
  assert.equal(
    (await b.rpc('thread/read', { threadId: fork.id, includeTurns: true })).thread.id,
    fork.id,
  );
  await b.rpc('thread/inject_items', {
    threadId: fork.id,
    items: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Second generation of synthetic native context.' }],
      },
    ],
  });
} finally {
  await b.close();
}
assert.equal(hash(await readFile(path)), hash(before));
const nextProfile = join(root, 'next-profile');
await mkdir(nextProfile);
const forkPath = fork.path ?? (await find(join(target, 'sessions'), fork.id));
assert(forkPath);
const leaf = await readFile(forkPath);
assert(
  JSON.parse(leaf.toString('utf8').split('\n')[0]).payload.history_base,
  'Installed CLI exposes paginated fork ancestry',
);
const leafDestination = join(nextProfile, relative(target, forkPath));
await mkdir(dirname(leafDestination), { recursive: true });
await writeFile(leafDestination, leaf, { flag: 'wx' });
let next = await server(nextProfile);
try {
  await assert.rejects(
    () => next.rpc('thread/fork', { threadId: fork.id, excludeTurns: true }),
    /missing source rollout/,
  );
} finally {
  await next.close();
}
async function importLineage(from, to, id, end, seen = new Set()) {
  assert(!seen.has(id) && seen.size < 128);
  seen.add(id);
  const file = await find(join(from, 'sessions'), id);
  assert(file);
  let bytes = await readFile(file);
  if (end !== undefined) {
    assert(bytes.length >= end);
    bytes = bytes.subarray(0, end);
  }
  assert.equal(bytes.at(-1), 10);
  const meta = JSON.parse(bytes.toString('utf8').split('\n')[0]).payload;
  assert.equal(meta.id, id);
  if (meta.history_base)
    await importLineage(
      from,
      to,
      meta.history_base.thread_id,
      meta.history_base.end_byte_offset,
      seen,
    );
  const destination = join(to, relative(from, file));
  await mkdir(dirname(destination), { recursive: true });
  try {
    assert((await readFile(destination)).subarray(0, bytes.length).equals(bytes));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(destination, bytes, { flag: 'wx' });
  }
}
await importLineage(target, nextProfile, fork.id);
next = await server(nextProfile);
let nextId;
try {
  nextId = (await next.rpc('thread/fork', { threadId: fork.id, excludeTurns: true })).thread.id;
  assert.notEqual(nextId, fork.id);
} finally {
  await next.close();
}
next = await server(nextProfile);
try {
  assert.equal(
    (await next.rpc('thread/resume', { threadId: nextId, excludeTurns: true })).thread.id,
    nextId,
  );
  assert.equal(
    (await next.rpc('thread/read', { threadId: nextId, includeTurns: true })).thread.id,
    nextId,
  );
} finally {
  await next.close();
}
const skills = join(source, 'skills', 'shared-probe');
await mkdir(skills, { recursive: true });
await writeFile(
  join(skills, 'SKILL.md'),
  '---\nname: shared-probe\ndescription: Synthetic shared skill for inventory testing\n---\nReturn PROBE when invoked.\n',
);
const claude = processFor(process.env.STUDIO_CLAUDE_EXE ?? 'claude', [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--tools',
  '',
  '--permission-mode',
  'dontAsk',
  '--settings',
  '{"disableAllHooks":true}',
  '--plugin-dir',
  source,
]);
let commands;
try {
  claude.send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  const response = await claude.wait(
    (v) => v.type === 'control_response' && v.response?.request_id === 'init',
  );
  assert.equal(response.response.subtype, 'success');
  commands = response.response.response?.commands ?? [];
  assert(
    commands.some((c) => JSON.stringify(c).includes('shared-probe')),
    'Shared profile skills are discoverable as native Claude plugin skills',
  );
} finally {
  await claude.close();
}
const report = {
  codexCrossProfileFork: true,
  codexPaginatedLineage: true,
  codexLineageSurvivesRestart: true,
  sourceUnchanged: true,
  claudeSharedSkillDiscovered: true,
  modelTurns: 0,
};
await mkdir('artifacts/account-context', { recursive: true });
await writeFile('artifacts/account-context/protocol.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
