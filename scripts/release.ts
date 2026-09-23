// Release tooling for signed desktop updates. See docs/UPDATES.md.
//
//   node scripts/release.ts version                 Print the app version; fail if files disagree.
//   node scripts/release.ts version <x.y.z|patch|minor|major>
//                                                   Set the version in every manifest.
//   node scripts/release.ts assets --input <dir> --output <dir> --repo <owner/name> [--notes <file>]
//                                                   Verify built packages and stage release assets
//                                                   with the updater's latest.json.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

type VersionFile = {
  path: string;
  // Each pattern captures the text before and after the version it replaces.
  patterns: RegExp[];
};

// Replace only the application's own entries, keeping each file's formatting.
const versionFiles: VersionFile[] = [
  { path: 'package.json', patterns: [/^(  "version": ")[^"]+(")/m] },
  {
    path: 'package-lock.json',
    patterns: [
      /^(  "version": ")[^"]+(")/m,
      /("packages": \{\s*"": \{\s*"name": "agent-studio",\s*"version": ")[^"]+(")/,
    ],
  },
  { path: 'src-tauri/tauri.conf.json', patterns: [/^(  "version": ")[^"]+(")/m] },
  {
    path: 'src-tauri/Cargo.toml',
    patterns: [/^(\[package\]\r?\n(?:.*\r?\n)*?version = ")[^"]+(")/m],
  },
  {
    path: 'src-tauri/Cargo.lock',
    patterns: [/(\[\[package\]\]\r?\nname = "agent-studio"\r?\nversion = ")[^"]+(")/],
  },
];

/** MSI packages accept only numeric versions within these bounds. */
export function validVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return !!match && +match[1] <= 255 && +match[2] <= 255 && +match[3] <= 65535;
}

export function nextVersion(current: string, request: string): string {
  if (!validVersion(current)) throw new Error(`The current version ${current} is not x.y.z.`);
  const [major, minor, patch] = current.split('.').map(Number);
  const next =
    request === 'major'
      ? `${major + 1}.0.0`
      : request === 'minor'
        ? `${major}.${minor + 1}.0`
        : request === 'patch'
          ? `${major}.${minor}.${patch + 1}`
          : request;
  if (!validVersion(next))
    throw new Error(`Use x.y.z (at most 255.255.65535), patch, minor, or major, not ${request}.`);
  if (compareVersions(next, current) <= 0)
    throw new Error(`The new version ${next} must be greater than ${current}.`);
  return next;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

/** Every manifest's application version; a mismatch means a partial bump. */
export function readVersions(root: string): Record<string, string[]> {
  return Object.fromEntries(
    versionFiles.map(({ path, patterns }) => {
      const text = readFileSync(join(root, path), 'utf8');
      return [
        path,
        patterns.map((pattern) => {
          const match = pattern.exec(text);
          if (!match) throw new Error(`Cannot find the app version in ${path}.`);
          return match[0].slice(match[1].length, match[0].length - match[2].length);
        }),
      ];
    }),
  );
}

export function currentVersion(root: string): string {
  const versions = [...new Set(Object.values(readVersions(root)).flat())];
  if (versions.length !== 1)
    throw new Error(
      `App versions disagree: ${JSON.stringify(readVersions(root))}. Run npm run release:version -- <x.y.z>.`,
    );
  return versions[0];
}

export function setVersion(root: string, version: string): void {
  if (!validVersion(version)) throw new Error(`Invalid version ${version}.`);
  // Read everything first so a missing entry changes nothing.
  const updated = versionFiles.map(({ path, patterns }) => {
    let text = readFileSync(join(root, path), 'utf8');
    for (const pattern of patterns) {
      if (!pattern.test(text)) throw new Error(`Cannot find the app version in ${path}.`);
      text = text.replace(pattern, (_, before: string, after: string) => before + version + after);
    }
    return [path, text] as const;
  });
  for (const [path, text] of updated) writeFileSync(join(root, path), text);
}

const ed25519Prefix = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verifies a Tauri updater signature (minisign, as produced by `tauri build`) against the
 * configured public key, including the trusted comment, and returns its signed fields.
 */
export function verifySignature(
  data: Buffer,
  signature: string,
  publicKey: string,
): Record<string, string> {
  const keyLines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? '', 'base64');
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  const box = Buffer.from(lines[1] ?? '', 'base64');
  const comment = lines[2]?.startsWith('trusted comment: ')
    ? lines[2].slice('trusted comment: '.length)
    : undefined;
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed')
    throw new Error('The updater public key is not a minisign Ed25519 key.');
  if (box.length !== 74 || comment === undefined || global.length !== 64)
    throw new Error('The signature is not a minisign signature.');
  const algorithm = box.subarray(0, 2).toString();
  if (algorithm !== 'Ed' && algorithm !== 'ED')
    throw new Error('The signature uses an unknown algorithm.');
  if (!box.subarray(2, 10).equals(key.subarray(2, 10)))
    throw new Error('The package was signed with a different key than the app trusts.');
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([ed25519Prefix, key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const bytes = box.subarray(10);
  if (!verify(null, message, publicKeyObject, bytes))
    throw new Error('The package signature does not match its contents.');
  if (!verify(null, Buffer.concat([bytes, Buffer.from(comment)]), publicKeyObject, global))
    throw new Error('The signature’s trusted comment was modified.');
  return Object.fromEntries(
    comment.split('\t').map((field) => {
      const separator = field.indexOf(':');
      return [field.slice(0, separator), field.slice(separator + 1)];
    }),
  );
}

type Kind = 'nsis' | 'msi' | 'appimage' | 'deb' | 'dmg' | 'app';
// Built package names and the updater manifest keys each one serves.
const kinds: { kind: Kind; pattern: RegExp; asset: (v: string) => string; targets: string[] }[] = [
  {
    kind: 'nsis',
    pattern: /_x64-setup\.exe$/,
    asset: (v) => `Agent-Studio_${v}_x64-setup.exe`,
    targets: ['windows-x86_64', 'windows-x86_64-nsis'],
  },
  {
    kind: 'msi',
    pattern: /_x64_en-US\.msi$/,
    asset: (v) => `Agent-Studio_${v}_x64_en-US.msi`,
    targets: ['windows-x86_64-msi'],
  },
  {
    // Distribution packages cannot replace themselves, so only the AppImage updates on Linux.
    kind: 'appimage',
    pattern: /_amd64\.AppImage$/,
    asset: (v) => `Agent-Studio_${v}_amd64.AppImage`,
    targets: ['linux-x86_64-appimage'],
  },
  {
    kind: 'deb',
    pattern: /_amd64\.deb$/,
    asset: (v) => `Agent-Studio_${v}_amd64.deb`,
    targets: [],
  },
  {
    kind: 'dmg',
    pattern: /_universal\.dmg$/,
    asset: (v) => `Agent-Studio_${v}_universal.dmg`,
    targets: [],
  },
  {
    // The universal archive serves both Mac architectures.
    kind: 'app',
    pattern: /\.app\.tar\.gz$/,
    asset: (v) => `Agent-Studio_${v}_universal.app.tar.gz`,
    targets: ['darwin-x86_64', 'darwin-x86_64-app', 'darwin-aarch64', 'darwin-aarch64-app'],
  },
];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

export type Manifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

/**
 * Finds each platform package under `input`, verifies updater signatures and their signed
 * version, and copies the release assets and latest.json into `output`.
 */
export function stageAssets(options: {
  input: string;
  output: string;
  repo: string;
  version: string;
  publicKey: string;
  notes: string;
  date?: Date;
}): Manifest {
  const { input, output, repo, version, publicKey } = options;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repository ${repo}.`);
  if (!validVersion(version)) throw new Error(`Invalid version ${version}.`);
  const found = files(input);
  const manifest: Manifest = {
    version,
    notes: options.notes.trim().slice(0, 4000),
    pub_date: (options.date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {},
  };
  const staged: [string, string][] = [];
  for (const { kind, pattern, asset, targets } of kinds) {
    const matches = found.filter((path) => pattern.test(basename(path)));
    if (matches.length !== 1)
      throw new Error(`Expected one ${kind} package, found ${matches.length}.`);
    const [path] = matches;
    const name = asset(version);
    staged.push([path, name]);
    if (!targets.length) continue;
    const signature = readFileSync(`${path}.sig`, 'utf8').trim();
    const signed = verifySignature(readFileSync(path), signature, publicKey);
    // The app requires the signed version to match the version this manifest announces.
    if (signed.version !== version)
      throw new Error(`The ${kind} package was signed for ${signed.version ?? 'no version'}.`);
    staged.push([`${path}.sig`, `${name}.sig`]);
    const url = `https://github.com/${repo}/releases/download/v${version}/${name}`;
    for (const target of targets) manifest.platforms[target] = { signature, url };
  }
  mkdirSync(output, { recursive: true });
  for (const [source, name] of staged) copyFileSync(source, join(output, name));
  writeFileSync(join(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main(argv: string[]) {
  const root = resolve(import.meta.dirname, '..');
  const [command, ...rest] = argv;
  if (command === 'version') {
    const current = currentVersion(root);
    if (!rest[0]) return console.log(current);
    const next = nextVersion(current, rest[0]);
    setVersion(root, next);
    return console.log(next);
  }
  if (command === 'assets') {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        repo: { type: 'string' },
        notes: { type: 'string' },
      },
    });
    if (!values.input || !values.output || !values.repo)
      throw new Error('Pass --input, --output, and --repo.');
    const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    const manifest = stageAssets({
      input: values.input,
      output: values.output,
      repo: values.repo,
      version: currentVersion(root),
      publicKey: config.plugins.updater.pubkey,
      notes: values.notes ? readFileSync(values.notes, 'utf8') : '',
    });
    return console.log(`Staged ${Object.keys(manifest.platforms).length} updater targets.`);
  }
  throw new Error('Usage: node scripts/release.ts version [x.y.z|patch|minor|major] | assets …');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
