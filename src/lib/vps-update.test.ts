import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthenticityError,
  BackupError,
  allowedUrl,
  authenticate,
  check,
  appImageName,
  busPath,
  emptyState,
  fileDigest,
  healthy,
  hostUnit,
  installerName,
  listTree,
  liveness,
  lockArguments,
  makeBackup,
  manifestOf,
  packBackup,
  parseRelease,
  parseService,
  relayKeyIn,
  publicKeyId,
  readConfig,
  readJournal,
  readManifest,
  replaceData,
  restoreBackup,
  restoreDone,
  retry,
  runningReplies,
  spaceShort,
  trialArguments,
  treeDifference,
  verifyBackup,
  writeJournal,
  type Archiver,
  type Recovered,
  type State,
  type System,
  type Unit,
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
const appImage = Buffer.from('Agent Studio AppImage fixture');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
// The relay alone; the server's host has tests of its own below.
const config = readConfig({ AGENT_STUDIO_UPDATE_HOST: 'off' });
const host = readConfig({}).host;
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(40));

function githubRelease(version: string, data = installer, linux = false) {
  const name = installerName(version);
  const base = `https://github.com/simpx-tech/agent-studio/releases/download/v${version}`;
  const url = `${base}/${name}`;
  const image = appImageName(version);
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name, size: data.length, digest: `sha256:${sha(data)}`, browser_download_url: url },
      { name: `${name}.sig`, size: 420, browser_download_url: `${url}.sig` },
      { name: 'latest.json', size: 900, browser_download_url: `${url}.json` },
      ...(linux
        ? [
            {
              name: image,
              size: appImage.length,
              digest: `sha256:${sha(appImage)}`,
              browser_download_url: `${base}/${image}`,
            },
            { name: `${image}.sig`, size: 420, browser_download_url: `${base}/${image}.sig` },
          ]
        : []),
    ],
  };
}

/** What a started relay does, by the time since its start in milliseconds. */
type Behaviour = {
  /** It ends at once, each time its service starts it. */
  crash?: boolean;
  /** When it begins to answer; never when infinite. */
  listens?: number;
  /** It does nothing at all, or nothing from then on: no CPU time, nothing read or written. */
  idle?: boolean | number;
  /** Each answer takes this long. */
  stall?: number;
  /** From then on it answers nothing. */
  mute?: number;
  /** From then on it answers again. */
  speaks?: number;
  /** It ends then. */
  dies?: number;
};

/** An updater that was killed: nothing it would still do happens, and nothing more is saved. */
class Killed extends Error {}

function fake() {
  let clock = Date.parse('2026-09-23T12:00:00Z');
  // The relay and the trial: which release each runs and since when.
  const live = { release: undefined as string | undefined, since: clock };
  const tried = { release: undefined as string | undefined, since: clock };
  const starts = new Map<string, number>();
  const behaviour = (trial?: boolean): Behaviour => {
    const release = trial ? tried.release : live.release;
    if (!trial && !env.healthy(release)) return { crash: true };
    return env.relay(release, !!trial, starts.get(release ?? '') ?? 0);
  };
  const age = (trial?: boolean) => clock - (trial ? tried : live).since;
  const gone = (trial?: boolean) => {
    const relay = behaviour(trial);
    return (
      (relay.crash && age(trial) > 0) || (relay.dies !== undefined && age(trial) >= relay.dies)
    );
  };
  const calls: string[] = [];
  // What was done to backups once the relay ran: compressed, and the archive removed.
  const tidied: string[] = [];
  const logs: string[] = [];
  // How often the relay's service was started: each start is another process.
  let started = 0;
  // Backups by their path, and the folders that keep replaced data by their name. A backup is
  // a file: one that was removed, or never finished, cannot be put back.
  const backups = new Map<string, string[]>();
  const kept = new Map<string, string[]>();
  // The backup made for an activation, by when the activation began.
  const made = new Map<string, string>();
  // The host's process: the version it runs, which a new link alone does not change.
  let hostProcess: string | undefined | null = null;
  const env = {
    state: { ...emptyState(), trustedKey: trusted.key } as State,
    latest: undefined as unknown,
    commits: {} as Record<string, string>,
    files: {} as Record<string, Buffer>,
    saved: new Map<string, Buffer>(),
    staged: new Set<string>(),
    current: A as string | undefined,
    /** Something that selects no release is at the current link's path. */
    foreign: false,
    active: true,
    running: 0,
    healthy: (_release?: string) => true,
    /** What a release's relay does: in its trial, or on its nth start as the service. */
    relay: (_release: string | undefined, _trial: boolean, _start: number): Behaviour => ({}),
    /** The private data: the releases whose relays wrote to it, each time one started. */
    data: [] as string[],
    kept,
    backups,
    /** Backups that are no longer the archive that was written. */
    damaged: new Set<string>(),
    /** The state just read is not the journal as it was last written. */
    recovered: undefined as Recovered | undefined,
    /** A command of the updater that never returns, by the method that runs it. */
    hangs: undefined as string | undefined,
    /** systemd does not answer the next looks at the relay's service. */
    unseen: 0,
    lastWords: undefined as string | undefined,
    trialError: undefined as Error | undefined,
    /** The trial's unit does not stop. */
    trialStuck: false,
    preflightError: undefined as Error | undefined,
    backupError: undefined as Error | undefined,
    buildError: undefined as Error | undefined,
    publishError: undefined as Error | undefined,
    releaseKeys: {} as Record<string, string>,
    // The server's host.
    byTag: {} as Record<string, unknown>,
    hostStaged: new Set<string>(),
    serverCheck: true,
    host: undefined as string | undefined,
    hostUp: (_version?: string) => true,
    provisionError: undefined as Error | undefined,
    relayKey: undefined as string | undefined,
    hostKey: undefined as string | undefined,
  };
  const system: System = {
    now: () => new Date(clock),
    log: (text) => logs.push(text),
    sleep: async (ms) => {
      clock += ms;
    },
    readState: () => structuredClone(env.state),
    recovered: () => env.recovered,
    writeState: (state) => {
      env.state = structuredClone(state);
      env.recovered = undefined;
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
    newServer: () => env.current === undefined && !env.foreign,
    deselect: () => {
      calls.push('deselect');
      env.current = undefined;
    },
    // A service whose relay ended is being started again, which systemd does not call active.
    serviceActive: () => env.active && !gone(),
    unit: (trial): Unit | undefined => {
      if (env.unseen > 0) {
        env.unseen--;
        return undefined;
      }
      if (trial ? !tried.release : !env.active) return { state: 'inactive', restarts: 0, pid: 0 };
      // The trial's unit has nothing start it again.
      if (gone(trial))
        return trial
          ? { state: 'failed', restarts: 0, pid: 0, result: 'exit-code 1' }
          : { state: 'activating', restarts: 1, pid: 0, result: 'exit-code 1' };
      const idle = behaviour(trial).idle;
      const worked = idle === true ? 0 : Math.min(age(trial), idle || Infinity);
      const process = trial ? tried : live;
      return {
        state: 'active',
        restarts: 0,
        // Each start is another process.
        pid: 100 + (trial ? 0 : started),
        cpu: worked,
        io: worked * 1000,
        started: process.since,
        ...(trial || !process.release ? {} : { release: process.release }),
      };
    },
    lastWords: () => env.lastWords,
    startTrial: (commit) => {
      calls.push(`trial ${commit}`);
      if (env.trialStuck) throw new Error('agent-studio-trial did not stop');
      if (env.trialError) throw env.trialError;
      tried.release = commit;
      tried.since = clock;
    },
    endTrial: () => {
      if (!tried.release) return;
      if (env.trialStuck) throw new Error('agent-studio-trial did not stop');
      calls.push('end trial');
      tried.release = undefined;
    },
    runningReplies: () => env.running,
    stopService: () => {
      calls.push('stop');
      env.active = false;
    },
    startService: () => {
      calls.push('start');
      started++;
      env.active = true;
      live.release = env.current;
      live.since = clock;
      if (env.current) {
        starts.set(env.current, (starts.get(env.current) ?? 0) + 1);
        env.data.push(env.current);
      }
    },
    preflight: () => {
      if (env.preflightError) throw env.preflightError;
    },
    backup: (commit, began, behind) => {
      calls.push(`backup ${commit}`);
      if (env.backupError) throw env.backupError;
      // The one an updater made for this activation and could not record, while the data is
      // as it holds it, or whatever the data holds when the release may have run on it since.
      const before = began ? made.get(began) : undefined;
      const holds = before ? backups.get(before) : undefined;
      if (before && holds && (behind || holds.join() === env.data.join())) return before;
      let path = `/var/backups/agent-studio/pre-${commit}.tar`;
      for (let copy = 2; backups.has(path) || backups.has(`${path}.gz`); copy++)
        path = `/var/backups/agent-studio/pre-${commit}-${copy}.tar`;
      backups.set(path, [...env.data]);
      if (began) made.set(began, path);
      return path;
    },
    // Like gzip beside the archive: the copy is published, and the archive stays until it is
    // removed. A state that names an archive the updater removed too early names nothing.
    compress: (backup) => {
      tidied.push(`compress ${backup}`);
      const holds = backups.get(backup);
      if (!holds || env.damaged.has(backup)) throw new Error(`${backup} cannot be read.`);
      backups.set(`${backup}.gz`, holds);
      return `${backup}.gz`;
    },
    removeBackup: (backup) => {
      tidied.push(`remove ${backup}`);
      backups.delete(backup);
    },
    select: (release) => {
      calls.push(`select ${release}`);
      env.current = release;
    },
    restore: (backup, keep) => {
      calls.push(`restore ${backup}`);
      const folder = `/var/lib/.agent-studio-failed-${keep}`;
      // Done again under the same name, it replaces nothing a second time.
      if (!kept.has(folder)) {
        const holds = backups.get(backup);
        // Checked before anything moves: the data stays, and nothing is put aside.
        if (!holds) throw new BackupError('it is missing');
        if (env.damaged.has(backup))
          throw new BackupError('it holds 1024 bytes where 20480 were written');
        kept.set(folder, env.data);
        env.data = [...holds];
      }
      return folder;
    },
    restored: (keep) => kept.has(`/var/lib/.agent-studio-failed-${keep}`),
    probe: async (trial) => {
      if (trial ? !tried.release : !env.active) return undefined;
      const relay = behaviour(trial);
      if (relay.crash || gone(trial) || age(trial) < (relay.listens ?? 0)) return undefined;
      if (
        relay.mute !== undefined &&
        age(trial) >= relay.mute &&
        age(trial) < (relay.speaks ?? Infinity)
      ) {
        // A probe waits its 30 seconds for an answer that does not come.
        clock += 30_000;
        return undefined;
      }
      clock += relay.stall ?? 0;
      return 401;
    },
    publishInstaller: async (commit, data) => {
      calls.push(`publish ${commit} ${data.length}`);
      if (env.publishError) throw env.publishError;
      return 'published';
    },
    prune: (commit, backup) => {
      calls.push(`prune ${commit} ${backup ?? ''}`.trim());
    },
    releaseByTag: async (tag) => {
      calls.push(`release ${tag}`);
      return env.byTag[tag];
    },
    hostStaged: (version) => env.hostStaged.has(version),
    extractHost: async (version, data) => {
      calls.push(`extract host ${version} ${data.length}`);
      if (!env.serverCheck) return false;
      env.hostStaged.add(version);
      return true;
    },
    currentHost: () => env.host,
    hostPackages: async () => {
      calls.push('host packages');
    },
    provisionHost: async () => {
      calls.push('provision host');
      if (env.provisionError) throw env.provisionError;
    },
    selectHost: (version) => {
      calls.push(`select host ${version}`);
      // The process that runs is the one from before, until the host is restarted.
      if (hostProcess === null) hostProcess = env.host;
      env.host = version;
    },
    hostActive: () => !!env.host && env.hostUp(env.host),
    hostRuns: (version) => {
      const runs = hostProcess === null ? env.host : hostProcess;
      return env.host === version && runs === version && env.hostUp(version);
    },
    restartHost: () => {
      calls.push('restart host');
      hostProcess = env.host;
    },
    stopHost: () => {
      calls.push('stop host');
    },
    pruneHost: (keep) => {
      calls.push(`prune host ${keep.join(' ')}`);
    },
    relayKey: () => env.relayKey,
    hostKey: () => env.hostKey,
    writeHostKey: (key) => {
      calls.push('write host key');
      env.hostKey = key;
    },
  };
  // The updater as a process that can be killed: before or after its nth call of a method.
  // Once dead, every call throws, so nothing it still tries happens and no state is written.
  let dead = false;
  let kill: { method: string; nth: number; before: boolean } | undefined;
  // Its unit, which has no deadline and a watchdog: the updater's own code running is a sign
  // of life, which it gives whenever it waits (a sleep, a probe) and not while a command it
  // runs holds it. An updater without one for `hungAfter` is ended, as systemd ends the unit.
  let unit: ReturnType<typeof liveness> | undefined;
  const counts = new Map<string, number>();
  const process = new Proxy(system, {
    get(target, name: string) {
      const method = target[name as keyof System] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        if (unit && !unit.alive(clock)) dead = true;
        if (dead) throw new Killed(`killed (${name})`);
        if (env.hangs === name) {
          // The command never returns: time passes, and nothing of the updater runs.
          env.hangs = undefined;
          clock += 60 * 60_000;
          dead = !!unit;
          if (dead) throw new Killed(`hung in ${name}`);
        }
        if (unit && (name === 'sleep' || name === 'probe')) {
          const waited = method(...args) as Promise<unknown>;
          return waited.then((result) => {
            unit?.beat(clock);
            return result;
          });
        }
        counts.set(name, (counts.get(name) ?? 0) + 1);
        const now = kill?.method === name && --kill.nth === 0 ? kill : undefined;
        if (now?.before) {
          dead = true;
          throw new Killed(`killed before ${name}`);
        }
        const result = method(...args);
        if (now) dead = true;
        return result;
      };
    },
  });
  const publish = (
    version: string,
    commit: string,
    options: {
      key?: ReturnType<typeof signer>;
      signedVersion?: string;
      /** Publishes the Linux AppImage too, signed by `linuxKey` for `linuxVersion`. */
      linux?: boolean;
      linuxKey?: ReturnType<typeof signer>;
      linuxVersion?: string;
    } = {},
  ) => {
    const release = githubRelease(version, installer, options.linux);
    const signature = (options.key ?? trusted).signData(
      installer,
      options.signedVersion ?? version,
    );
    env.latest = release;
    env.byTag[release.tag_name] = release;
    env.commits[release.tag_name] = commit;
    env.files[release.assets[0].browser_download_url] = installer;
    env.files[release.assets[1].browser_download_url] = Buffer.from(signature);
    if (options.linux) {
      const image = (options.linuxKey ?? trusted).signData(
        appImage,
        options.linuxVersion ?? version,
      );
      env.files[release.assets[3].browser_download_url] = appImage;
      env.files[release.assets[4].browser_download_url] = Buffer.from(image);
    }
  };
  return {
    system,
    calls,
    tidied,
    logs,
    env,
    publish,
    counts,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    /** The relay the service runs, and whether it serves. */
    serves: () =>
      env.active && !gone() && behaviour().listens !== Infinity ? live.release : undefined,
    /** The service runs a release since before this updater looked. */
    boot: (release: string) => {
      env.current = release;
      env.active = true;
      live.release = release;
      live.since = clock;
    },
    /** The host's process runs another version than its link selects, or none. */
    hostProcess: (version: string | undefined) => {
      hostProcess = version;
    },
    /** A trial that an updater left running. */
    leaveTrial: (commit: string) => {
      tried.release = commit;
      tried.since = clock;
    },
    /** Kills the updater before or after its nth call of a system method. */
    kill: (method: keyof System, when: 'before' | 'after', nth = 1) => {
      kill = { method, nth, before: when === 'before' };
    },
    /** The next updater: the timer starts a new process. */
    revive: () => {
      dead = false;
      kill = undefined;
      if (unit) unit = liveness(config.hungAfter, clock);
    },
    /** Runs the updater as its unit does: without a deadline, ended when it hangs. */
    asUnit: () => {
      unit = liveness(config.hungAfter, clock);
    },
    run: (options: Partial<typeof config> = {}) => check(process, { ...config, ...options }),
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
    // However the file is laid out, and with text that looks like what is counted.
    const state = {
      instanceId: 'relay',
      workspace: {
        fleet: { note: '"status":"running"' },
        conversations: [
          { title: '{"status":"running"}', messages: [{ status: 'running' }, { status: 'done' }] },
          { messages: [{ status: 'running', blocks: [{ status: 'running' }] }] },
          { messages: [] },
        ],
      },
      revision: 3,
    };
    writeFileSync(join(data, 'workspace.json'), JSON.stringify(state, null, 2));
    expect(runningReplies(data)).toBe(3);
    writeFileSync(join(data, 'workspace.json'), JSON.stringify({ revision: 1 }));
    expect(runningReplies(data)).toBe(1);
    // A file it cannot read stops the count, as it always did: no release activates on a guess.
    writeFileSync(join(data, 'workspace.json'), '{"workspace":{"conversations":[{"messages":');
    expect(() => runningReplies(data)).toThrow(SyntaxError);
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
      `trial ${B}`,
      'end trial',
      'stop',
      `backup ${B}`,
      'stop',
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
      expect.objectContaining({
        tag: 'v0.2.1',
        commit: B,
        backup: `/var/backups/agent-studio/pre-${B}.tar.gz`,
      }),
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
      'stop',
      `select ${B}`,
      'start',
      'stop',
      `restore /var/backups/agent-studio/pre-${B}.tar`,
      `select ${A}`,
      'start',
    ]);
    expect(f.env.current).toBe(A);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.state.release?.activation).toBeUndefined();
    expect(f.env.state.history).toEqual([]);
    // The data is what it was, but for what the restored relay wrote since; the rest is kept.
    expect(f.env.data).toEqual([A]);
    expect([...f.env.kept.values()]).toEqual([[B]]);

    const broken = fake();
    broken.publish('0.2.1', B);
    broken.env.healthy = () => false;
    await expect(broken.run()).rejects.toThrow(/Intervene manually/);
  });

  it('waits for a relay as long as it works, however long it takes to listen', async () => {
    // What failed v1.3.2 and v1.3.3 on 2026-11-13: more than 30 seconds to read the state.
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = () => ({ listens: 45_000 });
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
    expect(f.env.current).toBe(B);
    expect(f.logs).toContain('v0.2.1 read the copy and listened after 45 s.');

    // No length of time ends a relay whose process works: three hours, said in the journal.
    // The updater runs as its unit does, which until 2026-11-20 ended it after two hours
    // (TimeoutStartSec=2h): the unit has no deadline, and its watchdog is answered all the
    // while, since the updater's own code runs between the looks.
    const long = fake();
    long.asUnit();
    long.publish('0.2.1', B);
    long.env.relay = () => ({ listens: 3 * 60 * 60_000 });
    await long.run();
    expect(long.env.state.release).toMatchObject({ phase: 'active' });
    expect(long.logs).toContain('v0.2.1 read the copy and listened after 10800 s.');
    expect(long.logs).toContain(
      'The trial has not listened after 60 s; its process works on, so it is waited for.',
    );
    expect(long.logs).toContain(
      'The relay has not listened after 10740 s; its process works on, so it is waited for.',
    );
  });

  it('accepts a relay whose answers take as long as its saves hold it, or longer', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = () => ({ stall: 16_000 });
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });

    // A relay that answers nothing for minutes while its process works is saving, not gone:
    // five times the longest save measured, on a day as slow as 2026-11-13, is 80 seconds.
    const saving = fake();
    saving.publish('0.2.1', B);
    saving.env.relay = () => ({ mute: 7000, speaks: 300_000 });
    await saving.run();
    expect(saving.env.state.release).toMatchObject({ phase: 'active' });
    expect(
      saving.logs.some((line) => /^The trial has not answered for \d+ s; its/.test(line)),
    ).toBe(true);
  });

  it('refuses a release whose relay cannot read a copy of the data, leaving the relay alone', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = (release) => (release === B ? { crash: true } : {});
    f.env.lastWords = 'Error: Relay data is unreadable; preserved without overwriting.';
    const began = f.now();
    await expect(f.run()).rejects.toThrow(
      `v0.2.1 was not activated: on a copy of the private data its relay ended (exit-code 1) and its service failed before it listened; it last logged: Error: Relay data is unreadable; preserved without overwriting.. ${A} runs on and nothing changed.`,
    );
    // Known from the service at the next look, not after a wait.
    expect(f.now() - began).toBeLessThan(5000);
    expect(f.calls.slice(f.calls.indexOf(`trial ${B}`))).toEqual([`trial ${B}`, 'end trial']);
    expect(f.env.active).toBe(true);
    expect(f.env.current).toBe(A);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.state.release?.activation).toBeUndefined();
    f.calls.length = 0;
    await f.run();
    expect(f.calls).toEqual([]);

    const full = fake();
    full.publish('0.2.1', B);
    full.env.trialError = new Error('ENOSPC: no space left on device');
    await expect(full.run()).rejects.toThrow(
      'its relay could not be tried: ENOSPC: no space left on device',
    );
    expect(full.calls).not.toContain('stop');
    expect(full.calls.at(-1)).toBe(`trial ${B}`);
  });

  it('fails a crash loop within seconds and goes back', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    // It reads the copy and ends each time its service starts it.
    f.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
    const began = f.now();
    await expect(f.run()).rejects.toThrow(
      new RegExp(
        `^v0\\.2\\.1 failed its health check; ${A} was restored\\. Data the failed release wrote is kept in /var/lib/\\.agent-studio-failed-${B.slice(0, 12)}-20260923T1200\\d\\dZ\\. Its relay ended \\(exit-code 1\\) and its service started it again before it listened\\.$`,
      ),
    );
    // Two relays shown to answer for 25 seconds each, and no wait for the one that ended.
    expect(f.now() - began).toBeLessThan(60_000);
    expect(f.env.current).toBe(A);
    expect(f.env.active).toBe(true);
  });

  it('ends the wait only for a relay that ended or that neither answers nor works', async () => {
    const tried = async (relay: Behaviour) => {
      const f = fake();
      f.publish('0.2.1', B);
      f.env.relay = (release) => (release === B ? relay : {});
      const began = f.now();
      const error = await f.run().then(
        () => undefined,
        (reason: Error) => reason.message,
      );
      expect(f.calls).not.toContain('stop');
      return { error, took: f.now() - began };
    };
    const idle = await tried({ listens: Infinity, idle: true });
    expect(idle.error).toContain(
      'its relay ran for 120 s without listening, the last 120 s without working.',
    );
    // It read for five minutes and then waits for something that does not come.
    const stuck = await tried({ listens: Infinity, idle: 300_000 });
    expect(stuck.error).toContain(
      'its relay ran for 420 s without listening, the last 120 s without working.',
    );
    const died = await tried({ dies: 12_000 });
    expect(died.error).toContain(
      'its relay listened after 0 s and then ended (exit-code 1) and its service failed.',
    );
    const silent = await tried({ mute: 7000, idle: 7000 });
    expect(silent.error).toMatch(
      /its relay listened after 0 s and then answered nothing for 175 s, the last 140 s without working\./,
    );
    // One answer that does not come is a save, not the end.
    const f = fake();
    let asked = 0;
    const probe = f.system.probe;
    f.system.probe = async (trial) => (++asked === 3 ? undefined : probe(trial));
    f.env.current = A;
    f.system.startService();
    expect(await healthy(f.system)).toEqual({ ok: true, listened: 0 });
  });

  it('never takes systemd not answering for a relay that ended', async () => {
    // One failed `systemctl show` read as "its service now unknown" and rolled a release back.
    const f = fake();
    f.publish('0.2.1', B);
    f.env.unseen = 7;
    f.env.relay = () => ({ listens: 20_000 });
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
    expect(f.env.current).toBe(B);
    expect(f.logs).toContain(
      'systemd does not say how the trial is; still asking it and the trial.',
    );
    expect(f.calls.some((call) => call.startsWith('restore'))).toBe(false);
  });

  it('starts the new release once more, on the data from before the switch, when the one before it no longer starts', async () => {
    // Production on 2026-11-20: the data had outgrown what the running release could read.
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = (release, trial, start) =>
      trial ? {} : release === A || start === 1 ? { crash: true } : {};
    f.env.lastWords = 'Error: Relay data is unreadable';
    await f.run();
    const backup = `/var/backups/agent-studio/pre-${B}.tar`;
    expect(f.calls.slice(f.calls.indexOf('stop'))).toEqual([
      'stop',
      `backup ${B}`,
      'stop',
      `select ${B}`,
      'start',
      'stop',
      `restore ${backup}`,
      `select ${A}`,
      'start',
      'stop',
      `restore ${backup}`,
      `select ${B}`,
      'start',
      `publish ${B} ${installer.length}`,
      `discard ${B}`,
    ]);
    expect(f.env.current).toBe(B);
    expect(f.env.active).toBe(true);
    expect(f.env.state.release).toMatchObject({ phase: 'active', previous: A });
    expect(f.env.state.release?.error).toBeUndefined();
    expect(f.env.state.release?.activation).toBeUndefined();
    // The release before wrote to the restored data before it ended: that is kept aside, and
    // the second start runs on the backup, not on what a relay that failed left.
    expect(f.env.data).toEqual([B]);
    const kept = [...f.env.kept.keys()];
    expect(kept).toEqual([
      expect.stringMatching(`^/var/lib/\\.agent-studio-failed-${B.slice(0, 12)}-`),
      expect.stringMatching(`^/var/lib/\\.agent-studio-failed-${A.slice(0, 12)}-`),
    ]);
    expect([...f.env.kept.values()]).toEqual([[B], [A]]);
    expect(f.env.state.release?.note).toBe(
      `v0.2.1 failed its first health check (its relay ended (exit-code 1) and its service started it again before it listened; it last logged: Error: Relay data is unreadable) and ${A} did not start again (its relay ended (exit-code 1) and its service started it again before it listened; it last logged: Error: Relay data is unreadable), so v0.2.1 was started once more, on the data as it was before the switch, and serves. ${A} can no longer be gone back to. Data the failed release wrote is kept in ${kept[0]}. What ${A} left when it did not start is kept in ${kept[1]}.`,
    );
    expect(f.logs).toContain(f.env.state.release?.note);
    expect(f.env.state.history).toEqual([
      expect.objectContaining({ commit: B, backup: `${backup}.gz` }),
    ]);
  });

  it('says what each relay did when neither release starts', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = (release, trial) =>
      trial ? {} : release === A ? { crash: true } : { listens: Infinity, idle: true };
    const error: string = await f.run().then(
      () => '',
      (reason: Error) => reason.message,
    );
    const kept = [...f.env.kept.keys()];
    expect(kept).toHaveLength(2);
    expect(error).toBe(
      `v0.2.1 failed its health check, restoring ${A} did not bring the relay back, and v0.2.1 did not start a second time: the relay is down. Intervene manually; v0.2.1 stays selected and the data backup is /var/backups/agent-studio/pre-${B}.tar. Data the failed release wrote is kept in ${kept[0]}. What ${A} left when it did not start is kept in ${kept[1]}. v0.2.1: its relay ran for 120 s without listening, the last 120 s without working. ${A}: its relay ended (exit-code 1) and its service started it again before it listened. v0.2.1 again: its relay ran for 120 s without listening, the last 120 s without working.`,
    );
    expect(f.env.current).toBe(B);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.state.history).toEqual([]);
  });

  it('checks before it stops the relay that its data can be backed up and restored', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.preflightError = new Error(
      '/var/backups/agent-studio has 12 MB free, less than a backup of the 786 MB of private data takes.',
    );
    await expect(f.run()).rejects.toThrow(
      `v0.2.1 was not activated: /var/backups/agent-studio has 12 MB free, less than a backup of the 786 MB of private data takes. ${A} runs on and nothing changed.`,
    );
    expect(f.calls).not.toContain('stop');
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    f.env.preflightError = undefined;
    retry(f.env.state);
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
  });

  it('starts the release that ran again when the backup fails after the relay stopped', async () => {
    const f = fake();
    f.publish('0.2.1', B);
    f.env.backupError = new Error('tar -cf exited with 2.');
    await expect(f.run()).rejects.toThrow(
      `v0.2.1 was not activated: private data could not be backed up (tar -cf exited with 2.). ${A} runs again on its data, which was not touched.`,
    );
    expect(f.calls.slice(f.calls.indexOf('stop'))).toEqual([
      'stop',
      `backup ${B}`,
      'stop',
      `select ${A}`,
      'start',
    ]);
    expect(f.serves()).toBe(A);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.kept.size).toBe(0);

    // The release that ran no longer reads its data, as production's could not on 2026-11-20:
    // the relay is not left down, the release that read a copy of the data in its trial runs.
    const outgrown = fake();
    outgrown.publish('0.2.1', B);
    outgrown.env.backupError = new Error('tar -cf exited with 2.');
    outgrown.env.relay = (release) => (release === A ? { crash: true } : {});
    await outgrown.run();
    expect(outgrown.calls.slice(outgrown.calls.indexOf('stop'))).toEqual([
      'stop',
      `backup ${B}`,
      'stop',
      `select ${A}`,
      'start',
      'stop',
      `select ${B}`,
      'start',
      `publish ${B} ${installer.length}`,
      `discard ${B}`,
    ]);
    expect(outgrown.serves()).toBe(B);
    expect(outgrown.env.state.release).toMatchObject({ phase: 'active' });
    expect(outgrown.env.state.release?.note).toBe(
      `Private data could not be backed up before activating v0.2.1 (tar -cf exited with 2.) and ${A} did not start again (its relay ended (exit-code 1) and its service started it again before it listened), so v0.2.1, which read a copy of this data in its trial, was started on it and serves, without a backup. ${A} can no longer be gone back to.`,
    );
    expect(outgrown.env.state.history).toEqual([
      expect.not.objectContaining({ backup: expect.anything() }),
    ]);

    const down = fake();
    down.publish('0.2.1', B);
    down.env.backupError = new Error('tar -cf exited with 2.');
    down.env.relay = (_release, trial) => (trial ? {} : { crash: true });
    await expect(down.run()).rejects.toThrow(
      /did not start on that data either: the relay is down\. Intervene manually; v0\.2\.1 stays selected and there is no backup/,
    );
  });

  it('clears a trial an updater left behind, and activates nothing while one cannot be cleared', async () => {
    // The updater was killed while its trial ran: systemd stops the unit bound to it, and the
    // next check finds what is left, the copy of the data, before it does anything else.
    const f = fake();
    f.leaveTrial(B);
    await f.run();
    expect(f.calls).toEqual(['end trial']);

    const killed = fake();
    killed.publish('0.2.1', B);
    killed.kill('startTrial', 'after');
    await expect(killed.run()).rejects.toThrow();
    expect(killed.env.state.release).toMatchObject({
      phase: 'staged',
      activation: { step: 'trial' },
    });
    killed.revive();
    killed.calls.length = 0;
    await killed.run();
    expect(killed.calls.slice(0, 3)).toEqual(['end trial', `trial ${B}`, 'end trial']);
    expect(killed.env.state.release).toMatchObject({ phase: 'active' });

    // A trial whose unit does not stop still reads its copy: the copy stays, and the check
    // ends there, before it looks for a release, tries one or stops a relay.
    const stuck = fake();
    stuck.publish('0.2.1', B);
    stuck.leaveTrial(A);
    stuck.env.trialStuck = true;
    await expect(stuck.run()).rejects.toThrow(
      'Nothing is activated while a trial left behind cannot be removed: agent-studio-trial did not stop',
    );
    expect(stuck.calls).toEqual([]);
    expect(stuck.env.state.release).toBeUndefined();
    stuck.env.trialStuck = false;
    await stuck.run();
    expect(stuck.env.state.release).toMatchObject({ phase: 'active' });

    // The same for an activation that an updater left in the middle, whatever its step: it
    // is not taken up beside a trial that still runs.
    const begun = fake();
    begun.publish('0.2.1', B);
    begun.kill('select', 'after');
    await expect(begun.run()).rejects.toThrow(Killed);
    begun.revive();
    begun.leaveTrial(B);
    begun.env.trialStuck = true;
    begun.calls.length = 0;
    await expect(begun.run()).rejects.toThrow(/^Nothing is activated while a trial left behind/);
    expect(begun.calls).toEqual([]);
    expect(begun.env.state.release).toMatchObject({ activation: { step: 'candidate' } });
    begun.env.trialStuck = false;
    await begun.run();
    expect(begun.env.state.release).toMatchObject({ phase: 'active' });
  });

  it('starts a new server’s relay with its first release', async () => {
    const f = fake();
    f.env.current = undefined;
    f.env.active = false;
    // Checkpoints copied from another server cannot hold a relay that never ran here.
    f.env.running = 2;
    f.publish('0.2.1', B);
    await f.run();
    expect(f.calls).toEqual([
      'download Agent-Studio_0.2.1_x64-setup.exe',
      'download Agent-Studio_0.2.1_x64-setup.exe.sig',
      `build ${B}`,
      'stop',
      `backup ${B}`,
      'stop',
      `select ${B}`,
      'start',
      `publish ${B} ${installer.length}`,
      `discard ${B}`,
    ]);
    expect(f.env.state.release).toMatchObject({ phase: 'active', download: 'published' });
    expect(f.env.state.release?.previous).toBeUndefined();
    expect(f.env.state.history).toEqual([expect.objectContaining({ tag: 'v0.2.1', commit: B })]);
    expect(f.logs).toContain("Activated v0.2.1, this server's first release.");
  });

  it('keeps a new server’s relay stopped when its first release fails, until a retry', async () => {
    const f = fake();
    f.env.current = undefined;
    f.env.active = false;
    f.env.healthy = () => false;
    f.publish('0.2.1', B);
    await expect(f.run()).rejects.toThrow(
      new RegExp(
        `^v0\\.2\\.1 failed its health check, so the relay stays stopped\\. Data it wrote is kept in /var/lib/\\.agent-studio-failed-${B.slice(0, 12)}-\\d{8}T\\d{6}Z\\. Its relay ended`,
      ),
    );
    expect(f.calls.slice(f.calls.indexOf('stop'))).toEqual([
      'stop',
      `backup ${B}`,
      'stop',
      `select ${B}`,
      'start',
      'deselect',
      'stop',
      `restore /var/backups/agent-studio/pre-${B}.tar`,
    ]);
    expect(f.env.current).toBeUndefined();
    expect(f.env.active).toBe(false);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });
    expect(f.env.state.history).toEqual([]);

    f.env.healthy = () => true;
    retry(f.env.state);
    await f.run();
    expect(f.env.state.release).toMatchObject({ phase: 'active' });
    expect(f.env.current).toBe(B);
    expect(f.calls.filter((call) => call.startsWith('build'))).toHaveLength(1);
  });

  it('never replaces a current link that selects no release', async () => {
    const f = fake();
    f.env.current = undefined;
    f.env.foreign = true;
    f.publish('0.2.1', B);
    await expect(f.run()).rejects.toThrow('/opt/agent-studio/current does not select a release.');
    expect(f.calls).not.toContain('stop');
    expect(f.calls.some((call) => call.startsWith('select'))).toBe(false);
  });

  it('records a release that is already selected only once its relay passes the check', async () => {
    const f = fake();
    f.boot(B);
    f.publish('0.2.1', B);
    const began = f.now();
    await f.run();
    expect(f.calls).not.toContain('stop');
    expect(f.calls.some((call) => call.startsWith('build'))).toBe(false);
    expect(f.env.state.release).toMatchObject({ phase: 'active', download: 'published' });
    // Its relay was watched answering, not taken for running because it is selected.
    expect(f.now() - began).toBeGreaterThanOrEqual(25_000);
    expect(f.logs).toContain('v0.2.1 is already the current release, and its relay answers.');

    const dead = fake();
    dead.boot(B);
    dead.publish('0.2.1', B);
    dead.env.relay = () => ({ listens: Infinity, idle: true });
    await expect(dead.run()).rejects.toThrow(
      'v0.2.1 is the current release, selected outside this updater, but its relay ran for 120 s without listening, the last 120 s without working. Nothing was changed.',
    );
    expect(dead.env.state.release).toMatchObject({ phase: 'failed' });
    expect(dead.env.state.history).toEqual([]);
    expect(dead.calls.some((call) => call.startsWith('publish'))).toBe(false);

    const stopped = fake();
    stopped.env.current = B;
    stopped.env.active = false;
    stopped.publish('0.2.1', B);
    await stopped.run();
    expect(stopped.env.state.release).toMatchObject({ phase: 'staged', waiting: 'service' });
    expect(stopped.calls).not.toContain('start');
  });

  describe('an updater that is killed', () => {
    it('never leaves a selected release that nobody checked marked active', async () => {
      // The updater ended right after it selected the release, whose relay then does not run:
      // the next check must not read success off the link, publish its installer or switch
      // the host. It starts the relay, checks it, and goes back like after any failed check.
      const f = fake();
      f.publish('0.2.1', B);
      f.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
      f.kill('select', 'after');
      await expect(f.run()).rejects.toThrow(Killed);
      expect(f.env.current).toBe(B);
      expect(f.env.active).toBe(false);
      expect(f.env.state.release).toMatchObject({
        phase: 'staged',
        previous: A,
        backup: `/var/backups/agent-studio/pre-${B}.tar`,
        activation: { step: 'candidate', previous: A },
      });

      f.revive();
      f.calls.length = 0;
      await expect(f.run()).rejects.toThrow(`v0.2.1 failed its health check; ${A} was restored.`);
      expect(f.calls).toEqual([
        'stop',
        `select ${B}`,
        'start',
        'stop',
        `restore /var/backups/agent-studio/pre-${B}.tar`,
        `select ${A}`,
        'start',
      ]);
      expect(f.logs).toContain(
        'An updater ended while starting v0.2.1; the activation of v0.2.1 goes on from there, and nothing is taken for done.',
      );
      expect(f.serves()).toBe(A);
      expect(f.env.state.release).toMatchObject({ phase: 'failed' });
      expect(f.env.state.history).toEqual([]);
      expect(f.env.data).toEqual([A]);
    });

    it('goes on from the step it had written, whichever it was', async () => {
      const at = async (
        method: keyof System,
        when: 'before' | 'after',
        nth: number,
        step: string,
      ) => {
        const f = fake();
        f.publish('0.2.1', B);
        f.kill(method, when, nth);
        await expect(f.run()).rejects.toThrow(Killed);
        expect(f.env.state.release).toMatchObject({ phase: 'staged', activation: { step } });
        f.revive();
        f.calls.length = 0;
        await f.run();
        expect(f.env.state.release).toMatchObject({ phase: 'active' });
        expect(f.env.state.release?.activation).toBeUndefined();
        expect(f.serves()).toBe(B);
        expect(f.env.state.history).toHaveLength(1);
        return f;
      };
      // After the relay was stopped: it is not left down until someone looks.
      let f = await at('stopService', 'after', 1, 'backup');
      expect(f.calls.slice(0, 5)).toEqual(['stop', `backup ${B}`, 'stop', `select ${B}`, 'start']);
      // After the backup was written but before the state named it: the relay is stopped and
      // the data as that backup holds it, so it is the one that is used, not a second one.
      f = await at('backup', 'after', 1, 'backup');
      expect(f.calls.slice(0, 2)).toEqual(['stop', `backup ${B}`]);
      expect([...f.env.backups.keys()]).toEqual([`/var/backups/agent-studio/pre-${B}.tar.gz`]);
      // After the release was selected: its relay was never started, so it is now.
      f = await at('select', 'after', 1, 'candidate');
      expect(f.calls.slice(0, 3)).toEqual(['stop', `select ${B}`, 'start']);
      // After its relay was started: the relay that runs is the one this step started, so it
      // is checked as it runs, and no device is cut off a second time.
      f = await at('startService', 'after', 1, 'candidate');
      expect(f.calls).toEqual([`publish ${B} ${installer.length}`, `discard ${B}`]);
      expect(f.logs).toContain(
        `The relay of ${B} that the updater started runs; it is checked, not started again.`,
      );
      // After its relay passed the check but before that was written: it is checked again,
      // as it runs.
      f = await at('releaseKey', 'before', 1, 'candidate');
      expect(f.calls).toEqual([`publish ${B} ${installer.length}`, `discard ${B}`]);
    });

    it('goes on watching the relay it started only when that is the relay that runs', async () => {
      const killedAfterStart = async () => {
        const f = fake();
        f.publish('0.2.1', B);
        f.kill('startService', 'after');
        await expect(f.run()).rejects.toThrow(Killed);
        f.revive();
        f.calls.length = 0;
        return f;
      };
      const restarted = ['stop', `select ${B}`, 'start'];
      // The same process: it is watched through the whole check, and not touched.
      let f = await killedAfterStart();
      const process = f.system.unit()?.pid;
      const began = f.now();
      await f.run();
      expect(f.system.unit()?.pid).toBe(process);
      expect(f.calls).not.toContain('stop');
      expect(f.now() - began).toBeGreaterThanOrEqual(25_000);
      expect(f.env.state.release).toMatchObject({ phase: 'active' });

      // A relay that began before the step was written is not the one the step started.
      f = await killedAfterStart();
      f.advance(60_000);
      f.env.state.release!.activation!.entered = new Date(f.now()).toISOString();
      await f.run();
      expect(f.calls.slice(0, 3)).toEqual(restarted);

      // A relay that runs another release than the one selected, as after a start by hand.
      f = await killedAfterStart();
      f.boot(A);
      f.env.current = B;
      await f.run();
      expect(f.calls.slice(0, 3)).toEqual(restarted);

      // A service that is not running.
      f = await killedAfterStart();
      f.env.active = false;
      await f.run();
      expect(f.calls.slice(0, 3)).toEqual(restarted);

      // A relay that ended and that its service started again is not watched as if it had
      // stayed up: the step is done again, and its check sees it end.
      const crashed = fake();
      crashed.publish('0.2.1', B);
      crashed.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
      crashed.kill('startService', 'after');
      await expect(crashed.run()).rejects.toThrow(Killed);
      crashed.revive();
      crashed.advance(5000);
      crashed.calls.length = 0;
      await expect(crashed.run()).rejects.toThrow(`${A} was restored`);
      expect(crashed.calls.slice(0, 3)).toEqual(restarted);

      // The release before, started again after the backup was put back: what it was started
      // on is in place, so it is watched too, and the data is not replaced a second time.
      const back = fake();
      back.publish('0.2.1', B);
      back.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
      back.kill('startService', 'after', 2);
      await expect(back.run()).rejects.toThrow(Killed);
      expect(back.env.state.release).toMatchObject({ activation: { step: 'previous' } });
      back.revive();
      back.calls.length = 0;
      await expect(back.run()).rejects.toThrow(
        new RegExp(
          `^v0\\.2\\.1 failed its health check; ${A} was restored\\. Data the failed release wrote is kept in /var/lib/\\.agent-studio-failed-${B.slice(0, 12)}-`,
        ),
      );
      // Asked only where the restore kept things; nothing was stopped, selected or started.
      expect(back.calls).toEqual([`restore /var/backups/agent-studio/pre-${B}.tar`]);
      expect(back.env.kept.size).toBe(1);
      expect(back.env.data).toEqual([A]);
      expect(back.serves()).toBe(A);
    });

    it('finishes a restore it was in the middle of, replacing the data once', async () => {
      for (const when of ['before', 'after'] as const) {
        const f = fake();
        f.publish('0.2.1', B);
        f.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
        f.kill('restore', when);
        await expect(f.run()).rejects.toThrow(Killed);
        expect(f.env.state.release).toMatchObject({
          phase: 'staged',
          activation: { step: 'previous', keep: expect.stringContaining(B.slice(0, 12)) },
        });
        f.revive();
        f.calls.length = 0;
        await expect(f.run()).rejects.toThrow(`v0.2.1 failed its health check; ${A} was restored.`);
        expect(f.calls).toEqual([
          'stop',
          `restore /var/backups/agent-studio/pre-${B}.tar`,
          `select ${A}`,
          'start',
        ]);
        expect(f.serves()).toBe(A);
        // One folder holds what the failed release wrote, under the name written beforehand.
        expect([...f.env.kept.values()]).toEqual([[B]]);
        expect(f.env.data).toEqual([A]);
      }
    });

    it('finishes what it began before a newer release replaces it', async () => {
      const f = fake();
      f.publish('0.2.1', B);
      f.kill('select', 'after');
      await expect(f.run()).rejects.toThrow(Killed);
      f.revive();
      f.publish('0.2.2', C);
      f.calls.length = 0;
      await f.run();
      expect(f.calls.slice(0, 3)).toEqual(['stop', `select ${B}`, 'start']);
      expect(f.calls).not.toContain(`discard ${B}`);
      expect(f.env.state.history.map((entry) => entry.commit)).toEqual([C, B]);
      expect(f.serves()).toBe(C);
    });

    it('ends well wherever it is killed, in every activation', async () => {
      // Every call the updater makes, in three activations: one that goes through, one whose
      // relay ends as the service, and one where the release before no longer starts either.
      // The updater is killed before and after each call; the checks that follow must end with
      // a relay that was checked, or say that there is none, and never with a guess.
      const scenarios: {
        name: string;
        relay: (release: string | undefined, trial: boolean, start: number) => Behaviour;
        ends: 'active' | 'restored' | 'down';
      }[] = [
        { name: 'goes through', relay: () => ({}), ends: 'active' },
        {
          name: 'ends as the service',
          relay: (release, trial) => (release === B && !trial ? { crash: true } : {}),
          ends: 'restored',
        },
        {
          name: 'neither starts',
          // The relay that runs goes on running until it is stopped; no start after that does.
          relay: (_release, trial, start) => (trial || start === 0 ? {} : { crash: true }),
          ends: 'down',
        },
      ];
      const methods = [
        'writeState',
        'startTrial',
        'endTrial',
        'preflight',
        'stopService',
        'backup',
        'select',
        'startService',
        'restore',
        'compress',
        'removeBackup',
        'probe',
      ] as const;
      let kills = 0;
      for (const scenario of scenarios) {
        const whole = fake();
        whole.publish('0.2.1', B);
        whole.env.relay = scenario.relay;
        await whole.run().catch(() => undefined);
        for (const method of methods)
          for (let nth = 1; nth <= (whole.counts.get(method) ?? 0); nth++)
            for (const when of ['before', 'after'] as const) {
              const f = fake();
              f.publish('0.2.1', B);
              f.env.relay = scenario.relay;
              f.kill(method, when, nth);
              const where = `${scenario.name}: killed ${when} ${method} #${nth}`;
              await f.run().catch(() => undefined);
              kills++;
              // The timer goes on starting updaters until one has nothing left to do.
              for (let checks = 0; checks < 4; checks++) {
                f.revive();
                await f.run().catch(() => undefined);
              }
              const release = f.env.state.release;
              expect(release?.activation, where).toBeUndefined();
              // The state names no backup that is not there, and leaves no archive behind
              // whose compressed copy took its place.
              for (const named of [release?.backup, ...f.env.state.history.map((e) => e.backup)])
                if (named) expect(f.env.backups.has(named), `${where}: ${named}`).toBe(true);
              expect(f.env.state.cleanup, where).toBeUndefined();
              if (release?.phase === 'active') {
                expect([...f.env.backups.keys()], where).toEqual([
                  `/var/backups/agent-studio/pre-${B}.tar.gz`,
                ]);
                // Only a relay that was checked: it runs the release and answers.
                expect(f.serves(), where).toBe(B);
                expect(f.env.current, where).toBe(B);
                expect(scenario.ends, where).toBe('active');
              } else {
                expect(release?.phase, where).toBe('failed');
                expect(f.env.state.history, where).toEqual([]);
                expect(
                  f.calls.some((call) => call.startsWith('publish')),
                  where,
                ).toBe(false);
                if (scenario.ends === 'restored') {
                  expect(f.serves(), where).toBe(A);
                  // Nothing the failed release wrote is in the data the restored relay reads.
                  expect(f.env.data, where).not.toContain(B);
                } else {
                  expect(scenario.ends, where).toBe('down');
                  expect(release?.error, where).toContain('the relay is down. Intervene manually');
                }
              }
            }
      }
      expect(kills).toBeGreaterThan(150);
    });
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

describe('the trial of a release', () => {
  // What `busctl --json=short get-property` prints for each property of the relay's service.
  const properties = {
    User: { type: 's', data: 'agent-studio' },
    Group: { type: 's', data: 'agent-studio' },
    Environment: {
      type: 'as',
      data: [
        'NODE_ENV=production',
        'NODE_OPTIONS=--max-old-space-size=32768 --no-warnings',
        'AGENT_STUDIO_RELAY_PORT=4317',
        'AGENT_STUDIO_RELAY_DATA=/var/lib/agent-studio',
        'QUOTED="kept as it is" $HOME',
      ],
    },
    EnvironmentFiles: {
      type: 'a(sb)',
      data: [
        ['/etc/agent-studio/relay.env', false],
        ['/etc/agent-studio/more settings.env', true],
      ],
    },
  };
  const trial = (service = parseService(properties)) =>
    trialArguments({
      unit: 'agent-studio-trial',
      updater: 'agent-studio-update.service',
      service,
      release: '/opt/agent-studio/releases/abc',
      data: '/var/lib/.agent-studio-trial',
      port: 4317,
      node: '/opt/agent-studio/runtimes/node/bin/node',
      hidden: ['/var/lib/agent-studio', '/var/backups/agent-studio'],
    });

  it('reads the service entry by entry, whatever the values hold', () => {
    expect(parseService(properties)).toEqual({
      user: 'agent-studio',
      group: 'agent-studio',
      environment: properties.Environment.data,
      files: [
        { path: '/etc/agent-studio/relay.env', optional: false },
        { path: '/etc/agent-studio/more settings.env', optional: true },
      ],
    });
    expect(busPath('agent-studio.service')).toBe(
      '/org/freedesktop/systemd1/unit/agent_2dstudio_2eservice',
    );
    expect(busPath('9relay@a.service')).toBe(
      '/org/freedesktop/systemd1/unit/_39relay_40a_2eservice',
    );
    for (const broken of [
      { ...properties, Environment: { data: 'NODE_ENV=production' } },
      { ...properties, Environment: { data: ['no assignment'] } },
      { ...properties, EnvironmentFiles: { data: [['relative.env', false]] } },
      { ...properties, EnvironmentFiles: { data: ['/etc/agent-studio/relay.env'] } },
      { ...properties, User: {} },
    ])
      expect(() => parseService(broken)).toThrow(/systemd reported/);
  });

  it('keeps every entry and every file of the service, each as one argument', () => {
    const args = trial();
    const command = args.indexOf('--');
    const options = args.slice(0, command);
    // Values with spaces, quotes and dollar signs stay one argument each, unchanged.
    for (const entry of properties.Environment.data) expect(options).toContain(`--setenv=${entry}`);
    // Every file, in the service's order, with its own "may be missing" mark.
    expect(options.filter((option) => option.startsWith('--property=EnvironmentFile='))).toEqual([
      '--property=EnvironmentFile=/etc/agent-studio/relay.env',
      '--property=EnvironmentFile=-/etc/agent-studio/more settings.env',
    ]);
    expect(options).toContain('--uid=agent-studio');
    expect(options).toContain('--property=PrivateNetwork=yes');
    expect(options).toContain(
      '--property=InaccessiblePaths=-/var/lib/agent-studio -/var/backups/agent-studio',
    );
    // It ends with the updater that started it.
    expect(options).toContain('--property=BindsTo=agent-studio-update.service');
    expect(trialArguments({ ...trialOf(), updater: undefined }).join(' ')).not.toContain('BindsTo');
  });

  it('sets where the trial reads and listens after everything the service sets', () => {
    // systemd gives an environment file precedence over Environment=, which is all --setenv is:
    // a relay.env that names the data folder or the port would send the trial to the real data.
    // What env(1) sets in the command itself comes after both.
    const args = trial();
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '/usr/bin/env',
      'AGENT_STUDIO_RELAY_HOST=127.0.0.1',
      'AGENT_STUDIO_RELAY_PORT=4317',
      'AGENT_STUDIO_RELAY_DATA=/var/lib/.agent-studio-trial',
      'AGENT_STUDIO_WEB_DIR=/opt/agent-studio/releases/abc/build',
      '/opt/agent-studio/runtimes/node/bin/node',
      'relay/start.ts',
    ]);
    // The service's own, conflicting values are still passed on, and lose.
    expect(args.indexOf('--setenv=AGENT_STUDIO_RELAY_DATA=/var/lib/agent-studio')).toBeLessThan(
      args.indexOf('--'),
    );
    // systemd expands $NAME in a command's arguments, so a dollar sign is written twice.
    const odd = trialArguments({ ...trialOf(), data: '/var/lib/.a$b-trial' });
    expect(odd).toContain('AGENT_STUDIO_RELAY_DATA=/var/lib/.a$$b-trial');
    expect(odd).toContain('--property=ReadWritePaths=/var/lib/.a$b-trial');
  });

  function trialOf() {
    return {
      unit: 'agent-studio-trial',
      updater: 'agent-studio-update.service' as string | undefined,
      service: parseService(properties),
      release: '/opt/agent-studio/releases/abc',
      data: '/var/lib/.agent-studio-trial',
      port: 4317,
      node: '/opt/agent-studio/runtimes/node/bin/node',
      hidden: ['/var/lib/agent-studio'],
    };
  }
});

describe('restoring private data', () => {
  // The folders as a restore finds them, and an extraction that can end early.
  const folders = () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-vps-restore-'));
    temporary.push(root);
    const data = join(root, 'agent-studio');
    mkdirSync(data);
    writeFileSync(join(data, 'workspace.json'), 'what the failed release wrote');
    const staging = join(root, '.agent-studio-restore-b-1');
    const kept = join(root, '.agent-studio-failed-b-1');
    let extractions = 0;
    const extract = (until: 'whole' | 'partly' = 'whole') => {
      extractions++;
      mkdirSync(join(staging, 'agent-studio'), { recursive: true });
      if (until === 'partly') throw new Error('killed while extracting');
      writeFileSync(join(staging, 'agent-studio', 'workspace.json'), 'the backup');
    };
    const read = (folder: string) => readFileSync(join(folder, 'workspace.json'), 'utf8');
    const settled = () => {
      expect(read(data)).toBe('the backup');
      expect(read(kept)).toBe('what the failed release wrote');
      expect(existsSync(staging)).toBe(false);
    };
    return { data, staging, kept, extract, settled, extractions: () => extractions };
  };

  it('replaces the data with the backup and keeps what was there', () => {
    const f = folders();
    replaceData(f.data, f.staging, f.kept, f.extract);
    f.settled();
  });

  it('can be done again after ending anywhere, and replaces the data once', () => {
    // While extracting: the data is untouched, and the extraction starts over.
    let f = folders();
    expect(() => replaceData(f.data, f.staging, f.kept, () => f.extract('partly'))).toThrow();
    expect(existsSync(f.kept)).toBe(false);
    replaceData(f.data, f.staging, f.kept, f.extract);
    f.settled();

    // After the data was moved aside and before the backup took its place: there is no data
    // folder at all, and the extraction, which had finished, is not done again.
    f = folders();
    f.extract();
    renameSync(f.data, f.kept);
    replaceData(f.data, f.staging, f.kept, () => {
      throw new Error('extracted twice');
    });
    f.settled();

    // After the backup took its place, before the empty folder it came from was removed.
    f = folders();
    f.extract();
    renameSync(f.data, f.kept);
    renameSync(join(f.staging, 'agent-studio'), f.data);
    replaceData(f.data, f.staging, f.kept, () => {
      throw new Error('extracted twice');
    });
    f.settled();

    // After all of it, when the relay that was started has written again: nothing is replaced.
    f = folders();
    replaceData(f.data, f.staging, f.kept, f.extract);
    writeFileSync(join(f.data, 'workspace.json'), 'what the restored relay wrote');
    replaceData(f.data, f.staging, f.kept, () => {
      throw new Error('extracted twice');
    });
    expect(readFileSync(join(f.data, 'workspace.json'), 'utf8')).toBe(
      'what the restored relay wrote',
    );
    expect(readFileSync(join(f.kept, 'workspace.json'), 'utf8')).toBe(
      'what the failed release wrote',
    );
    expect(f.extractions()).toBe(1);
  });
});

describe('server host', () => {
  const relayCalls = (commit: string, first = false) => [
    'download Agent-Studio_0.9.0_x64-setup.exe',
    'download Agent-Studio_0.9.0_x64-setup.exe.sig',
    `build ${commit}`,
    // A new server has no relay to protect and nothing to try a release on.
    ...(first ? [] : [`trial ${commit}`, 'end trial']),
    'stop',
    `backup ${commit}`,
    // Every start of a relay stops whatever runs first, so that it can be done again.
    'stop',
    `select ${commit}`,
    'start',
    `publish ${commit} ${installer.length}`,
    `discard ${commit}`,
  ];
  const key = 'relay-pairing-key-'.repeat(3);

  it('runs the release the relay runs, from its signed AppImage, once set up', async () => {
    const f = fake();
    f.env.relayKey = key;
    f.publish('0.9.0', B, { linux: true });
    await f.run({ host });
    expect(f.calls).toEqual([
      ...relayCalls(B),
      'write host key',
      'download Agent-Studio_0.9.0_amd64.AppImage',
      'download Agent-Studio_0.9.0_amd64.AppImage.sig',
      'host packages',
      `extract host 0.9.0 ${appImage.length}`,
      'provision host',
      'select host 0.9.0',
      'restart host',
      'prune host 0.9.0',
    ]);
    expect(f.env.state.host).toMatchObject({ tag: 'v0.9.0', commit: B, phase: 'active' });
    expect(f.env.hostKey).toBe(key);
    expect(f.logs.join('\n')).toMatch(/Staged the v0.9.0 host[\s\S]*The host runs v0.9.0/);
    f.calls.length = 0;
    await f.run({ host });
    expect(f.calls).toEqual([]);
  });

  it('sets up a new server’s relay and host in one run', async () => {
    const f = fake();
    f.env.current = undefined;
    f.env.active = false;
    f.env.relayKey = key;
    f.publish('0.9.0', B, { linux: true });
    await f.run({ host });
    expect(f.calls).toEqual([
      ...relayCalls(B, true),
      'write host key',
      'download Agent-Studio_0.9.0_amd64.AppImage',
      'download Agent-Studio_0.9.0_amd64.AppImage.sig',
      'host packages',
      `extract host 0.9.0 ${appImage.length}`,
      'provision host',
      'select host 0.9.0',
      'restart host',
      'prune host 0.9.0',
    ]);
    expect(f.env.state.release).toMatchObject({ phase: 'active', download: 'published' });
    expect(f.env.state.host).toMatchObject({ phase: 'active' });
    expect(f.env.state.host?.previous).toBeUndefined();
  });

  it('restarts the host only once no reply runs, or after two hours', async () => {
    const f = fake();
    f.publish('0.9.0', B, { linux: true });
    f.env.current = B;
    f.env.host = '0.8.9';
    f.env.running = 1;
    await f.run({ host });
    expect(f.calls).toContain(`extract host 0.9.0 ${appImage.length}`);
    expect(f.calls).not.toContain('restart host');
    expect(f.env.state.host).toMatchObject({ phase: 'staged', waiting: 'replies' });
    await f.run({ host });
    expect(f.logs.filter((line) => line.includes('waits up to two hours'))).toHaveLength(1);
    f.advance(2 * 60 * 60 * 1000);
    await f.run({ host });
    expect(f.calls.slice(-4)).toEqual([
      'provision host',
      'select host 0.9.0',
      'restart host',
      'prune host 0.9.0 0.8.9',
    ]);
    expect(f.env.state.host).toMatchObject({ phase: 'active', previous: '0.8.9' });
  });

  it('refuses an AppImage from another key or for another version and keeps the host', async () => {
    for (const options of [{ linuxKey: signer() }, { linuxVersion: '0.8.0' }]) {
      const f = fake();
      f.env.host = '0.8.9';
      f.publish('0.9.0', B, { linux: true, ...options });
      await expect(f.run({ host })).rejects.toThrow(/Could not stage the v0.9.0 host/);
      expect(f.env.state.release).toMatchObject({ phase: 'active' });
      expect(f.env.state.host).toMatchObject({ phase: 'failed' });
      expect(f.calls.some((call) => call.startsWith('extract host'))).toBe(false);
      expect(f.calls).not.toContain('host packages');
      expect(f.env.host).toBe('0.8.9');
      await f.run({ host });
    }
  });

  it('keeps the host on its release when a release cannot run as a server', async () => {
    const f = fake();
    f.env.host = '0.8.9';
    f.env.serverCheck = false;
    f.publish('0.9.0', B, { linux: true });
    await f.run({ host });
    expect(f.env.state.host).toMatchObject({ phase: 'unsupported' });
    expect(f.calls).not.toContain('provision host');
    expect(f.calls).not.toContain('restart host');
    f.calls.length = 0;
    await f.run({ host });
    expect(f.calls).toEqual([]);
    // A release without an AppImage leaves it alone too.
    const g = fake();
    g.publish('0.9.0', C);
    await g.run({ host });
    expect(g.env.state.host).toMatchObject({ phase: 'unsupported' });
    expect(g.calls).toContain('release v0.9.0');
  });

  it('goes back to the host that ran before when a new one does not stay up', async () => {
    const f = fake();
    f.env.host = '0.8.9';
    f.env.hostUp = (version) => version !== '0.9.0';
    f.publish('0.9.0', B, { linux: true });
    await expect(f.run({ host })).rejects.toThrow(/did not stay up; it runs 0.8.9 again/);
    expect(f.calls.slice(-4)).toEqual([
      'select host 0.9.0',
      'restart host',
      'select host 0.8.9',
      'restart host',
    ]);
    expect(f.env.state.host).toMatchObject({ phase: 'failed' });
    // A first host that does not stay up stops instead of restarting forever.
    const g = fake();
    g.env.hostUp = () => false;
    g.publish('0.9.0', B, { linux: true });
    await expect(g.run({ host })).rejects.toThrow(/did not stay up and was stopped/);
    expect(g.calls.at(-1)).toBe('stop host');
  });

  it('reads the AppImage of a release tracked before the updater knew of it', async () => {
    const f = fake();
    f.publish('0.9.0', B, { linux: true });
    f.env.current = B;
    f.env.state.release = {
      tag: 'v0.9.0',
      version: '0.9.0',
      commit: B,
      installer: parseRelease(githubRelease('0.9.0')).installer,
      signature: parseRelease(githubRelease('0.9.0')).signature,
      phase: 'active',
      attempts: 1,
      seen: '2026-10-10T00:00:00Z',
      download: 'published',
    };
    await f.run({ host });
    expect(f.calls).toContain('release v0.9.0');
    expect(f.env.state.host).toMatchObject({ phase: 'active' });
  });

  it('retries a host whose server could not be prepared', async () => {
    const f = fake();
    f.env.provisionError = new Error('apt-get exited with 100.');
    f.publish('0.9.0', B, { linux: true });
    await expect(f.run({ host })).rejects.toThrow(/Could not prepare the server/);
    expect(f.env.state.host).toMatchObject({ phase: 'pending', error: 'apt-get exited with 100.' });
    delete f.env.provisionError;
    f.advance(11 * 60 * 1000);
    await f.run({ host });
    expect(f.env.state.host).toMatchObject({ phase: 'active' });
  });

  it('follows the relay key, restarting the host, but keeps a key set by hand', async () => {
    const f = fake();
    f.env.relayKey = key;
    f.publish('0.9.0', B, { linux: true });
    await f.run({ host });
    f.calls.length = 0;
    // The relay's key was rotated.
    f.env.relayKey = 'rotated-pairing-key-'.repeat(3);
    await f.run({ host });
    expect(f.calls).toEqual(['write host key', 'restart host']);
    expect(f.env.hostKey).toBe(f.env.relayKey);
    // Someone gave the host another workspace's key.
    f.env.hostKey = 'member-workspace-key-'.repeat(3);
    f.env.relayKey = 'rotated-again-key-'.repeat(3);
    f.calls.length = 0;
    await f.run({ host });
    expect(f.calls).toEqual([]);
    expect(f.env.hostKey).toBe('member-workspace-key-'.repeat(3));
  });

  it('describes the host service and its settings', () => {
    expect(host).toMatchObject({
      user: 'agent-studio-host',
      sudo: false,
      name: 'VPS',
      service: 'agent-studio-host',
      key: '/etc/agent-studio/host.key',
    });
    expect(readConfig({ AGENT_STUDIO_UPDATE_HOST: 'off' }).host).toBe(false);
    const custom = readConfig({
      AGENT_STUDIO_UPDATE_HOST_USER: 'claude',
      AGENT_STUDIO_UPDATE_HOST_SUDO: 'on',
      AGENT_STUDIO_UPDATE_HOST_NAME: 'Build server',
    });
    expect(custom.host).toMatchObject({ user: 'claude', sudo: true, name: 'Build server' });
    for (const [name, value] of [
      ['HOST_USER', 'root'],
      ['HOST_USER', 'claude; reboot'],
      ['HOST_NAME', 'VPS\nExecStart=/bin/sh'],
      ['HOST_NAME', 'VPS"'],
      ['HOST_KEY', 'relative/key'],
    ])
      expect(() => readConfig({ [`AGENT_STUDIO_UPDATE_${name}`]: value })).toThrow();
    const unit = hostUnit({ ...readConfig({}), host: custom.host }, '/home/claude');
    for (const line of [
      'User=claude',
      'Environment=AGENT_STUDIO_SERVER=1',
      'Environment=AGENT_STUDIO_RELAY_URL=http://127.0.0.1:4317',
      'Environment="AGENT_STUDIO_COMPUTER_NAME=Build server"',
      'Environment=PATH=/home/claude/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LoadCredential=relay-key:/etc/agent-studio/host.key',
      'ExecStart=/usr/bin/dbus-run-session -- /usr/bin/xvfb-run --auto-servernum "--server-args=-screen 0 1440x900x24 -nolisten tcp" /opt/agent-studio/host/current/AppRun',
      'Restart=always',
    ])
      expect(unit.split('\n')).toContain(line);
  });

  it('reads the relay key from its environment file', () => {
    const value = 'k'.repeat(64);
    expect(relayKeyIn(`AGENT_STUDIO_RELAY_TOKEN=${value}\n`)).toBe(value);
    expect(relayKeyIn(`# key\nexport AGENT_STUDIO_RELAY_TOKEN="${value}"\r\n`)).toBe(value);
    expect(relayKeyIn('AGENT_STUDIO_RELAY_TOKEN=short')).toBeUndefined();
    expect(relayKeyIn('OTHER=1')).toBeUndefined();
  });
});

describe('server setup', () => {
  const file = (path: string) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const relay = readConfig({});

  it('installs the Node runtime that the services and the updater run', () => {
    const setup = file('scripts/vps/setup.sh');
    const version = /^node_version=(\d+\.\d+\.\d+)$/m.exec(setup)?.[1];
    expect(version).toBeDefined();
    expect(setup).toMatch(/^node_sha256=[0-9a-f]{64}$/m);
    for (const path of [
      'scripts/vps/agent-studio.service',
      'scripts/vps/agent-studio-update.service',
      'scripts/vps/install.sh',
    ])
      expect(file(path)).toContain(`/runtimes/node-v${version}-linux-x64/bin/node`);
  });

  it('runs the relay where the updater activates, probes and publishes', () => {
    const unit = file('scripts/vps/agent-studio.service').split('\n');
    for (const line of [
      `WorkingDirectory=${relay.root}/current`,
      `EnvironmentFile=${relay.host && relay.host.relayEnv}`,
      `Environment=AGENT_STUDIO_RELAY_PORT=${relay.port}`,
      `Environment=AGENT_STUDIO_RELAY_DATA=${relay.data}`,
      `Environment=AGENT_STUDIO_WEB_DIR=${relay.root}/current/build`,
      `Environment=AGENT_STUDIO_DOWNLOADS_DIR=${relay.root}/downloads`,
      `ReadWritePaths=${relay.data}`,
    ])
      expect(unit).toContain(line);
    expect(unit.some((line) => /^(MemoryMax|MemoryHigh|CPUQuota)=/.test(line))).toBe(false);
    expect(file('scripts/vps/setup.sh')).toMatch(new RegExp(`^port=${relay.port}$`, 'm'));
  });
});

describe('the updater’s journal', () => {
  const folder = () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-vps-journal-'));
    temporary.push(root);
    return join(root, 'state.json');
  };
  const state = (tag: string): State => ({ ...emptyState(), ignored: tag });

  it('is written whole under a name of its own, and keeps the generation before it', () => {
    const file = folder();
    expect(readJournal(file)).toEqual({ state: emptyState() });
    writeJournal(file, state('one'));
    expect(existsSync(`${file}.previous`)).toBe(false);
    writeJournal(file, state('two'));
    writeJournal(file, state('three'));
    expect(readJournal(file)).toEqual({ state: state('three') });
    expect(JSON.parse(readFileSync(`${file}.previous`, 'utf8'))).toEqual(state('two'));
    // What a writer that was killed left, under whatever name it had, goes with the next write.
    writeFileSync(`${file}.4242-0a0b0c0d.partial`, '{ "version": 1, "hist');
    writeJournal(file, state('four'));
    expect(readdirSync(join(file, '..')).sort()).toEqual(['state.json', 'state.json.previous']);
  });

  it('goes on from the generation before when the journal is missing or not whole', () => {
    const file = folder();
    writeJournal(file, state('one'));
    writeJournal(file, state('two'));
    rmSync(file);
    expect(readJournal(file)).toEqual({
      state: state('one'),
      recovered: { from: 'previous', problem: `${file} is missing` },
    });
    // Cut short, as a file is whose blocks never reached the disk.
    writeFileSync(file, '{\n  "version": 1,\n  "histo');
    const cut = readJournal(file);
    expect(cut.state).toEqual(state('one'));
    expect(cut.recovered).toEqual({
      from: 'previous',
      problem: `${file} is not whole (26 characters)`,
    });
    // The next write keeps what could not be read aside, and never makes it the generation
    // before: that stays the last one that was whole.
    writeJournal(file, state('three'));
    expect(readJournal(file)).toEqual({ state: state('three') });
    expect(JSON.parse(readFileSync(`${file}.previous`, 'utf8'))).toEqual(state('one'));
    expect(
      readdirSync(join(file, '..')).some((name) => /^state\.json\.unreadable-\d{8}T/.test(name)),
    ).toBe(true);
  });

  it('says that the state is lost when neither generation can be read, and only then', () => {
    const file = folder();
    writeJournal(file, state('one'));
    writeJournal(file, state('two'));
    writeFileSync(file, '');
    writeFileSync(`${file}.previous`, '[]');
    const lost = readJournal(file);
    expect(lost.state).toEqual(emptyState());
    expect(lost.recovered).toEqual({
      from: 'lost',
      problem: `${file} is not whole (0 characters), and ${file}.previous does not hold a state`,
    });
    rmSync(`${file}.previous`);
    expect(readJournal(file).recovered?.from).toBe('lost');
    // A state another version of the updater wrote is not damage, and is never replaced.
    writeFileSync(file, '{ "version": 2, "history": [] }');
    expect(() => readJournal(file)).toThrow('has an unknown format');
    expect(() => writeJournal(file, state('three'))).toThrow('has an unknown format');
  });

  it('takes up an activation from the generation before, a step behind', async () => {
    // The newest journal said the release was selected and started; the one before it still
    // says that the data is to be backed up. The release may have written to the data since,
    // so the backup made for this activation is used, not a new one of what the data holds
    // now: when the release fails, the release before gets its own data back.
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
    f.kill('startService', 'after');
    await expect(f.run()).rejects.toThrow(Killed);
    expect(f.env.data).toEqual([B]);
    const activation = f.env.state.release!.activation!;
    activation.step = 'backup';
    delete activation.backup;
    delete f.env.state.release!.backup;
    f.env.recovered = { from: 'previous', problem: '/var/lib/x/state.json is missing' };
    f.revive();
    f.calls.length = 0;
    await expect(f.run()).rejects.toThrow(`v0.2.1 failed its health check; ${A} was restored.`);
    expect(f.logs).toContain(
      "The updater's state could not be used (/var/lib/x/state.json is missing); the one written before it is, which may be a step behind. Every step is done again from its start.",
    );
    expect(f.env.backups.size).toBe(1);
    expect(f.env.data).toEqual([A]);
    expect(f.serves()).toBe(A);
    expect(f.env.recovered).toBeUndefined();
  });

  it('starts and checks what is selected when a relay is stopped and no state says why', async () => {
    // The generation before knows of no activation, and the relay does not run: an updater
    // may have stopped it. What is selected is started and checked before anything else.
    const f = fake();
    f.env.active = false;
    f.env.recovered = { from: 'previous', problem: 'state.json is not whole (12 characters)' };
    await f.run();
    expect(f.calls).toEqual(['start']);
    expect(f.serves()).toBe(A);
    expect(f.logs).toContain(`${A}, which is selected, was started and its relay answers.`);
    expect(f.env.recovered).toBeUndefined();

    // With no state at all the same, and then the check says what is left to do by hand.
    const lost = fake();
    lost.env.state = emptyState();
    lost.env.active = false;
    lost.env.recovered = { from: 'lost', problem: 'state.json is missing, and so on' };
    lost.publish('0.2.1', B);
    await expect(lost.run()).rejects.toThrow(
      `The updater's state was lost (state.json is missing, and so on). ${A}, which is selected, was started and its relay answers. No updater key is trusted any more, so no release is installed: run scripts/vps/install.sh again.`,
    );
    expect(lost.serves()).toBe(A);
    expect(lost.calls).toEqual(['start']);
    // Later checks install nothing until a key is trusted again, and say so.
    await expect(lost.run()).rejects.toThrow('No updater key is trusted yet');
    expect(lost.calls).toEqual(['start']);

    // A relay that does not start is said at every check, and nothing is written over it.
    const down = fake();
    down.env.active = false;
    down.env.healthy = () => false;
    down.env.recovered = { from: 'previous', problem: 'state.json is missing' };
    for (let checks = 0; checks < 2; checks++)
      await expect(down.run()).rejects.toThrow(
        new RegExp(
          `^The updater's state was not usable and agent-studio does not run: the relay of ${A}, which is selected, ended .* Intervene manually\\.$`,
        ),
      );
    expect(down.env.recovered).toBeDefined();

    // A relay that runs is left alone.
    const up = fake();
    up.env.recovered = { from: 'previous', problem: 'state.json is missing' };
    await up.run();
    expect(up.calls).toEqual([]);
  });
});

describe('private data backups', () => {
  // An archive of lines, one for each thing it holds. Like tar, it unpacks what it holds and
  // ends well where the archive ends, also when that is in the middle.
  let archived = 0;
  let packs = 0;
  const lines: Archiver = {
    archive(parent, name, skip, to) {
      archived++;
      const out = listTree(join(parent, name), skip).map((entry) =>
        JSON.stringify({
          ...entry,
          ...(entry.type === 'file'
            ? { data: readFileSync(join(parent, name, entry.path)).toString('base64') }
            : {}),
        }),
      );
      writeFileSync(to, `${out.join('\n')}\n`);
    },
    extract(backup, into) {
      const raw = readFileSync(backup);
      const text = (backup.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
      const name = 'agent-studio';
      mkdirSync(join(into, name), { recursive: true });
      for (const line of text.split('\n')) {
        let entry: { path: string; type: string; data?: string; mtime?: number };
        try {
          entry = JSON.parse(line);
        } catch {
          // The archive ends here.
          return;
        }
        const path = join(into, name, entry.path);
        if (entry.type === 'folder') mkdirSync(path, { recursive: true });
        else if (entry.type === 'file')
          writeFileSync(path, Buffer.from(entry.data ?? '', 'base64'));
      }
    },
    pack(archive, to) {
      packs++;
      writeFileSync(to, gzipSync(readFileSync(archive)));
    },
    unpacked: (packed) => sha(gunzipSync(readFileSync(packed))),
  };
  const folders = () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-vps-backup-'));
    temporary.push(root);
    const data = join(root, 'agent-studio');
    const backups = join(root, 'backups');
    mkdirSync(join(data, 'images'), { recursive: true });
    mkdirSync(join(data, '.npm'));
    writeFileSync(join(data, '.npm', 'cache'), 'not private data');
    writeFileSync(join(data, 'workspace.json'), 'the chats '.repeat(400));
    writeFileSync(join(data, 'images', 'one'), 'an image '.repeat(200));
    writeFileSync(join(data, 'web-push.json'), 'keys');
    archived = 0;
    packs = 0;
    const backup = (options: { began?: string; behind?: boolean; archiver?: Archiver } = {}) =>
      makeBackup({
        data,
        backups,
        commit: B,
        skip: ['.npm'],
        made: new Date('2026-11-20T12:00:00Z'),
        archiver: lines,
        ...options,
      });
    const untouched = () => {
      expect(readFileSync(join(data, 'workspace.json'), 'utf8')).toBe('what the release wrote');
      expect(readdirSync(root).sort()).toEqual(['agent-studio', 'backups']);
    };
    const restore = (path: string, keep = 'b-1') =>
      restoreBackup({ data, backup: path, keep, archiver: lines });
    return { root, data, backups, backup, restore, untouched };
  };

  it('records what was backed up and the archive that holds it, before the archive has its name', () => {
    const f = folders();
    const path = f.backup();
    expect(path).toBe(join(f.backups, `pre-${B}.tar`));
    const manifest = readManifest(path);
    expect(manifest).toMatchObject({ version: 1, commit: B, archive: fileDigest(path) });
    expect(manifest.entries.map((entry) => `${entry.type} ${entry.path}`)).toEqual([
      'folder images',
      'file images/one',
      'file web-push.json',
      'file workspace.json',
    ]);
    expect(manifest.entries.find((entry) => entry.path === 'workspace.json')?.size).toBe(4000);
    verifyBackup(path, manifest);
    expect(readdirSync(f.backups).sort()).toEqual([`pre-${B}.tar`, `pre-${B}.tar.manifest.json`]);
    // A second backup for the same release takes another name; neither replaces the other.
    expect(f.backup()).toBe(join(f.backups, `pre-${B}-20261120T120000Z.tar`));
  });

  it('names no archive that was not finished, and clears what a killed updater left', () => {
    const f = folders();
    const killed: Archiver = {
      ...lines,
      archive(parent, name, skip, to) {
        writeFileSync(to, '{"path":"images","type":"folder"}\n{"path":"ima');
        throw new Error('killed while archiving');
      },
    };
    expect(() => f.backup({ archiver: killed })).toThrow('killed while archiving');
    expect(readdirSync(f.backups)).toEqual([]);
    // Killed for good, its file stays: under a name of its own, which nothing takes for a
    // backup, and which the next one removes.
    writeFileSync(join(f.backups, `pre-${B}.tar.77-00112233.partial`), 'half an archive');
    const path = f.backup();
    expect(readdirSync(f.backups).sort()).toEqual([`pre-${B}.tar`, `pre-${B}.tar.manifest.json`]);
    verifyBackup(path, readManifest(path));
  });

  it('uses the backup an updater made for the activation and could not record', () => {
    const f = folders();
    const began = '2026-11-20T11:59:00.000Z';
    const path = f.backup({ began });
    // The relay is stopped and the data as the backup holds it: it is that backup.
    expect(f.backup({ began })).toBe(path);
    expect(archived).toBe(1);
    // Another activation makes its own.
    expect(f.backup({ began: '2026-11-21T00:00:00.000Z' })).not.toBe(path);
    expect(archived).toBe(2);
    // The data was written since, as by a relay that ran in between: what it holds now is
    // backed up, unless it was the release itself that may have written to it.
    writeFileSync(join(f.data, 'workspace.json'), 'what a relay wrote since'.padEnd(4000));
    utimesSync(join(f.data, 'workspace.json'), new Date(), new Date(Date.now() + 5000));
    expect(f.backup({ began, behind: true })).toBe(path);
    expect(archived).toBe(2);
    const third = f.backup({ began });
    expect(third).not.toBe(path);
    expect(archived).toBe(3);
  });

  it('puts a backup back only when it is the archive that was made', () => {
    // Cut short where tar still ends well: one file of two would be unpacked and installed.
    const cut = folders();
    let path = cut.backup();
    writeFileSync(join(cut.data, 'workspace.json'), 'what the release wrote');
    const whole = readFileSync(path);
    writeFileSync(path, whole.subarray(0, whole.indexOf('\n', 40) + 1));
    expect(() => cut.restore(path)).toThrow(BackupError);
    expect(() => cut.restore(path)).toThrow(
      `it holds ${lstatSync(path).size} bytes where ${whole.length} were written`,
    );
    cut.untouched();

    // The same bytes, one of them another.
    const changed = folders();
    path = changed.backup();
    writeFileSync(join(changed.data, 'workspace.json'), 'what the release wrote');
    const bytes = readFileSync(path);
    bytes[100] ^= 1;
    writeFileSync(path, bytes);
    expect(() => changed.restore(path)).toThrow(
      'it is not the archive that was written (its SHA-256 differs)',
    );
    changed.untouched();

    // Removed, or without the manifest that says what it should hold.
    const gone = folders();
    path = gone.backup();
    writeFileSync(join(gone.data, 'workspace.json'), 'what the release wrote');
    rmSync(manifestOf(path));
    expect(() => gone.restore(path)).toThrow(/^it has no manifest/);
    rmSync(path);
    expect(() => gone.restore(path)).toThrow(BackupError);
    gone.untouched();
  });

  it('checks what a backup unpacked to before the data makes way for it', () => {
    // The archive is the one that was written, and still does not unpack to everything that
    // was backed up (it was cut before its manifest was made, or the disk filled while it
    // was unpacked): what was unpacked is removed, and the data never moved.
    const f = folders();
    const cutting: Archiver = {
      ...lines,
      archive(parent, name, skip, to) {
        lines.archive(parent, name, skip, to);
        const whole = readFileSync(to);
        writeFileSync(to, whole.subarray(0, whole.lastIndexOf('\n', whole.length - 2) + 1));
      },
    };
    const path = f.backup({ archiver: cutting });
    verifyBackup(path, readManifest(path));
    writeFileSync(join(f.data, 'workspace.json'), 'what the release wrote');
    expect(() => f.restore(path)).toThrow(
      'it does not unpack to what was backed up: workspace.json is missing',
    );
    f.untouched();
    expect(restoreDone(f.data, 'b-1')).toBe(false);

    expect(treeDifference(listTree(f.data, ['.npm']), listTree(f.data, ['.npm']))).toBeUndefined();
    const listed = listTree(f.data, ['.npm']);
    expect(treeDifference(listed, listed.slice(1))).toBe('images is missing');
    expect(treeDifference(listed.slice(1), listed)).toBe('images was not there');
    expect(
      treeDifference(
        listed,
        listed.map((entry) => (entry.path === 'web-push.json' ? { ...entry, size: 3 } : entry)),
      ),
    ).toBe('web-push.json holds 3 bytes, not 4');
  });

  it('restores a whole backup, once, wherever the restore was interrupted', () => {
    const f = folders();
    const path = f.backup();
    writeFileSync(join(f.data, 'workspace.json'), 'what the release wrote');
    const kept = f.restore(path);
    expect(readFileSync(join(kept, 'workspace.json'), 'utf8')).toBe('what the release wrote');
    expect(readFileSync(join(f.data, 'workspace.json'), 'utf8')).toBe('the chats '.repeat(400));
    expect(existsSync(join(f.data, '.npm'))).toBe(false);
    expect(restoreDone(f.data, 'b-1')).toBe(true);
    // Again under the same name, with the backup gone meanwhile: nothing is replaced, and
    // nothing needs the backup any more.
    writeFileSync(join(f.data, 'workspace.json'), 'what the restored relay wrote');
    rmSync(path);
    expect(f.restore(path)).toBe(kept);
    expect(readFileSync(join(f.data, 'workspace.json'), 'utf8')).toBe(
      'what the restored relay wrote',
    );

    // Killed while unpacking: half of it lies beside the data, which was not touched, and
    // the restore starts over.
    const g = folders();
    const again = g.backup();
    writeFileSync(join(g.data, 'workspace.json'), 'what the release wrote');
    const staging = join(g.root, '.agent-studio-restore-b-1');
    mkdirSync(join(staging, 'agent-studio', 'images'), { recursive: true });
    expect(restoreDone(g.data, 'b-1')).toBe(false);
    g.restore(again);
    expect(readFileSync(join(g.data, 'workspace.json'), 'utf8')).toBe('the chats '.repeat(400));
    expect(existsSync(staging)).toBe(false);

    // Killed after the data was moved aside, before the backup took its place: no data
    // folder at all, which no relay may be started on, and the restore is not done.
    const h = folders();
    const third = h.backup();
    lines.extract(third, join(h.root, '.agent-studio-restore-b-1'));
    renameSync(h.data, join(h.root, '.agent-studio-failed-b-1'));
    expect(restoreDone(h.data, 'b-1')).toBe(false);
    h.restore(third);
    expect(restoreDone(h.data, 'b-1')).toBe(true);
    expect(readFileSync(join(h.data, 'images', 'one'), 'utf8')).toBe('an image '.repeat(200));
  });

  it('compresses a backup beside itself, and names the copy only once it is the archive', () => {
    const f = folders();
    const path = f.backup();
    const original = readFileSync(path);
    const listing = () => readdirSync(f.backups).sort();
    const both = [`pre-${B}.tar`, `pre-${B}.tar.manifest.json`];

    // Killed while compressing, and when the copy is compared: the archive stays as it is,
    // no copy has its name, and the manifest records none.
    for (const broken of [
      {
        ...lines,
        pack(archive: string, to: number) {
          writeFileSync(to, gzipSync(readFileSync(archive)).subarray(0, 60));
          throw new Error('killed while compressing');
        },
      },
      {
        ...lines,
        unpacked() {
          throw new Error('killed while comparing');
        },
      },
      // A copy that is cut short, or holds something else, is never published.
      { ...lines, pack: (archive: string, to: number) => writeFileSync(to, gzipSync('else')) },
    ] as Archiver[]) {
      expect(() => packBackup(path, broken)).toThrow();
      expect(listing()).toEqual(both);
      expect(readManifest(path).compressed).toBeUndefined();
      expect(readFileSync(path).equals(original)).toBe(true);
    }
    // A file a compressor that was killed for good left behind goes with the next one.
    writeFileSync(`${path}.gz.99-aabbccdd.partial`, 'half a copy');

    const packed = packBackup(path, lines);
    expect(packed).toBe(`${path}.gz`);
    // The archive is still there: it goes only once the state names the copy.
    expect(listing()).toEqual([both[0], `pre-${B}.tar.gz`, both[1]]);
    const manifest = readManifest(packed);
    expect(manifest.compressed).toEqual(fileDigest(packed));
    verifyBackup(packed, manifest);
    verifyBackup(path, manifest);

    // Done again, as by a check after an updater that was killed before it wrote the state:
    // the copy that is there is the one, and nothing is compressed twice.
    packs = 0;
    expect(packBackup(path, lines)).toBe(packed);
    expect(packs).toBe(0);
    // Unless it is not the copy that was recorded.
    writeFileSync(packed, 'something else');
    expect(packBackup(path, lines)).toBe(packed);
    expect(packs).toBe(1);
    verifyBackup(packed, readManifest(packed));

    // The copy alone restores the data, checked against the same manifest.
    rmSync(path);
    writeFileSync(join(f.data, 'workspace.json'), 'what the release wrote');
    f.restore(packed);
    expect(readFileSync(join(f.data, 'workspace.json'), 'utf8')).toBe('the chats '.repeat(400));
    // And one that is cut short does not.
    const g = folders();
    const cut = packBackup(g.backup(), lines);
    writeFileSync(cut, readFileSync(cut).subarray(0, 40));
    writeFileSync(join(g.data, 'workspace.json'), 'what the release wrote');
    expect(() => g.restore(cut)).toThrow(/^it holds 40 bytes where \d+ were written$/);
    g.untouched();
  });

  it('removes the archive only after the state names its compressed copy', async () => {
    const tar = `/var/backups/agent-studio/pre-${B}.tar`;
    const f = fake();
    f.publish('0.2.1', B);
    await f.run();
    expect(f.tidied).toEqual([`compress ${tar}`, `remove ${tar}`]);
    expect(f.env.state.history[0].backup).toBe(`${tar}.gz`);
    expect(f.env.state.release?.backup).toBe(`${tar}.gz`);
    expect([...f.env.backups.keys()]).toEqual([`${tar}.gz`]);

    // Killed once the copy is there, before the state says so: the state still names the
    // archive, which is still there, and the next check finishes.
    const before = fake();
    before.publish('0.2.1', B);
    before.kill('compress', 'after');
    await expect(before.run()).rejects.toThrow(Killed);
    expect(before.env.state.history[0]).toMatchObject({ backup: tar, packing: 1 });
    expect(before.env.backups.has(tar)).toBe(true);
    before.revive();
    await before.run();
    expect(before.env.state.history[0]).toEqual(expect.objectContaining({ backup: `${tar}.gz` }));
    expect(before.env.state.history[0].packing).toBeUndefined();
    expect([...before.env.backups.keys()]).toEqual([`${tar}.gz`]);

    // Killed once the state names the copy, before the archive is removed: the state says
    // what is left to remove, and the next check removes it.
    const after = fake();
    after.publish('0.2.1', B);
    after.kill('removeBackup', 'before');
    await expect(after.run()).rejects.toThrow(Killed);
    expect(after.env.state).toMatchObject({ cleanup: [tar], history: [{ backup: `${tar}.gz` }] });
    expect([...after.env.backups.keys()].sort()).toEqual([tar, `${tar}.gz`]);
    after.revive();
    await after.run();
    expect(after.env.state.cleanup).toBeUndefined();
    expect([...after.env.backups.keys()]).toEqual([`${tar}.gz`]);

    // A backup that cannot be compressed stays as it is, and is tried three times in all.
    const failing = fake();
    failing.publish('0.2.1', B);
    failing.env.damaged.add(tar);
    for (let checks = 0; checks < 5; checks++) await failing.run();
    expect(failing.tidied).toEqual([`compress ${tar}`, `compress ${tar}`, `compress ${tar}`]);
    expect(failing.env.state.history[0]).toMatchObject({ backup: tar, packing: 3 });
    expect(failing.env.state.release).toMatchObject({ phase: 'active' });
  });

  it('leaves the data as it is, nothing moved aside, when the backup cannot be put back', async () => {
    const tar = `/var/backups/agent-studio/pre-${B}.tar`;
    const why = 'it holds 1024 bytes where 20480 were written';
    const said = ` The data backup ${tar} could not be put back (${why}), so the private data stayed as it was, with nothing moved aside.`;
    // The release fails its check and its backup was cut short meanwhile: the release before
    // is started on the data as it is, and the error says exactly that.
    const f = fake();
    f.publish('0.2.1', B);
    f.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
    f.env.damaged.add(tar);
    await expect(f.run()).rejects.toThrow(
      new RegExp(
        `^v0\\.2\\.1 failed its health check; ${A} runs again, on the data as v0\\.2\\.1 left it\\.${said.replace(/[.()]/g, '\\$&')} Its relay ended`,
      ),
    );
    expect(f.logs).toContain(
      `The data backup ${tar} cannot be put back: ${why}. The private data stays as it is, and nothing was moved aside.`,
    );
    expect(f.env.kept.size).toBe(0);
    expect(f.env.data).toEqual([B, A]);
    expect(f.serves()).toBe(A);
    expect(f.env.state.release).toMatchObject({ phase: 'failed' });

    // The release before no longer starts either: the new one is started once more on the
    // same data, and when it serves, the note says what it runs on. No backup is kept as one.
    const outgrown = fake();
    outgrown.publish('0.2.1', B);
    // Its backup is removed once the release is started the first time.
    outgrown.env.relay = (release, trial, start) => {
      if (release === B && !trial && start < 2) outgrown.env.backups.delete(tar);
      return (release === B && !trial && start < 2) || release === A ? { crash: true } : {};
    };
    await outgrown.run();
    expect(outgrown.env.state.release).toMatchObject({ phase: 'active' });
    expect(outgrown.env.state.release?.note).toContain(
      `so v0.2.1 was started once more, on the data as it was left, and serves. ${A} can no longer be gone back to. The data backup ${tar} could not be put back (it is missing)`,
    );
    expect(outgrown.env.kept.size).toBe(0);
    expect(outgrown.calls.filter((call) => call.startsWith('restore'))).toHaveLength(1);
    expect(outgrown.env.state.history[0].backup).toBeUndefined();
    expect(outgrown.serves()).toBe(B);

    // Whole at the first restore and cut short by the second: what the first one kept stays,
    // and the second moves nothing.
    const second = fake();
    second.publish('0.2.1', B);
    second.env.relay = (release, trial, start) => {
      if (release === A) second.env.damaged.add(tar);
      return (release === B && !trial && start < 2) || release === A ? { crash: true } : {};
    };
    await second.run();
    expect(second.env.kept.size).toBe(1);
    expect(second.env.data).toEqual([A, B]);
    expect(second.env.state.release?.note).toContain('on the data as it was left, and serves');
    expect(second.env.state.release?.note).toContain('Data the failed release wrote is kept in');

    // A new server's first release: the relay stays stopped, and the error says what the
    // data holds.
    const first = fake();
    first.env.current = undefined;
    first.env.active = false;
    first.env.healthy = () => false;
    first.env.damaged.add(tar);
    first.publish('0.2.1', B);
    await expect(first.run()).rejects.toThrow(
      `v0.2.1 failed its health check, so the relay stays stopped.${said} Its relay ended`,
    );
    expect(first.env.kept.size).toBe(0);

    // Killed while it goes back, the next updater does not try the backup again.
    const killed = fake();
    killed.publish('0.2.1', B);
    killed.env.relay = (release, trial) => (release === B && !trial ? { crash: true } : {});
    killed.env.damaged.add(tar);
    killed.kill('select', 'before', 2);
    await expect(killed.run()).rejects.toThrow(Killed);
    expect(killed.env.state.release?.activation).toMatchObject({
      step: 'previous',
      restoreError: why,
    });
    killed.revive();
    killed.calls.length = 0;
    await expect(killed.run()).rejects.toThrow(`${A} runs again, on the data as v0.2.1 left it.`);
    expect(killed.calls).toEqual(['stop', `select ${A}`, 'start']);
  });

  it('counts what the disks must hold at once, together where they are one disk', () => {
    const tree = { bytes: 800_000_000, entries: 2000 };
    const disk = (device: number, free: number, path = device === 1 ? '/var/lib' : '/backups') => ({
      path,
      device,
      free,
    });
    // One disk: the archive and the two restores an activation can need, 2.4 GB and more.
    // Each alone would fit in 1.7 GB, which is what was asked for before.
    expect(spaceShort(tree, disk(1, 1_700_000_000), disk(1, 1_700_000_000, '/var/backups'))).toBe(
      '/var/backups and /var/lib share a disk with 1700 MB free, less than the 2420 MB that a backup of the 800 MB of private data (804 MB) and the two restores an activation can need (1617 MB) take together.',
    );
    expect(
      spaceShort(tree, disk(1, 2_500_000_000), disk(1, 2_500_000_000, '/var/backups')),
    ).toBeUndefined();
    // Two disks: each needs its own share, and no more.
    expect(spaceShort(tree, disk(1, 1_700_000_000), disk(2, 900_000_000))).toBeUndefined();
    expect(spaceShort(tree, disk(1, 1_700_000_000), disk(2, 700_000_000))).toBe(
      '/backups has 700 MB free, less than a backup of the 800 MB of private data takes (804 MB).',
    );
    expect(spaceShort(tree, disk(1, 1_500_000_000), disk(2, 900_000_000))).toBe(
      '/var/lib has 1500 MB free, less than the two restores of the 800 MB of private data that an activation can need (1617 MB).',
    );
  });
});

describe('the updater’s own unit', () => {
  const minutes = (count: number) => count * 60_000;
  const file = (path: string) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  it('has no deadline, and a watchdog that the updater answers while it shows signs of life', () => {
    const unit = file('scripts/vps/agent-studio-update.service').split('\n');
    for (const line of [
      'Type=notify',
      'NotifyAccess=all',
      'WatchdogSec=5min',
      'TimeoutStartSec=infinity',
    ])
      expect(unit).toContain(line);
    expect(unit.some((line) => /^(RuntimeMaxSec|TimeoutSec)=/.test(line))).toBe(false);
    // The updater takes the lock itself: a unit that runs it under flock would end without
    // having said that it started whenever the lock is held.
    expect(unit.find((line) => line.startsWith('ExecStart='))).toBe(
      'ExecStart=/opt/agent-studio/runtimes/node-v24.20.0-linux-x64/bin/node /opt/agent-studio/updater/vps/update.ts check',
    );
    // A unit that says it started at once is waited for with --wait.
    expect(file('scripts/vps/setup.sh')).toContain(
      'systemctl start --wait agent-studio-update.service',
    );
  });

  it('counts the updater’s own code running, or its commands working, as signs of life', () => {
    const limit = minutes(15);
    // Its own code runs every ten seconds, for three hours: never hung.
    let life = liveness(limit, 0);
    for (let at = 10_000; at <= minutes(180); at += 10_000) {
      life.beat(at);
      expect(life.alive(at)).toBe(true);
    }
    // A command holds it for an hour and works all the while: the unit's CPU time grows.
    life = liveness(limit, 0);
    life.sample(0, { cpu: 100, io: 0 });
    for (let at = 30_000; at <= minutes(60); at += 30_000) {
      life.sample(at, { cpu: 100 + at / 2, io: 0 });
      expect(life.alive(at)).toBe(true);
    }
    // Or the disk, with next to no CPU time: an archive being flushed.
    life = liveness(limit, 0);
    life.sample(0, { cpu: 100, io: 0 });
    for (let at = 30_000; at <= minutes(60); at += 30_000) {
      life.sample(at, { cpu: 100, io: at * 100 });
      expect(life.alive(at)).toBe(true);
    }
    // Neither: hung after the limit, and not before. What answering the watchdog itself
    // costs, a few milliseconds of CPU time each half minute, is not work.
    life = liveness(limit, 0);
    life.sample(0, { cpu: 100, io: 0 });
    for (let at = 30_000; at < limit; at += 30_000) {
      life.sample(at, { cpu: 100 + at / 3000, io: 0 });
      expect(life.alive(at)).toBe(true);
    }
    life.sample(limit, { cpu: 400, io: 0 });
    expect(life.alive(limit)).toBe(false);
    expect(life.idle(limit)).toBe(limit);
    // A unit without accounting says nothing either way.
    life = liveness(limit, 0);
    life.sample(minutes(20), {});
    expect(life.alive(minutes(20))).toBe(false);
  });

  it('is ended when it hangs, wherever that is, and the next check goes on', async () => {
    for (const method of ['stopService', 'backup', 'startService', 'restore'] as const) {
      const f = fake();
      f.asUnit();
      f.publish('0.2.1', B);
      f.env.relay = (release, trial, start) =>
        release === B && !trial && start < 2 && method === 'restore' ? { crash: true } : {};
      f.env.hangs = method;
      await expect(f.run()).rejects.toThrow(Killed);
      expect(f.env.state.release?.activation).toBeDefined();
      // The timer starts the next one, which goes on from the state.
      for (let checks = 0; checks < 3; checks++) {
        f.revive();
        await f.run().catch(() => undefined);
      }
      expect(f.env.state.release?.activation, method).toBeUndefined();
      expect(f.serves(), method).toBe(method === 'restore' ? A : B);
    }
  });

  it('holds the deployment lock for everything that changes the state', () => {
    const lock = '/opt/agent-studio/.deploy.lock';
    // A check skips its run while the lock is held; retry and trust wait for it.
    expect(lockArguments(lock, false, ['node', 'update.ts', 'check'])).toEqual([
      '--nonblock',
      '--conflict-exit-code',
      '75',
      lock,
      'node',
      'update.ts',
      'check',
    ]);
    expect(lockArguments(lock, true, ['node', 'update.ts', 'retry'])).toEqual([
      lock,
      'node',
      'update.ts',
      'retry',
    ]);
    const install = file('scripts/vps/install.sh');
    // install.sh waits for a running check before it replaces the updater or trusts a key,
    // and tells update.ts that the lock is held already.
    expect(install).toContain('exec 9>"$root/.deploy.lock"');
    expect(install.indexOf('flock 9')).toBeLessThan(install.indexOf('install -m 0644'));
    expect(install).toContain(
      'AGENT_STUDIO_UPDATE_LOCK=held "$node" "$updater/vps/update.ts" trust "$config"',
    );
  });
});

describe('an interrupted host switch', () => {
  const ready = async () => {
    const f = fake();
    f.env.host = '0.8.9';
    f.publish('0.9.0', B, { linux: true });
    return f;
  };

  it('never takes a link that selects the version for a host that runs it', async () => {
    // Killed between the link and the restart: the link selects the new version, and the
    // process that runs is still the one from before.
    const f = await ready();
    f.kill('selectHost', 'after');
    await expect(f.run({ host })).rejects.toThrow(Killed);
    expect(f.env.host).toBe('0.9.0');
    expect(f.env.state.host).toMatchObject({
      phase: 'staged',
      previous: '0.8.9',
      activation: { step: 'switch' },
    });
    f.revive();
    f.calls.length = 0;
    await f.run({ host });
    expect(f.calls).toEqual(['select host 0.9.0', 'restart host', 'prune host 0.9.0 0.8.9']);
    expect(f.logs).toContain(
      'An updater ended while switching the host to v0.9.0; the switch goes on from there, and nothing is taken for done.',
    );
    expect(f.env.state.host).toMatchObject({ phase: 'active', previous: '0.8.9' });
    expect(f.env.state.host?.activation).toBeUndefined();

    // The same with no record of a switch at all, as after a link changed by hand.
    const g = await ready();
    g.env.current = B;
    await g.run({ host }).catch(() => undefined);
    g.env.state.host = { ...g.env.state.host!, phase: 'staged', staged: g.env.state.host!.seen };
    delete g.env.state.host.activated;
    g.env.host = '0.9.0';
    g.hostProcess('0.8.9');
    g.calls.length = 0;
    await g.run({ host });
    expect(g.calls).toContain('restart host');
    expect(g.env.state.host).toMatchObject({ phase: 'active' });
  });

  it('goes on watching a host it had already restarted', async () => {
    const f = await ready();
    f.kill('restartHost', 'after');
    await expect(f.run({ host })).rejects.toThrow(Killed);
    f.revive();
    f.calls.length = 0;
    const began = f.now();
    await f.run({ host });
    expect(f.calls).toEqual(['prune host 0.9.0 0.8.9']);
    expect(f.logs).toContain('The host already runs v0.9.0; it is watched, not started again.');
    expect(f.now() - began).toBeGreaterThanOrEqual(20_000);
    expect(f.env.state.host).toMatchObject({ phase: 'active' });
  });

  it('finishes going back to the host before, and says when that one does not stay up either', async () => {
    const f = await ready();
    f.env.hostUp = (version) => version !== '0.9.0';
    // The second selection is the one that goes back.
    f.kill('selectHost', 'after', 2);
    await expect(f.run({ host })).rejects.toThrow(Killed);
    expect(f.env.state.host).toMatchObject({ phase: 'staged', activation: { step: 'back' } });
    f.revive();
    f.calls.length = 0;
    await expect(f.run({ host })).rejects.toThrow(
      'The v0.9.0 host did not stay up; it runs 0.8.9 again.',
    );
    expect(f.calls).toEqual(['select host 0.8.9', 'restart host']);
    expect(f.env.state.host).toMatchObject({ phase: 'failed' });
    expect(f.env.state.host?.activation).toBeUndefined();

    const g = await ready();
    g.env.hostUp = () => false;
    await expect(g.run({ host })).rejects.toThrow(
      'The v0.9.0 host did not stay up, and 0.8.9, which is selected again, does not stay up either.',
    );
    expect(g.env.host).toBe('0.8.9');
  });

  it('ends with the host on one version, checked, wherever the updater is killed', async () => {
    const methods = [
      'writeState',
      'provisionHost',
      'selectHost',
      'restartHost',
      'hostRuns',
      'sleep',
    ];
    let kills = 0;
    for (const up of [true, false]) {
      const whole = await ready();
      whole.env.current = B;
      whole.env.hostUp = (version) => up || version !== '0.9.0';
      await whole.run({ host }).catch(() => undefined);
      for (const method of methods as (keyof System)[])
        for (let nth = 1; nth <= (whole.counts.get(method) ?? 0); nth++)
          for (const when of ['before', 'after'] as const) {
            const f = await ready();
            f.env.current = B;
            f.env.hostUp = (version) => up || version !== '0.9.0';
            f.kill(method, when, nth);
            const where = `${up ? 'stays up' : 'does not stay up'}: killed ${when} ${method} #${nth}`;
            await f.run({ host }).catch(() => undefined);
            kills++;
            for (let checks = 0; checks < 4; checks++) {
              f.revive();
              await f.run({ host }).catch(() => undefined);
            }
            const tracked = f.env.state.host;
            expect(tracked?.activation, where).toBeUndefined();
            expect(tracked?.phase, where).toBe(up ? 'active' : 'failed');
            // The link and the process agree, on the version the state says.
            expect(f.env.host, where).toBe(up ? '0.9.0' : '0.8.9');
            expect(f.system.hostRuns(up ? '0.9.0' : '0.8.9'), where).toBe(true);
          }
    }
    expect(kills).toBeGreaterThan(40);
  });
});
