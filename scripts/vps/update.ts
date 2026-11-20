// Automatic production updates for the Agent Studio relay and web viewer. See docs/DEPLOYMENT.md.
//
// agent-studio-update.timer runs this as root on the VPS every five minutes:
//
//   node update.ts [check]                            Install the latest GitHub release once.
//   node update.ts retry                              Try a failed release again.
//   node update.ts trust <tauri.conf.json> [--replace] Store the trusted updater key.
//
// Each of them holds the deployment lock (<root>/.deploy.lock) while it runs: a check skips its
// run while something else holds it, and retry and trust wait for it.
//
// A release is installed only when its Windows installer carries a valid updater signature for
// its own version from the trusted key, so only the signing release pipeline can deploy. The
// source is built and tested by an unprivileged, sandboxed user without access to private data.
// Activation waits for running replies (at most two hours), tries the release's relay on a copy
// of the private data, backs the data up, switches the release and restarts only the relay. A
// failed health check restores the previous release and data, and when that release no longer
// starts either, the new one is started once more. Each step is written to the state before it
// is taken, so an updater that was killed goes on from it at the next check. The state, a backup
// and each replacement of the data are flushed to the disk in the order a recovery needs, and a
// backup is restored only when it is the archive that was made. The installer then replaces the
// public Windows download, keeping the previous package.
// A new server, prepared by setup.sh, starts its relay with the first release it activates.
//
// The server also runs the desktop app as a host for its workspace (requested 2026-10-10), so
// the other devices can start chats on it: the release's Linux AppImage, authenticated like the
// installer and extracted by the build user, runs as agent-studio-host.service in server mode
// under a virtual display. The updater provisions what it needs once (Xvfb, its user, optional
// passwordless sudo, Claude Code and Codex, the pairing key, the unit) and switches it to each
// release the relay runs, after running replies end, going back to the previous one when it
// does not stay up.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  statfsSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
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
  /** How long an updater may neither run its own code nor have its commands work. */
  hungAfter: number;
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
    hungAfter: Number(value('HUNG_AFTER', '900')) * 1000,
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
    !(config.hungAfter >= 1000) ||
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
  /** When the step was written, before anything of it was done. */
  entered?: string;
  /** The release that ran before; a new server has none. */
  previous?: string;
  /** The backup of the data as it was before the switch. */
  backup?: string;
  /** Why there is no backup. */
  backupError?: string;
  /**
   * Why the backup was not put back: it is missing or is not the archive that was made. The data
   * was then left as it was, and nothing was moved aside for it.
   */
  restoreError?: string;
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
  /**
   * The switch under way, written before anything of it is done: `switch` selects the version
   * and restarts the host, `back` does so for the version before.
   */
  activation?: { step: 'switch' | 'back'; entered: string; resumed?: number };
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
  /**
   * Releases this updater activated, newest first. `packing` counts the attempts to compress a
   * backup that is still the archive as it was written.
   */
  history: { tag: string; commit: string; activated: string; backup?: string; packing?: number }[];
  /** Archives whose compressed copy took their place, still to be removed. */
  cleanup?: string[];
};

/**
 * Where a state came from: the journal, the generation before it (the journal was missing or
 * could not be read), or nowhere although something was there (`lost`).
 */
export type Recovered = { from: 'previous' | 'lost'; problem: string };

export const emptyState = (): State => ({ version: 1, history: [] });

/** Side effects, replaceable in tests. */
export type System = {
  now(): Date;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  readState(): State;
  /** Says when the state just read is not the journal as it was last written. */
  recovered(): Recovered | undefined;
  /** Writes the state so that it survives a power loss, keeping the generation before it. */
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
  /**
   * Throws when a backup cannot be written or the disks lack room for it and for the two
   * restores an activation can need, counted together where they share a disk.
   */
  preflight(): void;
  runningReplies(): number;
  stopService(): void;
  startService(): void;
  /**
   * Archives the private data of the stopped relay, uncompressed so the relay starts sooner,
   * with a manifest of what it holds, both on the disk before it returns. `began` names the
   * activation: the backup an updater made for it and could not record is returned instead of
   * another one, while the data is still as that backup holds it, or whatever the data holds
   * when `behind` says the release may have run on it since.
   */
  backup(commit: string, began?: string, behind?: boolean): string;
  /**
   * Compresses a backup once the relay runs again, checks that the copy unpacks to the archive
   * that was made, and returns where the copy is. The archive stays until `removeBackup`.
   */
  compress(backup: string): string;
  /** Removes an archive whose compressed copy the state names. */
  removeBackup(backup: string): void;
  select(release: string): void;
  /**
   * Replaces private data with a backup and returns where the replaced data is kept, a folder
   * named after `keep`. Doing it again with the same name, after being interrupted anywhere,
   * finishes it and never replaces the data twice. Throws a BackupError, with the data untouched
   * and nothing moved aside, when the backup is missing, is not the archive that was made or
   * does not unpack to what was backed up.
   */
  restore(backup: string, keep: string): string;
  /** Whether the restore named `keep` replaced the data, all of it. */
  restored(keep: string): boolean;
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
  hostPackages(): Promise<void>;
  /** Installs what the host needs: packages, its user, sudo, Claude Code and Codex, its unit. */
  provisionHost(): Promise<void>;
  selectHost(version: string): void;
  hostActive(): boolean;
  /**
   * Whether the host's service runs this version, with the process this updater first saw
   * running it: its link selects the version and its processes run that version's files or
   * began after the link selected it.
   */
  hostRuns(version: string): boolean;
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
  // A trial whose updater was killed: its unit, and its copy of the private data. Nothing goes
  // on while one cannot be removed: a relay may still read the copy, and no release is tried or
  // activated beside it.
  try {
    system.endTrial();
  } catch (error) {
    throw new Error(
      `Nothing is activated while a trial left behind cannot be removed: ${message(error)}`,
    );
  }
  const recovered = system.recovered();
  if (recovered) await recover(system, config, state, recovered, save);
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
  tidy(system, state, save);
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
 * Goes on from a state that is not the journal as it was last written. The generation before it
 * is at most one step behind, and every step can be done again from its start, so an activation
 * it names is taken up as after any kill. Without one, and with no state at all, nothing says
 * whether an updater stopped the relay: what is selected is started and checked.
 */
async function recover(
  system: System,
  config: Config,
  state: State,
  recovered: Recovered,
  save: () => void,
) {
  system.log(
    recovered.from === 'previous'
      ? `The updater's state could not be used (${recovered.problem}); the one written before it is, which may be a step behind. Every step is done again from its start.`
      : `The updater's state is lost (${recovered.problem}): nothing is known of earlier checks.`,
  );
  const step = state.release?.activation?.step;
  let relay = '';
  if (!step || step === 'trial') {
    const current = system.currentRelease();
    if (current && !system.serviceActive()) {
      system.log(`${config.service} is not running; starting ${current}, which is selected.`);
      let health: Health;
      try {
        system.startService();
        health = await healthy(system);
      } catch (error) {
        health = { ok: false, reason: `could not be started: ${message(error)}` };
      }
      // Nothing is written, so the next check finds the same and says so again.
      if (!health.ok)
        throw new Error(
          `The updater's state was not usable and ${config.service} does not run: the relay of ${current}, which is selected, ${health.reason}. Intervene manually.`,
        );
      relay = ` ${current}, which is selected, was started and its relay answers.`;
      system.log(relay.trim());
    }
  }
  save();
  if (recovered.from === 'lost')
    throw new Error(
      `The updater's state was lost (${recovered.problem}).${relay} No updater key is trusted any more, so no release is installed: run scripts/vps/install.sh again.`,
    );
}

/**
 * Finishes what an activation leaves for when the relay runs again: an archive whose compressed
 * copy took its place is removed, and a backup still as it was written is compressed. Each can
 * be done again, and the state names a file only while the file is there.
 */
function tidy(system: System, state: State, save: () => void) {
  const remove = () => {
    for (const archive of [...(state.cleanup ?? [])]) {
      try {
        system.removeBackup(archive);
      } catch (error) {
        system.log(`Could not remove ${archive}: ${message(error)}`);
        continue;
      }
      state.cleanup = state.cleanup?.filter((path) => path !== archive);
    }
    if (state.cleanup && !state.cleanup.length) delete state.cleanup;
  };
  if (state.cleanup?.length) {
    remove();
    save();
  }
  for (const entry of state.history) {
    const archive = entry.backup;
    if (!archive?.endsWith('.tar') || (entry.packing ?? 0) >= maxAttempts) continue;
    entry.packing = (entry.packing ?? 0) + 1;
    save();
    let packed: string;
    try {
      packed = system.compress(archive);
    } catch (error) {
      system.log(`Could not compress ${archive}, which stays as it is: ${message(error)}`);
      continue;
    }
    // The state names the copy, on the disk, before the archive goes.
    entry.backup = packed;
    delete entry.packing;
    if (state.release?.backup === archive) state.release.backup = packed;
    if (packed !== archive) state.cleanup = [...(state.cleanup ?? []), archive];
    save();
    remove();
    save();
  }
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
      await system.hostPackages();
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

/**
 * The host runs the version, and stays up with the same process through its start and a while
 * after it. That its app reached the relay is not checked: see docs/DEPLOYMENT.md.
 */
async function hostUp(system: System, version: string): Promise<boolean> {
  await system.sleep(10_000);
  if (!system.hostRuns(version)) return false;
  await system.sleep(10_000);
  return system.hostRuns(version);
}

async function activateHost(
  system: System,
  config: Config,
  tracked: HostRelease,
  save: () => void,
) {
  const done = () => {
    tracked.phase = 'active';
    tracked.activated = system.now().toISOString();
    delete tracked.activation;
    delete tracked.error;
    save();
    system.pruneHost([tracked.version, ...(tracked.previous ? [tracked.previous] : [])]);
    system.log(`The host runs ${tracked.tag}.`);
  };
  // The switch is written before anything of it is done, like the relay's: that the link
  // selects a version shows nothing of the process that runs, which may be the one from before.
  let begun = tracked.activation;
  const resumed = !!begun;
  if (begun) {
    begun.resumed = (begun.resumed ?? 0) + 1;
    save();
    system.log(
      `An updater ended while switching the host to ${tracked.tag}; the switch goes on from there, and nothing is taken for done.`,
    );
  } else {
    const selected = system.currentHost();
    // Selected and running it already, by hand or by an updater whose record was lost: it is
    // recorded once it is seen to run this version and to stay up.
    if (
      selected === tracked.version &&
      system.hostRuns(tracked.version) &&
      (await hostUp(system, tracked.version))
    )
      return done();
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
    if (selected !== tracked.version) tracked.previous = selected;
    delete tracked.waiting;
    begun = tracked.activation = { step: 'switch', entered: system.now().toISOString() };
    save();
  }
  const activation = begun;
  if (activation.step === 'switch') {
    let ok = false;
    try {
      // A host the earlier updater started on this version goes on running, and is watched.
      const runs =
        resumed && system.currentHost() === tracked.version && system.hostRuns(tracked.version);
      if (runs)
        system.log(`The host already runs ${tracked.tag}; it is watched, not started again.`);
      else {
        system.selectHost(tracked.version);
        system.restartHost();
      }
      ok = await hostUp(system, tracked.version);
    } catch (error) {
      system.log(`Starting the ${tracked.tag} host failed: ${message(error)}`);
    }
    if (ok) return done();
    activation.step = 'back';
    activation.entered = system.now().toISOString();
    save();
  }
  tracked.phase = 'failed';
  if (tracked.previous) {
    let back = false;
    try {
      system.selectHost(tracked.previous);
      system.restartHost();
      back = await hostUp(system, tracked.previous);
    } catch (error) {
      system.log(`Starting the ${tracked.previous} host again failed: ${message(error)}`);
    }
    tracked.error = back
      ? `The ${tracked.tag} host did not stay up; it runs ${tracked.previous} again.`
      : `The ${tracked.tag} host did not stay up, and ${tracked.previous}, which is selected again, does not stay up either.`;
  } else {
    system.stopHost();
    tracked.error = `The ${tracked.tag} host did not stay up and was stopped.`;
  }
  delete tracked.activation;
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
  /** When its main process began, in milliseconds, as the kernel tells it. */
  started?: number;
  /** The release directory its main process runs in. */
  release?: string;
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
 * a step that starts a relay first stops whatever runs, unless the relay that runs is the one
 * the step itself started, which is then watched instead; and the data is replaced under a name
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
    // The backup was written uncompressed, to keep the relay stopped for less long. It is
    // compressed now that the relay runs, and by later checks when this one does not finish.
    tidy(system, state, save);
  };

  let begun = release.activation;
  const resumed = !!begun;
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
    const began = system.now().toISOString();
    begun = release.activation = {
      step: current ? 'trial' : 'backup',
      began,
      entered: began,
      ...(current ? { previous: current } : {}),
    };
    delete release.waiting;
    save();
  }
  const activation = begun;
  const previous = activation.previous;
  const enter = (step: Activation['step']) => {
    activation.step = step;
    activation.entered = system.now().toISOString();
    save();
  };
  const keepAs = (commit: string) => `${commit.slice(0, 12)}-${stampOf(system.now())}`;
  // Whether the relay that runs is the one an earlier updater started in the step this one
  // takes up: the service is active and never started its process again, the process runs in
  // the release's directory, which is the one selected, it began after the step was written
  // (so after that updater's own stop), and the data the step puts in place is in place.
  let taken = resumed;
  const startedBefore = (commit: string, keep?: string): boolean => {
    if (!taken) return false;
    taken = false;
    const unit = system.unit();
    const entered = Date.parse(activation.entered ?? '');
    return (
      !!unit &&
      unit.state === 'active' &&
      unit.restarts === 0 &&
      unit.pid > 0 &&
      unit.release === commit &&
      system.currentRelease() === commit &&
      unit.started !== undefined &&
      // The kernel tells a start to the second.
      unit.started + 1000 >= entered &&
      (!keep || system.restored(keep))
    );
  };
  // Puts a backup back under the name written for it. A backup that cannot be put back leaves
  // the data as it is, nothing moved aside, and the relay is started on that.
  const putBack = (keep: string | undefined, record: (kept: string) => void) => {
    if (!activation.backup || !keep || activation.restoreError) return;
    try {
      record(system.restore(activation.backup, keep));
    } catch (error) {
      if (!(error instanceof BackupError)) throw error;
      activation.restoreError = message(error);
      save();
      system.log(
        `The data backup ${activation.backup} cannot be put back: ${activation.restoreError}. The private data stays as it is, and nothing was moved aside.`,
      );
    }
  };
  // Stops whatever relay runs, puts the data in place, selects a release, starts its relay and
  // waits for it. A part that fails is the relay's reason too, and all of it can be done again.
  const start = async (commit: string, data?: () => void, keep?: string): Promise<Health> => {
    try {
      if (startedBefore(commit, keep)) {
        // The restore that came before its start is whole: this only says where it kept things.
        if (keep) data?.();
        system.log(
          `The relay of ${commit} that the updater started runs; it is checked, not started again.`,
        );
      } else {
        system.stopService();
        data?.();
        system.select(commit);
        system.startService();
      }
      return await healthy(system);
    } catch (error) {
      return { ok: false, reason: `could not be started: ${message(error)}` };
    }
  };
  // What is said of a backup that could not be put back.
  const unrestored = () =>
    activation.restoreError
      ? ` The data backup ${activation.backup} could not be put back (${activation.restoreError}), so the private data stayed as it was, with nothing moved aside.`
      : '';

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
        // The earlier updater may have got further than the state says, when the state is the
        // one from before: a release that is already selected may have written to this data.
        const behind = resumed && system.currentRelease() === release.commit;
        system.stopService();
        activation.backup = system.backup(release.commit, activation.began, behind);
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
        putBack(activation.keep, (kept) => (activation.kept = kept));
      } catch (error) {
        system.log(`Stopping ${tag} failed: ${message(error)}`);
      }
      return fail(
        `${tag} failed its health check, so the relay stays stopped.${activation.kept ? ` Data it wrote is kept in ${activation.kept}.` : ''}${unrestored()} Its relay ${activation.failed}.`,
      );
    } else if (activation.step === 'previous') {
      const back = await start(
        previous!,
        () => putBack(activation.keep, (kept) => (activation.kept = kept)),
        activation.restoreError ? undefined : activation.keep,
      );
      const wrote = activation.kept
        ? ` Data the failed release wrote is kept in ${activation.kept}.`
        : '';
      if (back.ok)
        return fail(
          activation.backupError
            ? `${tag} was not activated: private data could not be backed up (${activation.backupError}). ${previous} runs again on its data, which was not touched.`
            : activation.restoreError
              ? `${tag} failed its health check; ${previous} runs again, on the data as ${tag} left it.${unrestored()} Its relay ${activation.failed}.`
              : `${tag} failed its health check; ${previous} was restored.${wrote} Its relay ${activation.failed}.`,
        );
      // The release that ran no longer starts, as one whose data outgrew it while it ran does
      // not. The new one read this data in its trial, so rather than leave the relay down it is
      // started, on the data as it was before the switch: the release that just ended may have
      // written to it, so what it left is kept aside and the backup put back once more.
      activation.back = back.reason;
      if (activation.backup && !activation.restoreError)
        activation.keepPrevious = keepAs(previous!);
      system.log(
        activation.backupError
          ? `${previous} did not come back: its relay ${back.reason}. Starting ${tag}, which read a copy of this data, on the data as it is, without a backup.`
          : activation.restoreError
            ? `${previous} did not come back: its relay ${back.reason}. Starting ${tag} once more, on the data as it is, since the backup cannot be put back.`
            : `${previous} did not come back: its relay ${back.reason}. Starting ${tag} once more, on the data as it was before the switch.`,
      );
      enter('again');
    } else {
      const again = await start(
        release.commit,
        () => putBack(activation.keepPrevious, (kept) => (activation.keptPrevious = kept)),
        activation.restoreError ? undefined : activation.keepPrevious,
      );
      const wrote =
        (activation.kept ? ` Data the failed release wrote is kept in ${activation.kept}.` : '') +
        (activation.keptPrevious
          ? ` What ${previous} left when it did not start is kept in ${activation.keptPrevious}.`
          : '') +
        unrestored();
      const told = activation.backupError
        ? `Private data could not be backed up before activating ${tag} (${activation.backupError}) and ${previous} did not start again (its relay ${activation.back})`
        : `${tag} failed its first health check (its relay ${activation.failed}) and ${previous} did not start again (its relay ${activation.back})`;
      if (again.ok) {
        release.note = activation.backupError
          ? `${told}, so ${tag}, which read a copy of this data in its trial, was started on it and serves, without a backup. ${previous} can no longer be gone back to.`
          : activation.restoreError
            ? `${told}, so ${tag} was started once more, on the data as it was left, and serves. ${previous} can no longer be gone back to.${wrote}`
            : `${told}, so ${tag} was started once more, on the data as it was before the switch, and serves. ${previous} can no longer be gone back to.${wrote}`;
        // A backup that cannot be put back is not kept as one.
        complete(activation.restoreError ? undefined : activation.backup);
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

// What survives what. An updater that is killed loses nothing: every file below is written under
// a name of its own and renamed into place, so a reader finds the file from before or the whole
// new one. A power loss, or a kernel that stops, also loses what was written and not yet on the
// disk, so the state, a backup with its manifest and each rename that replaces the data are
// flushed (fsync of the file, then of its folder) before the next thing relies on them, in the
// order a recovery reads them. What that leaves open: a disk that reports a flush it did not do,
// and the journal generations both damaged, which a check reports as a lost state.

/** Flushes a file's contents to the disk. */
export function syncFile(path: string) {
  const file = openSync(path, 'r+');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

/** Flushes a folder's entries to the disk: the names created in it, renamed and removed. */
export function syncFolder(path: string) {
  // Windows, where only the unit tests run, has no handle to a folder that can be flushed.
  if (process.platform === 'win32') return;
  const folder = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

/** A name beside `path` that no other writer uses, for a file that is renamed into place. */
const partialOf = (path: string) =>
  `${path}.${process.pid}-${randomBytes(4).toString('hex')}.partial`;

/** Removes what writers that were killed left beside `path`. The caller holds the lock. */
function clearPartials(path: string) {
  const folder = dirname(path);
  const prefix = `${basename(path)}.`;
  for (const name of existsSync(folder) ? readdirSync(folder) : [])
    if (name.startsWith(prefix) && name.endsWith('.partial'))
      rmSync(join(folder, name), { force: true });
}

/**
 * Replaces a file with `data` so that it is whole and on the disk when this returns, and so that
 * until then the file from before is.
 */
export function writeDurably(path: string, data: string | Buffer, mode: number) {
  const partial = partialOf(path);
  const file = openSync(partial, 'wx', mode);
  try {
    writeFileSync(file, data);
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    rmSync(partial, { force: true });
    throw error;
  }
  closeSync(file);
  renameSync(partial, path);
  syncFolder(dirname(path));
}

const validState = (value: unknown): value is State =>
  !!value &&
  typeof value === 'object' &&
  (value as State).version === 1 &&
  Array.isArray((value as State).history);

/** Reads one generation of the journal: the state, nothing when it is not there, or why not. */
function readGeneration(file: string): State | undefined | Error {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return error as Error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new Error(`${file} is not whole (${text.length} characters)`);
  }
  // Written by another version of the updater: not damage, and never replaced by a guess.
  if (value && typeof value === 'object' && typeof (value as State).version === 'number')
    if ((value as State).version !== 1) throw new Error(`${file} has an unknown format.`);
  return validState(value) ? value : new Error(`${file} does not hold a state`);
}

const previousOf = (file: string) => `${file}.previous`;

/**
 * Reads the updater's state. The journal is written whole and flushed, so it is missing or
 * damaged only after something the writes do not cover; the generation before it is then used,
 * and `recovered` says so. With neither where one of them was, the state is lost.
 */
export function readJournal(file: string): { state: State; recovered?: Recovered } {
  const journal = readGeneration(file);
  if (journal && !(journal instanceof Error)) return { state: journal };
  const previous = readGeneration(previousOf(file));
  // Nothing was ever written: a new server.
  if (journal === undefined && previous === undefined) return { state: emptyState() };
  const problem = journal instanceof Error ? journal.message : `${file} is missing`;
  if (previous && !(previous instanceof Error))
    return { state: previous, recovered: { from: 'previous', problem } };
  return {
    state: emptyState(),
    recovered: {
      from: 'lost',
      problem: `${problem}, and ${previous instanceof Error ? previous.message : `${previousOf(file)} is missing`}`,
    },
  };
}

/**
 * Writes the updater's state: whole and on the disk before this returns, with the generation it
 * replaces kept as `<file>.previous`. A journal that cannot be read is kept aside for whoever
 * looks into it, and never becomes the generation before.
 */
export function writeJournal(file: string, state: State) {
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  clearPartials(file);
  const partial = partialOf(file);
  const output = openSync(partial, 'wx', 0o600);
  try {
    writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(output);
  } finally {
    closeSync(output);
  }
  const current = readGeneration(file);
  if (current instanceof Error) renameSync(file, `${file}.unreadable-${stampOf(new Date())}`);
  else if (current) {
    // The same file under a second name: the journal's name then moves on to the new one.
    const link = partialOf(previousOf(file));
    try {
      linkSync(file, link);
    } catch {
      copyFileSync(file, link);
      syncFile(link);
    }
    renameSync(link, previousOf(file));
  }
  renameSync(partial, file);
  syncFolder(folder);
}

/** A backup that cannot be put back: missing, not the archive that was made, or not whole. */
export class BackupError extends Error {}

/** One thing a backup holds, by its path inside the data folder. */
export type BackupEntry = {
  path: string;
  type: 'file' | 'folder' | 'link';
  /** A file's bytes, and when it was last written. */
  size?: number;
  mtime?: number;
  /** Where a link points. */
  target?: string;
};

/**
 * What was backed up and the archive that holds it, written beside the archive, on the disk
 * before the state names the backup: enough to tell that an archive is the one that was made
 * and that what it unpacks to is everything that was there.
 */
export type BackupManifest = {
  version: 1;
  commit: string;
  /** The activation it was made for. */
  began?: string;
  made: string;
  /** The archive as it was written, and its compressed copy once there is one. */
  archive: { bytes: number; sha256: string };
  compressed?: { bytes: number; sha256: string };
  entries: BackupEntry[];
};

/** The manifest of a backup, whichever of its two files names it. */
export const manifestOf = (backup: string) => `${backup.replace(/\.gz$/, '')}.manifest.json`;

/** The files, folders and links of a folder, by their paths inside it, in a fixed order. */
export function listTree(folder: string, skip: string[] = []): BackupEntry[] {
  const entries: BackupEntry[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && skip.includes(entry.name)) continue;
      const path = prefix + entry.name;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path, type: 'folder' });
        walk(full, `${path}/`);
      } else if (entry.isSymbolicLink())
        entries.push({ path, type: 'link', target: readlinkSync(full) });
      else if (entry.isFile()) {
        const file = lstatSync(full);
        entries.push({ path, type: 'file', size: file.size, mtime: Math.floor(file.mtimeMs) });
      }
      // Sockets and pipes are not data, and an archive does not hold them.
    }
  };
  walk(folder, '');
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * How a folder differs from what a manifest lists, or nothing when it holds exactly that: every
 * path, as the same kind of thing, each file with its size (and its time, when asked).
 */
export function treeDifference(
  expected: BackupEntry[],
  actual: BackupEntry[],
  times = false,
): string | undefined {
  const found = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of expected) {
    const other = found.get(entry.path);
    if (!other) return `${entry.path} is missing`;
    if (other.type !== entry.type) return `${entry.path} is a ${other.type}, not a ${entry.type}`;
    if (entry.type === 'file' && other.size !== entry.size)
      return `${entry.path} holds ${other.size} bytes, not ${entry.size}`;
    if (entry.type === 'file' && times && other.mtime !== entry.mtime)
      return `${entry.path} was written since`;
    if (entry.type === 'link' && other.target !== entry.target)
      return `${entry.path} points elsewhere`;
    found.delete(entry.path);
  }
  const extra = found.keys().next();
  return extra.done ? undefined : `${extra.value} was not there`;
}

/** The size and SHA-256 of a file, read through once. */
export function fileDigest(path: string): { bytes: number; sha256: string } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  const file = openSync(path, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(file, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(file);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Reads the manifest of a backup, or says why the backup cannot be trusted without one. */
export function readManifest(backup: string): BackupManifest {
  let value: BackupManifest;
  try {
    value = JSON.parse(readFileSync(manifestOf(backup), 'utf8'));
  } catch (error) {
    throw new BackupError(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `it has no manifest (${manifestOf(backup)}), so nothing says what it should hold`
        : `its manifest cannot be read (${message(error)})`,
    );
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.entries) ||
    typeof value.archive?.sha256 !== 'string' ||
    typeof value.archive.bytes !== 'number'
  )
    throw new BackupError('its manifest is not one');
  return value;
}

/** Throws unless the file of a backup is, byte for byte, the one its manifest recorded. */
export function verifyBackup(backup: string, manifest: BackupManifest) {
  const recorded = backup.endsWith('.gz') ? manifest.compressed : manifest.archive;
  if (!recorded) throw new BackupError('its manifest does not record a compressed copy');
  let size: number;
  try {
    size = lstatSync(backup).size;
  } catch {
    throw new BackupError('it is missing');
  }
  if (size !== recorded.bytes)
    throw new BackupError(`it holds ${size} bytes where ${recorded.bytes} were written`);
  if (fileDigest(backup).sha256 !== recorded.sha256)
    throw new BackupError('it is not the archive that was written (its SHA-256 differs)');
}

/** What turns a folder into an archive and back; replaceable in tests. */
export type Archiver = {
  /** Writes the archive of the folder `name` in `parent`, without `skip` at its top, to `to`. */
  archive(parent: string, name: string, skip: string[], to: string): void;
  /** Unpacks an archive, compressed or not, into `into`, and flushes what it wrote. */
  extract(backup: string, into: string): void;
  /** Writes the compressed copy of an archive to the open file `to`. */
  pack(archive: string, to: number): void;
  /** The SHA-256 of what a compressed copy unpacks to; throws when it does not unpack. */
  unpacked(packed: string): string;
};

/**
 * Archives the folder `data` into `backups` as `pre-<commit>.tar` with its manifest, and returns
 * the archive: flushed with its manifest and its folder, and named only once it is whole. The
 * backup an earlier updater made for the same activation is returned instead while the data is
 * as that backup holds it, or, when `behind`, whatever the data holds now.
 */
export function makeBackup(options: {
  data: string;
  backups: string;
  commit: string;
  began?: string;
  behind?: boolean;
  skip: string[];
  made: Date;
  archiver: Archiver;
}): string {
  const { data, backups, commit, began, skip, archiver } = options;
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const entries = listTree(data, skip);
  const first = join(backups, `pre-${commit}.tar`);
  if (began)
    for (const name of readdirSync(backups).sort()) {
      if (!name.startsWith(`pre-${commit}`) || !name.endsWith('.tar')) continue;
      const made = join(backups, name);
      try {
        const manifest = readManifest(made);
        if (manifest.commit !== commit || manifest.began !== began) continue;
        if (lstatSync(made).size !== manifest.archive.bytes) continue;
        if (options.behind || !treeDifference(manifest.entries, entries, true)) return made;
      } catch {
        // Not a backup of this activation that can be used.
      }
    }
  let path = first;
  if ([path, `${path}.gz`, manifestOf(path)].some((taken) => existsSync(taken)))
    path = join(backups, `pre-${commit}-${stampOf(options.made)}.tar`);
  clearPartials(path);
  const partial = partialOf(path);
  try {
    archiver.archive(dirname(data), basename(data), skip, partial);
    chmodSync(partial, 0o600);
    syncFile(partial);
    const manifest: BackupManifest = {
      version: 1,
      commit,
      ...(began ? { began } : {}),
      made: options.made.toISOString(),
      archive: fileDigest(partial),
      entries,
    };
    writeDurably(manifestOf(path), `${JSON.stringify(manifest)}\n`, 0o600);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, path);
  syncFolder(backups);
  return path;
}

/**
 * Compresses an archive beside itself and returns the copy, published only once it is on the
 * disk and unpacks to the very archive the manifest recorded. The archive itself stays: it is
 * removed once the state names the copy. Done again, it returns the copy that was published.
 */
export function packBackup(backup: string, archiver: Archiver): string {
  if (!backup.endsWith('.tar')) return backup;
  const packed = `${backup}.gz`;
  const manifest = readManifest(backup);
  if (manifest.compressed && existsSync(packed)) {
    try {
      verifyBackup(packed, manifest);
      return packed;
    } catch {
      // A copy that is not the one recorded is made again.
    }
  }
  verifyBackup(backup, manifest);
  clearPartials(packed);
  const partial = partialOf(packed);
  const output = openSync(partial, 'wx', 0o600);
  try {
    try {
      archiver.pack(backup, output);
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
    if (archiver.unpacked(partial) !== manifest.archive.sha256)
      throw new Error(`the compressed copy of ${backup} does not unpack to it`);
    writeDurably(
      manifestOf(backup),
      `${JSON.stringify({ ...manifest, compressed: fileDigest(partial) })}\n`,
      0o600,
    );
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  renameSync(partial, packed);
  syncFolder(dirname(packed));
  return packed;
}

/**
 * Replaces the folder `data` with the one of its name that `extract` puts into `staging`,
 * keeping the replaced folder as `kept`. It can be run again after ending anywhere: `kept`
 * exists only once the extraction finished and `validate` accepted what it unpacked, so an
 * unfinished extraction is done again, a finished one is not, and the data is never replaced
 * twice. Each rename is flushed before the next, so a power loss leaves one of the same places
 * to go on from. An extraction that fails or unpacks something else throws a BackupError, with
 * the data untouched and nothing moved aside.
 */
export function replaceData(
  data: string,
  staging: string,
  kept: string,
  extract: () => void,
  validate?: (unpacked: string) => void,
) {
  const parent = dirname(data);
  if (!existsSync(kept)) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    try {
      extract();
      validate?.(join(staging, basename(data)));
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error instanceof BackupError ? error : new BackupError(message(error));
    }
    syncFolder(staging);
    syncFolder(parent);
    renameSync(data, kept);
    syncFolder(parent);
  }
  if (!existsSync(data)) {
    if (!existsSync(join(staging, basename(data))))
      throw new Error(
        `${data} is missing and so is what was unpacked to replace it; what it held is in ${kept}.`,
      );
    renameSync(join(staging, basename(data)), data);
    syncFolder(parent);
  }
  rmSync(staging, { recursive: true, force: true });
  syncFolder(parent);
}

/**
 * Puts a backup back in place of the folder `data` and returns where the replaced folder is
 * kept. Before anything moves, the backup must be the file its manifest recorded and unpack to
 * everything that was backed up; otherwise it throws a BackupError and the data stays as it is.
 */
export function restoreBackup(options: {
  data: string;
  backup: string;
  keep: string;
  archiver: Archiver;
}): string {
  const { data, backup, keep, archiver } = options;
  if (!/^[A-Za-z0-9_.-]+$/.test(keep)) throw new Error(`${keep} cannot name a folder.`);
  const parent = dirname(data);
  const name = basename(data);
  const staging = join(parent, `.${name}-restore-${keep}`);
  const kept = join(parent, `.${name}-failed-${keep}`);
  // The data was moved aside already: what was unpacked then was checked then.
  let manifest: BackupManifest | undefined;
  if (!existsSync(kept)) {
    manifest = readManifest(backup);
    verifyBackup(backup, manifest);
  }
  replaceData(
    data,
    staging,
    kept,
    () => archiver.extract(backup, staging),
    (unpacked) => {
      const difference = treeDifference(manifest?.entries ?? [], listTree(unpacked));
      if (difference)
        throw new BackupError(`it does not unpack to what was backed up: ${difference}`);
    },
  );
  return kept;
}

/** Whether the restore named `keep` replaced the folder `data`, all of it. */
export function restoreDone(data: string, keep: string): boolean {
  const parent = dirname(data);
  const name = basename(data);
  return (
    existsSync(join(parent, `.${name}-failed-${keep}`)) &&
    existsSync(data) &&
    !existsSync(join(parent, `.${name}-restore-${keep}`))
  );
}

/** What a folder of private data holds, as far as the room it takes goes. */
export type TreeSize = { bytes: number; entries: number };

/**
 * Why the disks lack the room an activation can need at once, or nothing when they have it.
 * The backup is the data once over, in an archive whose headers and padding take up to three
 * blocks of 512 bytes for each entry. A restore unpacks the data beside itself, every file
 * rounded up to a block of the disk, and what it replaces stays in a folder of its own; when the
 * release before no longer starts there is a second restore, whose folder stays too. So the disk
 * of the data needs the data twice over, the disk of the backups once, and a disk that holds
 * both (`device` is the same) needs all three together.
 */
export function spaceShort(
  tree: TreeSize,
  data: { path: string; device: number; free: number },
  backups: { path: string; device: number; free: number },
): string | undefined {
  const megabytes = (bytes: number) => `${Math.ceil(bytes / 1_000_000)} MB`;
  const archive = tree.bytes + tree.entries * 1536 + 20_480;
  const restores = 2 * (tree.bytes + tree.entries * 4096);
  if (data.device === backups.device) {
    const free = Math.min(data.free, backups.free);
    return free < archive + restores
      ? `${backups.path} and ${data.path} share a disk with ${megabytes(free)} free, less than the ${megabytes(archive + restores)} that a backup of the ${megabytes(tree.bytes)} of private data (${megabytes(archive)}) and the two restores an activation can need (${megabytes(restores)}) take together.`
      : undefined;
  }
  if (backups.free < archive)
    return `${backups.path} has ${megabytes(backups.free)} free, less than a backup of the ${megabytes(tree.bytes)} of private data takes (${megabytes(archive)}).`;
  if (data.free < restores)
    return `${data.path} has ${megabytes(data.free)} free, less than the two restores of the ${megabytes(tree.bytes)} of private data that an activation can need (${megabytes(restores)}).`;
  return undefined;
}

/**
 * Whether an updater shows signs of life: its own code ran (`beat`), or the commands it waits
 * for used the CPU or the disk (`sample`, of the whole unit). An updater that for `limit` does
 * neither is hung. No length of time ends one that works.
 */
export function liveness(limit: number, now: number, cpuNeeded = 5000, ioNeeded = 1_000_000) {
  let seen = now;
  let base: { cpu?: number; io?: number } = {};
  return {
    beat(at: number) {
      seen = at;
    },
    sample(at: number, work: { cpu?: number; io?: number }) {
      const progressed =
        (work.cpu !== undefined && base.cpu !== undefined && work.cpu - base.cpu >= cpuNeeded) ||
        (work.io !== undefined && base.io !== undefined && work.io - base.io >= ioNeeded);
      const rebased =
        (work.cpu === undefined) !== (base.cpu === undefined) ||
        (work.io === undefined) !== (base.io === undefined);
      if (progressed) seen = at;
      if (progressed || rebased) base = { ...work };
    },
    alive: (at: number) => at - seen < limit,
    idle: (at: number) => at - seen,
  };
}

/** The flock(1) arguments that run a command while holding the deployment lock. */
export function lockArguments(lock: string, wait: boolean, command: string[]): string[] {
  return [
    ...(wait ? [] : ['--nonblock', '--conflict-exit-code', String(lockHeld)]),
    lock,
    ...command,
  ];
}
/** flock's exit status when something else holds the lock. */
export const lockHeld = 75;

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

/**
 * Runs a command without holding this process's own code meanwhile, so that an updater waiting
 * for a build goes on showing that it lives.
 */
function runFree(command: string, args: string[], stdio: (number | 'ignore' | 'inherit')[]) {
  return new Promise<number | null>((done, failed) => {
    const child = spawn(command, args, { stdio });
    child.on('error', failed);
    child.on('close', (status) => done(status));
  });
}

/** When a process began, in milliseconds, from the kernel: its start since boot and the boot. */
function processStart(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    const started = boot * 1000 + ticks * 10;
    return Number.isFinite(started) && started > 0 ? started : undefined;
  } catch {
    return undefined;
  }
}

/** The archives of the server: GNU tar and gzip, each flushed before anything relies on it. */
const archiver: Archiver = {
  archive(parent, name, skip, to) {
    run('tar', [
      '-cf',
      to,
      ...skip.map((entry) => `--exclude=${name}/${entry}`),
      '-C',
      parent,
      name,
    ]);
  },
  extract(backup, into) {
    // As root, tar restores the original owners and modes; it reads either kind of archive.
    run('tar', ['-xf', backup, '-C', into]);
    // Everything it unpacked, on the disk before the data is replaced by it.
    run('sync', ['--file-system', into]);
  },
  pack(archive, to) {
    run('gzip', ['-c', archive], { stdio: ['ignore', to, 'inherit'] });
  },
  unpacked(packed) {
    // One pass, which fails when gzip does: a copy that is cut short is not hashed as if whole.
    const result = spawnSync(
      'bash',
      ['-o', 'pipefail', '-c', 'gzip -dc -- "$1" | sha256sum', 'bash', packed],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const sha256 = /^[0-9a-f]{64}/.exec(result.stdout ?? '')?.[0];
    if (result.status !== 0 || !sha256) throw new Error(`${packed} cannot be unpacked.`);
    return sha256;
  },
};

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
  const sandbox = async (
    directory: string,
    command: string[],
    network: boolean,
    input?: number,
  ) => {
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
    const status = await runFree(
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
      [input ?? 'ignore', 'inherit', 'inherit'],
    );
    if (status !== 0) throw new Error(`systemd-run --quiet exited with ${status ?? 'a signal'}.`);
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
  const transient = async (command: string[], user?: string, check = true) => {
    const status = await runFree(
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
      ['ignore', 'inherit', 'inherit'],
    );
    if (check && status !== 0)
      throw new Error(`${basename(command[0])} exited with ${status ?? 'a signal'}.`);
    return status;
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
  // The size of a folder's files and how many things it holds, while the relay writes in it.
  const treeSize = (folder: string, skip: string[] = []): TreeSize => {
    const size = { bytes: 0, entries: 1 };
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const path = join(folder, entry.name);
      try {
        if (entry.isDirectory()) {
          const inner = treeSize(path);
          size.bytes += inner.bytes;
          size.entries += inner.entries;
        } else {
          size.bytes += lstatSync(path).size;
          size.entries++;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return size;
  };
  // What says whether the state just read is the journal as it was last written.
  let recovered: Recovered | undefined;
  // The host's process as this updater first saw it run a version.
  let hostSeen: { version: string; pid: number } | undefined;
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
      const journal = readJournal(stateFile);
      recovered = journal.recovered;
      return journal.state;
    },
    recovered: () => recovered,
    writeState(state) {
      writeJournal(stateFile, state);
      recovered = undefined;
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
      clearPartials(saved(commit));
      writeDurably(saved(commit), data, 0o600);
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
        await sandbox(building, ['/usr/bin/tar', '-xzf', '-', ...tar], false, input);
      } finally {
        closeSync(input);
        rmSync(archive, { force: true });
      }
      const npm = join(dirname(process.execPath), 'npm');
      await sandbox(building, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], true);
      await sandbox(building, [npm, 'run', 'build'], false);
      await sandbox(building, [npm, 'test'], false);
      // The relay runs these files, so only root may change them from now on.
      run('chown', ['-R', '-h', 'root:root', building]);
      run('chmod', ['-R', 'go-w', building]);
      create(join(building, '.built-by-updater'));
      create(join(building, '.deployment-ready'));
      // A release that is ready is whole: its files are on the disk before its name says so.
      run('sync', ['--file-system', building]);
      renameSync(building, target);
      syncFolder(releases);
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
      syncFolder(config.root);
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
      // Where the process runs: the service's working directory is the current link, which
      // the process resolved when it began, so this is the release it runs whatever the link
      // selects by now.
      let release: string | undefined;
      const started = pid ? processStart(pid) : undefined;
      if (pid && !trial) {
        try {
          const directory = realpathSync(`/proc/${pid}/cwd`);
          if (dirname(directory) === realpathSync(releases)) release = basename(directory);
        } catch {
          // It ended meanwhile.
        }
      }
      return {
        state: values.ActiveState || 'unknown',
        restarts: Number(values.NRestarts) || 0,
        pid,
        ...(cpu === undefined ? {} : { cpu }),
        ...(io === undefined ? {} : { io }),
        ...(result ? { result: `${result}${status ? ` ${status}` : ''}` } : {}),
        ...(started === undefined ? {} : { started }),
        ...(release ? { release } : {}),
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
      // Both disks, which are often one: what they must hold at once is counted together.
      const disk = (path: string) => {
        const space = statfsSync(path);
        return { path, device: statSync(path).dev, free: space.bavail * space.bsize };
      };
      const short = spaceShort(
        treeSize(config.data, ['.npm']),
        disk(dirname(config.data)),
        disk(config.backups),
      );
      if (short) throw new Error(short);
    },
    // Uncompressed: compressing the owner's 785 MB took 24 seconds of a stopped relay, and
    // writing them as they are, with their SHA-256 and flushed to the disk, takes a few. The
    // archive is compressed once the relay runs. Earlier manual builds left an npm cache in the
    // service home; it is not private data.
    backup: (commit, began, behind) =>
      makeBackup({
        data: config.data,
        backups: config.backups,
        commit,
        began,
        behind,
        skip: ['.npm'],
        made: new Date(),
        archiver,
      }),
    compress: (backup) => packBackup(backup, archiver),
    removeBackup(backup) {
      if (dirname(backup) !== config.backups || !backup.endsWith('.tar')) return;
      rmSync(backup, { force: true });
      syncFolder(config.backups);
    },
    select(release) {
      if (!/^[\w.-]+$/.test(release) || !lstatSync(join(releases, release)).isDirectory())
        throw new Error(`${release} is not a release directory.`);
      const next = join(config.root, `.next-${release}`);
      rmSync(next, { force: true });
      symlinkSync(join(releases, release), next);
      renameSync(next, current);
      syncFolder(config.root);
    },
    restore: (backup, keep) => restoreBackup({ data: config.data, backup, keep, archiver }),
    restored: (keep) => restoreDone(config.data, keep),
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
        await sandbox(
          extracting,
          ['/bin/sh', '-c', './app.AppImage --appimage-extract >/dev/null'],
          false,
        );
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
        run('sync', ['--file-system', app]);
        renameSync(app, join(hosts, version));
        syncFolder(hosts);
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
    async hostPackages() {
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
        await transient(['/usr/bin/apt-get', 'update', '-q']);
        await transient([
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
      await system.hostPackages();
      if (spawnSync('id', ['-u', host.user], { stdio: 'ignore' }).status !== 0) {
        await transient([
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
        if ((await transient(['/bin/bash', '-lc', probe], host.user, false)) === 0) continue;
        system.log(`Installing ${cli} for ${host.user}.`);
        await transient(['/bin/bash', '-c', cliInstaller, 'install', url, runner], host.user);
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
      syncFolder(hosts);
    },
    hostRuns(version) {
      if (!config.host || system.currentHost() !== version) return false;
      const unit = show(config.host.service, [
        'ActiveState',
        'NRestarts',
        'MainPID',
        'ControlGroup',
      ]);
      const pid = Number(unit?.MainPID) || 0;
      if (unit?.ActiveState !== 'active' || !pid) return false;
      // Started again by its service since this updater restarted it: it did not stay up.
      if (hostRestarts !== undefined && unit.NRestarts !== hostRestarts) return false;
      // Another process than the one first seen running this version: it ended in between.
      if (hostSeen?.version === version && hostSeen.pid !== pid) return false;
      // The files its processes run: the app's own programs lie in its version's folder.
      const running = new Set<string>();
      try {
        const folder = `${realpathSync(hosts)}/`;
        const processes = readFileSync(`/sys/fs/cgroup${unit.ControlGroup}/cgroup.procs`, 'utf8');
        for (const process of processes.split('\n').filter(Boolean)) {
          try {
            const program = readlinkSync(`/proc/${process}/exe`);
            if (program.startsWith(folder)) running.add(program.slice(folder.length).split('/')[0]);
          } catch {
            // It ended meanwhile, or is not a program on a disk.
          }
        }
      } catch {
        // Without its processes, when it began says which version it runs.
      }
      let runs: boolean;
      if (running.size) runs = running.size === 1 && running.has(version);
      else {
        // Its command names the link, which the process resolved when it began: one that began
        // after the link last changed runs what the link selects. The kernel tells a start to
        // the second.
        const began = processStart(pid);
        const selected = lstatSync(join(hosts, 'current')).ctimeMs;
        runs = began !== undefined && began + 1000 >= selected;
      }
      if (runs) hostSeen = { version, pid };
      return runs;
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
      hostSeen = undefined;
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
      if (backup && dirname(backup) === config.backups) {
        // With its manifest, and the archive a compressed copy had not replaced yet.
        for (const path of [backup, backup.replace(/\.gz$/, ''), manifestOf(backup)])
          rmSync(path, { force: true });
      }
      for (const entry of existsSync(config.backups) ? readdirSync(config.backups) : [])
        if (entry.startsWith(`pre-${commit}-windows-installer`))
          rmSync(join(config.backups, entry), { force: true });
    },
  };
  return system;
}

/** What the unit of this updater used so far: CPU time in milliseconds, bytes read and written. */
function ownWork(): { cpu?: number; io?: number } {
  try {
    const group = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').at(-1) ?? '';
    const folder = `/sys/fs/cgroup${group.slice(group.lastIndexOf(':') + 1)}`;
    const work: { cpu?: number; io?: number } = {};
    try {
      const used = /^usage_usec (\d+)$/m.exec(readFileSync(join(folder, 'cpu.stat'), 'utf8'));
      if (used) work.cpu = Number(used[1]) / 1000;
    } catch {
      // No CPU accounting for this unit.
    }
    try {
      let bytes = 0;
      for (const match of readFileSync(join(folder, 'io.stat'), 'utf8').matchAll(
        /\b[rw]bytes=(\d+)/g,
      ))
        bytes += Number(match[1]);
      work.io = bytes;
    } catch {
      // No IO accounting for this unit.
    }
    return work;
  } catch {
    return {};
  }
}

const lockEnvironment = 'AGENT_STUDIO_UPDATE_LOCK';
const beatEnvironment = 'AGENT_STUDIO_UPDATE_BEAT';

/**
 * Runs a command of this updater while holding the deployment lock, which everything that
 * changes the state or a deployment holds: a check, retry, trust, install.sh and a deployment by
 * hand. A check skips its run while the lock is held; retry and trust wait for it.
 *
 * As a service (agent-studio-update.service, Type=notify with a watchdog) the check has no
 * deadline: this process tells systemd that it started, runs the check as a child, and answers
 * the watchdog for as long as the check shows signs of life, which are its own code running (a
 * byte on a pipe every ten seconds) or the commands it waits for using the CPU or the disk. One
 * that for `hungAfter` does neither is no longer answered for, and systemd ends the unit, whose
 * next run goes on from the state.
 */
async function locked(config: Config, argv: string[]): Promise<number> {
  const [command = 'check'] = argv;
  const lock = join(config.root, '.deploy.lock');
  const self = [process.execPath, resolve(import.meta.filename), ...argv];
  const environment = { ...process.env, [lockEnvironment]: 'held' };
  if (command !== 'check') {
    // Says so only when it has to wait.
    const free = spawnSync('flock', lockArguments(lock, false, ['true']), { stdio: 'ignore' });
    if (free.status === lockHeld)
      console.log('A check or a deployment is running; waiting for it to end.');
    const result = spawnSync('flock', lockArguments(lock, true, self), {
      stdio: 'inherit',
      env: environment,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  const notify = (...what: string[]) => {
    if (process.env.NOTIFY_SOCKET)
      spawnSync('systemd-notify', what, { stdio: 'ignore', timeout: answerWithin });
  };
  notify('--ready', '--status=Checking for a release');
  const child = spawn('flock', lockArguments(lock, false, self), {
    stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
    env: { ...environment, [beatEnvironment]: '3' },
  });
  const life = liveness(config.hungAfter, Date.now());
  (child.stdio[3] as NodeJS.ReadableStream).on('data', () => life.beat(Date.now()));
  let said = false;
  const watch = setInterval(
    () => {
      const now = Date.now();
      life.sample(now, ownWork());
      if (life.alive(now)) return notify('WATCHDOG=1');
      if (said) return;
      said = true;
      console.log(
        `This check neither ran nor had a command of its own work for ${seconds(life.idle(now))}: it is hung. Its watchdog is no longer answered, so systemd ends it, and the next check goes on from the state.`,
      );
    },
    Math.min(30_000, config.hungAfter / 4),
  );
  const status = await new Promise<number>((done, failed) => {
    child.on('error', failed);
    child.on('close', (code) => done(code ?? 1));
  }).finally(() => clearInterval(watch));
  if (status !== lockHeld) return status;
  console.log('A deployment holds the lock; this check is skipped.');
  return 0;
}

async function main(argv: string[]) {
  const config = readConfig();
  const [command = 'check', ...rest] = argv;
  const usage = 'Usage: node update.ts [check | retry | trust <tauri.conf.json> [--replace]]';
  if (!['check', 'retry', 'trust'].includes(command) || (command === 'trust' && !rest[0]))
    throw new Error(usage);
  if (process.env[lockEnvironment] !== 'held') {
    process.exitCode = await locked(config, argv);
    return;
  }
  // The check's own code runs: said to the process that answers the unit's watchdog.
  const pipe = Number(process.env[beatEnvironment]);
  if (pipe) {
    const beat = () => {
      try {
        writeSync(pipe, '.');
      } catch {
        // Nobody listens.
      }
    };
    beat();
    setInterval(beat, 10_000).unref();
  }
  const system = createSystem(config);
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
  throw new Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
