import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthenticityError,
  allowedUrl,
  authenticate,
  check,
  emptyState,
  installerName,
  parseRelease,
  publicKeyId,
  readConfig,
  retry,
  runningReplies,
  type State,
  type System,
} from '../../scripts/vps/update.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

// A minisign signer matching the Tauri CLI's prehashed format, with a throwaway key.
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
  ).toString('base64');
  const signData = (data: Buffer, version: string) => {
    const comment = `timestamp:1790120917\tfile:setup.exe\tversion:${version}`;
    const bytes = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const global = sign(null, Buffer.concat([bytes, Buffer.from(comment)]), privateKey);
    const box = Buffer.concat([Buffer.from('ED'), id, bytes]).toString('base64');
    return Buffer.from(
      `untrusted comment: signature\n${box}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
    ).toString('base64');
  };
  return { key, id: Buffer.from(id).reverse().toString('hex').toUpperCase(), signData };
}

const trusted = signer();
const installer = Buffer.from('Agent Studio installer fixture');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const config = readConfig({});
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(40));

function githubRelease(version: string, data = installer) {
  const name = installerName(version);
  const url = `https://github.com/simpx-tech/agent-studio/releases/download/v${version}/${name}`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name, size: data.length, digest: `sha256:${sha(data)}`, browser_download_url: url },
      { name: `${name}.sig`, size: 420, browser_download_url: `${url}.sig` },
      { name: 'latest.json', size: 900, browser_download_url: `${url}.json` },
    ],
  };
}

function fake() {
  let clock = Date.parse('2026-09-23T12:00:00Z');
  const calls: string[] = [];
  const logs: string[] = [];
  const env = {
    state: { ...emptyState(), trustedKey: trusted.key } as State,
    latest: undefined as unknown,
    commits: {} as Record<string, string>,
    files: {} as Record<string, Buffer>,
    saved: new Map<string, Buffer>(),
    staged: new Set<string>(),
    current: A as string | undefined,
    active: true,
    running: 0,
    healthy: (_release?: string) => true,
    buildError: undefined as Error | undefined,
    publishError: undefined as Error | undefined,
    releaseKeys: {} as Record<string, string>,
  };
  const system: System = {
    now: () => new Date(clock),
    log: (text) => logs.push(text),
    sleep: async (ms) => {
      clock += ms;
    },
    readState: () => structuredClone(env.state),
    writeState: (state) => {
      env.state = structuredClone(state);
    },
    latestRelease: async () => env.latest,
    commitOf: async (tag) => env.commits[tag],
    download: async (asset) => {
      calls.push(`download ${asset.name}`);
      const data = env.files[asset.url];
      if (!data) throw new Error(`HTTP 404 from ${asset.url}.`);
      return data;
    },
    savedInstaller: (commit) => env.saved.get(commit),
    saveInstaller: (commit, data) => env.saved.set(commit, data),
    discard: (commit) => {
      calls.push(`discard ${commit}`);
      env.saved.delete(commit);
      env.staged.delete(commit);
    },
    staged: (commit) => env.staged.has(commit),
    build: async (commit) => {
      calls.push(`build ${commit}`);
      if (env.buildError) throw env.buildError;
      env.staged.add(commit);
    },
    releaseKey: (commit) => env.releaseKeys[commit],
    updaterChanged: () => false,
    currentRelease: () => env.current,
    serviceActive: () => env.active,
    runningReplies: () => env.running,
    stopService: () => {
      calls.push('stop');
      env.active = false;
    },
    startService: () => {
      calls.push('start');
      env.active = true;
    },
    backup: (commit) => {
      calls.push(`backup ${commit}`);
      return `/var/backups/agent-studio/pre-${commit}.tar.gz`;
    },
    select: (release) => {
      calls.push(`select ${release}`);
      env.current = release;
    },
    restore: (backup, commit) => {
      calls.push(`restore ${backup}`);
      return `/var/lib/.agent-studio-failed-${commit.slice(0, 12)}`;
    },
    probe: async () => (env.active && env.healthy(env.current) ? 401 : undefined),
    publishInstaller: async (commit, data) => {
      calls.push(`publish ${commit} ${data.length}`);
      if (env.publishError) throw env.publishError;
      return 'published';
    },
    prune: (commit, backup) => {
      calls.push(`prune ${commit} ${backup ?? ''}`.trim());
    },
  };
  const publish = (
    version: string,
    commit: string,
    options: { key?: ReturnType<typeof signer>; signedVersion?: string } = {},
  ) => {
    const release = githubRelease(version);
    const signature = (options.key ?? trusted).signData(
      installer,
      options.signedVersion ?? version,
    );
    env.latest = release;
    env.commits[release.tag_name] = commit;
    env.files[release.assets[0].browser_download_url] = installer;
    env.files[release.assets[1].browser_download_url] = Buffer.from(signature);
  };
  return {
    system,
    calls,
    logs,
    env,
    publish,
    advance: (ms: number) => {
      clock += ms;
    },
    run: (options: Partial<typeof config> = {}) => check(system, { ...config, ...options }),
  };
}

describe('release discovery', () => {
  it('reads the signed Windows installer from the latest release', () => {
    const release = parseRelease(githubRelease('0.2.1'));
    expect(release).toMatchObject({
      tag: 'v0.2.1',
      version: '0.2.1',
      installer: { name: 'Agent-Studio_0.2.1_x64-setup.exe', size: installer.length },
      signature: { name: 'Agent-Studio_0.2.1_x64-setup.exe.sig' },
    });
    expect(release.installer.sha256).toBe(sha(installer));
  });

  it('rejects drafts, unversioned tags, missing installers and unsafe URLs', () => {
    const release = githubRelease('0.2.1');
    expect(() => parseRelease({ ...release, tag_name: 'nightly' })).toThrow(/v<x.y.z>/);
    expect(() => parseRelease({ ...release, draft: true })).toThrow(/draft/);
    expect(() => parseRelease({ ...release, assets: release.assets.slice(1) })).toThrow(
      /no Agent-Studio_0.2.1_x64-setup.exe/,
    );
    const [asset, ...rest] = release.assets;
    const remote = { ...asset, browser_download_url: 'http://example.com/setup.exe' };
    expect(() => parseRelease({ ...release, assets: [remote, ...rest] })).toThrow(/URL/);
    expect(() => parseRelease({ ...release, assets: [{ ...asset, size: 0 }, ...rest] })).toThrow(
      /size/,
    );
    expect(allowedUrl('http://127.0.0.1:4398/x')).toBe(true);
    expect(allowedUrl('file:///etc/passwd')).toBe(false);
  });

  it('accepts only loopback overrides for plain HTTP', () => {
    expect(config).toMatchObject({
      api: 'https://api.github.com',
      repo: 'simpx-tech/agent-studio',
      root: '/opt/agent-studio',
      port: 4317,
    });
    expect(readConfig({ AGENT_STUDIO_UPDATE_API: 'http://127.0.0.1:4398/' }).api).toBe(
      'http://127.0.0.1:4398',
    );
    expect(() => readConfig({ AGENT_STUDIO_UPDATE_API: 'http://example.com' })).toThrow();
    expect(() => readConfig({ AGENT_STUDIO_UPDATE_SERVICE: 'relay; reboot' })).toThrow();
  });
});

describe('installer authentication', () => {
  const release = parseRelease(githubRelease('0.2.1'));

  it('accepts the trusted key’s signature for the release version', () => {
    expect(() =>
      authenticate(installer, trusted.signData(installer, '0.2.1'), release, trusted.key),
    ).not.toThrow();
    expect(publicKeyId(trusted.key)).toBe(trusted.id);
    expect(publicKeyId(Buffer.from('not a key').toString('base64'))).toBeUndefined();
  });

  it('treats another key or version as untrusted, and corruption as retryable', () => {
    const other = signer();
    expect(() =>
      authenticate(installer, other.signData(installer, '0.2.1'), release, trusted.key),
    ).toThrow(AuthenticityError);
    expect(() =>
      authenticate(installer, trusted.signData(installer, '0.2.0'), release, trusted.key),
    ).toThrow(/signed for 0.2.0/);
    const corrupt = Buffer.from(installer);
    corrupt[0] ^= 1;
    let error: unknown;
    try {
      authenticate(corrupt, trusted.signData(corrupt, '0.2.1'), release, trusted.key);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(/SHA-256/);
    expect(error).not.toBeInstanceOf(AuthenticityError);
  });
});

describe('running replies', () => {
  it('counts running replies in the owner and member workspace checkpoints', () => {
    const data = mkdtempSync(join(tmpdir(), 'studio-vps-'));
    temporary.push(data);
    const workspace = (statuses: string[]) =>
      JSON.stringify({
        workspace: { conversations: [{ messages: statuses.map((status) => ({ status })) }] },
      });
    writeFileSync(join(data, 'workspace.json'), workspace(['done', 'running']));
    const member = join(data, 'workspaces', '0f0e0d0c-0b0a-4908-8706-050403020100');
    mkdirSync(member, { recursive: true });
    writeFileSync(join(member, 'workspace.json'), workspace(['running', 'failed']));
    mkdirSync(join(data, 'workspaces', 'notes'));
    writeFileSync(join(data, 'workspaces', 'notes', 'workspace.json'), workspace(['running']));
    expect(runningReplies(data)).toBe(2);
    expect(runningReplies(join(data, 'missing'))).toBe(0);
  });
});

describe('automatic updates', () => {
  it('does nothing until a release is published', async () => {
    const f = fake();
    await f.run();
    expect(f.calls).toEqual([]);
    expect(f.env.state.release).toBeUndefined();
  });

  it('builds a signed release before restarting, then publishes its installer', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    await f.run();
    expect(f.calls).toEqual([
      'download Agent-Studio_0.2.1_x64-setup.exe',
      'download Agent-Studio_0.2.1_x64-setup.exe.sig',
      `build ${B}`,
      'stop',
      `backup ${B}`,
      `select ${B}`,
      'start',
      `publish ${B} ${installer.length}`,
      `discard ${B}`,
    ]);
    expect(f.env.state.release).toMatchObject({
      tag: 'v0.2.1',
      commit: B,
      phase: 'active',
      previous: A,
      download: 'published',
    });
    expect(f.env.state.history).toEqual([
      expect.objectContaining({ tag: 'v0.2.1', commit: B, backup: expect.stringContaining(B) }),
    ]);
    expect(f.logs.join('\n')).toMatch(/Found v0.2.1[\s\S]*Activated v0.2.1/);
    f.calls.length = 0;
    await f.run();
    expect(f.calls).toEqual([]);
  });

  it('refuses installers from another key or version without building anything', async () => {
    for (const options of [{ key: signer() }, { signedVersion: '0.2.0' }]) {
      const f = fake();
      f.publish('0.2.1', B, options);
      await expect(f.run()).rejects.toThrow(/Could not stage v0.2.1: .*(not trusted|signed for)/);
      expect(f.env.state.release).toMatchObject({ phase: 'failed' });
      expect(f.calls.some((call) => call.startsWith('build') || call === 'stop')).toBe(false);
      await f.run();
      expect(f.calls.filter((call) => call.startsWith('download'))).toHaveLength(2);
    }
  });

  it('waits for a trusted key without spending attempts', async () => {
    const f = fake();
    delete f.env.state.trustedKey;
    f.publish('0.2.1', B);
    await expect(f.run()).rejects.toThrow(/No updater key is trusted/);
    expect(f.env.state.release).toMatchObject({ phase: 'pending', attempts: 0 });
  });

  it('retries failed builds with backoff, gives up after three attempts, and retries on request', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.buildError = new Error('npm ci failed');
    await expect(f.run()).rejects.toThrow(/retrying after .*npm ci failed/);
    await f.run();
    expect(f.calls.filter((call) => call.startsWith('build'))).toHaveLength(1);
    f.advance(10 * 60 * 1000);
    await expect(f.run()).rejects.toThrow(/retrying after/);
    f.advance(60 * 60 * 1000);
    await expect(f.run()).rejects.toThrow(/^Could not stage v0.2.1: npm ci failed/);
    expect(f.env.state.release).toMatchObject({ phase: 'failed', attempts: 3 });
    await f.run();
    expect(f.calls.filter((call) => call.startsWith('build'))).toHaveLength(3);

    f.env.buildError = undefined;
    expect(retry(f.env.state)).toMatch(/tried again/);
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
    expect(f.env.current).toBe(B);
  });

  it('waits up to two hours for running replies before restarting the relay', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.running = 2;
    await f.run();
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'staged', waiting: 'replies' });
    expect(f.calls).not.toContain('stop');
    expect(f.logs.filter((line) => line.includes('2 replies are running'))).toHaveLength(1);
    f.env.running = 0;
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });

    const stale = fake();
    stale.publish('0.2.1', B);
    stale.env.running = 1;
    await stale.run();
    stale.advance(2 * 60 * 60 * 1000);
    await stale.run();
    expect(stale.env.state.release).toMatchObject({ phase: 'active' });
    expect(stale.logs).toContain('Activating v0.2.1 although 1 reply is still marked running.');
  });

  it('leaves a stopped relay alone until it runs again', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.active = false;
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'staged', waiting: 'service' });
    expect(f.calls).not.toContain('start');
    f.env.active = true;
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
  });

  it('restores the previous release and its data when the new one fails its health check', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.healthy = (release) => release !== B;
    await expect(f.run()).rejects.toThrow(`v0.2.1 failed its health check; ${A} was restored.`);
    expect(f.calls.slice(f.calls.indexOf('stop'))).toEqual([
      'stop',
      `backup ${B}`,
      `select ${B}`,
      'start',
      'stop',
      `restore /var/backups/agent-studio/pre-${B}.tar.gz`,
      `select ${A}`,
      'start',
    ]);
    expect(f.env.current).toBe(A);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.state.history).toEqual([]);

    const broken = fake();
    broken.publish('0.2.1', B);
    broken.env.healthy = () => false;
    await expect(broken.run()).rejects.toThrow(/Intervene manually/);
  });

  it('records a release that is already live without restarting it', async () => {
    const f = fake();
    f.env.current = B;
    f.publish('0.2.1', B);
    await f.run();
    expect(f.calls).not.toContain('stop');
    expect(f.calls.some((call) => call.startsWith('build'))).toBe(false);
    expect(f.env.state.release).toMatchObject({ phase: 'active', download: 'published' });
  });

  it('never downgrades, and replaces a release still waiting to activate', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    await f.run();
    f.publish('0.2.0', C);
    await f.run();
    await f.run();
    expect(f.env.state.release).toMatchObject({ tag: 'v0.2.1', phase: 'active' });
    expect(f.logs.filter((line) => line.startsWith('Not installing v0.2.0'))).toHaveLength(1);

    const waiting = fake();
    waiting.publish('0.2.1', B);
    waiting.env.running = 1;
    await waiting.run();
    waiting.publish('0.2.2', C);
    await waiting.run();
    expect(waiting.calls).toContain(`discard ${B}`);
    expect(waiting.env.state.release).toMatchObject({ tag: 'v0.2.2', phase: 'staged' });
  });

  it('ignores a malformed latest release once', async () => {
    const f = fake();
    f.env.latest = { ...githubRelease('0.2.1'), assets: [] };
    await f.run();
    await f.run();
    expect(f.logs).toEqual([
      'Ignoring release v0.2.1: The release has no Agent-Studio_0.2.1_x64-setup.exe.',
    ]);
  });

  it('follows updater key rotation like installed apps', async () => {
    const f = fake();
    const rotated = signer();
    f.env.releaseKeys[B] = rotated.key;
    f.publish('0.2.1', B);
    await f.run();
    expect(f.env.state.trustedKey).toBe(rotated.key);
    expect(f.logs).toContain(`Trusting updater key ${rotated.id} from v0.2.1 from now on.`);
    f.publish('0.2.2', C, { key: rotated });
    await f.run();
    expect(f.env.state.release).toMatchObject({ tag: 'v0.2.2', phase: 'active' });
  });

  it('prunes the oldest updater releases but keeps the current and previous ones', async () => {
    const f = fake();
    for (const [version, commit] of [
      ['0.2.1', B],
      ['0.2.2', C],
      ['0.2.3', D],
    ] as const) {
      f.publish(version, commit);
      await f.run({ keep: 2 });
    }
    expect(f.calls.filter((call) => call.startsWith('prune'))).toEqual([
      `prune ${B} /var/backups/agent-studio/pre-${B}.tar.gz`,
    ]);
    expect(f.env.state.history.map((entry) => entry.commit)).toEqual([D, C]);
  });

  it('retries publishing the Windows installer', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.publishError = new Error('The relay did not serve the new installer.');
    await expect(f.run()).rejects.toThrow(/Could not publish the v0.2.1 Windows installer/);
    expect(f.env.state.release).toMatchObject({ phase: 'active', download: 'failed' });
    f.env.publishError = undefined;
    await f.run();
    expect(f.env.state.release).toMatchObject({ download: 'published', downloadAttempts: 2 });
  });
});
