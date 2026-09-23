// Automatic production updates for the Agent Studio relay and web viewer. See docs/DEPLOYMENT.md.
//
// agent-studio-update.timer runs this as root on the VPS every five minutes:
//
//   node update.ts [check]                            Install the latest GitHub release once.
//   node update.ts retry                              Try a failed release again.
//   node update.ts trust <tauri.conf.json> [--replace] Store the trusted updater key.
//
// A release is installed only when its Windows installer carries a valid updater signature for
// its own version from the trusted key, so only the signing release pipeline can deploy. The
// source is built and tested by an unprivileged, sandboxed user without access to private data.
// Activation waits for running replies (at most two hours), backs up private data, switches the
// release and restarts only the relay. A failed health check restores the previous release and
// data. The installer then replaces the public Windows download, keeping the previous package.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { compareVersions, validVersion, verifySignature } from '../release.ts';

export type Config = {
  /** GitHub REST API origin. */
  api: string;
  repo: string;
  /** Holds releases/, the current link and downloads/. */
  root: string;
  /** The relay's private data. */
  data: string;
  backups: string;
  stateDirectory: string;
  service: string;
  port: number;
  buildUser: string;
  buildHome: string;
  /** How long activation waits for running replies. */
  deferLimit: number;
  /** Releases (and their backups) this updater activated that stay on disk. */
  keep: number;
};

export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const value = (name: string, fallback: string) => env[`AGENT_STUDIO_UPDATE_${name}`] || fallback;
  const config: Config = {
    api: value('API', 'https://api.github.com').replace(/\/+$/, ''),
    repo: value('REPO', 'simpx-tech/agent-studio'),
    root: value('ROOT', '/opt/agent-studio'),
    data: value('DATA', '/var/lib/agent-studio'),
    backups: value('BACKUPS', '/var/backups/agent-studio'),
    stateDirectory: value('STATE', '/var/lib/agent-studio-update'),
    service: value('SERVICE', 'agent-studio'),
    port: Number(value('PORT', '4317')),
    buildUser: value('BUILD_USER', 'agent-studio-build'),
    buildHome: value('BUILD_HOME', '/var/cache/agent-studio-build'),
    deferLimit: 2 * 60 * 60 * 1000,
    keep: 5,
  };
  const paths = [config.root, config.data, config.backups, config.stateDirectory, config.buildHome];
  if (
    !allowedUrl(config.api) ||
    !/^[\w.-]+\/[\w.-]+$/.test(config.repo) ||
    !/^[\w@.-]+$/.test(config.service) ||
    !/^[a-z_][a-z0-9_-]*$/.test(config.buildUser) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    paths.some((path) => !isAbsolute(path) || /\s/.test(path))
  )
    throw new Error('Invalid AGENT_STUDIO_UPDATE_* configuration.');
  return config;
}

/** Release data comes over HTTPS; plain HTTP is accepted only on loopback, for testing. */
export function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export type Asset = { name: string; url: string; size: number; sha256?: string };
export type Release = { tag: string; version: string; installer: Asset; signature: Asset };

const assetLimit = 256 * 1024 * 1024;
const installerFile = 'agent-studio-windows-x64-setup.exe';
export const installerName = (version: string) => `Agent-Studio_${version}_x64-setup.exe`;

/** Reads GitHub's latest-release response, requiring the signed Windows installer. */
export function parseRelease(value: unknown): Release {
  const release = (value ?? {}) as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    assets?: unknown;
  };
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!validVersion(version)) throw new Error('The release tag is not v<x.y.z>.');
  if (release.draft !== false || release.prerelease !== false)
    throw new Error('The release is a draft or prerelease.');
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const find = (name: string): Asset => {
    const asset = assets.find((item) => item?.name === name) as
      { browser_download_url?: unknown; size?: unknown; digest?: unknown } | undefined;
    if (!asset) throw new Error(`The release has no ${name}.`);
    const { browser_download_url: url, size, digest } = asset;
    if (typeof url !== 'string' || !allowedUrl(url))
      throw new Error(`${name} has an invalid download URL.`);
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > assetLimit)
      throw new Error(`${name} has an invalid size.`);
    const sha256 = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(digest)?.[1] : '';
    return { name, url, size, ...(sha256 ? { sha256 } : {}) };
  };
  const name = installerName(version);
  return { tag, version, installer: find(name), signature: find(`${name}.sig`) };
}

/** A release that does not come from the signing pipeline; retrying cannot fix it. */
export class AuthenticityError extends Error {}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Confirms the installer was signed by the release pipeline for exactly this version. */
export function authenticate(installer: Buffer, signature: string, release: Release, key: string) {
  if (installer.length !== release.installer.size)
    throw new Error(`The ${release.tag} installer download is incomplete.`);
  if (release.installer.sha256 && sha256(installer) !== release.installer.sha256)
    throw new Error(`The ${release.tag} installer does not match its published SHA-256.`);
  let signed: Record<string, string>;
  try {
    signed = verifySignature(installer, signature, key);
  } catch (error) {
    throw new AuthenticityError(`The ${release.tag} installer is not trusted: ${message(error)}`);
  }
  if (signed.version !== release.version)
    throw new AuthenticityError(
      `The ${release.tag} installer was signed for ${signed.version ?? 'no version'}.`,
    );
}

/** The minisign key ID of a Tauri updater public key, or undefined when it is not one. */
export function publicKeyId(key: string): string | undefined {
  const lines = Buffer.from(key, 'base64').toString('utf8').trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') return undefined;
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

/** Replies still marked running in any workspace checkpoint the relay retains. */
export function runningReplies(data: string): number {
  const directories = [data];
  const workspaces = join(data, 'workspaces');
  if (existsSync(workspaces))
    for (const entry of readdirSync(workspaces, { withFileTypes: true }))
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
        directories.push(join(workspaces, entry.name));
  let count = 0;
  for (const directory of directories) {
    let text: string;
    try {
      text = readFileSync(join(directory, 'workspace.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const state = JSON.parse(text) as {
      workspace?: { conversations?: { messages?: { status?: unknown }[] }[] };
    };
    for (const conversation of state.workspace?.conversations ?? [])
      for (const message of conversation.messages ?? []) if (message.status === 'running') count++;
  }
  return count;
}

export type Tracked = {
  tag: string;
  version: string;
  commit: string;
  installer: Asset;
  signature: Asset;
  /** The updater key that authenticated the installer. */
  key?: string;
  phase: 'pending' | 'staged' | 'active' | 'failed';
  attempts: number;
  retryAt?: string;
  seen: string;
  staged?: string;
  waiting?: 'service' | 'replies';
  previous?: string;
  backup?: string;
  activated?: string;
  /** Publication of the public Windows download. */
  download?: 'published' | 'failed' | 'unavailable';
  downloadAttempts?: number;
  error?: string;
};

export type State = {
  version: 1;
  trustedKey?: string;
  release?: Tracked;
  /** A latest release that is not installed: malformed, or older than the tracked one. */
  ignored?: string;
  /** Releases this updater activated, newest first. */
  history: { tag: string; commit: string; activated: string; backup?: string }[];
};

export const emptyState = (): State => ({ version: 1, history: [] });

/** Side effects, replaceable in tests. */
export type System = {
  now(): Date;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  readState(): State;
  writeState(state: State): void;
  /** GitHub's latest-release response, or undefined when nothing is published. */
  latestRelease(): Promise<unknown>;
  commitOf(tag: string): Promise<string>;
  download(asset: Asset): Promise<Buffer>;
  savedInstaller(commit: string): Buffer | undefined;
  saveInstaller(commit: string, data: Buffer): void;
  /** Removes files kept for a release that was superseded before activation. */
  discard(commit: string): void;
  staged(commit: string): boolean;
  build(commit: string): Promise<void>;
  /** The updater public key a staged release's desktop app trusts. */
  releaseKey(commit: string): string | undefined;
  updaterChanged(commit: string): boolean;
  /** The release directory name the current link selects. */
  currentRelease(): string | undefined;
  serviceActive(): boolean;
  runningReplies(): number;
  stopService(): void;
  startService(): void;
  backup(commit: string): string;
  select(release: string): void;
  /** Replaces private data with a backup and returns where the replaced data was kept. */
  restore(backup: string, commit: string): string;
  /** HTTP status of the relay's unauthenticated state request. */
  probe(): Promise<number | undefined>;
  publishInstaller(commit: string, installer: Buffer): Promise<'published' | 'unavailable'>;
  prune(commit: string, backup?: string): void;
};

const maxAttempts = 3;
const retryDelays = [10 * 60 * 1000, 60 * 60 * 1000];

export function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/** One timer run: track the latest release, then advance it one step as far as it can go. */
export async function check(system: System, config: Config): Promise<void> {
  const state = system.readState();
  const save = () => system.writeState(state);
  await track(system, state, save);
  const release = state.release;
  if (!release || release.phase === 'failed') return;
  if (release.phase === 'pending') {
    if (release.retryAt && system.now() < new Date(release.retryAt)) return;
    await stage(system, state, release, save);
  }
  if (release.phase === 'staged') await activate(system, config, state, release, save);
  if (
    release.phase === 'active' &&
    (release.download === undefined || release.download === 'failed') &&
    (release.downloadAttempts ?? 0) < maxAttempts
  )
    await publish(system, state, release, save);
}

async function track(system: System, state: State, save: () => void) {
  const value = await system.latestRelease();
  if (value === undefined) return;
  const tag = String((value as { tag_name?: unknown }).tag_name ?? '').slice(0, 100);
  if (tag === state.release?.tag || tag === state.ignored) return;
  let latest: Release;
  try {
    latest = parseRelease(value);
  } catch (error) {
    state.ignored = tag;
    save();
    system.log(`Ignoring release ${tag}: ${message(error)}`);
    return;
  }
  const tracked = state.release;
  if (tracked && compareVersions(latest.version, tracked.version) < 0) {
    state.ignored = tag;
    save();
    system.log(`Not installing ${tag}: ${tracked.tag} is newer, and releases never downgrade.`);
    return;
  }
  const commit = await system.commitOf(latest.tag);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Invalid commit for ${latest.tag}.`);
  if (tracked && tracked.phase !== 'active' && tracked.commit !== commit)
    system.discard(tracked.commit);
  state.release = {
    tag: latest.tag,
    version: latest.version,
    commit,
    installer: latest.installer,
    signature: latest.signature,
    phase: 'pending',
    attempts: 0,
    seen: system.now().toISOString(),
  };
  delete state.ignored;
  save();
  system.log(`Found ${latest.tag} at ${commit}.`);
}

async function authenticated(system: System, release: Tracked, key: string) {
  const installer = await system.download(release.installer);
  const signature = (await system.download(release.signature)).toString('utf8');
  authenticate(installer, signature, release, key);
  return installer;
}

async function stage(system: System, state: State, release: Tracked, save: () => void) {
  const key = state.trustedKey;
  if (!key)
    throw new Error('No updater key is trusted yet. Run: update.ts trust <tauri.conf.json>');
  release.attempts++;
  delete release.retryAt;
  delete release.error;
  save();
  try {
    if (!system.savedInstaller(release.commit)) {
      system.saveInstaller(release.commit, await authenticated(system, release, key));
      release.key = key;
      save();
    }
    // A release deployed by hand is already built; never rebuild the live directory.
    if (!system.staged(release.commit) && system.currentRelease() !== release.commit) {
      system.log(`Building and testing ${release.tag}.`);
      await system.build(release.commit);
    }
  } catch (error) {
    const final = error instanceof AuthenticityError || release.attempts >= maxAttempts;
    release.error = message(error);
    if (final) release.phase = 'failed';
    else
      release.retryAt = new Date(
        system.now().getTime() + retryDelays[release.attempts - 1],
      ).toISOString();
    save();
    throw new Error(
      `Could not stage ${release.tag}${final ? '' : `; retrying after ${release.retryAt}`}: ${release.error}`,
    );
  }
  release.phase = 'staged';
  release.staged = system.now().toISOString();
  save();
  system.log(`Staged ${release.tag}.`);
  if (system.updaterChanged(release.commit))
    system.log(
      `${release.tag} changes this updater; reinstall it with scripts/vps/install.sh to use the new version.`,
    );
}

/** The relay answers an unauthenticated state request with 401 once it serves requests. */
async function healthy(system: System): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await system.probe()) === 401) {
      // Catch a release that exits shortly after starting.
      await system.sleep(5000);
      return system.serviceActive() && (await system.probe()) === 401;
    }
    await system.sleep(1000);
  }
  return false;
}

async function activate(
  system: System,
  config: Config,
  state: State,
  release: Tracked,
  save: () => void,
) {
  const fail = (error: string): never => {
    release.phase = 'failed';
    release.error = error;
    save();
    throw new Error(error);
  };
  const wait = (reason: 'service' | 'replies', text: string) => {
    if (release.waiting === reason) return;
    release.waiting = reason;
    save();
    system.log(text);
  };
  const complete = (backup?: string) => {
    const activated = system.now().toISOString();
    release.phase = 'active';
    release.activated = activated;
    delete release.waiting;
    state.history.unshift({
      tag: release.tag,
      commit: release.commit,
      activated,
      ...(backup ? { backup } : {}),
    });
    // Follow key rotation the way installed desktop apps do.
    const key = system.releaseKey(release.commit);
    if (key && key !== state.trustedKey) {
      state.trustedKey = key;
      system.log(`Trusting updater key ${publicKeyId(key)} from ${release.tag} from now on.`);
    }
    const kept = new Set([release.commit, release.previous]);
    const removed = state.history.splice(config.keep);
    save();
    for (const old of removed) if (!kept.has(old.commit)) system.prune(old.commit, old.backup);
  };

  const current = system.currentRelease();
  if (current === release.commit) {
    complete();
    system.log(`${release.tag} is already the current release.`);
    return;
  }
  if (!current) return fail(`${config.root}/current does not select a release.`);
  if (!system.serviceActive())
    return wait('service', `${config.service} is not running; ${release.tag} waits for it.`);
  let running: number;
  try {
    running = system.runningReplies();
  } catch (error) {
    system.log(`Cannot read workspace checkpoints (${message(error)}); treating them as busy.`);
    running = 1;
  }
  const replies = running === 1 ? '1 reply is' : `${running} replies are`;
  if (running && system.now().getTime() - Date.parse(release.staged!) < config.deferLimit)
    return wait(
      'replies',
      `Waiting up to two hours before activating ${release.tag}: ${replies} running.`,
    );
  if (running) system.log(`Activating ${release.tag} although ${replies} still marked running.`);

  system.stopService();
  let backup: string;
  try {
    backup = system.backup(release.commit);
  } catch (error) {
    system.startService();
    return fail(
      `Could not back up private data before activating ${release.tag}: ${message(error)}`,
    );
  }
  release.previous = current;
  release.backup = backup;
  save();
  let ok = false;
  try {
    system.select(release.commit);
    system.startService();
    ok = await healthy(system);
  } catch (error) {
    system.log(`Activating ${release.tag} failed: ${message(error)}`);
  }
  if (ok) {
    complete(backup);
    system.log(`Activated ${release.tag}; ${current} and the private data backup are retained.`);
    return;
  }

  system.log(`${release.tag} failed its health check; restoring ${current} and its data.`);
  let kept = '';
  let restored = false;
  try {
    system.stopService();
    kept = system.restore(backup, release.commit);
    system.select(current);
    system.startService();
    restored = await healthy(system);
  } catch (error) {
    system.log(`Rollback failed: ${message(error)}`);
  }
  fail(
    restored
      ? `${release.tag} failed its health check; ${current} was restored. Data the failed release wrote is kept in ${kept}.`
      : `${release.tag} failed its health check, and restoring ${current} did not bring the relay back. Intervene manually; the data backup is ${backup}.`,
  );
}

async function publish(system: System, state: State, release: Tracked, save: () => void) {
  release.downloadAttempts = (release.downloadAttempts ?? 0) + 1;
  save();
  try {
    const installer =
      system.savedInstaller(release.commit) ??
      (await authenticated(system, release, release.key ?? state.trustedKey ?? ''));
    release.download = await system.publishInstaller(release.commit, installer);
    delete release.error;
    save();
    system.discard(release.commit);
    system.log(
      release.download === 'published'
        ? `Published the ${release.tag} Windows installer; the previous package is retained.`
        : 'No downloads directory exists, so the Windows installer was not published.',
    );
  } catch (error) {
    release.download = 'failed';
    release.error = message(error);
    save();
    throw new Error(`Could not publish the ${release.tag} Windows installer: ${release.error}`);
  }
}

/** Resets a failed release so the next check stages or publishes it again. */
export function retry(state: State): string {
  const release = state.release;
  if (release?.phase === 'failed') {
    release.phase = 'pending';
    release.attempts = 0;
    for (const field of ['retryAt', 'waiting', 'error'] as const) delete release[field];
    return `${release.tag} will be tried again at the next check.`;
  }
  if (release?.phase === 'active' && release.download === 'failed') {
    release.downloadAttempts = 0;
    return `The ${release.tag} Windows installer will be published again at the next check.`;
  }
  delete state.ignored;
  return 'Nothing failed; the latest release will be checked again.';
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} exited with ${result.status ?? result.signal}.`);
}

async function fetchBytes(url: string, limit: number, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'agent-studio-updater', ...headers },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`${url} is larger than expected.`);
    }
    chunks.push(Buffer.from(value));
  }
}

export function createSystem(config: Config): System {
  const releases = join(config.root, 'releases');
  const current = join(config.root, 'current');
  const stateFile = join(config.stateDirectory, 'state.json');
  const saved = (commit: string) => join(config.stateDirectory, `${commit}.installer`);
  const api = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const exists = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  // Runs one build step as the unprivileged build user, confined to the release directory and
  // its npm cache, without private data and with limits that leave room for other services.
  const sandbox = (directory: string, command: string[], network: boolean, input?: number) => {
    const hidden = [config.data, config.backups, config.stateDirectory, '/etc/agent-studio'];
    const properties = [
      'ProtectSystem=strict',
      `ReadWritePaths=${directory} ${config.buildHome}`,
      `InaccessiblePaths=${hidden.map((path) => `-${path}`).join(' ')}`,
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'NoNewPrivileges=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectControlGroups=yes',
      'RestrictSUIDSGID=yes',
      'LockPersonality=yes',
      'MemoryMax=4G',
      'CPUWeight=20',
      'IOWeight=20',
      'Nice=10',
      'TasksMax=2048',
      'RuntimeMaxSec=1800',
      ...(network ? [] : ['PrivateNetwork=yes']),
    ];
    run(
      'systemd-run',
      [
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        '--service-type=exec',
        `--uid=${config.buildUser}`,
        `--gid=${config.buildUser}`,
        `--working-directory=${directory}`,
        `--setenv=HOME=${config.buildHome}`,
        `--setenv=npm_config_cache=${join(config.buildHome, 'npm')}`,
        `--setenv=PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
        '--setenv=CI=1',
        ...properties.map((property) => `--property=${property}`),
        '--',
        ...command,
      ],
      { stdio: [input ?? 'ignore', 'inherit', 'inherit'] },
    );
  };
  // Creates a public, root-owned file without following anything the build left at its path.
  const create = (path: string, data: Buffer | string = '') => {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, data, { flag: 'wx' });
    chmodSync(path, 0o644);
  };
  const system: System = {
    now: () => new Date(),
    log: (text) => console.log(text),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    readState() {
      try {
        const state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
        if (state.version !== 1 || !Array.isArray(state.history))
          throw new Error(`${stateFile} has an unknown format.`);
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
        throw error;
      }
    },
    writeState(state) {
      mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${stateFile}.tmp`, stateFile);
    },
    async latestRelease() {
      const response = await fetch(`${config.api}/repos/${config.repo}/releases/latest`, {
        headers: { ...api, 'User-Agent': 'agent-studio-updater' },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for releases.`);
      return response.json();
    },
    async commitOf(tag) {
      const url = `${config.api}/repos/${config.repo}/commits/${encodeURIComponent(tag)}`;
      const data = await fetchBytes(url, 1024, { ...api, Accept: 'application/vnd.github.sha' });
      return data.toString('utf8').trim();
    },
    async download(asset) {
      const data = await fetchBytes(asset.url, asset.size);
      if (data.length !== asset.size) throw new Error(`${asset.name} download is incomplete.`);
      if (asset.sha256 && sha256(data) !== asset.sha256)
        throw new Error(`${asset.name} does not match its published SHA-256.`);
      return data;
    },
    savedInstaller: (commit) => (exists(saved(commit)) ? readFileSync(saved(commit)) : undefined),
    saveInstaller(commit, data) {
      mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(`${saved(commit)}.tmp`, data, { mode: 0o600 });
      renameSync(`${saved(commit)}.tmp`, saved(commit));
    },
    discard(commit) {
      for (const path of [saved(commit), join(releases, `.building-${commit}`)])
        rmSync(path, { recursive: true, force: true });
      const target = join(releases, commit);
      if (exists(join(target, '.built-by-updater')) && system.currentRelease() !== commit)
        rmSync(target, { recursive: true, force: true });
    },
    staged: (commit) => exists(join(releases, commit, '.deployment-ready')),
    async build(commit) {
      const target = join(releases, commit);
      const building = join(releases, `.building-${commit}`);
      const archive = join(config.stateDirectory, `${commit}.tar.gz`);
      if (system.currentRelease() === commit) throw new Error(`${commit} is the live release.`);
      // Keep an unfinished directory from an earlier manual attempt for inspection.
      if (exists(target)) renameSync(target, join(releases, `.abandoned-${commit}-${stamp()}`));
      rmSync(building, { recursive: true, force: true });
      mkdirSync(building);
      chmodSync(building, 0o755);
      run('chown', [`${config.buildUser}:${config.buildUser}`, building]);
      const source = `${config.api}/repos/${config.repo}/tarball/${commit}`;
      writeFileSync(archive, await fetchBytes(source, assetLimit, api), { mode: 0o600 });
      const input = openSync(archive, 'r');
      try {
        const tar = ['--strip-components=1', '--no-same-owner', '--no-same-permissions'];
        sandbox(building, ['/usr/bin/tar', '-xzf', '-', ...tar], false, input);
      } finally {
        closeSync(input);
        rmSync(archive, { force: true });
      }
      const npm = join(dirname(process.execPath), 'npm');
      sandbox(building, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], true);
      sandbox(building, [npm, 'run', 'build'], false);
      sandbox(building, [npm, 'test'], false);
      // The relay runs these files, so only root may change them from now on.
      run('chown', ['-R', '-h', 'root:root', building]);
      run('chmod', ['-R', 'go-w', building]);
      create(join(building, '.built-by-updater'));
      create(join(building, '.deployment-ready'));
      renameSync(building, target);
    },
    releaseKey(commit) {
      try {
        const path = join(releases, commit, 'src-tauri', 'tauri.conf.json');
        const key = JSON.parse(readFileSync(path, 'utf8'))?.plugins?.updater?.pubkey;
        return typeof key === 'string' && publicKeyId(key) ? key : undefined;
      } catch {
        return undefined;
      }
    },
    updaterChanged(commit) {
      const installed = import.meta.dirname;
      // A Windows checkout may have installed the updater with CRLF line endings.
      const text = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      return [
        [join(releases, commit, 'scripts', 'vps', 'update.ts'), join(installed, 'update.ts')],
        [join(releases, commit, 'scripts', 'release.ts'), join(dirname(installed), 'release.ts')],
      ].some(([candidate, running]) => {
        try {
          return text(candidate) !== text(running);
        } catch {
          return true;
        }
      });
    },
    currentRelease() {
      try {
        const target = realpathSync(current);
        return dirname(target) === realpathSync(releases) ? basename(target) : undefined;
      } catch {
        return undefined;
      }
    },
    serviceActive: () =>
      spawnSync('systemctl', ['is-active', '--quiet', config.service]).status === 0,
    runningReplies: () => runningReplies(config.data),
    stopService() {
      run('systemctl', ['stop', config.service]);
      // A release that crashed in a restart loop may have hit the start rate limit.
      spawnSync('systemctl', ['reset-failed', config.service], { stdio: 'ignore' });
    },
    startService: () => run('systemctl', ['start', config.service]),
    backup(commit) {
      mkdirSync(config.backups, { recursive: true, mode: 0o700 });
      let path = join(config.backups, `pre-${commit}.tar.gz`);
      if (exists(path)) path = join(config.backups, `pre-${commit}-${stamp()}.tar.gz`);
      const name = basename(config.data);
      // Earlier manual builds left an npm cache in the service home; it is not private data.
      const args = ['-czf', `${path}.partial`, `--exclude=${name}/.npm`];
      run('tar', [...args, '-C', dirname(config.data), name]);
      chmodSync(`${path}.partial`, 0o600);
      renameSync(`${path}.partial`, path);
      return path;
    },
    select(release) {
      if (!/^[\w.-]+$/.test(release) || !lstatSync(join(releases, release)).isDirectory())
        throw new Error(`${release} is not a release directory.`);
      const next = join(config.root, `.next-${release}`);
      rmSync(next, { force: true });
      symlinkSync(join(releases, release), next);
      renameSync(next, current);
    },
    restore(backup, commit) {
      const parent = dirname(config.data);
      const name = basename(config.data);
      const staging = join(parent, `.${name}-restore-${stamp()}`);
      const kept = join(parent, `.${name}-failed-${commit.slice(0, 12)}-${stamp()}`);
      mkdirSync(staging, { mode: 0o700 });
      // As root, tar restores the original owners and modes.
      run('tar', ['-xzf', backup, '-C', staging]);
      renameSync(config.data, kept);
      renameSync(join(staging, name), config.data);
      rmdirSync(staging);
      return kept;
    },
    async probe() {
      try {
        const response = await fetch(`http://127.0.0.1:${config.port}/v1/state`, {
          signal: AbortSignal.timeout(3000),
        });
        await response.body?.cancel();
        return response.status;
      } catch {
        return undefined;
      }
    },
    async publishInstaller(commit, installer) {
      const downloads = join(config.root, 'downloads');
      if (!exists(downloads)) return 'unavailable';
      const destination = join(downloads, installerFile);
      const previous = exists(destination) ? readFileSync(destination) : undefined;
      if (previous && sha256(previous) === sha256(installer)) return 'published';
      const place = (data: Buffer, label: string) => {
        const next = join(downloads, `.${label}-${commit}.exe`);
        create(next, data);
        renameSync(next, destination);
      };
      if (previous) {
        let backup = join(config.backups, `pre-${commit}-windows-installer.exe`);
        if (exists(backup))
          backup = join(config.backups, `pre-${commit}-windows-installer-${stamp()}.exe`);
        writeFileSync(backup, previous, { mode: 0o600 });
      }
      place(installer, 'next');
      const url = `http://127.0.0.1:${config.port}/downloads/${installerFile}`;
      const served = await fetchBytes(url, installer.length).catch(() => Buffer.alloc(0));
      if (sha256(served) === sha256(installer)) return 'published';
      if (previous) place(previous, 'rollback');
      else rmSync(destination, { force: true });
      throw new Error('The relay did not serve the new installer; the previous one was restored.');
    },
    prune(commit, backup) {
      if (system.currentRelease() !== commit)
        rmSync(join(releases, commit), { recursive: true, force: true });
      if (backup && dirname(backup) === config.backups) rmSync(backup, { force: true });
      for (const entry of existsSync(config.backups) ? readdirSync(config.backups) : [])
        if (entry.startsWith(`pre-${commit}-windows-installer`))
          rmSync(join(config.backups, entry), { force: true });
    },
  };
  return system;
}

async function main(argv: string[]) {
  const config = readConfig();
  const system = createSystem(config);
  const [command = 'check', ...rest] = argv;
  if (command === 'check') return check(system, config);
  const state = system.readState();
  if (command === 'retry') {
    const result = retry(state);
    system.writeState(state);
    return system.log(result);
  }
  if (command === 'trust' && rest[0]) {
    const key = JSON.parse(readFileSync(rest[0], 'utf8'))?.plugins?.updater?.pubkey;
    const id = typeof key === 'string' ? publicKeyId(key) : undefined;
    if (!id) throw new Error(`${rest[0]} has no updater public key.`);
    if (state.trustedKey && state.trustedKey !== key && rest[1] !== '--replace')
      throw new Error(
        `Updater key ${publicKeyId(state.trustedKey)} is already trusted; pass --replace to change it.`,
      );
    state.trustedKey = key;
    system.writeState(state);
    return system.log(`Trusting updater key ${id}.`);
  }
  throw new Error('Usage: node update.ts [check | retry | trust <tauri.conf.json> [--replace]]');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
