import { describe, expect, it } from 'vitest';
import { consoleShell, consoleShells, fenceClosed } from './code-blocks';
import {
  emptyFleet,
  registerInstallation,
  registerWslEnvironments,
  type Fleet,
  type Installation,
} from './fleet';

const installation = (platform: Installation['platform'], name: string): Installation => ({
  id: crypto.randomUUID(),
  computerId: crypto.randomUUID(),
  name,
  platform,
});

// An account of one provider connected in an environment, as Connections saves it.
function connect(fleet: Fleet, environmentId: string) {
  const account = { id: crypto.randomUUID(), name: 'Main', provider: 'claude', purpose: 'work' };
  const connection = {
    id: crypto.randomUUID(),
    environmentId,
    accountId: account.id,
    profile: 'isolated',
  } as const;
  fleet.accounts.push(account as Fleet['accounts'][number]);
  fleet.connections.push(connection);
  return connection.id;
}

const chat = (connectionId?: string, path?: string) => ({
  settings: {
    provider: 'claude',
    model: '',
    reasoning: '',
    instructions: '',
    connectionId,
  } as const,
  location: path
    ? { computerId: crypto.randomUUID(), environmentId: crypto.randomUUID(), path }
    : undefined,
});

describe('console languages', () => {
  it('runs shell languages and only copies everything else', () => {
    for (const label of ['bash', 'sh', 'shell', 'zsh', 'BASH'])
      expect(consoleShell(label)).toBe('posix');
    for (const label of ['powershell', 'pwsh', 'ps1', 'ps', 'PowerShell'])
      expect(consoleShell(label)).toBe('powershell');
    for (const label of ['cmd', 'bat', 'batch', 'dos']) expect(consoleShell(label)).toBe('cmd');
    // Transcripts mix prompts with output, and other languages are mostly parts of files.
    for (const label of ['console', 'shell-session', 'text', 'python', 'js', 'json', '', undefined])
      expect(consoleShell(label)).toBeUndefined();
    // An object's own members are not languages.
    expect(consoleShell('constructor')).toBeUndefined();
    expect(consoleShell('toString')).toBeUndefined();
  });
});

describe('fences still being written', () => {
  it('counts a fence as closed only with its own closing line', () => {
    expect(fenceClosed('```bash\nnpm test\n```')).toBe(true);
    expect(fenceClosed('```bash\nnpm test\n```\n')).toBe(true);
    expect(fenceClosed('```\n```')).toBe(true);
    expect(fenceClosed('~~~sh\nls\n~~~~')).toBe(true);
    expect(fenceClosed('   ````bash\ncode\n   ````')).toBe(true);
    // Streaming: the opening line alone, a body without its end, and a shorter or other fence.
    expect(fenceClosed('```')).toBe(false);
    expect(fenceClosed('```bash')).toBe(false);
    expect(fenceClosed('```bash\nnpm te')).toBe(false);
    expect(fenceClosed('````bash\ncode\n```')).toBe(false);
    expect(fenceClosed('```bash\ncode\n~~~')).toBe(false);
    expect(fenceClosed('```bash\ncode\n``` not a close')).toBe(false);
    // Indented code has no fence.
    expect(fenceClosed('    indented code')).toBe(true);
  });
});

describe('where a console can open', () => {
  it('offers every shell on Windows and POSIX shells in its WSL distributions', () => {
    const desktop = installation('windows', 'Desktop');
    const fleet = emptyFleet();
    registerInstallation(fleet, desktop);
    registerWslEnvironments(fleet, desktop, {
      distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: true }],
      warning: null,
    });
    const ubuntu = fleet.environments.find((e) => e.platform === 'wsl')!;
    const onWindows = connect(fleet, desktop.id);
    const inUbuntu = connect(fleet, ubuntu.id);
    expect(consoleShells(fleet, desktop, chat(onWindows, 'C:\\Projects\\studio'))).toEqual([
      'posix',
      'powershell',
      'cmd',
    ]);
    expect(consoleShells(fleet, desktop, chat(onWindows))).toEqual(['posix', 'powershell', 'cmd']);
    expect(consoleShells(fleet, desktop, chat(inUbuntu, '/home/test/studio'))).toEqual(['posix']);
  });

  it('offers POSIX shells on macOS and Linux', () => {
    for (const platform of ['macos', 'linux'] as const) {
      const computer = installation(platform, 'Laptop');
      const fleet = emptyFleet();
      registerInstallation(fleet, computer);
      expect(consoleShells(fleet, computer, chat(connect(fleet, computer.id)))).toEqual(['posix']);
    }
  });

  it('offers nothing for a chat another computer runs, or without a known computer', () => {
    const desktop = installation('windows', 'Desktop');
    const laptop = installation('windows', 'Laptop');
    const fleet = emptyFleet();
    registerInstallation(fleet, desktop);
    registerInstallation(fleet, laptop);
    registerWslEnvironments(fleet, laptop, {
      distributions: [{ id: crypto.randomUUID(), name: 'Ubuntu', running: true }],
      warning: null,
    });
    const elsewhere = connect(fleet, laptop.id);
    const itsUbuntu = connect(fleet, fleet.environments.find((e) => e.platform === 'wsl')!.id);
    expect(consoleShells(fleet, desktop, chat(elsewhere))).toEqual([]);
    expect(consoleShells(fleet, desktop, chat(itsUbuntu))).toEqual([]);
    expect(consoleShells(fleet, desktop, chat(crypto.randomUUID()))).toEqual([]);
    expect(consoleShells(fleet, undefined, chat(elsewhere))).toEqual([]);
    expect(consoleShells(fleet, desktop, undefined)).toEqual([]);
    // The Viewer is no computer: it shows chats and runs nothing.
    const browser = installation('preview', 'This browser');
    registerInstallation(fleet, browser);
    expect(consoleShells(fleet, browser, chat())).toEqual([]);
  });

  it('runs a chat saved without a connection on this computer, in no project folder', () => {
    const desktop = installation('windows', 'Desktop');
    const fleet = emptyFleet();
    registerInstallation(fleet, desktop);
    expect(consoleShells(fleet, desktop, chat())).toEqual(['posix', 'powershell', 'cmd']);
    expect(consoleShells(fleet, desktop, chat(undefined, 'C:\\Projects\\studio'))).toEqual([]);
  });
});
