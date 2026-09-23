// End-to-end check of the automatic VPS updater (scripts/vps/update.ts) on the production
// server, using an isolated relay instance and a local stand-in for GitHub. Production releases,
// data, services and downloads are only read. See docs/DEPLOYMENT.md.
//
//   node scripts/vps/smoke.mjs [--host agent-studio-vps]
//
// Packages the committed HEAD, uploads it with this script, and runs the scenarios remotely as
// root: install a signed release, wait for a running reply, roll back a release that fails its
// health check, refuse an untrusted installer and ignore a downgrade. Everything it creates is
// removed afterwards, except the updater's build account and npm cache.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  for (const [file, name] of [
    [archive, 'source.tar.gz'],
    [import.meta.filename, 'smoke.mjs'],
  ])
    sh('ssh', [...ssh, host, `cat > ${upload}/${name}`], { input: readFileSync(file) });
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
  };
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
  const productionBefore = { current: realpathSync('/opt/agent-studio/current'), pids: pids() };
  let createdUser = false;
  let server;

  const qaKey = signer();
  const otherKey = signer();
  const commit = { '9.0.0': 'a0', '9.0.1': 'b1', '9.0.2': 'c2', '9.0.3': 'd3', '8.0.0': 'e4' };
  for (const version of Object.keys(commit)) commit[version] = commit[version].repeat(20);
  const releases = new Map();
  let latest;
  const requests = [];

  try {
    // An isolated relay instance that starts from a copy of the production release.
    for (const path of [qa.root, qa.data, qa.backups, qa.state, unit])
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
Environment=AGENT_STUDIO_RELAY_TOKEN=${randomBytes(32).toString('hex')}
Environment=NODE_ENV=production
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
MemoryMax=512M
CPUQuota=100%
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

    // Release sources: the committed tree trusting the QA key, and one whose relay exits at once.
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
    const broken = variant('broken', (tree) =>
      writeFileSync(join(tree, 'relay', 'start.ts'), 'process.exit(3);\n'),
    );
    const trustFile = join(work, 'trust.json');
    writeFileSync(trustFile, JSON.stringify({ plugins: { updater: { pubkey: qaKey.key } } }));
    for (const [version, tarball, key] of [
      ['9.0.0', good, qaKey],
      ['9.0.1', good, qaKey],
      ['9.0.2', broken, qaKey],
      ['9.0.3', good, otherKey],
      ['8.0.0', good, qaKey],
    ]) {
      const installer = randomBytes(512 * 1024);
      releases.set(version, {
        tarball,
        installer,
        signature: Buffer.from(key.signData(installer, version)),
      });
    }
    const assetName = (version) => `Agent-Studio_${version}_x64-setup.exe`;
    const origin = `http://127.0.0.1:${qa.apiPort}`;
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', origin).pathname;
      requests.push(path);
      const send = (code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(body);
      };
      let match;
      if (path === '/repos/qa/agent-studio/releases/latest') {
        if (!latest) return send(404, '{"message":"Not Found"}');
        const { installer, signature } = releases.get(latest);
        const name = assetName(latest);
        return send(
          200,
          JSON.stringify({
            tag_name: `v${latest}`,
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
            ],
          }),
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

    // Run the updater the way its systemd unit does, pointed at the QA instance. It must run
    // asynchronously so this process keeps answering as GitHub.
    const update = async (...args) => {
      const env = {
        API: origin,
        REPO: 'qa/agent-studio',
        ROOT: qa.root,
        DATA: qa.data,
        BACKUPS: qa.backups,
        STATE: qa.state,
        SERVICE: qa.service,
        PORT: String(qa.port),
      };
      const child = spawn('systemd-run', [
        '--quiet',
        '--wait',
        '--pipe',
        '--collect',
        '--service-type=exec',
        '--property=UMask=0077',
        '--property=ProtectHome=yes',
        '--property=PrivateTmp=yes',
        '--property=NoNewPrivileges=yes',
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
      const run = { status: await new Promise((done) => child.on('close', done)) };
      appendFileSync(logFile, `\n$ update.ts ${args.join(' ')} (exit ${run.status})\n${output}`);
      // Only the updater's own messages; build tools print their own progress.
      const messages = output
        .split('\n')
        .filter((line) =>
          /^(Found|Building|Staged|Waiting|Activat|Published|Not installing|Ignoring|Could not|Trusting|v\d|Rollback|No )/.test(
            line,
          ),
        );
      console.log(`update.ts ${args.join(' ')} → exit ${run.status}\n  ${messages.join('\n  ')}`);
      return { status: run.status, output, messages };
    };
    const state = () => JSON.parse(readFileSync(join(qa.state, 'state.json'), 'utf8'));
    const selected = () => basename(realpathSync(join(qa.root, 'current')));

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
      'Staged v9.0.0',
      'Activated v9.0.0',
      'Published the v9.0.0 Windows installer',
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
    run = await update('check');
    expect(run.status === 0 && run.output.trim() === '', 'second check was not quiet');
    passed(
      'installs a signed release: sandboxed build and tests, backup, switch, health check, installer',
      {
        release: commit['9.0.0'],
      },
    );

    // 2. Activation waits for a running reply.
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
    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Activated v9.0.1'),
      `activation failed:\n${run.output}`,
    );
    expect(selected() === commit['9.0.1'], 'current does not select v9.0.1');
    passed('waits for running replies, then activates');

    // 3. A release that fails its health check is rolled back with its data.
    latest = '9.0.2';
    run = await update('check');
    expect(run.status === 1, `broken release did not fail:\n${run.output.slice(-4000)}`);
    expect(
      run.output.includes(`v9.0.2 failed its health check; ${commit['9.0.1']} was restored.`),
      'no rollback message',
    );
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
    passed('rolls back a release that fails its health check, restoring release and data', {
      kept: kept[0],
    });

    // 4. An installer from another key is refused before anything is built.
    latest = '9.0.3';
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
    expect(!existsSync(join(qa.root, 'releases', commit['9.0.3'])), 'untrusted release was built');
    expect(
      !existsSync(join(qa.root, 'releases', commit['9.0.2'])),
      'superseded failed build was kept',
    );
    expect(selected() === commit['9.0.1'], 'current changed');
    passed('refuses an installer signed by another key without building it');

    // 5. Older releases are never installed.
    latest = '8.0.0';
    run = await update('check');
    expect(
      run.status === 0 && run.output.includes('Not installing v8.0.0'),
      'downgrade not ignored',
    );
    expect(selected() === commit['9.0.1'], 'downgraded');
    passed('never downgrades');

    expect(
      realpathSync('/opt/agent-studio/current') === productionBefore.current,
      'production release changed',
    );
    expect(pids() === productionBefore.pids, 'a production service restarted');
    passed('production release and service processes unchanged');
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${result.error}`);
    if (existsSync(logFile)) console.log(readFileSync(logFile, 'utf8').slice(-12000));
  } finally {
    server?.close();
    spawnSync('systemctl', ['stop', qa.service]);
    rmSync(unit, { force: true });
    spawnSync('systemctl', ['daemon-reload']);
    spawnSync('systemctl', ['reset-failed', qa.service]);
    for (const path of [qa.root, qa.data, qa.backups, qa.state])
      rmSync(path, { recursive: true, force: true });
    for (const name of readdirSync('/var/lib'))
      if (name.startsWith('.agent-studio-qa-'))
        rmSync(join('/var/lib', name), { recursive: true, force: true });
    if (createdUser) spawnSync('userdel', [qa.user]);
    rmSync(upload, { recursive: true, force: true });
    result.finished = new Date().toISOString();
    result.cleaned = [qa.root, qa.data, qa.backups, qa.state, unit].every(
      (path) => !existsSync(path),
    );
    console.log(`RESULT ${JSON.stringify(result)}`);
    process.exitCode = result.ok && result.cleaned ? 0 : 1;
  }
}

const upload = option('--remote');
if (upload) await remote(upload);
else local();
