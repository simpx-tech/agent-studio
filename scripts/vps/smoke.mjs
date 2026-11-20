// End-to-end check of the automatic VPS updater (scripts/vps/update.ts) on the production
// server, using an isolated relay instance and a local stand-in for GitHub. Production releases,
// data, services and downloads are only read. See docs/DEPLOYMENT.md.
//
//   node scripts/vps/smoke.mjs [--host agent-studio-vps] [--appimage <Linux AppImage>]
//
// Packages the committed HEAD, uploads it with this script, and runs the scenarios remotely as
// root: install a signed release, wait for a running reply and for a relay that needs 45 seconds
// to listen, refuse a release whose relay cannot read a copy of the data without touching the
// relay, roll back a release that ends once it is the service, accept a relay whose answers take
// seconds, start a release once more when the one before it no longer starts, refuse an
// untrusted installer and ignore a downgrade. Updaters are killed while a trial runs and right
// after a release was selected, and the next check must clear up and take nothing for done. The
// QA relay's environment file names its data folder, which a trial must not follow. Every check
// runs under the settings of the updater's own unit file (no deadline, a watchdog), and takes
// the deployment lock itself. On three gigabytes of data, updaters are killed while the backup
// is archived, while it is compressed and while it is put back; a backup cut short is refused
// with the data left alone; a relay and a host that an updater started and could not record are
// watched on, their processes unchanged; a check skips its run and a retry waits while the lock
// is held; and an updater that hangs is ended by its watchdog. The first release is built from
// source; the others are that build with another relay/start.ts. Each release also runs as
// the server's host (agent-studio-qa-host.service): a stand-in AppImage that only stays up, or,
// with --appimage, a real build of the app for the first release, which must pair with the QA
// relay as a server and list a folder for another device. A host that does not stay up goes
// back to the previous one. Everything it creates is removed afterwards, except the updater's
// build account and npm cache.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const runtime = '/opt/agent-studio/runtimes/node-v24.20.0-linux-x64/bin/node';
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout ?? '';
}

function local() {
  const host = option('--host') ?? 'agent-studio-vps';
  const root = resolve(import.meta.dirname, '../..');
  if (sh('git', ['-C', root, 'status', '--porcelain', '--', 'scripts', 'src']).trim())
    console.warn('Uncommitted changes under scripts/ or src/ are not part of this check.');
  const scratch = mkdtempSync(join(tmpdir(), 'agent-studio-update-qa-'));
  const archive = join(scratch, 'source.tar.gz');
  // One top-level directory, like GitHub's source tarballs.
  const prefix = '--prefix=agent-studio/';
  sh('git', ['-C', root, 'archive', '--format=tar.gz', prefix, '-o', archive, 'HEAD']);
  const upload = '/root/agent-studio-update-qa';
  const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  sh('ssh', [...ssh, host, `rm -rf ${upload} && install -d -m 0700 ${upload}`]);
  const appImage = option('--appimage');
  for (const [file, name] of [
    [archive, 'source.tar.gz'],
    [import.meta.filename, 'smoke.mjs'],
    ...(appImage ? [[appImage, 'host.AppImage']] : []),
  ])
    sh('ssh', [...ssh, host, `cat > ${upload}/${name}`], {
      input: readFileSync(file),
      maxBuffer: 1024 * 1024 * 1024,
    });
  rmSync(scratch, { recursive: true, force: true });
  const result = spawnSync(
    'ssh',
    [...ssh, host, `${runtime} ${upload}/smoke.mjs --remote ${upload}`],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const lines = (result.stdout ?? '').trimEnd().split('\n');
  const summary = lines.findLast((line) => line.startsWith('RESULT '));
  for (const line of lines) if (line !== summary) console.log(line);
  if (summary) {
    const output = join(root, 'artifacts', 'vps-update-qa');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'result.json'),
      `${JSON.stringify(JSON.parse(summary.slice(7)), null, 2)}\n`,
    );
    console.log(`Result: ${join(output, 'result.json')}`);
  }
  process.exitCode = result.status === 0 && summary ? 0 : 1;
}

// A minisign signer in the Tauri CLI's prehashed format, with a throwaway key.
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
  ).toString('base64');
  const signData = (data, version) => {
    const comment = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:setup.exe\tversion:${version}`;
    const bytes = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const global = sign(null, Buffer.concat([bytes, Buffer.from(comment)]), privateKey);
    const box = Buffer.concat([Buffer.from('ED'), id, bytes]).toString('base64');
    return Buffer.from(
      `untrusted comment: signature\n${box}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
    ).toString('base64');
  };
  return { key, signData };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// A stand-in AppImage: it unpacks an app that answers as a server and then stays up, or exits.
const fakeAppImage = (stays) =>
  Buffer.from(`#!/bin/sh
if [ "$1" = "--appimage-extract" ]; then
  mkdir -p squashfs-root
  printf '%s\\n' '#!/bin/sh' 'if [ "$1" = "--server-check" ]; then echo "agent-studio-server 1"; exit 0; fi' '${stays ? 'exec sleep infinity' : 'exit 3'}' > squashfs-root/AppRun
  chmod 755 squashfs-root/AppRun
  exit 0
fi
exit 1
`);

async function remote(upload) {
  const qa = {
    root: '/opt/agent-studio-qa',
    data: '/var/lib/agent-studio-qa',
    backups: '/var/backups/agent-studio-qa',
    state: '/var/lib/agent-studio-update-qa',
    service: 'agent-studio-qa',
    user: 'agent-studio-qa',
    port: 4399,
    apiPort: 4398,
    hostService: 'agent-studio-qa-host',
    hostUser: 'agent-studio-qa-host',
    hostHome: '/var/lib/agent-studio-qa-host',
    // Another device of the QA workspace, which asks the host for work.
    viewer: crypto.randomUUID(),
  };
  const relayEnv = join(qa.root, 'relay.env');
  const moreEnv = join(qa.root, 'relay-more.env');
  const hostKey = join(qa.state, 'host.key');
  const hostUnit = `/etc/systemd/system/${qa.hostService}.service`;
  const token = randomBytes(32).toString('hex');
  const realHost = existsSync(join(upload, 'host.AppImage'))
    ? readFileSync(join(upload, 'host.AppImage'))
    : undefined;
  const unit = `/etc/systemd/system/${qa.service}.service`;
  const work = join(qa.root, 'work');
  const logFile = join(upload, 'updater.log');
  const result = { started: new Date().toISOString(), checks: [], ok: false };
  const passed = (name, detail) => {
    result.checks.push({ name, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  };
  const expect = (condition, text) => {
    if (!condition) throw new Error(text);
  };
  const status = async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      return response.status;
    } catch {
      return undefined;
    }
  };
  const active = (service) =>
    spawnSync('systemctl', ['is-active', '--quiet', service]).status === 0;
  const pids = () =>
    sh('systemctl', [
      'show',
      'agent-studio',
      'caddy',
      'deck-server',
      'minecraft',
      'atm10sky',
      '-p',
      'Id',
      '-p',
      'MainPID',
    ]);
  const productionBefore = {
    current: realpathSync('/opt/agent-studio/current'),
    pids: pids(),
    host: spawnSync('systemctl', ['is-active', '--quiet', 'agent-studio-host']).status === 0,
  };
  let createdUser = false;
  let createdHostUser = false;
  let server;

  const qaKey = signer();
  const otherKey = signer();
  const commit = {
    '9.0.0': 'a0',
    '9.0.1': 'b1',
    '9.0.2': 'c2',
    '9.0.3': 'd3',
    '9.0.4': 'f5',
    '9.0.5': 'a6',
    '9.0.6': 'b7',
    '9.0.7': 'c8',
    '9.0.8': 'd9',
    '9.0.9': 'a9',
    '9.1.0': 'b0',
    '9.1.1': 'c1',
    '9.1.2': 'd2',
    '9.1.3': 'f3',
    '8.0.0': 'e4',
  };
  // Something a relay can write that outlives a restored data folder.
  const secondStart = '/dev/shm/agent-studio-qa-second-start';
  const trialService = `${qa.service}-trial`;
  for (const version of Object.keys(commit)) commit[version] = commit[version].repeat(20);
  const releases = new Map();
  let latest;
  const requests = [];

  try {
    // An isolated relay instance that starts from a copy of the production release.
    for (const path of [qa.root, qa.data, qa.backups, qa.state, unit, hostUnit, qa.hostHome])
      expect(!existsSync(path), `${path} already exists; remove the previous QA run first.`);
    sh('install', [
      '-d',
      '-m',
      '0755',
      qa.root,
      join(qa.root, 'releases'),
      join(qa.root, 'downloads'),
    ]);
    sh('install', ['-d', '-m', '0700', work]);
    sh('tar', ['-xzf', join(upload, 'source.tar.gz'), '-C', work]);
    const source = join(work, 'agent-studio');
    const updater = join(qa.root, 'updater');
    sh('install', ['-d', '-m', '0755', updater, join(updater, 'vps')]);
    copyFileSync(join(source, 'scripts', 'release.ts'), join(updater, 'release.ts'));
    copyFileSync(join(source, 'scripts', 'vps', 'update.ts'), join(updater, 'vps', 'update.ts'));
    copyFileSync(
      join(source, 'scripts', 'vps', 'state-file.ts'),
      join(updater, 'vps', 'state-file.ts'),
    );
    writeFileSync(join(updater, 'package.json'), '{ "type": "module" }\n');
    sh('chmod', ['-R', 'u=rwX,go=rX', updater]);
    if (spawnSync('id', ['agent-studio-build']).status !== 0)
      sh('useradd', [
        '--system',
        '--user-group',
        '--home-dir',
        '/var/cache/agent-studio-build',
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        'agent-studio-build',
      ]);
    sh('install', [
      '-d',
      '-o',
      'agent-studio-build',
      '-g',
      'agent-studio-build',
      '-m',
      '0700',
      '/var/cache/agent-studio-build',
    ]);
    if (spawnSync('id', [qa.user]).status !== 0) {
      sh('useradd', [
        '--system',
        '--user-group',
        '--home-dir',
        qa.data,
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        qa.user,
      ]);
      createdUser = true;
    }
    sh('install', ['-d', '-o', qa.user, '-g', qa.user, '-m', '0700', qa.data]);
    // The host's account, with stand-ins for the CLIs the updater would otherwise install.
    if (spawnSync('id', [qa.hostUser]).status !== 0) {
      sh('useradd', [
        '--system',
        '--user-group',
        '--create-home',
        '--home-dir',
        qa.hostHome,
        '--shell',
        '/bin/bash',
        qa.hostUser,
      ]);
      createdHostUser = true;
    }
    mkdirSync(join(qa.hostHome, '.local', 'bin'), { recursive: true });
    for (const cli of ['claude', 'codex']) {
      const stub = join(qa.hostHome, '.local', 'bin', cli);
      writeFileSync(stub, `#!/bin/sh\necho "0.0.0 (${cli} QA stand-in)"\n`);
      chmodSync(stub, 0o755);
    }
    sh('chown', ['-R', `${qa.hostUser}:${qa.hostUser}`, qa.hostHome]);
    // Like a production file may, it names the data folder and the port: systemd lets it
    // override the unit's Environment=, and a trial must read its copy all the same.
    writeFileSync(
      relayEnv,
      `AGENT_STUDIO_RELAY_TOKEN=${token}\nAGENT_STUDIO_RELAY_DATA=${qa.data}\nAGENT_STUDIO_RELAY_PORT=${qa.port}\n`,
      { mode: 0o600 },
    );
    // A second file, which may be missing, with a quoted value.
    writeFileSync(moreEnv, 'QA_QUOTED="two words"\n', { mode: 0o600 });
    writeFileSync(join(qa.data, 'qa-marker.txt'), 'original data');
    mkdirSync(join(qa.data, '.npm'));
    writeFileSync(join(qa.data, '.npm', 'cache.txt'), 'npm cache');
    sh('chown', ['-R', `${qa.user}:${qa.user}`, qa.data]);
    const initial = basename(productionBefore.current);
    sh('cp', ['-a', productionBefore.current, join(qa.root, 'releases', initial)]);
    symlinkSync(join(qa.root, 'releases', initial), join(qa.root, 'current'));
    writeFileSync(
      join(qa.root, 'downloads', 'agent-studio-windows-x64-setup.exe'),
      'previous installer',
    );
    chmodSync(join(qa.root, 'downloads', 'agent-studio-windows-x64-setup.exe'), 0o644);
    writeFileSync(
      unit,
      `[Unit]
Description=Agent Studio updater QA relay (temporary)

[Service]
Type=simple
User=${qa.user}
Group=${qa.user}
WorkingDirectory=${qa.root}/current
EnvironmentFile=${relayEnv}
EnvironmentFile=-${moreEnv}
EnvironmentFile=-${qa.root}/relay-missing.env
Environment=NODE_ENV=production
Environment="QA_SPACED=a b"
Environment=NODE_OPTIONS=--max-old-space-size=32768
Environment=AGENT_STUDIO_RELAY_HOST=127.0.0.1
Environment=AGENT_STUDIO_RELAY_PORT=${qa.port}
Environment=AGENT_STUDIO_RELAY_DATA=${qa.data}
Environment=AGENT_STUDIO_WEB_DIR=${qa.root}/current/build
Environment=AGENT_STUDIO_DOWNLOADS_DIR=${qa.root}/downloads
ExecStart=${runtime} relay/start.ts
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${qa.data}
TasksMax=infinity
`,
      { mode: 0o600 },
    );
    sh('systemctl', ['daemon-reload']);
    sh('systemctl', ['start', qa.service]);
    for (
      let attempt = 0;
      attempt < 30 && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) !== 401;
      attempt++
    )
      await new Promise((done) => setTimeout(done, 1000));
    expect(
      (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'QA relay did not start.',
    );
    passed('isolated relay started from a copy of the production release', initial);

    rmSync(secondStart, { force: true });
    // The release source: the committed tree trusting the QA key.
    const variant = (name, change) => {
      const parent = join(work, `variant-${name}`);
      mkdirSync(parent);
      sh('cp', ['-a', source, join(parent, 'agent-studio')]);
      const config = join(parent, 'agent-studio', 'src-tauri', 'tauri.conf.json');
      const parsed = JSON.parse(readFileSync(config, 'utf8'));
      parsed.plugins.updater.pubkey = qaKey.key;
      writeFileSync(config, JSON.stringify(parsed, null, 2));
      change?.(join(parent, 'agent-studio'));
      const archive = join(work, `${name}.tar.gz`);
      sh('tar', ['-czf', archive, '-C', parent, 'agent-studio']);
      return readFileSync(archive);
    };
    const good = variant('good');
    // Relays that behave otherwise: the first release's build with a start.ts that does
    // something before, instead of or after starting the relay (relay-start.ts, the original).
    const onTrial = "/-trial$/.test(process.env.AGENT_STUDIO_RELAY_DATA ?? '')";
    // Every one of them first requires the service's environment, values with spaces included,
    // from its Environment= and from both of its files, as the service and in a trial.
    const environment = `if (process.env.QA_QUOTED !== 'two words' || process.env.QA_SPACED !== 'a b' || !process.env.AGENT_STUDIO_RELAY_TOKEN) {
  console.error('Error: QA relay lacks the environment of its service');
  process.exit(4);
}
`;
    const relays = {
      // Starts as it is.
      plain: `await import('./relay-start.ts');
`,
      // Serves a copy of the data; as the service it works for 40 seconds and then ends, every
      // time: a release an updater selected and never checked.
      dyingLate: `if (!${onTrial}) {
  for (const until = Date.now() + 40_000; Date.now() < until; );
  console.error('Error: QA relay ends after working for a while');
  process.exit(3);
}
await import('./relay-start.ts');
`,
      // Works for 45 seconds before it listens, as a relay reading a large state does.
      // In a trial it also writes into the data it was given, which must be the copy.
      slow: `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (${onTrial}) writeFileSync(join(process.env.AGENT_STUDIO_RELAY_DATA, 'qa-trial-wrote'), '');
for (const until = Date.now() + 45_000; Date.now() < until; );
await import('./relay-start.ts');
`,
      // Ends at once, wherever it runs.
      broken: `console.error('Error: QA relay cannot read this data');
process.exit(3);
`,
      // Serves a copy of the data, and ends at once as the service.
      liveBroken: `if (!${onTrial}) {
  console.error('Error: QA relay ends as the service');
  process.exit(3);
}
await import('./relay-start.ts');
`,
      // Starts once on its data and never again, as a release whose data outgrew it. Once up,
      // it holds its event loop for eight of every ten seconds, as saves of a large state do.
      stallingOnce: `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mark = join(process.env.AGENT_STUDIO_RELAY_DATA ?? '', 'qa-started-once');
if (existsSync(mark)) {
  // It writes to its data before it ends: what the release that is started after it must not
  // run on.
  writeFileSync(join(process.env.AGENT_STUDIO_RELAY_DATA ?? '', 'qa-wrote-before-failing'), '');
  console.error('Error: QA relay cannot read its data a second time');
  process.exit(3);
}
writeFileSync(mark, '');
await import('./relay-start.ts');
const until = Date.now() + 90_000;
const hold = () => {
  if (Date.now() > until) return;
  for (const end = Date.now() + 8000; Date.now() < end; );
  setTimeout(hold, 2000);
};
setTimeout(hold, 2000);
`,
      // Ends the first time it is the service, and runs from its second start on.
      secondStart: `import { existsSync, writeFileSync } from 'node:fs';
if (!${onTrial} && !existsSync('${secondStart}')) {
  writeFileSync('${secondStart}', '');
  console.error('Error: QA relay ends the first time it starts');
  process.exit(3);
}
await import('./relay-start.ts');
`,
    };
    // Stages a release as the updater would have built it: the first release's build, root-owned.
    const prepare = (version, relay) => {
      const target = join(qa.root, 'releases', commit[version]);
      sh('cp', ['-a', join(qa.root, 'releases', commit['9.0.0']), target]);
      copyFileSync(join(target, 'relay', 'start.ts'), join(target, 'relay', 'relay-start.ts'));
      writeFileSync(join(target, 'relay', 'start.ts'), environment + relays[relay]);
      sh('chmod', [
        '0644',
        join(target, 'relay', 'start.ts'),
        join(target, 'relay', 'relay-start.ts'),
      ]);
    };
    const relayPid = () => sh('systemctl', ['show', qa.service, '-p', 'MainPID', '--value']).trim();
    const trustFile = join(work, 'trust.json');
    writeFileSync(trustFile, JSON.stringify({ plugins: { updater: { pubkey: qaKey.key } } }));
    for (const [version, tarball, key, appImage] of [
      ['9.0.0', good, qaKey, realHost ?? fakeAppImage(true)],
      ['9.0.1', good, qaKey, fakeAppImage(true)],
      ['9.0.2', good, qaKey, fakeAppImage(true)],
      ['9.0.3', good, qaKey, fakeAppImage(true)],
      ['9.0.4', good, otherKey, fakeAppImage(true)],
      ['9.0.5', good, qaKey, fakeAppImage(false)],
      ['9.0.6', good, qaKey, fakeAppImage(true)],
      ['9.0.7', good, qaKey, fakeAppImage(true)],
      ['9.0.8', good, qaKey, fakeAppImage(true)],
      ['9.0.9', good, qaKey, fakeAppImage(true)],
      ['9.1.0', good, qaKey, fakeAppImage(true)],
      ['9.1.1', good, qaKey, fakeAppImage(true)],
      ['9.1.2', good, qaKey, fakeAppImage(true)],
      ['9.1.3', good, qaKey, fakeAppImage(true)],
      ['8.0.0', good, qaKey, fakeAppImage(true)],
    ]) {
      const installer = randomBytes(512 * 1024);
      releases.set(version, {
        tarball,
        installer,
        signature: Buffer.from(key.signData(installer, version)),
        appImage,
        appImageSignature: Buffer.from(key.signData(appImage, version)),
      });
    }
    const assetName = (version) => `Agent-Studio_${version}_x64-setup.exe`;
    const appImageName = (version) => `Agent-Studio_${version}_amd64.AppImage`;
    const releaseOf = (version) => {
      const { installer, signature, appImage, appImageSignature } = releases.get(version);
      const name = assetName(version);
      const image = appImageName(version);
      return JSON.stringify({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name,
            size: installer.length,
            digest: `sha256:${sha256(installer)}`,
            browser_download_url: `${origin}/assets/${name}`,
          },
          {
            name: `${name}.sig`,
            size: signature.length,
            browser_download_url: `${origin}/assets/${name}.sig`,
          },
          {
            name: image,
            size: appImage.length,
            digest: `sha256:${sha256(appImage)}`,
            browser_download_url: `${origin}/assets/${image}`,
          },
          {
            name: `${image}.sig`,
            size: appImageSignature.length,
            browser_download_url: `${origin}/assets/${image}.sig`,
          },
        ],
      });
    };
    const origin = `http://127.0.0.1:${qa.apiPort}`;
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', origin).pathname;
      requests.push(path);
      const send = (code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(body);
      };
      let match;
      if (path === '/repos/qa/agent-studio/releases/latest')
        return latest ? send(200, releaseOf(latest)) : send(404, '{"message":"Not Found"}');
      if ((match = /^\/repos\/qa\/agent-studio\/releases\/tags\/v([\d.]+)$/.exec(path)))
        return releases.has(match[1]) ? send(200, releaseOf(match[1])) : send(404, '{}');
      if ((match = /^\/assets\/Agent-Studio_([\d.]+)_amd64\.AppImage(\.sig)?$/.exec(path))) {
        const release = releases.get(match[1]);
        if (!release) return send(404, '{}');
        return send(
          200,
          match[2] ? release.appImageSignature : release.appImage,
          'application/octet-stream',
        );
      }
      if ((match = /^\/repos\/qa\/agent-studio\/commits\/v([\d.]+)$/.exec(path)))
        return commit[match[1]] ? send(200, commit[match[1]], 'text/plain') : send(404, '{}');
      if ((match = /^\/repos\/qa\/agent-studio\/tarball\/([0-9a-f]{40})$/.exec(path))) {
        const version = Object.keys(commit).find((key) => commit[key] === match[1]);
        return version
          ? send(200, releases.get(version).tarball, 'application/gzip')
          : send(404, '{}');
      }
      if ((match = /^\/assets\/Agent-Studio_([\d.]+)_x64-setup\.exe(\.sig)?$/.exec(path))) {
        const release = releases.get(match[1]);
        if (!release) return send(404, '{}');
        return send(
          200,
          match[2] ? release.signature : release.installer,
          'application/octet-stream',
        );
      }
      send(404, '{}');
    });
    await new Promise((done) => server.listen(qa.apiPort, '127.0.0.1', done));

    // Run the updater the way its systemd unit does, pointed at the QA instance: a check under
    // every setting of the unit file install.sh installs, but for the program it runs. It must
    // run asynchronously so this process keeps answering as GitHub.
    const unitFile = readFileSync(
      join(source, 'scripts', 'vps', 'agent-studio-update.service'),
      'utf8',
    );
    const unitSettings = unitFile
      .slice(unitFile.indexOf('[Service]'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Za-z]*=/.test(line) && !line.startsWith('ExecStart='));
    for (const setting of ['Type=notify', 'NotifyAccess=all', 'TimeoutStartSec=infinity'])
      expect(unitSettings.includes(setting), `the updater's unit lacks ${setting}`);
    expect(
      unitSettings.some((line) => line.startsWith('WatchdogSec=')) &&
        !unitSettings.some((line) => /^(RuntimeMaxSec|TimeoutSec)=/.test(line)),
      "the updater's unit has a deadline, or no watchdog",
    );
    // What a scenario changes of them, and of the updater's settings.
    let unitChanges = { env: {}, properties: [] };
    let launched = 0;
    const launch = (...args) => {
      const name = `${qa.service}-update-${++launched}`;
      // retry and trust are run from a shell, which is not a unit that reports its start.
      const settings =
        args[0] === 'check'
          ? [...unitSettings, ...unitChanges.properties]
          : [
              'Type=exec',
              ...unitSettings.filter((line) => /^(UMask|Protect|Private|NoNew)/.test(line)),
            ];
      const env = {
        ...unitChanges.env,
        API: origin,
        REPO: 'qa/agent-studio',
        ROOT: qa.root,
        DATA: qa.data,
        BACKUPS: qa.backups,
        STATE: qa.state,
        SERVICE: qa.service,
        PORT: String(qa.port),
        HOST_USER: qa.hostUser,
        HOST_SERVICE: qa.hostService,
        HOST_NAME: 'QA server',
        HOST_KEY: hostKey,
        RELAY_ENV: relayEnv,
      };
      const child = spawn('systemd-run', [
        '--quiet',
        `--unit=${name}`,
        '--wait',
        '--pipe',
        '--collect',
        ...settings.map((setting) => `--property=${setting}`),
        ...Object.entries(env).map(
          ([name, value]) => `--setenv=AGENT_STUDIO_UPDATE_${name}=${value}`,
        ),
        '--',
        runtime,
        join(updater, 'vps', 'update.ts'),
        ...args,
      ]);
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const closed = new Promise((done) => child.on('close', done));
      return { name, args, closed, output: () => output };
    };
    const update = async (...args) => finish(launch(...args));
    const finish = async (launched) => {
      const { args } = launched;
      const run = { status: await launched.closed };
      const output = launched.output();
      appendFileSync(logFile, `\n$ update.ts ${args.join(' ')} (exit ${run.status})\n${output}`);
      // Only the updater's own messages; build tools print their own progress.
      const messages = output
        .split('\n')
        .filter((line) =>
          /^(Found|Building|Staged|Waiting|Trying|Activat|Published|Not installing|Ignoring|Could not|Trusting|v\d|[0-9a-f]{40} |No |The |Extracting|Installing|Created|Starting|An updater|A trial|A check|A deployment|This check|Nothing)/.test(
            line,
          ),
        );
      console.log(`update.ts ${args.join(' ')} → exit ${run.status}\n  ${messages.join('\n  ')}`);
      return { status: run.status, output, messages };
    };
    const state = () => JSON.parse(readFileSync(join(qa.state, 'state.json'), 'utf8'));
    const trialCopy = `/var/lib/.${basename(qa.data)}-trial`;
    const settle = (ms) => new Promise((done) => setTimeout(done, ms));
    // Starts a check and kills its updater, as the kernel or a timeout would, once `when` holds.
    const killed = async (when, what, patience = 300) => {
      const check = launch('check');
      let met = false;
      for (let waited = 0; waited < patience && !met; waited++) {
        try {
          met = when();
        } catch {
          // The state is being replaced.
        }
        if (!met) await settle(100);
      }
      if (!met) {
        const run = await finish(check);
        throw new Error(`the updater never was ${what}:\n${run.output.slice(-4000)}`);
      }
      sh('systemctl', ['kill', '--signal=KILL', '--kill-whom=all', `${check.name}.service`]);
      const run = await finish(check);
      expect(run.status !== 0, `the updater killed while ${what} ended well`);
      return run;
    };
    const selected = () => basename(realpathSync(join(qa.root, 'current')));
    const hostVersion = () => {
      try {
        return basename(realpathSync(join(qa.root, 'host', 'current')));
      } catch {
        return undefined;
      }
    };
    const relay = async (method, path, body, environment = crypto.randomUUID()) => {
      const response = await fetch(`http://127.0.0.1:${qa.port}/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-environment-id': environment,
          'content-type': 'application/json',
          'x-studio-images': '1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() };
    };

    let run = await update('trust', trustFile);
    expect(run.status === 0 && state().trustedKey === qaKey.key, 'trust failed');
    run = await update('check');
    expect(run.status === 0 && run.output.trim() === '', `idle check was not quiet: ${run.output}`);
    passed('seeds the trusted key and stays quiet without a release');

    // 1. A signed release is built in the sandbox, activated and published.
    latest = '9.0.0';
    run = await update('check');
    expect(run.status === 0, `install failed:\n${run.output.slice(-4000)}`);
    for (const text of [
      'Found v9.0.0',
      'Building and testing v9.0.0',
      'Staged v9.0.0',
      'Trying v9.0.0 on a copy of the private data.',
      'v9.0.0 read the copy and listened after',
      'Activated v9.0.0',
      'Published the v9.0.0 Windows installer',
      'Staged the v9.0.0 host',
      'The host runs v9.0.0',
    ])
      expect(run.output.includes(text), `missing "${text}"`);
    const first = join(qa.root, 'releases', commit['9.0.0']);
    expect(selected() === commit['9.0.0'], 'current does not select v9.0.0');
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'relay unhealthy after install',
    );
    expect((await status(`http://127.0.0.1:${qa.port}/`)) === 200, 'web viewer not served');
    const loose = sh('find', [
      first,
      '!',
      '-type',
      'l',
      '(',
      '-perm',
      '/022',
      '-o',
      '!',
      '-user',
      'root',
      ')',
      '-print',
      '-quit',
    ]);
    expect(loose.trim() === '', `release file writable by others or not root-owned: ${loose}`);
    expect(
      existsSync(join(first, '.deployment-ready')) &&
        existsSync(join(first, 'build', 'index.html')),
      'release not built',
    );
    expect(
      statSync('/var/cache/agent-studio-build/npm').uid ===
        Number(sh('id', ['-u', 'agent-studio-build'])),
      'build did not run as agent-studio-build',
    );
    const download = join(qa.root, 'downloads', 'agent-studio-windows-x64-setup.exe');
    const { installer } = releases.get('9.0.0');
    expect(sha256(readFileSync(download)) === sha256(installer), 'installer not published');
    expect((statSync(download).mode & 0o777) === 0o644, 'installer not public');
    const served = Buffer.from(
      await (
        await fetch(`http://127.0.0.1:${qa.port}/downloads/agent-studio-windows-x64-setup.exe`)
      ).arrayBuffer(),
    );
    expect(sha256(served) === sha256(installer), 'relay serves another installer');
    const previousInstaller = join(qa.backups, `pre-${commit['9.0.0']}-windows-installer.exe`);
    expect(
      readFileSync(previousInstaller, 'utf8') === 'previous installer',
      'previous installer not kept',
    );
    const backup = join(qa.backups, `pre-${commit['9.0.0']}.tar.gz`);
    const listing = sh('tar', ['-tzf', backup]);
    expect(
      listing.includes('agent-studio-qa/qa-marker.txt') && !listing.includes('.npm'),
      'unexpected backup contents',
    );
    expect((statSync(backup).mode & 0o777) === 0o600, 'backup is not private');
    expect(
      state().release.phase === 'active' && state().release.download === 'published',
      'state not active',
    );
    expect(
      !existsSync(`/var/lib/.${basename(qa.data)}-trial`) && !active(trialService),
      'the trial or its copy of the data was left behind',
    );
    run = await update('check');
    expect(run.status === 0 && run.output.trim() === '', 'second check was not quiet');
    passed(
      'installs a signed release: sandboxed build and tests, backup, switch, health check, installer',
      {
        release: commit['9.0.0'],
      },
    );

    // The release also runs as the server's host, from its signed AppImage.
    expect(state().host?.phase === 'active', `host not active: ${JSON.stringify(state().host)}`);
    expect(hostVersion() === '9.0.0' && active(qa.hostService), 'host does not run v9.0.0');
    const hostFiles = sh('find', [
      join(qa.root, 'host', '9.0.0'),
      '!',
      '-type',
      'l',
      '(',
      '-perm',
      '/022',
      '-o',
      '!',
      '-user',
      'root',
      ')',
      '-print',
      '-quit',
    ]);
    expect(hostFiles.trim() === '', `host file writable by others or not root-owned: ${hostFiles}`);
    const unitText = readFileSync(hostUnit, 'utf8');
    for (const line of [`User=${qa.hostUser}`, `LoadCredential=relay-key:${hostKey}`])
      expect(unitText.split('\n').includes(line), `host unit lacks ${line}`);
    expect(
      readFileSync(hostKey, 'utf8').trim() === token && (statSync(hostKey).mode & 0o777) === 0o600,
      'host key is not the relay key, privately',
    );
    expect(!existsSync(`/etc/sudoers.d/${qa.hostService}`), 'host got sudo it was not given');
    if (realHost) {
      // The app pairs with the relay as a server and answers another device's request.
      let server;
      for (let attempt = 0; attempt < 90 && !server; attempt++) {
        const peers = await relay(
          'POST',
          'v1/heartbeat',
          { environmentId: qa.viewer, connections: [], running: [] },
          qa.viewer,
        );
        server = peers.body.find?.((peer) => peer.online && peer.features?.includes('server'));
        if (!server) await new Promise((done) => setTimeout(done, 2000));
      }
      expect(server, 'the host never paired with the relay as a server');
      let owned = false;
      for (let attempt = 0; attempt < 30 && !owned; attempt++) {
        const shared = await relay('GET', 'v1/state', undefined, qa.viewer);
        owned = shared.body.workspace?.fleet?.environments?.some(
          (environment) => environment.id === server.environmentId,
        );
        if (!owned) await new Promise((done) => setTimeout(done, 2000));
      }
      expect(owned, 'the host never registered its computer');
      const job = crypto.randomUUID();
      const posted = await relay(
        'POST',
        'v1/jobs',
        {
          id: job,
          source: qa.viewer,
          target: server.environmentId,
          method: 'folders',
          args: { environmentId: server.environmentId, path: '' },
        },
        qa.viewer,
      );
      expect(posted.status === 200, `folders request refused: ${JSON.stringify(posted.body)}`);
      let answer;
      for (let attempt = 0; attempt < 60; attempt++) {
        answer = (await relay('GET', `v1/jobs/${job}`, undefined, qa.viewer)).body;
        if (['complete', 'error', 'cancelled'].includes(answer.status)) break;
        await new Promise((done) => setTimeout(done, 1000));
      }
      expect(
        answer?.status === 'complete' && answer.result?.path === qa.hostHome,
        `the host did not list its home folder: ${JSON.stringify(answer)}`,
      );
      passed('the host pairs with the relay as a server and lists a folder for another device', {
        environment: server.environmentId,
        features: server.features,
      });
      // The app's own sync must not touch the checkpoints the next scenarios write.
      sh('systemctl', ['stop', qa.hostService]);
    }
    passed('runs the release as the server host from its signed AppImage, with the relay key');

    // 2. Activation waits for a running reply, and for a relay that works 45 seconds before it
    // listens: what the 30-second check of earlier updaters rolled back on 2026-11-13.
    prepare('9.0.1', 'slow');
    latest = '9.0.1';
    const checkpoint = join(qa.data, 'workspace.json');
    writeFileSync(
      checkpoint,
      JSON.stringify({ workspace: { conversations: [{ messages: [{ status: 'running' }] }] } }),
    );
    sh('chown', [`${qa.user}:${qa.user}`, checkpoint]);
    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Staged v9.0.1'),
      `staging failed:\n${run.output.slice(-4000)}`,
    );
    expect(
      run.output.includes('Waiting up to two hours before activating v9.0.1: 1 reply is running.'),
      'did not wait',
    );
    expect(selected() === commit['9.0.0'] && active(qa.service), 'relay changed while a reply ran');
    run = await update('check');
    expect(run.status === 0 && run.output.trim() === '', 'waiting was not quiet');
    rmSync(checkpoint);

    // An updater killed while its trial runs: systemd stops the trial with it, the relay is
    // untouched, and the next check removes the copy of the data before anything else.
    let pid = relayPid();
    await killed(
      () => state().release.activation?.step === 'trial' && active(trialService),
      'trying the release',
    );
    for (let waited = 0; waited < 50 && active(trialService); waited++) await settle(200);
    expect(!active(trialService), 'the trial outlived the updater that was killed');
    expect(existsSync(trialCopy), 'no copy of the data was left to clear up');
    expect(
      state().release.phase === 'staged' && state().release.activation?.step === 'trial',
      `a killed trial changed the release: ${JSON.stringify(state().release)}`,
    );
    expect(
      relayPid() === pid && selected() === commit['9.0.0'],
      'a killed trial touched the relay',
    );
    passed('a trial ends with the updater that is killed, and the relay is untouched');

    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Activated v9.0.1'),
      `activation failed:\n${run.output}`,
    );
    expect(!existsSync(trialCopy), 'the copy a killed trial left was not removed');
    expect(
      !existsSync(join(qa.data, 'qa-trial-wrote')),
      'the trial wrote into the data of the relay: its environment file sent it there',
    );
    passed(
      'a trial reads its copy although the environment file names the data folder, with the values of every file',
    );
    expect(selected() === commit['9.0.1'], 'current does not select v9.0.1');
    const slow = Number(/v9\.0\.1 read the copy and listened after (\d+) s/.exec(run.output)?.[1]);
    expect(slow >= 45, `the slow relay was not waited for:\n${run.output}`);
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'slow relay unhealthy after activation',
    );
    expect(
      run.output.includes('The host runs v9.0.1') && hostVersion() === '9.0.1',
      `host not updated:\n${run.output}`,
    );
    expect(active(qa.hostService), 'host not running v9.0.1');
    passed('waits for running replies, then activates the relay and the host');
    passed('activates a relay that listens only after 45 seconds', { listened: `${slow} s` });

    // 3. A release whose relay cannot read the data is refused on a copy: the relay never stops.
    prepare('9.0.2', 'broken');
    latest = '9.0.2';
    pid = relayPid();
    let began = Date.now();
    run = await update('check');
    let took = Date.now() - began;
    expect(run.status === 1, `broken release did not fail:\n${run.output.slice(-4000)}`);
    expect(
      run.output.includes(
        'v9.0.2 was not activated: on a copy of the private data its relay ended (exit-code 3) and its service failed before it listened; it last logged: Error: QA relay cannot read this data.',
      ) && run.output.includes(`${commit['9.0.1']} runs on and nothing changed.`),
      `no refusal message:\n${run.output.slice(-4000)}`,
    );
    expect(took < 20_000, `a relay that ends at once took ${took} ms to fail`);
    expect(relayPid() === pid && selected() === commit['9.0.1'], 'the relay was touched');
    expect(
      !existsSync(`/var/lib/.${basename(qa.data)}-trial`) && !active(trialService),
      'the failed trial or its copy of the data was left behind',
    );
    expect(
      !readdirSync(qa.backups).some((name) => name.includes(commit['9.0.2'])),
      'a refused release made a backup',
    );
    expect(state().release.phase === 'failed', 'refused release not marked failed');
    passed(
      'refuses a release whose relay ends on a copy of the data, within seconds, relay untouched',
      {
        took: `${took} ms`,
      },
    );

    // 4. A release whose relay ends in a loop as the service is rolled back with its data, as
    // soon as its service says so. The release it goes back to is the slow one.
    prepare('9.0.3', 'liveBroken');
    latest = '9.0.3';
    began = Date.now();
    run = await update('check');
    took = Date.now() - began;
    expect(run.status === 1, `broken release did not fail:\n${run.output.slice(-4000)}`);
    expect(
      !existsSync(join(qa.root, 'releases', commit['9.0.2'])),
      'superseded refused build was kept',
    );
    expect(
      run.output.includes(`v9.0.3 failed its health check; ${commit['9.0.1']} was restored.`),
      'no rollback message',
    );
    expect(
      run.output.includes(
        'Its relay ended (exit-code 3) and its service started it again before it listened; it last logged: Error: QA relay ends as the service.',
      ),
      `the rollback does not say what the relay did:\n${run.output.slice(-4000)}`,
    );
    // The trial (about 30 s), the slow release's 45 s and the 25 s it is watched for; a wait of
    // 30 s for the relay that ended would not fit.
    expect(took < 130_000, `a crash loop took ${took} ms to roll back`);
    expect(selected() === commit['9.0.1'], 'previous release not restored');
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'relay unhealthy after rollback',
    );
    expect(
      readFileSync(join(qa.data, 'qa-marker.txt'), 'utf8') === 'original data',
      'data not restored',
    );
    expect(!existsSync(join(qa.data, '.npm')), 'data was not restored from the backup');
    const dataStat = statSync(qa.data);
    expect(
      dataStat.uid === Number(sh('id', ['-u', qa.user])) && (dataStat.mode & 0o777) === 0o700,
      'restored data ownership changed',
    );
    const kept = readdirSync('/var/lib').filter((name) =>
      name.startsWith('.agent-studio-qa-failed-'),
    );
    expect(
      kept.length === 1 && existsSync(join('/var/lib', kept[0], '.npm')),
      'replaced data not kept',
    );
    expect(state().release.phase === 'failed', 'broken release not marked failed');
    run = await update('check');
    expect(
      run.status === 0 && run.output.trim() === '',
      'a failed release was retried automatically',
    );
    passed('rolls back a crash loop without waiting for it, restoring release and data', {
      kept: kept[0],
      took: `${took} ms`,
    });

    // 5. An installer from another key is refused before anything is built.
    latest = '9.0.4';
    const before = requests.length;
    run = await update('check');
    expect(
      run.status === 1 && run.output.includes('installer is not trusted'),
      `untrusted release not refused:\n${run.output}`,
    );
    expect(
      !requests.slice(before).some((path) => path.includes('/tarball/')),
      'untrusted source was downloaded',
    );
    expect(!existsSync(join(qa.root, 'releases', commit['9.0.4'])), 'untrusted release was built');
    expect(
      !existsSync(join(qa.root, 'releases', commit['9.0.3'])),
      'superseded failed build was kept',
    );
    expect(selected() === commit['9.0.1'], 'current changed');
    expect(hostVersion() === '9.0.1' && active(qa.hostService), 'host changed');
    passed('refuses an installer signed by another key without building it');

    // 6. A host that does not stay up gives way to the one before it. The release's relay
    // answers only between holds of eight seconds, which a 3-second probe took for a dead one.
    prepare('9.0.5', 'stallingOnce');
    latest = '9.0.5';
    run = await update('check');
    expect(
      run.status === 1 && run.output.includes('Activated v9.0.5'),
      `relay of v9.0.5 not activated:\n${run.output.slice(-4000)}`,
    );
    passed('activates a relay whose answers take seconds');
    expect(
      run.output.includes('did not stay up; it runs 9.0.1 again'),
      `no host rollback:\n${run.output.slice(-4000)}`,
    );
    expect(hostVersion() === '9.0.1' && active(qa.hostService), 'previous host not restored');
    run = await update('check');
    expect(run.status === 0 && run.output.trim() === '', 'a failed host was retried automatically');
    passed('a host that does not stay up gives way to the previous one');

    // 7. The release before no longer starts on its own data, as production's could not on
    // 2026-11-20: when the new one fails its check, going back fails too, and the new one is
    // started once more rather than leaving the relay down.
    prepare('9.0.6', 'secondStart');
    latest = '9.0.6';
    run = await update('check');
    expect(run.status === 0, `v9.0.6 was not kept:\n${run.output.slice(-6000)}`);
    for (const text of [
      'v9.0.6 failed its health check: its relay ended (exit-code 3) and its service started it again before it listened; it last logged: Error: QA relay ends the first time it starts. Restoring',
      `${commit['9.0.5']} did not come back: its relay ended (exit-code 3) and its service started it again before it listened; it last logged: Error: QA relay cannot read its data a second time. Starting v9.0.6 once more, on the data as it was before the switch.`,
      'so v9.0.6 was started once more, on the data as it was before the switch, and serves.',
      `${commit['9.0.5']} can no longer be gone back to.`,
      'The host runs v9.0.6',
    ])
      expect(run.output.includes(text), `missing "${text}":\n${run.output.slice(-6000)}`);
    expect(selected() === commit['9.0.6'], 'current does not select v9.0.6');
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'relay down after the second start',
    );
    expect(
      state().release.phase === 'active' &&
        state().release.note?.includes('was started once more') &&
        !state().release.error,
      `state does not say what happened: ${JSON.stringify(state().release)}`,
    );
    expect(
      readFileSync(join(qa.data, 'qa-marker.txt'), 'utf8') === 'original data' &&
        existsSync(join(qa.data, 'qa-started-once')),
      'the second start does not run on the data from before the switch',
    );
    // The release before wrote to the restored data before it ended. That is kept aside, and
    // the second start runs on the backup once more, not on what a failed relay left.
    const failed = readdirSync('/var/lib').filter((name) =>
      name.startsWith('.agent-studio-qa-failed-'),
    );
    expect(failed.length === 3, `kept data: ${failed.join(', ')}`);
    const left = failed.find((name) => name.includes(`-failed-${commit['9.0.5'].slice(0, 12)}-`));
    expect(
      left && existsSync(join('/var/lib', left, 'qa-wrote-before-failing')),
      'what the release before wrote when it did not start was not kept',
    );
    expect(
      !existsSync(join(qa.data, 'qa-wrote-before-failing')),
      'the second start runs on data the release before wrote to as it failed',
    );
    expect(
      state().release.note?.includes(
        `What ${commit['9.0.5']} left when it did not start is kept in /var/lib/${left}.`,
      ),
      `the note does not say where: ${state().release.note}`,
    );
    expect(
      existsSync(join(qa.backups, `pre-${commit['9.0.6']}.tar.gz`)) &&
        !existsSync(join(qa.backups, `pre-${commit['9.0.6']}.tar`)),
      'the backup was not compressed once the relay ran',
    );
    expect(hostVersion() === '9.0.6' && active(qa.hostService), 'host does not run v9.0.6');
    passed('starts the new release once more when the one before it no longer starts', {
      note: state().release.note,
    });

    // 8. An updater killed right after it selected a release, whose relay then ends: the
    // current link selects it, and nothing checked it. The next check must not take it for
    // active; it starts it, checks it, and goes back as after any failed check.
    prepare('9.0.7', 'dyingLate');
    latest = '9.0.7';
    const published = sha256(readFileSync(download));
    await killed(
      () =>
        state().release.activation?.step === 'candidate' &&
        selected() === commit['9.0.7'] &&
        active(qa.service),
      'starting the release',
    );
    expect(
      selected() === commit['9.0.7'] && state().release.phase === 'staged',
      `the kill did not leave the release selected and unchecked: ${JSON.stringify(state().release)}`,
    );
    run = await update('check');
    expect(
      run.status === 1,
      `a selected release was taken for active:\n${run.output.slice(-4000)}`,
    );
    for (const text of [
      'An updater ended while starting v9.0.7; the activation of v9.0.7 goes on from there, and nothing is taken for done.',
      'v9.0.7 failed its health check: its relay ended (exit-code 3) and its service started it again before it listened; it last logged: Error: QA relay ends after working for a while. Restoring',
      `v9.0.7 failed its health check; ${commit['9.0.6']} was restored.`,
    ])
      expect(run.output.includes(text), `missing "${text}":\n${run.output.slice(-6000)}`);
    expect(selected() === commit['9.0.6'], 'the release before was not restored');
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'relay down after an interrupted activation',
    );
    expect(
      state().release.phase === 'failed' && !state().release.activation,
      `state: ${JSON.stringify(state().release)}`,
    );
    expect(
      sha256(readFileSync(download)) === published,
      'the installer of a release that never passed its check was published',
    );
    expect(hostVersion() === '9.0.6' && active(qa.hostService), 'the host was switched');
    passed('a release selected by an updater that was killed is checked, not taken for active');

    // 9. Killed the same way with a relay that serves: the next check starts it again, checks
    // it and only then records it.
    prepare('9.0.8', 'plain');
    latest = '9.0.8';
    await killed(
      () => state().release.activation?.step === 'candidate' && selected() === commit['9.0.8'],
      'starting the release',
    );
    run = await update('check');
    expect(
      run.status === 0 &&
        run.output.includes('An updater ended while starting v9.0.8') &&
        run.output.includes('Activated v9.0.8') &&
        run.output.includes('The host runs v9.0.8'),
      `the interrupted activation was not finished:\n${run.output.slice(-4000)}`,
    );
    expect(
      selected() === commit['9.0.8'] && state().release.phase === 'active',
      'v9.0.8 is not active',
    );
    expect(
      active(qa.service) && (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401,
      'relay down after the activation was finished',
    );
    passed('an activation its updater was killed in is finished by the next check');

    // The releases of the scenarios below, staged while the first release's build is still
    // there to make them from: the updater keeps five releases.
    for (const [version, relay] of [
      ['9.0.9', 'plain'],
      ['9.1.0', 'plain'],
      ['9.1.1', 'liveBroken'],
      ['9.1.2', 'dyingLate'],
      ['9.1.3', 'slow'],
    ])
      prepare(version, relay);
    const answers = async () => (await status(`http://127.0.0.1:${qa.port}/v1/state`)) === 401;
    const backupFiles = (version) =>
      readdirSync(qa.backups)
        .filter((name) => name.startsWith(`pre-${commit[version]}.tar`))
        .sort();
    const manifest = (version) =>
      JSON.parse(
        readFileSync(join(qa.backups, `pre-${commit[version]}.tar.manifest.json`), 'utf8'),
      );
    const fileSha = (path) => sh('sha256sum', [path]).slice(0, 64);
    const keptFolders = () =>
      readdirSync('/var/lib').filter((name) => name.startsWith('.agent-studio-qa-failed-'));
    const stagingFolders = () =>
      readdirSync('/var/lib').filter((name) => name.startsWith('.agent-studio-qa-restore-'));

    // 10. An updater killed once the relay it started answers. The next check finds the relay
    // it started, checks it as it runs and records it: the same process, never stopped again.
    latest = '9.0.9';
    await killed(
      () => state().release.activation?.step === 'candidate' && selected() === commit['9.0.9'],
      'starting the release',
    );
    for (let waited = 0; waited < 100 && !(await answers()); waited++) await settle(200);
    expect(await answers(), 'the relay the killed updater started does not answer');
    pid = relayPid();
    run = await update('check');
    expect(
      run.status === 0 &&
        run.output.includes(
          `The relay of ${commit['9.0.9']} that the updater started runs; it is checked, not started again.`,
        ) &&
        run.output.includes('Activated v9.0.9'),
      `the running relay was not taken up:\n${run.output.slice(-4000)}`,
    );
    expect(relayPid() === pid, 'the relay an updater had started was started again');
    expect(state().release.phase === 'active' && (await answers()), 'v9.0.9 is not active');
    passed('a relay that a killed updater had started is checked as it runs, not restarted', {
      pid,
    });

    // 11. The deployment lock, which every command of the updater takes itself. A check skips
    // its run while something holds it; retry waits, and changes the state only afterwards.
    const lockFile = join(qa.root, '.deploy.lock');
    const holder = spawn('flock', [lockFile, 'sleep', '9'], { stdio: 'ignore' });
    await settle(1000);
    began = Date.now();
    run = await update('check');
    expect(
      run.status === 0 &&
        run.output.includes('A deployment holds the lock; this check is skipped.') &&
        Date.now() - began < 5000,
      `a check did not skip its run while the lock was held:\n${run.output}`,
    );
    const stateBefore = readFileSync(join(qa.state, 'state.json'), 'utf8');
    began = Date.now();
    const waiting = launch('retry');
    await settle(2000);
    expect(
      readFileSync(join(qa.state, 'state.json'), 'utf8') === stateBefore,
      'retry changed the state while the lock was held',
    );
    run = await finish(waiting);
    expect(
      run.status === 0 &&
        run.output.includes('A check or a deployment is running; waiting for it to end.') &&
        run.output.includes('Nothing failed; the latest release will be checked again.') &&
        Date.now() - began > 4000,
      `retry did not wait for the lock:\n${run.output}`,
    );
    await new Promise((done) => holder.on('close', done));
    expect(
      !readdirSync(qa.state).some((name) => name.endsWith('.tmp') || name.endsWith('.partial')) &&
        existsSync(join(qa.state, 'state.json.previous')),
      `the state folder holds ${readdirSync(qa.state).join(', ')}`,
    );
    passed('a check skips its run while the lock is held, and retry waits for it');

    // 12. Three gigabytes of data, so that archiving, compressing and unpacking take seconds.
    // An updater is killed while it archives them: the relay is stopped, no backup has its
    // name yet, and the next updater clears what was left and goes on. That one is killed
    // while it compresses the backup: the state still names the archive, which is whole and
    // still there. The third finishes, and removes the archive only then.
    const big = join(qa.data, 'qa-big.bin');
    sh('fallocate', ['-l', '3G', big]);
    sh('chown', [`${qa.user}:${qa.user}`, big]);
    latest = '9.1.0';
    await killed(
      () =>
        backupFiles('9.1.0').some(
          (name) =>
            /\.tar\.\d+-[0-9a-f]+\.partial$/.test(name) &&
            statSync(join(qa.backups, name)).size > 0,
        ),
      'archiving the data',
      3000,
    );
    expect(
      state().release.activation?.step === 'backup' && !state().release.activation.backup,
      `killed while archiving, the state names a backup: ${JSON.stringify(state().release)}`,
    );
    expect(
      !backupFiles('9.1.0').some((name) => name.endsWith('.tar')) && !active(qa.service),
      `an archive that was not finished has its name: ${backupFiles('9.1.0').join(', ')}`,
    );
    passed('an updater killed while it archives the data leaves no backup under its name', {
      left: backupFiles('9.1.0'),
    });
    await killed(
      () => backupFiles('9.1.0').some((name) => /\.tar\.gz\.\d+-[0-9a-f]+\.partial$/.test(name)),
      'compressing the backup',
      3000,
    );
    const archive = join(qa.backups, `pre-${commit['9.1.0']}.tar`);
    expect(
      state().release.phase === 'active' &&
        state().history[0].backup === archive &&
        state().release.backup === archive,
      `killed while compressing, the state does not name the archive: ${JSON.stringify(state().history[0])}`,
    );
    expect(
      existsSync(archive) && !existsSync(`${archive}.gz`),
      `killed while compressing: ${backupFiles('9.1.0').join(', ')}`,
    );
    expect(
      statSync(archive).size === manifest('9.1.0').archive.bytes &&
        fileSha(archive) === manifest('9.1.0').archive.sha256 &&
        manifest('9.1.0').entries.some(
          (entry) => entry.path === 'qa-big.bin' && entry.size === 3 * 1024 ** 3,
        ) &&
        !manifest('9.1.0').entries.some((entry) => entry.path.startsWith('.npm')),
      'the archive is not what its manifest recorded',
    );
    expect(selected() === commit['9.1.0'] && (await answers()), 'v9.1.0 does not serve');
    run = await update('check');
    expect(run.status === 0, `the check after the kills failed:\n${run.output.slice(-4000)}`);
    expect(
      backupFiles('9.1.0').join() ===
        [`pre-${commit['9.1.0']}.tar.gz`, `pre-${commit['9.1.0']}.tar.manifest.json`].join(),
      `after compressing: ${backupFiles('9.1.0').join(', ')}`,
    );
    expect(
      state().history[0].backup === `${archive}.gz` &&
        state().release.backup === `${archive}.gz` &&
        !state().cleanup &&
        fileSha(`${archive}.gz`) === manifest('9.1.0').compressed?.sha256,
      `the state does not name the compressed backup: ${JSON.stringify(state().history[0])}`,
    );
    expect(
      sh('bash', ['-o', 'pipefail', '-c', `gzip -dc ${archive}.gz | sha256sum`]).slice(0, 64) ===
        manifest('9.1.0').archive.sha256,
      'the compressed backup does not unpack to the archive that was made',
    );
    expect(hostVersion() === '9.1.0' && active(qa.hostService), 'host does not run v9.1.0');
    passed('an updater killed while it compresses a backup leaves the archive, named and whole', {
      backup: backupFiles('9.1.0'),
    });

    // 13. A release whose relay ends as the service, and an updater killed while it puts the
    // backup back: half of it lies beside the data. The next check finishes the restore, once.
    latest = '9.1.1';
    const keptBefore = keptFolders();
    await killed(() => stagingFolders().length > 0, 'putting the backup back', 3000);
    expect(
      state().release.activation?.step === 'previous' && state().release.activation.keep,
      `killed in a restore: ${JSON.stringify(state().release.activation)}`,
    );
    const interrupted = {
      staging: stagingFolders(),
      kept: keptFolders().length - keptBefore.length,
    };
    run = await update('check');
    expect(
      run.status === 1 &&
        run.output.includes(`v9.1.1 failed its health check; ${commit['9.1.0']} was restored.`),
      `the interrupted restore was not finished:\n${run.output.slice(-4000)}`,
    );
    expect(
      stagingFolders().length === 0 && keptFolders().length === keptBefore.length + 1,
      `after the restore: ${stagingFolders().join(', ')} / ${keptFolders().join(', ')}`,
    );
    expect(
      readFileSync(join(qa.data, 'qa-marker.txt'), 'utf8') === 'original data' &&
        statSync(big).size === 3 * 1024 ** 3 &&
        statSync(qa.data).uid === Number(sh('id', ['-u', qa.user])),
      'the data is not the backup, whole',
    );
    expect(
      selected() === commit['9.1.0'] && (await answers()),
      'the release before does not serve',
    );
    passed('a restore its updater was killed in is finished by the next check, once', interrupted);
    rmSync(big);

    // 14. A backup that was cut short. GNU tar ends well where such an archive ends in the
    // middle and would unpack a part of the data as if it were all of it. The release fails
    // its check, and the release before is started on the data as it is: nothing was moved
    // aside for a backup that is not the archive that was made.
    latest = '9.1.2';
    await killed(
      () =>
        state().release.activation?.step === 'candidate' &&
        selected() === commit['9.1.2'] &&
        active(qa.service),
      'starting the release',
      3000,
    );
    const short = join(qa.backups, `pre-${commit['9.1.2']}.tar`);
    const written = statSync(short).size;
    sh('truncate', ['-s', '1024', short]);
    // What tar makes of it: it ends well.
    const tarEnds = spawnSync('tar', ['-tf', short], { encoding: 'utf8' });
    const keptThen = keptFolders();
    run = await update('check');
    expect(run.status === 1, `a cut backup did not fail:\n${run.output.slice(-4000)}`);
    for (const text of [
      `The data backup ${short} cannot be put back: it holds 1024 bytes where ${written} were written. The private data stays as it is, and nothing was moved aside.`,
      `v9.1.2 failed its health check; ${commit['9.1.0']} runs again, on the data as v9.1.2 left it.`,
    ])
      expect(run.output.includes(text), `missing "${text}":\n${run.output.slice(-6000)}`);
    expect(
      keptFolders().length === keptThen.length && stagingFolders().length === 0,
      'data was moved aside for a backup that cannot be put back',
    );
    expect(
      readFileSync(join(qa.data, 'qa-marker.txt'), 'utf8') === 'original data' &&
        selected() === commit['9.1.0'] &&
        (await answers()),
      'the release before does not serve the data that was there',
    );
    passed('a backup that was cut short is not put back, and the data is left as it is', {
      tar: `exit ${tarEnds.status}, ${tarEnds.stdout.trim().split('\n').length} entries listed`,
      written,
    });

    // 15. An updater that hangs. Its unit has no deadline; the updater answers the unit's
    // watchdog while its own code runs or its commands work. Here its code is stopped while it
    // waits for a trial, with the watchdog and the patience shortened to seconds: systemd ends
    // the unit, the trial with it, and the next check, under the same short watchdog, runs for
    // minutes without being ended, since it shows signs of life all the while.
    latest = '9.1.3';
    unitChanges = { env: { HUNG_AFTER: '20' }, properties: ['WatchdogSec=10'] };
    const hung = launch('check');
    for (let waited = 0; waited < 600 && !active(trialService); waited++) await settle(200);
    expect(active(trialService), 'the check that is to hang never tried the release');
    const group = sh('systemctl', [
      'show',
      `${hung.name}.service`,
      '-p',
      'ControlGroup',
      '--value',
    ]);
    const worker = readFileSync(`/sys/fs/cgroup${group.trim()}/cgroup.procs`, 'utf8')
      .split('\n')
      .filter(Boolean)
      .find((process) => {
        try {
          return (
            readFileSync(`/proc/${process}/environ`, 'utf8').includes(
              'AGENT_STUDIO_UPDATE_LOCK=held',
            ) && !readFileSync(`/proc/${process}/cmdline`, 'utf8').startsWith('flock')
          );
        } catch {
          return false;
        }
      });
    expect(worker, 'the check has no process of its own');
    began = Date.now();
    process.kill(Number(worker), 'SIGSTOP');
    run = await finish(hung);
    took = Date.now() - began;
    expect(
      run.status !== 0 && run.output.includes('it is hung. Its watchdog is no longer answered'),
      `a hung updater was not ended:\n${run.output.slice(-4000)}`,
    );
    expect(took > 15_000 && took < 90_000, `a hung updater was ended after ${took} ms`);
    expect(!existsSync(`/proc/${worker}`), 'the hung updater still runs');
    for (let waited = 0; waited < 50 && active(trialService); waited++) await settle(200);
    expect(!active(trialService), 'the trial outlived the hung updater');
    began = Date.now();
    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Activated v9.1.3'),
      `the check after the hung one failed:\n${run.output.slice(-4000)}`,
    );
    expect(
      Date.now() - began > 90_000,
      'the check was too short to show that a working updater is not ended',
    );
    unitChanges = { env: {}, properties: [] };
    passed('an updater that hangs is ended by its watchdog, and one that works is not', {
      endedAfter: `${took} ms`,
      workedFor: `${Date.now() - began} ms`,
    });

    // 16. A host switch that was interrupted. The state says a switch was begun; the host
    // already runs the version, started after its link was set: it is watched, not restarted.
    // Then the link is set again, as by an updater that ended before it restarted the host:
    // the process is older than the link, so nothing shows that it runs what the link selects,
    // and it is restarted.
    expect(hostVersion() === '9.1.3' && active(qa.hostService), 'host does not run v9.1.3');
    const hostPid = () =>
      sh('systemctl', ['show', qa.hostService, '-p', 'MainPID', '--value']).trim();
    const interrupt = () => {
      const saved = state();
      saved.host = {
        ...saved.host,
        phase: 'staged',
        staged: new Date().toISOString(),
        activation: { step: 'switch', entered: new Date().toISOString() },
      };
      delete saved.host.activated;
      writeFileSync(join(qa.state, 'state.json'), JSON.stringify(saved, null, 2), { mode: 0o600 });
    };
    let hostProcess = hostPid();
    interrupt();
    run = await update('check');
    expect(
      run.status === 0 &&
        run.output.includes('The host already runs v9.1.3; it is watched, not started again.') &&
        run.output.includes('The host runs v9.1.3'),
      `the running host was not taken up:\n${run.output.slice(-4000)}`,
    );
    expect(hostPid() === hostProcess, 'a host that ran the version was restarted');
    await settle(1500);
    const link = join(qa.root, 'host', 'current');
    symlinkSync(join(qa.root, 'host', '9.1.3'), `${link}.again`);
    renameSync(`${link}.again`, link);
    expect(lstatSync(link).ctimeMs > Date.now() - 1000, 'the link was not set again');
    interrupt();
    run = await update('check');
    expect(
      run.status === 0 &&
        !run.output.includes('The host already runs') &&
        run.output.includes('The host runs v9.1.3'),
      `a host older than its link was taken for the version:\n${run.output.slice(-4000)}`,
    );
    expect(
      hostPid() !== hostProcess && active(qa.hostService) && state().host.phase === 'active',
      'a host older than its link was not restarted',
    );
    passed('an interrupted host switch is finished by what the host process shows, not the link');

    // 17. Older releases are never installed.
    latest = '8.0.0';
    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Not installing v8.0.0'),
      'downgrade not ignored',
    );
    expect(selected() === commit['9.1.3'], 'downgraded');
    passed('never downgrades');

    expect(
      realpathSync('/opt/agent-studio/current') === productionBefore.current,
      'production release changed',
    );
    expect(pids() === productionBefore.pids, 'a production service restarted');
    expect(
      spawnSync('systemctl', ['is-active', '--quiet', 'agent-studio-host']).status !== 0 ||
        productionBefore.host,
      'a production host started',
    );
    passed('production release and service processes unchanged');
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${result.error}`);
    if (existsSync(logFile)) console.log(readFileSync(logFile, 'utf8').slice(-12000));
  } finally {
    server?.close();
    spawnSync('systemctl', ['disable', '--now', qa.hostService]);
    rmSync(hostUnit, { force: true });
    spawnSync('systemctl', ['reset-failed', qa.hostService]);
    spawnSync('systemctl', ['kill', '--signal=KILL', '--kill-whom=all', `${qa.service}-update-*`]);
    spawnSync('systemctl', ['stop', `${qa.service}-update-*`]);
    spawnSync('systemctl', ['stop', qa.service, trialService]);
    spawnSync('systemctl', ['reset-failed', trialService]);
    rmSync(secondStart, { force: true });
    rmSync(unit, { force: true });
    spawnSync('systemctl', ['daemon-reload']);
    spawnSync('systemctl', ['reset-failed', qa.service]);
    for (const path of [qa.root, qa.data, qa.backups, qa.state])
      rmSync(path, { recursive: true, force: true });
    for (const name of readdirSync('/var/lib'))
      if (name.startsWith('.agent-studio-qa-'))
        rmSync(join('/var/lib', name), { recursive: true, force: true });
    if (createdUser) spawnSync('userdel', [qa.user]);
    if (createdHostUser) spawnSync('userdel', ['--remove', qa.hostUser]);
    rmSync(qa.hostHome, { recursive: true, force: true });
    rmSync(upload, { recursive: true, force: true });
    result.finished = new Date().toISOString();
    result.cleaned = [qa.root, qa.data, qa.backups, qa.state, unit, hostUnit, qa.hostHome].every(
      (path) => !existsSync(path),
    );
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exitCode = result.ok && result.cleaned ? 0 : 1;
  }
}

const upload = option('--remote');
if (upload) await remote(upload);
else local();
