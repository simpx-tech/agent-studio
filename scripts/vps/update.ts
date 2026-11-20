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
// Activation waits for running replies (at most two hours), tries the release's relay on a copy
// of the private data, backs the data up, switches the release and restarts only the relay. A
// failed health check restores the previous release and data, and when that release no longer
// starts either, the new one is started once more. Each step is written to the state before it
// is taken, so an updater that was killed goes on from it at the next check. The installer then
// replaces the public Windows download, keeping the previous package.
// A new server, prepared by setup.sh, starts its relay with the first release it activates.
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
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  statfsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { compareVersions, validVersion, verifySignature } from '../release.ts';
import { scanState } from './state-file.ts';

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

/** The folders that hold a workspace checkpoint: the owner's and each member workspace's. */
function workspaceDirectories(data: string): string[] {
  const directories = [data];
  const workspaces = join(data, 'workspaces');
  if (existsSync(workspaces))
    for (const entry of readdirSync(workspaces, { withFileTypes: true }))
      if (entry.isDirectory() && /^[0-9a-f-]{36}$/.test(entry.name))
        directories.push(join(workspaces, entry.name));
  return directories;
}

/**
 * Replies still marked running in any workspace checkpoint the relay retains. A reply whose
 * computer stopped publishing stays marked for good, and the files do not tell it from one that
 * runs: which computers are connected is known to the running relay alone, and a computer that
 * lost its connection can still be running its reply. So such a reply holds an activation for
 * the two hours a running one may, and no longer.
 */
export function runningReplies(data: string): number {
  const directories = workspaceDirectories(data);
  type Chat = { messages?: { status?: unknown }[] };
  let count = 0;
  const running = (conversation: unknown) => {
    for (const message of (conversation as Chat | null)?.messages ?? [])
      if (message.status === 'running') count++;
  };
  for (const directory of directories) {
    try {
      // A conversation at a time: the file holds every one of them, and outgrows what one text
      // can hold (state-file.ts). A file laid out otherwise keeps its conversations.
      const rest = scanState(join(directory, 'workspace.json'), running) as {
        workspace?: { conversations?: unknown[] };
      } | null;
      for (const conversation of rest?.workspace?.conversations ?? []) running(conversation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
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
  /** The activation under way; absent before it begins and once it ended either way. */
  activation?: Activation;
  activated?: string;
  /** What an activation that did not go straight through had to do, kept for the operator. */
  note?: string;
  /** Publication of the public Windows download. */
  download?: 'published' | 'failed' | 'unavailable';
  downloadAttempts?: number;
  error?: string;
};

/**
 * An activation under way. The step is written before anything it does, and every step can be
 * done again from its start, so an updater that ended in the middle of one (killed, the server
 * restarted) takes it up at the next check instead of reading success off the selected release.
 */
export type Activation = {
  /**
   * `trial`: the release's relay runs on a copy of the data; nothing of production changed.
   * `backup`: the relay is stopped and the data backed up.
   * `candidate`: the release is selected and started, and its relay checked.
   * `previous`: the backup and the release before are put back and started, and checked.
   * `again`: the backup is put back once more and the release started a second time.
   * `abandon`: a new server's first release is taken out and its relay left stopped.
   */
  step: 'trial' | 'backup' | 'candidate' | 'previous' | 'again' | 'abandon';
  began: string;
  /** The release that ran before; a new server has none. */
  previous?: string;
  /** The backup of the data as it was before the switch. */
  backup?: string;
  /** Why there is no backup. */
  backupError?: string;
  /** Names for the folders that keep replaced data, chosen before the data is replaced. */
  keep?: string;
  keepPrevious?: string;
  /** Where what the release wrote, and what the release before then wrote, are kept. */
  kept?: string;
  keptPrevious?: string;
  /** What the release's relay did, and that of the release before. */
  failed?: string;
  back?: string;
  /** How often an updater took this activation up again. */
  resumed?: number;
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
  /** Whether nothing is at the current link's path yet: a new server, set up by setup.sh. */
  newServer(): boolean;
  /** Removes the current link again, after a new server's first release did not start. */
  deselect(): void;
  serviceActive(): boolean;
  /**
   * What systemd says of the relay's service, or of the trial's; undefined when systemd did not
   * answer, which says nothing of the relay.
   */
  unit(trial?: boolean): Unit | undefined;
  /** The last thing the relay, or the trial, logged since `since`: an error when it logged one. */
  lastWords(since: Date, trial?: boolean): string | undefined;
  /**
   * Starts a release's relay on a copy of the private data, where no device and no network
   * reaches it, as the service would run it.
   */
  startTrial(commit: string): void;
  /**
   * Ends a trial, this run's or one an updater that was killed left behind, and removes its copy
   * of the data once its unit ended. Throws, keeping the copy, when the unit does not end.
   */
  endTrial(): void;
  /** Throws when a backup cannot be written or the disk lacks room for one and for a restore. */
  preflight(): void;
  runningReplies(): number;
  stopService(): void;
  startService(): void;
  /** Archives the private data of the stopped relay, uncompressed so the relay starts sooner. */
  backup(commit: string): string;
  /** Compresses a backup once the relay runs again, and returns where it is now. */
  compress(backup: string): string;
  select(release: string): void;
  /**
   * Replaces private data with a backup and returns where the replaced data is kept, a folder
   * named after `keep`. Doing it again with the same name, after being interrupted anywhere,
   * finishes it and never replaces the data twice.
   */
  restore(backup: string, keep: string): string;
  /**
   * HTTP status of the relay's unauthenticated state request, or of the trial's, waiting
   * `probeTimeout` for it.
   */
  probe(trial?: boolean): Promise<number | undefined>;
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
  /** Installs the packages the host needs when missing, the app's own libraries among them. */
  hostPackages(): void;
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
  // A trial whose updater was killed: its unit, and its copy of the private data.
  try {
    system.endTrial();
  } catch (error) {
    system.log(`A trial left behind could not be removed: ${message(error)}`);
  }
  // An activation an earlier updater began comes first, before a newer release can replace it:
  // the relay may be stopped, or running a release nobody checked.
  const begun = state.release;
  if (begun?.activation?.step === 'trial') {
    // Only a copy of the data was touched, and it is gone: the activation begins again.
    delete begun.activation;
    save();
  }
  if (begun?.phase === 'staged' && begun.activation)
    await activate(system, config, state, begun, save);
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
      // The check below starts the app, which a new server cannot load without its libraries.
      system.hostPackages();
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

/** What systemd says of a relay's service and its main process. */
export type Unit = {
  /** systemd's ActiveState: active, activating, failed, inactive… */
  state: string;
  /** How often systemd started it again by itself. */
  restarts: number;
  pid: number;
  /** The CPU time it used so far, in milliseconds, when that is known. */
  cpu?: number;
  /** The bytes its process read, wrote and paged in so far, when that is known. */
  io?: number;
  /** How its last process ended, when it did not end well: `exit-code 1`, `oom-kill`. */
  result?: string;
};

export type Health =
  /** `listened`: how long the relay took to answer, in milliseconds. */
  { ok: true; listened: number } | { ok: false; reason: string };

// The health check waits on what the relay does, never on a clock alone. Until 2026-11-20 it
// gave a relay 30 seconds to listen and one 3-second probe five seconds later. A relay reads its
// whole state before it listens: 13 to 19 seconds for the owner's 537 MB, 46 seconds at a third
// of a core's speed, and more than 30 on 2026-11-13, when the server was slow and v1.3.2 and
// v1.3.3 were both rolled back while they were starting. Once up, its saves and whole reads
// hold its event loop for 4 to 16 seconds, which a 3-second probe reads as a relay that is gone.
// So nothing here ends a relay that works, however long it takes: only evidence does, that its
// process ended or that it neither answers nor does anything.

/**
 * How long a probe waits for its answer: about twice the longest a save was measured to keep a
 * healthy relay from answering.
 */
export const probeTimeout = 30_000;
/** A relay that answers must go on answering: this many answers, this far apart. */
const answersNeeded = 6;
const answerEvery = 5000;
/**
 * A relay that reads or saves its state uses the CPU all the while (a third of a core even when
 * held to that) and reads or writes its files. One that does not answer and in two minutes used
 * less than a second of CPU time and moved less than a megabyte waits for something that will
 * not come. This is the only wait that ends a relay whose process still runs.
 */
const idleLimit = 2 * 60_000;
const worked = 1000;
const moved = 1_000_000;
/** How often the wait for a relay that works on says so in the journal. */
const reportEvery = 60_000;

/** What ended a relay since `started` was read, or undefined while the same process runs. */
function ended(started: Unit, unit: Unit): string | undefined {
  const how = unit.result ? ` (${unit.result})` : '';
  if (unit.state === 'failed') return `ended${how} and its service failed`;
  if (unit.state !== 'active' && unit.state !== 'activating')
    return `ended${how}, its service now ${unit.state}`;
  if (unit.restarts !== started.restarts || unit.pid !== started.pid)
    return `ended${how} and its service started it again`;
  return undefined;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * Whether the relay just started serves requests and goes on serving them: it answers an
 * unauthenticated state request with 401, six times. Answers are waited for as long as the
 * relay's own process runs and works, by what systemd and the kernel report of it, with no limit
 * of time: a relay that ended is known at once from its service, so a crash loop fails within
 * seconds, and one that neither answers nor works for two minutes fails as stuck. When systemd
 * does not answer about the service, that says nothing of the relay: the check goes on asking
 * both and never fails for it. `reason` says what the relay did, after "its relay".
 */
export async function healthy(system: System, trial = false): Promise<Health> {
  const began = system.now();
  const since = (from: Date | number) => system.now().getTime() - new Date(from).getTime();
  const fail = (reason: string): Health => {
    const said = system.lastWords(began, trial);
    return { ok: false, reason: said ? `${reason}; it last logged: ${said}` : reason };
  };
  const name = trial ? 'trial' : 'relay';
  // The service as first seen, which later looks are compared with.
  let started: Unit | undefined;
  let unseen = 0;
  // The last time the process was seen to have worked, and what it had used by then.
  let work = { cpu: undefined as number | undefined, io: undefined as number | undefined };
  let workedAt = began.getTime();
  let reported = began.getTime();
  /** Looks at the service: what ended the relay, if anything did. */
  const look = (): string | undefined => {
    const unit = system.unit(trial);
    if (!unit) {
      if (unseen++ % 60 === 0)
        system.log(`systemd does not say how the ${name} is; still asking it and the ${name}.`);
      // Nothing is known, so nothing shows that it stopped working either.
      workedAt = system.now().getTime();
      return undefined;
    }
    unseen = 0;
    started ??= unit;
    const gone = ended(started, unit);
    if (gone) return gone;
    const unknown = unit.cpu === undefined && unit.io === undefined;
    const rebased =
      (unit.cpu === undefined) !== (work.cpu === undefined) ||
      (unit.io === undefined) !== (work.io === undefined);
    const progressed =
      (unit.cpu !== undefined && work.cpu !== undefined && unit.cpu - work.cpu >= worked) ||
      (unit.io !== undefined && work.io !== undefined && unit.io - work.io >= moved);
    if (unknown || rebased || progressed) {
      work = { cpu: unit.cpu, io: unit.io };
      workedAt = system.now().getTime();
    }
    return undefined;
  };
  const answered = () => {
    workedAt = system.now().getTime();
  };
  look();
  for (;;) {
    if ((await system.probe(trial)) === 401) break;
    const gone = look();
    if (gone) return fail(`${gone} before it listened`);
    if (since(workedAt) >= idleLimit)
      return fail(
        `ran for ${seconds(since(began))} without listening, the last ${seconds(since(workedAt))} without working`,
      );
    if (since(reported) >= reportEvery) {
      reported = system.now().getTime();
      system.log(
        `The ${name} has not listened after ${seconds(since(began))}; its process works on, so it is waited for.`,
      );
    }
    await system.sleep(1000);
  }
  const listened = since(began);
  let answers = 1;
  let last = system.now().getTime();
  answered();
  while (answers < answersNeeded) {
    await system.sleep(answerEvery);
    const status = await system.probe(trial);
    const gone = look();
    if (gone) return fail(`listened after ${seconds(listened)} and then ${gone}`);
    if (status === 401) {
      answers++;
      last = system.now().getTime();
      answered();
    } else if (since(workedAt) >= idleLimit)
      return fail(
        `listened after ${seconds(listened)} and then answered nothing for ${seconds(since(last))}, the last ${seconds(since(workedAt))} without working`,
      );
    else if (since(reported) >= reportEvery) {
      reported = system.now().getTime();
      system.log(
        `The ${name} has not answered for ${seconds(since(last))}; its process works on, so it is waited for.`,
      );
    }
  }
  return { ok: true, listened };
}

const stampOf = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * Activates a staged release, or takes an activation up where an earlier updater left it. Each
 * step is recorded in the state before anything it does and can be done again from its start:
 * a step that starts a relay first stops whatever runs, and the data is replaced under a name
 * chosen and recorded beforehand. A release becomes active only after its relay passed the
 * health check in this process; that the current link selects it shows nothing.
 */
async function activate(
  system: System,
  config: Config,
  state: State,
  release: Tracked,
  save: () => void,
) {
  const tag = release.tag;
  const fail = (error: string): never => {
    release.phase = 'failed';
    release.error = error;
    delete release.activation;
    delete release.waiting;
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
    delete release.activation;
    delete release.waiting;
    delete release.error;
    const entry = { tag, commit: release.commit, activated, ...(backup ? { backup } : {}) };
    state.history.unshift(entry);
    // Follow key rotation the way installed desktop apps do.
    const key = system.releaseKey(release.commit);
    if (key && key !== state.trustedKey) {
      state.trustedKey = key;
      system.log(`Trusting updater key ${publicKeyId(key)} from ${tag} from now on.`);
    }
    const kept = new Set([release.commit, release.previous]);
    const removed = state.history.splice(config.keep);
    save();
    for (const old of removed) if (!kept.has(old.commit)) system.prune(old.commit, old.backup);
    if (!backup) return;
    // The backup was written uncompressed, to keep the relay stopped a second instead of 24.
    try {
      const packed = system.compress(backup);
      entry.backup = packed;
      if (release.backup === backup) release.backup = packed;
      save();
    } catch (error) {
      system.log(`Could not compress ${backup}, which stays as it is: ${message(error)}`);
    }
  };

  let begun = release.activation;
  if (begun) {
    begun.resumed = (begun.resumed ?? 0) + 1;
    save();
    const doing = {
      trial: `trying ${tag}`,
      backup: 'backing up the private data',
      candidate: `starting ${tag}`,
      previous: `going back to ${begun.previous}`,
      again: `starting ${tag} once more`,
      abandon: `taking ${tag} out again`,
    }[begun.step];
    system.log(
      `An updater ended while ${doing}; the activation of ${tag} goes on from there, and nothing is taken for done.`,
    );
  } else {
    const current = system.currentRelease();
    if (current === release.commit) {
      // Selected by hand, or by an updater whose state was lost: that it is selected does not
      // show that it serves, so it is recorded only once its relay passes the health check.
      if (!system.serviceActive())
        return wait(
          'service',
          `${tag} is the current release but ${config.service} is not running; it is recorded once its relay runs.`,
        );
      const health = await healthy(system);
      if (!health.ok)
        return fail(
          `${tag} is the current release, selected outside this updater, but its relay ${health.reason}. Nothing was changed.`,
        );
      complete();
      system.log(`${tag} is already the current release, and its relay answers.`);
      return;
    }
    // A new server has no release yet, so no relay runs and no reply can: its first one starts it.
    const first = !current && system.newServer();
    if (!current && !first) return fail(`${config.root}/current does not select a release.`);
    if (current) {
      if (!system.serviceActive())
        return wait('service', `${config.service} is not running; ${tag} waits for it.`);
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
          `Waiting up to two hours before activating ${tag}: ${replies} running.`,
        );
      if (running) system.log(`Activating ${tag} although ${replies} still marked running.`);
    } else {
      try {
        system.preflight();
      } catch (error) {
        return fail(`${tag} was not activated: ${message(error)}`);
      }
    }
    begun = release.activation = {
      step: current ? 'trial' : 'backup',
      began: system.now().toISOString(),
      ...(current ? { previous: current } : {}),
    };
    delete release.waiting;
    save();
  }
  const activation = begun;
  const previous = activation.previous;
  const enter = (step: Activation['step']) => {
    activation.step = step;
    save();
  };
  const keepAs = (commit: string) => `${commit.slice(0, 12)}-${stampOf(system.now())}`;
  // Stops whatever relay runs, puts the data in place, selects a release, starts its relay and
  // waits for it. A part that fails is the relay's reason too, and all of it can be done again.
  const start = async (commit: string, data?: () => void): Promise<Health> => {
    try {
      system.stopService();
      data?.();
      system.select(commit);
      system.startService();
      return await healthy(system);
    } catch (error) {
      return { ok: false, reason: `could not be started: ${message(error)}` };
    }
  };

  for (;;) {
    if (activation.step === 'trial') {
      // The switch stops the relay every device uses, and going back is not always possible: on
      // 2026-11-20 the release in production could no longer read its own data, which had
      // outgrown it while it ran. So the new relay first shows, on a copy, that it reads this
      // data and serves; one that does not is refused while the old one runs on, untouched.
      system.log(`Trying ${tag} on a copy of the private data.`);
      let trial: Health;
      try {
        system.startTrial(release.commit);
        trial = await healthy(system, true);
      } catch (error) {
        trial = { ok: false, reason: `could not be tried: ${message(error)}` };
      }
      try {
        system.endTrial();
      } catch (error) {
        // Not the release's doing, so it is not failed: the next check clears up and tries again.
        throw new Error(
          `${tag} is not activated while its trial cannot be removed: ${message(error)} ${previous} runs on and nothing changed.`,
        );
      }
      if (!trial.ok)
        return fail(
          `${tag} was not activated: on a copy of the private data its relay ${trial.reason}. ${previous} runs on and nothing changed.`,
        );
      system.log(`${tag} read the copy and listened after ${seconds(trial.listened)}.`);
      try {
        // Before the relay is stopped: what would keep its data from being backed up or restored.
        system.preflight();
      } catch (error) {
        return fail(
          `${tag} was not activated: ${message(error)} ${previous} runs on and nothing changed.`,
        );
      }
      enter('backup');
    } else if (activation.step === 'backup') {
      try {
        system.stopService();
        activation.backup = system.backup(release.commit);
      } catch (error) {
        activation.backupError = message(error);
        if (!previous)
          return fail(
            `Could not back up private data before activating ${tag}, so the relay stays stopped: ${activation.backupError}`,
          );
        // The relay may be stopped already, so this goes the way a failed health check does:
        // the release that ran is started again on its data, which nothing touched.
        system.log(
          `Could not back up private data before activating ${tag}: ${activation.backupError}. Starting ${previous} again.`,
        );
        enter('previous');
        continue;
      }
      if (previous) release.previous = previous;
      release.backup = activation.backup;
      enter('candidate');
    } else if (activation.step === 'candidate') {
      const health = await start(release.commit);
      if (health.ok) {
        complete(activation.backup);
        system.log(
          previous
            ? `Activated ${tag}; ${previous} and the private data backup are retained.`
            : `Activated ${tag}, this server's first release.`,
        );
        return;
      }
      activation.failed = health.reason;
      if (activation.backup) activation.keep = keepAs(release.commit);
      system.log(
        previous
          ? `${tag} failed its health check: its relay ${health.reason}. Restoring ${previous} and its data.`
          : `${tag} failed its health check: its relay ${health.reason}.`,
      );
      enter(previous ? 'previous' : 'abandon');
    } else if (activation.step === 'abandon') {
      // Without a release to go back to, the relay stays stopped, as it was before.
      try {
        system.deselect();
        system.stopService();
        if (activation.backup && activation.keep)
          activation.kept = system.restore(activation.backup, activation.keep);
      } catch (error) {
        system.log(`Stopping ${tag} failed: ${message(error)}`);
      }
      return fail(
        `${tag} failed its health check, so the relay stays stopped.${activation.kept ? ` Data it wrote is kept in ${activation.kept}.` : ''} Its relay ${activation.failed}.`,
      );
    } else if (activation.step === 'previous') {
      const back = await start(previous!, () => {
        if (activation.backup && activation.keep)
          activation.kept = system.restore(activation.backup, activation.keep);
      });
      const wrote = activation.kept
        ? ` Data the failed release wrote is kept in ${activation.kept}.`
        : '';
      if (back.ok)
        return fail(
          activation.backupError
            ? `${tag} was not activated: private data could not be backed up (${activation.backupError}). ${previous} runs again on its data, which was not touched.`
            : `${tag} failed its health check; ${previous} was restored.${wrote} Its relay ${activation.failed}.`,
        );
      // The release that ran no longer starts, as one whose data outgrew it while it ran does
      // not. The new one read this data in its trial, so rather than leave the relay down it is
      // started, on the data as it was before the switch: the release that just ended may have
      // written to it, so what it left is kept aside and the backup put back once more.
      activation.back = back.reason;
      if (activation.backup) activation.keepPrevious = keepAs(previous!);
      system.log(
        activation.backupError
          ? `${previous} did not come back: its relay ${back.reason}. Starting ${tag}, which read a copy of this data, on the data as it is, without a backup.`
          : `${previous} did not come back: its relay ${back.reason}. Starting ${tag} once more, on the data as it was before the switch.`,
      );
      enter('again');
    } else {
      const again = await start(release.commit, () => {
        if (activation.backup && activation.keepPrevious)
          activation.keptPrevious = system.restore(activation.backup, activation.keepPrevious);
      });
      const wrote =
        (activation.kept ? ` Data the failed release wrote is kept in ${activation.kept}.` : '') +
        (activation.keptPrevious
          ? ` What ${previous} left when it did not start is kept in ${activation.keptPrevious}.`
          : '');
      const told = activation.backupError
        ? `Private data could not be backed up before activating ${tag} (${activation.backupError}) and ${previous} did not start again (its relay ${activation.back})`
        : `${tag} failed its first health check (its relay ${activation.failed}) and ${previous} did not start again (its relay ${activation.back})`;
      if (again.ok) {
        release.note = activation.backupError
          ? `${told}, so ${tag}, which read a copy of this data in its trial, was started on it and serves, without a backup. ${previous} can no longer be gone back to.`
          : `${told}, so ${tag} was started once more, on the data as it was before the switch, and serves. ${previous} can no longer be gone back to.${wrote}`;
        complete(activation.backup);
        system.log(release.note);
        return;
      }
      return fail(
        activation.backupError
          ? `${told}, and ${tag} did not start on that data either: the relay is down. Intervene manually; ${tag} stays selected and there is no backup, the data being as ${previous} left it. ${tag}: its relay ${again.reason}.`
          : `${tag} failed its health check, restoring ${previous} did not bring the relay back, and ${tag} did not start a second time: the relay is down. Intervene manually; ${tag} stays selected and the data backup is ${activation.backup}.${wrote} ${tag}: its relay ${activation.failed}. ${previous}: its relay ${activation.back}. ${tag} again: its relay ${again.reason}.`,
      );
    }
  }
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
    for (const field of ['retryAt', 'waiting', 'error', 'note', 'activation'] as const)
      delete release[field];
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

const stamp = () => stampOf(new Date());

/**
 * How long systemd, or the journal, is given to answer a question. They answer in milliseconds,
 * so one that has not by then is not going to, and the updater must not hang on it.
 */
const answerWithin = 60_000;
/**
 * How long a command that stops or starts a unit is given. systemd itself ends a stop that
 * takes longer than the unit's TimeoutStopSec (90 seconds unless set), so a systemctl still
 * waiting after ten minutes waits on a service manager that no longer answers.
 */
const actWithin = 10 * 60_000;

/** The D-Bus object path of a systemd unit. */
export function busPath(unit: string): string {
  const label = [...Buffer.from(unit)]
    .map((byte, index) => {
      const character = String.fromCharCode(byte);
      return /[A-Za-z]/.test(character) || (index > 0 && /[0-9]/.test(character))
        ? character
        : `_${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
  return `/org/freedesktop/systemd1/unit/${label || '_'}`;
}

/** How a service runs its program, as far as a trial repeats it. */
export type Service = {
  user: string;
  group: string;
  /** Its Environment= entries, each one NAME=value whatever the value holds. */
  environment: string[];
  /** Its EnvironmentFile= entries in their order; systemd reads them, not this updater. */
  files: { path: string; optional: boolean }[];
};

/**
 * Reads a service from systemd's own properties as busctl prints them in JSON, where every
 * entry is a value of its own: no quoting to undo, and no splitting at spaces.
 */
export function parseService(properties: Record<string, unknown>): Service {
  const data = (name: string) => (properties[name] as { data?: unknown } | undefined)?.data;
  const text = (name: string) => {
    const value = data(name);
    if (typeof value !== 'string') throw new Error(`systemd reported no ${name} for the relay.`);
    return value;
  };
  const environment = data('Environment');
  const files = data('EnvironmentFiles');
  if (
    !Array.isArray(environment) ||
    environment.some(
      (entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry),
    ) ||
    !Array.isArray(files) ||
    files.some(
      (entry) =>
        !Array.isArray(entry) ||
        typeof entry[0] !== 'string' ||
        !isAbsolute(entry[0]) ||
        typeof entry[1] !== 'boolean',
    )
  )
    throw new Error('systemd reported an environment for the relay that cannot be read.');
  return {
    user: text('User'),
    group: text('Group'),
    environment: environment as string[],
    files: (files as [string, boolean][]).map(([path, optional]) => ({ path, optional })),
  };
}

/**
 * The systemd-run arguments that start the trial of a release: its relay as the service runs
 * it, with the service's user, Environment= entries and environment files, but for where it
 * listens and what it reads. systemd lets an environment file override Environment=, which
 * --setenv is, so a file that sets the data folder or the port (the production one may) would
 * send the trial to the real data. The trial's own settings are therefore set by env(1) in the
 * command itself, after systemd put the environment together, where nothing overrides them.
 */
export function trialArguments(trial: {
  unit: string;
  /** The updater's own unit, which the trial ends with. */
  updater?: string;
  service: Service;
  release: string;
  data: string;
  port: number;
  node: string;
  /** Folders the trial cannot see. */
  hidden: string[];
}): string[] {
  // systemd expands $NAME in a command's arguments; two dollar signs are one.
  const literal = (value: string) => value.split('$').join('$$');
  const own = [
    'AGENT_STUDIO_RELAY_HOST=127.0.0.1',
    `AGENT_STUDIO_RELAY_PORT=${trial.port}`,
    `AGENT_STUDIO_RELAY_DATA=${trial.data}`,
    `AGENT_STUDIO_WEB_DIR=${trial.release}/build`,
  ];
  return [
    '--quiet',
    `--unit=${trial.unit}`,
    '--service-type=exec',
    ...(trial.service.user ? [`--uid=${trial.service.user}`] : []),
    ...(trial.service.group ? [`--gid=${trial.service.group}`] : []),
    `--working-directory=${trial.release}`,
    ...trial.service.environment.map((entry) => `--setenv=${entry}`),
    ...[
      ...trial.service.files.map(
        (file) => `EnvironmentFile=${file.optional ? '-' : ''}${file.path}`,
      ),
      // A trial does not outlive the updater that waits for it: when that one is killed, systemd
      // stops this unit, and the next check removes its copy of the data.
      ...(trial.updater ? [`BindsTo=${trial.updater}`] : []),
      // It has no network but a loopback of its own (a relay delivers the phone alerts its data
      // holds queued, and no device may reach this one), and cannot see the data itself.
      'PrivateNetwork=yes',
      'ProtectSystem=strict',
      `ReadWritePaths=${trial.data}`,
      `InaccessiblePaths=${trial.hidden.map((path) => `-${path}`).join(' ')}`,
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'NoNewPrivileges=yes',
      'UMask=0077',
      'TasksMax=infinity',
    ].map((property) => `--property=${property}`),
    '--',
    '/usr/bin/env',
    ...own.map(literal),
    literal(trial.node),
    'relay/start.ts',
  ];
}

/**
 * Replaces the folder `data` with the one of its name that `extract` puts into `staging`,
 * keeping the replaced folder as `kept`. It can be run again after ending anywhere: `kept`
 * exists only once the extraction finished, so an unfinished extraction is done again, a
 * finished one is not, and the data is never replaced twice.
 */
export function replaceData(data: string, staging: string, kept: string, extract: () => void) {
  if (!existsSync(kept)) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    extract();
    renameSync(data, kept);
  }
  if (!existsSync(data)) renameSync(join(staging, basename(data)), data);
  rmSync(staging, { recursive: true, force: true });
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
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
    throw new Error(`${command} ${args[0]} did not finish in ${Number(options.timeout) / 1000} s.`);
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
  // What systemd reports of a unit, by property, or undefined when it did not answer in time.
  const show = (unit: string, properties: string[]) => {
    const result = spawnSync(
      'systemctl',
      ['show', unit, ...properties.map((property) => `--property=${property}`)],
      { encoding: 'utf8', timeout: answerWithin },
    );
    if (result.error || result.status !== 0) return undefined;
    const values: Record<string, string> = {};
    for (const line of (result.stdout ?? '').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
    }
    return values;
  };
  // A property of a service as systemd holds it, each entry a value of its own.
  const property = (unit: string, name: string): unknown => {
    const result = spawnSync(
      'busctl',
      [
        '--json=short',
        'get-property',
        'org.freedesktop.systemd1',
        busPath(`${unit}.service`),
        'org.freedesktop.systemd1.Service',
        name,
      ],
      { encoding: 'utf8', timeout: answerWithin },
    );
    if (result.error || result.status !== 0)
      throw new Error(`systemd did not report ${name} of ${unit}.`);
    return JSON.parse(result.stdout);
  };
  // The systemd service this updater runs as, when it runs as one.
  const ownUnit = () => {
    try {
      const group = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').at(-1) ?? '';
      const unit = basename(group.slice(group.lastIndexOf(':') + 1));
      return /^[A-Za-z0-9_@.:-]+[.]service$/.test(unit) ? unit : undefined;
    } catch {
      return undefined;
    }
  };
  // The size of a folder's files.
  const treeBytes = (folder: string, skip: string[] = []): number => {
    let bytes = 0;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const path = join(folder, entry.name);
      try {
        bytes += entry.isDirectory() ? treeBytes(path) : lstatSync(path).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return bytes;
  };
  // The trial of a release: its relay as a unit of its own, on a copy of the data beside it.
  const trialUnit = `${config.service}-trial`;
  const trialData = join(dirname(config.data), `.${basename(config.data)}-trial`);
  // Copies a folder with its owners and modes while the relay may be writing in it: the relay
  // replaces its files by renaming, so a file is whole or, when it left meanwhile, skipped.
  const copyTree = (from: string, to: string, skip: string[] = []) => {
    const folder = lstatSync(from);
    mkdirSync(to, { mode: 0o700 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      try {
        if (entry.isDirectory()) copyTree(source, target);
        else if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
        else if (entry.isFile()) {
          const file = lstatSync(source);
          copyFileSync(source, target, constants.COPYFILE_FICLONE);
          chownSync(target, file.uid, file.gid);
          chmodSync(target, file.mode & 0o7777);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    chownSync(to, folder.uid, folder.gid);
    chmodSync(to, folder.mode & 0o7777);
  };
  // How often the host's service restarted the host on its own, as of the updater's restart.
  let hostRestarts: string | undefined;
  const restartsOf = (service: string) =>
    (
      spawnSync('systemctl', ['show', '--property=NRestarts', '--value', service], {
        encoding: 'utf8',
        timeout: answerWithin,
      }).stdout ?? ''
    ).trim();
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
        [
          join(releases, commit, 'scripts', 'vps', 'state-file.ts'),
          join(installed, 'state-file.ts'),
        ],
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
    newServer: () => !exists(current),
    deselect() {
      if (exists(current) && lstatSync(current).isSymbolicLink()) rmSync(current);
    },
    serviceActive: () =>
      spawnSync('systemctl', ['is-active', '--quiet', config.service], { timeout: answerWithin })
        .status === 0,
    unit(trial) {
      const values = show(trial ? trialUnit : config.service, [
        'ActiveState',
        'NRestarts',
        'MainPID',
        'CPUUsageNSec',
        'Result',
        'ExecMainStatus',
      ]);
      if (!values?.ActiveState) return undefined;
      const pid = Number(values.MainPID) || 0;
      // Without CPU accounting systemd reports no number, or the largest there is.
      let cpu = /^\d{1,18}$/.test(values.CPUUsageNSec ?? '')
        ? Number(values.CPUUsageNSec) / 1e6
        : undefined;
      if (cpu === undefined && pid) {
        try {
          // The process's own user and system time, in the kernel's hundredths of a second.
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          cpu = (Number(fields[11]) + Number(fields[12])) * 10;
          if (!Number.isFinite(cpu)) cpu = undefined;
        } catch {
          // It ended meanwhile.
        }
      }
      // What the process read and wrote through the kernel, and the pages it had read back in:
      // a relay held up by a slow disk or by swapping uses little CPU time and still gets on.
      let io: number | undefined;
      if (pid) {
        try {
          const counts = readFileSync(`/proc/${pid}/io`, 'utf8');
          const count = (name: string) =>
            Number(
              counts
                .split('\n')
                .find((line) => line.startsWith(`${name}: `))
                ?.slice(name.length + 2),
            );
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          const faults = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[9]);
          io = count('rchar') + count('wchar') + faults * 4096;
          if (!Number.isFinite(io)) io = undefined;
        } catch {
          // It ended meanwhile.
        }
      }
      const status = Number(values.ExecMainStatus) || 0;
      const result = values.Result && values.Result !== 'success' ? values.Result : '';
      return {
        state: values.ActiveState || 'unknown',
        restarts: Number(values.NRestarts) || 0,
        pid,
        ...(cpu === undefined ? {} : { cpu }),
        ...(io === undefined ? {} : { io }),
        ...(result ? { result: `${result}${status ? ` ${status}` : ''}` } : {}),
      };
    },
    lastWords(since, trial) {
      const result = spawnSync(
        'journalctl',
        [
          `--unit=${trial ? trialUnit : config.service}`,
          `--since=@${Math.floor(since.getTime() / 1000)}`,
          '--lines=80',
          '--output=cat',
          '--no-pager',
          '--quiet',
        ],
        { encoding: 'utf8', timeout: answerWithin },
      );
      const lines = (result.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return (lines.findLast((line) => /error/i.test(line)) ?? lines.at(-1))?.slice(0, 300);
    },
    startTrial(commit) {
      const release = join(releases, commit);
      if (!/^[\w.-]+$/.test(commit) || !lstatSync(release).isDirectory())
        throw new Error(`${commit} is not a release directory.`);
      system.endTrial();
      // The npm cache earlier manual builds left there is not private data.
      copyTree(config.data, trialData, ['.npm']);
      const service = parseService(
        Object.fromEntries(
          ['User', 'Group', 'Environment', 'EnvironmentFiles'].map((name) => [
            name,
            property(config.service, name),
          ]),
        ),
      );
      run(
        'systemd-run',
        trialArguments({
          unit: trialUnit,
          updater: ownUnit(),
          service,
          release,
          data: trialData,
          port: config.port,
          node: process.execPath,
          hidden: [config.data, config.backups, config.stateDirectory],
        }),
        { timeout: actWithin },
      );
    },
    endTrial() {
      const unit = () => show(trialUnit, ['LoadState', 'ActiveState']);
      let found = unit();
      if (!found) throw new Error(`systemd does not say whether ${trialUnit} runs.`);
      if (found.LoadState !== 'not-found') {
        const quiet = { stdio: 'ignore', timeout: actWithin } as const;
        spawnSync('systemctl', ['stop', trialUnit], quiet);
        spawnSync('systemctl', ['reset-failed', trialUnit], quiet);
        found = unit();
        // The copy holds private data a relay may still be reading: it goes only once that
        // relay is known to have ended.
        if (!found || !['inactive', 'failed'].includes(found.ActiveState ?? ''))
          throw new Error(
            `${trialUnit} did not stop (systemd says ${found?.ActiveState ?? 'nothing'}), so its copy of the data stays in ${trialData}.`,
          );
      }
      rmSync(trialData, { recursive: true, force: true });
    },
    runningReplies: () => runningReplies(config.data),
    stopService() {
      run('systemctl', ['stop', config.service], { timeout: actWithin });
      // A release that crashed in a restart loop may have hit the start rate limit.
      spawnSync('systemctl', ['reset-failed', config.service], {
        stdio: 'ignore',
        timeout: answerWithin,
      });
    },
    startService: () => run('systemctl', ['start', config.service], { timeout: actWithin }),
    preflight() {
      try {
        mkdirSync(config.backups, { recursive: true, mode: 0o700 });
        const test = join(config.backups, `.writable-${process.pid}`);
        writeFileSync(test, '', { mode: 0o600 });
        rmSync(test);
      } catch (error) {
        throw new Error(`a backup cannot be written to ${config.backups} (${message(error)}).`);
      }
      // The backup is the data once over, and so is the folder a restore unpacks beside it.
      const megabytes = (bytes: number) => `${Math.ceil(bytes / 1_000_000)} MB`;
      const bytes = treeBytes(config.data, ['.npm']);
      for (const [folder, what] of [
        [config.backups, 'a backup of'],
        [dirname(config.data), 'restoring'],
      ]) {
        const disk = statfsSync(folder);
        const free = disk.bavail * disk.bsize;
        if (free < bytes)
          throw new Error(
            `${folder} has ${megabytes(free)} free, less than ${what} the ${megabytes(bytes)} of private data takes.`,
          );
      }
    },
    backup(commit) {
      mkdirSync(config.backups, { recursive: true, mode: 0o700 });
      // Uncompressed: compressing the owner's 785 MB took 24 seconds of a stopped relay, and
      // writing them as they are takes one. The archive is compressed once the relay runs.
      let path = join(config.backups, `pre-${commit}.tar`);
      if (exists(path) || exists(`${path}.gz`))
        path = join(config.backups, `pre-${commit}-${stamp()}.tar`);
      const name = basename(config.data);
      // Earlier manual builds left an npm cache in the service home; it is not private data.
      const args = ['-cf', `${path}.partial`, `--exclude=${name}/.npm`];
      rmSync(`${path}.partial`, { force: true });
      run('tar', [...args, '-C', dirname(config.data), name]);
      chmodSync(`${path}.partial`, 0o600);
      renameSync(`${path}.partial`, path);
      return path;
    },
    compress(backup) {
      if (!backup.endsWith('.tar')) return backup;
      const packed = `${backup}.gz`;
      const partial = `${packed}.partial`;
      rmSync(partial, { force: true });
      const output = openSync(partial, 'wx', 0o600);
      try {
        run('gzip', ['-c', backup], { stdio: ['ignore', output, 'inherit'] });
      } catch (error) {
        rmSync(partial, { force: true });
        throw error;
      } finally {
        closeSync(output);
      }
      renameSync(partial, packed);
      rmSync(backup);
      return packed;
    },
    select(release) {
      if (!/^[\w.-]+$/.test(release) || !lstatSync(join(releases, release)).isDirectory())
        throw new Error(`${release} is not a release directory.`);
      const next = join(config.root, `.next-${release}`);
      rmSync(next, { force: true });
      symlinkSync(join(releases, release), next);
      renameSync(next, current);
    },
    restore(backup, keep) {
      if (!/^[A-Za-z0-9_.-]+$/.test(keep)) throw new Error(`${keep} cannot name a folder.`);
      const parent = dirname(config.data);
      const name = basename(config.data);
      const staging = join(parent, `.${name}-restore-${keep}`);
      const kept = join(parent, `.${name}-failed-${keep}`);
      // As root, tar restores the original owners and modes; it reads either kind of archive.
      replaceData(config.data, staging, kept, () => run('tar', ['-xf', backup, '-C', staging]));
      return kept;
    },
    async probe(trial) {
      const url = `http://127.0.0.1:${config.port}/v1/state`;
      if (trial) {
        // The trial listens on a loopback of its own, which is reached from its process.
        const pid = system.unit(true)?.pid;
        if (!pid) return undefined;
        const ask = `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(${probeTimeout}) }).then((response) => { console.log(response.status); process.exit(0); }, () => process.exit(0));`;
        const result = spawnSync(
          'nsenter',
          [`--net=/proc/${pid}/ns/net`, '--', process.execPath, '--eval', ask],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: probeTimeout + 10_000 },
        );
        const status = Number((result.stdout ?? '').trim());
        return Number.isInteger(status) && status > 0 ? status : undefined;
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(probeTimeout) });
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
    hostPackages() {
      const lib = '/usr/lib/x86_64-linux-gnu';
      // A virtual display, a session bus of its own, sudo, and curl for the CLIs' installers.
      // The AppImage leaves some libraries to the system, as every desktop has them, and WebKit
      // loads GLES as it starts; a new server has none of them (found on a fresh Debian 13).
      const needs = [
        ['/usr/bin/Xvfb', 'xvfb'],
        ['/usr/bin/xvfb-run', 'xvfb'],
        ['/usr/bin/xauth', 'xauth'],
        ['/usr/bin/dbus-run-session', 'dbus-daemon'],
        ['/usr/bin/sudo', 'sudo'],
        ['/usr/bin/curl', 'curl'],
        [`${lib}/libasound.so.2`, 'libasound2'],
        [`${lib}/libfontconfig.so.1`, 'libfontconfig1'],
        [`${lib}/libharfbuzz.so.0`, 'libharfbuzz0b'],
        [`${lib}/libfribidi.so.0`, 'libfribidi0'],
        [`${lib}/libgpg-error.so.0`, 'libgpg-error0'],
        [`${lib}/libwayland-client.so.0`, 'libwayland-client0'],
        [`${lib}/libEGL.so.1`, 'libegl1'],
        [`${lib}/libGLESv2.so.2`, 'libgles2'],
      ];
      const missing = [...new Set(needs.filter(([file]) => !exists(file)).map(([, p]) => p))];
      if (missing.length) {
        system.log(`Installing ${missing.join(', ')} for the host.`);
        transient(['/usr/bin/apt-get', 'update', '-q']);
        transient([
          '/usr/bin/apt-get',
          'install',
          '-y',
          '-q',
          '--no-install-recommends',
          ...missing,
        ]);
      }
    },
    async provisionHost() {
      const host = config.host;
      if (!host) return;
      system.hostPackages();
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
