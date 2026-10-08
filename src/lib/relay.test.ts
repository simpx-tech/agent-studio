import { nativeWorkflowFixture } from '../../tests/native-workflow-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../../relay/server.ts';
import { emptyShared } from './sync';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(limits?: {
  upload?: number;
  answer?: number;
  jobUpdate?: number;
  jobStorage?: number;
}) {
  let time = Date.now();
  const token = 'synthetic-test-pairing-key-'.repeat(2);
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-relay-'));
  const server = createRelay({ token, directory, now: () => time, limits });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const source = crypto.randomUUID(),
    target = crypto.randomUUID();
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    actor = source,
    key = token,
  ) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'x-environment-id': actor,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    call,
    source,
    target,
    directory,
    token,
    server,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
// A conversation holding one message of `text`, as a device would sync it.
const conversation = (text: string) => ({
  id: crypto.randomUUID(),
  title: text.slice(0, 20),
  createdAt: '2026-09-27',
  updatedAt: '2026-09-27',
  settings: { provider: 'codex' as const, model: '', reasoning: '' as const, instructions: '' },
  messages: [
    {
      id: crypto.randomUUID(),
      role: 'user' as const,
      blocks: [{ type: 'markdown' as const, text }],
      status: 'complete' as const,
      createdAt: '2026-09-27',
    },
  ],
});
/** A 1×1 PNG, and the same with one more byte, so two images differ. */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
  'base64',
);
const otherPng = Buffer.concat([png, Buffer.from([0])]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** A conversation whose first message carries `images`, as a device syncs it. */
const withImages = (images: unknown[]) => {
  const chat = conversation('An image');
  (chat.messages[0] as { images?: unknown[] }).images = images;
  return chat;
};
const inline = (bytes: Buffer, id = crypto.randomUUID()) => ({
  id,
  name: 'shot.png',
  mediaType: 'image/png',
  data: bytes.toString('base64'),
});
const stored = (bytes: Buffer, id: string) => ({
  id,
  name: 'shot.png',
  mediaType: 'image/png',
  hash: sha256(bytes),
  bytes: bytes.length,
});

describe('image store', () => {
  // A request as a device that knows the image store sends it, or as an older one when
  // `references` is off; `raw` sends bytes rather than JSON.
  async function request(
    f: Awaited<ReturnType<typeof fixture>>,
    method: string,
    path: string,
    options: { body?: unknown; raw?: Buffer; references?: boolean; actor?: string } = {},
  ) {
    const response = await fetch(
      `http://127.0.0.1:${(f.server.address() as { port: number }).port}/v1/${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${f.token}`,
          'x-environment-id': options.actor ?? f.source,
          ...(options.references === false ? {} : { 'x-studio-images': '1' }),
          'content-type': options.raw ? 'application/octet-stream' : 'application/json',
        },
        body: options.raw
          ? new Uint8Array(options.raw)
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      },
    );
    const type = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      type,
      body: type.includes('json')
        ? ((await response.json()) as any)
        : Buffer.from(await response.arrayBuffer()),
    };
  }

  it('keeps each image once, refusing bytes that are not an image or not its hash', async () => {
    const f = await fixture();
    const hash = sha256(png);
    expect((await request(f, 'POST', 'images/missing', { body: { hashes: [hash] } })).body).toEqual(
      {
        missing: [hash],
      },
    );
    expect((await request(f, 'PUT', `images/${hash}`, { raw: png })).status).toBe(200);
    expect((await request(f, 'POST', 'images/missing', { body: { hashes: [hash] } })).body).toEqual(
      {
        missing: [],
      },
    );
    const read = await request(f, 'GET', `images/${hash}`);
    expect(read).toMatchObject({ status: 200, type: 'image/png' });
    expect(read.body).toEqual(png);
    // An upload must be the image its name says, and an image at all.
    expect((await request(f, 'PUT', `images/${hash}`, { raw: otherPng })).status).toBe(400);
    const text = Buffer.from('not an image at all');
    expect((await request(f, 'PUT', `images/${sha256(text)}`, { raw: text })).status).toBe(400);
    expect((await request(f, 'GET', `images/${sha256(otherPng)}`)).status).toBe(404);
    expect((await request(f, 'PUT', 'images/not-a-hash', { raw: png })).status).toBe(400);
    // Nothing unauthenticated reads an image.
    expect(
      (
        await f.call(
          'GET',
          `images/${hash}`,
          undefined,
          f.source,
          'wrong-key-wrong-key-wrong-key-wrong',
        )
      ).status,
    ).toBe(401);
  });

  it('stores images an older app sends inline and hands them back to it inline', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    const workspace = emptyShared();
    workspace.conversations.push(withImages([inline(png, id)]) as never);
    const put = await request(f, 'PUT', 'state', {
      body: { revision: 0, workspace },
      references: false,
    });
    expect(put.status).toBe(200);
    // The older app reads its own image back as it sent it.
    expect(put.body.workspace.conversations[0].messages[0].images).toEqual([inline(png, id)]);
    // The relay keeps the reference, and the bytes once.
    const current = await request(f, 'GET', 'state');
    expect(current.body.workspace.conversations[0].messages[0].images).toEqual([stored(png, id)]);
    expect((await request(f, 'GET', `images/${sha256(png)}`)).body).toEqual(png);
    const old = await request(f, 'GET', 'state', { references: false });
    expect(old.body.workspace.conversations[0].messages[0].images).toEqual([inline(png, id)]);
    // A patch from the older app, and the conversations it asks for, work the same way.
    const second = withImages([inline(otherPng, id)]);
    const patch = await request(f, 'POST', 'state/patch', {
      body: { revision: current.body.revision, upsert: [second] },
      references: false,
    });
    expect(patch.status).toBe(200);
    const chats = (references: boolean) =>
      request(f, 'POST', 'state/chats', { body: { ids: [second.id] }, references });
    expect((await chats(true)).body.chats[0].messages[0].images).toEqual([stored(otherPng, id)]);
    expect((await chats(false)).body.chats[0].messages[0].images).toEqual([inline(otherPng, id)]);
    // Uploading the same bytes again, inline or as a reference, changes nothing.
    const revision = (await request(f, 'GET', 'state/revision')).body.revision;
    const again = await request(f, 'POST', 'state/patch', {
      body: {
        revision,
        upsert: [
          { ...second, messages: [{ ...second.messages[0], images: [stored(otherPng, id)] }] },
        ],
      },
    });
    expect(again.body.chats[second.id]).toBe((await chats(true)).body.chatRevisions[second.id]);
  });

  it("keeps a run's images as references and gives them inline to an older host", async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const id = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const job = {
      id: runId,
      source: f.source,
      target: f.target,
      method: 'run',
      args: {
        connectionId: crypto.randomUUID(),
        request: { runId, messages: [{ role: 'user', text: 'Look', images: [inline(png, id)] }] },
      },
    };
    const posted = await request(f, 'POST', 'jobs', { body: job, references: false });
    expect(posted.status).toBe(200);
    expect(posted.body.args.request.messages[0].images).toEqual([stored(png, id)]);
    // A retried submission is still the same request.
    expect((await request(f, 'POST', 'jobs', { body: job, references: false })).status).toBe(200);
    const claimed = await request(f, 'GET', 'jobs', { actor: f.target, references: false });
    expect(claimed.body[0].args.request.messages[0].images).toEqual([inline(png, id)]);
  });

  it('refuses an image upload past 16 MB even without a declared length', async () => {
    const f = await fixture();
    const large = Buffer.alloc(16 * 1024 * 1024 + 1);
    png.copy(large);
    const hash = sha256(large);
    const port = (f.server.address() as { port: number }).port;
    const outcome = await new Promise<number | 'reset'>((resolve) => {
      // Without a length the bytes arrive chunked, and the relay counts them as they come.
      const upload = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: `/v1/images/${hash}`,
          headers: {
            authorization: `Bearer ${f.token}`,
            'x-environment-id': f.source,
            'x-studio-images': '1',
            'content-type': 'application/octet-stream',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      // The relay stops reading past the limit, which may reset the connection instead.
      upload.on('error', () => resolve('reset'));
      for (let at = 0; at < large.length; at += 1 << 20)
        upload.write(large.subarray(at, at + (1 << 20)));
      upload.end();
    });
    expect([413, 'reset']).toContain(outcome);
    // Nothing of it stays, not even the partial upload.
    await vi.waitFor(() => expect(readdirSync(join(f.directory, 'images'))).toEqual([]));
  });

  it('refuses a run whose inline image is not the image it says', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const runId = crypto.randomUUID();
    const text = Buffer.from('not an image at all');
    const image = { ...inline(png), data: text.toString('base64') };
    const job = {
      id: runId,
      source: f.source,
      target: f.target,
      method: 'run',
      args: {
        connectionId: crypto.randomUUID(),
        request: { runId, messages: [{ role: 'user', text: 'Look', images: [image] }] },
      },
    };
    expect((await request(f, 'POST', 'jobs', { body: job, references: false })).status).toBe(400);
    expect((await request(f, 'GET', `images/${sha256(text)}`)).status).toBe(404);
  });

  it('keeps an image a rewind, a waiting run or a fresh upload needs, and prunes it after', async () => {
    const f = await fixture();
    const path = (bytes: Buffer) => join(f.directory, 'images', sha256(bytes));
    const kept = (bytes: Buffer) => existsSync(path(bytes));
    const [rewound, running, old, fresh] = [1, 2, 3, 4].map((n) =>
      Buffer.concat([png, Buffer.from([n])]),
    );
    const all = [rewound, running, old, fresh];
    for (const bytes of all)
      expect((await request(f, 'PUT', `images/${sha256(bytes)}`, { raw: bytes })).status).toBe(200);
    // All but the fresh upload were uploaded more than a day ago.
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const bytes of [rewound, running, old]) utimesSync(path(bytes), dayAgo, dayAgo);
    // One is named only by the messages a rewind keeps to restore.
    const workspace = emptyShared();
    const removed = {
      ...conversation('Removed').messages[0],
      images: [stored(rewound, crypto.randomUUID())],
    };
    workspace.conversations.push({
      ...conversation('Rewound'),
      rewind: { removed: [removed], createdAt: '2026-09-27' },
    } as never);
    expect((await request(f, 'PUT', 'state', { body: { revision: 0, workspace } })).status).toBe(
      200,
    );
    // Another only by a run waiting for its computer.
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const runId = crypto.randomUUID();
    const run = {
      id: runId,
      source: f.source,
      target: f.target,
      method: 'run',
      args: {
        connectionId: crypto.randomUUID(),
        request: {
          runId,
          messages: [
            { role: 'user', text: 'Look', images: [stored(running, crypto.randomUUID())] },
          ],
        },
      },
    };
    expect((await request(f, 'POST', 'jobs', { body: run })).status).toBe(200);
    // The next sweep removes the old image nothing names, and keeps the fresh upload, which a
    // message may name next. The run has waited too long by then, but the relay still has it.
    f.advance(60 * 60 * 1000);
    await request(f, 'GET', 'state/revision');
    expect(all.map(kept)).toEqual([true, true, false, true]);
    // Once the relay forgets the run, its image goes too.
    f.advance(2 * 60 * 60 * 1000);
    await request(f, 'GET', 'state/revision');
    expect(all.map(kept)).toEqual([true, false, false, true]);
  });

  it('moves images saved inline into the store at startup and prunes what nothing refers to', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-studio-relay-'));
    const token = 'synthetic-test-pairing-key-'.repeat(2);
    let time = Date.now();
    const id = crypto.randomUUID();
    const workspace = emptyShared();
    workspace.conversations.push(withImages([inline(png, id)]) as never);
    const saved = { instanceId: crypto.randomUUID(), version: 1, revision: 3, workspace };
    writeFileSync(join(directory, 'workspace.json'), JSON.stringify(saved));
    const orphan = join(directory, 'images', sha256(otherPng));
    const server = createRelay({ token, directory, now: () => time });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    });
    const disk = JSON.parse(readFileSync(join(directory, 'workspace.json'), 'utf8'));
    expect(disk.workspace.conversations[0].messages[0].images).toEqual([stored(png, id)]);
    expect(readFileSync(join(directory, 'images', sha256(png)))).toEqual(png);
    // The file it came from is kept once, unchanged.
    expect(
      JSON.parse(readFileSync(join(directory, 'workspace-before-images.json'), 'utf8')),
    ).toEqual(saved);
    // An image nothing refers to is removed once it is a day old; a referenced one stays.
    writeFileSync(orphan, otherPng);
    time += 25 * 60 * 60 * 1000;
    const port = (server.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/v1/state/revision`, {
      headers: { authorization: `Bearer ${token}`, 'x-environment-id': crypto.randomUUID() },
    });
    // The hourly sweep runs with the relay's regular expiry pass.
    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false));
    expect(existsSync(join(directory, 'images', sha256(png)))).toBe(true);
  });
});

describe('real HTTP relay', () => {
  it('keeps idle connections longer than the proxy in front of it keeps them', async () => {
    const f = await fixture();
    // Caddy reuses an idle connection for two minutes; one the relay closed sooner was reset.
    expect(f.server.keepAliveTimeout).toBeGreaterThan(120_000);
    expect(f.server.headersTimeout).toBeGreaterThan(f.server.keepAliveTimeout);
  });

  it('names its workspace in the revision answer, so a computer pairs without the whole state', async () => {
    const f = await fixture();
    expect(await f.call('GET', 'state/revision')).toEqual({
      status: 200,
      body: { instanceId: expect.any(String), workspaceId: 'owner', revision: 0, images: 1 },
    });
  });

  it('refuses a workspace upload past its limit, whole or patched', async () => {
    const f = await fixture({ upload: 4_000 });
    const large = conversation('x'.repeat(8_000));
    expect(
      await f.call('PUT', 'state', {
        revision: 0,
        workspace: { ...emptyShared(), conversations: [large] },
      }),
    ).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(await f.call('POST', 'state/patch', { revision: 0, upsert: [large] })).toMatchObject({
      status: 413,
      body: { code: 'too_large' },
    });
    // Nothing was stored, and an upload within the limit still goes through.
    const small = conversation('Small');
    const accepted = await f.call('POST', 'state/patch', { revision: 0, upsert: [small] });
    expect(accepted).toMatchObject({
      status: 200,
      body: { revision: 1, chats: { [small.id]: 1 } },
    });
  });

  it('answers conversations within a budget and names the rest for another request', async () => {
    const f = await fixture({ answer: 3_000 });
    const chats = ['a', 'b', 'c'].map((letter) => conversation(letter.repeat(2_000)));
    expect((await f.call('POST', 'state/patch', { revision: 0, upsert: chats })).status).toBe(200);
    const ids = chats.map((c) => c.id);
    const first = await f.call('POST', 'state/chats', { ids });
    expect(first.body.chats.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
    expect(first.body.rest).toEqual([ids[1], ids[2]]);
    const second = await f.call('POST', 'state/chats', { ids: first.body.rest });
    expect(second.body.chats.map((c: { id: string }) => c.id)).toEqual([ids[1]]);
    expect(second.body.rest).toEqual([ids[2]]);
  });

  it('routes Undo identities without accepting caller-supplied file content or paths', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'undoFiles',
      args: {
        conversationId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        commit: true,
      },
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...job.args, path: '/outside/file', content: 'replacement' },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(job.args);
  });
  it('routes a chat closed on another device to its host with only its identities', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'release',
      args: { conversationId: crypto.randomUUID(), connectionId: crypto.randomUUID() },
    };
    for (const args of [
      { ...job.args, path: '/outside/process' },
      { ...job.args, conversationId: 'every-conversation' },
      { conversationId: job.args.conversationId },
    ])
      expect((await f.call('POST', 'jobs', { ...job, args })).status).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0]).toMatchObject({
      method: 'release',
      args: job.args,
    });
  });
  it('routes folder icon choices to the host with only a bounded folder name and message', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'folderIcon',
      args: {
        conversationId: crypto.randomUUID(),
        provider: 'claude',
        folder: 'Unreal Projects/Bluevox',
        firstMessage: 'Fix the voxel shader',
        connectionId: crypto.randomUUID(),
      },
    };
    for (const args of [
      { ...job.args, path: '/outside/process' },
      { ...job.args, provider: 'shell' },
      { ...job.args, folder: '' },
      { ...job.args, firstMessage: 'x'.repeat(4001) },
      { ...job.args, connectionId: undefined },
    ])
      expect((await f.call('POST', 'jobs', { ...job, args })).status).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0]).toMatchObject({
      method: 'folderIcon',
      args: job.args,
    });
  });
  it('routes explicit plan decisions to the owning host and retains proposed plans in checkpoints', async () => {
    const f = await fixture(),
      id = crypto.randomUUID(),
      connectionId = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id,
      source: f.source,
      target: f.target,
      method: 'run',
      args: { request: { runId: id, agent: { provider: 'claude', planMode: true } } },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect(
      (await f.call('GET', 'jobs', undefined, f.target)).body[0].args.request.agent.planMode,
    ).toBe(true);
    const question = {
      id: crypto.randomUUID(),
      revision: 1,
      status: 'pending',
      questions: [
        {
          id: 'approval',
          header: 'Plan mode',
          question: 'Approve?',
          options: [],
          multiSelect: false,
        },
      ],
      planApproval: { action: 'exit', text: 'A reviewable plan' },
    };
    const proposedPlan = {
      id: 'plan',
      revision: 2,
      text: 'Final proposed plan',
      complete: true,
      truncated: false,
    };
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${id}`,
          {
            status: 'running',
            events: [
              { kind: 'question', question },
              { kind: 'proposedplan', proposedPlan },
            ],
          },
          f.target,
        )
      ).status,
    ).toBe(200);
    const checkpoint = (await f.call('GET', `jobs/${id}`)).body;
    expect(checkpoint.events.find((e: any) => e.kind === 'question').question.planApproval).toEqual(
      question.planApproval,
    );
    expect(checkpoint.events.find((e: any) => e.kind === 'proposedplan').proposedPlan).toEqual(
      proposedPlan,
    );
    const decision = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'answer',
      args: {
        runId: id,
        connectionId,
        answer: {
          requestId: question.id,
          answers: [{ id: 'approval', values: ['Approve'] }],
          skipped: false,
        },
      },
    };
    expect((await f.call('POST', 'jobs', decision)).status).toBe(200);
    const owned = (await f.call('GET', 'jobs', undefined, f.target)).body;
    expect(owned.find((j: any) => j.id === decision.id).args).toEqual(decision.args);
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${decision.id}`,
          { status: 'complete', events: [], result: null },
          f.source,
        )
      ).status,
    ).toBe(404);
  });
  it('keeps active plugin evaluations beyond six minutes but bounds their lifetime and heartbeat', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'plugins',
      args: {
        provider: 'claude',
        connectionId: crypto.randomUUID(),
        action: {
          kind: 'eval',
          id: 'fixture@local',
          operationId: crypto.randomUUID(),
          trusted: true,
          maxCostUsd: 1,
        },
      },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    for (let second = 30; second <= 660; second += 30) {
      f.advance(30_000);
      const update = await f.call(
        'PUT',
        `jobs/${job.id}`,
        { status: 'running', events: [] },
        f.target,
      );
      expect(update.status).toBe(200);
      expect(update.body.status).toBe('running');
    }
    f.advance(1);
    expect((await f.call('GET', `jobs/${job.id}`)).body.status).toBe('error');
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const abandoned = { ...job, id: crypto.randomUUID() };
    expect((await f.call('POST', 'jobs', abandoned)).status).toBe(200);
    f.advance(45_001);
    expect((await f.call('GET', `jobs/${abandoned.id}`)).body.status).toBe('error');
  });
  it('routes plugin management to its owner without persisting configuration in workspace state', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      action: { kind: 'skill', path: '/skills/private-fixture/SKILL.md', enabled: false },
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'plugins',
      args,
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...args, action: { kind: 'raw', method: 'config/write' } },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(args);
    expect(JSON.stringify((await f.call('GET', 'state')).body)).not.toContain('private-fixture');
  });
  it('routes MCP OAuth jobs transiently and rejects arbitrary native protocol payloads', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      provider: 'codex',
      connectionId: crypto.randomUUID(),
      action: { kind: 'authenticate', name: 'docs' },
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'mcp',
      args,
    };
    expect(
      (await f.call('POST', 'jobs', { ...job, args: { ...args, nativeSessionId: 'foreign' } }))
        .status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body[0].args).toEqual(args);
    const result = {
      status: 'pending',
      authorizationUrl: 'https://example.com/authorize?state=synthetic-private',
      operationId: crypto.randomUUID(),
      servers: [],
    };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'state')).body)).not.toContain('synthetic-private');
    f.advance(600_001);
    expect((await f.call('GET', `jobs/${job.id}`)).status).toBe(404);
  });
  it('routes bounded steering jobs only to their target host and rejects extra payload fields', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'steer',
      args: {
        runId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        input: { id: crypto.randomUUID(), text: 'Keep the current files' },
      },
    };
    expect(
      (await f.call('POST', 'jobs', { ...job, args: { ...job.args, threadId: 'caller-supplied' } }))
        .status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('GET', 'jobs', undefined, f.source)).body).toEqual([]);
    const claimed = (await f.call('GET', 'jobs', undefined, f.target)).body;
    expect(claimed[0].args).toEqual(job.args);
    expect((await f.call('PUT', `jobs/${job.id}`, { status: 'complete' }, f.source)).status).toBe(
      404,
    );
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [] }, f.target)).status,
    ).toBe(200);
  });
  it('carries bounded reasoning alongside a full activity checkpoint', async () => {
    const f = await fixture(),
      id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    expect(
      (
        await f.call('POST', 'jobs', {
          id,
          source: f.source,
          target: f.target,
          method: 'run',
          args: { request: { runId: id, agent: { provider: 'codex' } } },
        })
      ).status,
    ).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const events = [
      ...Array.from({ length: 336 }, (_, i) => ({ kind: 'activity', text: `Activity ${i}` })),
      ...Array.from({ length: 64 }, (_, i) => ({
        kind: 'reasoning',
        id: `r${i}`,
        revision: 2,
        text: `Reasoning ${i}`,
        truncated: false,
      })),
    ];
    expect(
      (await f.call('PUT', `jobs/${id}`, { status: 'running', events }, f.target)).status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${id}`)).body.events).toEqual(events);
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${id}`,
          { status: 'running', events: Array(449).fill(events[0]) },
          f.target,
        )
      ).status,
    ).toBe(400);
  });
  it('routes bounded native instruction requests as transient jobs and rejects caller-supplied paths', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      conversationId: crypto.randomUUID(),
      provider: 'claude',
      connectionId: crypto.randomUUID(),
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'nativeInstructions',
      args,
    };
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          args: { ...args, path: '/another-profile/session.jsonl' },
        })
      ).status,
    ).toBe(400);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const result = {
      provider: 'claude',
      checkedAt: Date.now(),
      notice: 'Recorded',
      studioGuidance: 'App guidance',
      blocks: [
        {
          label: 'System prompt',
          text: 'Synthetic native prompt',
          capturedAt: null,
          version: 'fixture',
          model: null,
        },
      ],
    };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'workspace')).body)).not.toContain(
      'Synthetic native prompt',
    );
    f.advance(600_001);
    expect((await f.call('GET', `jobs/${job.id}`)).status).toBe(404);
  });
  it('routes tool output reads as transient jobs that never reach the workspace', async () => {
    const f = await fixture();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const args = {
      runId: crypto.randomUUID(),
      toolId: 'claude:toolu_01',
      connectionId: crypto.randomUUID(),
    };
    const job = {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'toolOutput',
      args,
    };
    for (const invalid of [
      { ...args, path: '/elsewhere/output.json' },
      { ...args, runId: '../run' },
      { ...args, toolId: '' },
      { ...args, toolId: 'a\nb' },
      { ...args, toolId: 'x'.repeat(241) },
      { ...args, full: 'yes' },
    ])
      expect((await f.call('POST', 'jobs', { ...job, args: invalid })).status).toBe(400);
    const image = { ...job, id: crypto.randomUUID(), method: 'toolOutputImage' };
    for (const invalid of [
      { ...args, index: -1 },
      { ...args, index: 1.5 },
      { ...args, index: 0, file: 'image-0.png' },
      args,
    ])
      expect((await f.call('POST', 'jobs', { ...image, args: invalid })).status).toBe(400);
    expect((await f.call('POST', 'jobs', { ...image, args: { ...args, index: 0 } })).status).toBe(
      200,
    );
    // Views of a model too large for one request name the model the same way, and nothing else:
    // the computer keeping it draws them itself.
    const views = { ...job, id: crypto.randomUUID(), method: 'toolOutputModelViews' };
    for (const invalid of [
      { ...args, index: -1 },
      { ...args, index: 0, renderer: 1 },
      { ...args, index: 0, views: ['UklGRg=='] },
      args,
    ])
      expect((await f.call('POST', 'jobs', { ...views, args: invalid })).status).toBe(400);
    expect((await f.call('POST', 'jobs', { ...views, args: { ...args, index: 0 } })).status).toBe(
      200,
    );
    expect(
      (
        await f.call('POST', 'jobs', {
          ...job,
          id: crypto.randomUUID(),
          args: { ...args, full: true },
        })
      ).status,
    ).toBe(200);
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    await f.call('GET', 'jobs', undefined, f.target);
    const result = { version: 2, toolId: args.toolId, stdout: 'Synthetic tool output\n' };
    expect(
      (await f.call('PUT', `jobs/${job.id}`, { status: 'complete', events: [], result }, f.target))
        .status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${job.id}`)).body.result).toEqual(result);
    expect(JSON.stringify((await f.call('GET', 'workspace')).body)).not.toContain(
      'Synthetic tool output',
    );
    // The requester has its result, and nothing else reads it, so it leaves at once.
    expect((await f.call('GET', `jobs/${job.id}`)).status).toBe(404);
    const drawn = {
      views: Array.from({ length: 8 }, () => ({
        mediaType: 'image/webp',
        data: 'UklGRg==',
        bytes: 4,
      })),
    };
    expect(
      (
        await f.call(
          'PUT',
          `jobs/${views.id}`,
          { status: 'complete', events: [], result: drawn },
          f.target,
        )
      ).status,
    ).toBe(200);
    expect((await f.call('GET', `jobs/${views.id}`)).body.result).toEqual(drawn);
    expect((await f.call('GET', `jobs/${views.id}`)).status).toBe(404);
  });
  it('keeps large read results only until they are read, within the storage budget', async () => {
    const f = await fixture({ jobUpdate: 3_000, jobStorage: 6_000 });
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const read = () => ({
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'toolOutputImage',
      args: {
        runId: crypto.randomUUID(),
        toolId: 'claude:toolu_01',
        connectionId: crypto.randomUUID(),
        index: 0,
      },
    });
    const image = (size: number) => ({ mediaType: 'image/png', data: 'A'.repeat(size), bytes: 1 });
    const [first, second, third] = [read(), read(), read()];
    for (const job of [first, second, third]) await f.call('POST', 'jobs', job);
    await f.call('GET', 'jobs', undefined, f.target);
    const finish = (id: string, size: number) =>
      f.call(
        'PUT',
        `jobs/${id}`,
        { status: 'complete', events: [], result: image(size) },
        f.target,
      );
    // An update past its limit is refused before it is read.
    expect((await finish(first.id, 4_000)).body.code).toBe('too_large');
    expect((await finish(first.id, 2_000)).status).toBe(200);
    expect((await finish(second.id, 2_000)).status).toBe(200);
    // Two held results leave no room for a third until one is read.
    expect((await finish(third.id, 2_000)).status).toBe(429);
    expect((await f.call('GET', `jobs/${first.id}`)).body.result).toEqual(image(2_000));
    expect((await finish(third.id, 2_000)).status).toBe(200);
    // A result its requester never reads leaves a minute after it finished.
    f.advance(60_001);
    expect((await f.call('GET', `jobs/${second.id}`)).status).toBe(404);
  });
  it('keeps healthy native workflows past one reply deadline while expiring abandoned work', async () => {
    const f = await fixture(),
      id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    await f.call('POST', 'jobs', {
      id,
      source: f.source,
      target: f.target,
      method: 'run',
      args: { request: { runId: id, agent: { provider: 'claude' } } },
    });
    await f.call('GET', 'jobs', undefined, f.target);
    for (let i = 0; i < 13; i++) {
      f.advance(30_000);
      const updated = await f.call(
        'PUT',
        `jobs/${id}`,
        {
          status: 'running',
          events: [
            {
              kind: 'nativeworkflow',
              nativeWorkflows: { ...nativeWorkflowFixture(), revision: i },
            },
          ],
        },
        f.target,
      );
      expect(updated.body.status).toBe('running');
    }
    expect(
      (await f.call('GET', `jobs/${id}`)).body.events[0].nativeWorkflows.runs[0].agents[0].status,
    ).toBe('complete');
    f.advance(46_000);
    expect((await f.call('GET', `jobs/${id}`)).body.status).toBe('error');
  });
  it('retains an empty relay identity across restart before the first workspace write', async () => {
    const f = await fixture();
    const before = (await f.call('GET', 'state')).body;
    expect(before.revision).toBe(0);
    expect(before.workspace).toEqual(emptyShared());
    const restarted = createRelay({ token: f.token, directory: f.directory });
    await new Promise<void>((resolve) => restarted.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(restarted.address() as { port: number }).port}/v1/state`,
        {
          headers: { authorization: `Bearer ${f.token}`, 'x-environment-id': f.source },
        },
      );
      expect(await response.json()).toEqual(before);
    } finally {
      restarted.closeAllConnections();
      await new Promise<void>((resolve) => restarted.close(() => resolve()));
    }
  });
  it('requires authentication, rejects stale writes, and persists acknowledged workspace data', async () => {
    const f = await fixture();
    expect((await f.call('GET', 'state', undefined, f.source, 'wrong')).status).toBe(401);
    const workspace = emptyShared();
    workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    expect((await f.call('PUT', 'state', { revision: 0, workspace })).status).toBe(200);
    expect((await f.call('PUT', 'state', { revision: 0, workspace: emptyShared() })).status).toBe(
      409,
    );
    const saved = JSON.parse(readFileSync(join(f.directory, 'workspace.json'), 'utf8'));
    expect(saved.revision).toBe(1);
    expect(saved.workspace.fleet.computers[0].name).toBe('Desktop');
    expect(JSON.stringify(saved)).not.toContain(f.token);
    const restarted = createRelay({ token: f.token, directory: f.directory });
    restarted.close();
  });
  it('reports the state revision to pollers without the workspace', async () => {
    const f = await fixture();
    expect((await f.call('GET', 'state/revision', undefined, f.source, 'wrong')).status).toBe(401);
    const { instanceId } = (await f.call('GET', 'state')).body;
    // It names the workspace, which pairing needs, and carries none of its data.
    expect((await f.call('GET', 'state/revision')).body).toEqual({
      instanceId,
      workspaceId: 'owner',
      revision: 0,
      images: 1,
    });
    const workspace = emptyShared();
    workspace.fleet.computers.push({ id: crypto.randomUUID(), name: 'Desktop' });
    expect((await f.call('PUT', 'state', { revision: 0, workspace })).status).toBe(200);
    expect((await f.call('GET', 'state/revision')).body).toEqual({
      instanceId,
      workspaceId: 'owner',
      revision: 1,
      images: 1,
    });
  });
  it('routes work to the exact environment, claims once, streams progress, cancels and deduplicates submissions', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    const job = {
      id,
      source: f.source,
      target: f.target,
      method: 'run',
      args: { request: { runId: id } },
    };
    expect((await f.call('POST', 'jobs', job)).status).toBe(200);
    expect((await f.call('POST', 'jobs', job)).body.id).toBe(id);
    expect((await f.call('GET', 'jobs')).body).toEqual([]);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toHaveLength(1);
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toEqual([]);
    expect((await f.call('PUT', `jobs/${id}`, { status: 'running', events: [] })).status).toBe(404);
    await f.call(
      'PUT',
      `jobs/${id}`,
      { status: 'running', events: [{ kind: 'text', text: 'Hello' }] },
      f.target,
    );
    expect((await f.call('GET', `jobs/${id}`)).body.events[0].text).toBe('Hello');
    await f.call('POST', `jobs/${id}/cancel`);
    expect((await f.call('GET', `jobs/${id}`, undefined, f.target)).body.cancel).toBe(true);
    await f.call('PUT', `jobs/${id}`, { status: 'cancelled', events: [] }, f.target);
    expect((await f.call('POST', 'jobs', job)).body.status).toBe('cancelled');
  });
  it('expires presence and abandoned jobs without replaying them', async () => {
    const f = await fixture();
    const id = crypto.randomUUID();
    await f.call(
      'POST',
      'heartbeat',
      { environmentId: f.target, connections: [], running: [] },
      f.target,
    );
    await f.call('POST', 'jobs', {
      id,
      source: f.source,
      target: f.target,
      method: 'usage',
      args: {},
    });
    await f.call('GET', 'jobs', undefined, f.target);
    f.advance(46_000);
    const peers = await f.call('POST', 'heartbeat', {
      environmentId: f.source,
      connections: [],
      running: [],
    });
    expect(peers.body.find((p: any) => p.environmentId === f.target).online).toBe(false);
    expect((await f.call('GET', `jobs/${id}`)).body.status).toBe('error');
    expect((await f.call('GET', 'jobs', undefined, f.target)).body).toEqual([]);
    const offline = await f.call('POST', 'jobs', {
      id: crypto.randomUUID(),
      source: f.source,
      target: f.target,
      method: 'run',
      args: {},
    });
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('host_offline');
  });
  it('preserves corrupt disk state and rejects invalid payloads', async () => {
    const f = await fixture();
    expect((await f.call('PUT', 'state', { revision: 0, workspace: { fleet: null } })).status).toBe(
      400,
    );
    writeFileSync(join(f.directory, 'workspace.json'), '{invalid');
    expect(() => createRelay({ token: f.token, directory: f.directory })).toThrow('preserved');
    expect(readFileSync(join(f.directory, 'workspace.json'), 'utf8')).toBe('{invalid');
  });
});
