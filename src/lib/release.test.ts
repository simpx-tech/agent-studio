import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  currentVersion,
  nextVersion,
  readVersions,
  setVersion,
  stageAssets,
  validVersion,
  verifySignature,
} from '../../scripts/release.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'studio-release-'));
  temporary.push(path);
  return path;
}

// Produced by `tauri signer sign --app-version 1.2.3` with a throwaway key.
const cliKey =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZCN0FEMTRCODQ2MzRENQpSV1RWTkVhNEZLMjNEOHdNMkpsTmpsTW5tamhaTmxoT2FBZk5oWkRQemNuSm15Mmpqenk4VHBhOQo=';
const cliSignature =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUVk5FYTRGSzIzRC9ia2JRTWZjekV3SXRGcWdVUzlvanVQaUpLRHYwUmhWWS84Z2QyWmNSakNhdVlFK0xGenNnS240V25IUDVhZHptUTVjcThQNTNHeFVIeFNlTWt6alE4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMTIwOTE3CWZpbGU6cGF5bG9hZC50eHQJdmVyc2lvbjoxLjIuMwpuTWQ4ZjB6TCtROUNYYnlsVjI0QkdmOWsyOCtqZjVTVDV4a0J6ZnhvQ2tKRjk1VEdjUy80TUlFclo2MVh4L0dkVkUra3BFRnc5UVJOTmxzaUR5dFpDZz09Cg==';
const cliPayload = Buffer.from('Agent Studio updater fixture\n');

// A minisign signer matching the Tauri CLI's prehashed format, for synthetic packages.
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = Buffer.from(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
  ).toString('base64');
  const signData = (data: Buffer, comment: string) => {
    const bytes = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
    const global = sign(null, Buffer.concat([bytes, Buffer.from(comment)]), privateKey);
    const box = Buffer.concat([Buffer.from('ED'), id, bytes]).toString('base64');
    return Buffer.from(
      `untrusted comment: signature\n${box}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
    ).toString('base64');
  };
  return { key, signData };
}
function recode(signature: string, change: (text: string) => string) {
  return Buffer.from(change(Buffer.from(signature, 'base64').toString('utf8'))).toString('base64');
}

describe('release versions', () => {
  it('accepts only MSI-compatible increasing versions', () => {
    expect(validVersion('0.2.0')).toBe(true);
    for (const version of ['1.2', '01.2.3', '1.2.3-beta', '256.0.0', '1.2.65536', 'v1.2.3'])
      expect(validVersion(version)).toBe(false);
    expect(nextVersion('0.2.9', 'patch')).toBe('0.2.10');
    expect(nextVersion('0.2.9', 'minor')).toBe('0.3.0');
    expect(nextVersion('0.2.9', 'major')).toBe('1.0.0');
    expect(nextVersion('0.2.9', '0.10.0')).toBe('0.10.0');
    expect(() => nextVersion('0.2.9', '0.2.9')).toThrow(/greater/);
    expect(() => nextVersion('0.2.9', '0.2.1')).toThrow(/greater/);
    expect(() => nextVersion('0.2.9', 'beta')).toThrow(/x\.y\.z/);
  });

  it('bumps every manifest together and changes nothing else', () => {
    const root = directory();
    const paths = [
      'package.json',
      'package-lock.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
    ];
    for (const [index, path] of paths.entries()) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      let text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      // Working copies may use either line ending; both must survive.
      if (index % 2) text = text.replace(/\n/g, '\r\n');
      writeFileSync(join(root, path), text);
    }
    const before = currentVersion(root);
    const original = paths.map((path) => readFileSync(join(root, path), 'utf8'));
    const next = nextVersion(before, 'minor');
    setVersion(root, next);
    expect(currentVersion(root)).toBe(next);
    expect(Object.values(readVersions(root)).flat()).toHaveLength(6);
    for (const [index, path] of paths.entries()) {
      const text = readFileSync(join(root, path), 'utf8');
      const lines = text.split('\n');
      const previous = original[index].split('\n');
      expect(lines).toHaveLength(previous.length);
      const changed = lines.filter((line, number) => line !== previous[number]);
      expect(changed.length).toBe(path === 'package-lock.json' ? 2 : 1);
      for (const line of changed) expect(line).toContain(next);
      expect(text.includes('\r\n')).toBe(index % 2 === 1);
    }
    // A partial bump is reported instead of guessed.
    writeFileSync(
      join(root, 'package.json'),
      readFileSync(join(root, 'package.json'), 'utf8').replace(next, '9.9.9'),
    );
    expect(() => currentVersion(root)).toThrow(/disagree/);
  });
});

describe('updater signatures', () => {
  it('verifies Tauri CLI signatures and their signed version', () => {
    expect(verifySignature(cliPayload, cliSignature, cliKey)).toMatchObject({
      file: 'payload.txt',
      version: '1.2.3',
    });
    expect(() => verifySignature(Buffer.from('tampered'), cliSignature, cliKey)).toThrow(
      /does not match/,
    );
    const promoted = recode(cliSignature, (text) => text.replace('version:1.2.3', 'version:9.9.9'));
    expect(() => verifySignature(cliPayload, promoted, cliKey)).toThrow(/trusted comment/);
    expect(() => verifySignature(cliPayload, cliSignature, signer().key)).toThrow(/different key/);
    expect(() => verifySignature(cliPayload, 'bm90IGEgc2lnbmF0dXJl', cliKey)).toThrow(/minisign/);
  });

  it('stages every platform package with a manifest the app can verify', () => {
    const input = directory();
    const output = directory();
    const { key, signData } = signer();
    const packages = {
      'windows/nsis/Agent Studio_0.3.0_x64-setup.exe': true,
      'windows/msi/Agent Studio_0.3.0_x64_en-US.msi': true,
      'linux/appimage/Agent Studio_0.3.0_amd64.AppImage': true,
      'linux/deb/Agent Studio_0.3.0_amd64.deb': false,
      'mac/dmg/Agent Studio_0.3.0_universal.dmg': false,
      'mac/macos/Agent Studio.app.tar.gz': true,
    };
    for (const [path, signed] of Object.entries(packages)) {
      const data = Buffer.from(`package ${path}`);
      mkdirSync(dirname(join(input, path)), { recursive: true });
      writeFileSync(join(input, path), data);
      if (signed)
        writeFileSync(
          join(input, `${path}.sig`),
          signData(data, `timestamp:1\tfile:${path}\tversion:0.3.0`),
        );
    }
    const manifest = stageAssets({
      input,
      output,
      repo: 'simpx-tech/agent-studio',
      version: '0.3.0',
      publicKey: key,
      notes: '- Automatic updates\n',
      date: new Date('2026-09-22T12:00:00.123Z'),
    });
    expect(manifest.version).toBe('0.3.0');
    expect(manifest.notes).toBe('- Automatic updates');
    expect(manifest.pub_date).toBe('2026-09-22T12:00:00Z');
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-x86_64-appimage',
      'windows-x86_64',
      'windows-x86_64-msi',
      'windows-x86_64-nsis',
    ]);
    const base = 'https://github.com/simpx-tech/agent-studio/releases/download/v0.3.0/';
    expect(manifest.platforms['windows-x86_64'].url).toBe(
      `${base}Agent-Studio_0.3.0_x64-setup.exe`,
    );
    expect(manifest.platforms['darwin-aarch64'].url).toBe(
      `${base}Agent-Studio_0.3.0_universal.app.tar.gz`,
    );
    for (const { signature, url } of Object.values(manifest.platforms)) {
      const data = readFileSync(join(output, url.slice(base.length)));
      expect(verifySignature(data, signature, key).version).toBe('0.3.0');
    }
    expect(readdirSync(output).sort()).toEqual([
      'Agent-Studio_0.3.0_amd64.AppImage',
      'Agent-Studio_0.3.0_amd64.AppImage.sig',
      'Agent-Studio_0.3.0_amd64.deb',
      'Agent-Studio_0.3.0_universal.app.tar.gz',
      'Agent-Studio_0.3.0_universal.app.tar.gz.sig',
      'Agent-Studio_0.3.0_universal.dmg',
      'Agent-Studio_0.3.0_x64-setup.exe',
      'Agent-Studio_0.3.0_x64-setup.exe.sig',
      'Agent-Studio_0.3.0_x64_en-US.msi',
      'Agent-Studio_0.3.0_x64_en-US.msi.sig',
      'latest.json',
    ]);
    expect(JSON.parse(readFileSync(join(output, 'latest.json'), 'utf8'))).toEqual(manifest);

    // A package signed for another version would be rejected by every client.
    const stale = 'windows/msi/Agent Studio_0.3.0_x64_en-US.msi';
    writeFileSync(
      join(input, `${stale}.sig`),
      signData(readFileSync(join(input, stale)), 'timestamp:1\tfile:x\tversion:0.2.0'),
    );
    const retry = directory();
    rmSync(retry, { recursive: true });
    const stage = () =>
      stageAssets({
        input,
        output: retry,
        repo: 'simpx-tech/agent-studio',
        version: '0.3.0',
        publicKey: key,
        notes: '',
      });
    expect(stage).toThrow(/msi package was signed for 0\.2\.0/);
    expect(existsSync(retry)).toBe(false);
    cpSync(join(input, 'windows'), join(input, 'windows-copy'), { recursive: true });
    expect(stage).toThrow(/Expected one nsis package, found 2/);
  });
});
