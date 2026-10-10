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
//
// The server also runs the desktop app as a host for its workspace (requested 2026-10-10), so
// the other devices can start chats on it: the release's Linux AppImage, authenticated like the
// installer and extracted by the build user, runs as agent-studio-host.service in server mode
// under a virtual display. The updater provisions what it needs once (Xvfb, its user, optional
// passwordless sudo, Claude Code and Codex, the pairing key, the unit) and switches it to each
// release the relay runs, after running replies end, going back to the previous one when it
// does not stay up.
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
  /** The desktop app this server runs for its workspace's devices, or false to run none. */
  host: Host | false;
};

export type Host = {
  /** The Linux user that runs the app and its agents. */
  user: string;
  /** Whether that user may run anything as root through sudo without a password. */
  sudo: boolean;
  /** The computer's name the first time the app starts. */
  name: string;
  service: string;
  /** The pairing key the service hands the app, kept from the relay's own key. */
  key: string;
  /** The relay's environment file, which holds its pairing key. */
  relayEnv: string;
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
    host:
      value('HOST', 'on') === 'off'
        ? false
        : {
            user: value('HOST_USER', 'agent-studio-host'),
            sudo: value('HOST_SUDO', 'off') === 'on',
            name: value('HOST_NAME', 'VPS'),
            service: value('HOST_SERVICE', 'agent-studio-host'),
            key: value('HOST_KEY', '/etc/agent-studio/host.key'),
            relayEnv: value('RELAY_ENV', '/etc/agent-studio/relay.env'),
          },
  };
  const paths = [config.root, config.data, config.backups, config.stateDirectory, config.buildHome];
  if (config.host) paths.push(config.host.key, config.host.relayEnv);
  if (
    config.host &&
    (!/^[a-z_][a-z0-9_-]*$/.test(config.host.user) ||
      config.host.user === 'root' ||
      !/^[\w@-]+$/.test(config.host.service) ||
      !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(config.host.name))
  )
    throw new Error('Invalid AGENT_STUDIO_UPDATE_HOST_* configuration.');
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
export type Release = {
  tag: string;
  version: string;
  installer: Asset;
  signature: Asset;
  /** The Linux AppImage and its signature, which a server runs as its host. */
  appImage?: Asset;
  appImageSignature?: Asset;
};

const assetLimit = 256 * 1024 * 1024;
const installerFile = 'agent-studio-windows-x64-setup.exe';
export const installerName = (version: string) => `Agent-Studio_${version}_x64-setup.exe`;
export const appImageName = (version: string) => `Agent-Studio_${version}_amd64.AppImage`;

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
  const linux = appImageName(version);
  // A release without its AppImage still updates the relay; the host keeps the one it runs.
  const appImage = assets.some((item) => item?.name === linux)
    ? { appImage: find(linux), appImageSignature: find(`${linux}.sig`) }
    : {};
  return { tag, version, installer: find(name), signature: find(`${name}.sig`), ...appImage };
}

/** A release that does not come from the signing pipeline; retrying cannot fix it. */
export class AuthenticityError extends Error {}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Confirms the installer was signed by the release pipeline for exactly this version. */
export function authenticate(installer: Buffer, signature: string, release: Release, key: string) {
  authenticateAsset(installer, signature, release.installer, release, key, 'installer');
}

/** Confirms a package was signed by the release pipeline for exactly this version. */
export function authenticateAsset(
  data: Buffer,
  signature: string,
  asset: Asset,
  release: Pick<Release, 'tag' | 'version'>,
  key: string,
  label: string,
) {
  if (data.length !== asset.size)
    throw new Error(`The ${release.tag} ${label} download is incomplete.`);
  if (asset.sha256 && sha256(data) !== asset.sha256)
    throw new Error(`The ${release.tag} ${label} does not match its published SHA-256.`);
  let signed: Record<string, string>;
  try {
    signed = verifySignature(data, signature, key);
  } catch (error) {
    throw new AuthenticityError(`The ${release.tag} ${label} is not trusted: ${message(error)}`);
  }
  if (signed.version !== release.version)
    throw new AuthenticityError(
      `The ${release.tag} ${label} was signed for ${signed.version ?? 'no version'}.`,
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
  appImage?: Asset;
  appImageSignature?: Asset;
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

/** The release the server's host runs, or is about to. */
export type HostRelease = {
  tag: string;
  version: string;
  commit: string;
  phase: 'pending' | 'staged' | 'active' | 'failed' | 'unsupported';
  attempts: number;
  retryAt?: string;
  seen: string;
  staged?: string;
  waiting?: 'replies';
  /** The host version that ran before this one. */
  previous?: string;
  activated?: string;
  error?: string;
};

export type State = {
  version: 1;
  trustedKey?: string;
  release?: Tracked;
  host?: HostRelease;
  /** The SHA-256 of the relay key the host's key file was last given. */
  hostKey?: string;
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
  /** GitHub's response for the release of a tag. */
  releaseByTag(tag: string): Promise<unknown>;
  /** Whether a host version is extracted and ready to run. */
  hostStaged(version: string): boolean;
  /**
   * Extracts an authenticated AppImage as the build user, and asks the app whether it runs as a
   * server (`--server-check`). False keeps nothing.
   */
  extractHost(version: string, appImage: Buffer): Promise<boolean>;
  /** The host version the host's current link selects. */
  currentHost(): string | undefined;
  /** Installs what the host needs: packages, its user, sudo, Claude Code and Codex, its unit. */
  provisionHost(): Promise<void>;
  selectHost(version: string): void;
  hostActive(): boolean;
  restartHost(): void;
  stopHost(): void;
  /** Removes host versions other than these. */
  pruneHost(keep: string[]): void;
  /** The relay's own pairing key, from its environment file. */
  relayKey(): string | undefined;
  /** The key the host's service hands the app, or undefined when it has none. */
  hostKey(): string | undefined;
  writeHostKey(key: string): void;
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
  if (release.phase === 'active' && config.host) await host(system, config, state, release, save);
}

/**
 * Keeps the server's host on the release the relay runs: it stages that release's AppImage,
 * provisions what the host needs and switches to it once no reply runs, and keeps its pairing
 * key that of the relay.
 */
async function host(
  system: System,
  config: Config,
  state: State,
  release: Tracked,
  save: () => void,
) {
  if (!state.host || state.host.commit !== release.commit) {
    state.host = {
      tag: release.tag,
      version: release.version,
      commit: release.commit,
      phase: 'pending',
      attempts: 0,
      seen: system.now().toISOString(),
    };
    save();
  }
  const tracked = state.host;
  // A key the relay rotated reaches the host, unless someone gave the host another one.
  const key = system.relayKey();
  if (key) {
    const current = system.hostKey();
    const digest = sha256(Buffer.from(key));
    if (current === undefined || (current !== key && sha256(Buffer.from(current)) === state.hostKey)) {
      system.writeHostKey(key);
      state.hostKey = digest;
      save();
      if (tracked.phase !== 'pending' && tracked.phase !== 'staged' && system.hostActive()) {
        system.restartHost();
        system.log('The relay pairing key changed; the host restarted with it.');
      }
    } else if (current === key && state.hostKey !== digest) {
      state.hostKey = digest;
      save();
    }
  }
  if (tracked.phase === 'pending') {
    if (tracked.retryAt && system.now() < new Date(tracked.retryAt)) return;
    await stageHost(system, state, release, tracked, save);
  }
  if (tracked.phase === 'staged') await activateHost(system, config, tracked, save);
}

async function stageHost(
  system: System,
  state: State,
  release: Tracked,
  tracked: HostRelease,
  save: () => void,
) {
  const key = release.key ?? state.trustedKey;
  if (!key) return;
  const unsupported = (reason: string) => {
    tracked.phase = 'unsupported';
    tracked.error = reason;
    save();
    system.log(`The host keeps its release: ${reason}`);
  };
  tracked.attempts++;
  delete tracked.retryAt;
  delete tracked.error;
  save();
  try {
    if (!system.hostStaged(release.version)) {
      // Releases tracked before the updater knew the AppImage carry no record of it.
      let { appImage, appImageSignature } = release;
      if (!appImage || !appImageSignature)
        ({ appImage, appImageSignature } = parseRelease(await system.releaseByTag(release.tag)));
      if (!appImage || !appImageSignature)
        return unsupported(`${release.tag} has no Linux AppImage.`);
      const data = await system.download(appImage);
      const signature = (await system.download(appImageSignature)).toString('utf8');
      authenticateAsset(data, signature, appImage, release, key, 'AppImage');
      system.log(`Extracting the ${release.tag} host.`);
      if (!(await system.extractHost(release.version, data)))
        return unsupported(`${release.tag} does not run as a server.`);
    }
  } catch (error) {
    const final = error instanceof AuthenticityError || tracked.attempts >= maxAttempts;
    tracked.error = message(error);
    if (final) tracked.phase = 'failed';
    else
      tracked.retryAt = new Date(
        system.now().getTime() + retryDelays[tracked.attempts - 1],
      ).toISOString();
    save();
    throw new Error(
      `Could not stage the ${release.tag} host${final ? '' : `; retrying after ${tracked.retryAt}`}: ${tracked.error}`,
    );
  }
  tracked.phase = 'staged';
  tracked.staged = system.now().toISOString();
  save();
  system.log(`Staged the ${release.tag} host.`);
}

/** The host stays up through its start and a while after it. */
async function hostUp(system: System): Promise<boolean> {
  await system.sleep(10_000);
  if (!system.hostActive()) return false;
  await system.sleep(10_000);
  return system.hostActive();
}

async function activateHost(
  system: System,
  config: Config,
  tracked: HostRelease,
  save: () => void,
) {
  const previous = system.currentHost();
  if (previous === tracked.version && system.hostActive()) {
    tracked.phase = 'active';
    tracked.activated = system.now().toISOString();
    save();
    return;
  }
  // Restarting the host ends the replies it runs.
  let running: number;
  try {
    running = system.runningReplies();
  } catch {
    running = 1;
  }
  if (running && system.now().getTime() - Date.parse(tracked.staged!) < config.deferLimit) {
    if (tracked.waiting !== 'replies') {
      tracked.waiting = 'replies';
      save();
      system.log(`The ${tracked.tag} host waits up to two hours for running replies.`);
    }
    return;
  }
  try {
    await system.provisionHost();
  } catch (error) {
    tracked.phase = 'pending';
    tracked.error = message(error);
    tracked.retryAt = new Date(system.now().getTime() + retryDelays[0]).toISOString();
    save();
    throw new Error(`Could not prepare the server for its host: ${tracked.error}`);
  }
  if (previous !== tracked.version) tracked.previous = previous;
  delete tracked.waiting;
  save();
  let ok = false;
  try {
    system.selectHost(tracked.version);
    system.restartHost();
    ok = await hostUp(system);
  } catch (error) {
    system.log(`Starting the ${tracked.tag} host failed: ${message(error)}`);
  }
  if (ok) {
    tracked.phase = 'active';
    tracked.activated = system.now().toISOString();
    delete tracked.error;
    save();
    system.pruneHost([tracked.version, ...(tracked.previous ? [tracked.previous] : [])]);
    system.log(`The host runs ${tracked.tag}.`);
    return;
  }
  tracked.phase = 'failed';
  if (tracked.previous) {
    system.selectHost(tracked.previous);
    system.restartHost();
    tracked.error = `The ${tracked.tag} host did not stay up; it runs ${tracked.previous} again.`;
  } else {
    system.stopHost();
    tracked.error = `The ${tracked.tag} host did not stay up and was stopped.`;
  }
  save();
  throw new Error(tracked.error);
}

/** The service that runs the host: the app in server mode under a virtual display. */
export function hostUnit(config: Config, home: string): string {
  const host = config.host;
  if (!host) throw new Error('No host is configured.');
  return `# Written by the Agent Studio updater (scripts/vps/update.ts); changes are replaced.
[Unit]
Description=Agent Studio host: chats run on this server for its workspace
After=network-online.target ${config.service}.service
Wants=network-online.target

[Service]
Type=simple
User=${host.user}
WorkingDirectory=~
Environment=AGENT_STUDIO_SERVER=1
Environment=AGENT_STUDIO_RELAY_URL=http://127.0.0.1:${config.port}
Environment="AGENT_STUDIO_COMPUTER_NAME=${host.name}"
Environment=PATH=${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=WEBKIT_DISABLE_COMPOSITING_MODE=1
LoadCredential=relay-key:${host.key}
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/xvfb-run --auto-servernum "--server-args=-screen 0 1440x900x24 -nolisten tcp" ${config.root}/host/current/AppRun
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;
}

/** The relay's pairing key from its environment file's AGENT_STUDIO_RELAY_TOKEN line. */
export function relayKeyIn(environment: string): string | undefined {
  for (const line of environment.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?AGENT_STUDIO_RELAY_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    return value.length >= 32 ? value : undefined;
  }
  return undefined;
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
    ...(latest.appImage && latest.appImageSignature
      ? { appImage: latest.appImage, appImageSignature: latest.appImageSignature }
      : {}),
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
  if (state.host?.phase === 'failed') {
    state.host.phase = 'pending';
    state.host.attempts = 0;
    for (const field of ['retryAt', 'waiting', 'error'] as const) delete state.host[field];
    return `The ${state.host.tag} host will be tried again at the next check.`;
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

// Installs a provider's CLI for the host's user with the provider's own installer, which verifies
// what it downloads: positional arguments only, the whole installer before any of it runs.
const cliInstaller = `set -eu
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
curl -fsSL --retry 2 "$1" -o "$installer"
CODEX_NON_INTERACTIVE=1 "$2" "$installer" </dev/null`;
const clis = [
  ['claude', 'https://claude.ai/install.sh', 'bash'],
  ['codex', 'https://chatgpt.com/codex/install.sh', 'sh'],
] as const;

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
  const hosts = join(config.root, 'host');
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
  // its npm cache, without private data and at low priority beside other services. It has no
  // memory, task or time limit: a build stops only where the machine itself does.
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
      'CPUWeight=20',
      'IOWeight=20',
      'Nice=10',
      'TasksMax=infinity',
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
  // The same sandbox for a command whose output is the answer, ending it after `seconds`.
  const sandboxOutput = (directory: string, command: string[], seconds: number) => {
    const result = spawnSync(
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
        '--setenv=PATH=/usr/bin:/bin',
        ...[
          'ProtectSystem=strict',
          `InaccessiblePaths=${[config.data, config.backups, config.stateDirectory, '/etc/agent-studio'].map((path) => `-${path}`).join(' ')}`,
          'ProtectHome=yes',
          'PrivateTmp=yes',
          'PrivateDevices=yes',
          'PrivateNetwork=yes',
          'NoNewPrivileges=yes',
          `RuntimeMaxSec=${seconds}`,
        ].map((property) => `--property=${property}`),
        '--',
        ...command,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return result.status === 0 ? result.stdout : '';
  };
  // Runs a command outside this updater's own sandbox, where /home is hidden and files are
  // private: as root to set up the system, or as the host's user for what lives in its home.
  const transient = (command: string[], user?: string, check = true) => {
    const result = spawnSync(
      'systemd-run',
      [
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        '--service-type=exec',
        ...(user ? [`--uid=${user}`, '--property=WorkingDirectory=~'] : []),
        '--setenv=DEBIAN_FRONTEND=noninteractive',
        '--property=UMask=0022',
        '--',
        ...command,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (result.error) throw result.error;
    if (check && result.status !== 0)
      throw new Error(`${basename(command[0])} exited with ${result.status ?? result.signal}.`);
    return result.status;
  };
  // Replaces a root-owned file only when it changes, never through what its path points to.
  const place = (path: string, content: string, mode: number) => {
    if (exists(path) && lstatSync(path).isFile() && readFileSync(path, 'utf8') === content)
      return false;
    const staging = join(dirname(path), `.${basename(path)}.new`);
    rmSync(staging, { force: true });
    writeFileSync(staging, content, { flag: 'wx', mode });
    chmodSync(staging, mode);
    return staging;
  };
  // How often the host's service restarted the host on its own, as of the updater's restart.
  let hostRestarts: string | undefined;
  const restartsOf = (service: string) =>
    spawnSync('systemctl', ['show', '--property=NRestarts', '--value', service], {
      encoding: 'utf8',
    }).stdout.trim();
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
    async releaseByTag(tag) {
      const url = `${config.api}/repos/${config.repo}/releases/tags/${encodeURIComponent(tag)}`;
      const response = await fetch(url, {
        headers: { ...api, 'User-Agent': 'agent-studio-updater' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${tag}.`);
      return response.json();
    },
    hostStaged: (version) => exists(join(hosts, version, '.deployment-ready')),
    async extractHost(version, appImage) {
      if (!validVersion(version)) throw new Error(`${version} is not a release version.`);
      mkdirSync(hosts, { recursive: true });
      chmodSync(hosts, 0o755);
      const extracting = join(hosts, `.extracting-${version}`);
      rmSync(extracting, { recursive: true, force: true });
      mkdirSync(extracting);
      chmodSync(extracting, 0o755);
      run('chown', [`${config.buildUser}:${config.buildUser}`, extracting]);
      const image = join(extracting, 'app.AppImage');
      writeFileSync(image, appImage, { flag: 'wx' });
      chmodSync(image, 0o755);
      run('chown', [`${config.buildUser}:${config.buildUser}`, image]);
      try {
        // The AppImage's own runtime unpacks it, as the build user and without network.
        sandbox(extracting, ['/bin/sh', '-c', './app.AppImage --appimage-extract >/dev/null'], false);
        rmSync(image, { force: true });
        const app = join(extracting, 'squashfs-root');
        // The host runs these files, so only root may change them from now on, while every user
        // reads them: the AppImage keeps some folders private to whoever unpacked it.
        run('chown', ['-R', '-h', 'root:root', app]);
        run('chmod', ['-R', 'u=rwX,go=rX', app]);
        // An app from before server mode would try to open its window instead of answering.
        const answer = sandboxOutput(app, [join(app, 'AppRun'), '--server-check'], 120);
        if (!answer.split(/\r?\n/).includes('agent-studio-server 1')) return false;
        create(join(app, '.built-by-updater'));
        create(join(app, '.deployment-ready'));
        rmSync(join(hosts, version), { recursive: true, force: true });
        renameSync(app, join(hosts, version));
        return true;
      } finally {
        rmSync(extracting, { recursive: true, force: true });
      }
    },
    currentHost() {
      try {
        const target = realpathSync(join(hosts, 'current'));
        return dirname(target) === realpathSync(hosts) ? basename(target) : undefined;
      } catch {
        return undefined;
      }
    },
    async provisionHost() {
      const host = config.host;
      if (!host) return;
      // A virtual display, a session bus of its own, sudo, and curl for the CLIs' installers.
      const programs = [
        ['/usr/bin/Xvfb', 'xvfb'],
        ['/usr/bin/xvfb-run', 'xvfb'],
        ['/usr/bin/xauth', 'xauth'],
        ['/usr/bin/dbus-run-session', 'dbus-daemon'],
        ['/usr/bin/sudo', 'sudo'],
        ['/usr/bin/curl', 'curl'],
      ];
      const missing = [...new Set(programs.filter(([file]) => !exists(file)).map(([, p]) => p))];
      if (missing.length) {
        system.log(`Installing ${missing.join(', ')} for the host.`);
        transient(['/usr/bin/apt-get', 'update', '-q']);
        transient(['/usr/bin/apt-get', 'install', '-y', '-q', '--no-install-recommends', ...missing]);
      }
      if (spawnSync('id', ['-u', host.user], { stdio: 'ignore' }).status !== 0) {
        transient([
          '/usr/sbin/useradd',
          '--create-home',
          '--shell',
          '/bin/bash',
          '--comment',
          'Agent Studio host',
          host.user,
        ]);
        system.log(`Created the ${host.user} user for the host.`);
      }
      const entry = spawnSync('getent', ['passwd', host.user], { encoding: 'utf8' }).stdout;
      const home = entry.split(':')[5]?.trim() ?? '';
      if (!isAbsolute(home) || /\s/.test(home))
        throw new Error(`${host.user} has no usable home folder.`);
      // Its agents may administer the server when the updater is configured so.
      const sudoers = join('/etc/sudoers.d', host.service);
      const mark = '# Written by the Agent Studio updater (scripts/vps/update.ts).';
      if (host.sudo) {
        const staging = place(sudoers, `${mark}\n${host.user} ALL=(ALL:ALL) NOPASSWD: ALL\n`, 0o440);
        if (staging) {
          run('visudo', ['-c', '-q', '-f', staging]);
          renameSync(staging, sudoers);
          system.log(`${host.user} may now run commands as root through sudo.`);
        }
      } else if (exists(sudoers) && readFileSync(sudoers, 'utf8').startsWith(mark)) {
        rmSync(sudoers);
        system.log(`${host.user} no longer runs commands through sudo.`);
      }
      for (const [cli, url, runner] of clis) {
        const probe = `command -v ${cli} >/dev/null || test -x "$HOME/.local/bin/${cli}"`;
        if (transient(['/bin/bash', '-lc', probe], host.user, false) === 0) continue;
        system.log(`Installing ${cli} for ${host.user}.`);
        transient(['/bin/bash', '-c', cliInstaller, 'install', url, runner], host.user);
      }
      const unit = join('/etc/systemd/system', `${host.service}.service`);
      const staging = place(unit, hostUnit(config, home), 0o644);
      if (staging) {
        renameSync(staging, unit);
        run('systemctl', ['daemon-reload']);
      }
      run('systemctl', ['enable', '--quiet', host.service]);
    },
    selectHost(version) {
      if (!validVersion(version) || !lstatSync(join(hosts, version)).isDirectory())
        throw new Error(`${version} is not a host version.`);
      const next = join(hosts, `.next-${version}`);
      rmSync(next, { force: true });
      symlinkSync(join(hosts, version), next);
      renameSync(next, join(hosts, 'current'));
    },
    // A host that ended and was started again by its service since this updater started it did
    // not stay up, even when it runs again now.
    hostActive: () =>
      !!config.host &&
      spawnSync('systemctl', ['is-active', '--quiet', config.host.service]).status === 0 &&
      (hostRestarts === undefined || restartsOf(config.host.service) === hostRestarts),
    restartHost() {
      if (!config.host) return;
      spawnSync('systemctl', ['reset-failed', config.host.service], { stdio: 'ignore' });
      run('systemctl', ['restart', config.host.service]);
      hostRestarts = restartsOf(config.host.service);
    },
    stopHost() {
      if (config.host) spawnSync('systemctl', ['stop', config.host.service], { stdio: 'ignore' });
    },
    pruneHost(keep) {
      for (const entry of existsSync(hosts) ? readdirSync(hosts) : [])
        if (
          validVersion(entry) &&
          !keep.includes(entry) &&
          entry !== system.currentHost() &&
          exists(join(hosts, entry, '.built-by-updater'))
        )
          rmSync(join(hosts, entry), { recursive: true, force: true });
    },
    relayKey() {
      if (!config.host) return undefined;
      try {
        return relayKeyIn(readFileSync(config.host.relayEnv, 'utf8'));
      } catch {
        return undefined;
      }
    },
    hostKey() {
      if (!config.host) return undefined;
      try {
        return readFileSync(config.host.key, 'utf8').trim() || undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    writeHostKey(key) {
      if (!config.host) return;
      mkdirSync(dirname(config.host.key), { recursive: true, mode: 0o700 });
      const staging = `${config.host.key}.new`;
      rmSync(staging, { force: true });
      writeFileSync(staging, `${key}\n`, { flag: 'wx', mode: 0o600 });
      chmodSync(staging, 0o600);
      renameSync(staging, config.host.key);
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
